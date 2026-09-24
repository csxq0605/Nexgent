"""Portable, content-addressed releases for task-authored capabilities.

A :class:`CapabilityRelease` is evidence that an origin-bound Definition can
be considered for later adoption.  It is deliberately inert: it grants no
Episode authority, creates no Instance, and carries no deployment status.
Selection, promotion, and fresh-Episode materialization are separate host
operations.

The first release contract covers only the two pure capability slices already
implemented by the task runtime: ``tool/local_compute`` and the
``service_provider/model_context`` interface ``model_context.v1``.
"""

from __future__ import annotations

from copy import deepcopy
import json

from ..kernel.programs import digest
from .capability_definitions import (
    build_tool_definition,
    verify_tool_definition,
)
from .packages import split_ref
from .service_definitions import (
    SERVICE_INTERFACE,
    SERVICE_SLOT,
    build_model_context_definition,
    verify_model_context_definition,
)
from .tools import ContractError


RELEASE_SCHEMA = "nexgent.capability-release.v1"
RELEASE_VERSION = 1

_RELEASE_FIELDS = {
    "schema", "version", "id", "digest", "kind", "name", "description",
    "effect_class", "interface", "input_schema", "output_schema", "source",
    "source_digest", "runtime", "dependency_lock", "authority_requirements",
    "creator",
}
_CREATOR_FIELDS = {
    "episode_id", "definition_schema", "definition_version", "definition_id",
    "definition_digest", "package_id", "package_digest", "bundle_digest",
    "entry", "entry_digest",
}
_AUTHORITY_FIELDS = {
    "minimum_version", "kind", "effect_class", "declared_operations",
    "credential_handles", "runtime",
}


class CapabilityReleaseError(ContractError):
    """A portable capability release is malformed or has broken lineage."""


def _finite_json(value, label):
    try:
        return json.loads(json.dumps(
            value, ensure_ascii=False, allow_nan=False,
        ))
    except (TypeError, ValueError, RecursionError) as exc:
        raise CapabilityReleaseError(
            f"{label} must be finite JSON: {str(exc)[:500]}") from None


def _identity(content):
    record_digest = digest(content)
    return "capability-release-" + record_digest[:24], record_digest


def _interface(definition):
    if definition["kind"] == "tool":
        return {
            "type": "tool",
            "version": definition["interface_version"],
            "entry_function": "execute",
        }
    return {
        "type": "service_provider",
        "name": definition["service_interface"],
        "slot": definition["service_slot"],
        "entry_function": "provide",
    }


def _authority_requirements(definition):
    return {
        # This is a requirement descriptor, not an EpisodeAuthority.  It has
        # no authority digest, budgets, or grant identity.
        "minimum_version": 1 if definition["kind"] == "tool" else 2,
        "kind": definition["kind"],
        "effect_class": definition["effect_class"],
        "declared_operations": deepcopy(definition["declared_operations"]),
        "credential_handles": deepcopy(definition["credential_handles"]),
        "runtime": definition["runtime"],
    }


def _creator(definition):
    return {
        "episode_id": definition["origin_episode_id"],
        "definition_schema": definition["schema"],
        "definition_version": definition["version"],
        "definition_id": definition["id"],
        "definition_digest": definition["digest"],
        "package_id": definition["package_id"],
        "package_digest": definition["package_digest"],
        "bundle_digest": definition["bundle_digest"],
        "entry": definition["entry"],
        "entry_digest": definition["entry_digest"],
    }


def build_capability_release(definition, package):
    """Build an inert portable release from one verified task Definition.

    The returned record contains the pure source and public contract needed to
    reproduce a fresh origin-bound Definition later.  It does not authorize
    that later operation and does not make the source package deployable.
    """
    try:
        kind = definition.get("kind") if isinstance(definition, dict) else None
        if kind == "tool":
            definition = deepcopy(verify_tool_definition(definition, package))
        elif kind == "service_provider":
            definition = deepcopy(
                verify_model_context_definition(definition, package))
        else:
            raise CapabilityReleaseError(
                "Capability release supports only tool or service_provider Definitions")
        entry_path, entry_function = split_ref(
            definition["entry"], package["files"])
        expected_function = "execute" if kind == "tool" else "provide"
        if entry_function != expected_function:
            raise CapabilityReleaseError(
                "Capability release Definition entry function is unsupported")
        source = package["files"][entry_path]
    except CapabilityReleaseError:
        raise
    except Exception as exc:
        raise CapabilityReleaseError(
            f"Capability release source Definition is invalid: {str(exc)[:500]}") from None

    content = {
        "schema": RELEASE_SCHEMA,
        "version": RELEASE_VERSION,
        "kind": kind,
        "name": definition["name"],
        "description": definition["description"],
        "effect_class": definition["effect_class"],
        "interface": _interface(definition),
        "input_schema": deepcopy(definition["input_schema"]),
        "output_schema": deepcopy(definition["output_schema"]),
        "source": source,
        "source_digest": digest(source),
        "runtime": definition["runtime"],
        "dependency_lock": deepcopy(definition["dependency_lock"]),
        "authority_requirements": _authority_requirements(definition),
        "creator": _creator(definition),
    }
    release_id, record_digest = _identity(content)
    record = {**content, "id": release_id, "digest": record_digest}
    return verify_capability_release(record)


