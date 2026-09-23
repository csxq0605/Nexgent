"""Task-time role creation through the real executable-plan runtime."""

from copy import deepcopy

import pytest

from nexgent.tasks.dynamic_roles import materialize_task_roles
from nexgent.tasks.orchestration import NodeStatus, PlanExecution
from nexgent.tasks.pending_graph_patch import (
    PendingGraphPatch, apply_graph_ops, compile_pending_graph_patch,
)
from nexgent.tasks.runtime import TaskService
from nexgent.tasks.self_orchestration_seed import self_orchestration_package
from nexgent.tasks.tools import ContractError
from nexgent.tasks.workflows import plan_from_workflow


ROLE_PROMPT = (
    "Act as the task's evidence cartographer. Return a JSON object containing "
    "the requested answer and the evidence path used."
)


def _dynamic_proposal():
    return {
        "replaced_node_ids": ["slot"],
        "task_roles": {
            "evidence_cartographer": {
                "identity": "Evidence cartographer",
                "prompt": ROLE_PROMPT,
                "capabilities": ["ask"],
            },
        },
        "operations": [
            {"op": "remove_node", "node_id": "slot"},
            {"op": "add_node", "node": {
                "id": "cartographer", "method": "ask",
                "role_ref": "task:evidence_cartographer",
                "params": {"max_tokens": 200},
                "bindings": {"payload": {"task": {"$input": ""}}},
            }},
            {"op": "add_node", "node": {
                "id": "publish", "method": "publish",
                "params": {"name": "result"},
                "bindings": {"content": {"$node": "cartographer"}},
            }},
            {"op": "add_control_edge", "edge": {
                "from": "architect", "to": "cartographer",
            }},
        ],
        "outputs": {"deliverables": {"result": {"$node": "publish.id"}}},
        "revision_rules": [],
    }


class _DynamicRoleGatewayFactory:
    def __init__(self):
        self.calls = []

    def __call__(self, reserve, stop_event):
        owner = self

        class Gateway:
            def ask(self, role, prompt, payload=None, max_tokens=4000):
                owner.calls.append({"role": role, "prompt": prompt, "payload": payload})
                receipt = {
                    "call_id": f"dynamic-role-{len(owner.calls)}",
                    "role": role, "model": "DYNAMIC-ROLE-TEST-DOUBLE",
                    "status": "started", "reserved_completion_tokens": max_tokens,
                    "max_tokens": max_tokens,
                }
                reserve(receipt)
                reserve({
                    **receipt, "status": "completed", "billing_status": "usage_reported",
                    "usage": {"prompt_tokens": 1, "completion_tokens": 1,
                              "total_tokens": 2},
                })
                if role == "architect":
                    stop_event.set()
                    return {"proposal": _dynamic_proposal()}
                return {"answer": "mapped", "evidence_path": ["task"]}

        return Gateway()


def test_model_creates_task_role_and_frozen_identity_survives_resume(tmp_path):
    gateway = _DynamicRoleGatewayFactory()
    service = TaskService(tmp_path, gateway_factory=gateway)
    episode = service.create(
        "Map the evidence for this task",
        deliverables=[{"name": "result", "schema": {
            "type": "object", "required": ["answer", "evidence_path"],
        }}],
        budget={"max_model_calls": 2, "max_completion_tokens": 5200,
                "max_tool_calls": 0, "max_nodes": 8},
        package=self_orchestration_package(),
    )

    paused = service.run(episode["id"])
    assert paused["status"] == "paused"
    assert paused["plan_revision"] == 2
    assert len(gateway.calls) == 1

    private = service.get_private(episode["id"])
    snapshot = private["plan_workflow_snapshot"]
    [role_ref] = snapshot["task_roles"]
    assert role_ref.startswith("task-role://evidence_cartographer/")
    assert snapshot["task_roles"][role_ref]["prompt"] == ROLE_PROMPT
    assert next(node for node in snapshot["nodes"]
                if node["id"] == "cartographer")["role_ref"] == role_ref

    resumed = TaskService(tmp_path, gateway_factory=gateway).run(episode["id"])
    assert resumed["status"] == "completed", resumed.get("last_error")
    assert len(gateway.calls) == 2
    assert gateway.calls[1]["role"] == role_ref
    assert gateway.calls[1]["prompt"] == ROLE_PROMPT
    assert resumed["usage"]["model_calls"] == 2
    result = service.store.read(resumed["output_refs"]["result"], episode["id"])
    assert result["content"] == {
        "answer": "mapped", "evidence_path": ["task"],
    }


