"""Focused E3-B.2b planning and candidate-dispatch tests."""

from copy import deepcopy
import json
import threading

import pytest

from nexgent.kernel.programs import digest
from nexgent.tasks.benchmarks import BenchmarkDescriptor
from nexgent.tasks.evolution import EvolutionService
from nexgent.tasks.feedback_trigger import (
    AutoEvolutionService,
    DEVELOPMENT_PLAN_SCHEMA,
)
from nexgent.tasks.generation import GenerationService
from nexgent.tasks.improvers import ImproverService, active_improver_registration
from nexgent.tasks.multirole_seed import multirole_package
from nexgent.tasks.orchestration_development import DevelopmentOrchestrationQualifier
from nexgent.tasks.orchestration_search import QUALIFICATION_SCHEMA
from nexgent.tasks.packages import make_package
from nexgent.tasks.runtime import TaskService
from nexgent.tasks.tools import ContractError, ToolRegistry


PRIVATE_TEXT = "PRIVATE-EVALUATOR-DATA-MUST-NOT-ENTER-DEVELOPMENT"


def _parent():
    source = (
        "def execute(payload, context):\n"
        "    artifact = context.publish({'version': 0}, name='result')\n"
        "    context.feedback({'valid': False, 'failure_code': 'invalid_output', "
        f"'note': '{PRIVATE_TEXT}'}})\n"
        "    return {'deliverables': {'result': artifact['id']}}\n"
    )
    return make_package(
        {"main.py": source}, {"entries": {"execute": "main.py:execute"}},
        provenance={"fixture": "feedback-development-parent"},
    )


def _improver(plan, patch=None):
    source = (
        "PLAN = " + repr(plan) + "\n"
        "PATCH = " + repr(patch) + "\n"
        "def execute(payload, context):\n"
        "    artifact = context.publish(PLAN, name='development_plan', "
        f"schema='{DEVELOPMENT_PLAN_SCHEMA}')\n"
        "    return {'deliverables': {'development_plan': artifact['id']}}\n"
        "def improve(payload, context):\n"
        "    if PATCH is None:\n"
        "        raise ValueError('no package mutation was selected')\n"
        "    artifact = context.publish(PATCH, name='behavior_patch')\n"
        "    return {'deliverables': {'behavior_patch': artifact['id']}}\n"
    )
    return make_package(
        {"improver.py": source},
        {"entries": {"execute": "improver.py:execute",
                     "improve": "improver.py:improve"}},
        provenance={"fixture": "feedback-development-improver"},
    )


def _setup(tmp_path, plan, *, patch=None, improver_revision=0):
    tasks = TaskService(tmp_path, tools=ToolRegistry())
    evolution = EvolutionService(tasks)
    parent = _parent()
    evolution.register("general", parent)
    generation = GenerationService(tasks, evolution)
    improver = _improver(plan, patch)
    ImproverService(tasks).register(
        "ordinary-improver", improver,
        {"mutable_paths": ["improver.py"], "allowed_operations": ["replace"]},
    )
    trigger = AutoEvolutionService(
        tasks,
        policies={"general": {
            "evaluator_id": "independent-evaluator",
            "candidate_types": ["orchestration", "no_change"],
            "budget": {"max_model_calls": 0, "max_completion_tokens": 0,
                       "max_tool_calls": 0, "max_nodes": 8},
            "improver": {"channel": "ordinary-improver",
                         "revision": improver_revision},
        }},
        evolution_service=evolution, generation_service=generation,
        evaluator_available=lambda _identity: True,
    )
    episode = tasks.create(
        "Produce an ordinary public result", package_channel="general",
        context={"split": "development", "split_role": "development",
                 "private_evaluator_answer": PRIVATE_TEXT},
    )
    episode = tasks.run(episode["id"])
    [captured] = trigger.drain()
    return tasks, evolution, trigger, parent, episode, captured


def _hypothesis():
    return {
        "failure_mechanism": "The current task loop emits an invalid public result.",
        "expected_behavior": "The replacement emits the required public result shape.",
        "applicability": "Tasks executed by the same generic loop.",
        "falsifier": "Independent tasks do not improve when the component is loaded.",
    }


