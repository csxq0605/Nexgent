"""Auditable, benchmark-gated evolution of immutable AgentPackages.

This module deliberately knows nothing about benchmark domains.  It turns a
candidate package into a paired experiment against the active parent, records
the frozen evaluator/task inputs, and keeps deployment as a separate explicit
operation.
"""

from __future__ import annotations

from copy import deepcopy
from collections import Counter
from dataclasses import asdict, dataclass
import inspect
import json
import math
import platform
import re
import time
import uuid

from ..kernel.programs import digest
from .benchmarks import (
    host_runtime_fingerprint, validate_adapter, validate_snapshot, validate_tasks,
)
from .costs import (
    COST_PROJECTION_SCHEMA, LEGACY_EVOLUTION_COST_WEIGHTS, STANDARD_COST_WEIGHTS,
    cost_projection_spec, normalized_work_projection,
)
from .outcomes import classify_benchmark_outcome, outcome_policy
from .packages import safe_path, split_ref, verify_package
from .tools import ContractError


def _copy(value, label="Evolution value"):
    try:
        return json.loads(json.dumps(value, ensure_ascii=False, allow_nan=False))
    except (TypeError, ValueError, RecursionError) as exc:
        raise ContractError(f"{label} must be finite JSON: {str(exc)[:500]}") from None


def _identifier(value, label):
    if not isinstance(value, str) or not re.fullmatch(r"[a-z][a-z0-9_.-]{0,99}", value):
        raise ContractError(f"{label} must be a bounded lowercase identifier")
    return value


def _id(prefix):
    return prefix + "-" + uuid.uuid4().hex[:16]


def _manifest_component(package, component_id):
    """Resolve a stable v2 id without accepting caller-supplied path/class data."""
    manifest = package["manifest"]
    if manifest.get("manifest_version", 1) != 2:
        raise ContractError("Stable component targets require manifest v2")
    component = manifest.get("components", {}).get(component_id)
    if not isinstance(component, dict):
        raise ContractError(f"Unknown manifest component id: {component_id!r}")
    component_class, kind, ref = (component.get("class"), component.get("kind"),
                                  component.get("ref"))
    try:
        if kind == "entry":
            files = [split_ref(manifest["entries"][ref], package["files"])[0]]
        elif kind == "skill":
            skill = manifest.get("skills", {})[ref]
            files = [split_ref(skill["ref"], package["files"])[0]
                     if skill["kind"] == "controlled_code" else skill["ref"]]
        elif kind == "workflow":
            files = [manifest["workflows"][ref]["ref"]]
        elif kind == "role":
            prompt_ref = manifest["roles"][ref].get("prompt_ref")
            files = [] if prompt_ref is None else [prompt_ref]
        elif kind == "resource":
            files = [ref]
        else:
            raise KeyError(kind)
    except (KeyError, TypeError, ValueError):
        raise ContractError(
            f"Manifest component {component_id!r} cannot resolve its frozen reference") from None
    for path in files:
        try:
            safe_path(path)
        except Exception as exc:
            raise ContractError(str(exc)) from None
        if path not in package["files"]:
            raise ContractError(
                f"Manifest component {component_id!r} resolves outside the package")
    return {"component_id": component_id, "class": component_class,
            "kind": kind, "ref": ref, "files": files}


def _loaded_evidence(component, execution, package):
    if component.get("kind") == "component_set":
        loaded_modules = (execution or {}).get("loaded_modules") or []
        package_loaded = (execution or {}).get("package_digest") == package["digest"]
        members = []
        for identity in component["component_ids"]:
            member = component["members"][identity]
            if member["operation"] == "remove":
                old_files = member["parent"]["files"]
                absent = (identity not in package["manifest"]["components"]
                          and all(path not in package["files"] and path not in loaded_modules
                                  for path in old_files))
                members.append({"component_id": identity, "operation": "remove",
                                "parent_files": old_files, "absent": absent,
                                "loaded": absent and package_loaded})
            else:
                actual = _loaded_evidence(member["child"], execution, package)
                members.append({"component_id": identity,
                                "operation": member["operation"], **actual})
        return {"kind": "component_set", "component_ids": component["component_ids"],
                "members": members, "expected_package_digest": package["digest"],
                "loaded_package_digest": (execution or {}).get("package_digest"),
                "loaded": package_loaded and all(row["loaded"] for row in members)}
    loaded_modules = (execution or {}).get("loaded_modules") or []
    actual = [path for path in component["files"] if path in loaded_modules]
    expected_digests = {
        path: package["component_digests"][path] for path in component["files"]}
    loaded_digests = {path: expected_digests[path] for path in actual}
    package_loaded = (execution or {}).get("package_digest") == package["digest"]
    return {"component_id": component["component_id"],
            "class": component["class"], "kind": component["kind"],
            "ref": component["ref"], "expected_files": list(component["files"]),
            "expected_file_digests": expected_digests,
            "loaded_files": actual, "loaded_modules": list(loaded_modules),
            "loaded_file_digests": loaded_digests,
            "loaded_modules_digest": digest(loaded_modules),
            "expected_package_digest": package["digest"],
            "loaded_package_digest": (execution or {}).get("package_digest"),
            "loaded": (bool(component["files"])
                       and len(actual) == len(component["files"])
                       and loaded_digests == expected_digests and package_loaded)}


@dataclass(frozen=True)
class PromotionPolicy:
    """Domain-neutral gates applied to paired aggregate measurements."""

    min_quality_delta: float = 0.0
    min_success_rate: float = 1.0
    max_cost_ratio: float = 1.0
    max_absolute_cost_when_parent_zero: float = 0.0
    max_regressions: int = 0
    monitor_min_score: float = 0.0
    monitor_min_success_rate: float = 1.0

    def __post_init__(self):
        finite = (self.min_quality_delta, self.min_success_rate, self.max_cost_ratio,
                  self.max_absolute_cost_when_parent_zero, self.monitor_min_score,
                  self.monitor_min_success_rate)
        if (any(type(value) not in {int, float} or not math.isfinite(value) for value in finite)
                or not 0 <= self.min_success_rate <= 1
                or not 0 <= self.monitor_min_success_rate <= 1
                or self.max_cost_ratio < 0 or self.max_absolute_cost_when_parent_zero < 0
                or type(self.max_regressions) is not int or self.max_regressions < 0):
            raise ValueError("Invalid promotion policy")


