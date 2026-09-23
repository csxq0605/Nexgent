"""Pure compiler for task-authored model-context service providers.

This module only validates source and produces content-addressed records. It
does not execute, persist, mount, or activate a provider. ``model_context.v1``
is deliberately narrow: a provider may transform the JSON payload visible to
one model request, but it cannot change the prompt, role, provider, budget, or
call host capabilities. When the original model payload is an object, the
provider may add fields but must preserve its existing top-level fields.
"""

from __future__ import annotations

import ast
from copy import deepcopy
import json
import re

from ..kernel.programs import ProgramError, digest, validate_source
from .packages import PackageError, make_package, split_ref, verify_package
from .tools import ContractError


DEFINITION_SCHEMA = "nexgent.service-definition.v1"
DEFINITION_VERSION = 1
SERVICE_INTERFACE = "model_context.v1"
SERVICE_SLOT = SERVICE_INTERFACE
RUNTIME = "controlled-python-v1"

MODEL_CONTEXT_INPUT_SCHEMA = {
    "type": "object",
    "required": ["schema", "role", "node_id", "payload"],
    "properties": {
        "schema": {"const": "nexgent.model-context-request.v1"},
        "role": {"type": "string", "minLength": 1, "maxLength": 100},
        "node_id": {"type": "string", "minLength": 1, "maxLength": 500},
        "payload": {},
    },
    "additionalProperties": False,
}
MODEL_CONTEXT_OUTPUT_SCHEMA = {
    "type": "object",
    "required": ["payload", "annotations"],
    "properties": {
        "payload": {},
        "annotations": {
            "type": "object",
            "maxProperties": 64,
        },
    },
    "additionalProperties": False,
}

_NAME = re.compile(r"[A-Za-z][A-Za-z0-9_.-]{0,119}")
_ENTRY_PATH = "service.py"
_ORIGIN_PATH = "origin.json"
_ENTRY_FUNCTION = "provide"
_ENTRY = f"{_ENTRY_PATH}:{_ENTRY_FUNCTION}"
_PROPOSAL_FIELDS = {"name", "description", "source"}
_DEFINITION_FIELDS = {
    "schema", "version", "id", "digest", "name", "description", "kind",
    "effect_class", "service_interface", "service_slot", "input_schema",
    "output_schema", "declared_operations", "credential_handles",
    "origin_episode_id", "package_id", "package_digest", "entry",
    "bundle_digest", "entry_digest", "dependency_lock", "runtime",
}


class ServiceDefinitionError(ContractError):
    """A model-context service proposal or persisted definition is invalid."""


def _finite_json(value, label):
    try:
        return json.loads(json.dumps(value, ensure_ascii=False, allow_nan=False))
    except (TypeError, ValueError, RecursionError) as exc:
        raise ServiceDefinitionError(f"{label} must be finite JSON: {exc}") from None


def _origin(value):
    if not isinstance(value, str) or not value or len(value) > 120:
        raise ServiceDefinitionError(
            "origin_episode_id must be a bounded nonempty string")
    return value


def _validate_source(source):
    try:
        tree = validate_source(source, _ENTRY_PATH)
    except (ProgramError, RecursionError) as exc:
        raise ServiceDefinitionError(str(exc)) from None
    entries = [node for node in tree.body
               if isinstance(node, ast.FunctionDef)
               and node.name == _ENTRY_FUNCTION]
    if len(entries) != 1:
        raise ServiceDefinitionError(
            "Model-context source must define provide exactly once")
    args = entries[0].args
    if (args.posonlyargs or len(args.args) != 2
            or [argument.arg for argument in args.args] != ["payload", "context"]
            or args.vararg is not None or args.kwarg is not None
            or args.kwonlyargs or args.defaults or args.kw_defaults):
        raise ServiceDefinitionError(
            "Model-context entrypoint must have the exact signature "
            "provide(payload, context)")
    if any(isinstance(node, ast.Name) and node.id == "context"
           and isinstance(node.ctx, ast.Load) for node in ast.walk(tree)):
        raise ServiceDefinitionError(
            "Pure model-context source cannot use context")


def _proposal(value):
    proposal = _finite_json(value, "Model-context service proposal")
    if not isinstance(proposal, dict) or set(proposal) != _PROPOSAL_FIELDS:
        raise ServiceDefinitionError(
            "Model-context service proposal has an invalid envelope")
    if (not isinstance(proposal["name"], str)
            or _NAME.fullmatch(proposal["name"]) is None):
        raise ServiceDefinitionError(
            "Service name must be a bounded logical identifier")
    if (not isinstance(proposal["description"], str)
            or len(proposal["description"]) > 5000):
        raise ServiceDefinitionError("Service description must be bounded text")
    if not isinstance(proposal["source"], str) or not proposal["source"].strip():
        raise ServiceDefinitionError("Service source must be nonempty text")
    _validate_source(proposal["source"])
    return proposal


def _identity(content):
    record_digest = digest(content)
    return "service-definition-" + record_digest[:24], record_digest


