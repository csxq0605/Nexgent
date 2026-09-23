"""Task skills enter cross-task evolution only through GenerationService."""

from __future__ import annotations

from copy import deepcopy
import json
from pathlib import Path
import sys

import pytest


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from nexgent.tasks.evolution import EvolutionService
from nexgent.tasks.generation import GenerationService
from nexgent.kernel.programs import digest
from nexgent.tasks.dynamic_roles import materialize_task_roles
from nexgent.tasks.packages import make_package
from nexgent.tasks.runtime import TaskService
from nexgent.tasks.self_orchestration_seed import self_orchestration_package
from nexgent.tasks.task_skill_adoption import TaskSkillAdoptionService
from nexgent.tasks.task_skill_compiler import (
    TASK_SKILL_PROPOSAL_SCHEMA,
    compile_task_skill_proposal,
)
from nexgent.tasks.tools import ContractError, ToolRegistry


def _parent_package():
    workflow = {
        "nodes": [
            {
                "id": "develop", "method": "develop_skill",
                "params": {
                    "proposal": _proposal(),
                    "constraints": {"allowed_rpc_methods": ["read_artifact"],
                                    "allowed_tools": [],
                                    "max_patch_bytes": 300_000},
                },
            },
            {
                "id": "publish", "method": "publish",
                "params": {"name": "result"},
                "bindings": {"content": {"$node": "develop"}},
            },
        ],
        "outputs": {"deliverables": {"result": {"$node": "publish.id"}}},
        "control_edges": [], "revision_rules": [],
    }
    return make_package(
        {
            "agent.py": (
                "def execute(payload, context):\n"
                "    raise RuntimeError('registered workflow must execute')\n"
            ),
            "workflow.json": json.dumps(workflow, sort_keys=True),
        },
        {
            "manifest_version": 2,
            "entries": {"execute": "agent.py:execute"},
            "skills": {}, "roles": {},
            "workflows": {"main": {
                "ref": "workflow.json", "max_parallel": 1,
                "input_schema": {"type": "object"},
                "output_schema": {"type": "object"},
            }},
            "components": {"planner": {
                "class": "O", "kind": "workflow", "ref": "main",
            }},
            "orchestrator": "planner",
        },
        provenance={"fixture": "task-skill-adoption-parent"},
    )


def _proposal(parent=None):
    value = {
        "schema": TASK_SKILL_PROPOSAL_SCHEMA,
        "skill": {
            "name": "candidate_transform", "entrypoint": "solve",
            "source": (
                "def solve(payload, context):\n"
                "    item = context.read_artifact(payload['input_refs']['value'])\n"
                "    return {'answer': item['content'] * 2}\n"
            ),
            "input_schema": {"type": "object"},
            "output_schema": {"type": "object", "required": ["answer"],
                              "properties": {"answer": {"type": "integer"}}},
        },
        "deliverable_name": "result",
        "hypothesis": {
            "failure_mechanism": "the active planner lacks the candidate transform",
            "expected_behavior": "the adopted skill is available to fresh plans",
            "applicability": "fresh tasks that need the same bounded transform",
            "falsifier": "fresh selection does not load the skill or improve outcomes",
        },
    }
    if parent is not None:
        value["parent_package_digest"] = parent["digest"]
    return value


