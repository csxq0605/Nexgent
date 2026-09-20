"""Host-owned, deterministic patches for immutable AgentPackages.

This module contains no search or evaluation policy.  It only validates a
bounded declarative text patch and constructs a complete child package.  The
separation lets task-agent evolution and improver evolution share the same
kind of fail-closed mutation boundary without giving package code filesystem
or control-plane access.
"""

from __future__ import annotations

from copy import deepcopy
import json
import re

from ..kernel.programs import digest
from .packages import make_package, safe_path, verify_package
from .tools import ContractError


IMPROVER_PATCH_SCHEMA = "nexgent.improver-patch.v1"
_OPERATIONS = frozenset({"replace", "add", "remove"})
_FORBIDDEN_PATH_TOKENS = frozenset({
    "benchmark", "credential", "credentials", "evaluator", "evaluation",
    "gate", "gating", "hidden", "holdout", "manifest", "permission",
    "permissions", "provider", "secret",
})


def _copy(value, label):
    try:
        encoded = json.dumps(value, ensure_ascii=False, sort_keys=True,
                             separators=(",", ":"), allow_nan=False)
        return json.loads(encoded)
    except (TypeError, ValueError, RecursionError) as exc:
        raise ContractError(f"{label} must be finite JSON: {str(exc)[:500]}") from None


def _tokens(path):
    return {part for part in re.split(r"[^a-z0-9]+", path.casefold()) if part}


def improver_patch_schema():
    """Return the strict artifact schema accepted from a running improver."""
    operation = {
        "type": "object",
        "required": ["op", "path"],
        "properties": {
            "op": {"enum": sorted(_OPERATIONS)},
            "path": {"type": "string", "minLength": 1, "maxLength": 240},
            "old_digest": {"type": "string", "pattern": "^[0-9a-f]{64}$"},
            "content": {"type": "string", "maxLength": 100000},
        },
        "additionalProperties": False,
    }
    return {
        "type": "object",
        "required": ["schema", "hypothesis", "operations", "activation_probe"],
        "properties": {
            "schema": {"const": IMPROVER_PATCH_SCHEMA},
            "hypothesis": {
                "type": "object",
                "required": ["failure_mechanism", "expected_behavior",
                             "applicability", "falsifier"],
                "properties": {key: {"type": "string", "minLength": 1,
                                     "maxLength": 5000}
                               for key in ("failure_mechanism", "expected_behavior",
                                           "applicability", "falsifier")},
                "additionalProperties": False,
            },
            "operations": {"type": "array", "minItems": 1, "maxItems": 128,
                           "items": operation},
            "activation_probe": {
                "type": "object", "required": ["kind", "path"],
                "properties": {
                    "kind": {"const": "improve_entry_loaded"},
                    "path": {"type": "string", "minLength": 1, "maxLength": 240},
                },
                "additionalProperties": False,
            },
        },
        "additionalProperties": False,
    }


def normalize_improver_policy(parent, policy):
    """Validate the fixed self-mutation surface for one improver lineage."""
    verify_package(parent)
    policy = _copy(policy, "Improver mutation policy")
    if not isinstance(policy, dict):
        raise ContractError("Improver mutation policy must be an object")
    allowed_keys = {"mutable_paths", "allowed_operations", "max_patch_bytes",
                    "max_outer_model_calls", "max_outer_completion_tokens",
                    "max_outer_tool_calls", "max_outer_nodes"}
    if set(policy) - allowed_keys:
        raise ContractError("Improver mutation policy contains host-unknown fields")
    paths = policy.get("mutable_paths")
    if (not isinstance(paths, list) or not paths or len(paths) > 128
            or len(set(paths)) != len(paths)
            or any(not isinstance(path, str) for path in paths)):
        raise ContractError("Improver mutable paths must be a nonempty unique bounded list")
    for path in paths:
        try:
            safe_path(path)
        except Exception as exc:
            raise ContractError(str(exc)) from None
        if _tokens(path) & _FORBIDDEN_PATH_TOKENS:
            raise ContractError("Improver policy cannot expose host control-plane paths")
    improve_ref = parent["manifest"]["entries"].get("improve")
    if not isinstance(improve_ref, str):
        raise ContractError("An evolvable improver must register an improve entry")
    improve_path = improve_ref.split(":", 1)[0]
    if improve_path not in paths:
        raise ContractError("Improver mutation policy must include the improve entry implementation")
    operations = policy.get("allowed_operations", ["replace"])
    if (not isinstance(operations, list) or not operations
            or len(set(operations)) != len(operations)
            or any(value not in _OPERATIONS for value in operations)):
        raise ContractError("Improver mutation policy has unsupported operations")
    max_patch_bytes = policy.get("max_patch_bytes", 300000)
    if type(max_patch_bytes) is not int or not 1 <= max_patch_bytes <= 500000:
        raise ContractError("Improver patch byte budget is invalid")
    outer = {}
    defaults = {
        "max_outer_model_calls": 20,
        "max_outer_completion_tokens": 80000,
        "max_outer_tool_calls": 0,
        "max_outer_nodes": 100,
    }
    for key, default in defaults.items():
        value = policy.get(key, default)
        if type(value) is not int or value < 0:
            raise ContractError("Improver outer budgets must be nonnegative integers")
        outer[key] = value
    return {
        "mutable_paths": list(paths),
        "allowed_operations": list(operations),
        "max_patch_bytes": max_patch_bytes,
        **outer,
    }


