"""Pure task-time tool Definition compilation contracts."""

from copy import deepcopy

import pytest

from nexgent.tasks.capability_definitions import (
    DefinitionError,
    build_tool_definition,
    verify_tool_definition,
)


def proposal(**changes):
    value = {
        "name": "task_math.double",
        "description": "Double one JSON integer.",
        "source": (
            "def execute(payload, context):\n"
            "    return {'value': payload['value'] * 2}\n"
        ),
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
    }
    value.update(changes)
    return value


def test_builds_fresh_pure_tool_definition_and_separate_package():
    record, package = build_tool_definition(proposal(), "episode-0123456789abcdef")

    assert record["id"].startswith("definition-")
    assert record["name"] == "task_math.double"
    assert record["kind"] == "tool"
    assert record["effect_class"] == "local_compute"
    assert record["declared_operations"] == []
    assert record["credential_handles"] == []
    assert record["dependency_lock"] == []
    assert record["runtime"] == "controlled-python-v1"
    assert record["package_id"] == package["id"]
    assert record["package_digest"] == record["bundle_digest"] == package["digest"]
    assert record["entry"] == "tool.py:execute"
    assert record["entry_digest"] == package["component_digests"]["tool.py"]
    assert package["provenance"] == {
        "task_time_only": True,
        "promotion_authority": False,
        "episode_id": "episode-0123456789abcdef",
    }
    assert verify_tool_definition(record, package) is record


def test_definition_and_package_source_tampering_are_rejected():
    record, package = build_tool_definition(proposal(), "episode-origin")
    changed_record = deepcopy(record)
    changed_record["effect_class"] = "external_compute"
    with pytest.raises(DefinitionError, match="identity mismatch"):
        verify_tool_definition(changed_record, package)

    changed_package = deepcopy(package)
    changed_package["files"]["tool.py"] = (
        "def execute(payload, context):\n    return {'value': 0}\n")
    with pytest.raises(DefinitionError, match="Invalid tool package"):
        verify_tool_definition(record, changed_package)


@pytest.mark.parametrize("source", [
    "import os\ndef execute(payload, context):\n    return payload\n",
    "def execute(payload, context):\n    return open(payload['path']).read()\n",
    "def execute(payload, context):\n    return context.ask(payload)\n",
    "def execute(payload):\n    return payload\n",
])
def test_forbidden_or_non_pure_source_is_rejected(source):
    with pytest.raises(DefinitionError):
        build_tool_definition(proposal(source=source), "episode-origin")


@pytest.mark.parametrize("field,schema", [
    ("input_schema", {"type": "not-a-json-type"}),
    ("output_schema", {"$ref": "https://example.invalid/schema"}),
    ("input_schema", ["not", "a", "schema"]),
])
def test_malformed_contract_schemas_are_rejected(field, schema):
    with pytest.raises(DefinitionError, match="schema"):
        build_tool_definition(proposal(**{field: schema}), "episode-origin")


def test_content_identity_is_stable_and_tracks_origin_and_source():
    first_record, first_package = build_tool_definition(
        proposal(), "episode-0123456789abcdef")
    second_record, second_package = build_tool_definition(
        deepcopy(proposal()), "episode-0123456789abcdef")
    assert first_record == second_record
    assert first_package == second_package

    other_origin, same_bundle = build_tool_definition(
        proposal(), "episode-fedcba9876543210")
    assert other_origin["id"] != first_record["id"]
    # Task-scoped package storage has one immutable row per package id; origin
    # must be part of bundle identity so two creators cannot alias that row.
    assert same_bundle["id"] != first_package["id"]

    changed_record, changed_package = build_tool_definition(
        proposal(source=(
            "def execute(payload, context):\n"
            "    return {'value': payload['value'] * 3}\n"
        )),
        "episode-0123456789abcdef",
    )
    assert changed_record["id"] != first_record["id"]
    assert changed_package["id"] != first_package["id"]
