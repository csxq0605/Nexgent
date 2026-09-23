"""Task-scoped model roles for model-authored executable plans.

The package manifest remains immutable.  A generated workflow may instead
declare a bounded ``task_roles`` registry and refer to an entry as
``task:<alias>``.  Materialization replaces that friendly reference with a
content-addressed role and component identity before the plan is compiled or
persisted.  Re-materializing a persisted generated workflow is idempotent.
"""

from __future__ import annotations

from copy import deepcopy
import hashlib
import json
import re

from .tools import ContractError


MAX_TASK_ROLES = 256
MAX_TASK_ROLE_PROMPT_BYTES = 20_000
MAX_TASK_ROLE_REGISTRY_BYTES = 80_000
_ALIAS = re.compile(r"[a-z][a-z0-9_-]{0,47}")
_CANONICAL_ID = re.compile(r"task-role://([a-z][a-z0-9_-]{0,47})/([0-9a-f]{16})")
_INPUT_FIELDS = frozenset({"identity", "prompt", "capabilities"})
_CANONICAL_FIELDS = frozenset({
    "alias", "identity", "prompt", "capabilities", "digest", "component_ref",
})


def _canonical(value) -> str:
    return json.dumps(
        value, ensure_ascii=False, allow_nan=False,
        sort_keys=True, separators=(",", ":"),
    )


def _definition(alias: str, value: object) -> dict:
    if not isinstance(alias, str) or _ALIAS.fullmatch(alias) is None:
        raise ContractError("Task role alias must be a bounded lowercase identifier")
    if not isinstance(value, dict) or set(value) != _INPUT_FIELDS:
        raise ContractError(
            "Task role definition must contain identity, prompt, and capabilities"
        )
    identity = value["identity"]
    prompt = value["prompt"]
    capabilities = value["capabilities"]
    if (not isinstance(identity, str) or not identity.strip()
            or len(identity) > 120):
        raise ContractError("Task role identity must be bounded nonempty text")
    if (not isinstance(prompt, str) or not prompt.strip()
            or len(prompt.encode("utf-8")) > MAX_TASK_ROLE_PROMPT_BYTES):
        raise ContractError("Task role prompt must be bounded nonempty text")
    if capabilities != ["ask"]:
        raise PermissionError("Task-created roles may only receive the ask capability")
    content = {
        "alias": alias,
        "identity": identity,
        "prompt": prompt,
        "capabilities": ["ask"],
    }
    digest = hashlib.sha256(_canonical(content).encode("utf-8")).hexdigest()
    role_id = f"task-role://{alias}/{digest[:16]}"
    return {
        **content,
        "digest": digest,
        "component_ref": f"task-role-component://{digest[:24]}",
        "role_ref": role_id,
    }


def _persisted_definition(role_id: str, value: object) -> dict:
    match = _CANONICAL_ID.fullmatch(role_id) if isinstance(role_id, str) else None
    if match is None or not isinstance(value, dict) or set(value) != _CANONICAL_FIELDS:
        raise ContractError("Persisted task role definition is invalid")
    alias = match.group(1)
    rebuilt = _definition(alias, {
        "identity": value.get("identity"),
        "prompt": value.get("prompt"),
        "capabilities": value.get("capabilities"),
    })
    if (role_id != rebuilt["role_ref"]
            or value.get("alias") != alias
            or value.get("digest") != rebuilt["digest"]
            or value.get("component_ref") != rebuilt["component_ref"]):
        raise ContractError("Persisted task role identity differs from its content")
    rebuilt.pop("role_ref")
    return rebuilt


def materialize_task_roles(workflow: object) -> dict:
    """Return a frozen workflow with task role references made immutable.

    Friendly proposals use a registry keyed by alias and nodes reference
    ``task:<alias>``.  Persisted workflows use content-addressed keys and node
    refs.  Later revisions may mix validated persisted entries with new
    aliases, but cannot redefine an existing alias.
    """
    if not isinstance(workflow, dict):
        raise ContractError("Workflow must be an object")
    result = deepcopy(workflow)
    registry = result.get("task_roles", {})
    if not isinstance(registry, dict) or len(registry) > MAX_TASK_ROLES:
        raise ContractError(
            f"Workflow task_roles must be an object of at most {MAX_TASK_ROLES} roles"
        )
    try:
        if len(_canonical(registry).encode("utf-8")) > MAX_TASK_ROLE_REGISTRY_BYTES:
            raise ContractError("Workflow task_roles exceeds its text budget")
    except (TypeError, ValueError, RecursionError) as exc:
        raise ContractError(f"Workflow task_roles must be finite JSON: {exc}") from None

    role_by_ref = {}
    alias_to_ref = {}
    frozen = {}
    proposed = []
    for key, value in sorted(registry.items()):
        if isinstance(key, str) and _CANONICAL_ID.fullmatch(key) is not None:
            role_ref = key
            role = _persisted_definition(role_ref, value)
            frozen[role_ref] = role
            role_by_ref[role_ref] = role
            alias = role["alias"]
            if alias in alias_to_ref:
                raise ContractError("Workflow task role aliases must be unique")
            alias_to_ref[alias] = role_ref
        elif isinstance(key, str) and _ALIAS.fullmatch(key) is not None:
            proposed.append((key, value))
        else:
            raise ContractError("Task role alias must be a bounded lowercase identifier")
    for alias, value in proposed:
        if alias in alias_to_ref:
            raise ContractError("A proposed task role cannot redefine an existing alias")
        role = _definition(alias, value)
        role_ref = role.pop("role_ref")
        if role_ref in frozen:
            raise ContractError("Task role content identity collides with an existing role")
        frozen[role_ref] = role
        role_by_ref[role_ref] = role
        alias_to_ref[alias] = role_ref
    if registry:
        result["task_roles"] = dict(sorted(frozen.items()))

    def rewrite(definition: dict) -> None:
        for node in definition.get("nodes", []):
            if not isinstance(node, dict):
                continue
            role_ref = node.get("role_ref")
            if isinstance(role_ref, str) and role_ref.startswith("task:"):
                alias = role_ref.removeprefix("task:")
                if alias not in alias_to_ref:
                    raise ContractError(f"Workflow task role is not declared: {alias}")
                role_ref = alias_to_ref[alias]
                node["role_ref"] = role_ref
            if isinstance(role_ref, str) and role_ref in role_by_ref:
                role = role_by_ref.get(role_ref)
                if role is None:
                    raise ContractError(f"Workflow task role is not declared: {role_ref}")
                if node.get("method") != "ask":
                    raise PermissionError("Task-created roles may only execute ask nodes")
                component_ref = node.get("component_ref")
                if component_ref not in {None, role["component_ref"]}:
                    raise ContractError(
                        "Task role component_ref differs from its content identity"
                    )
                node["component_ref"] = role["component_ref"]
                params = node.setdefault("params", {})
                if not isinstance(params, dict):
                    raise ContractError("Task role node params must be an object")
                if "role" in params and params["role"] != role_ref:
                    raise ContractError("Task role params.role conflicts with role_ref")
                if "prompt" in params and params["prompt"] != role["prompt"]:
                    raise ContractError("Task role params.prompt conflicts with its frozen prompt")
                params["role"] = role_ref
                params["prompt"] = role["prompt"]
            if node.get("method") == "loop" and isinstance(node.get("body"), dict):
                rewrite(node["body"])

    rewrite(result)
    return result


def task_role_registry(workflow: object) -> dict[str, dict]:
    """Read and validate the canonical task role registry of a workflow."""
    materialized = materialize_task_roles(workflow)
    return deepcopy(materialized.get("task_roles", {}))
