"""Canonical contracts and isolated discovery for TaskService benchmarks.

This SDK is deliberately separate from ``nexgent.domains``.  A domain pack
grants public tools; a benchmark adapter owns task sampling and host-only
evaluation.  The preserved 0.8 ``nexgent.benchmarks`` source-bundle API is a
different, legacy interface and is not discovered here.
"""

from __future__ import annotations

from copy import deepcopy
from dataclasses import asdict, dataclass
import hashlib
from importlib.metadata import entry_points
import json
import math
from pathlib import Path
import re
from typing import Protocol, runtime_checkable

from .tools import ContractError


ENTRY_POINT_GROUP = "nexgent.task_benchmarks"
SDK_SCHEMA = "nexgent.task-benchmark-sdk.v1"
_IDENTIFIER = re.compile(r"[a-z][a-z0-9_.-]{0,99}")
_MODES = frozenset({"fixed", "confirmatory", "recovery"})


def _json_copy(value, label):
    try:
        return json.loads(json.dumps(value, ensure_ascii=False, allow_nan=False))
    except (TypeError, ValueError, RecursionError) as exc:
        raise ContractError(f"{label} must be finite JSON: {str(exc)[:500]}") from None


def _text(value, label, *, maximum=5000):
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise ContractError(f"{label} must be nonempty bounded text")
    return value


def _identifier(value, label):
    if not isinstance(value, str) or _IDENTIFIER.fullmatch(value) is None:
        raise ContractError(f"{label} must be a bounded lowercase identifier")
    return value


@dataclass(frozen=True)
class BenchmarkDescriptor:
    """Stable public identity and declared support for a task benchmark."""

    id: str
    version: str
    title: str
    splits: tuple[str, ...]
    default_split: str
    modes: tuple[str, ...] = ("fixed",)
    required_capabilities: tuple[str, ...] = ()
    evidence_scope: str = "Benchmark-local task evaluation"

    def __post_init__(self):
        _identifier(self.id, "Benchmark id")
        _text(self.version, "Benchmark version", maximum=200)
        _text(self.title, "Benchmark title", maximum=500)
        _text(self.evidence_scope, "Benchmark evidence scope")
        if (not isinstance(self.splits, tuple) or not self.splits
                or any(not isinstance(value, str) or not value or len(value) > 200
                       for value in self.splits)
                or len(set(self.splits)) != len(self.splits)):
            raise ContractError("Benchmark splits must be unique bounded names")
        if self.default_split not in self.splits:
            raise ContractError("Benchmark default split must be declared in splits")
        if (not isinstance(self.modes, tuple) or not self.modes
                or set(self.modes) - _MODES or len(set(self.modes)) != len(self.modes)):
            raise ContractError("Benchmark modes are invalid")
        if (not isinstance(self.required_capabilities, tuple)
                or any(not isinstance(value, str) or not value or len(value) > 120
                       for value in self.required_capabilities)
                or len(set(self.required_capabilities)) != len(self.required_capabilities)):
            raise ContractError("Benchmark capabilities must be unique bounded names")

    def as_dict(self):
        value = asdict(self)
        for name in ("splits", "modes", "required_capabilities"):
            value[name] = list(value[name])
        return value


@runtime_checkable
class BenchmarkAdapter(Protocol):
    """Canonical adapter surface consumed by TaskService benchmark workflows."""

    id: str
    descriptor: BenchmarkDescriptor

    def describe(self) -> dict: ...
    def snapshot(self) -> dict: ...
    def tasks(self, split: str, seed: int, **options) -> list[dict]: ...
    def evaluate(self, task_ref: dict, deliverables: dict,
                 execution_view: dict) -> dict: ...


def descriptor_of(adapter, *, entry_name=None, require_explicit=True):
    """Validate an adapter descriptor.

    ``require_explicit=False`` exists only for directly injected test and host
    adapters during the first SDK migration phase.  Installed entry points
    must expose ``BenchmarkDescriptor`` explicitly.
    """
    value = getattr(adapter, "descriptor", None)
    if not isinstance(value, BenchmarkDescriptor):
        if require_explicit:
            raise ContractError("Installed task benchmark must expose BenchmarkDescriptor")
        identity = _identifier(getattr(adapter, "id", ""), "Benchmark id")
        metadata = adapter.describe() if callable(getattr(adapter, "describe", None)) else {}
        metadata = _json_copy(metadata, "Benchmark description")
        if not isinstance(metadata, dict):
            raise ContractError("Benchmark description must be a JSON object")
        splits = metadata.get("splits") or ["development"]
        if not isinstance(splits, list):
            raise ContractError("Benchmark description splits must be a list")
        value = BenchmarkDescriptor(
            id=identity,
            version=str(metadata.get("version", "injected-v1")),
            title=str(metadata.get("title", identity)),
            splits=tuple(splits),
            default_split=str(metadata.get("default_split", splits[0])),
            evidence_scope=str(metadata.get("research_scope") or metadata.get("evidence_scope")
                               or "Directly injected benchmark adapter"),
        )
    if getattr(adapter, "id", None) != value.id:
        raise ContractError("Benchmark descriptor and adapter identity differ")
    if entry_name is not None and entry_name != value.id:
        raise ContractError("Benchmark entry point and adapter identity differ")
    return value