def apply_improver_patch(parent, patch, policy, *, provenance):
    """Apply one strict patch while preserving the host-owned frozen surface.

    The manifest is copied byte-for-byte at the JSON value level.  In
    particular, the ``improve`` path/function, skill declarations and entry
    points cannot move.  Capabilities and outer budgets live in the policy and
    are not package-controlled fields.
    """
    verify_package(parent)
    policy = normalize_improver_policy(parent, policy)
    patch = _copy(patch, "ImproverPatch")
    if (not isinstance(patch, dict)
            or set(patch) != {"schema", "hypothesis", "operations", "activation_probe"}
            or patch.get("schema") != IMPROVER_PATCH_SCHEMA):
        raise ContractError("Improver output is not a strict ImproverPatch")
    hypothesis = patch.get("hypothesis")
    hypothesis_keys = {"failure_mechanism", "expected_behavior", "applicability", "falsifier"}
    if (not isinstance(hypothesis, dict) or set(hypothesis) != hypothesis_keys
            or any(not isinstance(value, str) or not value.strip() or len(value) > 5000
                   for value in hypothesis.values())):
        raise ContractError("ImproverPatch hypothesis is incomplete")
    operations = patch.get("operations")
    if not isinstance(operations, list) or not 1 <= len(operations) <= 128:
        raise ContractError("ImproverPatch operations must be a nonempty bounded list")
    probe = patch.get("activation_probe")
    improve_path = parent["manifest"]["entries"]["improve"].split(":", 1)[0]
    if (not isinstance(probe, dict) or set(probe) != {"kind", "path"}
            or probe.get("kind") != "improve_entry_loaded"
            or probe.get("path") != improve_path):
        raise ContractError("ImproverPatch must probe the frozen improve entry path")
    encoded = json.dumps(patch, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    if len(encoded.encode("utf-8")) > policy["max_patch_bytes"]:
        raise ContractError("ImproverPatch exceeds its byte budget")

    files, seen = deepcopy(parent["files"]), set()
    for operation in operations:
        if not isinstance(operation, dict):
            raise ContractError("ImproverPatch operations must be objects")
        op, path = operation.get("op"), operation.get("path")
        if op not in policy["allowed_operations"] or path not in policy["mutable_paths"]:
            raise ContractError("ImproverPatch operation is outside the frozen mutation policy")
        if path in seen:
            raise ContractError("ImproverPatch cannot modify one path twice")
        seen.add(path)
        expected = ({"op", "path", "content"} if op == "add" else
                    {"op", "path", "old_digest", "content"} if op == "replace" else
                    {"op", "path", "old_digest"})
        if set(operation) != expected:
            raise ContractError("ImproverPatch operation fields do not match its operation")
        if op in {"replace", "remove"}:
            if (path not in files
                    or operation["old_digest"] != parent["component_digests"].get(path)):
                raise ContractError("ImproverPatch old digest does not match its parent")
        if op == "add":
            if path in files:
                raise ContractError("ImproverPatch add target already exists")
            content = operation["content"]
            if not isinstance(content, str):
                raise ContractError("ImproverPatch content must be text")
            files[path] = content
        elif op == "replace":
            content = operation["content"]
            if (not isinstance(content, str)
                    or digest(content) == parent["component_digests"][path]):
                raise ContractError("ImproverPatch replacement must change its component")
            files[path] = content
        else:
            if path == improve_path:
                raise ContractError("ImproverPatch cannot remove the improve entry implementation")
            del files[path]
    if improve_path not in seen:
        raise ContractError("Recursive improver candidates must change the improve implementation")
    try:
        child = make_package(files, deepcopy(parent["manifest"]), parent=parent,
                             provenance=_copy(provenance, "Improver provenance"))
    except Exception as exc:
        raise ContractError(f"ImproverPatch cannot form a valid child: {str(exc)[:500]}") from None
    if child["manifest"] != parent["manifest"]:
        raise ContractError("ImproverPatch changed the frozen manifest")
    return child, patch, policy
