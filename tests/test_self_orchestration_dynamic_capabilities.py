"""Task-time capability development through the model-authored graph seed."""

from copy import deepcopy
import threading

import pytest

from nexgent.tasks.capability_authority import make_episode_authority
from nexgent.tasks.runtime import TaskService
from nexgent.tasks.self_orchestration_seed import self_orchestration_package
from nexgent.tasks.tools import ContractError, ToolRegistry


def _deliverable():
    return [{
        "name": "result",
        "schema": {
            "type": "object",
            "properties": {"answer": {"type": "integer"}},
            "required": ["answer"],
            "additionalProperties": False,
        },
    }]


def _tool_proposal():
    return {
        "name": "task.double",
        "description": "Double one integer inside this Episode.",
        "source": (
            "def execute(payload, context):\n"
            "    return {'answer': payload['value'] * 2}\n"
        ),
        "input_schema": {
            "type": "object",
            "properties": {"value": {"type": "integer"}},
            "required": ["value"],
            "additionalProperties": False,
        },
        "output_schema": {
            "type": "object",
            "properties": {"answer": {"type": "integer"}},
            "required": ["answer"],
            "additionalProperties": False,
        },
    }


def _service_proposal():
    return {
        "name": "context.graph_hint",
        "description": "Add a checked integer hint to later model payloads.",
        "source": (
            "def provide(payload, context):\n"
            "    visible = payload['payload'].copy()\n"
            "    visible['computed_hint'] = 42\n"
            "    return {'payload': visible, 'annotations': {'source': 'graph'}}\n"
        ),
    }


def _proposal(operations):
    return {"proposal": {
        "replaced_node_ids": ["slot"],
        "operations": [
            {"op": "remove_node", "node_id": "slot"},
            *operations,
        ],
        "outputs": {"deliverables": {"result": {"$node": "publish.id"}}},
        "revision_rules": [],
    }}


class GraphGateway:
    def __init__(self, architect_response, worker=None):
        self.architect_response = architect_response
        self.worker = worker
        self.calls = []
        self.lock = threading.Lock()

    def __call__(self, reserve, stop_event):
        owner = self

        class Gateway:
            def ask(self, role, prompt, payload=None, max_tokens=4000):
                with owner.lock:
                    number = len(owner.calls) + 1
                    owner.calls.append({
                        "role": role,
                        "prompt": prompt,
                        "payload": deepcopy(payload),
                    })
                receipt = {
                    "call_id": f"dynamic-graph-{number}",
                    "role": role,
                    "model": "DETERMINISTIC-DYNAMIC-GRAPH",
                    "status": "started",
                    "reserved_completion_tokens": max_tokens,
                    "max_tokens": max_tokens,
                }
                reserve(receipt)
                if role == "architect":
                    result = deepcopy(owner.architect_response)
                else:
                    result = owner.worker(role, deepcopy(payload))
                reserve({
                    **receipt,
                    "status": "completed",
                    "billing_status": "usage_reported",
                    "usage": {
                        "prompt_tokens": 3,
                        "completion_tokens": 4,
                        "total_tokens": 7,
                    },
                })
                return result

        return Gateway()


def test_graph_develops_and_consumes_a_task_local_tool(tmp_path):
    graph = _proposal([
        {"op": "add_node", "node": {
            "id": "develop", "method": "develop_tool",
            "params": {"proposal": _tool_proposal()},
        }},
        {"op": "add_node", "node": {
            "id": "calculate", "method": "tool",
            "params": {"arguments": {"value": 21}},
            "bindings": {"name": {"$node": "develop.name"}},
        }},
        {"op": "add_node", "node": {
            "id": "publish", "method": "publish",
            "params": {"name": "result"},
            "bindings": {"content": {"$node": "calculate"}},
        }},
        {"op": "add_control_edge", "edge": {
            "from": "architect", "to": "develop",
        }},
    ])
    gateway = GraphGateway(graph)
    service = TaskService(
        tmp_path, tools=ToolRegistry(), gateway_factory=gateway)
    authority = make_episode_authority(
        ["tool"], ["local_compute"],
        max_definitions=2, max_invocations=3,
    )
    episode = service.create(
        "Create the missing computation and return its checked result",
        deliverables=_deliverable(), package=self_orchestration_package(),
        capability_authority=authority,
    )

    result = service.run(episode["id"])

    assert result["status"] == "completed", result.get("last_error")
    assert result["plan_revision"] == 2
    artifact = service.store.read(result["output_refs"]["result"], episode["id"])
    assert artifact["content"] == {"answer": 42}
    assert service.store.tool_instances(episode["id"], active_only=True)[0][
        "name"
    ] == "task.double"
    assert [call["role"] for call in gateway.calls] == ["architect"]
    available = gateway.calls[0]["payload"]["available_operators"]
    assert "develop_tool" in available
    assert "develop_service" not in available


