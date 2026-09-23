"""Runtime contracts for promoted portable AgentPackage capabilities."""

from copy import deepcopy
import json
import threading

import pytest

from nexgent.tasks.packages import (
    MODEL_CONTEXT_INPUT_SCHEMA, MODEL_CONTEXT_OUTPUT_SCHEMA, make_package,
)
from nexgent.tasks.runtime import TaskService
from nexgent.tasks.tools import ContractError, ToolRegistry, ToolSpec


TOOL_INPUT = {
    "type": "object", "required": ["value"],
    "properties": {"value": {"type": "integer"}},
    "additionalProperties": False,
}
TOOL_OUTPUT = {
    "type": "object", "required": ["doubled"],
    "properties": {"doubled": {"type": "integer"}},
    "additionalProperties": False,
}


def _manifest(*, tools=None, services=None):
    components = {
        "main-entry": {"class": "O", "kind": "entry", "ref": "execute"},
    }
    if tools:
        components["portable-tool"] = {
            "class": "S", "kind": "tool", "ref": "portable.double"}
    if services:
        components["portable-service"] = {
            "class": "S", "kind": "service_provider",
            "ref": "model_context.v1",
        }
    return {
        "manifest_version": 2,
        "entries": {"execute": "agent/main.py:execute"},
        "skills": {}, "roles": {}, "workflows": {},
        "components": components, "orchestrator": "main-entry",
        "tools": tools or {}, "services": services or {},
    }


def _tool_package(*, bad_output=False):
    files = {
        "agent/main.py": (
            "def execute(payload, context):\n"
            "    value = context.tool('portable.double', {'value': 4})\n"
            "    artifact = context.publish(value, name='result')\n"
            "    return {'deliverables': {'result': artifact['id']}}\n"
        ),
        "capabilities/double.py": (
            "def execute(payload, context):\n"
            + ("    return {'wrong': payload['value']}\n" if bad_output else
               "    return {'doubled': payload['value'] * 2}\n")
        ),
    }
    tools = {"portable.double": {
        "description": "Double one integer.",
        "ref": "capabilities/double.py:execute",
        "input_schema": TOOL_INPUT, "output_schema": TOOL_OUTPUT,
        "effect_class": "local_compute", "runtime": "controlled-python-v1",
        "work_units_per_call": 1,
    }}
    return make_package(files, _manifest(tools=tools))


def _service_package(*, drop_original=False):
    provider_body = (
        "    return {'payload': {'hint': 'portable'}, 'annotations': {}}\n"
        if drop_original else
        "    visible = payload['payload'].copy()\n"
        "    visible['hint'] = 'portable'\n"
        "    return {'payload': visible, 'annotations': {'source': 'package'}}\n"
    )
    files = {
        "agent/main.py": (
            "def execute(payload, context):\n"
            "    answer = context.ask('solver', 'solve', {'evidence': 7}, 20)\n"
            "    artifact = context.publish(answer, name='result')\n"
            "    return {'deliverables': {'result': artifact['id']}}\n"
        ),
        "capabilities/context.py": "def provide(payload, context):\n" + provider_body,
    }
    services = {"model_context.v1": {
        "name": "portable.context", "description": "Add one durable hint.",
        "ref": "capabilities/context.py:provide",
        "service_interface": "model_context.v1",
        "input_schema": MODEL_CONTEXT_INPUT_SCHEMA,
        "output_schema": MODEL_CONTEXT_OUTPUT_SCHEMA,
        "effect_class": "model_context", "runtime": "controlled-python-v1",
    }}
    return make_package(files, _manifest(services=services))


def _tool_workflow_package(*, component_ref="portable-tool"):
    workflow = {
        "nodes": [{
            "id": "double", "method": "tool",
            "component_ref": component_ref,
            "params": {"name": "portable.double", "arguments": {"value": 4}},
        }],
        "outputs": {"value": {"$node": "double.doubled"}},
    }
    files = {
        "agent/main.py": "def execute(payload, context):\n    return {}\n",
        "workflows/main.json": json.dumps(workflow),
        "capabilities/double.py": (
            "def execute(payload, context):\n"
            "    return {'doubled': payload['value'] * 2}\n"
        ),
    }
    tools = {"portable.double": {
        "description": "Double one integer.",
        "ref": "capabilities/double.py:execute",
        "input_schema": TOOL_INPUT, "output_schema": TOOL_OUTPUT,
        "effect_class": "local_compute", "runtime": "controlled-python-v1",
        "work_units_per_call": 1,
    }}
    manifest = _manifest(tools=tools)
    manifest["workflows"] = {"main": {
        "ref": "workflows/main.json", "max_parallel": 1,
        "input_schema": {}, "output_schema": {},
    }}
    manifest["components"].pop("main-entry")
    manifest["components"]["main-workflow"] = {
        "class": "O", "kind": "workflow", "ref": "main",
    }
    manifest["orchestrator"] = "main-workflow"
    return make_package(files, manifest)


