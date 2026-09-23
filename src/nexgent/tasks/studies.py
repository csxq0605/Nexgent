"""Frozen, domain-neutral confirmatory studies over real task Episodes.

The study layer is deliberately downstream of evolution.  It compares two
immutable task-agent packages on a benchmark plugin's final holdout tasks.  It
does not generate candidates, expose evaluator internals, or move deployment
channels.  Those responsibilities remain in the P3/P4 control planes.
"""

from __future__ import annotations

from copy import deepcopy
from dataclasses import asdict, dataclass, is_dataclass
import hashlib
from importlib.metadata import entry_points
import inspect
import json
import math
from pathlib import Path
import platform
import random
import sys
import time
import types
import uuid

from ..kernel.programs import digest
from .benchmarks import (
    BenchmarkRegistry, ENTRY_POINT_GROUP, descriptor_of, host_runtime_fingerprint,
    validate_adapter, validate_snapshot, validate_tasks,
)
from .meta_evaluation import _LIMIT_KEYS, _USAGE_KEYS
from .outcomes import classify_benchmark_outcome, outcome_policy
from .packages import verify_package
from .tools import ContractError


STUDY_PLAN_SCHEMA = "nexgent.rsi-study-plan.v1"
STUDY_RUN_SCHEMA = "nexgent.rsi-study-run.v1"
STUDY_REPORT_SCHEMA = "nexgent.rsi-study-report.v1"
STUDY_CLAIM_LEASE_SECONDS = 3600
_CELL_BINDING_KEYS = (
    "id", "plan_id", "row_index", "arm", "seed", "task_index", "task_digest",
    "statistical_unit_id", "cluster_id", "package_id", "package_digest",
)


def _id(prefix):
    return prefix + "-" + uuid.uuid4().hex[:16]


def _copy(value, label):
    try:
        return json.loads(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                     separators=(",", ":"), allow_nan=False))
    except (TypeError, ValueError, RecursionError) as exc:
        raise ContractError(f"{label} must be finite JSON: {str(exc)[:500]}") from None


def _stable_code_constant(value):
    if isinstance(value, types.CodeType):
        return {"code": _code_fingerprint(value)}
    if isinstance(value, bytes):
        return {"bytes": value.hex()}
    if isinstance(value, tuple):
        return {"tuple": [_stable_code_constant(item) for item in value]}
    if isinstance(value, frozenset):
        items = [_stable_code_constant(item) for item in value]
        return {"frozenset": sorted(
            items, key=lambda item: json.dumps(item, sort_keys=True, separators=(",", ":")))}
    if value is Ellipsis:
        return {"singleton": "ellipsis"}
    if isinstance(value, complex):
        return {"complex": [value.real, value.imag]}
    if type(value) is float and not math.isfinite(value):
        return {"float": repr(value)}
    if value is None or type(value) in {bool, int, float, str}:
        return value
    return {"type": f"{type(value).__module__}.{type(value).__qualname__}"}


def _code_fingerprint(code):
    if code is None:
        return None
    return {
        "bytecode": code.co_code.hex(),
        "constants": [_stable_code_constant(value) for value in code.co_consts],
        "names": list(code.co_names),
        "varnames": list(code.co_varnames),
        "freevars": list(code.co_freevars),
        "cellvars": list(code.co_cellvars),
        "argcount": code.co_argcount,
        "posonlyargcount": code.co_posonlyargcount,
        "kwonlyargcount": code.co_kwonlyargcount,
        "flags": code.co_flags,
        "stacksize": code.co_stacksize,
        "exceptiontable": getattr(code, "co_exceptiontable", b"").hex(),
    }


