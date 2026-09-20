"""Installed host capabilities and local JSON schemas, independent of domains."""

from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
from importlib.metadata import entry_points
import json
from typing import Callable

from jsonschema import Draft202012Validator


class ContractError(ValueError):
    pass


def validate(value, schema, *, label="value"):
    """Validate JSON without permitting schemas to retrieve remote resources."""
    json.dumps(value, allow_nan=False)
    if not isinstance(schema, (dict, bool)):
        raise ContractError(f"{label}: schema must be a JSON Schema object or boolean")

    def check_refs(item):
        if isinstance(item, dict):
            for key, content in item.items():
                if key in {"$ref", "$dynamicRef"} and (not isinstance(content, str) or not content.startswith("#")):
                    raise ContractError("Schemas may only reference local definitions")
                check_refs(content)
        elif isinstance(item, list):
            for child in item:
                check_refs(child)

    check_refs(schema)
    Draft202012Validator.check_schema(schema)
    errors = list(Draft202012Validator(schema).iter_errors(value))
    if errors:
        error = errors[0]
        location = "/".join(str(part) for part in error.absolute_path)
        raise ContractError(f"{label}{'/' + location if location else ''}: {error.message[:800]}")


@dataclass(frozen=True)
class ToolSpec:
    name: str
    input_schema: dict
    output_schema: dict
    effect_class: str
    handler: Callable
    description: str = ""

    def describe(self):
        return {"name": self.name, "description": self.description,
                "input_schema": deepcopy(self.input_schema), "output_schema": deepcopy(self.output_schema),
                "effect_class": self.effect_class}


class ToolRegistry:
    def __init__(self, tools=()):
        self._tools = {}
        self.domains = []
        self.unavailable = []
        for tool in tools:
            self.register(tool)

    def register(self, tool):
        if not isinstance(tool, ToolSpec) or not callable(tool.handler):
            raise ContractError("Installed tools must supply a ToolSpec and host handler")
        if not tool.name or len(tool.name) > 120 or tool.name in self._tools:
            raise ContractError("Tool names must be nonempty, bounded and unique")
        if tool.effect_class not in {"read", "artifact_write", "local_compute", "external_compute"}:
            raise ContractError("Tool effect class is not supported by this host")
        Draft202012Validator.check_schema(tool.input_schema)
        Draft202012Validator.check_schema(tool.output_schema)
        self._tools[tool.name] = tool

    def get(self, name):
        if name not in self._tools:
            raise ContractError(f"Capability is not installed: {name}")
        return self._tools[name]

    def describe(self, allowed=None):
        names = sorted(self._tools) if allowed is None else allowed
        return [self.get(name).describe() for name in names]

    @classmethod
    def discover(cls):
        registry = cls()
        for point in sorted(entry_points(group="nexgent.domains"), key=lambda point: point.name):
            try:
                domain = point.load()()
                metadata = domain.describe()
                probe = domain.environment_probe() if hasattr(domain, "environment_probe") else {"available": True}
                tools = list(domain.tools())
                # Install a domain atomically; malformed plugins leave no partial grant.
                trial = cls(list(registry._tools.values()) + tools)
                registry._tools = trial._tools
                registry.domains.append({**metadata, "environment": probe,
                                         "tools": [tool.name for tool in tools]})
            except Exception as exc:
                registry.unavailable.append({"id": point.name, "error": f"{type(exc).__name__}: {str(exc)[:500]}"})
        return registry


def task_benchmarks():
    result = {}
    for point in entry_points(group="nexgent.task_benchmarks"):
        if point.name in result:
            raise ContractError("Duplicate task benchmark identity")
        result[point.name] = point.load()()
    return result
