"""Versioned trusted tool-provider registration without runtime dispatch edits."""

from dataclasses import replace
import json
import threading

import pytest

from nexgent.tasks.packages import make_package
from nexgent.tasks.runtime import TaskService
from nexgent.tasks.tools import (
    CAPABILITY_INVENTORY_SCHEMA,
    TOOL_PROVIDER_INTERFACE,
    ContractError,
    ToolProvider,
    ToolRegistry,
    ToolSpec,
)


def _provider(version, value, *, digest_char="a", name="switch.value",
              dependencies=("fixture-runtime==1.0",)):
    def handler(arguments, context):
        return {"value": value, "argument": arguments["argument"]}

    tool = ToolSpec(
        name=name,
        description="Return the provider version marker.",
        input_schema={
            "type": "object", "required": ["argument"],
            "properties": {"argument": {"type": "integer"}},
            "additionalProperties": False,
        },
        output_schema={
            "type": "object", "required": ["value", "argument"],
            "properties": {
                "value": {"type": "string"},
                "argument": {"type": "integer"},
            },
            "additionalProperties": False,
        },
        effect_class="local_compute",
        handler=handler,
        work_units_per_call=1,
        provider_id="fixture.provider",
        provider_version=version,
        handler_digest=digest_char * 64,
    )
    return ToolProvider(
        provider_id="fixture.provider",
        provider_version=version,
        tools=(tool,),
        declared_operations=("local.compute",),
        dependencies=dependencies,
    )


def _package():
    return make_package(
        {"agent/main.py": """def execute(payload, context):
    value = context.tool('switch.value', {'argument': 7})
    artifact = context.publish(value, name='result')
    return {'deliverables': {'result': artifact['id']}}
"""},
        {"entries": {"execute": "agent/main.py:execute"}},
    )


def _run(service):
    state = service.create(
        "Use the currently registered provider",
        package=_package(),
        capabilities=["switch.value"],
        deliverables=[{"name": "result", "schema": {"type": "object"}}],
        budget={"max_model_calls": 0, "max_completion_tokens": 0,
                "max_tool_calls": 1, "max_tool_work_units": 1,
                "max_nodes": 8},
    )
    result = service.run(state["id"])
    assert result["status"] == "completed", result.get("last_error")
    return service.store.read(result["output_refs"]["result"], state["id"])["content"]


def test_task_service_dispatch_uses_replaced_provider_without_runtime_change(tmp_path):
    registry = ToolRegistry()
    first = registry.register_provider(_provider("1.0", "first"))
    service = TaskService(tmp_path, tools=registry)

    assert _run(service) == {"value": "first", "argument": 7}
    second = registry.register_provider(
        _provider("2.0", "second", digest_char="b"), replace=True)
    assert _run(service) == {"value": "second", "argument": 7}
    assert first["digest"] != second["digest"]


def test_replacement_preserves_frozen_lease_and_receipt_safety(tmp_path):
    registry = ToolRegistry()
    registry.register_provider(_provider("1.0", "first"))
    service = TaskService(tmp_path, tools=registry)
    state = service.create(
        "Freeze provider one for this Episode",
        package=_package(),
        capabilities=["switch.value"],
        initially_active_capabilities=["switch.value"],
        deliverables=[{"name": "result", "schema": {"type": "object"}}],
        budget={"max_tool_work_units": 1},
    )
    lease = service.active_capabilities(state["id"])[0]
    assert lease["descriptor"]["provider_version"] == "1.0"

    registry.register_provider(
        _provider("2.0", "second", digest_char="b"), replace=True)
    with pytest.raises(ContractError, match="differs from the frozen"):
        service.run(state["id"])
    assert service.store.get(state["id"])["status"] == "ready"
    assert lease["descriptor"]["provider_version"] == "1.0"
    assert lease["descriptor"]["handler_digest"] == "a" * 64


def test_provider_replacement_rejects_conflicts_and_bad_metadata_atomically():
    registry = ToolRegistry()
    registry.register_provider(_provider("1.0", "first"))
    before = registry.capability_inventory()
    original_handler = registry.get("switch.value").handler

    bad_dependency = _provider(
        "2.0", "bad", digest_char="b", dependencies=("floating-version",))
    with pytest.raises(ContractError, match="exact name==version pins"):
        registry.register_provider(bad_dependency, replace=True)

    invalid_tool = replace(
        _provider("2.0", "bad", digest_char="b").tools[0],
        handler_digest="not-a-sha256",
    )
    invalid_digest = replace(
        _provider("2.0", "bad", digest_char="b"), tools=(invalid_tool,))
    with pytest.raises(ContractError, match="declared handler SHA-256"):
        registry.register_provider(invalid_digest, replace=True)

    other_tool = replace(
        _provider("9.0", "other", digest_char="c").tools[0],
        provider_id="other.provider", provider_version="9.0")
    other = ToolProvider("other.provider", "9.0", (other_tool,))
    with pytest.raises(ContractError, match="does not own"):
        registry.register_provider(other)

    assert registry.capability_inventory() == before
    assert registry.get("switch.value").handler is original_handler