def _normalize_dataclass_state(value):
    if is_dataclass(value) and not isinstance(value, type):
        value = asdict(value)
    if isinstance(value, dict):
        return {key: _normalize_dataclass_state(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_normalize_dataclass_state(item) for item in value]
    return value


def _stable_runtime_value(value, label, seen=None):
    value = _normalize_dataclass_state(value)
    if isinstance(value, dict):
        if any(not isinstance(key, str) for key in value):
            raise ContractError(f"{label} must use string object keys")
        return {key: _stable_runtime_value(item, label, seen)
                for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_stable_runtime_value(item, label, seen) for item in value]
    if isinstance(value, bytes):
        return {"bytes": value.hex()}
    if isinstance(value, types.CodeType):
        return {"code": _code_fingerprint(value)}
    if inspect.isfunction(value) or inspect.ismethod(value):
        return {"callable": _callable_fingerprint(value, _seen=seen)}
    if inspect.ismodule(value):
        return {"module": value.__name__}
    if isinstance(value, type):
        return {"class": f"{value.__module__}.{value.__qualname__}"}
    return _copy(value, label)


def _callable_fingerprint(value, _seen=None):
    target = getattr(value, "__func__", value)
    seen = set() if _seen is None else set(_seen)
    if id(target) in seen:
        return {"recursive_reference": {
            "module": getattr(target, "__module__", None),
            "qualname": getattr(target, "__qualname__", None),
        }}
    seen.add(id(target))
    code = getattr(target, "__code__", None)
    try:
        source = inspect.getsource(target)
    except (OSError, TypeError):
        source = None
    closure = []
    for cell in getattr(target, "__closure__", None) or ():
        try:
            closure.append(_stable_runtime_value(
                cell.cell_contents, "Evaluator closure state", seen))
        except ValueError as exc:
            raise ContractError("Evaluator closure state is unavailable") from exc
    globals_used = {}
    namespace = getattr(target, "__globals__", {})
    for name in sorted(set(getattr(code, "co_names", ()))):
        if name not in namespace or name == "__builtins__":
            continue
        item = namespace[name]
        globals_used[name] = _stable_runtime_value(
            item, "Evaluator global state", seen)
    return {
        "python_abi": {
            "implementation": sys.implementation.name,
            "cache_tag": sys.implementation.cache_tag,
            "version": list(sys.version_info[:3]),
        },
        "module": getattr(target, "__module__", None),
        "qualname": getattr(target, "__qualname__", None),
        "source": source,
        "code": _code_fingerprint(code),
        "defaults": _stable_runtime_value(
            getattr(target, "__defaults__", None), "Evaluator positional defaults", seen),
        "kwdefaults": _stable_runtime_value(
            getattr(target, "__kwdefaults__", None), "Evaluator keyword defaults", seen),
        "closure": closure,
        "globals": globals_used,
    }


def _adapter_fingerprint(adapter):
    try:
        instance_state = _copy(
            _normalize_dataclass_state(vars(adapter)), "Study adapter instance state")
    except (TypeError, ContractError):
        instance_state = {}
    class_state = {}
    for name, value in vars(type(adapter)).items():
        if name.startswith("__") or callable(value) or isinstance(value, (staticmethod, classmethod)):
            continue
        class_state[name] = _copy(
            _normalize_dataclass_state(value), "Study adapter class state")
    module = sys.modules.get(type(adapter).__module__)
    module_path = Path(getattr(module, "__file__", ""))
    module_digest = (hashlib.sha256(module_path.read_bytes()).hexdigest()
                     if module_path.is_file() else None)
    manifest = (adapter.study_artifact_manifest()
                if callable(getattr(adapter, "study_artifact_manifest", None)) else {})
    return digest({
        "class": f"{type(adapter).__module__}.{type(adapter).__qualname__}",
        "instance_state": instance_state,
        "class_state": class_state,
        "module_digest": module_digest,
        "artifact_manifest": _copy(manifest, "Study adapter artifact manifest"),
        "methods": {name: _callable_fingerprint(getattr(adapter, name))
                    for name in ("snapshot", "tasks", "evaluate")},
    })


def _descriptor_digest(adapter):
    return digest(descriptor_of(adapter, require_explicit=False).as_dict())


def _load_installed_authority(project_root, identity):
    points = [point for point in entry_points(group=ENTRY_POINT_GROUP)
              if point.name == identity]
    if not points:
        return None
    registry = BenchmarkRegistry(project_root, points=points)
    canonical = registry.adapters().get(identity)
    if canonical is None:
        raise ContractError(
            "Installed benchmark authority is unavailable or ambiguous")
    return canonical


def _execution_environment(task_service, adapter):
    tools = []
    for name in sorted(task_service.tools._tools):
        spec = task_service.tools.get(name)
        tools.append({**spec.describe(), "handler": _callable_fingerprint(spec.handler)})
    external = (adapter.study_environment()
                if callable(getattr(adapter, "study_environment", None)) else {})
    return {
        "python": platform.python_version(),
        "implementation": platform.python_implementation(),
        "platform": platform.platform(),
        "tools": tools,
        "domains": _copy(task_service.tools.domains, "Study tool domains"),
        "benchmark_environment": _copy(external, "Study benchmark environment"),
    }


def public_study_records(store, limit=50):
    """Return a bounded projection without task payloads or package source."""
    if type(limit) is not int or not 1 <= limit <= 1000:
        raise ContractError("Study view limit must be between 1 and 1000")
    with store.connect() as db:
        tables = {row[0] for row in db.execute(
            "SELECT name FROM sqlite_master WHERE type='table'")}
        plans = (db.execute(
            "SELECT data,digest FROM task_rsi_study_plans ORDER BY rowid DESC LIMIT ?",
            (limit,)).fetchall() if "task_rsi_study_plans" in tables else [])
        reports = (db.execute(
            "SELECT data,digest FROM task_rsi_study_reports ORDER BY rowid DESC LIMIT ?",
            (limit,)).fetchall() if "task_rsi_study_reports" in tables else [])

    def read(rows):
        values = []
        for encoded, record_digest in rows:
            value = json.loads(encoded)
            if digest(value) != record_digest:
                raise ContractError("RSI study public record digest mismatch")
            value["record_digest"] = record_digest
            values.append(value)
        return values

    plan_records = read(plans)
    for value in plan_records:
        value["suite_role"] = _study_suite_role(value)
    report_records = [_sanitize_study_report(value) for value in read(reports)]
    return {
        "plans": [{key: value.get(key) for key in (
            "id", "benchmark_id", "split", "seeds", "arms", "baseline_arm",
            "candidate_arm", "provider", "model", "resolved_model",
            "model_profile_digest", "model_version_binding", "expected_observed_model",
            "expected_provider_revision", "policy", "suite_role", "statistics",
            "benchmark_descriptor_digest", "adapter_fingerprint",
            "benchmark_authority_fingerprint",
            "benchmark_authority_snapshot_digest",
            "execution_environment_digest",
            "protocol_digest", "created_at", "record_digest")}
                  for value in plan_records],
        "reports": [{key: value.get(key) for key in (
            "id", "plan_id", "run_id", "complete_pair_count", "planned_pair_count",
            "independent_cluster_count", "planned_cluster_count",
            "metrics", "gates", "engineering_acceptance", "statistical_support",
            "suite_role", "version_scope", "claim_scope", "created_at", "record_digest")}
                    for value in report_records],
    }


@dataclass(frozen=True, init=False)
class StudyPolicy:
    estimand: str = "superiority"
    min_quality_delta: float = 0.0
    min_success_delta: float = 0.0
    max_work_proxy_ratio: float = 1.25
    max_regressions: int = 0
    min_independent_clusters: int = 5
    confidence: float = 0.95

    def __init__(self, estimand="superiority", min_quality_delta=0.0,
                 min_success_delta=0.0, max_work_proxy_ratio=1.25,
                 max_regressions=0, min_independent_clusters=None,
                 confidence=0.95, *, min_complete_pairs=None):
        if (min_independent_clusters is not None
                and min_complete_pairs is not None
                and min_independent_clusters != min_complete_pairs):
            raise ContractError(
                "Study cluster threshold aliases must have the same value")
        threshold = (min_independent_clusters
                     if min_independent_clusters is not None else
                     min_complete_pairs if min_complete_pairs is not None else 5)
        for name, value in (
                ("estimand", estimand),
                ("min_quality_delta", min_quality_delta),
                ("min_success_delta", min_success_delta),
                ("max_work_proxy_ratio", max_work_proxy_ratio),
                ("max_regressions", max_regressions),
                ("min_independent_clusters", threshold),
                ("confidence", confidence)):
            object.__setattr__(self, name, value)

    @property
    def min_complete_pairs(self):
        """Compatibility alias for callers using the original policy name."""
        return self.min_independent_clusters

    def normalized(self):
        value = asdict(self)
        if value["estimand"] not in {"superiority", "noninferiority"}:
            raise ContractError("Study estimand must be superiority or noninferiority")
        for key in ("min_quality_delta", "min_success_delta", "max_work_proxy_ratio",
                    "confidence"):
            if type(value[key]) not in {int, float} or not math.isfinite(value[key]):
                raise ContractError(f"Study policy {key} must be finite")
        if value["max_work_proxy_ratio"] < 0:
            raise ContractError("Study maximum work-proxy ratio must be nonnegative")
        if (value["estimand"] == "superiority"
                and (value["min_quality_delta"] < 0 or value["min_success_delta"] < 0)):
            raise ContractError("Superiority margins must be nonnegative")
        if (value["estimand"] == "noninferiority"
                and (value["min_quality_delta"] > 0 or value["min_success_delta"] > 0)):
            raise ContractError("Noninferiority margins must be nonpositive")
        if not 0 < value["confidence"] < 1:
            raise ContractError("Study confidence must be between zero and one")
        if (type(value["max_regressions"]) is not int or value["max_regressions"] < 0
                or type(value["min_independent_clusters"]) is not int
                or not 2 <= value["min_independent_clusters"] <= 10000):
            raise ContractError("Study count thresholds are invalid")
        return value


def _policy_independent_cluster_minimum(policy):
    """Read the canonical threshold while accepting frozen pre-rename plans."""
    if not isinstance(policy, dict):
        raise ContractError("Study policy must be an object")
    minimum = policy.get("min_independent_clusters")
    legacy = policy.get("min_complete_pairs")
    if minimum is not None and legacy is not None and minimum != legacy:
        raise ContractError("Study cluster threshold aliases differ")
    minimum = minimum if minimum is not None else legacy
    if type(minimum) is not int or not 2 <= minimum <= 10000:
        raise ContractError("Study independent cluster threshold is invalid")
    return minimum


def _study_suite_role(plan):
    role = plan.get("suite_role", "legacy_unclassified")
    return (role if role in {"qualification", "primary", "transfer", "demo_only"}
            else "legacy_unclassified")


def _claim_eligible_suite_role(role):
    return role in {"qualification", "primary", "transfer"}


def _study_evidence_label(version_scope):
    return {
        "none": "deterministic",
        "request_alias_time_window": "time_window",
        "provider_reported_revision": "provider_revision",
    }.get(version_scope, "unresolved_version")


def _sanitize_study_report(report):
    value = deepcopy(report)
    role = _study_suite_role(value)
    eligible = _claim_eligible_suite_role(role)
    value["suite_role"] = role
    gates = deepcopy(value.get("gates")) if isinstance(value.get("gates"), dict) else {}
    gates["claim_eligible_role"] = eligible
    value["gates"] = gates
    evidence = _study_evidence_label(
        value.get("version_scope", "request_alias_time_window"))
    if not eligible:
        value["statistical_support"] = False
        value["claim_scope"] = (
            f"benchmark_local_{role}_{evidence}_effect_not_established")
    elif value.get("statistical_support") is True:
        estimand = ("noninferiority" if "noninferiority" in str(
            value.get("claim_scope", "")) else "superiority")
        value["claim_scope"] = (
            f"benchmark_local_{role}_{evidence}_{estimand}_supported")
    return value


class TaskStudyExecutor:
    """Trusted bridge from a frozen study cell to TaskService and an adapter."""

    def __init__(self, task_service, adapter):
        validate_adapter(adapter, require_descriptor=False)
        self.tasks = task_service
        try:
            self.adapter = deepcopy(adapter)
        except Exception as exc:
            raise TypeError("Study adapter must be deepcopy-freezable") from exc
        self.snapshot = validate_snapshot(self.adapter.snapshot())
        self.adapter_fingerprint = _adapter_fingerprint(self.adapter)
        self.environment = _execution_environment(task_service, self.adapter)
        self.environment_digest = digest(self.environment)

    def prepare(self, plan, cell):
        package = self.tasks.store.package(cell["package_id"])
        if package["digest"] != cell["package_digest"]:
            raise ContractError("Frozen study package digest changed")
        task_ref = _copy(cell["task"], "Study task")
        context = deepcopy(task_ref.get("context") or {})
        if not isinstance(context, dict) or "benchmark_registration" in context:
            raise ContractError("Study task context attempts to provide host authority")
        context.update({
            "split": plan["split"], "split_role": "final_holdout",
            "memory_writeback": False, "rsi_role": "confirmatory_holdout",
            "study_plan_id": plan["id"], "study_cell_id": cell["id"],
            "provider_requirement": plan["provider"],
            "model_requirement": plan["model"],
        })
        benchmark_registration = {
            "benchmark_id": plan["benchmark_id"],
            "task_ref": deepcopy(task_ref),
            "snapshot": deepcopy(plan["benchmark_snapshot"]),
            "host_runtime": host_runtime_fingerprint(),
        }
        state = self.tasks.create(
            task_ref["objective"], inputs=task_ref.get("inputs"),
            deliverables=task_ref.get("deliverables"), budget=plan["episode_budget"],
            capabilities=task_ref.get("capabilities"), package=package,
            context=context, constraints=task_ref.get("constraints"),
            entry=task_ref.get("entry", "execute"),
            benchmark_registration=benchmark_registration)
        snapshot = self.tasks.store.memory_snapshot(
            state["memory_snapshot_id"], state["id"])
        if snapshot.get("items") or snapshot.get("item_version_refs"):
            raise ContractError("Confirmatory holdout did not start from empty memory")
        return state["id"]

    def validate_episode(self, plan, cell, episode_id):
        state = self.tasks.get_private(episode_id)
        registration = self.tasks.store.benchmark_registration(episode_id) or {}
        if (state.get("package_id") != cell["package_id"]
                or state.get("package_digest") != cell["package_digest"]
                or registration.get("benchmark_id") != plan["benchmark_id"]
                or registration.get("snapshot") != plan["benchmark_snapshot"]
                or digest(registration.get("task_ref")) != cell["task_digest"]):
            raise ContractError("Study Episode does not match its frozen cell")
        return state

    def finish(self, plan, cell, episode_id, *, stop_event=None):
        if (plan.get("outcome_policy") != outcome_policy()
                or _adapter_fingerprint(self.adapter) != plan["adapter_fingerprint"]
                or validate_snapshot(self.adapter.snapshot())
                   != plan["benchmark_snapshot"]
                or digest(_execution_environment(self.tasks, self.adapter))
                   != plan["execution_environment_digest"]):
            raise ContractError("Study evaluator authority changed after registration")
        state = self.tasks.get_private(episode_id)
        if state["status"] not in {"completed", "failed", "cancelled", "waiting_input"}:
            state = self.tasks.run(episode_id, stop_event=stop_event)
        if state["status"] in {"ready", "running", "paused"}:
            return None
        evaluated = self.tasks.evaluate(
            episode_id, self.adapter, deepcopy(cell["task"]),
            snapshot=deepcopy(plan["benchmark_snapshot"]))
        state = self.tasks.get_private(episode_id)
        classified = classify_benchmark_outcome(state, evaluated["evaluation"])
        report = classified["evaluation"]
        failure_class = classified["failure_class"]
        state = self.validate_episode(plan, cell, episode_id)
        calls = state.get("calls") or []
        if plan["provider"] == "none" and plan["model"] == "none":
            if calls:
                raise ContractError("No-model study cell emitted model calls")
        else:
            expected = plan["provider"] + "/" + plan["model"]
            if any(call.get("model") != expected for call in calls):
                raise ContractError("Study cell used a model outside the frozen requirement")
            if any(call.get("profile_digest") != plan["model_profile_digest"]
                   or call.get("configured_provider_model", call.get("provider_model"))
                      != plan["resolved_model"] for call in calls):
                raise ContractError("Study cell model profile changed after registration")
            if plan.get("model_version_binding") == "provider_reported_revision" and any(
                    call.get("observed_provider_model") != plan["expected_observed_model"]
                    or call.get("provider_revision") != plan["expected_provider_revision"]
                    for call in calls):
                raise ContractError("Study cell provider revision changed after registration")
            if plan["require_model_calls"] and not calls:
                raise ContractError("Study cell did not exercise the required model")
        usage = state.get("usage") or {}
        measured = (report.get("score_available") is True
                    and type(report.get("accepted")) is bool
                    and type(report.get("score")) in {int, float}
                    and math.isfinite(report["score"])
                    and usage.get("usage_complete") is True)
        return {
            "status": "measured" if measured else "missing",
            "episode_id": episode_id,
            "score": float(report["score"]) if measured else None,
            "accepted": report["accepted"] if measured else None,
            "evaluation_digest": digest(report),
            "usage": {key: (usage.get(key, 0) if key == "charged_tool_work_units"
                            else usage.get(key)) for key in _USAGE_KEYS},
            "usage_complete": usage.get("usage_complete") is True,
            "execution_status": state["status"],
            "failure_class": failure_class,
            "reason": None if measured else str(
                state.get("last_error") or report.get("status") or "measurement unavailable")[:500],
        }


class RSIStudyService:
    """Pre-register, execute, and assess paired final-holdout studies."""

    def __init__(self, task_service, adapter):
        self.tasks = task_service
        self.store = task_service.store
        self._executor = TaskStudyExecutor(task_service, adapter)
        self._executor_authority = self._executor
        self._adapter_authority = self._executor.adapter
        self._installed_authorities = {}
        with self.store.connect() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS task_rsi_study_plans(
                    id TEXT PRIMARY KEY, data TEXT NOT NULL, digest TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS task_rsi_study_cells(
                    id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, status TEXT NOT NULL,
                    data TEXT NOT NULL, updated REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS task_rsi_study_runs(
                    id TEXT PRIMARY KEY, data TEXT NOT NULL, digest TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS task_rsi_study_reports(
                    id TEXT PRIMARY KEY, data TEXT NOT NULL, digest TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS task_rsi_study_claims(
                    plan_id TEXT PRIMARY KEY, status TEXT NOT NULL, run_id TEXT,
                    created REAL NOT NULL, updated REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS task_rsi_holdout_claims(
                    unit_digest TEXT PRIMARY KEY, plan_id TEXT NOT NULL,
                    created REAL NOT NULL);
            """)

    @staticmethod
    def _encode(value):
        return json.dumps(value, ensure_ascii=False, sort_keys=True,
                          separators=(",", ":"), allow_nan=False)

    def _insert(self, table, record):
        encoded, record_digest = self._encode(record), digest(record)
        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            old = db.execute(
                f"SELECT data,digest FROM {table} WHERE id=?", (record["id"],)).fetchone()
            if old and old != (encoded, record_digest):
                raise ContractError("Cannot overwrite immutable RSI study evidence")
            db.execute(f"INSERT OR IGNORE INTO {table} VALUES(?,?,?)",
                       (record["id"], encoded, record_digest))
        result = deepcopy(record)
        result["record_digest"] = record_digest
        return result

    def _insert_plan(self, record, holdout_units):
        encoded, record_digest = self._encode(record), digest(record)
        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            for unit in holdout_units:
                previous = db.execute(
                    "SELECT plan_id FROM task_rsi_holdout_claims WHERE unit_digest=?",
                    (unit,)).fetchone()
                if previous:
                    raise ContractError(
                        "A final-holdout study unit was already registered by " + previous[0])
            db.execute("INSERT INTO task_rsi_study_plans VALUES(?,?,?)",
                       (record["id"], encoded, record_digest))
            db.executemany(
                "INSERT INTO task_rsi_holdout_claims VALUES(?,?,?)",
                [(unit, record["id"], time.time()) for unit in holdout_units])
        result = deepcopy(record)
        result["record_digest"] = record_digest
        return result

    def _trusted_executor(self, plan=None):
        executor = self._executor
        if (executor is not self._executor_authority
                or executor.__class__ is not TaskStudyExecutor
                or executor.tasks is not self.tasks
                or executor.adapter is not self._adapter_authority):
            raise ContractError("RSI study executor authority changed")
        if plan is not None and (
                executor.adapter.id != plan["benchmark_id"]
                or (plan.get("benchmark_descriptor_digest") is not None
                    and _descriptor_digest(executor.adapter)
                    != plan["benchmark_descriptor_digest"])
                or _adapter_fingerprint(executor.adapter) != plan["adapter_fingerprint"]
                or validate_snapshot(executor.adapter.snapshot())
                   != plan["benchmark_snapshot"]
                or digest(_execution_environment(self.tasks, executor.adapter))
                   != plan["execution_environment_digest"]):
            raise ContractError("RSI study evaluator changed after registration")
        if plan is not None:
            self._validate_installed_authority(executor.adapter, plan=plan)
        return executor

    def _installed_authority(self, identity):
        if identity not in self._installed_authorities:
            self._installed_authorities[identity] = _load_installed_authority(
                self.tasks.project_root, identity)
        return self._installed_authorities[identity]

    def _validate_installed_authority(self, adapter, plan=None):
        authority = self._installed_authority(adapter.id)
        if authority is None:
            if plan is not None and plan.get("benchmark_authority_fingerprint") is not None:
                raise ContractError("Installed benchmark authority disappeared")
            return {"fingerprint": None, "snapshot_digest": None}
        authority_fingerprint = _adapter_fingerprint(authority)
        authority_snapshot_digest = digest(validate_snapshot(authority.snapshot()))
        if (type(adapter) is not type(authority)
                or _adapter_fingerprint(adapter) != authority_fingerprint
                or digest(validate_snapshot(adapter.snapshot())) != authority_snapshot_digest):
            raise ContractError(
                "Study adapter implementation differs from the installed benchmark authority")
        if plan is not None and (
                plan.get("benchmark_authority_fingerprint") not in {
                    None, authority_fingerprint}
                or plan.get("benchmark_authority_snapshot_digest") not in {
                    None, authority_snapshot_digest}):
            raise ContractError(
                "Installed benchmark authority changed after registration")
        return {"fingerprint": authority_fingerprint,
                "snapshot_digest": authority_snapshot_digest}

    def _get(self, table, identity):
        with self.store.connect() as db:
            row = db.execute(
                f"SELECT data,digest FROM {table} WHERE id=?", (identity,)).fetchone()
        if row is None:
            raise KeyError(identity)
        value = json.loads(row[0])
        if digest(value) != row[1]:
            raise ContractError("RSI study evidence digest mismatch")
        value["record_digest"] = row[1]
        return value

    def plan(self, identity):
        return self._get("task_rsi_study_plans", identity)

    def run_record(self, identity):
        return self._get("task_rsi_study_runs", identity)

    def report(self, identity):
        return self._get("task_rsi_study_reports", identity)

    @staticmethod
    def _budget(value):
        value = _copy(value, "Study episode budget")
        expected = set(_LIMIT_KEYS.values())
        if not isinstance(value, dict):
            raise ContractError("Study budget must freeze every supported resource limit")
        value.setdefault("max_tool_work_units", 0)
        if set(value) != expected:
            raise ContractError("Study budget must freeze every supported resource limit")
        if any(type(value[key]) is not int or value[key] < 0 for key in expected):
            raise ContractError("Study budget limits must be nonnegative integers")
        return {key: value[key] for key in sorted(expected)}

    def create_plan(self, *, arms, baseline_arm, candidate_arm, split,
                    seeds, episode_budget, provider, model, policy=None,
                    require_model_calls=True, observed_model=None,
                    provider_revision=None, role=None):
        if split != "final_holdout":
            raise ContractError("Confirmatory RSI studies require final_holdout tasks")
        if (not isinstance(seeds, list) or not 2 <= len(seeds) <= 1000
                or len(set(seeds)) != len(seeds)
                or any(type(seed) is not int for seed in seeds)):
            raise ContractError("Study seeds must be a bounded unique integer list")
        if not isinstance(arms, dict) or set(arms) != {baseline_arm, candidate_arm}:
            raise ContractError("Study must freeze exactly one baseline and one candidate arm")
        if (not all(isinstance(name, str) and name for name in arms)
                or baseline_arm == candidate_arm):
            raise ContractError("Study arm names are invalid")
        if not isinstance(provider, str) or not provider or not isinstance(model, str) or not model:
            raise ContractError("Study provider and model must be explicit")
        if type(require_model_calls) is not bool:
            raise ContractError("Study require_model_calls must be boolean")
        if (provider == "none") != (model == "none"):
            raise ContractError("No-model studies must use provider=none and model=none")
        if provider == "none" and require_model_calls:
            raise ContractError("No-model studies cannot require model calls")
        if (observed_model is None) != (provider_revision is None):
            raise ContractError(
                "Observed provider model and reported revision must be specified together")
        if observed_model is not None and (
                not isinstance(observed_model, str) or not observed_model
                or not isinstance(provider_revision, str) or not provider_revision):
            raise ContractError("Provider model revision binding must be nonempty text")
        if provider == "none" and observed_model is not None:
            raise ContractError("No-model studies cannot bind a provider revision")
        episode_budget = self._budget(episode_budget)
        policy = (policy or StudyPolicy()).normalized()
        executor = self._trusted_executor()
        descriptor = descriptor_of(executor.adapter, require_explicit=False)
        if "confirmatory" not in descriptor.modes:
            raise ContractError(
                "RSI studies require a benchmark with confirmatory mode")
        if role is None:
            if descriptor.allowed_suite_roles != ("qualification",):
                raise ContractError(
                    "Study role must be explicit unless qualification is the only allowed role")
            suite_role = "qualification"
        else:
            suite_role = role
        if suite_role not in descriptor.allowed_suite_roles:
            raise ContractError(
                "Requested study role is not allowed by the benchmark descriptor")
        if suite_role == "demo_only":
            raise ContractError("Demo-only benchmarks cannot create confirmatory RSI studies")
        authority = self._validate_installed_authority(executor.adapter)
        packages = {}
        for name, package in arms.items():
            package = _copy(package, f"Study arm {name}")
            verify_package(package)
            self.store.put_package(package)
            packages[name] = {"package_id": package["id"],
                              "package_digest": package["digest"]}
        if packages[baseline_arm]["package_digest"] == packages[candidate_arm]["package_digest"]:
            raise ContractError("Study arms must be distinct immutable packages")

        snapshot = deepcopy(executor.snapshot)
        rows = []
        for seed in seeds:
            tasks = validate_tasks(executor.adapter.tasks(split=split, seed=seed))
            if not tasks:
                raise ContractError("Study benchmark returned no holdout tasks")
            for index, task in enumerate(tasks):
                task = _copy(task, "Study task")
                if not isinstance(task, dict) or not isinstance(task.get("objective"), str):
                    raise ContractError("Study benchmark returned an invalid task")
                context = task.get("context") or {}
                if (not isinstance(context, dict)
                        or context.get("split", split) != split
                        or "benchmark_registration" in context):
                    raise ContractError("Study task split or authority is invalid")
                unit_id = task.get("statistical_unit_id")
                cluster_id = task.get("cluster_id")
                if (not isinstance(unit_id, str) or not unit_id or len(unit_id) > 500
                        or not isinstance(cluster_id, str) or not cluster_id
                        or len(cluster_id) > 500):
                    raise ContractError(
                        "Confirmatory tasks require statistical_unit_id and cluster_id")
                rows.append({"seed": seed, "task_index": index,
                             "task": task, "task_digest": digest(task),
                             "statistical_unit_id": unit_id, "cluster_id": cluster_id})
        task_keys = [(row["seed"], row["task_index"]) for row in rows]
        if len(set(task_keys)) != len(task_keys):
            raise ContractError("Study benchmark task identities are not unique")
        task_digests = [row["task_digest"] for row in rows]
        if len(set(task_digests)) != len(task_digests):
            raise ContractError(
                "Confirmatory task payloads must be unique")
        unit_ids = [row["statistical_unit_id"] for row in rows]
        if len(set(unit_ids)) != len(unit_ids):
            raise ContractError("Confirmatory statistical_unit_id values must be unique")
        clusters = {row["cluster_id"] for row in rows}
        if len(clusters) < 2:
            raise ContractError("Confirmatory studies require at least two independent clusters")

        if provider == "none":
            resolved_model = None
            model_profile_digest = None
        else:
            from ..models.config import load_profiles
            profiles, _ = load_profiles(self.tasks.project_root)
            identity = provider + "/" + model
            profile = profiles.get(identity)
            if profile is None:
                raise ContractError("Study model profile is not configured locally")
            resolved_model = profile.model
            model_profile_digest = digest({
                "id": profile.id, "model": profile.model, "base_url": profile.base_url})

        plan_id = _id("rsi-study-plan")
        schedule = []
        for row_index, row in enumerate(rows):
            order = [baseline_arm, candidate_arm]
            if int(digest({"plan": plan_id, "row": row_index})[:8], 16) % 2:
                order.reverse()
            for arm in order:
                schedule.append({"cell_id": f"{plan_id}:{row_index}:{arm}",
                                 "row_index": row_index, "arm": arm})
        protocol = {
            "benchmark_id": executor.adapter.id, "benchmark_snapshot": snapshot,
            "split": split, "seeds": seeds, "tasks": rows, "arms": packages,
            "baseline_arm": baseline_arm, "candidate_arm": candidate_arm,
            "episode_budget": episode_budget, "provider": provider, "model": model,
            "resolved_model": resolved_model,
            "model_profile_digest": model_profile_digest,
            "expected_observed_model": observed_model,
            "expected_provider_revision": provider_revision,
            "require_model_calls": require_model_calls, "policy": policy,
            "suite_role": suite_role,
            "benchmark_descriptor_digest": _descriptor_digest(executor.adapter),
            "benchmark_authority_fingerprint": authority["fingerprint"],
            "benchmark_authority_snapshot_digest": authority["snapshot_digest"],
            "outcome_policy": outcome_policy(),
            "adapter_fingerprint": _adapter_fingerprint(executor.adapter),
            "execution_environment": deepcopy(executor.environment),
            "execution_environment_digest": executor.environment_digest,
            "model_version_binding": (
                "provider_reported_revision" if provider_revision is not None else
                "request_alias_time_window" if provider != "none" else "none"),
            "statistics": {"pairing": "statistical_unit_id",
                           "independence": "cluster_id", "interval": "cluster_bootstrap",
                           "resamples": 10000, "test": "paired_sign_flip",
                           "missing": "fail_closed",
                           "work_proxy": {"model_calls": 1.0,
                                          "charged_completion_tokens": 0.001,
                                          "tool_calls": 1.0,
                                          "charged_tool_work_units": 1.0,
                                          "nodes": 1.0}},
        }
        record = {
            "schema": STUDY_PLAN_SCHEMA, "id": plan_id, "created_at": time.time(),
            "status": "registered", **protocol, "schedule": schedule,
            "protocol_digest": digest(protocol),
        }
        snapshot_digest = digest(snapshot)
        holdout_units = [digest({"benchmark_id": executor.adapter.id,
                                 "snapshot_digest": snapshot_digest,
                                 "statistical_unit_id": row["statistical_unit_id"]})
                         for row in rows]
        return self._insert_plan(record, holdout_units)

    def _cell(self, cell_id):
        with self.store.connect() as db:
            row = db.execute(
                "SELECT data FROM task_rsi_study_cells WHERE id=?", (cell_id,)).fetchone()
        return json.loads(row[0]) if row else None

    @staticmethod
    def _cell_binding(cell):
        return {key: deepcopy(cell.get(key)) for key in _CELL_BINDING_KEYS}

    def _canonical_cell(self, plan, scheduled):
        row = plan["tasks"][scheduled["row_index"]]
        package_ref = plan["arms"][scheduled["arm"]]
        value = {
            "id": scheduled["cell_id"], "plan_id": plan["id"],
            "row_index": scheduled["row_index"], "arm": scheduled["arm"],
            "seed": row["seed"], "task_index": row["task_index"],
            "task": deepcopy(row["task"]), "task_digest": row["task_digest"],
            "statistical_unit_id": row["statistical_unit_id"],
            "cluster_id": row["cluster_id"],
            **deepcopy(package_ref),
        }
        value["binding_digest"] = digest(self._cell_binding(value))
        return value

    def _validate_cell(self, plan, scheduled, cell):
        canonical = self._canonical_cell(plan, scheduled)
        if (self._cell_binding(cell) != self._cell_binding(canonical)
                or cell.get("binding_digest") != canonical["binding_digest"]
                or digest(cell.get("task")) != canonical["task_digest"]):
            raise ContractError("RSI study cell differs from its frozen plan")
        if cell.get("status") not in {"preparing", "ready", "measured", "missing"}:
            raise ContractError("RSI study cell status is invalid")
        if cell["status"] != "preparing" and not isinstance(cell.get("episode_id"), str):
            raise ContractError("RSI study cell lacks its unique Episode")
        return canonical

    def _reserve_cell(self, plan, scheduled, owner):
        canonical = self._canonical_cell(plan, scheduled)
        cell = {**canonical, "status": "preparing", "episode_id": None}
        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            claim = db.execute(
                "SELECT status FROM task_rsi_study_claims WHERE plan_id=?",
                (plan["id"],)).fetchone()
            if claim != (owner,):
                raise ContractError("RSI study runner lost its claim")
            old = db.execute(
                "SELECT data FROM task_rsi_study_cells WHERE id=?", (cell["id"],)).fetchone()
            if old:
                existing = json.loads(old[0])
                self._validate_cell(plan, scheduled, existing)
                return existing, False
            db.execute("INSERT INTO task_rsi_study_cells VALUES(?,?,?,?,?)",
                       (cell["id"], cell["plan_id"], cell["status"],
                        self._encode(cell), time.time()))
        return deepcopy(cell), True

    def _advance_cell(self, plan, scheduled, owner, expected_status, updates):
        updates = _copy(updates, "Study cell update")
        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            claim = db.execute(
                "SELECT status FROM task_rsi_study_claims WHERE plan_id=?",
                (plan["id"],)).fetchone()
            if claim != (owner,):
                raise ContractError("RSI study runner lost its claim")
            row = db.execute(
                "SELECT data FROM task_rsi_study_cells WHERE id=?",
                (scheduled["cell_id"],)).fetchone()
            if row is None:
                raise ContractError("RSI study cell disappeared")
            cell = json.loads(row[0])
            self._validate_cell(plan, scheduled, cell)
            if cell["status"] != expected_status:
                raise ContractError("RSI study cell changed before transition")
            if expected_status in {"measured", "missing"}:
                raise ContractError("Terminal RSI study cells are immutable")
            changed = {**cell, **updates}
            if self._cell_binding(changed) != self._cell_binding(cell):
                raise ContractError("RSI study cell update changed its frozen binding")
            self._validate_cell(plan, scheduled, changed)
            db.execute(
                "UPDATE task_rsi_study_cells SET status=?,data=?,updated=? WHERE id=?",
                (changed["status"], self._encode(changed), time.time(), cell["id"]))
        return changed

    def _claim(self, plan_id):
        now, token = time.time(), uuid.uuid4().hex
        owner = "running:" + token
        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                "SELECT status,run_id,updated FROM task_rsi_study_claims WHERE plan_id=?",
                (plan_id,)).fetchone()
            if row:
                if row[0] == "completed" and row[1]:
                    return None, row[1]
                if row[0].startswith("running:") and now - row[2] < STUDY_CLAIM_LEASE_SECONDS:
                    raise ContractError("RSI study is already running")
                if row[0] != "paused" and not row[0].startswith("running:"):
                    raise ContractError("RSI study claim is invalid")
                changed = db.execute(
                    "UPDATE task_rsi_study_claims SET status=?,updated=? "
                    "WHERE plan_id=? AND status=? AND run_id IS NULL",
                    (owner, now, plan_id, row[0])).rowcount
                if changed != 1:
                    raise ContractError("RSI study claim changed during takeover")
                return owner, None
            db.execute("INSERT INTO task_rsi_study_claims VALUES(?,?,?,?,?)",
                       (plan_id, owner, None, now, now))
        return owner, None

    def _heartbeat(self, plan_id, owner):
        with self.store.connect() as db:
            changed = db.execute(
                "UPDATE task_rsi_study_claims SET updated=? "
                "WHERE plan_id=? AND status=? AND run_id IS NULL",
                (time.time(), plan_id, owner)).rowcount
        if changed != 1:
            raise ContractError("RSI study runner lost its claim")

    def _pause(self, plan_id, owner):
        with self.store.connect() as db:
            changed = db.execute(
                "UPDATE task_rsi_study_claims SET status='paused',updated=? "
                "WHERE plan_id=? AND status=? AND run_id IS NULL",
                (time.time(), plan_id, owner)).rowcount
        if changed != 1:
            raise ContractError("RSI study runner lost its claim while pausing")

    def run(self, plan_id, *, stop_event=None):
        plan = self.plan(plan_id)
        executor = self._trusted_executor(plan)
        owner, prior_run = self._claim(plan_id)
        if prior_run is not None:
            return self.run_record(prior_run)

        for scheduled in plan["schedule"]:
            if stop_event is not None and stop_event.is_set():
                self._pause(plan_id, owner)
                return {"schema": STUDY_RUN_SCHEMA, "plan_id": plan_id,
                        "status": "paused", "completed_cells": sum(
                            (self._cell(item["cell_id"]) or {}).get("status") in
                            {"measured", "missing"} for item in plan["schedule"])}
            self._heartbeat(plan_id, owner)
            cell, created = self._reserve_cell(plan, scheduled, owner)
            if created:
                try:
                    episode_id = TaskStudyExecutor.prepare(executor, plan, cell)
                except Exception:
                    # A host-side preparation failure leaves an explicit
                    # preparing cell.  It cannot be replaced by a fresh draw.
                    self._pause(plan_id, owner)
                    raise
                cell = self._advance_cell(
                    plan, scheduled, owner, "preparing",
                    {"status": "ready", "episode_id": episode_id})
            else:
                self._validate_cell(plan, scheduled, cell)
                if cell["status"] == "preparing":
                    self._pause(plan_id, owner)
                    raise ContractError(
                        "Study preparation was interrupted; the holdout cell cannot be redrawn")
            if cell["status"] in {"measured", "missing"}:
                continue
            try:
                receipt = TaskStudyExecutor.finish(
                    executor, plan, cell, cell["episode_id"], stop_event=stop_event)
                if receipt is None:
                    self._pause(plan_id, owner)
                    return {"schema": STUDY_RUN_SCHEMA, "plan_id": plan_id,
                            "status": "paused", "completed_cells": 0}
                self._advance_cell(plan, scheduled, owner, "ready", receipt)
            except ContractError:
                self._pause(plan_id, owner)
                raise
            except Exception as exc:
                usage = self.tasks.store.usage(cell["episode_id"])
                self._advance_cell(
                    plan, scheduled, owner, "ready",
                    {"status": "missing", "score": None, "accepted": None,
                     "execution_status": "error", "evaluation_digest": None,
                     "usage": {key: (usage.get(key, 0) if key == "charged_tool_work_units"
                                     else usage.get(key)) for key in _USAGE_KEYS},
                     "usage_complete": usage.get("usage_complete") is True,
                     "failure_class": "infrastructure_missing",
                     "reason": f"{type(exc).__name__}: {str(exc)[:500]}"})

        cells = []
        for scheduled in plan["schedule"]:
            cell = self._cell(scheduled["cell_id"])
            self._validate_cell(plan, scheduled, cell)
            # Reconstruct terminal evidence from the immutable Episode and
            # single-assignment benchmark result before sealing the run.
            if (cell["status"] == "missing" and cell.get("evaluation_digest") is None
                    and cell.get("failure_class") == "infrastructure_missing"):
                TaskStudyExecutor.validate_episode(
                    executor, plan, cell, cell["episode_id"])
            else:
                receipt = TaskStudyExecutor.finish(
                    executor, plan, cell, cell["episode_id"], stop_event=None)
                if receipt is None or any(cell.get(key) != receipt.get(key) for key in (
                        "status", "episode_id", "score", "accepted", "evaluation_digest",
                        "usage", "usage_complete", "execution_status", "failure_class", "reason")):
                    raise ContractError("RSI study terminal cell evidence changed")
            cells.append(cell)
        if any(cell is None or cell.get("status") not in {"measured", "missing"}
               for cell in cells):
            raise ContractError("RSI study cells are not terminal")
        run_record = {
            "schema": STUDY_RUN_SCHEMA,
            "id": "rsi-study-run-" + digest({"plan": plan_id, "cells": [
                {"id": cell["id"], "status": cell["status"],
                 "episode_id": cell["episode_id"], "score": cell.get("score"),
                 "accepted": cell.get("accepted"), "usage": cell.get("usage"),
                 "evaluation_digest": cell.get("evaluation_digest")}
                for cell in cells]})[:24],
            "created_at": time.time(), "plan_id": plan_id,
            "plan_digest": plan["record_digest"],
            "protocol_digest": plan["protocol_digest"],
            "measurement_complete": all(cell["status"] == "measured" for cell in cells),
            "cells": [{key: cell.get(key) for key in (
                "id", "row_index", "arm", "seed", "task_index", "task_digest",
                "statistical_unit_id", "cluster_id",
                "package_id", "package_digest", "binding_digest", "status", "episode_id", "score",
                "accepted", "evaluation_digest", "usage", "usage_complete",
                "execution_status", "failure_class", "reason")} for cell in cells],
        }
        encoded, record_digest = self._encode(run_record), digest(run_record)
        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("INSERT INTO task_rsi_study_runs VALUES(?,?,?)",
                       (run_record["id"], encoded, record_digest))
            changed = db.execute(
                "UPDATE task_rsi_study_claims SET status='completed',run_id=?,updated=? "
                "WHERE plan_id=? AND status=? AND run_id IS NULL",
                (run_record["id"], time.time(), plan_id, owner)).rowcount
            if changed != 1:
                raise ContractError("RSI study claim changed before completion")
        return {**run_record, "record_digest": record_digest}

    @staticmethod
    def _work(usage):
        if not isinstance(usage, dict):
            return None
        values = [usage.get(key) for key in _USAGE_KEYS]
        if any(type(value) is not int or value < 0 for value in values):
            return None
        return (usage["model_calls"] + usage["charged_completion_tokens"] / 1000.0
                + usage["tool_calls"] + usage["charged_tool_work_units"]
                + usage["nodes"])

    @staticmethod
    def _bootstrap_interval(values, confidence, seed):
        if not values:
            return None
        rng = random.Random(seed)
        means = []
        for _ in range(10000):
            means.append(sum(rng.choice(values) for _ in values) / len(values))
        means.sort()
        tail = (1.0 - confidence) / 2.0
        low = means[max(0, min(len(means) - 1, int(tail * len(means))))]
        high = means[max(0, min(len(means) - 1,
                                int((1.0 - tail) * len(means)) - 1))]
        return [low, high]

    @staticmethod
    def _sign_flip_p(values, seed):
        if not values:
            return None
        observed = abs(sum(values) / len(values))
        if len(values) <= 20:
            total, extreme = 1 << len(values), 0
            for mask in range(total):
                mean = sum(value if mask & (1 << index) else -value
                           for index, value in enumerate(values)) / len(values)
                extreme += abs(mean) >= observed - 1e-15
            return extreme / total
        rng, extreme, samples = random.Random(seed), 0, 100000
        for _ in range(samples):
            mean = sum(value if rng.randrange(2) else -value for value in values) / len(values)
            extreme += abs(mean) >= observed - 1e-15
        return (extreme + 1) / (samples + 1)

    def assess(self, run_id):
        run = self.run_record(run_id)
        plan = self.plan(run["plan_id"])
        if run["plan_digest"] != plan["record_digest"]:
            raise ContractError("Study run does not match its immutable plan")
        existing_id = "rsi-study-report-" + digest({"run": run_id})[:24]
        try:
            return _sanitize_study_report(self.report(existing_id))
        except KeyError:
            pass
        rows = {}
        for cell in run["cells"]:
            rows.setdefault(cell["row_index"], {})[cell["arm"]] = cell
        pairs, missing = [], []
        for index in range(len(plan["tasks"])):
            arms = rows.get(index, {})
            baseline = arms.get(plan["baseline_arm"])
            candidate = arms.get(plan["candidate_arm"])
            if (not baseline or not candidate or baseline["status"] != "measured"
                    or candidate["status"] != "measured"):
                missing.append({"row_index": index,
                                "baseline_status": (baseline or {}).get("status", "absent"),
                                "candidate_status": (candidate or {}).get("status", "absent")})
                continue
            task = plan["tasks"][index]
            if (baseline.get("task_digest") != task["task_digest"]
                    or candidate.get("task_digest") != task["task_digest"]
                    or baseline.get("package_id")
                       != plan["arms"][plan["baseline_arm"]]["package_id"]
                    or baseline.get("package_digest")
                       != plan["arms"][plan["baseline_arm"]]["package_digest"]
                    or candidate.get("package_id")
                       != plan["arms"][plan["candidate_arm"]]["package_id"]
                    or candidate.get("package_digest")
                       != plan["arms"][plan["candidate_arm"]]["package_digest"]):
                raise ContractError("Study pair differs from its frozen plan")
            base_work, candidate_work = self._work(baseline["usage"]), self._work(
                candidate["usage"])
            if base_work is None or candidate_work is None:
                missing.append({"row_index": index, "baseline_status": "usage_missing",
                                "candidate_status": "usage_missing"})
                continue
            pairs.append({
                "row_index": index, "task_digest": baseline["task_digest"],
                "statistical_unit_id": task["statistical_unit_id"],
                "cluster_id": task["cluster_id"],
                "baseline_episode_id": baseline["episode_id"],
                "candidate_episode_id": candidate["episode_id"],
                "baseline_score": baseline["score"], "candidate_score": candidate["score"],
                "quality_delta": candidate["score"] - baseline["score"],
                "success_delta": int(candidate["accepted"]) - int(baseline["accepted"]),
                "baseline_work": base_work, "candidate_work": candidate_work,
            })
        by_cluster = {}
        for pair in pairs:
            by_cluster.setdefault(pair["cluster_id"], []).append(pair)
        cluster_rows = []
        for cluster_id, members in sorted(by_cluster.items()):
            cluster_rows.append({
                "cluster_id": cluster_id,
                "unit_count": len(members),
                "quality_delta": sum(row["quality_delta"] for row in members) / len(members),
                "success_delta": sum(row["success_delta"] for row in members) / len(members),
            })
        deltas = [row["quality_delta"] for row in cluster_rows]
        success_deltas = [row["success_delta"] for row in cluster_rows]
        mean_delta = sum(deltas) / len(deltas) if deltas else None
        mean_success_delta = sum(success_deltas) / len(success_deltas) if deltas else None
        baseline_work = sum(pair["baseline_work"] for pair in pairs)
        candidate_work = sum(pair["candidate_work"] for pair in pairs)
        work_proxy_ratio = (candidate_work / baseline_work if baseline_work > 0
                            else 1.0 if candidate_work == 0 else math.inf)
        regressions = sum(delta < 0 for delta in deltas)
        policy = plan["policy"]
        minimum_clusters = _policy_independent_cluster_minimum(policy)
        complete = not missing and len(pairs) == len(plan["tasks"])
        enough = len(cluster_rows) >= minimum_clusters
        gates = {
            "complete_pairs": complete,
            "minimum_independent_clusters": enough,
            "minimum_pairs": enough,
            "quality": mean_delta is not None and mean_delta >= policy["min_quality_delta"],
            "success": mean_success_delta is not None
                       and mean_success_delta >= policy["min_success_delta"],
            "work_proxy": (math.isfinite(work_proxy_ratio)
                           and work_proxy_ratio <= policy["max_work_proxy_ratio"]),
            "regressions": regressions <= policy["max_regressions"],
        }
        seed = int(plan["protocol_digest"][:16], 16)
        interval = self._bootstrap_interval(deltas, policy["confidence"], seed)
        # Test the pre-registered margin, rather than silently testing zero
        # when the estimand is noninferiority or requires a positive SESOI.
        p_value = self._sign_flip_p(
            [delta - policy["min_quality_delta"] for delta in deltas], seed)
        engineering_pass = all(gates.values())
        suite_role = _study_suite_role(plan)
        claim_eligible_role = _claim_eligible_suite_role(suite_role)
        gates["claim_eligible_role"] = claim_eligible_role
        statistical_support = bool(
            engineering_pass and claim_eligible_role and interval is not None
            and interval[0] > policy["min_quality_delta"] and p_value is not None
            and p_value < (1.0 - policy["confidence"]))
        version_scope = plan.get("model_version_binding", "request_alias_time_window")
        evidence_label = _study_evidence_label(version_scope)
        record = {
            "schema": STUDY_REPORT_SCHEMA, "id": existing_id,
            "created_at": time.time(), "plan_id": plan["id"],
            "plan_digest": plan["record_digest"], "run_id": run["id"],
            "run_digest": run["record_digest"], "protocol_digest": plan["protocol_digest"],
            "complete_pair_count": len(pairs), "planned_pair_count": len(plan["tasks"]),
            "independent_cluster_count": len(cluster_rows),
            "planned_cluster_count": len({row["cluster_id"] for row in plan["tasks"]}),
            "missing": missing, "pairs": pairs, "clusters": cluster_rows,
            "metrics": {"mean_quality_delta": mean_delta,
                        "mean_success_delta": mean_success_delta,
                        "min_independent_clusters": minimum_clusters,
                        "work_proxy_ratio": (work_proxy_ratio
                                             if math.isfinite(work_proxy_ratio) else None),
                        "regressions": regressions,
                        "quality_interval": interval, "paired_sign_flip_p": p_value},
            "gates": gates, "engineering_acceptance": engineering_pass,
            "statistical_support": statistical_support,
            "suite_role": suite_role,
            "version_scope": version_scope,
            "claim_scope": (
                f"benchmark_local_{suite_role}_{evidence_label}_{policy['estimand']}_supported"
                if statistical_support else
                f"benchmark_local_{suite_role}_{evidence_label}_effect_not_established"),
        }
        return self._insert("task_rsi_study_reports", record)
