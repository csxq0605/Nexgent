"""A task-created skill remains behind the generic planner in its child package."""

import json

import pytest

from nexgent.tasks.runtime import TaskService
from nexgent.tasks.self_orchestration_seed import self_orchestration_package
from nexgent.tasks.task_skill_compiler import TASK_SKILL_PROPOSAL_SCHEMA


RESULT_SPEC = [{"name": "result", "schema": {
    "type": "object", "required": ["answer"],
    "properties": {"answer": {"const": 42}},
}}]


def _skill_proposal():
    return {
        "schema": TASK_SKILL_PROPOSAL_SCHEMA,
        "skill": {
            "name": "double_value", "entrypoint": "solve",
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
            "failure_mechanism": "the current team lacks a reusable transform",
            "expected_behavior": "the installed skill doubles the supplied value",
            "applicability": "tasks needing this numeric transform",
            "falsifier": "the delegated planner cannot select or run the skill",
        },
    }


def _parent_graph():
    nodes = [
        {
            "id": "coder", "method": "ask", "role_ref": "generalist",
            "component_ref": "generalist-role",
            "params": {"max_tokens": 800, "prompt": "Create the missing skill."},
            "bindings": {"payload": {"task": {"$input": ""}}},
        },
        {
            "id": "develop", "method": "develop_skill",
            "params": {
                "mode": "planner_preserving",
                "constraints": {
                    "allowed_rpc_methods": ["read_artifact"],
                    "allowed_tools": [],
                    "max_patch_bytes": 300000,
                },
            },
            "bindings": {"proposal": {"$node": "coder"}},
        },
        {
            "id": "delegate_skill_team", "method": "delegate",
            "bindings": {
                "package_id": {"$node": "develop.package_id"},
                "task": {
                    "objective": {"$input": "objective"},
                    "input_refs": {"$input": "input_refs"},
                    "deliverables": {"$input": "deliverables"},
                    "capabilities": {"$input": "capabilities"},
                },
            },
        },
    ]
    return {
        "replaced_node_ids": ["slot"],
        "operations": [
            {"op": "remove_node", "node_id": "slot"},
            *[{"op": "add_node", "node": node} for node in nodes],
            {"op": "add_control_edge", "edge": {
                "from": "architect", "to": "coder",
            }},
        ],
        "outputs": {"deliverables": {
            "result": {"$node": "delegate_skill_team.output_refs.result"},
        }},
        "revision_rules": [],
    }


def _child_graph():
    return {
        "replaced_node_ids": ["slot"],
        "operations": [
            {"op": "remove_node", "node_id": "slot"},
            {"op": "add_node", "node": {
                "id": "use_installed_skill", "method": "skill",
                "component_ref": "task-skill-double_value",
                "params": {"name": "double_value"},
                "bindings": {"payload": {"$input": ""}},
                "output_schema": {
                    "type": "object", "required": ["answer"],
                    "properties": {"answer": {"type": "integer"}},
                },
            }},
            {"op": "add_node", "node": {
                "id": "publish", "method": "publish", "params": {"name": "result"},
                "bindings": {"content": {"$node": "use_installed_skill"}},
            }},
            {"op": "add_control_edge", "edge": {
                "from": "architect", "to": "use_installed_skill",
            }},
        ],
        "outputs": {"deliverables": {"result": {"$node": "publish.id"}}},
        "revision_rules": [],
    }


class PlannerSkillGateway:
    def __init__(self):
        self.roles = []
        self.architect_skill_inventories = []

    def __call__(self, reserve, stop_event):
        owner = self

        class Gateway:
            def ask(self, role, prompt, payload=None, max_tokens=4000):
                owner.roles.append(role)
                receipt = {
                    "call_id": f"planner-skill-{len(owner.roles)}",
                    "role": role, "model": "PLANNER-SKILL-TEST-DOUBLE",
                    "status": "started", "max_tokens": max_tokens,
                    "reserved_completion_tokens": max_tokens,
                }
                reserve(receipt)
                reserve({**receipt, "status": "completed",
                         "billing_status": "usage_reported",
                         "usage": {"prompt_tokens": 1, "completion_tokens": 1,
                                   "total_tokens": 2}})
                if role == "architect":
                    inventory = payload["available_skills"]
                    owner.architect_skill_inventories.append(inventory)
                    return {"proposal": _child_graph() if inventory else _parent_graph()}
                return _skill_proposal()

        return Gateway()


def test_delegated_child_planner_selects_and_runs_task_created_skill(tmp_path):
    parent = self_orchestration_package()
    parent_workflow = parent["files"]["workflows/main.json"]
    gateway = PlannerSkillGateway()
    service = TaskService(tmp_path, gateway_factory=gateway)
    episode = service.create(
        "Double the supplied number with a created capability",
        inputs={"value": 21}, deliverables=RESULT_SPEC, package=parent,
        budget={"max_model_calls": 6, "max_completion_tokens": 24000},
    )

    result = service.run(episode["id"])

    assert result["status"] == "completed", result.get("last_error")
    assert gateway.roles == ["architect", "generalist", "architect"]
    assert gateway.architect_skill_inventories[0] == []
    assert gateway.architect_skill_inventories[1] == [{
        "name": "double_value",
        "component_ref": "task-skill-double_value",
        "kind": "controlled_code",
        "input_schema": {"type": "object"},
        "output_schema": {
            "type": "object", "required": ["answer"],
            "properties": {"answer": {"type": "integer"}},
        },
    }]
    assert len(result["child_episode_ids"]) == 1
    child = service.get(result["child_episode_ids"][0])
    assert child["parent_episode_id"] == result["id"]
    assert child["root_episode_id"] == result["root_episode_id"]
    assert child["plan_revision"] == 2
    assert "skills/task_time/double_value.py" in child["execution"]["loaded_modules"]
    child_package = service.store.package(child["package_id"])
    assert child_package["manifest"]["orchestrator"] == parent["manifest"]["orchestrator"]
    assert child_package["files"]["workflows/main.json"] == parent_workflow
    assert child_package["provenance"]["planner_preserving"] is True
    assert child_package["provenance"]["task_time_only"] is True
    assert child_package["provenance"]["promotion_authority"] is False
    with pytest.raises(PermissionError, match="delegated Episode"):
        service.create("Cross-task reuse is not authorized", package=child_package)
    assert json.loads(child_package["files"]["workflows/main.json"])["nodes"][0][
        "id"] == "architect"
    assert service.store.read(result["output_refs"]["result"], episode["id"])[
        "content"] == {"answer": 42}
    compiled = [event for event in result["events"]
                if event["kind"] == "task_skill_compiled"]
    assert compiled[0]["content"]["mode"] == "planner_preserving"
