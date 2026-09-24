"""Installed host capabilities and local JSON schemas, independent of domains."""

from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
from importlib.metadata import entry_points
import hashlib
import json
import re
import threading
from typing import Callable

from jsonschema import Draft202012Validator, ValidationError, validators


class ContractError(ValueError):
    pass


_ARTIFACT_REF_KEY = "x-nexgent-artifact-ref"
TOOL_INTERFACE = "nexgent.tool.v1"
TOOL_PROVIDER_INTERFACE = "nexgent.tool-provider.v1"
CAPABILITY_INVENTORY_SCHEMA = "nexgent.capability-inventory.v1"


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
    work_units_per_call: int = 0
    provider_id: str = ""
    provider_version: str = ""
    handler_digest: str = ""

    def describe(self):
        return {"name": self.name, "description": self.description,
                "input_schema": deepcopy(self.input_schema), "output_schema": deepcopy(self.output_schema),
                "effect_class": self.effect_class,
                "work_units_per_call": self.work_units_per_call}


@dataclass(frozen=True)
class ToolProvider:
    """One trusted host implementation of the versioned tool-provider contract.

    ``handler_digest`` on each tool remains an identity asserted by this trusted
    provider.  It is useful for durable Episode leases and drift detection, but
    it is not a measurement of the Python bytes executing in the host process.
    """

    provider_id: str
    provider_version: str
    tools: tuple[ToolSpec, ...]
    declared_operations: tuple[str, ...] = ()
    dependencies: tuple[str, ...] = ()
    runtime: str = "host-python-v1"
    interface: str = TOOL_PROVIDER_INTERFACE

