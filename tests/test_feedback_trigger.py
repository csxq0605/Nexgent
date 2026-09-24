"""E3-B.2a durable ordinary-task feedback trigger coverage."""

from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import json

import pytest

from nexgent.tasks.evolution import EvolutionService
from nexgent.tasks.feedback_trigger import AutoEvolutionService
from nexgent.tasks.generation import GenerationService
from nexgent.tasks.packages import make_package
from nexgent.tasks.runtime import TaskService
from nexgent.tasks.tools import ContractError, ToolRegistry
from nexgent.kernel.programs import digest


PRIVATE_TEXT = "PRIVATE-EVALUATOR-ANSWER-MUST-NOT-LEAK"


def _package():
    return make_package(
        {"main.py": (
            "def execute(payload, context):\n"
            "    artifact = context.publish({'ok': True}, name='result')\n"
            "    context.feedback({'valid': False, 'failure_code': 'invalid_output', "
            f"'note': '{PRIVATE_TEXT}'}})\n"
            "    return {'deliverables': {'result': artifact['id']}}\n"
        )},
        {"entries": {"execute": "main.py:execute"}},
        provenance={"fixture": "feedback-trigger"},
    )


def _services(tmp_path, *, evaluator_available=lambda _identity: True, attach=True):
    tasks = TaskService(tmp_path, tools=ToolRegistry())
    evolution = EvolutionService(tasks)
    package = _package()
    evolution.register("general", package)
    generation = GenerationService(tasks, evolution)
    trigger = AutoEvolutionService(
        tasks,
        policies={"general": {
            "evaluator_id": "independent-evaluator",
            "candidate_types": ["tool", "service_provider", "orchestration", "no_change"],
            "budget": {"max_model_calls": 1},
            "permissions": {"allowed_effects": ["local_compute"]},
            "improver": {"channel": "ordinary-improver", "revision": 0},
            "promotion_policy": {"max_regressions": 0},
        }},
        evolution_service=evolution,
        generation_service=generation,
        evaluator_available=evaluator_available,
        attach=attach,
    )
    return tasks, evolution, generation, trigger, package


def _ordinary(tasks, *, package_channel="general", package=None, context=None,
              benchmark_registration=None):
    state = tasks.create(
        "Exercise ordinary feedback capture",
        package_channel=package_channel,
        package=package,
        context=context or {"split": "development", "split_role": "development",
                            "private_evaluator_answer": PRIVATE_TEXT},
        benchmark_registration=benchmark_registration,
    )
    return tasks.run(state["id"])


def test_terminal_hook_enqueues_one_keyed_item_and_drain_projects_public_feedback(tmp_path):
    tasks, _, generation, trigger, _ = _services(tmp_path)
    episode = _ordinary(tasks)

    with ThreadPoolExecutor(max_workers=8) as workers:
        rows = list(workers.map(
            lambda _: trigger.observe_terminal(episode["id"]), range(16)))

    assert len({row["id"] for row in rows}) == 1
    work = tasks.store.feedback_triggers(limit=10)
    assert len(work) == 1
    assert work[0]["status"] == "observed"
    assert (work[0]["channel_id"], work[0]["parent_revision"],
            work[0]["source_episode_id"]) == ("general", 0, episode["id"])
    forged = deepcopy(work[0])
    forged["channel_id"] = "other"
    forged["trigger_key"] = digest({
        "schema": forged["schema"], "channel_id": "other",
        "parent_revision": 0, "source_episode_id": episode["id"],
    })
    forged["id"] = "feedback-work-" + forged["trigger_key"][:24]
    with pytest.raises(ValueError, match="frozen package channel"):
        tasks.store.put_feedback_trigger(forged)

    captured = trigger.drain()
    assert len(captured) == 1
    assert captured[0]["status"] == "feedback_captured"
    bundle = generation.feedback(captured[0]["feedback_bundle"]["id"])
    serialized = json.dumps({"work": captured[0], "bundle": bundle})
    assert PRIVATE_TEXT not in serialized
    assert bundle["episode_refs"][0]["public_feedback"][0] == {
        "event_digest": bundle["episode_refs"][0]["public_feedback"][0]["event_digest"],
        "source": "task_agent",
        "claim_status": "unverified",
        "signals": {"valid": False},
        "failure_code": "invalid_output",
    }
    assert trigger.drain() == []