class _SearchAdapter:
    id = "ordinary-search-evaluator"
    descriptor = BenchmarkDescriptor(
        id=id, version="1", title="Ordinary search fixture",
        splits=("development",), default_split="development",
        allowed_suite_roles=("qualification",))

    def describe(self):
        return {"id": self.id}

    def snapshot(self):
        return {"dataset": "ordinary-search-v1"}

    def tasks(self, split, seed, **_options):
        return [{
            "id": f"fresh-{seed}", "objective": "Solve a fresh public task",
            "statistical_unit_id": f"fresh-unit-{seed}", "inputs": {},
            "context": {}, "constraints": {}, "deliverables": [],
            "capabilities": [],
        }]

    def evaluate(self, task_ref, deliverables, execution_view):
        raise AssertionError("Qualification is projected by the deterministic boundary")


def _search_patch(parent):
    workflow = json.loads(parent["files"]["workflows/main.json"])
    proposer = next(node for node in workflow["nodes"]
                    if node["id"] == "proposer_b")
    proposer["role_ref"] = "proposer_a"
    proposer["component_ref"] = "proposer-a-role"
    return {
        "schema": "nexgent.package-patch.v3",
        "parent_package_digest": parent["digest"],
        "hypothesis": {
            **_hypothesis(), "component_ids": ["main-workflow"],
        },
        "activation_targets": ["main-workflow"],
        "operations": [{
            "op": "replace", "component_id": "main-workflow",
            "old_digest": parent["component_digests"]["workflows/main.json"],
            "content": json.dumps(workflow, sort_keys=True),
        }],
        "child_manifest": deepcopy(parent["manifest"]),
    }


def _search_setup(tmp_path, monkeypatch):
    from nexgent.tasks import runtime as runtime_module

    adapter = _SearchAdapter()
    monkeypatch.setattr(runtime_module, "task_benchmarks",
                        lambda *_args, **_kwargs: {adapter.id: adapter})
    tasks = TaskService(tmp_path, tools=ToolRegistry())
    evolution = EvolutionService(tasks)
    parent = multirole_package()
    evolution.register("general", parent)
    generation = GenerationService(tasks, evolution)
    plan = {
        "schema": DEVELOPMENT_PLAN_SCHEMA,
        "candidate_type": "orchestration",
        "source_ref": "orchestration_search",
        "hypothesis": _hypothesis(),
        "reason": "Search bounded O variants against fresh development tasks.",
    }
    improver = _improver(plan, _search_patch(parent))
    ImproverService(tasks).register(
        "ordinary-improver", improver,
        {"mutable_paths": ["improver.py"], "allowed_operations": ["replace"]})
    trigger = AutoEvolutionService(
        tasks,
        policies={"general": {
            "evaluator_id": adapter.id,
            "candidate_types": ["orchestration", "no_change"],
            "budget": {"max_model_calls": 0, "max_completion_tokens": 0,
                       "max_tool_calls": 0, "max_nodes": 8},
            "improver": {"channel": "ordinary-improver", "revision": 0},
            "orchestration_search": {
                "max_attempts": 2, "first_seed": 7,
                "minimum_mean_delta": 0.0,
                "max_model_calls": 1, "max_completion_tokens": 100,
                "max_tool_calls": 0, "max_nodes": 20,
                "development_episode_budget": {
                    "max_model_calls": 1, "max_completion_tokens": 50,
                    "max_tool_calls": 0, "max_nodes": 10,
                },
            },
        }},
        evolution_service=evolution, generation_service=generation)
    episode = tasks.create(
        "Ordinary source task", package_channel="general",
        context={"split": "development", "split_role": "development"})
    state = tasks.get_private(episode["id"])
    state["status"] = "completed"
    state["usage"]["usage_complete"] = True
    state["outcome"] = {"delivery_status": "delivered",
                        "schema_validation": "passed"}
    tasks.store.save(state)
    trigger.observe_terminal(episode["id"])
    [captured] = trigger.drain()

    def qualify(_self, candidate, _remaining):
        return {
            "schema": QUALIFICATION_SCHEMA,
            "candidate_id": candidate["id"],
            "tasks": [{
                "statistical_unit_id": "fresh-unit-7",
                "parent_status": "completed", "candidate_status": "completed",
                "parent_score_available": True,
                "candidate_score_available": True,
                "parent_score": 0.25, "candidate_score": 0.5,
                "activation_loaded": True, "artifact_contract_valid": True,
            }],
            "usage": {"model_calls": 0, "completion_tokens": 0,
                      "tool_calls": 0, "nodes": 0, "usage_complete": True},
            "evidence_refs": {"plan_id": "deterministic-plan",
                              "trial_id": "deterministic-trial"},
        }

    monkeypatch.setattr(DevelopmentOrchestrationQualifier, "__call__", qualify)
    return tasks, evolution, generation, trigger, parent, improver, captured


