"""Manifest-v2 contracts for portable, package-owned capability components."""

from copy import deepcopy

import pytest

from nexgent.tasks.generation import GenerationService
from nexgent.tasks.package_patch_v3 import PACKAGE_PATCH_SCHEMA, apply_package_patch
from nexgent.tasks.packages import (
    MODEL_CONTEXT_INPUT_SCHEMA,
    MODEL_CONTEXT_OUTPUT_SCHEMA,
    PackageError,
    make_package,
    resolve_entry,
    verify_package,
)
from nexgent.tasks.tools import ContractError


TOOL_SOURCE = (
    "def execute(payload, context):\n"
    "    return {'value': payload['value'] * 2}\n"
)
SERVICE_SOURCE = (
    "def provide(payload, context):\n"
    "    visible = payload['payload'].copy()\n"
    "    visible['hint'] = 'compare evidence'\n"
    "    return {'payload': visible, 'annotations': {'source': 'portable'}}\n"
)


def _tool(ref="capabilities/double.py:execute"):
    return {
        "description": "Double one integer with pure local computation.",
        "ref": ref,
        "input_schema": {
            "type": "object", "required": ["value"],
            "properties": {"value": {"type": "integer"}},
            "additionalProperties": False,
        },
        "output_schema": {
            "type": "object", "required": ["value"],
            "properties": {"value": {"type": "integer"}},
            "additionalProperties": False,
        },
        "effect_class": "local_compute",
        "runtime": "controlled-python-v1",
        "work_units_per_call": 0,
    }


def _service(ref="services/context.py:provide"):
    return {
        "name": "portable.context_hint",
        "description": "Add one bounded hint to a model payload.",
        "ref": ref,
        "service_interface": "model_context.v1",
        "input_schema": deepcopy(MODEL_CONTEXT_INPUT_SCHEMA),
        "output_schema": deepcopy(MODEL_CONTEXT_OUTPUT_SCHEMA),
        "effect_class": "model_context",
        "runtime": "controlled-python-v1",
    }


def _parent():
    return make_package(
        {"main.py": "def execute(payload, context):\n    return payload\n"},
        {
            "manifest_version": 2,
            "entries": {"execute": "main.py:execute"},
            "skills": {}, "roles": {}, "workflows": {}, "components": {
                "orchestrator": {"class": "O", "kind": "entry", "ref": "execute"},
            },
            "orchestrator": "orchestrator",
        },
    )


def _capability_package():
    parent = _parent()
    manifest = deepcopy(parent["manifest"])
    manifest["tools"] = {"portable.double": _tool()}
    manifest["services"] = {"model_context.v1": _service()}
    manifest["components"].update({
        "portable-tool-double": {
            "class": "S", "kind": "tool", "ref": "portable.double",
        },
        "portable-service-context": {
            "class": "S", "kind": "service_provider", "ref": "model_context.v1",
        },
    })
    return make_package(
        {**parent["files"],
         "capabilities/double.py": TOOL_SOURCE,
         "services/context.py": SERVICE_SOURCE},
        manifest,
    )


def test_manifest_v2_registers_pure_portable_tool_and_service_entries():
    package = _capability_package()
    assert verify_package(package) == package
    assert resolve_entry(package, "tool:portable.double") == (
        "capabilities/double.py", "execute")
    assert resolve_entry(package, "service:model_context.v1") == (
        "services/context.py", "provide")

    descriptor = GenerationService._mutation_policy({
        "mutable_components": ["portable-tool-double"],
        "allowed_operations": ["replace"],
        "max_patch_bytes": 100_000,
    }, package)["resolved_components"]["portable-tool-double"]
    assert descriptor == {
        "component_id": "portable-tool-double", "class": "S", "kind": "tool",
        "ref": "portable.double", "files": ["capabilities/double.py"],
    }


def test_optional_registries_preserve_old_v2_and_are_forbidden_in_v1():
    assert verify_package(_parent())["manifest"].get("tools") is None
    with pytest.raises(PackageError, match="v2 fields"):
        make_package(
            {"main.py": "def execute(payload, context):\n    return payload\n"},
            {"entries": {"execute": "main.py:execute"}, "tools": {}},
        )


@pytest.mark.parametrize(("registry", "source", "match"), [
    ("tool", "def execute(payload, context):\n    return context.publish(payload)\n", "cannot use context"),
    ("service", "def provide(payload, context):\n    return context.publish(payload)\n", "cannot use context"),
])
def test_portable_capability_source_cannot_call_host_context(registry, source, match):
    parent = _parent()
    manifest = deepcopy(parent["manifest"])
    if registry == "tool":
        path = "capabilities/double.py"
        manifest["tools"] = {"portable.double": _tool()}
        manifest["components"]["portable-tool-double"] = {
            "class": "S", "kind": "tool", "ref": "portable.double"}
    else:
        path = "services/context.py"
        manifest["services"] = {"model_context.v1": _service()}
        manifest["components"]["portable-service-context"] = {
            "class": "S", "kind": "service_provider", "ref": "model_context.v1"}
    with pytest.raises(PackageError, match=match):
        make_package({**parent["files"], path: source}, manifest)


