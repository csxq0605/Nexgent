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
CAPABILITIES = frozenset({"ask", "tool", "parallel", "skill", "delegate", "read_artifact",
                          "publish", "memory_search", "remember", "plan", "feedback"})
LOCAL_METHODS = frozenset({"call", "resource"})


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
    entries = manifest.get("entries")
    if not isinstance(entries, dict) or "execute" not in entries or set(entries) - {"execute", "improve"}:
        raise PackageError("Manifest needs execute and optional improve entries")
    for ref in entries.values():
        split_ref(ref, files)
    skills = manifest.get("skills", {})
    if not isinstance(skills, dict):
        raise PackageError("Manifest skills must be an object")
    for name, skill in skills.items():
        if (not isinstance(name, str) or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_.-]{0,99}", name)
                or not isinstance(skill, dict)):
            raise PackageError("Skills need names and object definitions")
        kind, ref = skill.get("kind"), skill.get("ref")
        if kind not in {"controlled_code", "prompt_protocol", "workflow"}:
            raise PackageError(f"Skill {name!r} has an unsupported implementation kind")
        if kind == "controlled_code":
            split_ref(skill.get("ref"), files)
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
    if not isinstance(package, dict) or not required.issubset(package) or package["schema"] != SCHEMA:
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
    return package
