"""Immutable, content-addressed agent file trees with explicit entry points.

Package content and lineage identities are separate. A child receives a complete
tree, so removing a module does not require tombstones or implicit parent merges.
"""

from __future__ import annotations

import ast
import json
import re
from copy import deepcopy

from jsonschema import Draft202012Validator

from ..kernel.programs import canonical, digest, validate_source, ProgramError

SCHEMA = "nexgent.agent-package.v1"
MANIFEST_VERSION = 2
CAPABILITIES = frozenset({"ask", "tool", "parallel", "skill", "delegate", "develop_skill",
                          "develop_tool", "release_tool", "develop_service",
                          "activate_service", "release_service", "capability_inventory", "read_artifact",
                          "publish", "memory_search", "remember", "plan", "feedback"})
LOCAL_METHODS = frozenset({"call", "resource"})
IDENTIFIER = re.compile(r"[A-Za-z][A-Za-z0-9_.-]{0,99}")
COMPONENT_CLASSES = frozenset({"O", "M", "S"})
COMPONENT_KINDS = frozenset({
    "role", "workflow", "skill", "entry", "resource", "tool",
    "service_provider",
})
V2_FIELDS = frozenset({
    "roles", "workflows", "components", "orchestrator", "tools", "services",
})
PORTABLE_RUNTIME = "controlled-python-v1"
MODEL_CONTEXT_INTERFACE = "model_context.v1"
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
        "annotations": {"type": "object", "maxProperties": 64},
    },
    "additionalProperties": False,
}


class PackageError(ValueError):
    """Invalid package content, identity, or controlled execution."""


def safe_path(path):
    if not isinstance(path, str) or not path or len(path) > 240:
        raise PackageError("Package paths must be nonempty relative text paths")
    parts = path.split("/")
    reserved = {"con", "prn", "aux", "nul", *(f"com{i}" for i in range(1, 10)),
                *(f"lpt{i}" for i in range(1, 10))}
    for part in parts:
        if (part in {"", ".", ".."} or part[-1:] in {".", " "}
                or any(ord(c) < 32 or c in '\\:*?"<>|' for c in part)
                or part.split(".")[0].casefold() in reserved):
            raise PackageError(f"Unsafe package path: {path!r}")
    return path


def split_ref(ref, files):
    if not isinstance(ref, str) or ref.count(":") != 1:
        raise PackageError("Entry references must be path.py:function")
    path, function = ref.split(":")
    safe_path(path)
    if (not path.endswith(".py") or path not in files
            or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]*", function)):
        raise PackageError(f"Invalid package entry reference: {ref!r}")
    tree = ast.parse(files[path], filename=path)
    if not any(isinstance(n, ast.FunctionDef) and n.name == function for n in tree.body):
        raise PackageError(f"Entry function is absent: {ref}")
    return path, function


def resolve_entry(package, entry):
    if not isinstance(entry, str):
        raise PackageError("Package entries must be registered text names")
    if entry in {"execute", "improve"}:
        ref = package["manifest"]["entries"].get(entry)
    elif entry.startswith("skill:"):
        skill = package["manifest"].get("skills", {}).get(entry[6:])
        ref = skill.get("ref") if isinstance(skill, dict) and skill.get("kind") == "controlled_code" else None
    elif entry.startswith("tool:"):
        tool = package["manifest"].get("tools", {}).get(entry[5:])
        ref = tool.get("ref") if isinstance(tool, dict) else None
    elif entry.startswith("service:"):
        service = package["manifest"].get("services", {}).get(entry[8:])
        ref = service.get("ref") if isinstance(service, dict) else None
    else:
        ref = None
    if ref is None:
        raise PackageError(f"Unregistered controlled package entry: {entry!r}")
    return split_ref(ref, package["files"])


def _schema(schema, label):
    if not isinstance(schema, (dict, bool)):
        raise PackageError(f"{label} must be a JSON Schema object or boolean")
    def walk(value):
        if isinstance(value, dict):
            for key, item in value.items():
                if key in {"$ref", "$dynamicRef"} and (not isinstance(item, str) or not item.startswith("#")):
                    raise PackageError(f"{label} may only use local schema references")
                walk(item)
        elif isinstance(value, list):
            for item in value:
                walk(item)
    walk(schema)
    try:
        Draft202012Validator.check_schema(schema)
    except Exception as exc:
        raise PackageError(f"{label} is invalid: {str(exc)[:500]}") from None


