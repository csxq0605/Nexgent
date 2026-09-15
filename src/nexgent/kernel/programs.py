"""Content-addressed source programs, independent of frozen evaluator identity."""

from __future__ import annotations

import ast
import hashlib
import json
from copy import deepcopy


class ProgramError(ValueError):
    pass


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


PURE_METHODS = {
    "get", "items", "keys", "values", "copy", "update", "append", "extend", "pop",
    "sort", "reverse", "count", "index", "join", "split", "strip", "lower", "upper",
    "replace", "startswith", "endswith", "remove", "add", "discard", "setdefault",
    "ask", "parallel", "experiment", "search", "log", "sin", "cos", "tan", "tanh",
    "exp", "log1p", "sqrt", "floor", "ceil", "fabs", "isfinite", "isnan", "isinf",
    "pi", "e", "work_units", "pow", "copysign", "atan2", "hypot", "asin", "acos",
}
FORBIDDEN_NAMES = {
    "eval", "exec", "compile", "open", "input", "getattr", "setattr", "delattr", "vars",
    "globals", "locals", "type", "object", "super", "breakpoint", "help", "dir",
    "memoryview", "classmethod", "staticmethod", "property", "exit", "quit", "print",
}


def validate_source(source, filename, tool_methods=()):
    if not isinstance(source, str) or len(source.encode()) > 100_000:
        raise ProgramError(f"{filename}: source must be text within 100 KB")
    try:
        tree = ast.parse(source, filename=filename)
    except (SyntaxError, RecursionError) as exc:
        raise ProgramError(f"{filename}: invalid Python syntax: {exc}") from None
    allowed_attributes = PURE_METHODS | set(tool_methods)
    nodes = list(ast.walk(tree))
    if len(nodes) > 18000:
        raise ProgramError(f"{filename}: source syntax exceeds complexity budget")
    forbidden_nodes = (ast.Import, ast.ImportFrom, ast.ClassDef, ast.AsyncFunctionDef,
                       ast.Await, ast.Global, ast.Nonlocal, ast.With, ast.AsyncWith, ast.Match)
    for node in nodes:
        if isinstance(node, forbidden_nodes):
            raise ProgramError(f"{filename}: {type(node).__name__} is not a granted capability")
        if isinstance(node, ast.Name) and (node.id.startswith("_") or node.id in FORBIDDEN_NAMES):
            raise ProgramError(f"{filename}: name {node.id!r} is not permitted")
        if isinstance(node, ast.Attribute) and (node.attr.startswith("_") or node.attr not in allowed_attributes):
            raise ProgramError(f"{filename}: attribute {node.attr!r} is not permitted")
        if isinstance(node, ast.Attribute) and not isinstance(node.ctx, ast.Load):
            raise ProgramError(f"{filename}: capability attributes are read-only")
        if isinstance(node, ast.FunctionDef) and (node.decorator_list or node.name.startswith("_")):
            raise ProgramError(f"{filename}: decorators/private function names are not permitted")
        if isinstance(node, ast.arg) and node.arg.startswith("_"):
            raise ProgramError(f"{filename}: private parameter names are not permitted")
    return tree


def make_bundle(files, parent=None, rationale="", provenance=None):
    if not isinstance(files, dict):
        raise ProgramError("Source files must be an object")
    merged = deepcopy(parent["files"]) if parent else {}
    merged.update(deepcopy(files))
    allowed = {"task.py", "meta.py", "workflow.py", "roles.json"}
    if not {"task.py", "meta.py"}.issubset(merged) or not set(merged).issubset(allowed):
        raise ProgramError("A program needs task.py and meta.py; optional workflow.py and roles.json")
    for name, content in merged.items():
        if not isinstance(content, str) or len(content.encode()) > 100_000:
            raise ProgramError(f"Invalid source file {name}")
        if name.endswith(".py"):
            try:
                ast.parse(content, filename=name)
            except SyntaxError as exc:
                raise ProgramError(f"{name}: {exc}") from None
        else:
            try:
                if not isinstance(json.loads(content), dict):
                    raise ValueError("roles must be an object")
            except ValueError as exc:
                raise ProgramError(f"roles.json: {exc}") from None
    if len(canonical(merged)) > 240_000:
        raise ProgramError("Combined source exceeds the program size budget")
    content_digest = digest(merged)
    parent_id = parent["id"] if parent else None
    return {"id": "agent-" + digest({"source": content_digest, "parent": parent_id})[:20],
            "digest": content_digest, "parent_id": parent_id,
            "generation": parent["generation"] + 1 if parent else 0,
            "files": merged, "component_digests": {n: digest(s) for n, s in merged.items()},
            "rationale": str(rationale)[:16000], "provenance": deepcopy(provenance or {})}


def verify_bundle(bundle):
    recreated = make_bundle(bundle["files"], rationale=bundle.get("rationale", ""))
    expected_id = "agent-" + digest({"source": recreated["digest"], "parent": bundle.get("parent_id")})[:20]
    if bundle["digest"] != recreated["digest"] or bundle["id"] != expected_id:
        raise ProgramError("Source identity mismatch")
    if bundle["component_digests"] != recreated["component_digests"]:
        raise ProgramError("Source component identity mismatch")
    if type(bundle["generation"]) is not int or bundle["generation"] < 0:
        raise ProgramError("Invalid source generation")
    if bundle.get("parent_id") is None and bundle["generation"] != 0:
        raise ProgramError("A root source bundle must have generation zero")


def splice(task_bundle, meta_bundle):
    files = dict(meta_bundle["files"])
    files["task.py"] = task_bundle["files"]["task.py"]
    return make_bundle(files, rationale="Counterfactual task/improver module replacement",
                       provenance={"task_origin": task_bundle["id"], "meta_origin": meta_bundle["id"]})