class EvolutionService:
    """Persist candidate lineage, paired trials, decisions, and deployments."""

    def __init__(self, task_service):
        self.tasks = task_service
        self.store = task_service.store
        with self.store.connect() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS task_evolution_candidates(
                    id TEXT PRIMARY KEY, data TEXT NOT NULL, digest TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS task_evolution_plans(
                    id TEXT PRIMARY KEY, data TEXT NOT NULL, digest TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS task_evolution_monitor_plans(
                    id TEXT PRIMARY KEY, data TEXT NOT NULL, digest TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS task_evolution_monitor_runs(
                    id TEXT PRIMARY KEY, data TEXT NOT NULL, digest TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS task_evolution_run_claims(
                    kind TEXT NOT NULL, plan_id TEXT NOT NULL, status TEXT NOT NULL,
                    record_id TEXT, created REAL NOT NULL, updated REAL NOT NULL,
                    PRIMARY KEY(kind,plan_id));
                CREATE TABLE IF NOT EXISTS task_evolution_trials(
                    id TEXT PRIMARY KEY, data TEXT NOT NULL, digest TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS task_evolution_decisions(
                    id TEXT PRIMARY KEY, data TEXT NOT NULL, digest TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS task_package_channels(
                    name TEXT PRIMARY KEY, package_id TEXT NOT NULL, revision INTEGER NOT NULL,
                    data TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS task_evolution_events(
                    channel TEXT, sequence INTEGER, kind TEXT, created REAL, data TEXT,
                    previous TEXT, digest TEXT, PRIMARY KEY(channel,sequence));
            """)

    @staticmethod
    def _encode(value):
        return json.dumps(value, ensure_ascii=False, sort_keys=True,
                          separators=(",", ":"), allow_nan=False)

    def _insert(self, table, record):
        encoded = self._encode(record)
        record_digest = digest(record)
        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            old = db.execute(f"SELECT data,digest FROM {table} WHERE id=?", (record["id"],)).fetchone()
            if old and old != (encoded, record_digest):
                raise ContractError("Cannot overwrite an immutable evolution record")
            db.execute(f"INSERT OR IGNORE INTO {table} VALUES(?,?,?)",
                       (record["id"], encoded, record_digest))
        result = deepcopy(record)
        result["record_digest"] = record_digest
        return result

    def _get(self, table, identity):
        with self.store.connect() as db:
            row = db.execute(f"SELECT data,digest FROM {table} WHERE id=?", (identity,)).fetchone()
        if not row:
            raise KeyError(identity)
        record = json.loads(row[0])
        if digest(record) != row[1]:
            raise ContractError("Evolution record digest mismatch")
        record["record_digest"] = row[1]
        return record

    def _claim_run(self, kind, plan_id):
        now = time.time()
        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                "SELECT status,record_id FROM task_evolution_run_claims WHERE kind=? AND plan_id=?",
                (kind, plan_id)).fetchone()
            if row:
                if row[0] == "completed" and row[1]:
                    return row[1]
                raise ContractError(f"{kind} plan is already claimed and cannot be repeated")
            db.execute("INSERT INTO task_evolution_run_claims VALUES(?,?,?,?,?,?)",
                       (kind, plan_id, "running", None, now, now))
        return None

    def _finish_run(self, kind, plan_id, record_id):
        claim = self.recover_run_claim(kind, plan_id)
        if (claim is None or claim["status"] != "completed"
                or claim["record_id"] != record_id):
            raise ContractError(f"{kind} plan claim changed before completion")

    def _durable_run_records(self, kind, plan_id):
        table, plan_key = (("task_evolution_trials", "plan_id") if kind == "paired" else
                           ("task_evolution_monitor_runs", "monitor_plan_id"))
        with self.store.connect() as db:
            rows = db.execute(f"SELECT id,data,digest FROM {table}").fetchall()
        matches = []
        for identity, data, record_digest in rows:
            record = json.loads(data)
            if record.get(plan_key) != plan_id:
                continue
            if record.get("id") != identity or digest(record) != record_digest:
                raise ContractError("Durable evolution run record digest mismatch")
            matches.append({**record, "record_digest": record_digest})
        if len(matches) > 1:
            raise ContractError("Evolution plan has multiple durable run records")
        return matches

    def inspect_run_claim(self, kind, plan_id):
        """Inspect and verify a paired/monitor single-consumption claim."""
        if kind not in {"paired", "monitor"}:
            raise ContractError("Evolution run claim kind must be paired or monitor")
        if kind == "paired":
            self.plan(plan_id)
        else:
            self.monitor_plan(plan_id)
        with self.store.connect() as db:
            row = db.execute(
                "SELECT status,record_id,created,updated FROM task_evolution_run_claims "
                "WHERE kind=? AND plan_id=?", (kind, plan_id)).fetchone()
        if row is None:
            return None
        status, record_id, created, updated = row
        durable = self._durable_run_records(kind, plan_id)
        if status == "running" and record_id is not None:
            raise ContractError("Running evolution claim unexpectedly has a record")
        if status == "completed":
            if not isinstance(record_id, str) or not record_id:
                raise ContractError("Completed evolution claim has no record")
            if kind == "paired":
                record = self.trial(record_id)
                linked_plan = record.get("plan_id")
            else:
                record = self._get("task_evolution_monitor_runs", record_id)
                linked_plan = record.get("monitor_plan_id")
            if linked_plan != plan_id:
                raise ContractError("Evolution run claim record belongs to another plan")
            if len(durable) != 1 or durable[0]["id"] != record_id:
                raise ContractError("Completed evolution claim lost its unique durable record")
        elif status != "running":
            raise ContractError("Evolution run claim status is invalid")
        return {"kind": kind, "plan_id": plan_id, "status": status,
                "record_id": record_id, "created_at": created, "updated_at": updated,
                "durable_record_id": durable[0]["id"] if durable else None}

    def recover_run_claim(self, kind, plan_id, *, confirm_no_external_commit=False):
        """Clear only an explicitly confirmed uncommitted running claim."""
        if type(confirm_no_external_commit) is not bool:
            raise TypeError("confirm_no_external_commit must be boolean")
        claim = self.inspect_run_claim(kind, plan_id)
        if claim is None or claim["status"] == "completed":
            return claim
        if claim["durable_record_id"] is not None:
            record_id = claim["durable_record_id"]
            record = (self.trial(record_id) if kind == "paired" else
                      self._get("task_evolution_monitor_runs", record_id))
            if kind == "paired":
                event_kind = "paired_trial_recorded"
                event_content = {
                    "candidate_id": record["candidate_id"], "plan_id": plan_id,
                    "trial_id": record_id, "suite_digest": record["suite_digest"],
                    "policy_digest": record["policy_digest"],
                    "component_id": record.get("component_id"),
                    "loaded_evidence_digest": digest([
                        (pair.get("candidate") or {}).get("loaded_evidence")
                        for pair in record.get("pairs", [])]),
                    "record_digest": record["record_digest"]}
                event_record_key = "trial_id"
            else:
                event_kind = "monitoring_run_recorded"
                event_content = {
                    "monitor_run_id": record_id, "monitor_plan_id": plan_id,
                    "suite_digest": record["suite_digest"],
                    "episode_ids": record["episode_ids"],
                    "component_id": record.get("component_id"),
                    "loaded_evidence_digest": digest([
                        report.get("loaded_evidence")
                        for report in record.get("reports", [])]),
                    "record_digest": record["record_digest"]}
                event_record_key = "monitor_run_id"
            with self.store.connect() as db:
                db.execute("BEGIN IMMEDIATE")
                current = db.execute(
                    "SELECT status,record_id FROM task_evolution_run_claims "
                    "WHERE kind=? AND plan_id=?", (kind, plan_id)).fetchone()
                if current != ("running", None):
                    raise ContractError("Evolution run claim changed during durable recovery")
                durable_row = db.execute(
                    "SELECT data,digest FROM "
                    + ("task_evolution_trials" if kind == "paired" else
                       "task_evolution_monitor_runs") + " WHERE id=?", (record_id,)).fetchone()
                if (durable_row is None or json.loads(durable_row[0]) != {
                        key: value for key, value in record.items() if key != "record_digest"}
                        or durable_row[1] != record["record_digest"]):
                    raise ContractError("Durable evolution run changed during recovery")
                event_rows = db.execute(
                    "SELECT data FROM task_evolution_events WHERE channel=? AND kind=?",
                    (record["channel"], event_kind)).fetchall()
                linked_events = [json.loads(data) for (data,) in event_rows
                                 if json.loads(data).get(event_record_key) == record_id]
                if len(linked_events) > 1:
                    raise ContractError("Durable evolution run has duplicate completion events")
                if linked_events and linked_events[0] != event_content:
                    raise ContractError("Durable evolution run completion event changed")
                if not linked_events:
                    self._append_event(db, record["channel"], event_kind, event_content)
                changed = db.execute(
                    "UPDATE task_evolution_run_claims "
                    "SET status='completed',record_id=?,updated=? "
                    "WHERE kind=? AND plan_id=? AND status='running' AND record_id IS NULL",
                    (record_id, time.time(), kind, plan_id)).rowcount
                if changed != 1:
                    raise ContractError("Evolution run claim changed during durable recovery")
            return self.inspect_run_claim(kind, plan_id)
        if not confirm_no_external_commit:
            raise ContractError(
                "Running evolution claim requires explicit no-commit confirmation")
        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            changed = db.execute(
                "DELETE FROM task_evolution_run_claims "
                "WHERE kind=? AND plan_id=? AND status='running' AND record_id IS NULL",
                (kind, plan_id)).rowcount
        if changed != 1:
            raise ContractError("Evolution run claim changed during recovery")
        return None

    @staticmethod
    def _expected_deployment(active, *, expected_revision=None,
                             expected_package_id=None, expected_monitor_plan_id=None):
        expected = (expected_revision, expected_package_id, expected_monitor_plan_id)
        if all(value is None for value in expected):
            return
        if any(value is None for value in expected):
            raise ContractError("Expected deployment binding must be complete")
        promotion = active.get("promotion") or {}
        if (active.get("revision") != expected_revision
                or active.get("package_id") != expected_package_id
                or promotion.get("monitor_plan_id") != expected_monitor_plan_id):
            raise ContractError("Active deployment differs from the expected binding")

    def _environment_snapshot(self, tasks):
        capabilities = sorted({name for task in tasks for name in task.get("capabilities", [])})
        gateway = self.tasks.gateway_factory
        if gateway is None:
            gateway_identity = None
        else:
            target = gateway if inspect.isfunction(gateway) or inspect.ismethod(gateway) else type(gateway)
            gateway_identity = {
                "module": getattr(target, "__module__", None),
                "qualname": getattr(target, "__qualname__", type(target).__qualname__),
            }
            try:
                gateway_identity["source_digest"] = digest(inspect.getsource(target))
            except (OSError, TypeError):
                gateway_identity["source_digest"] = None
        tools = []
        for name in capabilities:
            spec = self.tasks.tools.get(name)
            handler = spec.handler
            target = handler if inspect.isfunction(handler) or inspect.ismethod(handler) else type(handler)
            try:
                handler_digest = digest(inspect.getsource(target))
            except (OSError, TypeError):
                handler_digest = None
            tools.append({**spec.describe(), "handler": {
                "module": getattr(target, "__module__", None),
                "qualname": getattr(target, "__qualname__", type(target).__qualname__),
                "source_digest": handler_digest,
            }})
        model_configuration = None
        if gateway is None:
            try:
                from ..models.config import load_profiles
                profiles, defaults = load_profiles(self.tasks.project_root)
                model_configuration = {
                    "defaults": _copy(defaults),
                    "profiles": {name: {"model": profile.model, "base_url": profile.base_url}
                                 for name, profile in sorted(profiles.items())},
                }
            except Exception as exc:
                model_configuration = {"unavailable": type(exc).__name__}
        snapshot = {
            "schema": "nexgent.task-execution-environment.v1",
            "python": platform.python_version(), "platform": platform.system(),
            "task_service_source_digest": digest(inspect.getsource(type(self.tasks))),
            "gateway_factory": gateway_identity,
            "tools": tools,
            "model_configuration": model_configuration,
            "model_receipts": "recorded-per-episode-not-gated",
        }
        return _copy(snapshot, "Execution environment snapshot")

    def _append_event(self, db, channel, kind, content):
        content = _copy(content)
        row = db.execute(
            "SELECT sequence,digest FROM task_evolution_events WHERE channel=? "
            "ORDER BY sequence DESC LIMIT 1", (channel,)).fetchone()
        sequence, previous = (row[0] + 1, row[1]) if row else (1, "genesis")
        record = {"channel": channel, "sequence": sequence, "kind": kind,
                  "created": time.time(), "content": content, "previous": previous}
        record["digest"] = digest(record)
        db.execute("INSERT INTO task_evolution_events VALUES(?,?,?,?,?,?,?)",
                   (channel, sequence, kind, record["created"], self._encode(content),
                    previous, record["digest"]))
        return record

    def _event(self, channel, kind, content):
        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            return self._append_event(db, channel, kind, content)

    def events(self, channel):
        _identifier(channel, "Package channel")
        with self.store.connect() as db:
            rows = db.execute(
                "SELECT sequence,kind,created,data,previous,digest FROM task_evolution_events "
                "WHERE channel=? ORDER BY sequence", (channel,)).fetchall()
        result, previous = [], "genesis"
        for sequence, kind, created, data, stored_previous, record_digest in rows:
            record = {"channel": channel, "sequence": sequence, "kind": kind,
                      "created": created, "content": json.loads(data), "previous": stored_previous}
            if stored_previous != previous or digest(record) != record_digest:
                raise ContractError("Evolution event chain is invalid")
            record["digest"] = record_digest
            result.append(record)
            previous = record_digest
        return result

    def register(self, channel, package):
        """Create a channel with its immutable generation-zero package."""
        channel = _identifier(channel, "Package channel")
        verify_package(package)
        if self.store.is_task_scoped_package(package):
            raise ContractError(
                "Task-authored packages require an explicit adoption before deployment")
        if package["generation"] != 0:
            raise ContractError("A new channel must start from a generation-zero package")
        self.store.put_package(package)
        state = {"channel": channel, "package_id": package["id"],
                 "package_digest": package["digest"], "revision": 0, "promotion": None,
                 "updated_at": time.time()}
        encoded = self._encode(state)
        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if db.execute("SELECT 1 FROM task_package_channels WHERE name=?", (channel,)).fetchone():
                raise ContractError(f"Package channel already exists: {channel}")
            db.execute("INSERT INTO task_package_channels VALUES(?,?,?,?)",
                       (channel, package["id"], 0, encoded))
            self._append_event(db, channel, "channel_registered", {"package_id": package["id"],
                                                                    "package_digest": package["digest"]})
        return self.active(channel)

    def active(self, channel):
        channel = _identifier(channel, "Package channel")
        with self.store.connect() as db:
            row = db.execute("SELECT package_id,revision,data FROM task_package_channels WHERE name=?",
                             (channel,)).fetchone()
        if not row:
            raise KeyError(channel)
        state = json.loads(row[2])
        if state.get("package_id") != row[0] or state.get("revision") != row[1]:
            raise ContractError("Active package registry projection mismatch")
        package = self.store.package(row[0])
        if package["digest"] != state["package_digest"]:
            raise ContractError("Active package registry digest mismatch")
        state["package"] = package
        return state

    def propose(self, channel, package, *, hypothesis, feedback_episode_ids,
                activation_probe=None, component_classes=None, component_target=None,
                origin="imported", package_patch=None, mutation_policy=None):
        """Admit a candidate bound to local non-holdout feedback and a hypothesis."""
        active = self.active(channel)
        verify_package(package, active["package"])
        if self.store.is_task_scoped_package(package):
            raise ContractError(
                "Task-authored packages require an explicit adoption before evolution")
        if isinstance(hypothesis, str):
            if not hypothesis.strip() or len(hypothesis) > 20000:
                raise ContractError("Candidate hypothesis must be nonempty bounded text")
            hypothesis = hypothesis.strip()
        elif isinstance(hypothesis, dict):
            hypothesis = _copy(hypothesis, "Candidate hypothesis")
            if not hypothesis or len(self._encode(hypothesis)) > 20000:
                raise ContractError("Candidate hypothesis must be a nonempty bounded object")
        else:
            raise ContractError("Candidate hypothesis must be nonempty bounded text or an object")
        if origin not in {"imported", "generated"}:
            raise ContractError("Candidate origin must be imported or generated")
        parent = active["package"]
        manifest_v2 = parent["manifest"].get("manifest_version", 1) == 2
        if (package["manifest"].get("entries", {}).get("improve")
                != parent["manifest"].get("entries", {}).get("improve")):
            raise ContractError("Candidate cannot change the frozen improve entry")
        component_set = package_patch is not None
        if not component_set and package["manifest"] != parent["manifest"]:
            raise ContractError("Candidates must preserve the frozen parent manifest")
        activation_probe = ({"kind": "package_loaded"} if activation_probe is None
                            else _copy(activation_probe, "Activation probe"))
        if component_set:
            from .package_patch_v3 import apply_package_patch
            if not manifest_v2 or component_target is not None or component_classes not in (None, {}):
                raise ContractError("PackagePatch v3 requires host-resolved manifest-v2 targets")
            if not isinstance(activation_probe, dict) or set(activation_probe) != {
                    "kind", "component_ids"} or activation_probe.get("kind") != "component_set_loaded":
                raise ContractError("PackagePatch v3 needs a component-set activation probe")
            patch = _copy(package_patch, "PackagePatch")
            if hypothesis != patch.get("hypothesis") or activation_probe.get(
                    "component_ids") != patch.get("activation_targets"):
                raise ContractError("PackagePatch hypothesis or activation identity changed")
            provenance = deepcopy(package.get("provenance") or {})
            provenance.pop("package_patch_digest", None)
            replay = apply_package_patch(parent, patch, mutation_policy,
                                         provenance=provenance)
            if replay != package:
                raise ContractError("Candidate differs from the host-replayed PackagePatch")
            ids = patch["activation_targets"]
            members = {}
            for operation in patch["operations"]:
                identity = operation["component_id"]
                members[identity] = {
                    "operation": operation["op"],
                    "parent": (_manifest_component(parent, identity)
                               if operation["op"] != "add" else None),
                    "child": (_manifest_component(package, identity)
                              if operation["op"] != "remove" else None),
                }
            resolved_target = {"kind": "component_set", "component_ids": ids,
                               "members": members,
                               "package_patch_digest": digest(patch),
                               "mutation_policy_digest": digest(mutation_policy)}
            component_classes = {
                identity: (member["child"] or member["parent"])["class"]
                for identity, member in members.items()}
            component_id = None
            targeting = "manifest_component_set_v3"
        elif manifest_v2:
            if (not isinstance(activation_probe, dict)
                    or set(activation_probe) != {"kind", "component_id"}
                    or activation_probe.get("kind") != "component_loaded"
                    or not isinstance(activation_probe.get("component_id"), str)):
                raise ContractError(
                    "Manifest v2 candidate activation probe must use a stable component id")
            resolved_target = _manifest_component(parent, activation_probe["component_id"])
            if not resolved_target["files"]:
                raise ContractError("Manifest component has no loadable declared file")
            if resolved_target["class"] not in {"O", "S"}:
                raise ContractError(
                    "Component-targeted manifest v2 evolution currently permits only O or S")
            if component_target is not None and _copy(
                    component_target, "Component target") != resolved_target:
                raise ContractError("Candidate component target differs from the frozen manifest")
            if component_classes not in (None, {}):
                raise ContractError(
                    "Manifest v2 candidate classes are resolved by the host, not the caller")
            component_id = resolved_target["component_id"]
            if (not isinstance(hypothesis, dict)
                    or hypothesis.get("component_id") != component_id):
                raise ContractError(
                    "Manifest v2 candidate hypothesis must name the target component id")
            component_classes = {component_id: resolved_target["class"]}
            targeting = "manifest_component_v2"
        else:
            if (not isinstance(activation_probe, dict)
                    or activation_probe.get("kind") not in {"package_loaded", "component_loaded"}
                    or activation_probe.get("kind") == "component_loaded"
                    and (not isinstance(activation_probe.get("path"), str)
                         or activation_probe["path"] not in package["files"])):
                raise ContractError("Candidate activation probe is invalid")
            component_classes = {} if component_classes is None else _copy(
                component_classes, "Component classes")
            if (not isinstance(component_classes, dict)
                    or any(value not in {"O", "M", "S"} for value in component_classes.values())):
                raise ContractError("Candidate component classes must use O, M, or S")
            resolved_target = None
            component_id = None
            targeting = "legacy_path_v1"
        if (not isinstance(feedback_episode_ids, list) or not feedback_episode_ids
                or len(feedback_episode_ids) > 256
                or any(not isinstance(identity, str) for identity in feedback_episode_ids)
                or len(set(feedback_episode_ids)) != len(feedback_episode_ids)):
            raise ContractError("Candidate feedback episodes must be a nonempty unique list")
        feedback = []
        for identity in feedback_episode_ids:
            try:
                episode = self.store.get(identity)
            except KeyError:
                raise ContractError(f"Candidate feedback episode is not local: {identity}") from None
            context = episode["task"].get("context", {})
            registration = self.store.benchmark_registration(identity) or {}
            registered_ref = registration.get("task_ref", {}) if isinstance(registration, dict) else {}
            registered_context = (registered_ref.get("context", {})
                                  if isinstance(registered_ref, dict) else {})
            if (context.get("split") in {"holdout", "final_holdout"}
                    or context.get("split_role") in {"holdout", "final_holdout"}
                    or registered_context.get("split") in {"holdout", "final_holdout"}
                    or registered_context.get("split_role") in {"holdout", "final_holdout"}):
                raise ContractError("Final holdout episodes cannot be candidate feedback")
            feedback.append({"episode_id": identity, "package_id": episode["package_id"],
                             "status": episode["status"], "updated_at": episode["updated_at"]})

        parent_improve = parent["manifest"]["entries"].get("improve")
        candidate_improve = package["manifest"]["entries"].get("improve")
        if candidate_improve != parent_improve:
            raise ContractError("Candidate cannot change the frozen improve entry")
        if parent_improve is not None:
            improve_path = parent_improve.split(":", 1)[0]
            if package["files"].get(improve_path) != parent["files"].get(improve_path):
                raise ContractError("Candidate cannot change the frozen improve entry file")

        old, new = parent["component_digests"], package["component_digests"]
        component_delta = {
            "added": sorted(set(new) - set(old)),
            "removed": sorted(set(old) - set(new)),
            "changed": sorted(path for path in set(old) & set(new) if old[path] != new[path]),
            "manifest_changed": parent["manifest"] != package["manifest"],
        }
        if not (component_delta["added"] or component_delta["removed"]
                or component_delta["changed"] or component_delta["manifest_changed"]):
            raise ContractError("Candidate package has no component delta")
        if manifest_v2 and not component_set:
            changed_files = set(component_delta["added"] + component_delta["removed"]
                                + component_delta["changed"])
            overlapping = {
                path: sorted(component_id for component_id in parent["manifest"]["components"]
                             if path in _manifest_component(parent, component_id)["files"])
                for path in changed_files}
            if (component_delta["manifest_changed"]
                    or not changed_files
                    or not changed_files <= set(resolved_target["files"])
                    or any(owners != [component_id]
                           for owners in overlapping.values())):
                raise ContractError(
                    "Manifest v2 candidate crosses its declared component boundary")
        evidence = {"hypothesis": hypothesis, "feedback": feedback,
                    "component_delta": component_delta, "parent_package_digest": parent["digest"],
                    "package_digest": package["digest"], "activation_probe": activation_probe,
                    "component_classes": component_classes, "component_id": component_id,
                    "component_target": resolved_target, "targeting": targeting,
                    "origin": origin}
        self.store.put_package(package)
        record = {"id": _id("candidate"), "channel": channel,
                  "parent_package_id": active["package_id"],
                  "parent_package_digest": active["package_digest"],
                  "package_id": package["id"], "package_digest": package["digest"],
                  "generation": package["generation"], "hypothesis": hypothesis,
                  "feedback_episode_ids": list(feedback_episode_ids),
                  "feedback_evidence": feedback,
                  "component_delta": component_delta, "component_classes": component_classes,
                  "component_id": component_id, "component_target": resolved_target,
                  "targeting": targeting, "legacy_path_patch": not manifest_v2,
                  "activation_probe": activation_probe, "origin": origin,
                  "evidence_digest": digest(evidence),
                  "created_at": time.time()}
        result = self._insert("task_evolution_candidates", record)
        self._event(channel, "candidate_admitted", {"candidate_id": record["id"],
                    "parent_package_id": record["parent_package_id"],
                    "package_id": record["package_id"], "evidence_digest": record["evidence_digest"],
                    "record_digest": result["record_digest"]})
        return result

    def candidate(self, candidate_id):
        return self._get("task_evolution_candidates", candidate_id)

    def _verify_generated_candidate(self, candidate):
        """Prove deployment authority came from one complete GenerationService run."""
        if candidate.get("origin") != "generated":
            raise ContractError("Only feedback-generated candidates can be promoted")
        try:
            with self.store.connect() as db:
                generation_rows = db.execute(
                    "SELECT data,digest FROM task_candidate_generations").fetchall()
                feedback_rows = db.execute(
                    "SELECT data,digest FROM task_feedback_bundles").fetchall()
        except Exception as exc:
            raise ContractError("Candidate has no verifiable generation closure") from exc

        matches = []
        for data, stored_digest in generation_rows:
            record = json.loads(data)
            if record.get("candidate_id") == candidate["id"]:
                if digest(record) != stored_digest:
                    raise ContractError("Candidate generation record digest mismatch")
                matches.append(record)
        if len(matches) != 1:
            raise ContractError("Candidate must have exactly one immutable generation record")
        generation = matches[0]
        required = (
            generation.get("status") == "generated"
            and generation.get("channel") == candidate["channel"]
            and generation.get("parent_package_id") == candidate["parent_package_id"]
            and generation.get("parent_package_digest") == candidate["parent_package_digest"]
            and generation.get("candidate_package_id") == candidate["package_id"]
            and generation.get("candidate_package_digest") == candidate["package_digest"]
            and isinstance(generation.get("feedback_bundle_id"), str)
            and isinstance(generation.get("feedback_digest"), str)
            and isinstance(generation.get("episode_id"), str)
            and isinstance(generation.get("patch_digest"), str)
        )
        if not required:
            raise ContractError("Candidate generation closure is incomplete")

        feedback_matches = []
        for data, stored_digest in feedback_rows:
            record = json.loads(data)
            if record.get("id") == generation["feedback_bundle_id"]:
                if digest(record) != stored_digest:
                    raise ContractError("Candidate feedback record digest mismatch")
                feedback_matches.append(record)
        if len(feedback_matches) != 1:
            raise ContractError("Candidate generation feedback is not immutable and unique")
        feedback = feedback_matches[0]
        feedback_episode_ids = [row.get("episode_id") for row in feedback.get("episode_refs", [])]
        if (feedback.get("digest") != generation["feedback_digest"]
                or feedback.get("channel") != candidate["channel"]
                or feedback.get("channel_revision") != generation.get("channel_revision")
                or feedback.get("parent_package_id") != candidate["parent_package_id"]
                or feedback.get("parent_package_digest") != candidate["parent_package_digest"]
                or feedback_episode_ids != candidate.get("feedback_episode_ids")):
            raise ContractError("Candidate feedback-to-generation linkage is invalid")

        try:
            episode = self.tasks.get_private(generation["episode_id"])
            artifact = self.store.read(episode["output_refs"]["behavior_patch"], episode["id"])
        except (KeyError, PermissionError, ValueError) as exc:
            raise ContractError("Candidate improver execution receipt is missing") from exc
        execution = episode.get("execution") or {}
        improver = self.store.package(generation.get("improver_package_id"))
        child = self.store.package(candidate["package_id"])
        provenance = child.get("provenance") or {}
        improve_path = (generation.get("improver_entry") or "").split(":", 1)[0]
        component_targeted = candidate.get("targeting") == "manifest_component_v2"
        component_set_targeted = candidate.get("targeting") == "manifest_component_set_v3"
        artifact_content = artifact.get("content")
        if (episode.get("status") != "completed"
                or set(episode.get("output_refs", {})) != {"behavior_patch"}
                or episode.get("task", {}).get("entry") != "improve"
                or episode.get("package_id") != generation.get("improver_package_id")
                or episode.get("package_digest") != generation.get("improver_package_digest")
                or improver.get("digest") != generation.get("improver_package_digest")
                or generation.get("improver_closure") != improver.get("component_digests")
                or generation.get("improver_closure_digest") != digest({
                    "entry": generation.get("improver_entry"),
                    "components": improver.get("component_digests")})
                or execution.get("entry") != "improve"
                or execution.get("package_digest") != generation.get("improver_package_digest")
                or improve_path not in (execution.get("loaded_modules") or [])
                or episode.get("usage", {}).get("usage_complete") is not True
                or generation.get("usage") != episode.get("usage")
                or generation.get("execution") != execution
                or generation.get("targeting") != candidate.get("targeting")
                or generation.get("legacy_path_patch") != candidate.get("legacy_path_patch")
                or generation.get("component_id") != candidate.get("component_id")
                or generation.get("component_target") != candidate.get("component_target")
                or (component_targeted
                    and (generation.get("patch_contract") != "nexgent.behavior-patch.v2"
                         or not isinstance(artifact_content, dict)
                         or artifact_content.get("schema") != "nexgent.behavior-patch.v2"
                         or child.get("manifest") != self.store.package(
                             candidate["parent_package_id"]).get("manifest")))
                or (component_set_targeted
                    and (generation.get("patch_contract") != "nexgent.package-patch.v3"
                         or not isinstance(artifact_content, dict)
                         or artifact_content.get("schema") != "nexgent.package-patch.v3"
                         or candidate.get("component_target", {}).get(
                             "package_patch_digest") != generation.get("patch_digest")))
                or (not component_targeted and not component_set_targeted
                    and (generation.get("patch_contract") not in {
                             None, "nexgent.behavior-patch.v1"}
                         or not isinstance(artifact_content, dict)
                         or artifact_content.get("schema") != "nexgent.behavior-patch.v1"))
                or digest(artifact_content) != generation["patch_digest"]
                or artifact.get("producer", {}).get("package_digest")
                != generation.get("improver_package_digest")
                or provenance.get("origin") != "generated"
                or provenance.get("generation_id") != generation.get("id")
                or provenance.get("feedback_bundle_id") != feedback.get("id")
                or provenance.get("feedback_digest") != feedback.get("digest")
                or provenance.get("improver_package_id") != improver.get("id")
                or provenance.get("improver_package_digest") != improver.get("digest")
                or provenance.get("behavior_patch_digest") != generation["patch_digest"]):
            raise ContractError("Candidate improver execution closure is invalid")
        if component_set_targeted:
            from .package_patch_v3 import apply_package_patch
            parent = self.store.package(candidate["parent_package_id"])
            source_provenance = deepcopy(provenance)
            source_provenance.pop("package_patch_digest", None)
            replay = apply_package_patch(
                parent, artifact_content,
                (generation.get("mutation_policy") or {}).get("package_patch_policy"),
                provenance=source_provenance)
            if replay != child:
                raise ContractError("Candidate PackagePatch replay differs from generation")
        return generation

    @staticmethod
    def _cost(usage):
        projection = EvolutionService._cost_projection(usage)
        return projection["conservative_work"] if projection is not None else 0.0

    @staticmethod
    def _cost_projection(usage, weights=STANDARD_COST_WEIGHTS):
        return normalized_work_projection(usage, weights)

    def _create_frozen(self, package, benchmark_id, task_ref, snapshot, budget, registration):
        context = deepcopy(task_ref.get("context") or {})
        if "evolution_registration" in context:
            raise ContractError("Evolution registration context is host-owned")
        context["split"] = registration["split"]
        context["evolution_registration"] = deepcopy(registration)
        context["memory_writeback"] = False
        benchmark_registration = {"benchmark_id": benchmark_id,
                                  "task_ref": deepcopy(task_ref),
                                  "snapshot": deepcopy(snapshot),
                                  "host_runtime": host_runtime_fingerprint()}
        return self.tasks.create(
            task_ref["objective"], task_ref.get("inputs"), task_ref.get("deliverables"), budget,
            task_ref.get("capabilities"), package, context,
            constraints=task_ref.get("constraints"),
            benchmark_registration=benchmark_registration)

    def _run_frozen(self, state, adapter, task_ref, snapshot, stop_event):
        error = None
        try:
            self.tasks.run(state["id"], stop_event=stop_event)
            result = self.tasks.evaluate(state["id"], adapter, deepcopy(task_ref), snapshot=deepcopy(snapshot))
        except Exception as exc:  # failure is evidence and must never become deployment authority
            error = {"type": type(exc).__name__, "message": str(exc)[:1000]}
            current = self.tasks.get_private(state["id"])
            result = {"episode_id": state["id"],
                      "evaluation": {"status": "error", "score_available": False,
                                     "accepted": False, "execution_status": current["status"]},
                      "usage": current["usage"]}
        current = self.tasks.get_private(state["id"])
        classified = classify_benchmark_outcome(current, result["evaluation"])
        return {"episode_id": result["episode_id"], "evaluation": classified["evaluation"],
                 "usage": result["usage"], "execution": deepcopy(current.get("execution")),
                "failure_class": classified["failure_class"], "error": error}

    def plan_pair(self, candidate_id, adapter, *, split="development", split_role="development",
                  seed=0, budget=None, policy=None, **options):
        """Freeze tasks, evaluator identity, budget, and gates before either arm runs."""
        candidate = self.candidate(candidate_id)
        if split_role in {"holdout", "final_holdout"} or split in {"holdout", "final_holdout"}:
            raise ContractError("Final holdout cannot be used for package evolution")
        if split_role not in {"development", "selection", "guard"}:
            raise ContractError("Paired trials require development, selection, or guard role")
        validate_adapter(adapter, require_descriptor=False)
        benchmark_id = _identifier(getattr(adapter, "id", ""), "Benchmark id")
        snapshot = validate_snapshot(adapter.snapshot())
        tasks = validate_tasks(adapter.tasks(split=split, seed=seed, **options))
        if not tasks or any(not isinstance(task, dict) or not isinstance(task.get("objective"), str)
                            for task in tasks):
            raise ContractError("Evolution benchmark must provide valid tasks")
        suite = {"benchmark_id": benchmark_id, "split": split, "split_role": split_role, "seed": seed,
                 "options": _copy(options), "snapshot": snapshot, "tasks": tasks}
        suite_digest = digest(suite)
        arm_schedule = [
            {"task_ref_digest": digest(task),
             "arms": ["parent", "candidate"] if index % 2 == 0 else ["candidate", "parent"]}
            for index, task in enumerate(tasks)]
        environment = self._environment_snapshot(tasks)
        policy = PromotionPolicy() if policy is None else policy
        if not isinstance(policy, PromotionPolicy):
            raise TypeError("policy must be a PromotionPolicy")
        record = {"id": _id("plan"), "candidate_id": candidate_id,
                  "channel": candidate["channel"], "parent_package_id": candidate["parent_package_id"],
                  "parent_package_digest": candidate["parent_package_digest"],
                  "package_id": candidate["package_id"], "package_digest": candidate["package_digest"],
                  "component_id": candidate.get("component_id"),
                  "component_target": deepcopy(candidate.get("component_target")),
                  "targeting": candidate.get("targeting", "legacy_path_v1"),
                  "suite": suite, "suite_digest": suite_digest, "split_role": split_role,
                  "arm_schedule": arm_schedule, "environment": environment,
                   "environment_digest": digest(environment),
                   "budget": _copy({} if budget is None else budget, "Trial budget"),
                   "cost_projection": cost_projection_spec(),
                   "outcome_policy": outcome_policy(),
                   "policy": asdict(policy), "policy_digest": digest(asdict(policy)),
                  "created_at": time.time()}
        result = self._insert("task_evolution_plans", record)
        self._event(candidate["channel"], "paired_trial_planned",
                    {"candidate_id": candidate_id, "plan_id": record["id"],
                     "suite_digest": suite_digest, "policy_digest": record["policy_digest"],
                     "record_digest": result["record_digest"]})
        return result

    def plan(self, plan_id):
        return self._get("task_evolution_plans", plan_id)

    def run_pair(self, plan_id, adapter, *, stop_event=None):
        """Execute a pre-registered paired plan with equal initial memory snapshots."""
        plan = self.plan(plan_id)
        suite = plan["suite"]
        validate_adapter(adapter, require_descriptor=False)
        benchmark_id = _identifier(getattr(adapter, "id", ""), "Benchmark id")
        if (benchmark_id != suite["benchmark_id"]
                or digest(validate_snapshot(adapter.snapshot())) != digest(suite["snapshot"])):
            raise ContractError("Benchmark evaluator changed from the paired trial plan")
        candidate = self.candidate(plan["candidate_id"])
        if (candidate["parent_package_id"] != plan["parent_package_id"]
                or candidate["package_id"] != plan["package_id"]
                or candidate.get("component_id") != plan.get("component_id")
                or candidate.get("component_target") != plan.get("component_target")):
            raise ContractError("Paired trial plan candidate identity mismatch")
        parent = self.store.package(candidate["parent_package_id"])
        proposed = self.store.package(candidate["package_id"])
        snapshot = suite["snapshot"]
        tasks = suite["tasks"]
        budget = plan["budget"]
        if (digest(self._environment_snapshot(tasks)) != plan.get("environment_digest")
                or len(plan.get("arm_schedule", [])) != len(tasks)
                or plan.get("outcome_policy") != outcome_policy()):
            raise ContractError("Paired trial execution environment changed from its plan")
        for task_ref, scheduled in zip(tasks, plan["arm_schedule"]):
            if (scheduled.get("task_ref_digest") != digest(task_ref)
                    or scheduled.get("arms") not in
                    (["parent", "candidate"], ["candidate", "parent"])):
                raise ContractError("Paired trial arm schedule is invalid")
        prior_id = self._claim_run("paired", plan_id)
        if prior_id is not None:
            claim = self.inspect_run_claim("paired", plan_id)
            if claim is None or claim["record_id"] != prior_id:
                raise ContractError("Completed paired claim changed during replay")
            return self.trial(prior_id)
        pairs, arm_order = [], []
        for index, task_ref in enumerate(tasks):
            scheduled = plan["arm_schedule"][index]
            if scheduled.get("task_ref_digest") != digest(task_ref):
                raise ContractError("Paired trial arm schedule task identity changed")
            order = scheduled.get("arms")
            if order not in (["parent", "candidate"], ["candidate", "parent"]):
                raise ContractError("Paired trial arm schedule is invalid")
            registration = {"plan_id": plan_id, "candidate_id": candidate["id"],
                            "split": suite["split"], "split_role": suite["split_role"],
                            "task_ref_digest": digest(task_ref), "suite_digest": plan["suite_digest"],
                            "policy_digest": plan["policy_digest"]}
            # Create both Episodes before either arm runs.  TaskService freezes
            # memory on create, so neither arm can write information that the
            # other arm later reads from its initial snapshot.
            states = {
                "parent": self._create_frozen(parent, benchmark_id, task_ref, snapshot, budget, registration),
                "candidate": self._create_frozen(proposed, benchmark_id, task_ref, snapshot, budget, registration),
            }
            memory = {name: self.store.memory_snapshot(state["memory_snapshot_id"], state["id"])
                      for name, state in states.items()}
            memory_seed = {name: [{"id": item["id"], "version": item["version"]}
                                  for item in value["items"]]
                           for name, value in memory.items()}
            if memory_seed["parent"] != memory_seed["candidate"]:
                raise ContractError("Paired arms did not receive the same frozen memory seed")
            runs = {}
            for arm in order:
                if digest(validate_snapshot(adapter.snapshot())) != digest(snapshot):
                    raise ContractError("Benchmark evaluator changed during the paired trial")
                if digest(self._environment_snapshot(tasks)) != plan["environment_digest"]:
                    raise ContractError("Paired trial execution environment changed during execution")
                runs[arm] = self._run_frozen(states[arm], adapter, task_ref, snapshot, stop_event)
                if digest(validate_snapshot(adapter.snapshot())) != digest(snapshot):
                    raise ContractError("Benchmark evaluator changed during the paired trial")
            parent_run, candidate_run = runs["parent"], runs["candidate"]
            if candidate.get("component_target") is not None:
                candidate_run["loaded_evidence"] = _loaded_evidence(
                    candidate["component_target"], candidate_run.get("execution"), proposed)
            pairs.append({"task_ref": deepcopy(task_ref), "task_ref_digest": digest(task_ref),
                          "memory_seed_digest": digest(memory_seed["parent"]),
                          "arm_order": order, "parent": parent_run, "candidate": candidate_run})
            arm_order.append({"task_ref_digest": digest(task_ref), "arms": order})
        record = {"id": _id("trial"), "plan_id": plan_id, "candidate_id": candidate["id"],
                  "channel": candidate["channel"], "parent_package_id": parent["id"],
                  "parent_package_digest": parent["digest"], "package_id": proposed["id"],
                  "package_digest": proposed["digest"],
                  "component_id": candidate.get("component_id"),
                  "component_target": deepcopy(candidate.get("component_target")),
                  "targeting": candidate.get("targeting", "legacy_path_v1"),
                  "suite": suite,
                  "suite_digest": plan["suite_digest"], "split_role": suite["split_role"],
                  "policy": deepcopy(plan["policy"]), "policy_digest": plan["policy_digest"],
                  "cost_projection": deepcopy(plan.get("cost_projection")),
                  "arm_order": arm_order, "pairs": pairs, "created_at": time.time()}
        result = self._insert("task_evolution_trials", record)
        self._finish_run("paired", plan_id, record["id"])
        return result

    def evaluate_pair(self, candidate_id, adapter, *, split="development", split_role="development",
                      seed=0, budget=None, policy=None, stop_event=None, **options):
        """Compatibility helper that still persists the plan before execution."""
        plan = self.plan_pair(candidate_id, adapter, split=split, split_role=split_role,
                              seed=seed, budget=budget, policy=policy, **options)
        return self.run_pair(plan["id"], adapter, stop_event=stop_event)

    def trial(self, trial_id):
        return self._get("task_evolution_trials", trial_id)

    def assess(self, trial_id):
        """Record an independent, deterministic promotion decision."""
        trial = self.trial(trial_id)
        policy = PromotionPolicy(**trial["policy"])
        if digest(asdict(policy)) != trial.get("policy_digest"):
            raise ContractError("Paired trial promotion policy identity mismatch")
        with self.store.connect() as db:
            existing = db.execute("SELECT data,digest FROM task_evolution_decisions").fetchall()
        for data, record_digest in existing:
            prior = json.loads(data)
            if prior.get("trial_id") == trial_id:
                if digest(prior) != record_digest:
                    raise ContractError("Evolution decision digest mismatch")
                prior["record_digest"] = record_digest
                return prior

        def score(evaluation):
            value = evaluation.get("score")
            if (evaluation.get("score_available") is True
                    and type(value) in {int, float} and math.isfinite(value)):
                return float(value)
            return None

        projection_spec = trial.get("cost_projection")
        if projection_spec is None:
            cost_weights = LEGACY_EVOLUTION_COST_WEIGHTS
        elif (not isinstance(projection_spec, dict)
              or projection_spec.get("schema") != COST_PROJECTION_SCHEMA
              or projection_spec.get("gate_basis") != "conservative_work"):
            raise ContractError("Paired trial cost projection is invalid")
        else:
            cost_weights = projection_spec.get("weights")

        deltas, failure_reasons = [], []
        for pair in trial["pairs"]:
            row = {"task_ref_digest": pair["task_ref_digest"], "arm_order": pair["arm_order"]}
            row_reasons = []
            for side in ("parent", "candidate"):
                run, evaluation = pair[side], pair[side]["evaluation"]
                value = score(evaluation)
                reasons = []
                if run.get("error") is not None:
                    reasons.append("execution_error")
                if evaluation.get("score_available") is not True:
                    reasons.append("score_unavailable")
                elif value is None:
                    reasons.append("score_invalid")
                if type(evaluation.get("accepted")) is not bool:
                    reasons.append("acceptance_missing")
                if run.get("usage", {}).get("usage_complete") is not True:
                    reasons.append("usage_incomplete")
                cost_projection = self._cost_projection(run.get("usage", {}), cost_weights)
                if cost_projection is None:
                    reasons.append("usage_invalid")
                row[side] = {"episode_id": run["episode_id"], "score": value,
                             "accepted": evaluation.get("accepted"),
                             "failure_class": run.get("failure_class"),
                             "cost": (cost_projection["conservative_work"]
                                      if cost_projection is not None else 0.0),
                             "cost_projection": cost_projection,
                             "usage_complete": run.get("usage", {}).get("usage_complete") is True,
                             "failure_reasons": reasons}
                row_reasons.extend(f"{side}:{reason}" for reason in reasons)
            parent_score, candidate_score = row["parent"]["score"], row["candidate"]["score"]
            row["score_delta"] = (candidate_score - parent_score
                                  if parent_score is not None and candidate_score is not None else None)
            row["failure_reasons"] = row_reasons
            failure_reasons.extend(f"{pair['task_ref_digest']}:{reason}" for reason in row_reasons)
            deltas.append(row)

        def measurements(side):
            rows = [row[side] for row in deltas]
            scores = [row["score"] for row in rows]
            complete_scores = all(value is not None for value in scores)
            complete_acceptance = all(type(row["accepted"]) is bool for row in rows)
            reported_work = [
                (row.get("cost_projection") or {}).get("reported_token_work")
                for row in rows]
            return {"quality": sum(scores) / len(scores) if complete_scores else None,
                    "success_rate": (sum(row["accepted"] is True for row in rows) / len(rows)
                                     if complete_acceptance else None),
                    "cost": sum(row["cost"] for row in rows),
                    "reported_token_work": (sum(reported_work)
                                             if all(value is not None
                                                    for value in reported_work) else None),
                    "all_accepted": all(row["accepted"] is True for row in rows),
                    "score_complete": complete_scores,
                    "acceptance_complete": complete_acceptance,
                    "usage_complete": all(row["usage_complete"] for row in rows)}

        parent, proposed = measurements("parent"), measurements("candidate")
        candidate = self.candidate(trial["candidate_id"])
        candidate_package = self.store.package(candidate["package_id"])
        probe = candidate.get("activation_probe") or {}
        activation_rows = []
        if probe.get("kind") == "package_loaded":
            behavior_activated = all(row["candidate"].get("error") is None
                                     for row in trial["pairs"])
            activation_rows = [{"episode_id": row["candidate"]["episode_id"],
                                "package_loaded": row["candidate"].get("error") is None}
                               for row in trial["pairs"]]
        elif (probe.get("kind") == "component_set_loaded"
              and candidate.get("targeting") == "manifest_component_set_v3"):
            component = candidate.get("component_target")
            if (not isinstance(component, dict)
                    or component.get("kind") != "component_set"
                    or component.get("component_ids") != probe.get("component_ids")):
                behavior_activated = False
            else:
                for row in trial["pairs"]:
                    actual = _loaded_evidence(
                        component, row["candidate"].get("execution"), candidate_package)
                    if row["candidate"].get("loaded_evidence") != actual:
                        raise ContractError("Paired trial component-set evidence changed")
                    activation_rows.append({"episode_id": row["candidate"]["episode_id"],
                                            **actual})
                behavior_activated = bool(activation_rows) and all(
                    row["loaded"] for row in activation_rows)
        elif (probe.get("kind") == "component_loaded"
              and candidate.get("targeting") == "manifest_component_v2"):
            component = candidate.get("component_target")
            if (not isinstance(component, dict)
                    or component.get("component_id") != probe.get("component_id")):
                behavior_activated = False
            else:
                for row in trial["pairs"]:
                    actual = _loaded_evidence(
                        component, row["candidate"].get("execution"), candidate_package)
                    if row["candidate"].get("loaded_evidence") != actual:
                        raise ContractError("Paired trial component loaded evidence changed")
                    activation_rows.append({"episode_id": row["candidate"]["episode_id"],
                                            **actual})
                behavior_activated = bool(activation_rows) and all(
                    row["loaded"] for row in activation_rows)
        elif probe.get("kind") == "component_loaded":
            behavior_activated = all(
                probe.get("path") in ((row["candidate"].get("execution") or {}).get("loaded_modules") or [])
                for row in trial["pairs"])
            activation_rows = [
                {"episode_id": row["candidate"]["episode_id"], "legacy": True,
                 "path": probe.get("path"),
                 "loaded_files": ([probe.get("path")] if probe.get("path") in
                                  ((row["candidate"].get("execution") or {}).get(
                                      "loaded_modules") or []) else []),
                 "loaded": probe.get("path") in
                           ((row["candidate"].get("execution") or {}).get(
                               "loaded_modules") or [])}
                for row in trial["pairs"]]
        else:
            behavior_activated = False
        regressions = sum(
            row["parent"]["accepted"] is True
            and (row["candidate"]["accepted"] is not True
                 or row["score_delta"] is None or row["score_delta"] < 0)
            for row in deltas)
        cost_ok = (proposed["cost"] <= policy.max_absolute_cost_when_parent_zero
                   if parent["cost"] == 0 else proposed["cost"] <= parent["cost"] * policy.max_cost_ratio)
        quality_ok = (parent["quality"] is not None and proposed["quality"] is not None
                      and proposed["quality"] >= parent["quality"] + policy.min_quality_delta)
        gates = {"selection_role": trial.get("split_role") == "selection",
                 "measurement_complete": not failure_reasons,
                 "quality": quality_ok,
                 "success_rate": (proposed["success_rate"] is not None
                                  and proposed["success_rate"] >= policy.min_success_rate),
                 "cost": cost_ok, "regressions": regressions <= policy.max_regressions,
                 "candidate_completed": proposed["all_accepted"],
                 "behavior_activated": behavior_activated}
        record = {"id": _id("decision"), "trial_id": trial_id,
                  "candidate_id": trial["candidate_id"], "channel": trial["channel"],
                  "component_id": candidate.get("component_id"),
                  "component_target": deepcopy(candidate.get("component_target")),
                  "loaded_evidence": activation_rows,
                  "policy": asdict(policy), "measurements": {"parent": parent, "candidate": proposed,
                                                               "regressions": regressions,
                                                               "paired_task_deltas": deltas,
                                                               "failure_reasons": failure_reasons},
                  "gates": gates, "eligible": all(gates.values()), "created_at": time.time()}
        result = self._insert("task_evolution_decisions", record)
        self._event(trial["channel"], "promotion_assessed",
                    {"decision_id": record["id"], "trial_id": trial_id,
                     "eligible": record["eligible"],
                     "component_id": candidate.get("component_id"),
                     "loaded_evidence_digest": digest(activation_rows),
                     "record_digest": result["record_digest"]})
        return result

    def decision(self, decision_id):
        return self._get("task_evolution_decisions", decision_id)

    def plan_monitor(self, candidate_id, adapter, *, split="guard", seed=0, budget=None, **options):
        """Pre-register public guard tasks and evaluator identity for a deployment."""
        candidate = self.candidate(candidate_id)
        if split in {"development", "selection", "final_holdout", "holdout"}:
            raise ContractError("Deployment monitoring requires an independent guard split")
        validate_adapter(adapter, require_descriptor=False)
        benchmark_id = _identifier(getattr(adapter, "id", ""), "Benchmark id")
        snapshot = validate_snapshot(adapter.snapshot())
        tasks = validate_tasks(adapter.tasks(split=split, seed=seed, **options))
        if not tasks or any(not isinstance(task, dict) or not isinstance(task.get("objective"), str)
                            for task in tasks):
            raise ContractError("Monitoring plan must provide valid tasks")
        suite = {"benchmark_id": benchmark_id, "split": split, "split_role": "monitoring",
                 "seed": seed, "options": _copy(options), "snapshot": snapshot, "tasks": tasks}
        environment = self._environment_snapshot(tasks)
        record = {"id": _id("monitor-plan"), "candidate_id": candidate_id,
                  "channel": candidate["channel"], "package_id": candidate["package_id"],
                   "package_digest": candidate["package_digest"],
                   "component_id": candidate.get("component_id"),
                   "component_target": deepcopy(candidate.get("component_target")),
                   "targeting": candidate.get("targeting", "legacy_path_v1"),
                   "suite": suite,
                   "suite_digest": digest(suite),
                   "task_schedule": [digest(task) for task in tasks],
                   "environment": environment, "environment_digest": digest(environment),
                   "outcome_policy": outcome_policy(),
                   "budget": _copy({} if budget is None else budget, "Monitoring budget"),
                  "created_at": time.time()}
        result = self._insert("task_evolution_monitor_plans", record)
        self._event(candidate["channel"], "monitoring_planned",
                    {"candidate_id": candidate_id, "monitor_plan_id": record["id"],
                     "suite_digest": record["suite_digest"], "record_digest": result["record_digest"]})
        return result

    def monitor_plan(self, monitor_plan_id):
        return self._get("task_evolution_monitor_plans", monitor_plan_id)

    def monitor_run(self, monitor_plan_id):
        """Return the unique completed execution of a monitoring plan."""
        self.monitor_plan(monitor_plan_id)
        with self.store.connect() as db:
            row = db.execute(
                "SELECT status,record_id FROM task_evolution_run_claims "
                "WHERE kind='monitor' AND plan_id=?", (monitor_plan_id,)).fetchone()
        if not row or row[0] != "completed" or not row[1]:
            raise ContractError("Monitoring plan has no complete single-consumption run")
        record = self._get("task_evolution_monitor_runs", row[1])
        if record.get("monitor_plan_id") != monitor_plan_id:
            raise ContractError("Monitoring run plan identity mismatch")
        return record

    def promote(self, candidate_id, decision_id, *, monitor_plan_id=None):
        """Explicitly deploy an eligible candidate if its tested parent is still active."""
        candidate, decision = self.candidate(candidate_id), self.decision(decision_id)
        if decision["candidate_id"] != candidate_id or not decision["eligible"]:
            raise ContractError("Candidate has no eligible paired promotion decision")
        if (decision.get("component_id") != candidate.get("component_id")
                or decision.get("component_target") != candidate.get("component_target")
                or (candidate.get("targeting") in {
                        "manifest_component_v2", "manifest_component_set_v3"}
                    and (not decision.get("loaded_evidence")
                         or not all(row.get("loaded") is True
                                    for row in decision["loaded_evidence"])))):
            raise ContractError("Promotion lacks the candidate component loaded evidence")
        if not isinstance(monitor_plan_id, str) or not monitor_plan_id:
            raise ContractError("Promotion requires a pre-registered monitoring plan")
        generation = self._verify_generated_candidate(candidate)
        active = self.active(candidate["channel"])
        if (active["package_id"] != candidate["parent_package_id"]
                or active["revision"] != generation.get("channel_revision")):
            raise ContractError("Candidate parent is no longer active")
        package = self.store.package(candidate["package_id"])
        if self.store.is_task_scoped_package(package):
            raise ContractError(
                "Task-authored packages require an explicit adoption before promotion")
        verify_package(package, active["package"])
        monitor_plan = self.monitor_plan(monitor_plan_id)
        if (monitor_plan["candidate_id"] != candidate_id
                or monitor_plan["package_id"] != package["id"]
                or monitor_plan["package_digest"] != package["digest"]
                or monitor_plan.get("component_id") != candidate.get("component_id")
                or monitor_plan.get("component_target") != candidate.get("component_target")):
            raise ContractError("Monitoring plan does not belong to the promoted candidate")
        promotion = {"candidate_id": candidate_id, "decision_id": decision_id,
                     "trial_id": decision["trial_id"], "policy": deepcopy(decision["policy"]),
                     "component_id": candidate.get("component_id"),
                     "component_target": deepcopy(candidate.get("component_target")),
                     "selection_loaded_evidence": deepcopy(decision.get("loaded_evidence")),
                     "selection_loaded_evidence_digest": digest(
                         decision.get("loaded_evidence") or []),
                     "monitor_plan_id": monitor_plan_id,
                     "monitor_plan_digest": monitor_plan["record_digest"],
                     "monitoring_thresholds": {
                         "min_score": decision["policy"]["monitor_min_score"],
                         "min_success_rate": decision["policy"]["monitor_min_success_rate"]},
                     "decision_record_digest": decision["record_digest"]}
        state = {"channel": candidate["channel"], "package_id": package["id"],
                 "package_digest": package["digest"], "revision": active["revision"] + 1,
                 "promotion": promotion, "updated_at": time.time()}
        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            changed = db.execute(
                "UPDATE task_package_channels SET package_id=?,revision=?,data=? "
                "WHERE name=? AND package_id=? AND revision=?",
                (package["id"], state["revision"], self._encode(state), candidate["channel"],
                 active["package_id"], active["revision"])).rowcount
            if changed != 1:
                raise ContractError("Active package changed during promotion")
            self._append_event(db, candidate["channel"], "package_promoted",
                               {"from_package_id": active["package_id"],
                                "to_package_id": package["id"], "candidate_id": candidate_id,
                                "decision_id": decision_id, "trial_id": decision["trial_id"],
                                "monitor_plan_id": monitor_plan_id,
                                "monitor_plan_digest": promotion["monitor_plan_digest"],
                                "component_id": promotion["component_id"],
                                "component_target": promotion["component_target"],
                                "selection_loaded_evidence": promotion[
                                    "selection_loaded_evidence"],
                                "selection_loaded_evidence_digest": promotion[
                                    "selection_loaded_evidence_digest"],
                                "policy": deepcopy(decision["policy"]),
                                "monitoring_thresholds": promotion["monitoring_thresholds"],
                                "decision_record_digest": decision["record_digest"]})
        return self.active(candidate["channel"])

    def run_monitor(self, channel, adapter, *, stop_event=None,
                    expected_revision=None, expected_package_id=None,
                    expected_monitor_plan_id=None):
        """Execute only the guard tasks frozen into the active promotion."""
        active = self.active(channel)
        self._expected_deployment(
            active, expected_revision=expected_revision,
            expected_package_id=expected_package_id,
            expected_monitor_plan_id=expected_monitor_plan_id)
        promotion = active.get("promotion") or {}
        plan_id = promotion.get("monitor_plan_id")
        if not isinstance(plan_id, str):
            raise ContractError("Active deployment has no pre-registered monitoring plan")
        plan = self.monitor_plan(plan_id)
        candidate = self.candidate(plan["candidate_id"])
        suite = plan["suite"]
        if (plan["record_digest"] != promotion.get("monitor_plan_digest")
                or plan["package_id"] != active["package_id"]
                or plan["package_digest"] != active["package_digest"]
                or plan.get("outcome_policy") != outcome_policy()
                or plan.get("component_id") != promotion.get("component_id")
                or plan.get("component_target") != promotion.get("component_target")
                or candidate.get("component_id") != plan.get("component_id")
                or candidate.get("component_target") != plan.get("component_target")
                or getattr(adapter, "id", None) != suite["benchmark_id"]
                or digest(validate_snapshot(adapter.snapshot())) != digest(suite["snapshot"])):
            raise ContractError("Active monitoring plan identity changed")
        tasks = suite["tasks"]
        if (plan.get("task_schedule") != [digest(task) for task in tasks]
                or digest(self._environment_snapshot(tasks)) != plan.get("environment_digest")):
            raise ContractError("Monitoring execution environment changed from its plan")
        prior_id = self._claim_run("monitor", plan_id)
        if prior_id is not None:
            claim = self.inspect_run_claim("monitor", plan_id)
            if claim is None or claim["record_id"] != prior_id:
                raise ContractError("Completed monitor claim changed during replay")
            return self._get("task_evolution_monitor_runs", prior_id)
        reports = []
        for task_ref in tasks:
            current = self.active(channel)
            self._expected_deployment(
                current, expected_revision=expected_revision,
                expected_package_id=expected_package_id,
                expected_monitor_plan_id=expected_monitor_plan_id)
            if (current["revision"] != active["revision"]
                    or current["package_id"] != active["package_id"]
                    or current["package_digest"] != active["package_digest"]):
                raise ContractError("Active deployment changed during monitoring")
            if (digest(validate_snapshot(adapter.snapshot())) != digest(suite["snapshot"])
                    or digest(self._environment_snapshot(tasks)) != plan["environment_digest"]):
                raise ContractError("Monitoring environment changed during execution")
            context = deepcopy(task_ref.get("context") or {})
            if "monitoring_registration" in context:
                raise ContractError("Monitoring registration context is host-owned")
            context["split"] = suite["split"]
            context["memory_writeback"] = False
            context["monitoring_registration"] = {
                "monitor_plan_id": plan_id, "suite_digest": plan["suite_digest"],
                "task_ref_digest": digest(task_ref), "split_role": "monitoring"}
            benchmark_registration = {
                "benchmark_id": suite["benchmark_id"], "task_ref": deepcopy(task_ref),
                "snapshot": deepcopy(suite["snapshot"]),
                "host_runtime": host_runtime_fingerprint()}
            state = self.tasks.create(
                task_ref["objective"], task_ref.get("inputs"), task_ref.get("deliverables"),
                plan["budget"], task_ref.get("capabilities"), context=context,
                constraints=task_ref.get("constraints"), package_channel=channel,
                benchmark_registration=benchmark_registration,
                expected_package_registration={
                    "channel": channel, "revision": active["revision"],
                    "package_id": active["package_id"],
                    "package_digest": active["package_digest"]})
            self.tasks.run(state["id"], stop_event=stop_event)
            report = self.tasks.evaluate(
                state["id"], adapter, deepcopy(task_ref), snapshot=deepcopy(suite["snapshot"]))
            if candidate.get("component_target") is not None:
                episode = self.tasks.get_private(state["id"])
                report["loaded_evidence"] = _loaded_evidence(
                    candidate["component_target"], episode.get("execution"), active["package"])
            reports.append(report)
            if (digest(validate_snapshot(adapter.snapshot())) != digest(suite["snapshot"])
                    or digest(self._environment_snapshot(tasks)) != plan["environment_digest"]):
                raise ContractError("Monitoring evaluator or environment changed during execution")
        current = self.active(channel)
        self._expected_deployment(
            current, expected_revision=expected_revision,
            expected_package_id=expected_package_id,
            expected_monitor_plan_id=expected_monitor_plan_id)
        if (current["revision"] != active["revision"]
                or current["package_id"] != active["package_id"]
                or current["package_digest"] != active["package_digest"]):
            raise ContractError("Active deployment changed during monitoring")
        record = {"id": _id("monitor-run"), "monitor_plan_id": plan_id,
                  "channel": channel, "package_id": active["package_id"],
                  "package_digest": active["package_digest"],
                  "component_id": candidate.get("component_id"),
                  "component_target": deepcopy(candidate.get("component_target")),
                  "suite_digest": plan["suite_digest"], "reports": reports,
                  "episode_ids": [row["episode_id"] for row in reports],
                  "created_at": time.time()}
        result = self._insert("task_evolution_monitor_runs", record)
        self._finish_run("monitor", plan_id, record["id"])
        return result

    def rollback(self, channel, *, reason, evidence=None, expected_revision=None,
                 expected_package_id=None, expected_monitor_plan_id=None):
        """Roll back one deployment edge to the prior promoted package."""
        if not isinstance(reason, str) or not reason.strip():
            raise ContractError("Rollback requires a nonempty reason")
        active = self.active(channel)
        self._expected_deployment(
            active, expected_revision=expected_revision,
            expected_package_id=expected_package_id,
            expected_monitor_plan_id=expected_monitor_plan_id)
        promotions = [event for event in self.events(channel)
                      if event["kind"] == "package_promoted"
                      and event["content"]["to_package_id"] == active["package_id"]]
        if not promotions:
            raise ContractError("Active package has no prior promoted version")
        target_id = promotions[-1]["content"]["from_package_id"]
        target = self.store.package(target_id)
        prior_promotions = [event for event in self.events(channel)
                            if event["kind"] == "package_promoted"
                            and event["content"]["to_package_id"] == target_id]
        restored_promotion = deepcopy(prior_promotions[-1]["content"]) if prior_promotions else None
        state = {"channel": channel, "package_id": target["id"],
                 "package_digest": target["digest"], "revision": active["revision"] + 1,
                 "promotion": restored_promotion, "updated_at": time.time()}
        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            changed = db.execute(
                "UPDATE task_package_channels SET package_id=?,revision=?,data=? "
                "WHERE name=? AND package_id=? AND revision=?",
                (target["id"], state["revision"], self._encode(state), channel,
                 active["package_id"], active["revision"])).rowcount
            if changed != 1:
                raise ContractError("Active package changed during rollback")
            self._append_event(db, channel, "package_rolled_back",
                               {"from_package_id": active["package_id"],
                                "to_package_id": target["id"], "reason": reason,
                                "evidence": _copy({} if evidence is None else evidence)})
        return self.active(channel)

    def monitor(self, channel, episode_ids, *, rollback_on_regression=True,
                expected_revision=None, expected_package_id=None,
                expected_monitor_plan_id=None):
        """Monitor the active deployment using evaluator-bound local Episodes only."""
        if (not isinstance(episode_ids, list) or not episode_ids
                or any(not isinstance(identity, str) for identity in episode_ids)
                or len(set(episode_ids)) != len(episode_ids)):
            raise ContractError("Monitoring requires unique local episode identities")
        active = self.active(channel)
        self._expected_deployment(
            active, expected_revision=expected_revision,
            expected_package_id=expected_package_id,
            expected_monitor_plan_id=expected_monitor_plan_id)
        promotion = active.get("promotion")
        if not isinstance(promotion, dict) or not isinstance(promotion.get("monitoring_thresholds"), dict):
            raise ContractError("Active deployment has no frozen monitoring policy")
        plan_id = promotion.get("monitor_plan_id")
        if not isinstance(plan_id, str):
            raise ContractError("Active deployment has no pre-registered monitoring plan")
        plan = self.monitor_plan(plan_id)
        if (plan["record_digest"] != promotion.get("monitor_plan_digest")
                or plan["package_id"] != active["package_id"]
                or plan["package_digest"] != active["package_digest"]
                or plan.get("outcome_policy") != outcome_policy()):
            raise ContractError("Active monitoring plan identity changed")
        monitor_run = self.monitor_run(plan_id)
        run_episodes = Counter(monitor_run.get("episode_ids", []))
        supplied_episodes = Counter(episode_ids)
        run_reports = {row.get("episode_id"): row for row in monitor_run.get("reports", [])
                       if isinstance(row, dict) and isinstance(row.get("episode_id"), str)}
        if (monitor_run.get("monitor_plan_id") != plan_id
                or monitor_run.get("suite_digest") != plan["suite_digest"]
                or monitor_run.get("channel") != channel
                or len(run_reports) != len(monitor_run.get("reports", []))
                or Counter(run_reports.keys()) != run_episodes):
            raise ContractError("Monitoring run does not match the active guard plan")
        if supplied_episodes - run_episodes:
            raise ContractError("Monitoring Episodes are outside the complete guard run")
        missing_run_episode_ids = sorted((run_episodes - supplied_episodes).elements())
        promotion_events = [event["content"] for event in self.events(channel)
                            if event["kind"] == "package_promoted"
                            and event["content"].get("to_package_id") == active["package_id"]
                            and event["content"].get("decision_id") == promotion.get("decision_id")]
        if (not promotion_events
                or promotion_events[-1].get("policy") != promotion.get("policy")
                or promotion_events[-1].get("monitoring_thresholds")
                != promotion.get("monitoring_thresholds")
                or promotion_events[-1].get("component_id")
                != promotion.get("component_id")
                or promotion_events[-1].get("selection_loaded_evidence_digest")
                != promotion.get("selection_loaded_evidence_digest")):
            raise ContractError("Active monitoring policy does not match its promotion event")
        thresholds = deepcopy(promotion["monitoring_thresholds"])
        expected_tasks = Counter(digest(task) for task in plan["suite"]["tasks"])
        observed_tasks = Counter()
        observations, scores, successes, missing = [], [], [], []
        for identity in episode_ids:
            try:
                episode = self.tasks.get_private(identity)
            except KeyError:
                raise ContractError(f"Monitoring episode is not local: {identity}") from None
            registration = episode["task"].get("context", {}).get("package_channel_registration")
            monitor_registration = episode["task"].get("context", {}).get("monitoring_registration")
            if (not isinstance(registration, dict) or registration.get("channel") != channel
                    or registration.get("revision") != active["revision"]
                    or registration.get("package_id") != active["package_id"]
                    or registration.get("package_digest") != active["package_digest"]
                    or episode["package_id"] != active["package_id"]
                    or episode["package_digest"] != active["package_digest"]):
                raise ContractError("Monitoring episode was not created by the active channel deployment")
            task_digest = (monitor_registration.get("task_ref_digest")
                           if isinstance(monitor_registration, dict) else None)
            if (not isinstance(monitor_registration, dict)
                    or monitor_registration.get("monitor_plan_id") != plan_id
                    or monitor_registration.get("suite_digest") != plan["suite_digest"]
                    or monitor_registration.get("split_role") != "monitoring"
                    or task_digest not in expected_tasks):
                raise ContractError("Monitoring episode is outside the pre-registered guard plan")
            observed_tasks[task_digest] += 1
            if observed_tasks[task_digest] > expected_tasks[task_digest]:
                raise ContractError("Monitoring guard task appears more often than planned")
            evaluation = episode.get("evaluation")
            if not isinstance(evaluation, dict):
                raise ContractError("Monitoring episode has no evaluator report")
            frozen_report = run_reports.get(identity)
            if (not isinstance(frozen_report, dict)
                    or frozen_report.get("evaluation") != evaluation):
                raise ContractError("Monitoring result changed after its immutable guard run")
            loaded_evidence = None
            if promotion.get("component_target") is not None:
                loaded_evidence = _loaded_evidence(
                    promotion["component_target"], episode.get("execution"), active["package"])
                if frozen_report.get("loaded_evidence") != loaded_evidence:
                    raise ContractError("Monitoring component loaded evidence changed")
            evaluation_events = [event for event in self.store.events(identity)
                                 if event["kind"] == "benchmark_evaluated"]
            if (not evaluation_events
                    or evaluation_events[-1]["content"].get("report") != evaluation
                    or digest(evaluation_events[-1]["content"].get("snapshot"))
                    != digest(plan["suite"]["snapshot"])):
                raise ContractError("Monitoring evaluator report is not bound to an audit event")
            accepted = evaluation.get("accepted")
            value = evaluation.get("score")
            complete = (type(accepted) is bool and evaluation.get("score_available") is True
                        and type(value) in {int, float} and math.isfinite(value)
                        and episode.get("status") in {"completed", "failed"}
                        and episode.get("usage", {}).get("usage_complete") is True
                        and (loaded_evidence is None
                             or loaded_evidence.get("loaded") is True))
            if complete:
                scores.append(float(value))
                successes.append(accepted is True)
            else:
                missing.append(identity)
            observations.append({"episode_id": identity, "evaluation_digest": digest(evaluation),
                                 "task_ref_digest": task_digest,
                                 "component_id": promotion.get("component_id"),
                                 "loaded_evidence": loaded_evidence,
                                 "accepted": accepted if type(accepted) is bool else None,
                                 "score": float(value) if complete else None,
                                 "usage_complete": episode.get("usage", {}).get("usage_complete") is True,
                                 "complete": complete})
        missing_task_digests = sorted((expected_tasks - observed_tasks).elements())
        missing.extend(missing_run_episode_ids)
        measurement_complete = (not missing and not missing_task_digests
                                and observed_tasks == expected_tasks
                                and len(scores) == len(observations))
        metrics = {"score": sum(scores) / len(scores) if measurement_complete else None,
                   "success_rate": (sum(successes) / len(successes)
                                    if measurement_complete else None), "count": len(observations),
                   "measurement_complete": measurement_complete,
                   "missing_episode_ids": missing,
                   "missing_task_digests": missing_task_digests,
                   "planned_count": sum(expected_tasks.values())}
        degraded = (not metrics["measurement_complete"]
                    or (metrics["score"] is not None
                        and metrics["score"] < thresholds["min_score"])
                    or (metrics["success_rate"] is not None
                        and metrics["success_rate"] < thresholds["min_success_rate"]))
        current = self.active(channel)
        self._expected_deployment(
            current, expected_revision=expected_revision,
            expected_package_id=expected_package_id,
            expected_monitor_plan_id=expected_monitor_plan_id)
        if (current["revision"] != active["revision"]
                or current["package_id"] != active["package_id"]
                or current["package_digest"] != active["package_digest"]):
            raise ContractError("Active deployment changed during monitoring assessment")
        self._event(channel, "deployment_monitored", {"metrics": metrics, "degraded": degraded,
                                                       "observations": observations,
                                                       "thresholds": thresholds})
        if degraded and rollback_on_regression:
            state = self.rollback(channel, reason="monitoring_regression",
                                  evidence={"metrics": metrics, "thresholds": thresholds,
                                            "episode_ids": list(episode_ids)},
                                  expected_revision=active["revision"],
                                  expected_package_id=active["package_id"],
                                  expected_monitor_plan_id=plan_id)
            return {"degraded": True, "rolled_back": True, "active": state, "metrics": metrics}
        return {"degraded": degraded, "rolled_back": False,
                "active": current, "metrics": metrics}


def active_package(store, channel):
    """Resolve an active package without constructing an EvolutionService."""
    return active_package_registration(store, channel)["package"]


def active_package_registration(store, channel):
    """Resolve and verify an active package plus its registry identity."""
    channel = _identifier(channel, "Package channel")
    with store.connect() as db:
        try:
            row = db.execute("SELECT package_id,revision,data FROM task_package_channels WHERE name=?",
                             (channel,)).fetchone()
        except Exception as exc:
            raise ContractError("Package channel registry is not initialized") from exc
    if not row:
        raise ContractError(f"Unknown package channel: {channel}")
    state = json.loads(row[2])
    package = store.package(row[0])
    if (state.get("package_id") != row[0] or state.get("revision") != row[1]
            or state.get("package_digest") != package["digest"]):
        raise ContractError("Active package registry digest mismatch")
    state["package"] = package
    return state