def test_graph_activates_model_context_service_before_later_ask(tmp_path):
    graph = _proposal([
        {"op": "add_node", "node": {
            "id": "develop", "method": "develop_service",
            "params": {"proposal": _service_proposal()},
        }},
        {"op": "add_node", "node": {
            "id": "activate", "method": "activate_service",
            "params": {"expected_revision": 0},
            "bindings": {
                "definition_id": {"$node": "develop.definition_id"},
            },
        }},
        {"op": "add_node", "node": {
            "id": "worker", "method": "ask",
            "role_ref": "generalist",
            "component_ref": "generalist-role",
            "params": {"max_tokens": 100},
            "bindings": {"payload": {"question": "return the hint"}},
        }},
        {"op": "add_node", "node": {
            "id": "publish", "method": "publish",
            "params": {"name": "result"},
            "bindings": {"content": {"$node": "worker"}},
        }},
        {"op": "add_control_edge", "edge": {
            "from": "architect", "to": "develop",
        }},
        {"op": "add_control_edge", "edge": {
            "from": "activate", "to": "worker",
        }},
    ])

    def worker(role, payload):
        assert role == "generalist"
        assert payload == {"question": "return the hint", "computed_hint": 42}
        return {"answer": payload["computed_hint"]}

    gateway = GraphGateway(graph, worker=worker)
    service = TaskService(
        tmp_path, tools=ToolRegistry(), gateway_factory=gateway)
    authority = make_episode_authority(
        ["service_provider"], ["model_context"],
        max_definitions=2, max_invocations=4, version=2,
    )
    episode = service.create(
        "Develop task-local model context and use it downstream",
        deliverables=_deliverable(), package=self_orchestration_package(),
        capability_authority=authority,
    )

    result = service.run(episode["id"])

    assert result["status"] == "completed", result.get("last_error")
    artifact = service.store.read(result["output_refs"]["result"], episode["id"])
    assert artifact["content"] == {"answer": 42}
    assert gateway.calls[0]["payload"]["task"]["services"] == {
        "model_context.v1": {"status": "empty", "revision": 0},
    }
    assert gateway.calls[1]["payload"]["computed_hint"] == 42
    available = gateway.calls[0]["payload"]["available_operators"]
    assert "develop_service" in available
    assert "activate_service" in available
    assert "develop_tool" not in available
    instance = service.store.service_instance(episode["id"])
    assert instance["status"] == "active"
    assert instance["revision"] == 1


def test_graph_capability_development_fails_closed_without_authority(tmp_path):
    graph = _proposal([
        {"op": "add_node", "node": {
            "id": "develop", "method": "develop_tool",
            "params": {"proposal": _tool_proposal()},
        }},
        {"op": "add_node", "node": {
            "id": "publish", "method": "publish",
            "params": {"name": "result", "content": {"answer": 0}},
        }},
        {"op": "add_control_edge", "edge": {
            "from": "architect", "to": "develop",
        }},
        {"op": "add_control_edge", "edge": {
            "from": "develop", "to": "publish",
        }},
    ])
    gateway = GraphGateway(graph)
    service = TaskService(
        tmp_path, tools=ToolRegistry(), gateway_factory=gateway)
    episode = service.create(
        "Attempt an unauthorized task-local capability",
        deliverables=_deliverable(), package=self_orchestration_package(),
    )

    result = service.run(episode["id"])

    assert result["status"] == "failed"
    assert "tool-development authority" in result["last_error"]
    assert service.store.tool_instances(episode["id"], active_only=False) == []
    assert "develop_tool" not in gateway.calls[0]["payload"][
        "available_operators"
    ]


def test_graph_rejects_unordered_capability_lifecycle_nodes(tmp_path):
    service = TaskService(tmp_path, tools=ToolRegistry())
    authority = make_episode_authority(
        ["tool"], ["local_compute"], max_definitions=2, max_invocations=2)
    workflow = {
        "nodes": [
            {"id": "first", "method": "develop_tool",
             "params": {"proposal": _tool_proposal()}},
            {"id": "second", "method": "develop_tool",
             "params": {"proposal": {
                 **_tool_proposal(), "name": "task.second",
             }}},
        ],
        "outputs": {},
    }

    with pytest.raises(ContractError, match="lifecycle nodes must be totally ordered"):
        service._materialize_workflow(
            self_orchestration_package(), "generated", [],
            proposed_workflow=workflow, capability_authority=authority)