def test_failed_generated_workflow_is_not_offered_for_direct_reuse(tmp_path):
    plan = {
        "schema": DEVELOPMENT_PLAN_SCHEMA, "candidate_type": "no_change",
        "source_ref": None, "hypothesis": None, "reason": "No reusable evidence.",
    }
    tasks, evolution, trigger, _, episode, work = _setup(tmp_path, plan)
    failed = tasks.get_private(episode["id"])
    failed["status"] = "failed"
    failed["plan_workflow_ref"] = "generated://archived-but-failed"
    options = trigger._candidate_options(work, failed, evolution.active("general"))
    assert {item["source_ref"] for item in options} == {"package_patch", None}


def test_public_feedback_planner_can_abstain_without_candidate_or_promotion(tmp_path):
    plan = {
        "schema": DEVELOPMENT_PLAN_SCHEMA,
        "candidate_type": "no_change", "source_ref": None,
        "hypothesis": None,
        "reason": "The bounded evidence does not identify a reusable mechanism.",
    }
    tasks, evolution, trigger, parent, _, captured = _setup(tmp_path, plan)

    [work] = trigger.drain_development()

    assert work["id"] == captured["id"]
    assert work["status"] == "no_change"
    assert "candidate" not in work
    assert evolution.active("general")["package_id"] == parent["id"]
    development = tasks.get_private(work["development_episode"]["id"])
    exposed = [tasks.store.read(identity, development["id"])["content"]
               for identity in development["input_refs"].values()]
    assert PRIVATE_TEXT not in json.dumps(exposed)
    # The coordinator's own Episode is excluded from the ordinary-task outbox.
    assert len(tasks.store.feedback_triggers(limit=20)) == 1


def test_public_plan_dispatches_one_generated_candidate_and_stops_before_selection(tmp_path):
    parent = _parent()
    replacement = parent["files"]["main.py"].replace("'version': 0", "'version': 1")
    patch = {
        "schema": "nexgent.behavior-patch.v1",
        "hypothesis": _hypothesis(),
        "operations": [{
            "op": "replace", "path": "main.py",
            "old_digest": parent["component_digests"]["main.py"],
            "content": replacement,
        }],
        "activation_probe": {"kind": "component_loaded", "path": "main.py"},
    }
    plan = {
        "schema": DEVELOPMENT_PLAN_SCHEMA,
        "candidate_type": "orchestration", "source_ref": "package_patch",
        "hypothesis": _hypothesis(),
        "reason": "A generic loop repair is supported by the public failure signal.",
    }
    tasks, evolution, trigger, active_parent, _, _ = _setup(
        tmp_path, plan, patch=patch)

    [work] = trigger.drain_development()

    assert work["status"] == "candidate_ready"
    candidate = evolution.candidate(work["candidate"]["candidate_id"])
    assert candidate["parent_package_id"] == active_parent["id"]
    assert candidate["package_id"] == work["candidate"]["candidate_package_id"]
    assert candidate["origin"] == "generated"
    assert evolution.active("general")["revision"] == 0
    assert evolution.active("general")["package_id"] == active_parent["id"]
    assert not any(event["kind"] == "package_promoted"
                   for event in evolution.events("general"))
    assert tasks.store.feedback_triggers(
        statuses=["feedback_captured", "development_planned", "development_run"],
        limit=20) == []


def test_stale_frozen_improver_revision_defers_before_development_episode(tmp_path):
    plan = {
        "schema": DEVELOPMENT_PLAN_SCHEMA,
        "candidate_type": "no_change", "source_ref": None,
        "hypothesis": None, "reason": "No reusable change.",
    }
    tasks, _, trigger, _, _, _ = _setup(
        tmp_path, plan, improver_revision=1)

    [work] = trigger.drain_development()

    assert work["status"] == "deferred"
    assert work["reason"] == "improver_revision_changed"
    assert not any((episode.get("task", {}).get("context") or {}).get("rsi_role")
                   == "ordinary_feedback_development"
                   for episode in tasks.store.list())


