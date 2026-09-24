"""A task-origin skill must pass fresh selection and guard before channel reuse."""

from copy import deepcopy

import pytest

from nexgent.tasks.capability_authority import make_episode_authority
from nexgent.tasks.evolution import EvolutionService, PromotionPolicy
from nexgent.tasks.generation import GenerationService
from nexgent.tasks.runtime import TaskService
from nexgent.tasks.self_orchestration_seed import self_orchestration_package
from nexgent.tasks.task_skill_adoption import TaskSkillAdoptionService
from nexgent.tasks.task_skill_compiler import TASK_SKILL_PROPOSAL_SCHEMA
from nexgent.tasks.tools import ContractError, ToolRegistry


RESULT_SPEC = [{"name": "result", "schema": {
    "type": "object", "required": ["answer"],
    "properties": {"answer": {"type": "integer"}},
}}]

HYPOTHESIS = {
    "failure_mechanism": "the active planner lacks the exact bounded transform",
    "expected_behavior": "fresh planners select the adopted skill and return 42",
    "applicability": "fresh tasks requiring the same constant transform",
    "falsifier": "selection or guard does not load the skill and improve the result",
}


def _skill_proposal():
    return {
        "schema": TASK_SKILL_PROPOSAL_SCHEMA,
        "skill": {
            "name": "answer_42", "entrypoint": "solve",
            "source": (
                "def solve(payload, context):\n"
                "    return {'answer': 42}\n"
            ),
            "input_schema": {"type": "object"},
            "output_schema": deepcopy(RESULT_SPEC[0]["schema"]),
        },
        "deliverable_name": "result",
        "hypothesis": deepcopy(HYPOTHESIS),
    }


def _creator_graph():
    return {
        "replaced_node_ids": ["slot"],
        "operations": [
            {"op": "remove_node", "node_id": "slot"},
            {"op": "add_node", "node": {
                "id": "coder", "method": "ask", "role_ref": "generalist",
                "component_ref": "generalist-role",
                "params": {"max_tokens": 800, "prompt": "Create the bounded skill."},
                "bindings": {"payload": {"task": {"$input": ""}}},
            }},
            {"op": "add_node", "node": {
                "id": "develop", "method": "develop_skill",
                "params": {
                    "mode": "planner_preserving",
                    "constraints": {
                        "allowed_rpc_methods": [], "allowed_tools": [],
                        "max_patch_bytes": 300000,
                    },
                },
                "bindings": {"proposal": {"$node": "coder"}},
            }},
            {"op": "add_node", "node": {
                "id": "publish", "method": "publish", "params": {
                    "name": "result", "content": {"answer": 0},
                },
            }},
            {"op": "add_control_edge", "edge": {
                "from": "architect", "to": "coder",
            }},
            {"op": "add_control_edge", "edge": {
                "from": "develop", "to": "publish",
            }},
        ],
        "outputs": {"deliverables": {"result": {"$node": "publish.id"}}},
        "revision_rules": [],
    }


def _baseline_graph():
    return {
        "replaced_node_ids": ["slot"],
        "operations": [
            {"op": "remove_node", "node_id": "slot"},
            {"op": "add_node", "node": {
                "id": "publish", "method": "publish", "params": {
                    "name": "result", "content": {"answer": 0},
                },
            }},
            {"op": "add_control_edge", "edge": {
                "from": "architect", "to": "publish",
            }},
        ],
        "outputs": {"deliverables": {"result": {"$node": "publish.id"}}},
        "revision_rules": [],
    }


def _skill_graph(skill):
    return {
        "replaced_node_ids": ["slot"],
        "operations": [
            {"op": "remove_node", "node_id": "slot"},
            {"op": "add_node", "node": {
                "id": "apply_adopted_skill", "method": "skill",
                "component_ref": skill["component_ref"],
                "params": {"name": skill["name"]},
                "bindings": {"payload": {"$input": ""}},
                "output_schema": deepcopy(skill["output_schema"]),
            }},
            {"op": "add_node", "node": {
                "id": "publish", "method": "publish", "params": {"name": "result"},
                "bindings": {"content": {"$node": "apply_adopted_skill"}},
            }},
            {"op": "add_control_edge", "edge": {
                "from": "architect", "to": "apply_adopted_skill",
            }},
        ],
        "outputs": {"deliverables": {"result": {"$node": "publish.id"}}},
        "revision_rules": [],
    }