def _identifier(value, label):
    if not isinstance(value, str) or not IDENTIFIER.fullmatch(value):
        raise PackageError(f"{label} must be a bounded identifier")
    return value


def _resource(ref, files, label):
    safe_path(ref)
    if ref not in files:
        raise PackageError(f"{label} resource is absent: {ref!r}")
    return ref


def _registry(value, label):
    if not isinstance(value, dict):
        raise PackageError(f"Manifest {label} must be an object")
    for name, definition in value.items():
        _identifier(name, f"{label[:-1].capitalize()} id")
        if not isinstance(definition, dict):
            raise PackageError(f"Manifest {label} definitions must be objects")
    return value


def _pure_entry(ref, files, *, function, label):
    """Validate the current portable, no-host-capability Python slice."""
    path, actual = split_ref(ref, files)
    if actual != function:
        raise PackageError(f"{label} must use the {function}(payload, context) entrypoint")
    tree = ast.parse(files[path], filename=path)
    entries = [node for node in tree.body
               if isinstance(node, ast.FunctionDef) and node.name == function]
    if len(entries) != 1:
        raise PackageError(f"{label} must define {function} exactly once")
    args = entries[0].args
    if (args.posonlyargs or len(args.args) != 2
            or [argument.arg for argument in args.args] != ["payload", "context"]
            or args.vararg is not None or args.kwarg is not None
            or args.kwonlyargs or args.defaults or args.kw_defaults):
        raise PackageError(
            f"{label} entrypoint must have the exact signature "
            f"{function}(payload, context)")
    if any(isinstance(node, ast.Name) and node.id == "context"
           and isinstance(node.ctx, ast.Load) for node in ast.walk(tree)):
        raise PackageError(f"{label} cannot use context")
    return path


def _portable_tool_schema(schema, label):
    """Keep package tools inside the same bounded schema slice as task tools."""
    allowed = {
        "type", "properties", "required", "additionalProperties", "items",
        "enum", "const", "minimum", "maximum", "exclusiveMinimum",
        "exclusiveMaximum", "minLength", "maxLength", "minItems", "maxItems",
        "minProperties", "maxProperties", "description",
    }
    pending = [(schema, 0)]
    nodes = 0
    while pending:
        current, depth = pending.pop()
        nodes += 1
        if nodes > 128 or depth > 12:
            raise PackageError(f"{label} exceeds the portable-tool schema bound")
        if type(current) is bool:
            continue
        if not isinstance(current, dict) or set(current) - allowed:
            raise PackageError(f"{label} uses an unsupported portable-tool schema keyword")
        properties = current.get("properties", {})
        if not isinstance(properties, dict) or len(properties) > 64:
            raise PackageError(f"{label} properties are not bounded")
        pending.extend((child, depth + 1) for child in properties.values())
        for key in ("additionalProperties", "items"):
            if key in current:
                pending.append((current[key], depth + 1))
        if ("enum" in current
                and (not isinstance(current["enum"], list)
                     or len(current["enum"]) > 64)):
            raise PackageError(f"{label} enum is not bounded")
    _schema(schema, label)


def _portable_registries(manifest, files):
    tools = _registry(manifest.get("tools", {}), "tools")
    tool_fields = {
        "description", "ref", "input_schema", "output_schema", "effect_class",
        "runtime", "work_units_per_call",
    }
    for name, tool in tools.items():
        if set(tool) != tool_fields:
            raise PackageError(f"Portable tool {name!r} has an invalid declaration")
        if (not isinstance(tool["description"], str)
                or len(tool["description"]) > 5000):
            raise PackageError(f"Portable tool {name!r} description must be bounded text")
        if (tool["effect_class"] != "local_compute"
                or tool["runtime"] != PORTABLE_RUNTIME
                or type(tool["work_units_per_call"]) is not int
                or not 0 <= tool["work_units_per_call"] <= 1_000_000):
            raise PackageError(f"Portable tool {name!r} exceeds the pure runtime slice")
        _portable_tool_schema(
            tool["input_schema"], f"Portable tool {name!r} input schema")
        _portable_tool_schema(
            tool["output_schema"], f"Portable tool {name!r} output schema")
        _pure_entry(tool["ref"], files, function="execute",
                    label=f"Portable tool {name!r}")

    services = _registry(manifest.get("services", {}), "services")
    service_fields = {
        "name", "description", "ref", "service_interface", "input_schema",
        "output_schema", "effect_class", "runtime",
    }
    if set(services) - {MODEL_CONTEXT_INTERFACE}:
        raise PackageError("Portable services only support model_context.v1")
    for interface, service in services.items():
        if set(service) != service_fields:
            raise PackageError(
                f"Portable service {interface!r} has an invalid declaration")
        _identifier(service["name"], f"Portable service {interface!r} name")
        if (not isinstance(service["description"], str)
                or len(service["description"]) > 5000
                or service["service_interface"] != interface
                or service["effect_class"] != "model_context"
                or service["runtime"] != PORTABLE_RUNTIME
                or service["input_schema"] != MODEL_CONTEXT_INPUT_SCHEMA
                or service["output_schema"] != MODEL_CONTEXT_OUTPUT_SCHEMA):
            raise PackageError(
                f"Portable service {interface!r} exceeds the model-context slice")
        _pure_entry(service["ref"], files, function="provide",
                    label=f"Portable service {interface!r}")
    return tools, services


