"""Compile one task-authored controlled skill into an immutable child package.

The compiler is deliberately host-side and pure: it neither stores the child
nor moves a package channel.  A caller may use the returned package for one
task or delegated Episode.  Cross-task deployment must still pass through the
ordinary feedback, generation, selection, monitoring, and promotion services.
"""

from __future__ import annotations

import ast
from copy import deepcopy
import json
import re

from ..kernel.programs import digest
from .package_patch_v3 import PACKAGE_PATCH_SCHEMA, apply_package_patch
from .packages import CAPABILITIES, verify_package
from .tools import ContractError, check_contract_schema


TASK_SKILL_PROPOSAL_SCHEMA = "nexgent.task-skill-proposal.v1"

_IDENTIFIER = re.compile(r"[A-Za-z][A-Za-z0-9_.-]{0,59}")
_FUNCTION = re.compile(r"[A-Za-z][A-Za-z0-9_]{0,79}")
_DIRECT_RPC_METHODS = frozenset(CAPABILITIES - {"parallel", "skill", "delegate", "develop_skill"})
_LOCAL_CONTEXT_METHODS = frozenset({"resource"})


def _finite_json(value, label):
    try:
        return json.loads(json.dumps(value, ensure_ascii=False, allow_nan=False))
    except (TypeError, ValueError, RecursionError) as exc:
        raise ContractError(f"{label} must be finite JSON: {exc}") from None


def _bounded_text(value, label, maximum=5000):
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise ContractError(f"{label} must be nonempty bounded text")
    return value


def _policy(value):
    policy = _finite_json(value, "Task skill constraints")
    if (not isinstance(policy, dict)
            or set(policy) != {
                "allowed_rpc_methods", "allowed_tools", "max_patch_bytes"}
            or not isinstance(policy["allowed_rpc_methods"], list)
            or not isinstance(policy["allowed_tools"], list)
            or type(policy["max_patch_bytes"]) is not int
            or not 1 <= policy["max_patch_bytes"] <= 1_000_000):
        raise ContractError("Task skill constraints have an invalid envelope")
    methods = policy["allowed_rpc_methods"]
    tools = policy["allowed_tools"]
    if (len(methods) != len(set(methods))
            or any(method not in _DIRECT_RPC_METHODS for method in methods)):
        raise ContractError(
            "Task skill allowed_rpc_methods must be unique direct host capabilities")
    if (len(tools) != len(set(tools))
            or any(not isinstance(name, str) or not name or len(name) > 120
                   for name in tools)):
        raise ContractError("Task skill allowed_tools must be unique bounded names")
    if tools and "tool" not in methods:
        raise ContractError("Task skill tool grants require the tool RPC method")
    policy["allowed_rpc_methods"] = sorted(methods)
    policy["allowed_tools"] = sorted(tools)
    return policy


def _proposal(value, parent):
    proposal = _finite_json(value, "Task skill proposal")
    if (not isinstance(proposal, dict)
            or set(proposal) != {
                "schema", "parent_package_digest", "skill",
                "deliverable_name", "hypothesis"}
            or proposal.get("schema") != TASK_SKILL_PROPOSAL_SCHEMA
            or proposal.get("parent_package_digest") != parent["digest"]):
        raise ContractError("Task skill proposal has an invalid envelope")
    skill = proposal["skill"]
    if (not isinstance(skill, dict)
            or set(skill) != {
                "name", "entrypoint", "source", "input_schema", "output_schema"}
            or not isinstance(skill.get("name"), str)
            or _IDENTIFIER.fullmatch(skill["name"]) is None
            or not isinstance(skill.get("entrypoint"), str)
            or _FUNCTION.fullmatch(skill["entrypoint"]) is None
            or not isinstance(skill.get("source"), str)
            or len(skill["source"].encode("utf-8")) > 100_000):
        raise ContractError("Task skill declaration is invalid")
    check_contract_schema(skill["input_schema"])
    check_contract_schema(skill["output_schema"])
    deliverable = proposal["deliverable_name"]
    if (not isinstance(deliverable, str) or not deliverable
            or len(deliverable) > 120):
        raise ContractError("Task skill deliverable_name must be bounded text")
    hypothesis = proposal["hypothesis"]
    fields = {"failure_mechanism", "expected_behavior", "applicability", "falsifier"}
    if not isinstance(hypothesis, dict) or set(hypothesis) != fields:
        raise ContractError("Task skill hypothesis has an invalid envelope")
    for name in fields:
        _bounded_text(hypothesis[name], f"Task skill hypothesis {name}")
    return proposal