class CapturingGateway:
    def __init__(self):
        self.created = 0
        self.payloads = []

    def __call__(self, reserve, _stop_event):
        owner = self
        owner.created += 1

        class Gateway:
            def ask(self, role, prompt, payload=None, max_tokens=4000):
                owner.payloads.append(deepcopy(payload))
                receipt = {
                    "call_id": "portable-service-call", "role": role,
                    "model": "TEST", "status": "started",
                    "reserved_completion_tokens": max_tokens, "max_tokens": max_tokens,
                }
                reserve(receipt)
                reserve({**receipt, "status": "completed",
                         "billing_status": "usage_reported",
                         "usage": {"prompt_tokens": 1, "completion_tokens": 1,
                                   "total_tokens": 2}})
                return {"observed": deepcopy(payload)}

        return Gateway()


def _create(service, package):
    return service.create(
        "exercise a promoted package capability", package=package,
        capabilities=[], budget={"max_tool_calls": 4,
                                 "max_tool_work_units": 500_000},
    )


def test_package_tool_executes_with_bound_receipt_and_activation_evidence(tmp_path):
    package = _tool_package()
    service = TaskService(tmp_path, tools=ToolRegistry())
    episode = _create(service, package)

    completed = service.run(episode["id"])

    assert service.store.read(completed["output_refs"]["result"], episode["id"])[
        "content"] == {"doubled": 8}
    tool_event = next(event for event in completed["events"] if event["kind"] == "tool")
    binding = tool_event["content"]["package_capability"]
    assert binding["scope"] == "agent_package"
    assert binding["component_id"] == "portable-tool"
    assert "dynamic_capability" not in tool_event["content"]
    assert completed["execution"]["activated_components"] == [{
        "component_id": "portable-tool", "kind": "tool",
        "package_digest": package["digest"],
        "source_path": "capabilities/double.py",
    }]
    assert "capabilities/double.py" in completed["execution"]["loaded_modules"]


def test_failed_package_tool_never_becomes_activation_evidence(tmp_path):
    package = _tool_package(bad_output=True)
    service = TaskService(tmp_path, tools=ToolRegistry())
    episode = _create(service, package)

    failed = service.run(episode["id"])

    assert failed["status"] == "failed"
    assert not [event for event in failed["events"]
                if event["kind"] == "package_capability_activated"]
    tool_event = next(event for event in failed["events"] if event["kind"] == "tool")
    assert tool_event["content"]["status"] == "failed"


def test_package_tool_name_cannot_shadow_installed_tool(tmp_path):
    installed = ToolSpec(
        name="portable.double", description="installed", effect_class="local_compute",
        input_schema=TOOL_INPUT, output_schema=TOOL_OUTPUT,
        handler=lambda value, _context: {"doubled": value["value"] * 2},
    )
    service = TaskService(tmp_path, tools=ToolRegistry([installed]))

    with pytest.raises(ContractError, match="shadow installed"):
        _create(service, _tool_package())


def test_workflow_package_tool_requires_exact_component_binding(tmp_path):
    service = TaskService(tmp_path, tools=ToolRegistry())
    package = _tool_workflow_package()
    materialized = service._materialize_workflow(package, "main", [])
    assert materialized["nodes"][0]["component_ref"] == "portable-tool"

    with pytest.raises(ContractError, match="matching S component_ref"):
        bad = _tool_workflow_package(component_ref="main-workflow")
        service._materialize_workflow(bad, "main", [])


def test_package_service_transforms_then_activates_only_after_model_completion(tmp_path):
    package = _service_package()
    gateway = CapturingGateway()
    service = TaskService(tmp_path, tools=ToolRegistry(), gateway_factory=gateway)
    episode = _create(service, package)

    completed = service.run(episode["id"])

    assert gateway.payloads == [{"evidence": 7, "hint": "portable"}]
    model_call = completed["calls"][0]
    assert model_call["service_provider"]["scope"] == "agent_package"
    assert model_call["service_provider"]["component_id"] == "portable-service"
    assert completed["execution"]["activated_components"] == [{
        "component_id": "portable-service", "kind": "service_provider",
        "package_digest": package["digest"],
        "source_path": "capabilities/context.py",
    }]
    assert "capabilities/context.py" in completed["execution"]["loaded_modules"]


def test_package_service_cannot_drop_payload_and_does_not_send_model_call(tmp_path):
    package = _service_package(drop_original=True)
    gateway = CapturingGateway()
    service = TaskService(tmp_path, tools=ToolRegistry(), gateway_factory=gateway)
    episode = _create(service, package)

    failed = service.run(episode["id"])

    assert failed["status"] == "failed"
    assert gateway.created == 0
    assert gateway.payloads == []
    assert not [event for event in failed["events"]
                if event["kind"] == "package_capability_activated"]