def _rebuild(record):
    creator = record["creator"]
    if record["kind"] == "tool":
        proposal = {
            "name": record["name"],
            "description": record["description"],
            "source": record["source"],
            "input_schema": deepcopy(record["input_schema"]),
            "output_schema": deepcopy(record["output_schema"]),
        }
        return build_tool_definition(proposal, creator["episode_id"])
    proposal = {
        "name": record["name"],
        "description": record["description"],
        "source": record["source"],
    }
    return build_model_context_definition(proposal, creator["episode_id"])


def verify_capability_release(record):
    """Verify release identity, pure contract, and creator Definition lineage."""
    record = _finite_json(record, "CapabilityRelease")
    if not isinstance(record, dict) or set(record) != _RELEASE_FIELDS:
        raise CapabilityReleaseError("CapabilityRelease has an invalid envelope")
    content = {
        key: deepcopy(value) for key, value in record.items()
        if key not in {"id", "digest"}
    }
    release_id, record_digest = _identity(content)
    if record["id"] != release_id or record["digest"] != record_digest:
        raise CapabilityReleaseError("CapabilityRelease identity mismatch")
    if record["schema"] != RELEASE_SCHEMA or record["version"] != RELEASE_VERSION:
        raise CapabilityReleaseError("CapabilityRelease schema or version is unsupported")
    if record["kind"] not in {"tool", "service_provider"}:
        raise CapabilityReleaseError("CapabilityRelease kind is unsupported")
    if not isinstance(record["creator"], dict) or set(record["creator"]) != _CREATOR_FIELDS:
        raise CapabilityReleaseError("CapabilityRelease creator lineage is invalid")
    requirements = record["authority_requirements"]
    if not isinstance(requirements, dict) or set(requirements) != _AUTHORITY_FIELDS:
        raise CapabilityReleaseError(
            "CapabilityRelease authority requirements are invalid")
    if not isinstance(record["source"], str) or not record["source"].strip():
        raise CapabilityReleaseError("CapabilityRelease source must be nonempty text")
    if record["source_digest"] != digest(record["source"]):
        raise CapabilityReleaseError("CapabilityRelease source digest mismatch")

    try:
        definition, package = _rebuild(record)
    except Exception as exc:
        raise CapabilityReleaseError(
            f"CapabilityRelease source contract is invalid: {str(exc)[:500]}") from None

    expected_creator = _creator(definition)
    if record["creator"] != expected_creator:
        raise CapabilityReleaseError(
            "CapabilityRelease creator Definition lineage mismatch")
    entry_path, _ = split_ref(definition["entry"], package["files"])
    if package["files"][entry_path] != record["source"]:
        raise CapabilityReleaseError("CapabilityRelease source lineage mismatch")
    if record["name"] != definition["name"] or record["description"] != definition[
            "description"]:
        raise CapabilityReleaseError("CapabilityRelease public identity mismatch")
    if (record["effect_class"] != definition["effect_class"]
            or record["runtime"] != definition["runtime"]
            or record["dependency_lock"] != definition["dependency_lock"]
            or record["input_schema"] != definition["input_schema"]
            or record["output_schema"] != definition["output_schema"]):
        raise CapabilityReleaseError("CapabilityRelease executable contract mismatch")
    if record["interface"] != _interface(definition):
        raise CapabilityReleaseError("CapabilityRelease interface mismatch")
    if requirements != _authority_requirements(definition):
        raise CapabilityReleaseError(
            "CapabilityRelease authority requirements widen the source Definition")
    if record["kind"] == "service_provider" and (
            record["interface"].get("name") != SERVICE_INTERFACE
            or record["interface"].get("slot") != SERVICE_SLOT):
        raise CapabilityReleaseError("CapabilityRelease service interface is unsupported")
    return record


__all__ = [
    "CapabilityReleaseError", "RELEASE_SCHEMA", "RELEASE_VERSION",
    "build_capability_release", "verify_capability_release",
]