def test_adoption_uses_generation_closure_and_preserves_active_planner(tmp_path):
    tasks = TaskService(tmp_path, tools=ToolRegistry())
    evolution = EvolutionService(tasks)
    generation = GenerationService(tasks, evolution)
    parent = _parent_package()
    evolution.register("skills", parent)

    creator = tasks.create(
        "Observe one development task", package_channel="skills",
        deliverables=[{"name": "result", "schema": {"type": "object"}}],
        context={"split": "development", "split_role": "development"},
    )
    creator = tasks.run(creator["id"])
    assert creator["status"] == "completed"
    compiled_events = [event for event in tasks.store.events(creator["id"])
                       if event["kind"] == "task_skill_compiled"]
    assert len(compiled_events) == 1
    scoped = tasks.store.package(compiled_events[0]["content"]["package_id"])
    assert compiled_events[0]["content"]["package_digest"] == scoped["digest"]
    feedback = generation.capture_feedback(
        "skills", [creator["id"]], expected_revision=0)

    manual_proposal = _proposal(parent)
    manual_proposal["skill"]["name"] = "manually_leased_transform"
    manually_leased = compile_task_skill_proposal(
        parent, manual_proposal,
        {"allowed_rpc_methods": ["read_artifact"], "allowed_tools": [],
         "max_patch_bytes": 300_000},
        provenance={"episode_id": creator["id"], "node_id": "manual"},
    )
    tasks.store.lease_task_package(manually_leased, creator["id"])
    with pytest.raises(ContractError, match="durable runtime compilation event"):
        TaskSkillAdoptionService(tasks, evolution, generation).adopt(
            "skills", manually_leased["id"], creator["id"], feedback["id"], 0,
            manual_proposal["hypothesis"],
            budget={"max_model_calls": 0, "max_tool_calls": 0,
                    "max_nodes": 12},
        )

    with pytest.raises(ContractError, match="explicit adoption"):
        evolution.propose(
            "skills", scoped, hypothesis="same-task success",
            feedback_episode_ids=[creator["id"]])

    adopted = TaskSkillAdoptionService(
        tasks, evolution, generation).adopt(
            "skills", scoped["id"], creator["id"], feedback["id"], 0,
            _proposal(parent)["hypothesis"],
            budget={"max_model_calls": 0, "max_tool_calls": 0,
                    "max_nodes": 12},
        )

    generated = adopted["generation"]
    assert generated["status"] == "generated", generated.get("reason")
    candidate = evolution.candidate(generated["candidate_id"])
    package = tasks.store.package(candidate["package_id"])
    adoption = adopted["adoption"]
    assert package["parent_id"] == parent["id"]
    assert tasks.store.is_task_scoped_package(package) is False
    assert package["files"]["workflow.json"] == parent["files"]["workflow.json"]
    assert package["manifest"]["orchestrator"] == parent["manifest"]["orchestrator"]
    assert package["manifest"]["components"][adoption["adopted_component_id"]] == {
        "class": "S", "kind": "skill", "ref": adoption["adopted_skill_name"],
    }
    assert package["manifest"]["skills"][
        adoption["adopted_skill_name"]]["allowed_rpc_methods"] == ["read_artifact"]
    assert package["files"][adoption["adopted_path"]] == (
        scoped["files"]["skills/task_time/candidate_transform.py"])
    closure = evolution._verify_generated_candidate(candidate)
    assert closure["id"] == generated["id"]
    assert evolution.active("skills")["package_id"] == parent["id"]


