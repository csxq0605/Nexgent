"""Pure Episode capability-authority contracts.

An authority freezes capability classes and effects, never logical capability
names. Version 1 remains the original local-compute tool slice. Version 2 adds
one separate pure service-provider interface: ``model_context.v1``. Persisted
v1 Episodes remain readable without silently acquiring v2 authority.
"""

from __future__ import annotations

import re

from ..kernel.programs import digest
from .tools import ContractError


AUTHORITY_SCHEMA_V1 = "nexgent.episode-authority.v1"
AUTHORITY_SCHEMA_V2 = "nexgent.episode-authority.v2"

# Compatibility names continue to identify the original contract. Callers opt
# into v2 explicitly with ``version=2``.
AUTHORITY_SCHEMA = AUTHORITY_SCHEMA_V1
AUTHORITY_VERSION = 1
LATEST_AUTHORITY_VERSION = 2
CONTROLLED_RUNTIME = "controlled-python-v1"

DEFAULT_MAX_DEFINITIONS = 32
DEFAULT_MAX_INVOCATIONS = 1_000

_SCHEMAS = {1: AUTHORITY_SCHEMA_V1, 2: AUTHORITY_SCHEMA_V2}
_FIELDS = {
    "schema", "version", "allowed_kinds", "allowed_effects",
    "allowed_operations", "credential_handles", "runtime",
    "max_definitions", "max_invocations", "digest",
}
_IDENTIFIER = re.compile(r"[a-z][a-z0-9_.:/-]{0,127}")
_DIGEST = re.compile(r"[0-9a-f]{64}")
_V2_PAIRS = {
    ("tool", "local_compute"),
    ("service_provider", "model_context"),
}


def _items(value, label, *, record=False):
    """Validate and canonicalize one set-like JSON authority field."""
    valid_container = type(value) is list if record else type(value) in {
        list, tuple, set, frozenset,
    }
    if not valid_container or len(value) > 256:
        raise ContractError(f"Episode authority {label} must be a bounded list")
    if any(type(item) is not str or _IDENTIFIER.fullmatch(item) is None
           for item in value):
        raise ContractError(
            f"Episode authority {label} must contain bounded identifiers")
    if len(set(value)) != len(value):
        raise ContractError(f"Episode authority {label} must be unique")
    canonical = sorted(value)
    if record and value != canonical:
        raise ContractError(f"Episode authority {label} is not canonical")
    return canonical


def _limit(value, label):
    if type(value) is not int or value < 0:
        raise ContractError(
            f"Episode authority {label} must be a nonnegative integer")
    return value


def _payload(*, version, allowed_kinds, allowed_effects, allowed_operations,
             credential_handles, runtime, max_definitions, max_invocations):
    schema = _SCHEMAS.get(version)
    if schema is None:
        raise ContractError("Episode authority version is unsupported")
    return {
        "schema": schema,
        "version": version,
        "allowed_kinds": allowed_kinds,
        "allowed_effects": allowed_effects,
        "allowed_operations": allowed_operations,
        "credential_handles": credential_handles,
        "runtime": runtime,
        "max_definitions": max_definitions,
        "max_invocations": max_invocations,
    }


def _require_common_slice(payload):
    if payload["runtime"] != CONTROLLED_RUNTIME:
        raise ContractError(
            f"Episode authority runtime is not supported by v{payload['version']}")
    if payload["credential_handles"]:
        raise ContractError(
            f"Episode authority v{payload['version']} does not permit credential handles")


def _require_v1_slice(payload):
    """Fail closed around the original controlled-Python tool slice."""
    _require_common_slice(payload)
    if not set(payload["allowed_kinds"]).issubset({"tool"}):
        raise ContractError("Episode authority v1 only permits tool capabilities")
    if not set(payload["allowed_effects"]).issubset({"local_compute"}):
        raise ContractError(
            "Episode authority v1 only permits the local_compute effect")


def _require_v2_slice(payload):
    """Bound v2 to the two implemented pure capability/effect pairs."""
    _require_common_slice(payload)
    kinds = set(payload["allowed_kinds"])
    effects = set(payload["allowed_effects"])
    if not kinds.issubset({kind for kind, _ in _V2_PAIRS}):
        raise ContractError("Episode authority v2 has an unsupported capability kind")
    if not effects.issubset({effect for _, effect in _V2_PAIRS}):
        raise ContractError("Episode authority v2 has an unsupported capability effect")
    # Separate dimensions must not create an unintended cross-product grant.
    for kind, effect in _V2_PAIRS:
        if (kind in kinds) != (effect in effects):
            raise ContractError(
                f"Episode authority v2 must grant {kind} with {effect}")


def _require_supported_slice(payload):
    if payload["version"] == 1:
        _require_v1_slice(payload)
    elif payload["version"] == 2:
        _require_v2_slice(payload)
    else:
        raise ContractError("Episode authority version is unsupported")


