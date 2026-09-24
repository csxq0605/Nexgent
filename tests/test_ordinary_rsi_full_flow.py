"""One vertical ordinary-task RSI flow across the real service boundaries."""

from copy import deepcopy
import json
import threading

import nexgent.tasks.runtime as runtime_module
from nexgent.tasks.benchmarks import BenchmarkDescriptor
from nexgent.tasks.evolution import EvolutionService
from nexgent.tasks.feedback_trigger import AutoEvolutionService, DEVELOPMENT_PLAN_SCHEMA
from nexgent.tasks.generation import GenerationService
from nexgent.tasks.improvers import ImproverService
from nexgent.tasks.multirole_seed import multirole_package
from nexgent.tasks.orchestration_search import OrchestrationSearchJournal
from nexgent.tasks.packages import make_package
from nexgent.tasks.runtime import TaskService
from nexgent.tasks.tools import ToolRegistry


PRIVATE_EVALUATOR_DATA = "PRIVATE-EVALUATOR-DATA-MUST-STAY-HOST-SIDE"


def _hypothesis():
    return {
        "failure_mechanism": "The current orchestration accepts a weak proposal.",
        "expected_behavior": "A revised role route consistently produces the valid result.",
        "applicability": "Tasks executed by the same domain-neutral workflow.",
        "falsifier": "Fresh paired tasks do not improve when the workflow is loaded.",
    }


def _orchestration_patch(parent):
    workflow = json.loads(parent["files"]["workflows/main.json"])
    second = next(node for node in workflow["nodes"] if node["id"] == "proposer_b")
    second["role_ref"] = "proposer_a"
    second["component_ref"] = "proposer-a-role"
    return {
        "schema": "nexgent.package-patch.v3",
        "parent_package_digest": parent["digest"],
        "hypothesis": {**_hypothesis(), "component_ids": ["main-workflow"]},
        "activation_targets": ["main-workflow"],
        "operations": [{
            "op": "replace",
            "component_id": "main-workflow",
            "old_digest": parent["component_digests"]["workflows/main.json"],
            "content": json.dumps(workflow, sort_keys=True),
        }],
        "child_manifest": deepcopy(parent["manifest"]),
    }


def _r0_improver(parent):
    plan = {
        "schema": DEVELOPMENT_PLAN_SCHEMA,
        "candidate_type": "orchestration",
        "source_ref": "orchestration_search",
        "hypothesis": _hypothesis(),
        "reason": "Search a bounded orchestration change on fresh public tasks.",
    }
    source = (
        f"PLAN = {plan!r}\n"
        f"PATCH = {_orchestration_patch(parent)!r}\n"
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
        provenance={"fixture": "ordinary-rsi-full-flow-r0"},
    )


class _ModelBoundary:
    """Deterministic provider boundary whose result depends on the executed DAG."""

    def __init__(self):
        self._lock = threading.Lock()
        self.calls = []

    def __call__(self, reserve, _stop_event):
        owner = self

        class Gateway:
            def ask(self, role, prompt, payload=None, max_tokens=4000):
                with owner._lock:
                    owner.calls.append(role)
                    number = len(owner.calls)
                receipt = {
                    "call_id": f"ordinary-rsi-{number}",
                    "role": role,
                    "model": "DETERMINISTIC-MODEL-BOUNDARY",
                    "status": "started",
                    "reserved_completion_tokens": max_tokens,
                    "max_tokens": max_tokens,
                }
                reserve(receipt)
                reserve({
                    **receipt,
                    "status": "completed",
                    "billing_status": "usage_reported",
                    "usage": {"prompt_tokens": 1, "completion_tokens": 1,
                              "total_tokens": 2},
                })
                if role == "proposer_a":
                    return {"deliverables": {"result": {"version": 1}}}
                if role == "proposer_b":
                    return {"deliverables": {"result": {"version": 0}}}
                proposals = [payload["proposal_a"], payload["proposal_b"]]
                versions = [item["deliverables"]["result"]["version"]
                            for item in proposals]
                return {"deliverables": {"result": {"version": min(versions)}}}

        return Gateway()


class _IndependentEvaluator:
    id = "ordinary-rsi-independent"
    descriptor = BenchmarkDescriptor(
        id=id,
        version="1",
        title="Domain-neutral ordinary RSI integration fixture",
        splits=("development", "selection", "guard"),
        default_split="development",
        allowed_suite_roles=("qualification",),
    )

    def snapshot(self):
        return {"dataset": "ordinary-rsi-independent-v1"}

    def describe(self):
        return {"id": self.id, "kind": "deterministic-independent-fixture"}

    def tasks(self, split="development", seed=0, **_options):
        return [{
            "id": f"{split}/{seed}/result",
            "statistical_unit_id": f"{split}-unit-{seed}",
            "objective": f"Return the public result for {split} unit {seed}",
            "inputs": {},
            "deliverables": [{
                "name": "result",
                "schema": {
                    "type": "object",
                    "required": ["version"],
                    "properties": {"version": {"type": "integer"}},
                    "additionalProperties": False,
                },
            }],
            "capabilities": [],
            "constraints": {},
            "context": {},
            "_evaluation": {"private_reference": PRIVATE_EVALUATOR_DATA},
        }]

    def evaluate(self, _task_ref, deliverables, _execution_view):
        version = deliverables["result"]["version"]
        return {
            "status": "accepted" if version == 1 else "rejected",
            "score_available": True,
            "accepted": version == 1,
            "score": float(version),
        }