class ToolRegistry:
    def __init__(self, tools=()):
        self._lock = threading.RLock()
        self._tools = {}
        self._tool_owners = {}
        self._providers = {}
        self.domains = []
        self.unavailable = []
        for tool in tools:
            self.register(tool)

    @staticmethod
    def _validate_tool(tool):
        if not isinstance(tool, ToolSpec) or not callable(tool.handler):
            raise ContractError("Installed tools must supply a ToolSpec and host handler")
        if not isinstance(tool.name, str) or not tool.name or len(tool.name) > 120:
            raise ContractError("Tool names must be nonempty and bounded")
        if tool.effect_class not in {"read", "artifact_write", "local_compute", "external_compute"}:
            raise ContractError("Tool effect class is not supported by this host")
        if type(tool.work_units_per_call) is not int or tool.work_units_per_call < 0:
            raise ContractError("Tool work-unit reservation must be a nonnegative integer")
        check_contract_schema(tool.input_schema, allow_artifact_refs=True)
        check_contract_schema(tool.output_schema, allow_artifact_refs=False)

    @staticmethod
    def _snapshot_tool(tool):
        """Copy a declaration while retaining its trusted executable handler."""
        return ToolSpec(
            name=tool.name,
            input_schema=deepcopy(tool.input_schema),
            output_schema=deepcopy(tool.output_schema),
            effect_class=tool.effect_class,
            handler=tool.handler,
            description=tool.description,
            work_units_per_call=tool.work_units_per_call,
            provider_id=tool.provider_id,
            provider_version=tool.provider_version,
            handler_digest=tool.handler_digest,
        )

    @classmethod
    def _snapshot_provider(cls, provider):
        return ToolProvider(
            provider_id=provider.provider_id,
            provider_version=provider.provider_version,
            tools=tuple(cls._snapshot_tool(tool) for tool in provider.tools),
            declared_operations=tuple(provider.declared_operations),
            dependencies=tuple(provider.dependencies),
            runtime=provider.runtime,
            interface=provider.interface,
        )

    def register(self, tool):
        """Register one legacy direct tool without changing its public contract."""
        self._validate_tool(tool)
        snapshot = self._snapshot_tool(tool)
        with self._lock:
            if snapshot.name in self._tools:
                raise ContractError("Tool names must be nonempty, bounded and unique")
            self._tools[snapshot.name] = snapshot
            self._tool_owners[snapshot.name] = None

    @staticmethod
    def _validate_provider(provider):
        if not isinstance(provider, ToolProvider):
            raise ContractError("Tool providers must implement ToolProvider")
        if provider.interface != TOOL_PROVIDER_INTERFACE:
            raise ContractError("Tool provider interface version is unsupported")
        if (not isinstance(provider.provider_id, str)
                or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_.-]{0,119}", provider.provider_id)):
            raise ContractError("Tool provider id must be a bounded identifier")
        if (not isinstance(provider.provider_version, str)
                or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.+-]{0,119}",
                                    provider.provider_version)):
            raise ContractError("Tool provider version must be bounded text")
        if (not isinstance(provider.runtime, str)
                or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_.-]{0,119}", provider.runtime)):
            raise ContractError("Tool provider runtime must be a bounded identifier")
        if not isinstance(provider.tools, tuple) or not provider.tools:
            raise ContractError("Tool provider tools must be a nonempty immutable tuple")
        names = []
        for tool in provider.tools:
            ToolRegistry._validate_tool(tool)
            if (tool.provider_id != provider.provider_id
                    or tool.provider_version != provider.provider_version
                    or not isinstance(tool.handler_digest, str)
                    or not re.fullmatch(r"[0-9a-f]{64}", tool.handler_digest)):
                raise ContractError(
                    "Provider tools require matching provider identity and a declared handler SHA-256")
            names.append(tool.name)
        if len(names) != len(set(names)):
            raise ContractError("Tool provider names must be unique")
        if (not isinstance(provider.declared_operations, tuple)
                or any(not isinstance(item, str)
                       or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_.:-]{0,159}", item)
                       for item in provider.declared_operations)
                or len(provider.declared_operations) != len(set(provider.declared_operations))):
            raise ContractError("Provider operations must be unique bounded identifiers")
        if (not isinstance(provider.dependencies, tuple)
                or any(not isinstance(item, str)
                       or not re.fullmatch(r"[A-Za-z0-9_.-]+==[^\s=]{1,120}", item)
                       for item in provider.dependencies)
                or len(provider.dependencies) != len(set(provider.dependencies))):
            raise ContractError("Provider dependencies must use unique exact name==version pins")

    @staticmethod
    def _provider_record(provider):
        tools = []
        for tool in sorted(provider.tools, key=lambda item: item.name):
            tools.append({
                **tool.describe(),
                "interface": TOOL_INTERFACE,
                "provider_id": provider.provider_id,
                "provider_version": provider.provider_version,
                "handler_identity": {
                    "kind": "provider_declared_sha256",
                    "digest": tool.handler_digest,
                },
            })
        record = {
            "interface": provider.interface,
            "provider_id": provider.provider_id,
            "provider_version": provider.provider_version,
            "runtime": provider.runtime,
            "declared_operations": sorted(provider.declared_operations),
            "dependencies": sorted(provider.dependencies),
            "tools": tools,
        }
        encoded = json.dumps(
            record, ensure_ascii=False, sort_keys=True, separators=(",", ":"),
            allow_nan=False).encode("utf-8")
        record["digest"] = hashlib.sha256(encoded).hexdigest()
        return record

    def register_provider(self, provider, *, replace=False):
        """Atomically install or replace one trusted host tool provider.

        Replacement may reuse names owned by the same provider.  It cannot
        capture a legacy tool or a name owned by another provider.  Existing
        leased Episodes keep their frozen descriptor and therefore fail closed
        if the provider version or declared handler identity has changed.  The
        registry switch is atomic for resolution and inventory readers; it does
        not stop a handler that a caller resolved before the switch.
        """
        self._validate_provider(provider)
        provider = self._snapshot_provider(provider)
        self._validate_provider(provider)
        with self._lock:
            previous = self._providers.get(provider.provider_id)
            if previous is not None and not replace:
                raise ContractError("Tool provider is already registered")
            previous_names = ({tool.name for tool in previous.tools}
                              if previous is not None else set())
            for tool in provider.tools:
                owner = self._tool_owners.get(tool.name)
                if tool.name in self._tools and not (
                        owner == provider.provider_id and tool.name in previous_names):
                    raise ContractError(
                        f"Tool provider cannot replace a capability it does not own: {tool.name}")

            # Validation and collision checks happen before the three maps move
            # under the same registry lock, so readers see one coherent version.
            next_tools = dict(self._tools)
            next_owners = dict(self._tool_owners)
            for name in previous_names:
                next_tools.pop(name, None)
                next_owners.pop(name, None)
            for tool in provider.tools:
                next_tools[tool.name] = tool
                next_owners[tool.name] = provider.provider_id
            self._tools = next_tools
            self._tool_owners = next_owners
            self._providers = {**self._providers, provider.provider_id: provider}
            return deepcopy(self._provider_record(provider))

    def unregister_provider(self, provider_id, *, expected_version):
        """Remove one provider using an exact version guard."""
        with self._lock:
            provider = self._providers.get(provider_id)
            if provider is None:
                raise ContractError(f"Tool provider is not registered: {provider_id}")
            if provider.provider_version != expected_version:
                raise ContractError("Tool provider version changed before unload")
            record = self._provider_record(provider)
            self._tools = {name: tool for name, tool in self._tools.items()
                           if self._tool_owners.get(name) != provider_id}
            self._tool_owners = {name: owner for name, owner in self._tool_owners.items()
                                 if owner != provider_id}
            self._providers = {key: value for key, value in self._providers.items()
                               if key != provider_id}
            return deepcopy(record)

    def capability_inventory(self):
        """Return the versioned host inventory without executable handlers."""
        with self._lock:
            provider_records = [
                self._provider_record(provider)
                for _, provider in sorted(self._providers.items())
            ]
            managed = {tool["name"]: tool for provider in provider_records
                       for tool in provider["tools"]}
            tools = []
            for name, tool in sorted(self._tools.items()):
                if name in managed:
                    tools.append(deepcopy(managed[name]))
                    continue
                handler_identity = None
                if re.fullmatch(r"[0-9a-f]{64}", tool.handler_digest or ""):
                    handler_identity = {
                        "kind": "provider_declared_sha256",
                        "digest": tool.handler_digest,
                    }
                tools.append({
                    **tool.describe(),
                    "interface": TOOL_INTERFACE,
                    "provider_id": tool.provider_id or None,
                    "provider_version": tool.provider_version or None,
                    "handler_identity": handler_identity,
                    "registration": "legacy_direct",
                })
            return {
                "schema": CAPABILITY_INVENTORY_SCHEMA,
                "version": 1,
                "providers": provider_records,
                "tools": tools,
            }

    def get(self, name):
        with self._lock:
            if name not in self._tools:
                raise ContractError(f"Capability is not installed: {name}")
            # ToolSpec is frozen but its JSON Schemas are mutable mappings.  Return
            # a declaration copy so callers cannot rewrite the registered snapshot.
            return self._snapshot_tool(self._tools[name])

    def describe(self, allowed=None):
        with self._lock:
            names = sorted(self._tools) if allowed is None else allowed
            return [self.get(name).describe() for name in names]

    def lease_descriptor(self, name):
        """Freeze a trusted host tool's implementation identity for one Episode."""
        with self._lock:
            tool = self.get(name)
            if (not tool.provider_id or not tool.provider_version
                    or not re.fullmatch(r"[0-9a-f]{64}", tool.handler_digest)):
                raise ContractError("Leased tools require a provider, version and handler SHA-256")
            descriptor = {**tool.describe(), "provider_id": tool.provider_id,
                          "provider_version": tool.provider_version,
                          "handler_digest": tool.handler_digest}
            encoded = json.dumps(descriptor, ensure_ascii=False, sort_keys=True,
                                 separators=(",", ":"), allow_nan=False).encode("utf-8")
            descriptor["digest"] = hashlib.sha256(encoded).hexdigest()
            return descriptor

    def resolve_lease(self, record):
        """Fail closed if the installed tool differs from a durable lease."""
        with self._lock:
            if not isinstance(record, dict) or record.get("status") != "active":
                raise ContractError("Capability lease is not active")
            descriptor = self.lease_descriptor(record["name"])
            if descriptor != record.get("descriptor"):
                raise ContractError("Installed tool differs from the frozen capability lease")
            return self.get(record["name"])

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
                with registry._lock:
                    registry._tools = trial._tools
                    registry._tool_owners = trial._tool_owners
                    registry._providers = trial._providers
                    registry.domains.append({**metadata, "environment": probe,
                                             "tools": [tool.name for tool in tools]})
            except Exception as exc:
                registry.unavailable.append({"id": point.name, "error": f"{type(exc).__name__}: {str(exc)[:500]}"})
        return registry


def task_benchmarks(project_root=None):
    """Compatibility facade over the canonical isolated benchmark registry."""
    from .benchmarks import BenchmarkRegistry
    return BenchmarkRegistry(project_root).adapters()
