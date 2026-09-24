"""Focused E3-B.2c independent adoption and later-use coverage."""

from copy import deepcopy
import threading

import pytest

import nexgent.tasks.runtime as runtime_module
from nexgent.kernel.programs import digest
from nexgent.tasks.evolution import EvolutionService
from nexgent.tasks.feedback_trigger import AutoEvolutionService, DEVELOPMENT_PLAN_SCHEMA
from nexgent.tasks.generation import GenerationService
from nexgent.tasks.improvers import ImproverService
from nexgent.tasks.packages import make_package
from nexgent.tasks.runtime import TaskService
from nexgent.tasks.tools import ToolRegistry


def _hypothesis():
    return {
        "failure_mechanism": "The active package emits the old version.",
        "expected_behavior": "The replacement emits the new version.",
        "applicability": "Tasks executing the same generic entry.",
        "falsifier": "Independent paired tasks do not improve.",
    }


def _parent():
    return make_package(
        {"main.py": (
            "def execute(payload, context):\n"
            "    artifact = context.publish({'version': 0}, name='result')\n"
            "    context.feedback({'valid': False, 'failure_code': 'old_version'})\n"
            "    return {'deliverables': {'result': artifact['id']}}\n"
        )}, {"entries": {"execute": "main.py:execute"}},
        provenance={"fixture": "feedback-adoption-parent"})


def _improver(parent):
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
        "schema": DEVELOPMENT_PLAN_SCHEMA, "candidate_type": "orchestration",
        "source_ref": "package_patch", "hypothesis": _hypothesis(),
        "reason": "Test one reusable package entry repair.",
    }
    source = (
        f"PLAN = {plan!r}\nPATCH = {patch!r}\n"
        "def execute(payload, context):\n"
        "    artifact = context.publish(PLAN, name='development_plan', "
        f"schema='{DEVELOPMENT_PLAN_SCHEMA}')\n"
        "    return {'deliverables': {'development_plan': artifact['id']}}\n"
        "def improve(payload, context):\n"
        "    artifact = context.publish(PATCH, name='behavior_patch')\n"
        "    return {'deliverables': {'behavior_patch': artifact['id']}}\n"
    )
    return make_package(
        {"improver.py": source},
        {"entries": {"execute": "improver.py:execute",
                     "improve": "improver.py:improve"}},
        provenance={"fixture": "feedback-adoption-improver"})


class IndependentBenchmark:
    id = "independent-evaluator"

    def __init__(self, direction=1, *, guard_regression=False):
        self.direction = direction
        self.guard_regression = guard_regression
        self.evaluations = []

    def snapshot(self):
        return {"id": self.id, "version": 1, "direction": self.direction,
                "guard_regression": self.guard_regression}

    def describe(self):
        return {"id": self.id, "kind": "deterministic-independent-fixture"}

    def tasks(self, split="selection", seed=0):
        return [{
            "id": f"{split}/{seed}/version", "objective": "Return the package version",
            "inputs": {}, "deliverables": [{"name": "result", "schema": {
                "type": "object", "required": ["version"],
                "properties": {"version": {"type": "integer"}},
            }}], "capabilities": [], "context": {"split": split},
        }]

    def evaluate(self, task_ref, deliverables, execution_view):
        version = deliverables["result"]["version"]
        self.evaluations.append({
            "task": deepcopy(task_ref), "episode_id": execution_view["episode_id"],
            "version": version,
        })
        regressed = (self.guard_regression
                     and task_ref.get("context", {}).get("split") == "guard")
        return {"status": "rejected" if regressed else "accepted",
                "score_available": True, "accepted": not regressed,
                "score": -1 if regressed else self.direction * version}


def _ready(tmp_path, monkeypatch, *, direction=1, guard_regression=False):
    tasks = TaskService(tmp_path, tools=ToolRegistry())
    evolution = EvolutionService(tasks)
    parent = _parent()
    evolution.register("general", parent)
    generation = GenerationService(tasks, evolution)
    ImproverService(tasks).register(
        "ordinary-improver", _improver(parent),
        {"mutable_paths": ["improver.py"], "allowed_operations": ["replace"]})
    adapter = IndependentBenchmark(
        direction=direction, guard_regression=guard_regression)
    monkeypatch.setattr(
        runtime_module, "task_benchmarks",
        lambda project_root=None: {adapter.id: adapter})
    trigger = AutoEvolutionService(
        tasks, policies={"general": {
            "evaluator_id": adapter.id,
            "candidate_types": ["orchestration", "no_change"],
            "budget": {"max_model_calls": 0, "max_completion_tokens": 0,
                       "max_tool_calls": 0, "max_nodes": 8},
            "improver": {"channel": "ordinary-improver", "revision": 0},
            "promotion_policy": {"min_quality_delta": 0.1,
                                 "max_regressions": 0},
        }}, evolution_service=evolution, generation_service=generation)
    source = tasks.create("Ordinary source", package_channel="general")
    tasks.run(source["id"])
    trigger.drain()
    [work] = trigger.drain_development()
    assert work["status"] == "candidate_ready"
    return tasks, evolution, trigger, adapter, parent, work