class TaskSkillGateway:
    def __init__(self):
        self.calls = []
        self.selected_skills = []

    def __call__(self, reserve, stop_event):
        owner = self

        class Gateway:
            def ask(self, role, prompt, payload=None, max_tokens=4000):
                owner.calls.append({
                    "role": role,
                    "objective": (payload or {}).get("task", {}).get("objective"),
                    "available_skills": deepcopy(
                        (payload or {}).get("available_skills", [])),
                })
                receipt = {
                    "call_id": f"task-skill-reuse-{len(owner.calls)}",
                    "role": role, "model": "TASK-SKILL-REUSE-TEST-DOUBLE",
                    "status": "started", "max_tokens": max_tokens,
                    "reserved_completion_tokens": max_tokens,
                }
                reserve(receipt)
                reserve({**receipt, "status": "completed",
                         "billing_status": "usage_reported",
                         "usage": {"prompt_tokens": 1, "completion_tokens": 1,
                                   "total_tokens": 2}})
                if role == "generalist":
                    return _skill_proposal()
                inventory = payload["available_skills"]
                if "Create one task-origin skill" in payload["task"]["objective"]:
                    return {"proposal": _creator_graph()}
                if inventory:
                    owner.selected_skills.append(deepcopy(inventory[0]))
                    return {"proposal": _skill_graph(inventory[0])}
                return {"proposal": _baseline_graph()}

        return Gateway()


class FreshTaskBenchmark:
    id = "task-skill-fresh-selection"

    def snapshot(self):
        return {"id": self.id, "evaluator_digest": "task-skill-fresh-v1"}

    def describe(self):
        return {"id": self.id, "kind": "host-private-deterministic"}

    def tasks(self, split="development", seed=0):
        return [{
            "id": f"{split}/{seed}/fresh",
            "objective": f"Solve a fresh {split} transform task",
            "inputs": {}, "deliverables": deepcopy(RESULT_SPEC),
            "capabilities": [], "context": {"split": split},
        }]

    def evaluate(self, task_ref, deliverables, execution_view):
        answer = deliverables["result"]["answer"]
        return {
            "status": "accepted", "score_available": True,
            "accepted": True, "score": 1.0 if answer == 42 else 0.0,
        }