def test_inventory_is_versioned_non_executable_and_unload_is_guarded():
    registry = ToolRegistry()
    registered = registry.register_provider(_provider("1.0", "first"))
    inventory = registry.capability_inventory()

    assert inventory["schema"] == CAPABILITY_INVENTORY_SCHEMA
    assert inventory["version"] == 1
    assert inventory["providers"] == [registered]
    assert registered["interface"] == TOOL_PROVIDER_INTERFACE
    assert registered["declared_operations"] == ["local.compute"]
    assert registered["dependencies"] == ["fixture-runtime==1.0"]
    assert registered["tools"][0]["handler_identity"] == {
        "kind": "provider_declared_sha256", "digest": "a" * 64}
    assert "handler" not in registered["tools"][0]
    json.dumps(inventory, allow_nan=False)

    with pytest.raises(ContractError, match="version changed"):
        registry.unregister_provider("fixture.provider", expected_version="0.9")
    assert registry.get("switch.value").provider_version == "1.0"
    removed = registry.unregister_provider(
        "fixture.provider", expected_version="1.0")
    assert removed == registered
    with pytest.raises(ContractError, match="not installed"):
        registry.get("switch.value")


def test_registration_and_get_freeze_mutable_tool_declarations():
    registry = ToolRegistry()
    provider = _provider("1.0", "first")
    original_handler = provider.tools[0].handler
    registered = registry.register_provider(provider)

    provider.tools[0].input_schema["required"].append("injected")
    provider.tools[0].input_schema["properties"]["injected"] = {
        "type": "string"}
    provider.tools[0].output_schema["properties"]["value"]["type"] = "integer"
    assert registry.capability_inventory()["providers"] == [registered]

    exposed = registry.get("switch.value")
    assert exposed.handler is original_handler
    exposed.input_schema["required"].append("via-get")
    exposed.output_schema["properties"].clear()
    frozen = registry.get("switch.value")
    assert frozen.handler is original_handler
    assert frozen.input_schema["required"] == ["argument"]
    assert frozen.output_schema["properties"] == {
        "value": {"type": "string"},
        "argument": {"type": "integer"},
    }
    assert registry.lease_descriptor("switch.value")["input_schema"][
        "required"] == ["argument"]


def test_inventory_and_provider_switch_are_linearized(monkeypatch):
    registry = ToolRegistry()
    registry.register_provider(_provider("1.0", "first"))
    inventory_entered = threading.Event()
    release_inventory = threading.Event()
    writer_started = threading.Event()
    writer_finished = threading.Event()
    observed = []
    errors = []
    provider_record = registry._provider_record

    def blocking_provider_record(provider):
        record = provider_record(provider)
        if threading.current_thread().name == "inventory-reader":
            inventory_entered.set()
            if not release_inventory.wait(3):
                raise AssertionError("test did not release inventory reader")
        return record

    monkeypatch.setattr(registry, "_provider_record", blocking_provider_record)

    def read_inventory():
        try:
            observed.append(registry.capability_inventory())
        except BaseException as exc:
            errors.append(exc)

    def replace_provider():
        writer_started.set()
        try:
            registry.register_provider(
                _provider("2.0", "second", digest_char="b"), replace=True)
        except BaseException as exc:
            errors.append(exc)
        finally:
            writer_finished.set()

    reader = threading.Thread(target=read_inventory, name="inventory-reader")
    writer = threading.Thread(target=replace_provider, name="provider-writer")
    reader.start()
    assert inventory_entered.wait(3)
    writer.start()
    assert writer_started.wait(3)
    assert not writer_finished.wait(0.1)
    release_inventory.set()
    reader.join(3)
    writer.join(3)

    assert not errors
    assert not reader.is_alive() and not writer.is_alive()
    assert observed[0]["providers"][0]["provider_version"] == "1.0"
    assert observed[0]["tools"][0]["provider_version"] == "1.0"
    current = registry.capability_inventory()
    assert current["providers"][0]["provider_version"] == "2.0"
    assert current["tools"][0]["provider_version"] == "2.0"


def test_legacy_direct_registration_remains_compatible():
    legacy = replace(
        _provider("1.0", "legacy").tools[0],
        provider_id="", provider_version="", handler_digest="")
    registry = ToolRegistry([legacy])

    assert registry.describe() == [legacy.describe()]
    row = registry.capability_inventory()["tools"][0]
    assert row["registration"] == "legacy_direct"
    assert row["provider_id"] is None
    assert row["handler_identity"] is None