def test_candidate_is_independently_selected_promoted_guarded_and_later_reused(
        tmp_path, monkeypatch):
    tasks, evolution, trigger, adapter, parent, ready = _ready(tmp_path, monkeypatch)

    result = trigger.advance()
    assert result["feedback"] == []
    assert result["development"] == []
    [work] = result["evolution"]

    assert work["id"] == ready["id"]
    assert work["status"] == "completed"
    assert evolution.active("general")["revision"] == 1
    assert evolution.active("general")["package_id"] == work["candidate"][
        "candidate_package_id"]
    assert work["evolution"]["selection_intent"] == {
        "evaluator_id": adapter.id,
        "snapshot_digest": digest(adapter.snapshot()),
        "split": "selection", "seed": 0,
    }
    assert work["evolution"]["guard_intent"]["split"] == "guard"
    assert len(adapter.evaluations) == 3  # two paired arms and one guard run
    assert evolution.active("general")["package_id"] != parent["id"]

    later = tasks.create("Later ordinary task", package_channel="general")
    later = tasks.run(later["id"])
    refreshed = tasks.store.feedback_trigger(work["id"])
    assert refreshed["reuse_observed"][0]["episode_id"] == later["id"]
    assert refreshed["reuse_observed"][0]["activation"]["loaded"] is True
    assert refreshed["reuse_observed"][0]["channel_revision"] == 1


def test_failed_independent_pair_is_rejected_without_promotion(tmp_path, monkeypatch):
    _, evolution, trigger, _, parent, _ = _ready(
        tmp_path, monkeypatch, direction=-1)

    [work] = trigger.drain_evolution()

    assert work["status"] == "rejected"
    assert work["reason"] == "independent_selection_rejected"
    assert work["evolution"]["selection_decision"]["eligible"] is False
    assert "guard_plan" not in work["evolution"]
    assert evolution.active("general")["package_id"] == parent["id"]


def test_guard_regression_rolls_back_the_promoted_candidate(tmp_path, monkeypatch):
    _, evolution, trigger, _, parent, _ = _ready(
        tmp_path, monkeypatch, guard_regression=True)

    [work] = trigger.drain_evolution()

    assert work["status"] == "rolled_back"
    assert work["reason"] == "guard_regression_rolled_back"
    assert work["evolution"]["guard_assessment"]["degraded"] is True
    assert work["evolution"]["guard_assessment"]["rolled_back"] is True
    active = evolution.active("general")
    assert active["package_id"] == parent["id"]
    assert active["revision"] == 2


def test_unknown_pair_run_is_deferred_and_not_replayed(tmp_path, monkeypatch):
    _, evolution, trigger, _, parent, ready = _ready(tmp_path, monkeypatch)
    calls = []

    def unknown(*args, **kwargs):
        calls.append((args, kwargs))
        raise RuntimeError("unknown external outcome")

    monkeypatch.setattr(evolution, "run_pair", unknown)
    [work] = trigger.drain_evolution()

    assert work["status"] == "deferred"
    assert work["reason"] == "selection_run_outcome_unknown"
    assert len(calls) == 1
    assert trigger.evolve(ready["id"])["status"] == "deferred"
    assert len(calls) == 1
    assert evolution.active("general")["package_id"] == parent["id"]


def test_restart_at_unkeyed_plan_intent_defers_without_replanning(tmp_path, monkeypatch):
    tasks, _, trigger, adapter, _, ready = _ready(tmp_path, monkeypatch)
    intent = {"evaluator_id": adapter.id,
              "snapshot_digest": digest(adapter.snapshot()),
              "split": "selection", "seed": 0}
    pending = tasks.store.transition_feedback_trigger(
        ready["id"], expected_revision=ready["revision"],
        status="selection_plan_started",
        evolution_update={"selection_intent": intent})

    work = trigger.evolve(pending["id"])

    assert work["status"] == "deferred"
    assert work["reason"] == "selection_plan_started_outcome_unknown"
    with tasks.store.connect() as db:
        assert db.execute("SELECT COUNT(*) FROM task_evolution_plans").fetchone()[0] == 0


def test_stop_event_reaches_pair_and_halts_before_assessment(tmp_path, monkeypatch):
    _, evolution, trigger, _, parent, ready = _ready(tmp_path, monkeypatch)
    stop = threading.Event()
    seen = []
    original = evolution.run_pair

    def run_pair(plan_id, adapter, *, stop_event=None):
        seen.append(stop_event)
        result = original(plan_id, adapter, stop_event=stop_event)
        stop_event.set()
        return result

    monkeypatch.setattr(evolution, "run_pair", run_pair)
    work = trigger.evolve(ready["id"], stop_event=stop)

    assert seen == [stop]
    assert work["status"] == "selection_planned"
    assert "selection_decision" not in (work.get("evolution") or {})
    assert evolution.active("general")["package_id"] == parent["id"]
    assert evolution.inspect_run_claim(
        "paired", work["evolution"]["selection_plan"]["id"])["status"] == "completed"


def test_stop_event_reaches_guard_and_resumes_from_durable_monitor(
        tmp_path, monkeypatch):
    _, evolution, trigger, _, _, ready = _ready(tmp_path, monkeypatch)
    stop = threading.Event()
    seen = []
    original = evolution.run_monitor

    def run_monitor(channel, adapter, *, stop_event=None, **kwargs):
        seen.append(stop_event)
        result = original(channel, adapter, stop_event=stop_event, **kwargs)
        stop_event.set()
        return result

    monkeypatch.setattr(evolution, "run_monitor", run_monitor)
    work = trigger.evolve(ready["id"], stop_event=stop)

    assert seen == [stop]
    assert work["status"] == "promoted"
    assert "guard_run" not in (work.get("evolution") or {})
    plan_id = work["evolution"]["guard_plan"]["id"]
    assert evolution.inspect_run_claim("monitor", plan_id)["status"] == "completed"

    monkeypatch.setattr(evolution, "run_monitor", original)
    resumed = trigger.evolve(work["id"], stop_event=threading.Event())
    assert resumed["status"] == "completed"
    assert seen == [stop]
