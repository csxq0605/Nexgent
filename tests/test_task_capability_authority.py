from copy import deepcopy

import pytest

from nexgent.kernel.programs import digest
from nexgent.tasks.capability_authority import (
    AUTHORITY_SCHEMA,
    AUTHORITY_SCHEMA_V2,
    make_authority,
    make_episode_authority,
    require_definition_authorized,
    require_delegated_authority,
    validate_authority,
    validate_episode_authority,
)
from nexgent.tasks.tools import ContractError


def authority(**changes):
    values = {
        "allowed_kinds": ["tool"],
        "allowed_effects": ["local_compute"],
        "allowed_operations": ["artifact.read", "table.sort"],
        "max_definitions": 8,
        "max_invocations": 40,
    }
    values.update(changes)
    return make_authority(**values)


def test_authority_is_canonical_content_bound_and_name_independent():
    record = make_authority(
        {"tool"}, {"local_compute"}, {"table.sort", "artifact.read"},
        max_definitions=8, max_invocations=40,
    )

    assert record["schema"] == AUTHORITY_SCHEMA
    assert record["version"] == 1
    assert record["allowed_operations"] == ["artifact.read", "table.sort"]
    assert record["digest"] == digest({
        key: value for key, value in record.items() if key != "digest"
    })
    assert validate_authority(record) == record
    assert make_episode_authority(["tool"], ["local_compute"])["schema"] == (
        AUTHORITY_SCHEMA)
    assert validate_episode_authority(record) == record

    # Neither name had to be predicted or frozen in the Episode authority.
    for newly_created_logical_name in (
            "model.created.normalize_rows", "another.unseen.tool"):
        assert newly_created_logical_name not in repr(record)
        require_definition_authorized(
            record, "tool", "local_compute", ["table.sort"], [])


@pytest.mark.parametrize("mutation", [
    lambda value: value.__setitem__("max_invocations", 41),
    lambda value: value["allowed_operations"].append("artifact.write"),
    lambda value: value.__setitem__("unexpected", True),
    lambda value: value.__setitem__("digest", "0" * 64),
])
def test_validate_authority_rejects_tampering_and_extra_fields(mutation):
    record = authority()
    mutation(record)
    with pytest.raises(ContractError):
        validate_authority(record)


def test_definition_authorization_rejects_every_widening_dimension():
    record = authority()
    require_definition_authorized(
        record, "tool", "local_compute", ["artifact.read"], [])

    cases = [
        ("service", "local_compute", [], []),
        ("tool", "external_compute", [], []),
        ("tool", "local_compute", ["artifact.write"], []),
        ("tool", "local_compute", [], ["secret.production"]),
    ]
    for kind, effect, operations, handles in cases:
        with pytest.raises(ContractError):
            require_definition_authorized(
                record, kind, effect, operations, handles)


def test_v1_fails_closed_outside_controlled_local_tool_slice():
    with pytest.raises(ContractError, match="tool"):
        make_authority(["service"], ["local_compute"])
    with pytest.raises(ContractError, match="local_compute"):
        make_authority(["tool"], ["external_compute"])
    with pytest.raises(ContractError, match="credential"):
        make_authority(
            ["tool"], ["local_compute"], credential_handles=["secret.one"])
    with pytest.raises(ContractError, match="runtime"):
        make_authority(
            ["tool"], ["local_compute"], runtime="host-python-v1")


def test_v2_explicitly_authorizes_tools_and_model_context_services():
    record = make_authority(
        ["service_provider", "tool"],
        ["model_context", "local_compute"],
        version=2,
    )

    assert record["schema"] == AUTHORITY_SCHEMA_V2
    assert record["version"] == 2
    assert validate_authority(record) == record
    require_definition_authorized(
        record, "service_provider", "model_context", [], [])
    require_definition_authorized(record, "tool", "local_compute", [], [])

    # Separate set membership cannot authorize a cross-product pair.
    with pytest.raises(ContractError, match="pair"):
        require_definition_authorized(
            record, "service_provider", "local_compute", [], [])


def test_v2_rejects_incoherent_or_unimplemented_service_authority():
    with pytest.raises(ContractError, match="must grant"):
        make_authority(["service_provider"], ["local_compute"], version=2)
    with pytest.raises(ContractError, match="effect"):
        make_authority(
            ["service_provider"], ["external_context"], version=2)
    with pytest.raises(ContractError, match="credential"):
        make_authority(
            ["service_provider"], ["model_context"],
            credential_handles=["secret.one"], version=2)


def test_authority_schema_and_version_must_match_exactly():
    record = make_authority(
        ["service_provider"], ["model_context"], version=2)
    record["schema"] = AUTHORITY_SCHEMA
    payload = {key: value for key, value in record.items() if key != "digest"}
    record["digest"] = digest(payload)
    with pytest.raises(ContractError, match="schema or version"):
        validate_authority(record)


def test_delegation_allows_only_subsets_and_nonincreasing_limits():
    parent = authority()
    child = authority(
        allowed_operations=["artifact.read"],
        max_definitions=2,
        max_invocations=12,
    )
    assert require_delegated_authority(parent, child) == child

    widenings = [
        {"allowed_operations": ["artifact.read", "network.get"]},
        {"max_definitions": 9},
        {"max_invocations": 41},
    ]
    for changes in widenings:
        delegated = deepcopy(child)
        delegated.update(changes)
        payload = {key: value for key, value in delegated.items()
                   if key != "digest"}
        delegated["digest"] = digest(payload)
        with pytest.raises(ContractError, match="widens"):
            require_delegated_authority(parent, delegated)


def test_v2_parent_may_delegate_v1_but_v1_parent_cannot_delegate_v2():
    parent_v2 = make_authority(
        ["service_provider", "tool"],
        ["model_context", "local_compute"],
        max_definitions=8,
        max_invocations=40,
        version=2,
    )
    child_v1 = authority(
        allowed_operations=[], max_definitions=2, max_invocations=10)
    assert require_delegated_authority(parent_v2, child_v1) == child_v1

    with pytest.raises(ContractError, match="contract version"):
        require_delegated_authority(child_v1, parent_v2)


def test_malformed_authority_values_are_rejected():
    with pytest.raises(ContractError):
        make_authority(["tool", "tool"], ["local_compute"])
    with pytest.raises(ContractError):
        make_authority(["tool"], ["local_compute"], max_definitions=True)

    record = authority()
    record["allowed_operations"] = list(reversed(record["allowed_operations"]))
    payload = {key: value for key, value in record.items() if key != "digest"}
    record["digest"] = digest(payload)
    with pytest.raises(ContractError, match="canonical"):
        validate_authority(record)
