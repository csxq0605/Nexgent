"""Typed inter-agent message edges for self-designed task DAGs."""

from copy import deepcopy
import json

import pytest

from nexgent.tasks.messages import (
    AGENT_MESSAGE_SCHEMA, make_agent_message, message_schema_ref,
)
from nexgent.tasks.orchestration import PlanExecution
from nexgent.tasks.packages import make_package
from nexgent.tasks.runtime import TaskService
from nexgent.tasks.self_orchestration_seed import self_orchestration_package
from nexgent.tasks.tools import ToolRegistry, ToolSpec
from nexgent.tasks.workflows import (
    WorkflowError, plan_from_workflow, run_executable_workflow, run_workflow,
)


MESSAGE_CONTRACT = {
    "topic": "research.finding",
    "payload_schema": {
        "type": "object",
        "properties": {"claim": {"type": "string"}},
        "required": ["claim"],
        "additionalProperties": False,
    },
}


def _workflow(*, typed=True):
    edge = {
        "producer_node": "researcher",
        "output_port": "finding",
        "consumer_node": "reviewer",
        "input_port": "inbox.finding",
    }
    if typed:
        edge["message"] = deepcopy(MESSAGE_CONTRACT)
    return {
        "nodes": [
            {"id": "researcher", "method": "ask"},
            {"id": "reviewer", "method": "ask"},
        ],
        "artifact_edges": [edge],
        "outputs": {"review": {"$node": "reviewer.review"}},
    }


def test_message_edge_delivers_addressed_typed_envelope_to_receiver():
    received = []

    def invoke(method, params, path):
        if path == "nodes/researcher":
            return {"finding": {"claim": "bounded DAGs can communicate"}}
        received.append(params)
        message = params["inbox"]["finding"]
        return {"review": message["payload"]["claim"]}

    first = run_workflow(_workflow(), {}, invoke)
    second = run_workflow(_workflow(), {}, invoke)

    assert first["status"] == "completed"
    assert first["outputs"] == {"review": "bounded DAGs can communicate"}
    message = received[0]["inbox"]["finding"]
    assert message == {
        "schema": AGENT_MESSAGE_SCHEMA,
        "id": message["id"],
        "sender_node_id": "researcher",
        "recipient_node_id": "reviewer",
        "topic": "research.finding",
        "payload_schema_ref": message_schema_ref(MESSAGE_CONTRACT),
        "payload": {"claim": "bounded DAGs can communicate"},
    }
    assert message["id"].startswith("message-")
    assert received[1]["inbox"]["finding"]["id"] == message["id"]
    assert second["status"] == "completed"


def test_executable_plan_delivers_message_through_durable_node_path():
    workflow = _workflow()
    execution = PlanExecution.create(
        "message-execution", plan_from_workflow(workflow, "message-plan"))
    received = []

    def invoke(method, params, path):
        if path == "plan/nodes/researcher":
            return {"finding": {"claim": "durable message"}}
        received.append(params["inbox"]["finding"])
        return {"review": "accepted"}

    result = run_executable_workflow(
        workflow,
        {},
        invoke,
        execution=execution,
        persist=lambda current, receipts: None,
        resolve_revision=lambda *args: pytest.fail("workflow has no revisions"),
        receipt_evidence=lambda kind, value: (),
        record_local_receipt=lambda method, params, path, receipt: None,
        max_parallel=1,
    )

    assert result["status"] == "completed"
    assert result["outputs"] == {"review": "accepted"}
    assert received[0]["schema"] == AGENT_MESSAGE_SCHEMA
    assert received[0]["sender_node_id"] == "researcher"
    assert received[0]["recipient_node_id"] == "reviewer"
    assert all(state.status.value == "completed"
               for state in result["plan_execution"].node_executions)