def make_authority(
        allowed_kinds,
        allowed_effects,
        allowed_operations=(),
        credential_handles=(),
        runtime=CONTROLLED_RUNTIME,
        max_definitions=DEFAULT_MAX_DEFINITIONS,
        max_invocations=DEFAULT_MAX_INVOCATIONS,
        *, version=AUTHORITY_VERSION):
    """Create a canonical, content-bound EpisodeAuthority v1 or v2 record."""
    if type(version) is not int or version not in _SCHEMAS:
        raise ContractError("Episode authority version is unsupported")
    if type(runtime) is not str or _IDENTIFIER.fullmatch(runtime) is None:
        raise ContractError("Episode authority runtime must be a bounded identifier")
    payload = _payload(
        version=version,
        allowed_kinds=_items(allowed_kinds, "allowed_kinds"),
        allowed_effects=_items(allowed_effects, "allowed_effects"),
        allowed_operations=_items(allowed_operations, "allowed_operations"),
        credential_handles=_items(credential_handles, "credential_handles"),
        runtime=runtime,
        max_definitions=_limit(max_definitions, "max_definitions"),
        max_invocations=_limit(max_invocations, "max_invocations"),
    )
    _require_supported_slice(payload)
    return {**payload, "digest": digest(payload)}


def validate_authority(record):
    """Validate an exact canonical authority envelope and its digest."""
    if type(record) is not dict or set(record) != _FIELDS:
        raise ContractError("Episode authority has an invalid envelope")
    version = record.get("version")
    if (type(version) is not int or version not in _SCHEMAS
            or record.get("schema") != _SCHEMAS[version]):
        raise ContractError("Episode authority schema or version is unsupported")
    if type(record["runtime"]) is not str or _IDENTIFIER.fullmatch(
            record["runtime"]) is None:
        raise ContractError("Episode authority runtime must be a bounded identifier")
    payload = _payload(
        version=version,
        allowed_kinds=_items(record["allowed_kinds"], "allowed_kinds", record=True),
        allowed_effects=_items(
            record["allowed_effects"], "allowed_effects", record=True),
        allowed_operations=_items(
            record["allowed_operations"], "allowed_operations", record=True),
        credential_handles=_items(
            record["credential_handles"], "credential_handles", record=True),
        runtime=record["runtime"],
        max_definitions=_limit(record["max_definitions"], "max_definitions"),
        max_invocations=_limit(record["max_invocations"], "max_invocations"),
    )
    _require_supported_slice(payload)
    if type(record["digest"]) is not str or _DIGEST.fullmatch(
            record["digest"]) is None or record["digest"] != digest(payload):
        raise ContractError("Episode authority digest mismatch")
    return {**payload, "digest": record["digest"]}


def require_definition_authorized(
        authority, kind, effect_class, declared_operations=(),
        credential_handles=()):
    """Reject a capability definition that widens its Episode authority."""
    authority = validate_authority(authority)
    if type(kind) is not str or kind not in authority["allowed_kinds"]:
        raise ContractError("Capability kind is outside Episode authority")
    if (type(effect_class) is not str
            or effect_class not in authority["allowed_effects"]):
        raise ContractError("Capability effect is outside Episode authority")
    if authority["version"] == 2 and (kind, effect_class) not in _V2_PAIRS:
        raise ContractError("Capability kind/effect pair is unsupported by authority v2")
    operations = _items(declared_operations, "declared_operations")
    handles = _items(credential_handles, "definition credential_handles")
    if not set(operations).issubset(authority["allowed_operations"]):
        raise ContractError("Capability operations widen Episode authority")
    if not set(handles).issubset(authority["credential_handles"]):
        raise ContractError("Capability credentials widen Episode authority")
    return authority


def require_delegated_authority(parent, child):
    """Reject delegation that changes runtime or expands any parent grant."""
    parent = validate_authority(parent)
    child = validate_authority(child)
    if child["version"] > parent["version"]:
        raise ContractError("Delegated authority widens the contract version")
    if child["runtime"] != parent["runtime"]:
        raise ContractError("Delegated authority cannot change runtime")
    for field in (
            "allowed_kinds", "allowed_effects", "allowed_operations",
            "credential_handles"):
        if not set(child[field]).issubset(parent[field]):
            raise ContractError(f"Delegated authority widens {field}")
    for field in ("max_definitions", "max_invocations"):
        if child[field] > parent[field]:
            raise ContractError(f"Delegated authority widens {field}")
    return child


make_episode_authority = make_authority
validate_episode_authority = validate_authority


__all__ = [
    "AUTHORITY_SCHEMA", "AUTHORITY_SCHEMA_V1", "AUTHORITY_SCHEMA_V2",
    "AUTHORITY_VERSION", "LATEST_AUTHORITY_VERSION", "CONTROLLED_RUNTIME",
    "DEFAULT_MAX_DEFINITIONS", "DEFAULT_MAX_INVOCATIONS", "make_authority",
    "make_episode_authority", "require_definition_authorized",
    "require_delegated_authority", "validate_authority",
    "validate_episode_authority",
]