def _manifest_v2(manifest, files, entries, skills):
    """Validate the first-class registries introduced by manifest version 2."""
    missing = {"roles", "workflows", "components", "orchestrator"} - manifest.keys()
    if missing:
        raise PackageError("Manifest v2 needs roles, workflows, components, and orchestrator")

    roles = _registry(manifest["roles"], "roles")
    for name, role in roles.items():
        if "prompt_ref" in role:
            _resource(role["prompt_ref"], files, f"Role {name!r} prompt")
        capabilities = role.get("capabilities", [])
        if (not isinstance(capabilities, list)
                or any(not isinstance(item, str) or item not in CAPABILITIES
                       for item in capabilities)
                or len(set(capabilities)) != len(capabilities)):
            raise PackageError(f"Role {name!r} capabilities must be unique registered capabilities")

    workflows = _registry(manifest["workflows"], "workflows")
    for name, workflow in workflows.items():
        ref = _resource(workflow.get("ref"), files, f"Workflow {name!r}")
        if not ref.endswith(".json"):
            raise PackageError(f"Workflow {name!r} must reference a JSON resource")
        try:
            definition = json.loads(files[ref])
        except (ValueError, TypeError):
            raise PackageError(f"Workflow {name!r} is not valid JSON") from None
        if not isinstance(definition, dict):
            raise PackageError(f"Workflow {name!r} must contain an object")
        # Local import avoids the workflows -> packages capability import cycle.
        from .workflows import WorkflowError, _validate
        try:
            _validate(definition)
        except WorkflowError as exc:
            raise PackageError(f"Workflow {name!r} is invalid: {str(exc)[:500]}") from None
        _schema(workflow.get("input_schema", {}), f"Workflow {name!r} input schema")
        _schema(workflow.get("output_schema", {}), f"Workflow {name!r} output schema")
        if ("max_parallel" in workflow
                and (type(workflow["max_parallel"]) is not int
                     or not 1 <= workflow["max_parallel"] <= 256)):
            raise PackageError(f"Workflow {name!r} has an invalid parallelism ceiling")

    tools, services = _portable_registries(manifest, files)
    components = _registry(manifest["components"], "components")
    targets = set()
    file_classes = {}
    registries = {
        "role": roles, "workflow": workflows, "skill": skills, "entry": entries,
        "tool": tools, "service_provider": services,
    }
    for component_id, component in components.items():
        component_class = component.get("class")
        kind, ref = component.get("kind"), component.get("ref")
        if component_class not in COMPONENT_CLASSES:
            raise PackageError(f"Component {component_id!r} class must be O, M, or S")
        if kind not in COMPONENT_KINDS:
            raise PackageError(f"Component {component_id!r} has an unsupported kind")
        if kind == "resource":
            _resource(ref, files, f"Component {component_id!r}")
        else:
            _identifier(ref, f"Component {component_id!r} reference")
            if ref not in registries[kind]:
                raise PackageError(
                    f"Component {component_id!r} references an absent {kind}: {ref!r}")
        target = (kind, ref)
        if target in targets:
            raise PackageError(f"Duplicate component reference: {kind}:{ref}")
        targets.add(target)
        if kind == "entry":
            paths = (split_ref(entries[ref], files)[0],)
        elif kind == "skill":
            skill = skills[ref]
            paths = ((split_ref(skill["ref"], files)[0],) if skill["kind"] == "controlled_code"
                     else (skill["ref"],))
        elif kind == "workflow":
            paths = (workflows[ref]["ref"],)
        elif kind == "role":
            paths = ((roles[ref]["prompt_ref"],) if "prompt_ref" in roles[ref] else ())
        elif kind == "tool":
            paths = (split_ref(tools[ref]["ref"], files)[0],)
        elif kind == "service_provider":
            paths = (split_ref(services[ref]["ref"], files)[0],)
        else:
            paths = (ref,)
        for path in paths:
            previous = file_classes.get(path)
            if previous is not None and previous != component_class:
                raise PackageError(
                    f"Package file {path!r} cannot have both {previous} and {component_class} classes")
            file_classes[path] = component_class

    orchestrator = manifest["orchestrator"]
    _identifier(orchestrator, "Manifest orchestrator")
    component = components.get(orchestrator)
    if component is None:
        raise PackageError("Manifest orchestrator must reference a registered component")
    if component.get("class") != "O" or component.get("kind") not in {"entry", "workflow"}:
        raise PackageError("Manifest orchestrator must reference an O entry or workflow component")
    return file_classes