def describe_adapter(adapter, *, require_explicit=False):
    descriptor = descriptor_of(adapter, require_explicit=require_explicit)
    extra = adapter.describe() if callable(getattr(adapter, "describe", None)) else {}
    extra = _json_copy(extra, "Benchmark description")
    if not isinstance(extra, dict):
        raise ContractError("Benchmark description must be a JSON object")
    if extra.get("id", descriptor.id) != descriptor.id:
        raise ContractError("Benchmark description and descriptor identity differ")
    return {**extra, **descriptor.as_dict(), "sdk_schema": SDK_SCHEMA}


def validate_adapter(adapter, *, entry_name=None, require_descriptor=False):
    descriptor_of(adapter, entry_name=entry_name, require_explicit=require_descriptor)
    for name in ("snapshot", "tasks", "evaluate"):
        if not callable(getattr(adapter, name, None)):
            raise ContractError("Benchmark adapter is missing method: " + name)
    describe_adapter(adapter, require_explicit=require_descriptor)
    validate_snapshot(adapter.snapshot())
    return adapter


def validate_snapshot(value):
    value = _json_copy(value, "Benchmark snapshot")
    if not isinstance(value, dict):
        raise ContractError("Benchmark snapshot must be a JSON object")
    return value


def validate_tasks(value):
    try:
        rows = list(value)
    except TypeError as exc:
        raise ContractError("Benchmark tasks must be iterable") from exc
    rows = _json_copy(rows, "Benchmark tasks")
    for row in rows:
        if not isinstance(row, dict):
            raise ContractError("Benchmark tasks must be JSON objects")
        _text(row.get("id"), "Benchmark task id", maximum=500)
        _text(row.get("objective"), "Benchmark task objective", maximum=20000)
        for name, expected in (("inputs", dict), ("context", dict),
                               ("constraints", dict), ("deliverables", list),
                               ("capabilities", list)):
            if name in row and not isinstance(row[name], expected):
                raise ContractError(f"Benchmark task {name} has an invalid type")
    return rows


def validate_report(value):
    value = _json_copy(value, "Benchmark evaluation report")
    if not isinstance(value, dict):
        raise ContractError("Benchmark evaluation report must be a JSON object")
    _text(value.get("status"), "Benchmark report status", maximum=200)
    available = value.get("score_available")
    if type(available) is not bool:
        raise ContractError("Benchmark report score_available must be boolean")
    score = value.get("score")
    if available and (type(score) not in {int, float} or not math.isfinite(score)):
        raise ContractError("Available benchmark score must be finite numeric data")
    accepted = value.get("accepted")
    if available and type(accepted) is not bool:
        raise ContractError("Available benchmark report must have a boolean acceptance")
    if not available and (score is not None or accepted is not None):
        raise ContractError("Unavailable benchmark report cannot claim a score or acceptance")
    if "accepted" in value and accepted is not None and type(accepted) is not bool:
        raise ContractError("Benchmark report accepted must be boolean or null")
    return value


def validate_availability(adapter):
    callback = getattr(adapter, "availability", None)
    value = {"available": True} if not callable(callback) else callback()
    value = _json_copy(value, "Benchmark availability")
    if not isinstance(value, dict) or type(value.get("available")) is not bool:
        raise ContractError("Benchmark availability must be an object with a boolean available field")
    if not value["available"] and not isinstance(value.get("reason"), str):
        raise ContractError("Unavailable benchmark must provide a reason")
    # Availability is a public discovery surface.  Plugin exception text and
    # dependency details can contain paths, credentials or private dataset
    # names, so expose only a stable host-owned reason.
    return ({"available": True} if value["available"] else
            {"available": False, "reason": "Benchmark reported unavailable"})