@pytest.mark.parametrize("failure_domain,usage_complete,reason", [
    ("infrastructure", True, "source_infrastructure_failure"),
    ("agent", False, "source_usage_incomplete"),
])
def test_unknown_or_infrastructure_source_never_starts_rsi_development(
        tmp_path, monkeypatch, failure_domain, usage_complete, reason):
    tasks, _, _, trigger, _ = _services(tmp_path, attach=False)
    episode = tasks.create(
        "A public task with an uncertain terminal outcome",
        package_channel="general",
        context={"split": "development", "split_role": "development"})
    state = tasks.store.get(episode["id"])
    state["status"] = "failed"
    state["failure_domain"] = failure_domain
    tasks.store.save(state)
    original_usage = tasks.store.usage
    monkeypatch.setattr(tasks.store, "usage", lambda identity: {
        **original_usage(identity), "usage_complete": usage_complete})
    trigger.observe_terminal(episode["id"])

    [work] = trigger.drain()

    assert work["status"] == "deferred"
    assert work["reason"] == reason
    assert "feedback_bundle" not in work
    assert tasks.store.feedback_triggers(statuses=["feedback_captured"], limit=10) == []


def test_normal_channel_task_without_split_is_frozen_as_development_and_triggered(tmp_path):
    tasks, _, _, trigger, _ = _services(tmp_path)
    state = tasks.create("Normal CLI-style task", package_channel="general")
    assert state["task"]["context"]["split"] == "development"
    assert state["task"]["context"]["split_role"] == "development"

    episode = tasks.run(state["id"])
    work = tasks.store.feedback_triggers(limit=10)[0]
    assert work["source_episode_id"] == episode["id"]
    assert work["status"] == "observed"
    assert trigger.drain()[0]["status"] == "feedback_captured"


@pytest.mark.parametrize("case,expected_reason", [
    ("unconfigured", "missing_package_channel"),
    ("benchmark", "benchmark_source_excluded"),
    ("holdout", "holdout_source_excluded"),
])
def test_unconfigured_benchmark_and_holdout_sources_defer_without_capture(
        tmp_path, monkeypatch, case, expected_reason):
    tasks, _, generation, trigger, package = _services(tmp_path)
    monkeypatch.setattr(
        generation, "capture_feedback",
        lambda *args, **kwargs: pytest.fail("excluded source reached feedback capture"))
    if case == "unconfigured":
        episode = _ordinary(
            tasks, package_channel=None, package=package,
            context={"split": "development", "split_role": "development"})
    elif case == "benchmark":
        episode = _ordinary(tasks, benchmark_registration={
            "benchmark_id": "source-evaluator",
            "task_ref": {"id": "private-row", "answer": PRIVATE_TEXT},
            "snapshot": {"hidden": PRIVATE_TEXT},
        })
    else:
        episode = _ordinary(
            tasks, context={"split": "final_holdout", "split_role": "holdout"})

    work = trigger.observe_terminal(episode["id"])
    assert work["status"] == "deferred"
    assert work["reason"] == expected_reason
    if case == "unconfigured":
        assert work["channel_id"] is None
        assert work["parent_revision"] is None
    assert PRIVATE_TEXT not in json.dumps(work)
    assert trigger.drain() == []


def test_explicit_package_cannot_forge_a_channel_registration(tmp_path):
    tasks, _, _, _, package = _services(tmp_path)
    with pytest.raises(ContractError, match="host-owned"):
        tasks.create(
            "Forge a channel",
            package=package,
            context={"package_channel_registration": {
                "channel": "general", "revision": 0,
                "package_id": package["id"], "package_digest": package["digest"],
            }},
        )


@pytest.mark.parametrize("field,value", [
    ("budget", {"api_key": PRIVATE_TEXT}),
    ("permissions", {"token": PRIVATE_TEXT}),
    ("promotion_policy", {"private_prompt": PRIVATE_TEXT}),
    ("improver", {"channel": "recursive", "revision": 0,
                  "credential": PRIVATE_TEXT}),
])
def test_policy_rejects_arbitrary_private_or_credential_fields(
        tmp_path, field, value):
    tasks = TaskService(tmp_path, tools=ToolRegistry())
    with pytest.raises(ContractError, match="fields|identity"):
        AutoEvolutionService(
            tasks,
            policies={"general": {"evaluator_id": "independent", field: value}},
            attach=False,
        )


