"""Pure compiler for task-authored local-compute tool definitions.

Compilation only validates and packages source.  It does not execute the
source, persist either object, or mutate an installed-tool registry.
"""

from __future__ import annotations

import ast
from copy import deepcopy
import json
import re

from jsonschema.exceptions import SchemaError

from ..kernel.programs import ProgramError, digest, validate_source
from .packages import PackageError, make_package, split_ref, verify_package
from .tools import ContractError, check_contract_schema


DEFINITION_SCHEMA = "nexgent.capability-definition.v1"
DEFINITION_VERSION = 1
INTERFACE_VERSION = 1
RUNTIME = "controlled-python-v1"

_NAME = re.compile(r"[A-Za-z][A-Za-z0-9_.-]{0,119}")
_ENTRY_PATH = "tool.py"
_ORIGIN_PATH = "origin.json"
_ENTRY_FUNCTION = "execute"
_ENTRY = f"{_ENTRY_PATH}:{_ENTRY_FUNCTION}"
_REQUIRED_PROPOSAL_FIELDS = {
    "name", "description", "source", "input_schema", "output_schema",
}
_REQUIRED_DEFINITION_FIELDS = {
    "schema", "version", "id", "digest", "name", "description", "kind",
    "effect_class", "input_schema", "output_schema", "declared_operations",
    "credential_handles", "interface_version", "origin_episode_id",
    "package_id", "package_digest", "entry", "bundle_digest", "entry_digest",
    "dependency_lock", "runtime",
}


class DefinitionError(ContractError):
    """A proposed or persisted capability definition is invalid."""


def _finite_json(value, label):
    try:
        return json.loads(json.dumps(value, ensure_ascii=False, allow_nan=False))
    except (TypeError, ValueError, RecursionError) as exc:
        raise DefinitionError(f"{label} must be finite JSON: {exc}") from None


def _validate_schema(schema, label):
    # Definitions are model-authored, and their schemas are evaluated in the
    # host during admission. Keep this first runtime slice to bounded,
    # non-recursive validation: regexes, references and branch combinators can
    # otherwise consume unbounded host CPU before the worker watchdog starts.
    allowed = {"type", "properties", "required", "additionalProperties",
               "items", "enum", "const", "minimum", "maximum",
               "exclusiveMinimum", "exclusiveMaximum", "minLength",
               "maxLength", "minItems", "maxItems", "minProperties",
               "maxProperties", "description"}
    pending = [(schema, 0)]
    nodes = 0
    while pending:
        current, depth = pending.pop()
        nodes += 1
        if nodes > 128 or depth > 12:
            raise DefinitionError(f"{label} exceeds the task-tool schema bound")
        if type(current) is bool:
            continue
        if not isinstance(current, dict) or set(current) - allowed:
            raise DefinitionError(f"{label} uses an unsupported task-tool schema keyword")
        properties = current.get("properties", {})
        if not isinstance(properties, dict) or len(properties) > 64:
            raise DefinitionError(f"{label} properties are not bounded")
        pending.extend((child, depth + 1) for child in properties.values())
        for key in ("additionalProperties", "items"):
            if key in current:
                pending.append((current[key], depth + 1))
        if ("enum" in current
                and (not isinstance(current["enum"], list)
                     or len(current["enum"]) > 64)):
            raise DefinitionError(f"{label} enum is not bounded")
    try:
        check_contract_schema(schema)
    except (ContractError, SchemaError, RecursionError) as exc:
        raise DefinitionError(f"{label} is invalid: {str(exc)[:500]}") from None


def _validate_entry_source(source):
    try:
        tree = validate_source(source, _ENTRY_PATH)
    except (ProgramError, RecursionError) as exc:
        raise DefinitionError(str(exc)) from None

    entries = [node for node in tree.body
               if isinstance(node, ast.FunctionDef) and node.name == _ENTRY_FUNCTION]
    if len(entries) != 1:
        raise DefinitionError("Tool source must define execute exactly once")
    args = entries[0].args
    if (args.posonlyargs or len(args.args) != 2
            or [argument.arg for argument in args.args] != ["payload", "context"]
            or args.vararg is not None or args.kwarg is not None
            or args.kwonlyargs or args.defaults or args.kw_defaults):
        raise DefinitionError(
            "Tool entrypoint must have the exact signature execute(payload, context)")

    # C1 tools are pure local computation.  The context parameter is retained
    # as the common runtime ABI, but this slice grants it no host operations.
    if any(isinstance(node, ast.Name) and node.id == "context"
           and isinstance(node.ctx, ast.Load) for node in ast.walk(tree)):
        raise DefinitionError("Pure local-compute tool source cannot use context")


def _proposal(value):
    proposal = _finite_json(value, "Tool definition proposal")
    if not isinstance(proposal, dict) or set(proposal) != _REQUIRED_PROPOSAL_FIELDS:
        raise DefinitionError("Tool definition proposal has an invalid envelope")
    name = proposal["name"]
    if not isinstance(name, str) or _NAME.fullmatch(name) is None:
        raise DefinitionError("Tool name must be a bounded logical identifier")
    description = proposal["description"]
    if not isinstance(description, str) or len(description) > 5000:
        raise DefinitionError("Tool description must be bounded text")
    source = proposal["source"]
    if not isinstance(source, str) or not source.strip():
        raise DefinitionError("Tool source must be nonempty text")
    _validate_schema(proposal["input_schema"], "Tool input schema")
    _validate_schema(proposal["output_schema"], "Tool output schema")
    _validate_entry_source(source)
    return proposal