def test_service_contract_is_fixed_to_current_model_context_slice():
    parent = _parent()
    manifest = deepcopy(parent["manifest"])
    declaration = _service()
    declaration["output_schema"] = {"type": "object"}
    manifest["services"] = {"model_context.v1": declaration}
    manifest["components"]["portable-service-context"] = {
        "class": "S", "kind": "service_provider", "ref": "model_context.v1"}
    with pytest.raises(PackageError, match="model-context slice"):
        make_package(
            {**parent["files"], "services/context.py": SERVICE_SOURCE}, manifest)


def test_tool_schema_stays_inside_task_tool_admission_slice():
    parent = _parent()
    manifest = deepcopy(parent["manifest"])
    declaration = _tool()
    declaration["input_schema"]["properties"]["value"] = {
        "type": "string", "pattern": "^(a+)+$"}
    manifest["tools"] = {"portable.double": declaration}
    manifest["components"]["portable-tool-double"] = {
        "class": "S", "kind": "tool", "ref": "portable.double"}
    with pytest.raises(PackageError, match="unsupported portable-tool"):
        make_package(
            {**parent["files"], "capabilities/double.py": TOOL_SOURCE}, manifest)


def test_package_patch_v3_adds_tool_and_service_as_owned_s_components():
    parent = _parent()
    child_manifest = deepcopy(parent["manifest"])
    child_manifest["tools"] = {"portable.double": _tool()}
    child_manifest["services"] = {"model_context.v1": _service()}
    child_manifest["components"].update({
        "portable-tool-double": {
            "class": "S", "kind": "tool", "ref": "portable.double"},
        "portable-service-context": {
            "class": "S", "kind": "service_provider", "ref": "model_context.v1"},
    })
    component_ids = ["portable-tool-double", "portable-service-context"]
    patch = {
        "schema": PACKAGE_PATCH_SCHEMA,
        "parent_package_digest": parent["digest"],
        "hypothesis": {
            "failure_mechanism": "The parent lacks reusable local capabilities.",
            "expected_behavior": "Fresh tasks can load the bounded components.",
            "applicability": "Tasks with the same declared interfaces.",
            "falsifier": "A fresh evaluation does not load or benefit from them.",
            "component_ids": component_ids,
        },
        "operations": [
            {"op": "add", "component_id": "portable-tool-double",
             "path": "capabilities/double.py", "content": TOOL_SOURCE},
            {"op": "add", "component_id": "portable-service-context",
             "path": "services/context.py", "content": SERVICE_SOURCE},
        ],
        "child_manifest": child_manifest,
        "activation_targets": component_ids,
    }
    policy = {
        "mutable_components": ["orchestrator"],
        "allow_add": True, "allow_remove": False,
        "max_patch_bytes": 1_000_000,
        "capability_ceiling": [],
        "tool_ceiling": ["portable.double"],
        "max_parallel": 1,
    }
    child = apply_package_patch(
        parent, patch, policy, provenance={"origin": "test-generation"})
    assert child["parent_id"] == parent["id"]
    assert child["manifest"]["tools"]["portable.double"] == _tool()
    assert child["manifest"]["services"]["model_context.v1"] == _service()

    narrowed = deepcopy(policy)
    narrowed["tool_ceiling"] = []
    with pytest.raises(ContractError, match="portable-tool ceiling"):
        apply_package_patch(
            parent, patch, narrowed, provenance={"origin": "test-generation"})


def test_package_patch_rejects_unowned_portable_registry_delta():
    parent = _parent()
    child_manifest = deepcopy(parent["manifest"])
    child_manifest["tools"] = {"portable.double": _tool()}
    patch = {
        "schema": PACKAGE_PATCH_SCHEMA,
        "parent_package_digest": parent["digest"],
        "hypothesis": {
            "failure_mechanism": "An unowned registry edit was proposed.",
            "expected_behavior": "The host rejects the edit.",
            "applicability": "All PackagePatch v3 candidates.",
            "falsifier": "The unowned registry edit is accepted.",
            "component_ids": ["orchestrator"],
        },
        "operations": [{
            "op": "replace", "component_id": "orchestrator",
            "old_digest": parent["component_digests"]["main.py"],
            "content": "def execute(payload, context):\n    return {'changed': True}\n",
        }],
        "child_manifest": child_manifest,
        "activation_targets": ["orchestrator"],
    }
    policy = {
        "mutable_components": ["orchestrator"],
        "allow_add": True, "allow_remove": False,
        "max_patch_bytes": 1_000_000,
        "capability_ceiling": [],
        "tool_ceiling": ["portable.double"],
        "max_parallel": 1,
    }
    with pytest.raises(ContractError, match="not owned"):
        apply_package_patch(
            parent, patch, policy, provenance={"origin": "test-generation"})