def test_missing_independent_evaluator_defers_before_feedback_capture(tmp_path, monkeypatch):
    tasks, _, generation, trigger, _ = _services(
        tmp_path, evaluator_available=lambda _identity: False)
    episode = _ordinary(tasks)
    monkeypatch.setattr(
        generation, "capture_feedback",
        lambda *args, **kwargs: pytest.fail("missing evaluator reached feedback capture"))

    [work] = trigger.drain()
    assert work["source_episode_id"] == episode["id"]
    assert work["status"] == "deferred"
    assert work["reason"] == "independent_evaluator_unavailable"


def test_restart_scan_discovers_missed_terminal_episode_and_is_idempotent(tmp_path):
    tasks = TaskService(tmp_path, tools=ToolRegistry())
    evolution = EvolutionService(tasks)
    package = _package()
    evolution.register("general", package)
    episode = _ordinary(tasks)
    assert tasks.store.feedback_triggers(limit=10) == []

    restarted_tasks = TaskService(tmp_path, tools=ToolRegistry())
    restarted_evolution = EvolutionService(restarted_tasks)
    restarted_generation = GenerationService(restarted_tasks, restarted_evolution)
    trigger = AutoEvolutionService(
        restarted_tasks,
        policies={"general": {"evaluator_id": "independent-evaluator"}},
        evolution_service=restarted_evolution,
        generation_service=restarted_generation,
        evaluator_available=lambda _identity: True,
    )
    first = trigger.scan(drain=True)
    assert any(row["source_episode_id"] == episode["id"]
               for row in first["observed"])
    [work] = restarted_tasks.store.feedback_triggers(limit=10)
    assert work["status"] == "feedback_captured"
    second = trigger.scan(drain=True)
    assert second["advanced"] == []
    assert len(restarted_tasks.store.feedback_triggers(limit=10)) == 1


def test_restart_scan_pages_all_terminal_episodes_and_drain_queue_progresses(tmp_path):
    tasks = TaskService(tmp_path, tools=ToolRegistry())
    evolution = EvolutionService(tasks)
    evolution.register("general", _package())
    episode_ids = {
        _ordinary(tasks, context={"split": "development", "split_role": "development"})["id"]
        for _ in range(5)
    }
    restarted_tasks = TaskService(tmp_path, tools=ToolRegistry())
    restarted_evolution = EvolutionService(restarted_tasks)
    trigger = AutoEvolutionService(
        restarted_tasks,
        policies={"general": {"evaluator_id": "independent-evaluator"}},
        evolution_service=restarted_evolution,
        generation_service=GenerationService(restarted_tasks, restarted_evolution),
        evaluator_available=lambda _identity: True,
    )

    cursor = None
    seen = set()
    while True:
        page = trigger.scan(after_id=cursor, limit=2, drain=False)
        seen.update(row["source_episode_id"] for row in page["observed"])
        cursor = page["next_cursor"]
        if cursor is None:
            break
    assert seen == episode_ids
    assert len(restarted_tasks.store.feedback_triggers(limit=10)) == 5

    advanced = []
    while True:
        page = trigger.drain(limit=2)
        if not page:
            break
        advanced.extend(page)
    assert len(advanced) == 5
    assert {row["status"] for row in advanced} == {"feedback_captured"}


def test_capture_commit_is_recovered_without_duplicate_bundle(tmp_path, monkeypatch):
    tasks, _, generation, trigger, _ = _services(tmp_path)
    episode = _ordinary(tasks)
    original = generation.capture_feedback

    def commit_then_interrupt(*args, **kwargs):
        original(*args, **kwargs)
        raise RuntimeError("simulated coordinator interruption")

    monkeypatch.setattr(generation, "capture_feedback", commit_then_interrupt)
    with pytest.raises(RuntimeError, match="simulated coordinator interruption"):
        trigger.drain()
    pending = tasks.store.feedback_triggers(limit=10)[0]
    assert pending["status"] == "feedback_capture_started"

    restarted_tasks = TaskService(tmp_path, tools=ToolRegistry())
    restarted_evolution = EvolutionService(restarted_tasks)
    restarted_generation = GenerationService(restarted_tasks, restarted_evolution)
    restarted = AutoEvolutionService(
        restarted_tasks,
        policies={"general": {"evaluator_id": "independent-evaluator"}},
        evolution_service=restarted_evolution,
        generation_service=restarted_generation,
        evaluator_available=lambda _identity: True,
    )
    [recovered] = restarted.drain()
    assert recovered["status"] == "feedback_captured"
    assert recovered["source_episode_id"] == episode["id"]
    with restarted_tasks.store.connect() as db:
        assert db.execute("SELECT COUNT(*) FROM task_feedback_bundles").fetchone()[0] == 1