def test_planner_cannot_select_an_unavailable_source_receipt(tmp_path):
    plan = {
        "schema": DEVELOPMENT_PLAN_SCHEMA,
        "candidate_type": "orchestration", "source_ref": "invented-receipt",
        "hypothesis": _hypothesis(), "reason": "Invented evidence must fail closed.",
    }
    _, evolution, trigger, parent, _, _ = _setup(tmp_path, plan)

    [work] = trigger.drain_development()

    assert work["status"] == "rejected"
    assert work["reason"] == "development_plan_rejected"
    assert evolution.active("general")["package_id"] == parent["id"]


def test_unknown_generation_outcome_is_deferred_and_never_replayed(tmp_path, monkeypatch):
    parent = _parent()
    replacement = parent["files"]["main.py"].replace("'version': 0", "'version': 1")
    patch = {
        "schema": "nexgent.behavior-patch.v1", "hypothesis": _hypothesis(),
        "operations": [{
            "op": "replace", "path": "main.py",
            "old_digest": parent["component_digests"]["main.py"],
            "content": replacement,
        }],
        "activation_probe": {"kind": "component_loaded", "path": "main.py"},
    }
    plan = {
        "schema": DEVELOPMENT_PLAN_SCHEMA,
        "candidate_type": "orchestration", "source_ref": "package_patch",
        "hypothesis": _hypothesis(), "reason": "Attempt one bounded repair.",
    }
    _, _, trigger, _, _, _ = _setup(tmp_path, plan, patch=patch)
    calls = []

    def interrupted(*args, **kwargs):
        calls.append((args, kwargs))
        raise RuntimeError("simulated unknown provider outcome")

    monkeypatch.setattr(trigger, "_dispatch_plan", interrupted)
    [work] = trigger.drain_development()

    assert work["status"] == "deferred"
    assert work["reason"] == "candidate_generation_outcome_unknown"
    assert len(calls) == 1
    assert trigger.develop(work["id"])["status"] == "deferred"
    assert len(calls) == 1


def test_development_stop_event_reaches_planner_and_generation(
        tmp_path, monkeypatch):
    parent = _parent()
    replacement = parent["files"]["main.py"].replace("'version': 0", "'version': 1")
    patch = {
        "schema": "nexgent.behavior-patch.v1", "hypothesis": _hypothesis(),
        "operations": [{
            "op": "replace", "path": "main.py",
            "old_digest": parent["component_digests"]["main.py"],
            "content": replacement,
        }],
        "activation_probe": {"kind": "component_loaded", "path": "main.py"},
    }
    plan = {
        "schema": DEVELOPMENT_PLAN_SCHEMA,
        "candidate_type": "orchestration", "source_ref": "package_patch",
        "hypothesis": _hypothesis(), "reason": "Attempt one bounded repair.",
    }
    tasks, _, trigger, _, _, _ = _setup(tmp_path, plan, patch=patch)
    stop = threading.Event()
    run_events = []
    generation_events = []
    original_run = tasks.run
    original_generate = trigger._generation.generate

    def observed_run(identity, *args, **kwargs):
        run_events.append(kwargs.get("stop_event"))
        return original_run(identity, *args, **kwargs)

    def observed_generate(*args, **kwargs):
        generation_events.append(kwargs.get("stop_event"))
        return original_generate(*args, **kwargs)

    monkeypatch.setattr(tasks, "run", observed_run)
    monkeypatch.setattr(trigger._generation, "generate", observed_generate)

    [work] = trigger.drain_development(stop_event=stop)

    assert work["status"] == "candidate_ready"
    assert generation_events == [stop]
    # One planner Episode and one improver Episode use the same cancellation.
    assert run_events == [stop, stop]


