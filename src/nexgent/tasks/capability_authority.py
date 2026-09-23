"""Pure Episode capability-authority contracts.

The authority freezes capability classes and resource scopes, never logical
capability names.  A definition can therefore introduce a previously unknown
name without acquiring effects, operations, credentials, or budget that the
Episode did not already possess.

Version 1 is deliberately the narrow controlled-Python slice: task-local tools
performing local computation, with no credential authority.  Additional
runtimes and capability kinds require a new schema version rather than being
accepted as inert strings by this validator.
"""

from __future__ import annotations

import re

from ..kernel.programs import digest
from .tools import ContractError


AUTHORITY_SCHEMA = "nexgent.episode-authority.v1"
AUTHORITY_VERSION = 1
CONTROLLED_RUNTIME = "controlled-python-v1"

DEFAULT_MAX_DEFINITIONS = 32
DEFAULT_MAX_INVOCATIONS = 1_000

_FIELDS = {
    "schema",
    "version",
    "allowed_kinds",
    "allowed_effects",
    "allowed_operations",
    "credential_handles",
    "runtime",
    "max_definitions",
    "max_invocations",
    "digest",
}
_IDENTIFIER = re.compile(r"[a-z][a-z0-9_.:/-]{0,127}")
_DIGEST = re.compile(r"[0-9a-f]{64}")


def _items(value, label, *, record=False):
    """Validate and canonicalize one set-like JSON authority field."""
    if record:
        valid_container = type(value) is list
    else:
        valid_container = type(value) in {list, tuple, set, frozenset}
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


def _payload(*, allowed_kinds, allowed_effects, allowed_operations,
             credential_handles, runtime, max_definitions, max_invocations):
    return {
        "schema": AUTHORITY_SCHEMA,
        "version": AUTHORITY_VERSION,
        "allowed_kinds": allowed_kinds,
        "allowed_effects": allowed_effects,
        "allowed_operations": allowed_operations,
        "credential_handles": credential_handles,
        "runtime": runtime,
        "max_definitions": max_definitions,
        "max_invocations": max_invocations,
    }


def _require_v1_slice(payload):
    """Fail closed around the only execution boundary implemented by C1."""
    if payload["runtime"] != CONTROLLED_RUNTIME:
        raise ContractError("Episode authority runtime is not supported by v1")
    if not set(payload["allowed_kinds"]).issubset({"tool"}):
        raise ContractError("Episode authority v1 only permits tool capabilities")
    if not set(payload["allowed_effects"]).issubset({"local_compute"}):
        raise ContractError(
            "Episode authority v1 only permits the local_compute effect")
    if payload["credential_handles"]:
        raise ContractError(
            "Episode authority v1 does not permit credential handles")


def make_authority(
        allowed_kinds,
        allowed_effects,
        allowed_operations=(),
        credential_handles=(),
        runtime=CONTROLLED_RUNTIME,
        max_definitions=DEFAULT_MAX_DEFINITIONS,
        max_invocations=DEFAULT_MAX_INVOCATIONS):
    """Create a canonical, content-bound EpisodeAuthority v1 record."""
    if type(runtime) is not str or _IDENTIFIER.fullmatch(runtime) is None:
        raise ContractError("Episode authority runtime must be a bounded identifier")
    payload = _payload(
        allowed_kinds=_items(allowed_kinds, "allowed_kinds"),
        allowed_effects=_items(allowed_effects, "allowed_effects"),
        allowed_operations=_items(allowed_operations, "allowed_operations"),
        credential_handles=_items(credential_handles, "credential_handles"),
        runtime=runtime,
        max_definitions=_limit(max_definitions, "max_definitions"),
        max_invocations=_limit(max_invocations, "max_invocations"),
    )
    _require_v1_slice(payload)
    return {**payload, "digest": digest(payload)}


def validate_authority(record):
    """Validate an exact canonical authority envelope and its digest."""
    if type(record) is not dict or set(record) != _FIELDS:
        raise ContractError("Episode authority has an invalid envelope")
    if (record["schema"] != AUTHORITY_SCHEMA
            or record["version"] != AUTHORITY_VERSION):
        raise ContractError("Episode authority schema or version is unsupported")
    if type(record["runtime"]) is not str or _IDENTIFIER.fullmatch(
            record["runtime"]) is None:
        raise ContractError("Episode authority runtime must be a bounded identifier")
    payload = _payload(
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
    _require_v1_slice(payload)
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


# Long-form names are the integration-facing API.  Keep the shorter names used
# by the design sketch as exact aliases so there is only one implementation and
# one record shape.
make_episode_authority = make_authority
validate_episode_authority = validate_authority


__all__ = [
    "AUTHORITY_SCHEMA",
    "AUTHORITY_VERSION",
    "CONTROLLED_RUNTIME",
    "DEFAULT_MAX_DEFINITIONS",
    "DEFAULT_MAX_INVOCATIONS",
    "make_authority",
    "make_episode_authority",
    "require_definition_authorized",
    "require_delegated_authority",
    "validate_authority",
    "validate_episode_authority",
]