def test_task_roles_cannot_gain_permissions_or_pass_unknown_gateway_arguments(tmp_path):
    package = self_orchestration_package()
    service = TaskService(tmp_path)
    base = service._materialize_workflow(package, "main", [])

    elevated = deepcopy(base)
    elevated["task_roles"] = {
        "operator": {
            "identity": "Operator", "prompt": "Use a tool.",
            "capabilities": ["tool"],
        },
    }
    elevated["nodes"][1] = {
        "id": "slot", "method": "ask", "role_ref": "task:operator",
        "bindings": {"payload": {"task": {"$input": ""}}},
    }
    with pytest.raises(PermissionError, match="only receive the ask capability"):
        service._materialize_workflow(
            package, "generated", [], proposed_workflow=elevated)

    invalid_arguments = deepcopy(base)
    invalid_arguments["nodes"][1] = {
        "id": "slot", "method": "ask", "role_ref": "generalist",
        "component_ref": "generalist-role",
        "bindings": {"task": {"$input": ""}},
    }
    with pytest.raises(ContractError, match="unsupported gateway arguments: task"):
        service._materialize_workflow(
            package, "generated", [], proposed_workflow=invalid_arguments)

    missing_payload = deepcopy(base)
    missing_payload["nodes"][1] = {
        "id": "slot", "method": "ask", "role_ref": "generalist",
        "component_ref": "generalist-role",
    }
    with pytest.raises(ContractError, match="must provide the model payload"):
        service._materialize_workflow(
            package, "generated", [], proposed_workflow=missing_payload)


def test_changing_task_role_prompt_cannot_redefine_a_completed_node():
    base = materialize_task_roles({
        "task_roles": {
            "analyst": {
                "identity": "Analyst", "prompt": "Analyze version one.",
                "capabilities": ["ask"],
            },
        },
        "nodes": [
            {"id": "done", "method": "ask", "role_ref": "task:analyst",
             "bindings": {"payload": {}}},
            {"id": "pending", "method": "join"},
        ],
        "control_edges": [{"from": "done", "to": "pending"}],
    })
    plan = plan_from_workflow(base, "dynamic-role-plan")
    execution = PlanExecution.create("episode-dynamic-role", plan)
    execution = execution.transition_node(
        "done", NodeStatus.RUNNING, attempt_ref="attempt://done/1")
    execution = execution.transition_node("done", NodeStatus.COMPLETED)

    revised = {
        "task_roles": {
            "analyst": {
                "identity": "Analyst", "prompt": "Analyze version two.",
                "capabilities": ["ask"],
            },
        },
        "nodes": [
            {"id": "done", "method": "ask", "role_ref": "task:analyst",
             "bindings": {"payload": {}}},
            {"id": "pending", "method": "join"},
        ],
        "control_edges": [{"from": "done", "to": "pending"}],
    }
    revised = materialize_task_roles(revised)
    patch = PendingGraphPatch(
        id="change-prompt", base_plan_ref=plan.ref,
        replaced_node_ids=["pending"], revised_workflow=revised,
    )

    with pytest.raises(ContractError, match="outside the pending subgraph"):
        compile_pending_graph_patch(execution, patch)


def test_later_revision_can_add_a_role_without_redefining_completed_role():
    base = materialize_task_roles({
        "task_roles": {
            "analyst": {
                "identity": "Analyst", "prompt": "Analyze the task.",
                "capabilities": ["ask"],
            },
        },
        "nodes": [
            {"id": "done", "method": "ask", "role_ref": "task:analyst",
             "bindings": {"payload": {}}},
            {"id": "pending", "method": "join"},
        ],
        "control_edges": [{"from": "done", "to": "pending"}],
    })
    plan = plan_from_workflow(base, "adaptive-role-plan")
    execution = PlanExecution.create("episode-adaptive-role", plan)
    execution = execution.transition_node(
        "done", NodeStatus.RUNNING, attempt_ref="attempt://done/1")
    execution = execution.transition_node("done", NodeStatus.COMPLETED)
    old_role_ref = next(iter(base["task_roles"]))

    candidate = apply_graph_ops(base, {
        "task_roles": {
            "critic": {
                "identity": "Task critic", "prompt": "Critique the prior result.",
                "capabilities": ["ask"],
            },
        },
        "operations": [
            {"op": "remove_node", "node_id": "pending"},
            {"op": "add_node", "node": {
                "id": "critic", "method": "ask", "role_ref": "task:critic",
                "bindings": {"payload": {"prior": {"$node": "done"}}},
            }},
            {"op": "add_control_edge", "edge": {"from": "done", "to": "critic"}},
        ],
    })
    revised = materialize_task_roles(candidate)
    assert old_role_ref in revised["task_roles"]
    critic = next(node for node in revised["nodes"] if node["id"] == "critic")
    assert critic["role_ref"].startswith("task-role://critic/")
    assert critic["role_ref"] in revised["task_roles"]

    revision = compile_pending_graph_patch(execution, PendingGraphPatch(
        id="add-critic", base_plan_ref=plan.ref,
        replaced_node_ids=["pending"], revised_workflow=revised,
    ))
    applied = execution.apply_revision(revision)
    assert applied.node("done").status is NodeStatus.COMPLETED
    assert applied.node("critic").status is NodeStatus.PENDING
