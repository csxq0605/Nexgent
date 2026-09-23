"""Portable capability releases remain inert and preserve task provenance."""

from copy import deepcopy

import pytest

from nexgent.kernel.programs import digest
from nexgent.tasks.capability_definitions import build_tool_definition
from nexgent.tasks.capability_releases import (
    CapabilityReleaseError,
    RELEASE_SCHEMA,
    build_capability_release,
    verify_capability_release,
)
from nexgent.tasks.service_definitions import build_model_context_definition


def _tool(origin="episode-tool-origin"):
    return build_tool_definition({
        "name": "compare.latency",
        "description": "Choose the option within a latency cap.",
        "source": (
            "def execute(payload, context):\n"
            "    allowed = payload['max_latency']\n"
            "    rows = [item for item in payload['options'] "
            "if item['latency'] <= allowed]\n"
            "    return {'choice': min(rows, key=lambda item: item['cost'])['name']}\n"
        ),
        "input_schema": {
            "type": "object",
            "required": ["options", "max_latency"],
            "properties": {
                "options": {"type": "array", "items": {"type": "object"}},
                "max_latency": {"type": "number"},
            },
            "additionalProperties": False,
        },
        "output_schema": {
            "type": "object", "required": ["choice"],
            "properties": {"choice": {"type": "string"}},
            "additionalProperties": False,
        },
    }, origin)


def _service(origin="episode-service-origin"):
    return build_model_context_definition({
        "name": "comparison.criteria",
        "description": "Attach the public comparison criterion.",
        "source": (
            "def provide(payload, context):\n"
            "    current = payload['payload'].copy()\n"
            "    current['criterion'] = 'minimize cost under latency cap'\n"
            "    return {'payload': current, 'annotations': {'release': 'candidate'}}\n"
        ),
    }, origin)


def _resign(record):
    record = deepcopy(record)
    body = {key: value for key, value in record.items()
            if key not in {"id", "digest"}}
    record_digest = digest(body)
    record["id"] = "capability-release-" + record_digest[:24]
    record["digest"] = record_digest
    return record


def test_builds_portable_tool_release_without_granting_authority():
    definition, package = _tool()
    release = build_capability_release(definition, package)

    assert release["schema"] == RELEASE_SCHEMA
    assert release["kind"] == "tool"
    assert release["effect_class"] == "local_compute"
    assert release["interface"] == {
        "type": "tool", "version": 1, "entry_function": "execute",
    }
    assert release["authority_requirements"] == {
        "minimum_version": 1,
        "kind": "tool",
        "effect_class": "local_compute",
        "declared_operations": [],
        "credential_handles": [],
        "runtime": "controlled-python-v1",
    }
    assert "digest" not in release["authority_requirements"]
    assert "max_invocations" not in release["authority_requirements"]
    assert "authority" not in release
    assert release["creator"]["episode_id"] == "episode-tool-origin"
    assert release["creator"]["definition_id"] == definition["id"]
    assert release["creator"]["package_digest"] == package["digest"]
    assert verify_capability_release(deepcopy(release)) == release


def test_builds_portable_service_release_with_fixed_interface_requirement():
    definition, package = _service()
    release = build_capability_release(definition, package)

    assert release["kind"] == "service_provider"
    assert release["effect_class"] == "model_context"
    assert release["interface"] == {
        "type": "service_provider",
        "name": "model_context.v1",
        "slot": "model_context.v1",
        "entry_function": "provide",
    }
    assert release["authority_requirements"] == {
        "minimum_version": 2,
        "kind": "service_provider",
        "effect_class": "model_context",
        "declared_operations": [],
        "credential_handles": [],
        "runtime": "controlled-python-v1",
    }
    assert release["input_schema"] == definition["input_schema"]
    assert release["output_schema"] == definition["output_schema"]
    assert verify_capability_release(release) == release


def test_identity_is_stable_but_includes_creator_origin():
    definition, package = _tool()
    first = build_capability_release(definition, package)
    assert build_capability_release(definition, package) == first

    other_definition, other_package = _tool("episode-other-origin")
    second = build_capability_release(other_definition, other_package)
    assert second["source_digest"] == first["source_digest"]
    assert second["id"] != first["id"]
    assert second["digest"] != first["digest"]


@pytest.mark.parametrize("mutation", [
    lambda release: release.update(name="forged.name"),
    lambda release: release.update(source=release["source"] + "\n# changed"),
    lambda release: release["interface"].update(version=2),
    lambda release: release["authority_requirements"].update(
        declared_operations=["network.send"]),
    lambda release: release["creator"].update(
        episode_id="episode-forged-origin"),
    lambda release: release["creator"].update(
        definition_digest="0" * 64),
])
def test_semantic_tampering_is_rejected_even_when_release_is_resigned(mutation):
    definition, package = _tool()
    release = build_capability_release(definition, package)
    mutation(release)
    release = _resign(release)
    with pytest.raises(CapabilityReleaseError):
        verify_capability_release(release)


def test_identity_and_envelope_tampering_are_rejected():
    definition, package = _service()
    release = build_capability_release(definition, package)

    wrong_digest = deepcopy(release)
    wrong_digest["digest"] = "0" * 64
    with pytest.raises(CapabilityReleaseError, match="identity mismatch"):
        verify_capability_release(wrong_digest)

    granted = deepcopy(release)
    granted["authority"] = {"digest": "forged"}
    with pytest.raises(CapabilityReleaseError, match="invalid envelope"):
        verify_capability_release(granted)


def test_builder_rejects_unknown_or_tampered_source_definition():
    with pytest.raises(CapabilityReleaseError, match="only tool or service_provider"):
        build_capability_release({"kind": "external_plugin"}, {})

    definition, package = _tool()
    definition["effect_class"] = "external_compute"
    with pytest.raises(CapabilityReleaseError, match="source Definition is invalid"):
        build_capability_release(definition, package)