def test_dispatch_passes_stop_event_to_capability_and_skill_adoption(
        tmp_path, monkeypatch):
    plan = {
        "schema": DEVELOPMENT_PLAN_SCHEMA,
        "candidate_type": "no_change", "source_ref": None,
        "hypothesis": None, "reason": "No reusable change.",
    }
    _, _, trigger, _, _, work = _setup(tmp_path, plan)
    stop = threading.Event()
    seen = []

    from nexgent.tasks.task_capability_adoption import TaskCapabilityAdoptionService
    from nexgent.tasks.task_skill_adoption import TaskSkillAdoptionService

    def capability(_self, *args, **kwargs):
        seen.append(("capability", kwargs.get("stop_event")))
        return {"generation": {"status": "missing"}}

    def skill(_self, *args, **kwargs):
        seen.append(("skill", kwargs.get("stop_event")))
        return {"generation": {"status": "missing"}}

    monkeypatch.setattr(TaskCapabilityAdoptionService, "adopt", capability)
    monkeypatch.setattr(TaskSkillAdoptionService, "adopt_episode", skill)
    trigger._dispatch_plan(work, {
        "candidate_type": "tool", "source_ref": "definition-fixture",
        "hypothesis": _hypothesis()}, stop_event=stop)
    trigger._dispatch_plan(work, {
        "candidate_type": "orchestration", "source_ref": "episode_os",
        "hypothesis": _hypothesis()}, stop_event=stop)

    assert seen == [("capability", stop), ("skill", stop)]


def test_advance_passes_stop_event_to_both_model_work_queues(
        tmp_path, monkeypatch):
    plan = {
        "schema": DEVELOPMENT_PLAN_SCHEMA,
        "candidate_type": "no_change", "source_ref": None,
        "hypothesis": None, "reason": "No reusable change.",
    }
    _, _, trigger, _, _, _ = _setup(tmp_path, plan)
    stop = threading.Event()
    seen = []
    monkeypatch.setattr(
        trigger, "drain_development",
        lambda *, limit, stop_event: seen.append(("development", stop_event)) or [])
    monkeypatch.setattr(
        trigger, "drain_evolution",
        lambda *, limit, stop_event: seen.append(("evolution", stop_event)) or [])

    trigger.advance(stop_event=stop)

    assert seen == [("development", stop), ("evolution", stop)]


def test_cancelled_generation_defers_without_replaying_uncertain_boundary(
        tmp_path, monkeypatch):
    parent = _parent()
    replacement = parent["files"]["main.py"].replace("'version': 0", "'version': 1")
    patch = {
        "schema": "nexgent.behavior-patch.v1", "hypothesis": _hypothesis(),
        "operations": [{
            "op": "replace", "path": "main.py",
            "old_digest": parent["component_digests"]["main.py"],
            "content": replacement,
        }],
        "activation_probe": {"kind": "component_loaded", "path": "main.py"},
    }
    plan = {
        "schema": DEVELOPMENT_PLAN_SCHEMA,
        "candidate_type": "orchestration", "source_ref": "package_patch",
        "hypothesis": _hypothesis(), "reason": "Attempt one bounded repair.",
    }
    _, _, trigger, _, _, _ = _setup(tmp_path, plan, patch=patch)
    stop = threading.Event()
    calls = []

    def interrupted(work, selected, *, stop_event=None):
        calls.append(stop_event)
        stop_event.set()
        return {"status": "missing"}

    monkeypatch.setattr(trigger, "_dispatch_plan", interrupted)
    [work] = trigger.drain_development(stop_event=stop)

    assert calls == [stop]
    assert work["status"] == "deferred"
    assert work["reason"] == "candidate_generation_interrupted"
    assert trigger.develop(work["id"], stop_event=threading.Event())["status"] == (
        "deferred")
    assert calls == [stop]


def test_user_context_cannot_forge_internal_development_role(tmp_path):
    plan = {
        "schema": DEVELOPMENT_PLAN_SCHEMA,
        "candidate_type": "no_change", "source_ref": None,
        "hypothesis": None, "reason": "No reusable change.",
    }
    tasks, _, trigger, _, _, captured = _setup(tmp_path, plan)
    forged = tasks.create(
        "Try to suppress ordinary feedback",
        package_channel="general",
        context={
            "split": "development", "split_role": "development",
            "rsi_role": "ordinary_feedback_development",
            "feedback_work_id": captured["id"],
            "feedback_bundle_id": captured["feedback_bundle"]["id"],
        },
    )
    forged = tasks.run(forged["id"])

    work = next(row for row in tasks.store.feedback_triggers(limit=20)
                if row["source_episode_id"] == forged["id"])
    assert work["status"] == "observed"
    assert work["source"]["kind"] == "ordinary_development"
    assert trigger._source_kind(tasks.get_private(forged["id"])) == "ordinary_development"