def _manifest_lineage(parent_manifest, child_manifest):
    parent_version = parent_manifest.get("manifest_version", 1)
    child_version = child_manifest.get("manifest_version", 1)
    if parent_version == MANIFEST_VERSION and child_version != MANIFEST_VERSION:
        raise PackageError("Manifest v2 lineage cannot downgrade to v1")
    if parent_version == child_version == MANIFEST_VERSION:
        parent_components = parent_manifest["components"]
        child_components = child_manifest["components"]
        for component_id in set(parent_components) & set(child_components):
            before, after = parent_components[component_id], child_components[component_id]
            if any(before.get(field) != after.get(field) for field in ("class", "kind", "ref")):
                raise PackageError(f"Stable component id changed classification or reference: {component_id}")


def manifest_component_classes(package):
    """Return authoritative file classifications for a validated v2 package."""
    verify_package(package)
    manifest = package["manifest"]
    if manifest.get("manifest_version", 1) != MANIFEST_VERSION:
        return None
    return _manifest_v2(
        manifest, package["files"], manifest["entries"], manifest.get("skills", {}))


def _content(files, manifest, provenance):
    if not isinstance(files, dict) or not files or len(files) > 256:
        raise PackageError("Package files must be a nonempty object of at most 256 text files")
    seen = set()
    for path, content in files.items():
        safe_path(path)
        folded = path.casefold()
        if folded in seen:
            raise PackageError("Package paths collide across platforms")
        seen.add(folded)
        if not isinstance(content, str) or len(content.encode("utf-8")) > 100_000:
            raise PackageError(f"Package file exceeds text budget: {path}")
        if path.endswith(".py"):
            try:
                validate_source(content, path, CAPABILITIES | LOCAL_METHODS)
            except (ProgramError, RecursionError) as exc:
                raise PackageError(str(exc)) from None
    if any("/".join(path.split("/")[:i]).casefold() in seen
           for path in files for i in range(1, len(path.split("/")))):
        raise PackageError("Package file and directory paths collide")
    if not isinstance(manifest, dict):
        raise PackageError("Package manifest must be an object")
    manifest_version = manifest.get("manifest_version", 1)
    if type(manifest_version) is not int or manifest_version not in {1, MANIFEST_VERSION}:
        raise PackageError("Unsupported AgentPackage manifest version")
    if manifest_version == 1 and V2_FIELDS.intersection(manifest):
        raise PackageError("Manifest v1 cannot contain manifest v2 fields")
    entries = manifest.get("entries")
    if not isinstance(entries, dict) or "execute" not in entries or set(entries) - {"execute", "improve"}:
        raise PackageError("Manifest needs execute and optional improve entries")
    for ref in entries.values():
        split_ref(ref, files)
    skills = manifest.get("skills", {})
    if not isinstance(skills, dict):
        raise PackageError("Manifest skills must be an object")
    for name, skill in skills.items():
        if (not isinstance(name, str) or not IDENTIFIER.fullmatch(name) or not isinstance(skill, dict)):
            raise PackageError("Skills need names and object definitions")
        kind, ref = skill.get("kind"), skill.get("ref")
        if kind not in {"controlled_code", "prompt_protocol", "workflow"}:
            raise PackageError(f"Skill {name!r} has an unsupported implementation kind")
        if kind == "controlled_code":
            split_ref(skill.get("ref"), files)
            ceiling_fields = {"allowed_rpc_methods", "allowed_tools"} & set(skill)
            if ceiling_fields and ceiling_fields != {
                    "allowed_rpc_methods", "allowed_tools"}:
                raise PackageError(
                    f"Skill {name!r} must declare both RPC and tool ceilings")
            if ceiling_fields:
                methods = skill["allowed_rpc_methods"]
                tools = skill["allowed_tools"]
                if (not isinstance(methods, list)
                        or any(not isinstance(method, str) or method not in CAPABILITIES
                               for method in methods)
                        or len(methods) != len(set(methods))):
                    raise PackageError(f"Skill {name!r} has an invalid RPC ceiling")
                if (not isinstance(tools, list)
                        or any(not isinstance(tool, str) or not tool or len(tool) > 120
                               for tool in tools)
                        or len(tools) != len(set(tools))
                        or tools and "tool" not in methods):
                    raise PackageError(f"Skill {name!r} has an invalid tool ceiling")
        else:
            safe_path(ref)
            if ref not in files:
                raise PackageError(f"Skill resource is absent: {ref!r}")
            if kind == "workflow":
                try:
                    workflow = json.loads(files[ref])
                except (ValueError, TypeError):
                    raise PackageError(f"Workflow skill is not valid JSON: {name}") from None
                if not isinstance(workflow, dict):
                    raise PackageError(f"Workflow skill must contain an object: {name}")
        _schema(skill.get("input_schema", {}), f"Skill {name!r} input schema")
        _schema(skill.get("output_schema", {}), f"Skill {name!r} output schema")
        if "max_tokens" in skill and (type(skill["max_tokens"]) is not int or not 1 <= skill["max_tokens"] <= 12000):
            raise PackageError(f"Skill {name!r} has an invalid token ceiling")
    if manifest_version == MANIFEST_VERSION:
        _manifest_v2(manifest, files, entries, skills)
    if not isinstance(provenance, dict):
        raise PackageError("Package provenance must be an object")
    try:
        serialized = canonical({"files": files, "manifest": manifest})
        if len(serialized.encode("utf-8")) > 1_000_000 or len(canonical(provenance).encode("utf-8")) > 100_000:
            raise PackageError("Package exceeds its total text budget")
    except (TypeError, ValueError, RecursionError) as exc:
        if isinstance(exc, PackageError):
            raise
        raise PackageError(f"Package metadata must be finite JSON: {exc}") from None