@pytest.mark.parametrize("with_authority", [False, True])
def test_task_origin_skill_passes_selection_guard_and_fresh_channel_reuse(
        tmp_path, with_authority):
    gateway = TaskSkillGateway()
    tasks = TaskService(
        tmp_path, tools=ToolRegistry(), gateway_factory=gateway)
    evolution = EvolutionService(tasks)
    generation = GenerationService(tasks, evolution)
    adoption = TaskSkillAdoptionService(tasks, evolution, generation)
    benchmark = FreshTaskBenchmark()
    parent = self_orchestration_package()
    evolution.register("task-skills", parent)

    creator = tasks.create(
        "Create one task-origin skill from development feedback",
        deliverables=deepcopy(RESULT_SPEC), package_channel="task-skills",
        context={"split": "development", "split_role": "development"},
        budget={"max_model_calls": 5, "max_completion_tokens": 16000},
    )
    creator = tasks.run(creator["id"])
    assert creator["status"] == "completed", creator.get("last_error")
    skill_events = [event for event in creator["events"]
                    if event["kind"] == "task_skill_compiled"]
    assert len(skill_events) == 1
    source_package_id = skill_events[0]["content"]["package_id"]
    feedback = generation.capture_feedback(
        "task-skills", [creator["id"]], expected_revision=0)

    adopted = adoption.adopt(
        "task-skills", source_package_id, creator["id"], feedback["id"], 0,
        deepcopy(HYPOTHESIS),
        budget={"max_model_calls": 0, "max_tool_calls": 0, "max_nodes": 12},
    )
    generated = adopted["generation"]
    assert generated["status"] == "generated", generated.get("reason")
    candidate = evolution.candidate(generated["candidate_id"])
    adopted_component = adopted["adoption"]["adopted_component_id"]
    adopted_path = adopted["adoption"]["adopted_path"]

    class GrantingBenchmark(FreshTaskBenchmark):
        def tasks(self, *args, **kwargs):
            rows = super().tasks(*args, **kwargs)
            rows[0]["capability_authority"] = make_episode_authority(
                ["tool"], ["local_compute"])
            return rows

    with pytest.raises(ContractError, match="cannot grant capability authority"):
        evolution.plan_pair(
            candidate["id"], GrantingBenchmark(), split="selection",
            split_role="selection")

    policy = PromotionPolicy(
        min_quality_delta=0.5, max_cost_ratio=20.0,
        monitor_min_score=0.5, monitor_min_success_rate=1.0,
    )
    authority = (make_episode_authority(["tool"], ["local_compute"])
                 if with_authority else None)
    selection_plan = evolution.plan_pair(
        candidate["id"], benchmark, split="selection",
        split_role="selection", seed=17, policy=policy,
        capability_authority=authority)
    trial = evolution.run_pair(selection_plan["id"], benchmark)
    assert selection_plan["capability_authority_digest"] == (
        authority["digest"] if authority is not None else None)
    for pair in trial["pairs"]:
        for arm in ("parent", "candidate"):
            episode = tasks.get_private(pair[arm]["episode_id"])
            assert episode["task"].get("capability_authority") == authority
    decision = evolution.assess(trial["id"])
    assert decision["eligible"] is True
    assert decision["gates"]["behavior_activated"] is True
    assert decision["measurements"]["candidate"]["quality"] == 1.0
    assert decision["measurements"]["parent"]["quality"] == 0.0
    assert decision["loaded_evidence"]
    assert all(row["loaded"] is True for row in decision["loaded_evidence"])
    assert candidate["component_target"]["kind"] == "component_set"
    assert candidate["component_target"]["component_ids"] == [adopted_component]

    monitor_plan = evolution.plan_monitor(
        candidate["id"], benchmark, split="guard", seed=23,
        capability_authority=authority)
    if authority is not None:
        mismatched = evolution.plan_monitor(
            candidate["id"], benchmark, split="guard", seed=24)
        with pytest.raises(ContractError, match="differs from selection"):
            evolution.promote(
                candidate["id"], decision["id"],
                monitor_plan_id=mismatched["id"])
    promoted = evolution.promote(
        candidate["id"], decision["id"], monitor_plan_id=monitor_plan["id"])
    assert promoted["revision"] == 1
    assert promoted["package_id"] == candidate["package_id"]
    guard = evolution.run_monitor("task-skills", benchmark)
    for episode_id in guard["episode_ids"]:
        assert tasks.get_private(episode_id)["task"].get(
            "capability_authority") == authority
    monitored = evolution.monitor("task-skills", guard["episode_ids"])
    assert monitored["degraded"] is False
    assert monitored["rolled_back"] is False
    assert monitored["active"]["package_id"] == candidate["package_id"]
    assert all(report["loaded_evidence"]["loaded"] is True
               for report in guard["reports"])

    reuse = tasks.create(
        "Solve an independent ordinary task through the promoted channel",
        deliverables=deepcopy(RESULT_SPEC), package_channel="task-skills",
        budget={"max_model_calls": 3, "max_completion_tokens": 8000},
    )
    reuse = tasks.run(reuse["id"])
    assert reuse["status"] == "completed", reuse.get("last_error")
    assert reuse["package_id"] == candidate["package_id"]
    assert reuse["task"]["context"]["package_channel_registration"]["revision"] == 1
    assert adopted_path in reuse["execution"]["loaded_modules"]
    assert tasks.store.read(reuse["output_refs"]["result"], reuse["id"])[
        "content"] == {"answer": 42}
    assert any(skill["component_ref"] == adopted_component
               for skill in gateway.selected_skills)
