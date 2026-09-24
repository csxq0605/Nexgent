"""Pure task-time model-context service Definition contracts."""

from copy import deepcopy

import pytest

from nexgent.tasks.service_definitions import (
    MODEL_CONTEXT_INPUT_SCHEMA,
    MODEL_CONTEXT_OUTPUT_SCHEMA,
    SERVICE_INTERFACE,
    ServiceDefinitionError,
    build_model_context_definition,
    build_service_definition,
    verify_model_context_definition,
    verify_service_definition,
)


def proposal(**changes):
    value = {
        "name": "task_context.add_hint",
        "description": "Add a task-local hint to the model-visible payload.",
        "source": (
            "def provide(payload, context):\n"
            "    visible = payload['payload'].copy()\n"
            "    visible['hint'] = 'inspect the evidence'\n"
            "    return {'payload': visible, 'annotations': {'kind': 'hint'}}\n"
        ),
    }
    value.update(changes)
    return value


def test_builds_fixed_model_context_definition_and_origin_bound_package():
    record, package = build_model_context_definition(
        proposal(), "episode-0123456789abcdef")

    assert record["id"].startswith("service-definition-")
    assert record["kind"] == "service_provider"
    assert record["effect_class"] == "model_context"
    assert record["service_interface"] == SERVICE_INTERFACE
    assert record["service_slot"] == SERVICE_INTERFACE
    assert record["input_schema"] == MODEL_CONTEXT_INPUT_SCHEMA
    assert record["output_schema"] == MODEL_CONTEXT_OUTPUT_SCHEMA
    assert record["declared_operations"] == []
    assert record["credential_handles"] == []
    assert record["dependency_lock"] == []
    assert record["runtime"] == "controlled-python-v1"
    assert record["package_id"] == package["id"]
    assert record["package_digest"] == record["bundle_digest"] == package["digest"]
    assert record["entry"] == "service.py:provide"
    assert record["entry_digest"] == package["component_digests"]["service.py"]
    assert package["manifest"] == {
        "entries": {"execute": "service.py:provide"}}
    assert package["provenance"] == {
        "task_time_only": True,
        "promotion_authority": False,
        "episode_id": "episode-0123456789abcdef",
    }
    assert verify_model_context_definition(record, package) is record
    assert verify_service_definition(record, package) is record


def test_generic_builder_alias_uses_the_same_single_service_abi():
    direct = build_model_context_definition(proposal(), "episode-origin")
    generic = build_service_definition(proposal(), "episode-origin")
    assert generic == direct


@pytest.mark.parametrize("source", [
    "import os\ndef provide(payload, context):\n    return payload\n",
    "def provide(payload, context):\n    return context.ask(payload)\n",
    "def provide(payload):\n    return payload\n",
    "def execute(payload, context):\n    return payload\n",
])
def test_forbidden_host_access_or_wrong_provider_signature_is_rejected(source):
    with pytest.raises(ServiceDefinitionError):
        build_model_context_definition(
            proposal(source=source), "episode-origin")


def test_proposal_cannot_supply_schemas_operations_credentials_or_dependencies():
    for extra in (
            {"input_schema": {}},
            {"declared_operations": ["artifact.read"]},
            {"credential_handles": ["secret.one"]},
            {"dependency_lock": ["some-package"]},
            {"service_interface": "another.interface"}):
        with pytest.raises(ServiceDefinitionError, match="invalid envelope"):
            build_model_context_definition(
                proposal(**extra), "episode-origin")


def test_definition_and_package_tampering_are_rejected():
    record, package = build_model_context_definition(
        proposal(), "episode-origin")

    changed_record = deepcopy(record)
    changed_record["service_interface"] = "model_context.v2"
    with pytest.raises(ServiceDefinitionError, match="identity mismatch"):
        verify_model_context_definition(changed_record, package)

    changed_package = deepcopy(package)
    changed_package["files"]["service.py"] = (
        "def provide(payload, context):\n"
        "    return {'payload': {}, 'annotations': {}}\n"
    )
    with pytest.raises(ServiceDefinitionError, match="Invalid service package"):
        verify_model_context_definition(record, changed_package)


def test_fixed_abi_and_empty_authority_dimensions_are_content_bound():
    record, package = build_model_context_definition(
        proposal(), "episode-origin")
    mutations = [
        ("input_schema", {}),
        ("output_schema", {}),
        ("declared_operations", ["artifact.read"]),
        ("credential_handles", ["secret.one"]),
        ("dependency_lock", ["dependency"]),
    ]
    for field, value in mutations:
        changed = deepcopy(record)
        changed[field] = value
        with pytest.raises(ServiceDefinitionError, match="identity mismatch"):
            verify_model_context_definition(changed, package)


def test_content_identity_is_stable_and_tracks_origin_and_source():
    first_record, first_package = build_model_context_definition(
        proposal(), "episode-0123456789abcdef")
    second_record, second_package = build_model_context_definition(
        deepcopy(proposal()), "episode-0123456789abcdef")
    assert second_record == first_record
    assert second_package == first_package

    other_origin, other_package = build_model_context_definition(
        proposal(), "episode-fedcba9876543210")
    assert other_origin["id"] != first_record["id"]
    assert other_package["id"] != first_package["id"]

    changed_record, changed_package = build_model_context_definition(
        proposal(source=(
            "def provide(payload, context):\n"
            "    return {'payload': payload['payload'], "
            "'annotations': {'kind': 'identity'}}\n"
        )),
        "episode-0123456789abcdef",
    )
    assert changed_record["id"] != first_record["id"]
    assert changed_package["id"] != first_package["id"]