def test_forged_planning_context_cannot_hijack_recovered_development_episode(tmp_path):
    plan = {
        "schema": DEVELOPMENT_PLAN_SCHEMA,
        "candidate_type": "no_change", "source_ref": None,
        "hypothesis": None, "reason": "No reusable change.",
    }
    tasks, _, trigger, _, _, captured = _setup(tmp_path, plan)
    improver = active_improver_registration(tasks.store, "ordinary-improver")
    forged = tasks.create(
        "Try to preempt development recovery",
        package=improver["package"],
        context={
            "split": "development", "split_role": "development",
            "rsi_role": "ordinary_feedback_development",
            "feedback_work_id": captured["id"],
            "feedback_bundle_id": captured["feedback_bundle"]["id"],
        },
    )

    [work] = trigger.drain_development()
    assert work["status"] == "no_change"
    assert work["development_episode"]["id"] != forged["id"]


def test_ordinary_feedback_can_select_bounded_search_and_reach_candidate_ready(
        tmp_path, monkeypatch):
    tasks, evolution, generation, trigger, parent, improver, captured = \
        _search_setup(tmp_path, monkeypatch)

    [work] = trigger.drain_development()

    assert work["status"] == "candidate_ready"
    assert work["development_plan"]["source_ref"] == "orchestration_search"
    assert work["search_intent"]["policy"]["target_qualified"] == 1
    assert work["search_intent"]["source_statistical_units"] == [
        "ordinary:" + work["source_episode_id"]]
    options = {(item["candidate_type"], item["source_ref"])
               for item in work["development_intent"]["options"]}
    assert ("orchestration", "package_patch") in options
    assert ("orchestration", "orchestration_search") in options
    candidate = evolution.candidate(work["candidate"]["candidate_id"])
    generated = generation.generation(work["candidate"]["generation_id"])
    assert candidate["parent_package_id"] == parent["id"]
    assert generated["improver_package_id"] == improver["id"]
    assert evolution.active("general")["revision"] == 0
    assert captured["id"] == work["id"]


def test_finished_search_recovers_candidate_without_second_generation(
        tmp_path, monkeypatch):
    _, _, generation, trigger, _, _, _ = _search_setup(tmp_path, monkeypatch)
    calls = []
    original_generate = generation.generate
    original_transition = trigger.store.transition_feedback_trigger
    interrupted = {"value": False}

    def counted(*args, **kwargs):
        calls.append(kwargs.get("search_attempt_id"))
        return original_generate(*args, **kwargs)

    def lose_candidate_ready(identity, **kwargs):
        if kwargs.get("status") == "candidate_ready" and not interrupted["value"]:
            interrupted["value"] = True
            raise RuntimeError("simulated coordinator interruption after search finish")
        return original_transition(identity, **kwargs)

    monkeypatch.setattr(generation, "generate", counted)
    monkeypatch.setattr(trigger.store, "transition_feedback_trigger",
                        lose_candidate_ready)
    with pytest.raises(RuntimeError, match="coordinator interruption"):
        trigger.drain_development()
    monkeypatch.setattr(trigger.store, "transition_feedback_trigger",
                        original_transition)

    [work] = trigger.drain_development()

    assert work["status"] == "candidate_ready"
    assert len(calls) == 1


def test_open_or_unknown_search_fails_closed_without_replay(
        tmp_path, monkeypatch):
    _, _, _, trigger, _, _, _ = _search_setup(tmp_path, monkeypatch)
    calls = []

    def unresolved(_work, *, stop_event=None):
        calls.append(stop_event)
        raise ContractError("caller-owned search is unfinished")

    monkeypatch.setattr(trigger, "_run_orchestration_search", unresolved)
    [work] = trigger.drain_development()

    assert work["status"] == "deferred"
    assert work["reason"] == "orchestration_search_outcome_unknown"
    assert trigger.develop(work["id"])["status"] == "deferred"
    assert len(calls) == 1