def _origin(value):
    if not isinstance(value, str) or not value or len(value) > 120:
        raise DefinitionError("origin_episode_id must be a bounded nonempty string")
    return value


def _identity(content):
    record_digest = digest(content)
    return "definition-" + record_digest[:24], record_digest


def build_tool_definition(proposal, origin_episode_id):
    """Return ``(definition, package)`` without executing or storing either.

    ``proposal`` has exactly ``name``, ``description``, ``source``,
    ``input_schema`` and ``output_schema``.  The resulting AgentPackage is a
    root content-addressed bundle scoped by provenance to the origin Episode.
    """
    proposal = _proposal(proposal)
    origin_episode_id = _origin(origin_episode_id)
    try:
        package = make_package(
            {_ENTRY_PATH: proposal["source"],
             _ORIGIN_PATH: json.dumps({"episode_id": origin_episode_id},
                                      sort_keys=True, separators=(",", ":"))},
            {"entries": {_ENTRY_FUNCTION: _ENTRY}},
            provenance={
                "task_time_only": True,
                "promotion_authority": False,
                "episode_id": origin_episode_id,
            },
        )
    except (PackageError, ProgramError, RecursionError) as exc:
        raise DefinitionError(str(exc)) from None

    content = {
        "schema": DEFINITION_SCHEMA,
        "version": DEFINITION_VERSION,
        "name": proposal["name"],
        "description": proposal["description"],
        "kind": "tool",
        "effect_class": "local_compute",
        "input_schema": deepcopy(proposal["input_schema"]),
        "output_schema": deepcopy(proposal["output_schema"]),
        "declared_operations": [],
        "credential_handles": [],
        "interface_version": INTERFACE_VERSION,
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
    verify_tool_definition(record, package)
    return record, package


def verify_tool_definition(record, package):
    """Verify a Definition and its exact controlled AgentPackage bundle."""
    if not isinstance(record, dict) or set(record) != _REQUIRED_DEFINITION_FIELDS:
        raise DefinitionError("Invalid CapabilityDefinition schema")
    try:
        verify_package(package)
    except (PackageError, ProgramError, RecursionError, KeyError, TypeError) as exc:
        raise DefinitionError(f"Invalid tool package: {str(exc)[:500]}") from None

    content = {key: deepcopy(value) for key, value in record.items()
               if key not in {"id", "digest"}}
    try:
        definition_id, record_digest = _identity(content)
    except (TypeError, ValueError, RecursionError) as exc:
        raise DefinitionError(f"Definition must be finite JSON: {exc}") from None
    if record["id"] != definition_id or record["digest"] != record_digest:
        raise DefinitionError("CapabilityDefinition identity mismatch")
    if (record["schema"] != DEFINITION_SCHEMA
            or record["version"] != DEFINITION_VERSION
            or record["kind"] != "tool"
            or record["effect_class"] != "local_compute"
            or record["declared_operations"] != []
            or record["credential_handles"] != []
            or record["interface_version"] != INTERFACE_VERSION
            or record["dependency_lock"] != []
            or record["runtime"] != RUNTIME):
        raise DefinitionError("CapabilityDefinition contract is invalid")
    if not isinstance(record["name"], str) or _NAME.fullmatch(record["name"]) is None:
        raise DefinitionError("Tool name must be a bounded logical identifier")
    if not isinstance(record["description"], str) or len(record["description"]) > 5000:
        raise DefinitionError("Tool description must be bounded text")
    _origin(record["origin_episode_id"])
    _validate_schema(record["input_schema"], "Tool input schema")
    _validate_schema(record["output_schema"], "Tool output schema")

    expected_provenance = {
        "task_time_only": True,
        "promotion_authority": False,
        "episode_id": record["origin_episode_id"],
    }
    if package["provenance"] != expected_provenance:
        raise DefinitionError("Tool package provenance does not match its Definition")
    if package["files"].get(_ORIGIN_PATH) != json.dumps(
            {"episode_id": record["origin_episode_id"]},
            sort_keys=True, separators=(",", ":")):
        raise DefinitionError("Tool package content is not scoped to its origin")
    if (record["package_id"] != package["id"]
            or record["package_digest"] != package["digest"]
            or record["bundle_digest"] != package["digest"]
            or record["entry"] != _ENTRY
            or package["manifest"] != {"entries": {_ENTRY_FUNCTION: _ENTRY}}):
        raise DefinitionError("Tool package binding does not match its Definition")
    try:
        entry_path, entry_function = split_ref(record["entry"], package["files"])
    except (PackageError, RecursionError) as exc:
        raise DefinitionError(str(exc)) from None
    if entry_path != _ENTRY_PATH or entry_function != _ENTRY_FUNCTION:
        raise DefinitionError("Tool Definition has an invalid entry binding")
    if record["entry_digest"] != package["component_digests"].get(entry_path):
        raise DefinitionError("Tool entry digest does not match its package")
    _validate_entry_source(package["files"][entry_path])
    return record


__all__ = [
    "DEFINITION_SCHEMA", "DEFINITION_VERSION", "DefinitionError",
    "INTERFACE_VERSION", "RUNTIME", "build_tool_definition",
    "verify_tool_definition",
]