def _source_capabilities(source, entrypoint, constraints):
    try:
        tree = ast.parse(source, filename="task-authored-skill.py")
    except (SyntaxError, RecursionError) as exc:
        raise ContractError(f"Task skill source is invalid Python: {exc}") from None
    entries = [node for node in tree.body
               if isinstance(node, ast.FunctionDef) and node.name == entrypoint]
    if len(entries) != 1:
        raise ContractError("Task skill source must define its entrypoint exactly once")
    entry = entries[0]
    args = entry.args
    if (len(args.posonlyargs) != 0 or len(args.args) != 2
            or [arg.arg for arg in args.args] != ["payload", "context"]
            or args.vararg is not None or args.kwarg is not None
            or args.kwonlyargs or args.defaults or args.kw_defaults):
        raise ContractError(
            "Task skill entrypoint must have the exact signature (payload, context)")

    parents = {}
    for node in ast.walk(tree):
        for child in ast.iter_child_nodes(node):
            parents[child] = node

    used_methods = set()
    used_tools = set()
    for node in ast.walk(tree):
        if not isinstance(node, ast.Name) or node.id != "context":
            continue
        attribute = parents.get(node)
        call = parents.get(attribute)
        if (not isinstance(attribute, ast.Attribute)
                or attribute.value is not node
                or not isinstance(call, ast.Call)
                or call.func is not attribute):
            raise ContractError(
                "Task skill context cannot be aliased, stored, or passed to another function")
        method = attribute.attr
        if method in _LOCAL_CONTEXT_METHODS:
            continue
        if method not in _DIRECT_RPC_METHODS:
            raise ContractError(
                f"Task skill context method is not directly auditable: {method}")
        used_methods.add(method)
        if method == "tool":
            positional = call.args[0] if call.args else None
            keywords = [item.value for item in call.keywords if item.arg == "name"]
            if positional is not None and keywords:
                raise ContractError("Task skill tool call declares its name twice")
            tool_node = positional if positional is not None else (
                keywords[0] if len(keywords) == 1 else None)
            if not isinstance(tool_node, ast.Constant) or not isinstance(tool_node.value, str):
                raise ContractError("Task skill tool names must be string literals")
            used_tools.add(tool_node.value)

    allowed_methods = set(constraints["allowed_rpc_methods"])
    allowed_tools = set(constraints["allowed_tools"])
    if not used_methods <= allowed_methods:
        raise ContractError(
            "Task skill source uses an RPC method outside allowed_rpc_methods")
    if not used_tools <= allowed_tools:
        raise ContractError("Task skill source uses a tool outside allowed_tools")
    return sorted(used_methods), sorted(used_tools)


def _workflow_tools(workflow):
    names = set()
    for node in workflow.get("nodes", []):
        if node.get("method") == "tool":
            name = node.get("params", {}).get("name")
            if isinstance(name, str):
                names.add(name)
        if node.get("method") == "loop" and isinstance(node.get("body"), dict):
            names.update(_workflow_tools(node["body"]))
    return names