def _policy(adapter):
    return {
        "evaluator_id": adapter.id,
        "candidate_types": ["orchestration", "no_change"],
        "budget": {
            "max_model_calls": 3,
            "max_completion_tokens": 4800,
            "max_tool_calls": 0,
            "max_nodes": 20,
        },
        "improver": {"channel": "ordinary-r0", "revision": 0},
        "promotion_policy": {"min_quality_delta": 0.5, "max_regressions": 0},
        "orchestration_search": {
            "max_attempts": 1,
            "first_seed": 7,
            "max_seed_scan": 8,
            "minimum_mean_delta": 0.5,
            "max_model_calls": 12,
            "max_completion_tokens": 20000,
            "max_tool_calls": 0,
            "max_nodes": 80,
            "development_episode_budget": {
                "max_model_calls": 3,
                "max_completion_tokens": 4800,
                "max_tool_calls": 0,
                "max_nodes": 30,
            },
        },
    }


def _content(tasks, episode, name="result"):
    return tasks.store.read(episode["output_refs"][name], episode["id"])["content"]


def test_ordinary_feedback_search_promotes_and_new_service_reuses_candidate(
        tmp_path, monkeypatch):
    adapter = _IndependentEvaluator()
    monkeypatch.setattr(
        runtime_module, "task_benchmarks",
        lambda project_root=None: {adapter.id: adapter},
    )
    gateway = _ModelBoundary()
    tasks = TaskService(tmp_path, tools=ToolRegistry(), gateway_factory=gateway)
    evolution = EvolutionService(tasks)
    parent = multirole_package()
    evolution.register("general", parent)
    generation = GenerationService(tasks, evolution)
    ImproverService(tasks).register(
        "ordinary-r0",
        _r0_improver(parent),
        {"mutable_paths": ["improver.py"], "allowed_operations": ["replace"]},
    )
    trigger = AutoEvolutionService(
        tasks,
        policies={"general": _policy(adapter)},
        evolution_service=evolution,
        generation_service=generation,
    )

    source_task = {
        "id": "ordinary-source",
        "objective": "Return the current public result for an ordinary task",
        "inputs": {},
        "deliverables": adapter.tasks("development", -1)[0]["deliverables"],
        "capabilities": [],
        "constraints": {},
        "context": {"split": "development", "split_role": "development"},
    }
    source = tasks.create(
        source_task["objective"],
        inputs=source_task["inputs"],
        deliverables=source_task["deliverables"],
        budget=_policy(adapter)["budget"],
        capabilities=[],
        constraints={},
        context=source_task["context"],
        package_channel="general",
    )
    source = tasks.run(source["id"])
    source_evaluation = tasks.evaluate(source["id"], adapter, source_task)
    assert source_evaluation["evaluation"]["accepted"] is False
    assert _content(tasks, source) == {"version": 0}

    [captured] = trigger.drain()
    [ready] = trigger.drain_development()
    assert ready["id"] == captured["id"]
    assert ready["status"] == "candidate_ready", (
        ready.get("reason"), ready.get("search_intent"), ready.get("candidate"))
    assert ready["development_plan"]["source_ref"] == "orchestration_search"
    generated = generation.generation(ready["candidate"]["generation_id"])
    assert generated["status"] == "generated"
    assert generated["search_attempt_id"].endswith("/attempt-1")
    search_events = OrchestrationSearchJournal(tasks.store).events(
        ready["search_intent"]["id"])
    assert PRIVATE_EVALUATOR_DATA not in json.dumps(search_events)
    assert len(gateway.calls) >= 9

    [completed] = trigger.drain_evolution()
    assert completed["id"] == ready["id"]
    assert completed["status"] == "completed"
    assert completed["evolution"]["selection_decision"]["eligible"] is True
    assert completed["evolution"]["guard_assessment"]["degraded"] is False
    assert completed["evolution"]["guard_assessment"]["rolled_back"] is False
    promoted = evolution.active("general")
    assert promoted["revision"] == 1
    assert promoted["package_id"] == ready["candidate"]["candidate_package_id"]
    assert promoted["package_id"] != parent["id"]

    restarted = TaskService(
        tmp_path, tools=ToolRegistry(), gateway_factory=gateway)
    restarted_evolution = EvolutionService(restarted)
    AutoEvolutionService(
        restarted,
        policies={"general": _policy(adapter)},
        evolution_service=restarted_evolution,
        generation_service=GenerationService(restarted, restarted_evolution),
    )
    later = restarted.create(
        "Run a later ordinary task in a new service instance",
        deliverables=source_task["deliverables"],
        budget=_policy(adapter)["budget"],
        context={"split": "development", "split_role": "development"},
        package_channel="general",
    )
    later = restarted.run(later["id"])

    assert _content(restarted, later) == {"version": 1}
    registration = later["task"]["context"]["package_channel_registration"]
    assert registration["revision"] == 1
    assert registration["package_id"] == promoted["package_id"]
    refreshed = restarted.store.feedback_trigger(completed["id"])
    assert refreshed["reuse_observed"][0]["episode_id"] == later["id"]
    assert refreshed["reuse_observed"][0]["activation"]["loaded"] is True
    assert len(gateway.calls) >= 21
