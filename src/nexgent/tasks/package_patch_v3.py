"""Host-side construction of atomic multi-component O/S package candidates.

This module validates and builds a complete immutable AgentPackage.  It does
not admit, select, or deploy the candidate; those gates remain host-owned and
must gain component-set evidence before generated v3 patches can be promoted.
"""

from __future__ import annotations

from copy import deepcopy
import json
import re

from ..kernel.programs import digest
from .packages import make_package, safe_path, verify_package
from .tools import ContractError


PACKAGE_PATCH_SCHEMA = "nexgent.package-patch.v3"
PACKAGE_PATCH_SWITCH_SCHEMA = "nexgent.package-patch.v4"
_REGISTRIES = {
    "entry": "entries", "role": "roles", "workflow": "workflows",
    "skill": "skills", "tool": "tools", "service_provider": "services",
}
_FORBIDDEN = frozenset({
    "benchmark", "evaluator", "evaluation", "gate", "gating", "permission",
    "permissions", "manifest", "holdout", "secret", "hidden",
})


def _finite_json(value, label):
    try:
        return json.loads(json.dumps(value, ensure_ascii=False, allow_nan=False))
    except (TypeError, ValueError, RecursionError) as exc:
        raise ContractError(f"{label} must be finite JSON") from exc


def _tokens(path):
    return set(filter(None, re.split(r"[^a-z0-9]+", path.lower())))


def _path(manifest, component_id, *, mutable=True):
    component = manifest["components"].get(component_id)
    if not isinstance(component, dict):
        raise ContractError(f"Component is not declared: {component_id}")
    kind, ref = component.get("kind"), component.get("ref")
    try:
        if kind == "resource":
            path = ref
        elif kind == "entry":
            path = manifest["entries"][ref].split(":", 1)[0]
        elif kind == "workflow":
            path = manifest["workflows"][ref]["ref"]
        elif kind == "skill":
            item = manifest["skills"][ref]
            path = (item["ref"].split(":", 1)[0] if item["kind"] == "controlled_code"
                    else item["ref"])
        elif kind == "role":
            path = manifest["roles"][ref].get("prompt_ref")
        elif kind == "tool":
            path = manifest.get("tools", {})[ref]["ref"].split(":", 1)[0]
        elif kind == "service_provider":
            path = manifest.get("services", {})[ref]["ref"].split(":", 1)[0]
        else:
            raise ContractError(f"Unsupported component kind: {kind}")
    except (KeyError, TypeError, AttributeError) as exc:
        raise ContractError("PackagePatch component registry reference is absent") from exc
    if path is None and not mutable:
        return None
    if not isinstance(path, str):
        raise ContractError("PackagePatch components must have a declared file")
    try:
        safe_path(path)
    except Exception as exc:
        raise ContractError("PackagePatch component path is unsafe") from exc
    if mutable and _tokens(path) & _FORBIDDEN:
        raise ContractError("PackagePatch cannot modify host-control or hidden paths")
    return path


def _owned_by(manifest, path):
    return sorted(component_id for component_id in manifest["components"]
                  if _path(manifest, component_id, mutable=False) == path)


def _check_manifest_delta(parent, child, changed_ids):
    permitted = {
        "entries", "roles", "workflows", "skills", "tools", "services",
        "components", "orchestrator",
    }
    for field in set(parent) | set(child):
        if field not in permitted and child.get(field) != parent.get(field):
            raise ContractError(f"PackagePatch cannot change manifest field: {field}")
    for kind, registry_name in _REGISTRIES.items():
        old_registry = parent.get(registry_name, {})
        new_registry = child.get(registry_name, {})
        if not isinstance(old_registry, dict) or not isinstance(new_registry, dict):
            raise ContractError("PackagePatch manifest registries must be objects")
        for ref in set(old_registry) | set(new_registry):
            if old_registry.get(ref) == new_registry.get(ref):
                continue
            owners = {
                identity for manifest in (parent, child)
                for identity, declaration in manifest["components"].items()
                if declaration.get("kind") == kind and declaration.get("ref") == ref
            }
            if not owners or not owners <= changed_ids:
                raise ContractError(
                    f"PackagePatch registry change is not owned by changed components: {kind}:{ref}")
    if parent["orchestrator"] != child["orchestrator"]:
        if not {parent["orchestrator"], child["orchestrator"]} <= changed_ids:
            raise ContractError("PackagePatch changed the orchestrator outside its component set")


def _check_envelope(manifest, files, policy):
    capabilities = set(policy["capability_ceiling"])
    if not set(manifest.get("tools", {})) <= set(policy["tool_ceiling"]):
        raise ContractError("PackagePatch expands the portable-tool ceiling")
    for role in manifest["roles"].values():
        if not set(role.get("capabilities", [])) <= capabilities:
            raise ContractError("PackagePatch expands the role capability envelope")
    for workflow in manifest["workflows"].values():
        if workflow.get("max_parallel", 4) > policy["max_parallel"]:
            raise ContractError("PackagePatch expands the parallelism ceiling")
        definition = json.loads(files[workflow["ref"]])
        def check_graph(graph):
            for node in graph.get("nodes", []):
                if node.get("method") == "tool" and node.get("params", {}).get("name") not in policy["tool_ceiling"]:
                    raise ContractError("PackagePatch requests an undeclared tool")
                if node.get("method") == "loop":
                    check_graph(node["body"])
        check_graph(definition)