def compile_task_skill_proposal(parent, proposal, constraints, *, provenance=None):
    """Return an immutable task-time child package containing one new skill.

    The parent must use a manifest-v2 workflow orchestrator.  The child keeps
    that component identity and replaces its workflow with a two-node graph:
    execute the new controlled-code skill, then publish its result under the
    proposal's deliverable name.  This function performs no persistence or
    deployment and therefore grants no cross-task promotion authority.
    """
    verify_package(parent)
    if parent["manifest"].get("manifest_version") != 2:
        raise ContractError("Task skill compilation requires a manifest-v2 parent")
    constraints = _policy(constraints)
    proposal = _proposal(proposal, parent)
    manifest = deepcopy(parent["manifest"])
    orchestrator_id = manifest["orchestrator"]
    orchestrator = manifest["components"].get(orchestrator_id)
    if (not isinstance(orchestrator, dict)
            or orchestrator.get("class") != "O"
            or orchestrator.get("kind") != "workflow"):
        raise ContractError(
            "Task skill compilation requires a workflow orchestrator parent")
    workflow_name = orchestrator["ref"]
    workflow_registration = manifest["workflows"].get(workflow_name)
    if not isinstance(workflow_registration, dict):
        raise ContractError("Task skill parent workflow registration is absent")

    skill = proposal["skill"]
    skill_name = skill["name"]
    component_id = "task-skill-" + skill_name
    path = "skills/task_time/" + skill_name + ".py"
    if (skill_name in manifest["skills"]
            or component_id in manifest["components"]
            or path in parent["files"]):
        raise ContractError("Task skill identity already exists in the parent package")
    used_methods, used_tools = _source_capabilities(
        skill["source"], skill["entrypoint"], constraints)

    manifest["skills"][skill_name] = {
        "kind": "controlled_code",
        "ref": f"{path}:{skill['entrypoint']}",
        "input_schema": deepcopy(skill["input_schema"]),
        "output_schema": deepcopy(skill["output_schema"]),
        "allowed_rpc_methods": deepcopy(constraints["allowed_rpc_methods"]),
        "allowed_tools": deepcopy(constraints["allowed_tools"]),
    }
    manifest["components"][component_id] = {
        "class": "S", "kind": "skill", "ref": skill_name,
    }
    workflow = {
        "nodes": [
            {
                "id": "invented_skill",
                "method": "skill",
                "component_ref": component_id,
                "params": {"name": skill_name},
                "bindings": {"payload": {"$input": ""}},
                "output_schema": deepcopy(skill["output_schema"]),
            },
            {
                "id": "publish_result",
                "method": "publish",
                "params": {"name": proposal["deliverable_name"]},
                "bindings": {"content": {"$node": "invented_skill"}},
            },
        ],
        "control_edges": [],
        "outputs": {
            "deliverables": {
                proposal["deliverable_name"]: {"$node": "publish_result.id"},
            },
            "summary": "Task-authored controlled skill executed in an immutable child package.",
        },
        "revision_rules": [],
    }
    workflow_path = workflow_registration["ref"]
    manifest["workflows"][workflow_name] = {
        **deepcopy(workflow_registration),
        "max_parallel": 1,
        "input_schema": {"type": "object"},
        "output_schema": {"type": "object"},
    }

    hypothesis = {**deepcopy(proposal["hypothesis"]),
                  "component_ids": [orchestrator_id, component_id]}
    patch = {
        "schema": PACKAGE_PATCH_SCHEMA,
        "parent_package_digest": parent["digest"],
        "hypothesis": hypothesis,
        "operations": [
            {
                "op": "replace",
                "component_id": orchestrator_id,
                "old_digest": parent["component_digests"][workflow_path],
                "content": json.dumps(
                    workflow, ensure_ascii=False, sort_keys=True, separators=(",", ":")),
            },
            {
                "op": "add",
                "component_id": component_id,
                "path": path,
                "content": skill["source"],
            },
        ],
        "child_manifest": manifest,
        "activation_targets": [orchestrator_id, component_id],
    }

    existing_role_methods = {
        method for role in manifest["roles"].values()
        for method in role.get("capabilities", [])
    }
    existing_tools = set(constraints["allowed_tools"])
    existing_parallelism = 1
    for registered_name, registration in manifest["workflows"].items():
        existing_parallelism = max(
            existing_parallelism, registration.get("max_parallel", 4))
        definition = (workflow if registered_name == workflow_name
                      else json.loads(parent["files"][registration["ref"]]))
        existing_tools.update(_workflow_tools(definition))
    package_policy = {
        "mutable_components": [orchestrator_id],
        "allow_add": True,
        "allow_remove": False,
        "max_patch_bytes": constraints["max_patch_bytes"],
        "capability_ceiling": sorted(existing_role_methods),
        "tool_ceiling": sorted(existing_tools),
        "max_parallel": existing_parallelism,
    }
    host_provenance = _finite_json(
        {} if provenance is None else provenance, "Task skill provenance")
    if not isinstance(host_provenance, dict):
        raise ContractError("Task skill provenance must be an object")
    return apply_package_patch(
        parent,
        patch,
        package_policy,
        provenance={
            **host_provenance,
            "origin": "task-time-skill-proposal",
            "task_time_only": True,
            "promotion_authority": False,
            "task_skill_proposal_digest": digest(proposal),
            "task_skill_constraint_digest": digest(constraints),
            "observed_rpc_methods": used_methods,
            "observed_tools": used_tools,
        },
    )