def _identity(content_digest, parent_id, generation):
    return "package-" + digest({"content": content_digest, "parent": parent_id, "generation": generation})[:24]


def make_package(files, manifest, parent=None, provenance=None):
    """Create a validated version from a complete tree, with optional lineage."""
    if parent is not None:
        verify_package(parent)
    provenance = {} if provenance is None else provenance
    _content(files, manifest, provenance)
    if parent is not None:
        _manifest_lineage(parent["manifest"], manifest)
    content_digest = digest({"files": files, "manifest": manifest})
    parent_id = parent["id"] if parent is not None else None
    generation = parent["generation"] + 1 if parent is not None else 0
    return {"schema": SCHEMA, "id": _identity(content_digest, parent_id, generation),
            "digest": content_digest, "parent_id": parent_id, "generation": generation,
            "files": deepcopy(files), "manifest": deepcopy(manifest),
            "component_digests": {path: digest(text) for path, text in files.items()},
            "provenance": deepcopy(provenance)}


def verify_package(package, parent=None):
    """Verify content and lineage; verify exact parent linkage when supplied."""
    required = {"schema", "id", "digest", "parent_id", "generation", "files", "manifest", "component_digests", "provenance"}
    if not isinstance(package, dict) or set(package) != required or package["schema"] != SCHEMA:
        raise PackageError("Invalid AgentPackage schema")
    _content(package["files"], package["manifest"], package["provenance"])
    generation, parent_id = package["generation"], package["parent_id"]
    if (type(generation) is not int or generation < 0
            or (parent_id is None) != (generation == 0)
            or parent_id is not None and not re.fullmatch(r"package-[0-9a-f]{24}", str(parent_id))):
        raise PackageError("Invalid package lineage")
    content_digest = digest({"files": package["files"], "manifest": package["manifest"]})
    if package["digest"] != content_digest or package["id"] != _identity(content_digest, parent_id, generation):
        raise PackageError("Package content or lineage identity mismatch")
    if package["component_digests"] != {path: digest(text) for path, text in package["files"].items()}:
        raise PackageError("Package component identity mismatch")
    if parent is not None:
        verify_package(parent)
        if parent_id != parent["id"] or generation != parent["generation"] + 1:
            raise PackageError("Package does not descend from the supplied parent")
        _manifest_lineage(parent["manifest"], package["manifest"])
    return package