def host_runtime_fingerprint():
    """Return a host-owned runtime identity, separate from plugin snapshots."""
    directory = Path(__file__).parent
    names = (
        "benchmarks.py", "outcomes.py", "runtime.py", "tools.py",
        "store.py", "packages.py", "package_runner.py", "package_worker.py",
    )
    files = {}
    for name in names:
        path = directory / name
        if path.is_file():
            files[name] = hashlib.sha256(path.read_bytes()).hexdigest()
    return {"schema": "nexgent.task-benchmark-host-runtime.v1", "files": files}


class BenchmarkRegistry:
    """Discover canonical adapters without allowing one plugin to break peers."""

    def __init__(self, project_root=None, *, points=None):
        self.project_root = Path(project_root).resolve() if project_root is not None else None
        self._adapters = {}
        self._records = {}
        selected = list(entry_points(group=ENTRY_POINT_GROUP) if points is None else points)
        grouped = {}
        for point in selected:
            grouped.setdefault(point.name, []).append(point)
        for name in sorted(grouped):
            matches = grouped[name]
            if len(matches) != 1:
                self._records[name] = self._unavailable(
                    name, "Duplicate task benchmark identity")
                continue
            try:
                adapter = self._instantiate(matches[0].load())
                validate_adapter(adapter, entry_name=name, require_descriptor=True)
                availability = validate_availability(adapter)
                metadata = describe_adapter(adapter, require_explicit=True)
                record = {**metadata, **availability}
                if availability["available"]:
                    self._adapters[name] = adapter
                self._records[name] = record
            except Exception as exc:
                self._records[name] = self._unavailable(
                    name, "Benchmark plugin failed to load or validate")

    @classmethod
    def from_mapping(cls, adapters, project_root=None):
        """Wrap trusted direct injection while canonical entry points migrate."""
        registry = cls.__new__(cls)
        registry.project_root = Path(project_root).resolve() if project_root is not None else None
        registry._adapters, registry._records = {}, {}
        if not isinstance(adapters, dict):
            raise ContractError("Injected benchmark adapters must be a mapping")
        for name, adapter in adapters.items():
            _identifier(name, "Benchmark mapping key")
            validate_adapter(adapter, entry_name=name, require_descriptor=False)
            availability = validate_availability(adapter)
            metadata = describe_adapter(adapter, require_explicit=False)
            registry._records[name] = {**metadata, **availability}
            if availability["available"]:
                registry._adapters[name] = adapter
        return registry

    def _instantiate(self, provider):
        factory = (getattr(provider, "from_project", None)
                   if self.project_root is not None else None)
        if callable(factory):
            return factory(self.project_root)
        if callable(provider):
            return provider()
        return provider

    @staticmethod
    def _unavailable(identity, error):
        return {"id": identity, "title": identity, "available": False,
                "error": error, "sdk_schema": SDK_SCHEMA}

    def available(self):
        return [deepcopy(self._records[name]) for name in sorted(self._records)]

    def adapters(self):
        return dict(self._adapters)

    def get(self, identity):
        if identity in self._adapters:
            return self._adapters[identity]
        record = self._records.get(identity)
        if record is not None:
            raise ContractError(f"Task benchmark is unavailable: {identity}")
        raise ContractError(f"Task benchmark is not installed: {identity}")

    def snapshot(self, adapter_or_identity):
        adapter = (self.get(adapter_or_identity) if isinstance(adapter_or_identity, str)
                   else adapter_or_identity)
        return validate_snapshot(adapter.snapshot())

    def tasks(self, adapter_or_identity, *, split, seed, **options):
        adapter = (self.get(adapter_or_identity) if isinstance(adapter_or_identity, str)
                   else adapter_or_identity)
        descriptor_of(adapter, require_explicit=False)
        if not isinstance(split, str) or not split or len(split) > 200:
            raise ContractError("Benchmark split must be bounded nonempty text")
        if type(seed) is not int:
            raise ContractError("Benchmark seed must be an integer")
        return validate_tasks(adapter.tasks(split=split, seed=seed, **options))

    def evaluate(self, adapter_or_identity, task_ref, deliverables, execution_view):
        adapter = (self.get(adapter_or_identity) if isinstance(adapter_or_identity, str)
                   else adapter_or_identity)
        return validate_report(adapter.evaluate(task_ref, deliverables, execution_view))


__all__ = [
    "BenchmarkAdapter", "BenchmarkDescriptor", "BenchmarkRegistry",
    "ENTRY_POINT_GROUP", "SDK_SCHEMA", "describe_adapter", "descriptor_of",
    "host_runtime_fingerprint", "validate_adapter", "validate_availability",
    "validate_report", "validate_snapshot", "validate_tasks",
]
