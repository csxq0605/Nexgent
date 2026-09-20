"""Installed host capabilities and local JSON schemas, independent of domains."""

from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
from importlib.metadata import entry_points
import json
import re
from typing import Callable

from jsonschema import Draft202012Validator, ValidationError, validators


class ContractError(ValueError):
    pass


_ARTIFACT_REF_KEY = "x-nexgent-artifact-ref"


def artifact_ref_schema(*, nullable=False):
    """Return a JSON Schema leaf for a task-visible artifact identity."""
    return {"type": ["string", "null"] if nullable else "string",
            "minLength": 1, _ARTIFACT_REF_KEY: True}


def check_contract_schema(schema, *, allow_artifact_refs=False):
    """Validate a local JSON Schema and the Nexgent artifact-ref extension."""
    if not isinstance(schema, (dict, bool)):
        raise ContractError("Schema must be a JSON Schema object or boolean")

    # Walk schema-valued keyword positions only. Values under ``const``, ``enum``,
    # ``examples`` and property names are instance data, even when they happen to
    # contain a key with the same spelling as our extension keyword.
    mapping_keywords = {
        "$defs", "definitions", "dependentSchemas", "properties",
        "patternProperties",
    }
    single_keywords = {
        "additionalProperties", "contains", "else", "if", "items", "not",
        "propertyNames", "then", "unevaluatedItems",
        "unevaluatedProperties",
    }
    array_keywords = {"allOf", "anyOf", "oneOf", "prefixItems"}

    def schema_children(item):
        if not isinstance(item, dict):
            return
        for keyword in mapping_keywords:
            values = item.get(keyword)
            if isinstance(values, dict):
                yield from (child for child in values.values()
                            if isinstance(child, (dict, bool)))
        for keyword in single_keywords:
            child = item.get(keyword)
            if isinstance(child, (dict, bool)):
                yield child
        for keyword in array_keywords:
            children = item.get(keyword)
            if isinstance(children, list):
                yield from (child for child in children
                            if isinstance(child, (dict, bool)))

    pending = [schema]
    while pending:
        item = pending.pop()
        if not isinstance(item, dict):
            continue
        if _ARTIFACT_REF_KEY in item:
            declared = item[_ARTIFACT_REF_KEY]
            if declared is not True:
                raise ContractError("Artifact-reference annotations must be true")
            if not allow_artifact_refs:
                raise ContractError("Artifact-reference annotations are only valid in tool inputs")
        for keyword in ("$ref", "$dynamicRef"):
            if keyword in item:
                reference = item[keyword]
                if not isinstance(reference, str) or not reference.startswith("#"):
                    raise ContractError("Schemas may only reference local definitions")
        # The installed Draft 2020-12 validator does not execute the legacy
        # ``dependencies`` keyword or validate decoded content against
        # ``contentSchema``. Reject our extension there instead of accepting a
        # contract which can never run.
        def contains_marker(value):
            if isinstance(value, dict):
                return (_ARTIFACT_REF_KEY in value
                        or any(contains_marker(child) for child in value.values()))
            if isinstance(value, list):
                return any(contains_marker(child) for child in value)
            return False

        for unsupported in ("dependencies", "contentSchema"):
            if unsupported in item and contains_marker(item[unsupported]):
                raise ContractError(
                    f"Artifact-reference annotations are not supported under {unsupported}")
        pending.extend(schema_children(item))
    Draft202012Validator.check_schema(schema)


def _contract_error(errors, label):
    error = next(iter(errors), None)
    if error is None:
        return
    # Prefer the actionable leaf emitted by the artifact-reference keyword.
    pending = [error]
    selected = error
    while pending:
        current = pending.pop(0)
        if current.validator == _ARTIFACT_REF_KEY:
            selected = current
            break
        pending.extend(current.context)
    location = "/".join(str(part) for part in selected.absolute_path)
    raise ContractError(
        f"{label}{'/' + location if location else ''}: {selected.message[:800]}")


def validate(value, schema, *, label="value", allow_artifact_refs=False):
    """Validate JSON without permitting schemas to retrieve remote resources."""
    json.dumps(value, allow_nan=False)
    check_contract_schema(schema, allow_artifact_refs=allow_artifact_refs)
    errors = list(Draft202012Validator(schema).iter_errors(value))
    _contract_error(errors, label)


def validate_tool_input(value, schema, *, artifact_resolver, label="tool input"):
    """Validate one tool input and resolve artifact refs through JSON Schema semantics."""
    json.dumps(value, allow_nan=False)
    check_contract_schema(schema, allow_artifact_refs=True)

    def artifact_ref(validator, declared, instance, subschema):
        if declared is not True or instance is None:
            return
        if not isinstance(instance, str) or not re.fullmatch(
                r"artifact-[0-9a-f]{16}", instance):
            yield ValidationError(
                "must be an actual artifact ID returned by the host",
                validator=_ARTIFACT_REF_KEY, validator_value=declared,
                instance=instance, schema=subschema)
            return
        try:
            artifact_resolver(instance)
        except (KeyError, PermissionError):
            yield ValidationError(
                "must reference an accessible artifact supplied by the host or returned by "
                "a completed action",
                validator=_ARTIFACT_REF_KEY, validator_value=declared,
                instance=instance, schema=subschema)

    validator_class = validators.extend(
        Draft202012Validator, {_ARTIFACT_REF_KEY: artifact_ref})
    _contract_error(list(validator_class(schema).iter_errors(value)), label)


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
        check_contract_schema(tool.input_schema, allow_artifact_refs=True)
        check_contract_schema(tool.output_schema, allow_artifact_refs=False)
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


def task_benchmarks(project_root=None):
    """Compatibility facade over the canonical isolated benchmark registry."""
    from .benchmarks import BenchmarkRegistry
    return BenchmarkRegistry(project_root).adapters()