def build_model_context_definition(proposal, origin_episode_id):
    """Return ``(definition, package)`` without executing or storing either."""
    proposal = _proposal(proposal)
    origin_episode_id = _origin(origin_episode_id)
    origin = {
        "episode_id": origin_episode_id,
        "service_interface": SERVICE_INTERFACE,
    }
    try:
        package = make_package(
            {
                _ENTRY_PATH: proposal["source"],
                _ORIGIN_PATH: json.dumps(
                    origin, sort_keys=True, separators=(",", ":")),
            },
            {"entries": {"execute": _ENTRY}},
            provenance={
                "task_time_only": True,
                "promotion_authority": False,
                "episode_id": origin_episode_id,
            },
        )
    except (PackageError, ProgramError, RecursionError) as exc:
        raise ServiceDefinitionError(str(exc)) from None

    content = {
        "schema": DEFINITION_SCHEMA,
        "version": DEFINITION_VERSION,
        "name": proposal["name"],
        "description": proposal["description"],
        "kind": "service_provider",
        "effect_class": "model_context",
        "service_interface": SERVICE_INTERFACE,
        "service_slot": SERVICE_SLOT,
        "input_schema": deepcopy(MODEL_CONTEXT_INPUT_SCHEMA),
        "output_schema": deepcopy(MODEL_CONTEXT_OUTPUT_SCHEMA),
        "declared_operations": [],
        "credential_handles": [],
        "origin_episode_id": origin_episode_id,
        "package_id": package["id"],
        "package_digest": package["digest"],
        "entry": _ENTRY,
        "bundle_digest": package["digest"],
        "entry_digest": package["component_digests"][_ENTRY_PATH],
        "dependency_lock": [],
        "runtime": RUNTIME,
    }
    definition_id, record_digest = _identity(content)
    record = {**content, "id": definition_id, "digest": record_digest}
    verify_model_context_definition(record, package)
    return record, package


def verify_model_context_definition(record, package):
    """Verify one definition and its exact origin-bound controlled package."""
    if not isinstance(record, dict) or set(record) != _DEFINITION_FIELDS:
        raise ServiceDefinitionError("Invalid service Definition schema")
    try:
        verify_package(package)
    except (PackageError, ProgramError, RecursionError, KeyError, TypeError) as exc:
        raise ServiceDefinitionError(
            f"Invalid service package: {str(exc)[:500]}") from None

    content = {key: deepcopy(value) for key, value in record.items()
               if key not in {"id", "digest"}}
    try:
        definition_id, record_digest = _identity(content)
    except (TypeError, ValueError, RecursionError) as exc:
        raise ServiceDefinitionError(
            f"Service Definition must be finite JSON: {exc}") from None
    if record["id"] != definition_id or record["digest"] != record_digest:
        raise ServiceDefinitionError("Service Definition identity mismatch")
    if (record["schema"] != DEFINITION_SCHEMA
            or record["version"] != DEFINITION_VERSION
            or record["kind"] != "service_provider"
            or record["effect_class"] != "model_context"
            or record["service_interface"] != SERVICE_INTERFACE
            or record["service_slot"] != SERVICE_SLOT
            or record["input_schema"] != MODEL_CONTEXT_INPUT_SCHEMA
            or record["output_schema"] != MODEL_CONTEXT_OUTPUT_SCHEMA
            or record["declared_operations"] != []
            or record["credential_handles"] != []
            or record["dependency_lock"] != []
            or record["runtime"] != RUNTIME):
        raise ServiceDefinitionError("Service Definition contract is invalid")
    if (not isinstance(record["name"], str)
            or _NAME.fullmatch(record["name"]) is None):
        raise ServiceDefinitionError(
            "Service name must be a bounded logical identifier")
    if (not isinstance(record["description"], str)
            or len(record["description"]) > 5000):
        raise ServiceDefinitionError("Service description must be bounded text")
    _origin(record["origin_episode_id"])

    expected_provenance = {
        "task_time_only": True,
        "promotion_authority": False,
        "episode_id": record["origin_episode_id"],
    }
    if package["provenance"] != expected_provenance:
        raise ServiceDefinitionError(
            "Service package provenance does not match its Definition")
    expected_origin = json.dumps(
        {
            "episode_id": record["origin_episode_id"],
            "service_interface": SERVICE_INTERFACE,
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    if package["files"].get(_ORIGIN_PATH) != expected_origin:
        raise ServiceDefinitionError(
            "Service package content is not scoped to its origin and interface")
    if (record["package_id"] != package["id"]
            or record["package_digest"] != package["digest"]
            or record["bundle_digest"] != package["digest"]
            or record["entry"] != _ENTRY
            or package["manifest"] != {"entries": {"execute": _ENTRY}}):
        raise ServiceDefinitionError(
            "Service package binding does not match its Definition")
    try:
        entry_path, entry_function = split_ref(
            record["entry"], package["files"])
    except (PackageError, RecursionError) as exc:
        raise ServiceDefinitionError(str(exc)) from None
    if entry_path != _ENTRY_PATH or entry_function != _ENTRY_FUNCTION:
        raise ServiceDefinitionError("Service Definition has an invalid entry binding")
    if record["entry_digest"] != package["component_digests"].get(entry_path):
        raise ServiceDefinitionError(
            "Service entry digest does not match its package")
    _validate_source(package["files"][entry_path])
    return record


# Integration-facing generic names. This version has exactly one service ABI.
build_service_definition = build_model_context_definition
verify_service_definition = verify_model_context_definition


__all__ = [
    "DEFINITION_SCHEMA", "DEFINITION_VERSION", "MODEL_CONTEXT_INPUT_SCHEMA",
    "MODEL_CONTEXT_OUTPUT_SCHEMA", "RUNTIME", "SERVICE_INTERFACE",
    "SERVICE_SLOT", "ServiceDefinitionError", "build_model_context_definition",
    "build_service_definition", "verify_model_context_definition",
    "verify_service_definition",
]