def apply_package_patch(parent, patch, policy, *, provenance):
    """Apply an atomic O/S component set to a frozen manifest-v2 parent.

    The caller supplies a separately frozen policy and host provenance.  This
    function rejects partial manifest/file edits before constructing the child.
    """
    verify_package(parent)
    patch = _finite_json(patch, "PackagePatch")
    policy = _finite_json(policy, "PackagePatch policy")
    if parent["manifest"].get("manifest_version") != 2:
        raise ContractError("PackagePatch v3 needs a manifest-v2 parent")
    if (not isinstance(patch, dict)
            or set(patch) != {"schema", "parent_package_digest", "hypothesis",
                           "operations", "child_manifest", "activation_targets"}
            or patch["schema"] not in {PACKAGE_PATCH_SCHEMA, PACKAGE_PATCH_SWITCH_SCHEMA}
            or patch["parent_package_digest"] != parent["digest"]
            or not isinstance(patch["hypothesis"], dict)
            or set(patch["hypothesis"]) != {
                "failure_mechanism", "expected_behavior", "applicability",
                "falsifier", "component_ids"}
            or any(not isinstance(patch["hypothesis"][key], str)
                   or not patch["hypothesis"][key].strip()
                   or len(patch["hypothesis"][key]) > 5000
                   for key in ("failure_mechanism", "expected_behavior",
                               "applicability", "falsifier"))
            or not isinstance(patch["operations"], list)
            or not 1 <= len(patch["operations"]) <= 64
            or not isinstance(patch["activation_targets"], list)
            or not isinstance(patch["child_manifest"], dict)):
        raise ContractError("PackagePatch has an invalid envelope")
    if (not isinstance(policy, dict)
            or set(policy) != {"mutable_components", "allow_add", "allow_remove",
                               "max_patch_bytes", "capability_ceiling",
                               "tool_ceiling", "max_parallel"}
            or not isinstance(policy["mutable_components"], list)
            or len(policy["mutable_components"]) > 128
            or not all(isinstance(item, str) for item in policy["mutable_components"])
            or len(set(policy["mutable_components"])) != len(policy["mutable_components"])
            or not all(item in parent["manifest"]["components"]
                       for item in policy["mutable_components"])
            or type(policy["allow_add"]) is not bool
            or type(policy["allow_remove"]) is not bool
            or type(policy["max_patch_bytes"]) is not int
            or not 1 <= policy["max_patch_bytes"] <= 1_000_000
            or type(policy["max_parallel"]) is not int
            or not 1 <= policy["max_parallel"] <= 256
            or not isinstance(policy["capability_ceiling"], list)
            or not all(isinstance(item, str) for item in policy["capability_ceiling"])
            or not isinstance(policy["tool_ceiling"], list)
            or not all(isinstance(item, str) for item in policy["tool_ceiling"])):
        raise ContractError("PackagePatch policy is invalid")
    if len(json.dumps(patch, ensure_ascii=False).encode("utf-8")) > policy["max_patch_bytes"]:
        raise ContractError("PackagePatch exceeds its byte ceiling")

    old_manifest = parent["manifest"]
    manifest = patch["child_manifest"]
    if (manifest.get("manifest_version") != 2
            or any(not isinstance(manifest.get(name, {}), dict)
                   for name in ("entries", "roles", "workflows", "skills", "tools",
                                "services", "components"))
            or any(not isinstance(item, dict)
                   for item in manifest["components"].values())
            or not isinstance(manifest.get("orchestrator"), str)):
        raise ContractError("PackagePatch child must keep manifest v2")
    if manifest.get("entries", {}).get("improve") != old_manifest["entries"].get("improve"):
        raise ContractError("PackagePatch cannot change the active improver entry")
    changed_ids = set()
    files = deepcopy(parent["files"])
    for operation in patch["operations"]:
        if not isinstance(operation, dict):
            raise ContractError("PackagePatch operations must be objects")
        op = operation.get("op")
        identity = operation.get("component_id")
        if (op not in {"add", "replace", "remove"}
                or not isinstance(identity, str) or not identity
                or identity in changed_ids):
            raise ContractError("PackagePatch operation is invalid or duplicated")
        changed_ids.add(identity)
        before = old_manifest["components"].get(identity)
        after = manifest["components"].get(identity)
        if op == "add":
            if (not policy["allow_add"] or before is not None or after is None
                    or set(operation) != {"op", "component_id", "path", "content"}):
                raise ContractError("PackagePatch add is not allowed")
            path = _path(manifest, identity)
            if (operation["path"] != path or path in files
                    or _owned_by(manifest, path) != [identity]
                    or not isinstance(operation["content"], str)):
                raise ContractError("PackagePatch add does not own a new file")
            files[path] = operation["content"]
        else:
            if before is None or identity not in policy["mutable_components"]:
                raise ContractError("PackagePatch target is not mutable")
            path = _path(old_manifest, identity)
            if _owned_by(old_manifest, path) != [identity]:
                raise ContractError("PackagePatch target shares its file")
            if operation.get("old_digest") != parent["component_digests"][path]:
                raise ContractError("PackagePatch old digest differs from parent")
            if op == "remove":
                if (not policy["allow_remove"] or after is not None
                        or set(operation) != {"op", "component_id", "old_digest"}):
                    raise ContractError("PackagePatch remove is not allowed")
                del files[path]
            else:
                if (after is None or set(operation) not in (
                        {"op", "component_id", "old_digest"},
                        {"op", "component_id", "old_digest", "content"})):
                    raise ContractError("PackagePatch replacement is invalid")
                if _path(manifest, identity) != path:
                    raise ContractError("Stable PackagePatch component changed its file")
                if "content" in operation:
                    if not isinstance(operation["content"], str):
                        raise ContractError("PackagePatch content must be text")
                    files[path] = operation["content"]
        active = after if op != "remove" else before
        if active.get("class") not in {"O", "S"}:
            raise ContractError("PackagePatch v3 only accepts O/S components")

    identities = patch["hypothesis"]["component_ids"]
    targets = patch["activation_targets"]
    if (not isinstance(identities, list) or len(identities) != len(changed_ids)
            or not all(isinstance(item, str) for item in identities)
            or set(identities) != changed_ids
            or not all(isinstance(item, str) for item in targets)):
        raise ContractError("PackagePatch hypothesis must name every changed component")

    old_orchestrator = old_manifest["orchestrator"]
    new_orchestrator = manifest["orchestrator"]
    old_kind = old_manifest["components"][old_orchestrator]["kind"]
    new_kind = manifest["components"][new_orchestrator]["kind"]
    backend_switch = (old_orchestrator != new_orchestrator
                      and {old_kind, new_kind} == {"entry", "workflow"})
    if patch["schema"] == PACKAGE_PATCH_SWITCH_SCHEMA:
        expected_targets = changed_ids - {old_orchestrator}
        if (not backend_switch or not targets
                or len(set(targets)) != len(targets)
                or set(targets) != expected_targets
                or new_orchestrator not in targets or old_orchestrator in targets
                or any(identity not in manifest["components"] for identity in targets)):
            raise ContractError(
                "PackagePatch v4 must activate every changed component except the "
                "retired entry/workflow orchestrator")
    elif set(targets) != changed_ids or len(targets) != len(changed_ids):
        raise ContractError(
            "PackagePatch v3 activation must name every changed component")

    old_ids = set(old_manifest["components"])
    new_ids = set(manifest["components"])
    expected_ids = ((old_ids - new_ids) | (new_ids - old_ids) | {
        identity for identity in old_ids & new_ids
        if old_manifest["components"][identity] != manifest["components"][identity]})
    if not expected_ids <= changed_ids:
        raise ContractError("PackagePatch has undeclared component registry changes")
    for identity in (old_ids & new_ids) - changed_ids:
        if (_path(old_manifest, identity, mutable=False)
                != _path(manifest, identity, mutable=False)):
            raise ContractError("PackagePatch changed an undeclared component path")
        path = _path(old_manifest, identity, mutable=False)
        if path is not None and files[path] != parent["files"][path]:
            raise ContractError("PackagePatch changed an undeclared component file")
    for operation in patch["operations"]:
        if operation["op"] == "replace":
            identity = operation["component_id"]
            before = old_manifest["components"][identity]
            after = manifest["components"][identity]
            old_path = _path(old_manifest, identity)
            registry_name = _REGISTRIES.get(before["kind"])
            registry_changed = (registry_name is not None
                                and old_manifest[registry_name].get(before["ref"])
                                != manifest[registry_name].get(after["ref"]))
            if (before == after
                    and files[old_path] == parent["files"][old_path]
                    and not registry_changed):
                raise ContractError("PackagePatch replacement has no component effect")
    _check_manifest_delta(old_manifest, manifest, changed_ids)
    improve = old_manifest["entries"].get("improve")
    if improve is not None:
        improve_path = improve.split(":", 1)[0]
        if files.get(improve_path) != parent["files"].get(improve_path):
            raise ContractError("PackagePatch cannot modify the active improver")
    try:
        _check_envelope(manifest, files, policy)
        host_provenance = _finite_json(provenance, "Provenance")
        if not isinstance(host_provenance, dict):
            raise ContractError("PackagePatch provenance must be an object")
        child = make_package(files, manifest, parent=parent,
                             provenance={**host_provenance,
                                         "package_patch_digest": digest(patch)})
    except ContractError:
        raise
    except Exception as exc:
        raise ContractError(f"PackagePatch cannot form a valid child: {str(exc)[:500]}") from None
    if child["digest"] == parent["digest"]:
        raise ContractError("PackagePatch must change the package")
    return child