def test_task_service_recovers_sender_then_delivers_message_to_model_role(tmp_path):
    calls = []
    pause_sender_once = [True]

    def gateway_factory(reserve, stop_event):
        class Gateway:
            def ask(self, role, prompt, payload=None, max_tokens=4000):
                call_id = f"message-role-{len(calls) + 1}"
                receipt = {
                    "call_id": call_id,
                    "role": role,
                    "model": "DETERMINISTIC-MESSAGE-DOUBLE",
                    "status": "started",
                    "reserved_completion_tokens": max_tokens,
                    "max_tokens": max_tokens,
                }
                reserve(receipt)
                calls.append({"role": role, "payload": deepcopy(payload)})
                reserve({
                    **receipt,
                    "status": "completed",
                    "billing_status": "usage_reported",
                    "usage": {
                        "prompt_tokens": 1,
                        "completion_tokens": 1,
                        "total_tokens": 2,
                    },
                })
                if role == "researcher":
                    if pause_sender_once[0]:
                        pause_sender_once[0] = False
                        stop_event.set()
                    return {"text": "durable finding"}
                return {"text": "accepted"}

        return Gateway()

    def publish_review(arguments, context):
        artifact = context.publish({"review": arguments["review"]}, name="result")
        return {"artifact_id": artifact["id"]}

    tool = ToolSpec(
        "message.publish-review",
        {
            "type": "object",
            "properties": {"review": {"type": "string"}},
            "required": ["review"],
            "additionalProperties": False,
        },
        {"type": "object"},
        "artifact_write",
        publish_review,
    )
    message_contract = {
        "topic": "research.finding",
        "payload_schema": {"type": "string"},
    }
    workflow = {
        "nodes": [
            {
                "id": "researcher",
                "method": "ask",
                "role_ref": "researcher",
                "component_ref": "researcher-role",
                "params": {"payload": {"question": "Find evidence"}, "max_tokens": 20},
            },
            {
                "id": "reviewer",
                "method": "ask",
                "role_ref": "reviewer",
                "component_ref": "reviewer-role",
                "params": {"payload": {}, "max_tokens": 20},
            },
            {
                "id": "publish",
                "method": "tool",
                "params": {"name": tool.name},
                "bindings": {"arguments": {"review": {"$node": "reviewer.text"}}},
            },
        ],
        "artifact_edges": [{
            "producer_node": "researcher",
            "output_port": "text",
            "consumer_node": "reviewer",
            "input_port": "payload.inbox.finding",
            "message": message_contract,
        }],
        "outputs": {
            "deliverables": {"result": {"$node": "publish.artifact_id"}},
        },
    }
    files = {
        "agent/main.py": (
            "def execute(payload, context):\n"
            "    raise RuntimeError('workflow orchestrator must bypass execute')\n"
        ),
        "prompts/researcher.md": "Find one concise result.",
        "prompts/reviewer.md": "Review the addressed message in your payload.",
        "workflows/main.json": json.dumps(workflow),
    }
    manifest = {
        "manifest_version": 2,
        "entries": {"execute": "agent/main.py:execute"},
        "skills": {},
        "roles": {
            role: {"prompt_ref": f"prompts/{role}.md", "capabilities": ["ask"]}
            for role in ("researcher", "reviewer")
        },
        "workflows": {
            "main": {
                "ref": "workflows/main.json",
                "max_parallel": 1,
                "input_schema": {"type": "object"},
                "output_schema": {"type": "object"},
            },
        },
        "components": {
            "main-orchestrator": {"class": "O", "kind": "workflow", "ref": "main"},
            "researcher-role": {"class": "S", "kind": "role", "ref": "researcher"},
            "reviewer-role": {"class": "S", "kind": "role", "ref": "reviewer"},
        },
        "orchestrator": "main-orchestrator",
    }
    registry = ToolRegistry([tool])
    service = TaskService(tmp_path, tools=registry, gateway_factory=gateway_factory)
    episode = service.create(
        "Exchange a typed finding",
        deliverables=[{"name": "result", "schema": {"type": "object"}}],
        capabilities=[tool.name],
        constraints={"allowed_effects": ["artifact_write"]},
        package=make_package(files, manifest),
    )

    paused = service.run(episode["id"])

    assert paused["status"] == "paused"
    assert paused["nodes"]["plan/nodes/researcher"]["status"] == "completed"
    assert paused["nodes"]["plan/nodes/reviewer"]["status"] == "pending"
    assert [call["role"] for call in calls] == ["researcher"]
    assert service.store.rpc_find(
        episode["id"], "plan/nodes/researcher")["status"] == "completed"

    resumed_service = TaskService(
        tmp_path, tools=registry, gateway_factory=gateway_factory)
    resumed = resumed_service.run(episode["id"])

    expected_message = make_agent_message(
        sender_node_id="researcher",
        recipient_node_id="reviewer",
        contract=message_contract,
        payload="durable finding",
    )
    assert resumed["status"] == "completed", resumed.get("last_error")
    assert [call["role"] for call in calls] == ["researcher", "reviewer"]
    assert calls[1]["payload"] == {"inbox": {"finding": expected_message}}
    reviewer_rpc = resumed_service.store.rpc_find(
        episode["id"], "plan/nodes/reviewer")
    assert reviewer_rpc["request"]["params"]["payload"] == calls[1]["payload"]
    started = [event["content"]["call_path"] for event in resumed["events"]
               if event["kind"] == "rpc_started"]
    assert started.count("plan/nodes/researcher") == 1
    assert started.count("plan/nodes/reviewer") == 1