@pytest.mark.parametrize("include_skill", [False, True])
def test_adoption_freezes_final_generated_workflow_roles_and_optional_skill(
        tmp_path, include_skill):
    role_prompt = "Solve the bounded task and return an integer answer."
    workflow_proposal = {
        "replaced_node_ids": ["slot"],
        "task_roles": {
            "bounded_solver": {
                "identity": "Bounded arithmetic solver",
                "prompt": role_prompt,
                "capabilities": ["ask"],
            },
        },
        "operations": [
            {"op": "remove_node", "node_id": "slot"},
            {"op": "add_node", "node": {
                "id": "solve", "method": "ask",
                "role_ref": "task:bounded_solver",
                "params": {"max_tokens": 200},
                "bindings": {"payload": {"task": {"$input": ""}}},
            }},
            {"op": "add_node", "node": {
                "id": "develop", "method": "develop_skill",
                "params": {
                    "proposal": _proposal(),
                    "mode": "planner_preserving",
                    "constraints": {
                        "allowed_rpc_methods": ["read_artifact"],
                        "allowed_tools": [],
                        "max_patch_bytes": 300_000,
                    },
                },
            }},
            {"op": "add_node", "node": {
                "id": "publish", "method": "publish",
                "params": {"name": "result"},
                "bindings": {"content": {"$node": "solve"}},
            }},
            {"op": "add_control_edge", "edge": {
                "from": "architect", "to": "solve"}},
            {"op": "add_control_edge", "edge": {
                "from": "architect", "to": "develop"}},
            {"op": "add_control_edge", "edge": {
                "from": "solve", "to": "publish"}},
            {"op": "add_control_edge", "edge": {
                "from": "develop", "to": "publish"}},
        ],
        "outputs": {"deliverables": {"result": {"$node": "publish.id"}}},
        "revision_rules": [{
            "id": "repair-on-failure", "after_node": "solve",
            "when": {"path": "$status", "equals": "failed"},
            "planner_role_ref": "task:bounded_solver",
            "planner_max_tokens": 200,
            "replace_node_ids": ["publish"],
            "max_compile_attempts": 1,
        }],
    }
    if not include_skill:
        workflow_proposal["operations"] = [
            operation for operation in workflow_proposal["operations"]
            if not (
                operation["op"] == "add_node"
                and operation["node"].get("id") == "develop"
            ) and not (
                operation["op"] == "add_control_edge"
                and "develop" in {
                    operation["edge"].get("from"), operation["edge"].get("to")}
            )
        ]

    class GatewayFactory:
        def __init__(self):
            self.roles = []

        def __call__(self, reserve, stop_event):
            owner = self

            class Gateway:
                def ask(self, role, prompt, payload=None, max_tokens=4000):
                    owner.roles.append(role)
                    call_id = f"adoption-role-{len(owner.roles)}"
                    record = {
                        "call_id": call_id, "role": role,
                        "model": "ADOPTION-TEST-DOUBLE", "status": "started",
                        "reserved_completion_tokens": max_tokens,
                    }
                    reserve(record)
                    reserve({
                        **record, "status": "completed",
                        "billing_status": "usage_reported",
                        "usage": {"prompt_tokens": 1, "completion_tokens": 1,
                                  "total_tokens": 2},
                    })
                    if role == "architect":
                        return {"proposal": deepcopy(workflow_proposal)}
                    assert role.startswith("task-role://bounded_solver/") or (
                        role.startswith("adopted_role_"))
                    assert prompt == role_prompt
                    return {"answer": 7}

            return Gateway()

    gateway = GatewayFactory()
    tasks = TaskService(tmp_path, tools=ToolRegistry(), gateway_factory=gateway)
    evolution = EvolutionService(tasks)
    generation = GenerationService(tasks, evolution)
    parent = self_orchestration_package()
    evolution.register("task-os", parent)
    creator = tasks.create(
        "Create and exercise one bounded role and skill",
        deliverables=[{"name": "result", "schema": {
            "type": "object", "required": ["answer"],
            "properties": {"answer": {"type": "integer"}},
        }}],
        package_channel="task-os",
        context={"split": "development", "split_role": "development"},
        budget={"max_model_calls": 2, "max_completion_tokens": 6000,
                "max_tool_calls": 0, "max_nodes": 20},
    )
    creator = tasks.run(creator["id"])
    assert creator["status"] == "completed", creator.get("last_error")
    private = tasks.get_private(creator["id"])
    source_workflow = private["plan_workflow_snapshot"]
    source_ref = private["plan_workflow_ref"]
    assert source_ref == "generated://" + digest(source_workflow)
    assert private["plan_workflow_versions"][source_ref] == source_workflow
    assert materialize_task_roles(source_workflow) == source_workflow
    compiled = [event for event in private["events"]
                if event["kind"] == "task_skill_compiled"]
    assert len(compiled) == int(include_skill)
    source_package_id = (compiled[0]["content"]["package_id"]
                         if compiled else None)
    feedback = generation.capture_feedback(
        "task-os", [creator["id"]], expected_revision=0)

    result = TaskSkillAdoptionService(tasks, evolution, generation).adopt_episode(
        "task-os", source_package_id, creator["id"],
        feedback["id"], 0, _proposal(parent)["hypothesis"],
        budget={"max_model_calls": 0, "max_tool_calls": 0, "max_nodes": 12},
    )

    generated = result["generation"]
    assert generated["status"] == "generated", generated.get("reason")
    candidate = evolution.candidate(generated["candidate_id"])
    package = tasks.store.package(candidate["package_id"])
    adoption = result["adoption"]
    assert package["parent_id"] == parent["id"]
    assert package["provenance"]["feedback_bundle_id"] == feedback["id"]
    assert package["provenance"]["feedback_digest"] == feedback["digest"]
    assert adoption["creator_workflow_ref"] == source_ref
    assert adoption["creator_workflow_digest"] == digest(source_workflow)
    assert adoption["creator_root_episode_id"] == creator["root_episode_id"]
    [role] = adoption["adopted_roles"]
    assert "prompt" not in role
    assert role_prompt not in json.dumps(adoption, ensure_ascii=False)
    assert role["source_role_digest"][:16] in role["source_role_ref"]
    assert role["name"].endswith(role["source_role_digest"][:16])
    assert role["component_id"].endswith(role["source_role_digest"][:16])
    assert package["files"][role["path"]] == role_prompt
    adopted_workflow = json.loads(package["files"]["workflows/main.json"])
    assert "task_roles" not in adopted_workflow
    adopted_solver = next(node for node in adopted_workflow["nodes"]
                          if node["id"] == "solve")
    assert adopted_solver["role_ref"] == role["name"]
    assert adopted_solver["component_ref"] == role["component_id"]
    assert adopted_solver["params"]["prompt"] == role_prompt
    assert adopted_workflow["revision_rules"][0]["planner_role_ref"] == role["name"]
    assert adoption["adopted_workflow_digest"] == digest(adopted_workflow)
    assert set(candidate["component_target"]["component_ids"]) == set(
        adoption["component_ids"])
    assert parent["manifest"]["orchestrator"] in adoption["component_ids"]
    assert role["component_id"] in adoption["component_ids"]
    if include_skill:
        assert adoption["adopted_component_id"] in adoption["component_ids"]
        assert len(adoption["adopted_skills"]) == 1
    else:
        assert adoption["adopted_component_id"] is None
        assert adoption["adopted_skills"] == []
    assert evolution._verify_generated_candidate(candidate)["id"] == generated["id"]
    assert evolution.active("task-os")["package_id"] == parent["id"]