def test_self_designed_graph_combines_task_role_with_typed_message_edge(tmp_path):
    role_prompt = (
        "Act as the task's source analyst. Return one finding with its evidence."
    )
    message_contract = {
        "topic": "analysis.finding",
        "payload_schema": {
            "type": "object",
            "properties": {
                "claim": {"type": "string"},
                "evidence": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["claim", "evidence"],
            "additionalProperties": False,
        },
    }
    proposal = {
        "replaced_node_ids": ["slot"],
        "task_roles": {
            "source_analyst": {
                "identity": "Task source analyst",
                "prompt": role_prompt,
                "capabilities": ["ask"],
            },
        },
        "operations": [
            {"op": "remove_node", "node_id": "slot"},
            {"op": "add_node", "node": {
                "id": "analyst",
                "method": "ask",
                "role_ref": "task:source_analyst",
                "params": {"max_tokens": 100},
                "bindings": {"payload": {"task": {"$input": ""}}},
            }},
            {"op": "add_node", "node": {
                "id": "reviewer",
                "method": "ask",
                "role_ref": "critic",
                "component_ref": "critic-role",
                "params": {"max_tokens": 100, "payload": {}},
            }},
            {"op": "add_node", "node": {
                "id": "publish",
                "method": "publish",
                "params": {"name": "result"},
                "bindings": {"content": {"$node": "reviewer"}},
            }},
            {"op": "add_control_edge", "edge": {
                "from": "architect", "to": "analyst",
            }},
            {"op": "add_artifact_edge", "edge": {
                "producer_node": "analyst",
                "output_port": "finding",
                "consumer_node": "reviewer",
                "input_port": "payload.inbox.finding",
                "message": message_contract,
            }},
        ],
        "outputs": {"deliverables": {"result": {"$node": "publish.id"}}},
        "revision_rules": [],
    }
    calls = []

    def gateway_factory(reserve, stop_event):
        class Gateway:
            def ask(self, role, prompt, payload=None, max_tokens=4000):
                receipt = {
                    "call_id": f"composed-message-{len(calls) + 1}",
                    "role": role,
                    "model": "COMPOSED-GRAPH-TEST-DOUBLE",
                    "status": "started",
                    "reserved_completion_tokens": max_tokens,
                    "max_tokens": max_tokens,
                }
                reserve(receipt)
                calls.append({
                    "role": role,
                    "prompt": prompt,
                    "payload": deepcopy(payload),
                })
                reserve({
                    **receipt,
                    "status": "completed",
                    "billing_status": "usage_reported",
                    "usage": {
                        "prompt_tokens": 1,
                        "completion_tokens": 1,
                        "total_tokens": 2,
                    },
                })
                if role == "architect":
                    return {"proposal": proposal}
                if role.startswith("task-role://source_analyst/"):
                    return {"finding": {
                        "claim": "typed edges compose with task roles",
                        "evidence": ["runtime receipt"],
                    }}
                message = payload["inbox"]["finding"]
                return {
                    "accepted": True,
                    "claim": message["payload"]["claim"],
                    "message_id": message["id"],
                }

        return Gateway()

    service = TaskService(tmp_path, gateway_factory=gateway_factory)
    episode = service.create(
        "Create a specialist and have another agent review its typed finding",
        deliverables=[{"name": "result", "schema": {
            "type": "object",
            "properties": {"accepted": {"const": True}},
            "required": ["accepted", "claim", "message_id"],
        }}],
        budget={
            "max_model_calls": 3,
            "max_completion_tokens": 6000,
            "max_tool_calls": 0,
            "max_nodes": 8,
        },
        package=self_orchestration_package(),
    )

    result = service.run(episode["id"])

    assert result["status"] == "completed", result.get("last_error")
    assert result["plan_revision"] == 2
    assert len(calls) == 3
    analyst_call = calls[1]
    reviewer_call = calls[2]
    assert analyst_call["role"].startswith("task-role://source_analyst/")
    assert analyst_call["prompt"] == role_prompt
    assert reviewer_call["role"] == "critic"
    message = reviewer_call["payload"]["inbox"]["finding"]
    assert message["schema"] == AGENT_MESSAGE_SCHEMA
    assert message["sender_node_id"] == "analyst"
    assert message["recipient_node_id"] == "reviewer"
    assert message["topic"] == "analysis.finding"
    assert message["payload_schema_ref"] == message_schema_ref(message_contract)
    assert message["payload"] == {
        "claim": "typed edges compose with task roles",
        "evidence": ["runtime receipt"],
    }
    private = service.get_private(episode["id"])
    [task_role_ref] = private["plan_workflow_snapshot"]["task_roles"]
    assert task_role_ref == analyst_call["role"]
    reviewer_rpc = service.store.rpc_find(episode["id"], "plan/nodes/reviewer")
    assert reviewer_rpc["request"]["params"]["payload"] == reviewer_call["payload"]
    delivered = service.store.read(result["output_refs"]["result"], episode["id"])
    assert delivered["content"] == {
        "accepted": True,
        "claim": "typed edges compose with task roles",
        "message_id": message["id"],
    }


def test_invalid_message_payload_fails_receiver_before_it_is_invoked():
    calls = []

    def invoke(method, params, path):
        calls.append(path)
        return ({"finding": {"claim": 7}}
                if path == "nodes/researcher" else {"review": "unreachable"})

    result = run_workflow(_workflow(), {}, invoke)

    assert calls == ["nodes/researcher"]
    assert result["status"] == "failed"
    assert result["nodes"]["reviewer"]["status"] == "failed"
    assert result["nodes"]["reviewer"]["value"]["error_type"] == "AgentMessageError"
    assert "message researcher->reviewer payload/claim" in result["nodes"]["reviewer"]["error"]


def test_message_contract_is_part_of_plan_and_receiver_wiring_identity():
    workflow = _workflow()
    first = plan_from_workflow(workflow, "message-plan")
    binding = first.artifact_bindings[0]

    assert binding.producer_node_id == "researcher"
    assert binding.consumer_node_id == "reviewer"
    assert binding.schema_ref == message_schema_ref(MESSAGE_CONTRACT)
    assert first.nodes[0].output_ports[0].schema_ref == binding.schema_ref
    assert first.nodes[1].input_ports[0].schema_ref == binding.schema_ref

    revised = deepcopy(workflow)
    revised["artifact_edges"][0]["message"]["topic"] = "research.challenge"
    second = plan_from_workflow(revised, "message-plan")
    assert second.ref != first.ref


def test_message_edge_rejects_spoofed_schema_identity():
    workflow = _workflow()
    workflow["artifact_edges"][0]["schema_ref"] = "schema://json"

    with pytest.raises(WorkflowError, match="schema_ref must match"):
        plan_from_workflow(workflow, "message-plan")


def test_legacy_artifact_edge_still_delivers_raw_payload():
    received = []

    def invoke(method, params, path):
        if path == "nodes/researcher":
            return {"finding": {"claim": "legacy"}}
        received.append(params)
        return {"review": params["inbox"]["finding"]["claim"]}

    result = run_workflow(_workflow(typed=False), {}, invoke)

    assert result["status"] == "completed"
    assert received == [{"inbox": {"finding": {"claim": "legacy"}}}]
