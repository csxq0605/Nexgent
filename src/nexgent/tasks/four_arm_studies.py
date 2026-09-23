"""Trusted four-arm final-holdout execution for confirmatory RSI studies.

This module is intentionally separate from :mod:`nexgent.tasks.studies`.
The historical two-arm protocol remains immutable while this service reserves
one statistical unit for an entire F/S/M/E quartet and executes every cell
through the ordinary :class:`TaskService` path.
"""

from __future__ import annotations

from copy import deepcopy
import json
import time
import uuid

from ..kernel.programs import digest
from .benchmarks import descriptor_of, host_runtime_fingerprint, validate_tasks
from .memory import MemoryService
from .outcomes import outcome_policy
from .packages import verify_package
from .studies import (
    TaskStudyExecutor,
    _adapter_fingerprint,
    _copy,
    _descriptor_digest,
    _execution_environment,
)
from .tools import ContractError


FOUR_ARM_PLAN_SCHEMA = "nexgent.four-arm-study-plan.v1"
FOUR_ARM_RUN_SCHEMA = "nexgent.four-arm-study-run.v1"
FOUR_ARM_CLAIM_LEASE_SECONDS = 3600
ARM_IDS = ("F", "S", "M", "E")
_TERMINAL = {"measured", "missing"}
_RELEASE_KEYS = (
    "channel", "revision", "memory_id", "memory_digest",
    "package_id", "package_digest",
)
_CELL_BINDING_KEYS = (
    "id", "plan_id", "row_index", "arm", "seed", "task_index",
    "task_digest", "statistical_unit_id", "cluster_id", "package_id",
    "package_digest", "memory_release_digest",
)


def _id(prefix):
    return prefix + "-" + uuid.uuid4().hex[:16]


def _encode(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"), allow_nan=False)


def _release_projection(release):
    if release is None:
        return None
    if not isinstance(release, dict) or any(key not in release for key in _RELEASE_KEYS):
        raise ContractError("Four-arm memory release identity is incomplete")
    return {key: deepcopy(release[key]) for key in _RELEASE_KEYS}


class FourArmStudyService:
    """Register and execute immutable F/S/M/E final-holdout quartets.

    F is the fixed multi-role package with empty memory, S is the single-role
    control with empty memory, M is exactly F plus an accepted frozen memory
    release, and E is the evolved package with optional package-compatible
    accepted memory.  The service records execution evidence; inferential
    statistics deliberately remain a later protocol layer.
    """

    def __init__(self, task_service, adapter):
        self.tasks = task_service
        self.store = task_service.store
        self._executor = TaskStudyExecutor(task_service, adapter)
        self._adapter = self._executor.adapter
        with self.store.connect() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS task_four_arm_study_plans(
                    id TEXT PRIMARY KEY, data TEXT NOT NULL, digest TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS task_four_arm_study_cells(
                    id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, status TEXT NOT NULL,
                    data TEXT NOT NULL, updated REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS task_four_arm_study_runs(
                    id TEXT PRIMARY KEY, data TEXT NOT NULL, digest TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS task_four_arm_study_claims(
                    plan_id TEXT PRIMARY KEY, status TEXT NOT NULL, run_id TEXT,
                    created REAL NOT NULL, updated REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS task_rsi_holdout_claims(
                    unit_digest TEXT PRIMARY KEY, plan_id TEXT NOT NULL,
                    created REAL NOT NULL);
            """)

    def _get(self, table, identity):
        with self.store.connect() as db:
            row = db.execute(
                f"SELECT data,digest FROM {table} WHERE id=?", (identity,)).fetchone()
        if row is None:
            raise KeyError(identity)
        value = json.loads(row[0])
        if digest(value) != row[1]:
            raise ContractError("Four-arm study evidence digest mismatch")
        value["record_digest"] = row[1]
        return value

    def plan(self, identity):
        return self._get("task_four_arm_study_plans", identity)

    def run_record(self, identity):
        return self._get("task_four_arm_study_runs", identity)

    def _validate_executor(self, plan=None):
        if (self._executor.__class__ is not TaskStudyExecutor
                or self._executor.tasks is not self.tasks
                or self._executor.adapter is not self._adapter):
            raise ContractError("Four-arm study executor authority changed")
        if plan is not None and (
                self._adapter.id != plan["benchmark_id"]
                or _adapter_fingerprint(self._adapter) != plan["adapter_fingerprint"]
                or digest(_execution_environment(self.tasks, self._adapter))
                   != plan["execution_environment_digest"]
                or self._executor.snapshot != plan["benchmark_snapshot"]):
            raise ContractError("Four-arm evaluator authority changed after registration")
        return self._executor

    @staticmethod
    def _budget(value):
        # Keep the resource contract aligned with the existing confirmatory
        # executor without coupling this service to its plan/run tables.
        from .studies import RSIStudyService
        return RSIStudyService._budget(value)

    def _freeze_release(self, channel, package_ref):
        release = MemoryService(self.tasks).active(channel)
        frozen = _release_projection(release)
        if (frozen["package_id"] != package_ref["package_id"]
                or frozen["package_digest"] != package_ref["package_digest"]):
            raise ContractError("Four-arm memory release belongs to another package")
        return frozen

    def create_plan(self, *, fixed_package, single_package, evolved_package,
                    memory_channel, split, seeds, episode_budget, provider, model,
                    require_model_calls=True, evolved_memory_channel=None,
                    observed_model=None, provider_revision=None, role=None):
        if split != "final_holdout":
            raise ContractError("Four-arm confirmatory studies require final_holdout tasks")
        if (not isinstance(seeds, list) or not seeds or len(seeds) > 1000
                or len(set(seeds)) != len(seeds)
                or any(type(seed) is not int for seed in seeds)):
            raise ContractError("Four-arm seeds must be a bounded unique integer list")
        if not isinstance(provider, str) or not provider or not isinstance(model, str) or not model:
            raise ContractError("Four-arm provider and model must be explicit")
        if type(require_model_calls) is not bool:
            raise ContractError("Four-arm require_model_calls must be boolean")
        if (provider == "none") != (model == "none"):
            raise ContractError("No-model studies require provider=none and model=none")
        if provider == "none" and require_model_calls:
            raise ContractError("No-model studies cannot require model calls")
        if (observed_model is None) != (provider_revision is None):
            raise ContractError("Provider model and revision must be frozen together")
        if provider == "none" and observed_model is not None:
            raise ContractError("No-model studies cannot bind a provider revision")
        episode_budget = self._budget(episode_budget)

        executor = self._validate_executor()
        descriptor = descriptor_of(self._adapter, require_explicit=False)
        if "confirmatory" not in descriptor.modes:
            raise ContractError("Four-arm studies require confirmatory benchmark mode")
        if role is None:
            if descriptor.allowed_suite_roles != ("qualification",):
                raise ContractError("Four-arm suite role must be explicit")
            role = "qualification"
        if role not in descriptor.allowed_suite_roles or role == "demo_only":
            raise ContractError("Requested four-arm suite role is not allowed")

        package_values = {
            "F": _copy(fixed_package, "F package"),
            "S": _copy(single_package, "S package"),
            "M": _copy(fixed_package, "M package"),
            "E": _copy(evolved_package, "E package"),
        }
        arms = {}
        for arm, package in package_values.items():
            verify_package(package)
            self.store.put_package(package)
            arms[arm] = {"package_id": package["id"],
                         "package_digest": package["digest"],
                         "memory_release": None}
        if arms["F"]["package_digest"] != arms["M"]["package_digest"]:
            raise ContractError("M must use the exact F package")
        if len({arms[name]["package_digest"] for name in ("F", "S", "E")}) != 3:
            raise ContractError("F, S and E must be distinct immutable packages")
        arms["M"]["memory_release"] = self._freeze_release(memory_channel, arms["M"])
        if evolved_memory_channel is not None:
            arms["E"]["memory_release"] = self._freeze_release(
                evolved_memory_channel, arms["E"])
        for arm in ARM_IDS:
            release = arms[arm]["memory_release"]
            arms[arm]["memory_release_digest"] = (
                digest(release) if release is not None else None)

        rows = []
        for seed in seeds:
            tasks = validate_tasks(self._adapter.tasks(split=split, seed=seed))
            if not tasks:
                raise ContractError("Four-arm benchmark returned no holdout tasks")
            for task_index, task in enumerate(tasks):
                task = _copy(task, "Four-arm task")
                context = task.get("context") or {}
                if (not isinstance(task.get("objective"), str)
                        or not isinstance(context, dict)
                        or context.get("split", split) != split
                        or "benchmark_registration" in context):
                    raise ContractError("Four-arm task payload or authority is invalid")
                unit_id, cluster_id = task.get("statistical_unit_id"), task.get("cluster_id")
                if (not isinstance(unit_id, str) or not unit_id or len(unit_id) > 500
                        or not isinstance(cluster_id, str) or not cluster_id
                        or len(cluster_id) > 500):
                    raise ContractError("Four-arm tasks require unit and cluster identities")
                rows.append({"seed": seed, "task_index": task_index, "task": task,
                             "task_digest": digest(task),
                             "statistical_unit_id": unit_id, "cluster_id": cluster_id})
        if len({row["statistical_unit_id"] for row in rows}) != len(rows):
            raise ContractError("Four-arm statistical units must be unique")
        if len({row["task_digest"] for row in rows}) != len(rows):
            raise ContractError("Four-arm task payloads must be unique")

        if provider == "none":
            resolved_model = model_profile_digest = None
        else:
            from ..models.config import load_profiles
            profiles, _ = load_profiles(self.tasks.project_root)
            profile = profiles.get(provider + "/" + model)
            if profile is None:
                raise ContractError("Four-arm model profile is not configured locally")
            resolved_model = profile.model
            model_profile_digest = digest({
                "id": profile.id, "model": profile.model, "base_url": profile.base_url})

        plan_id = _id("four-arm-study-plan")
        occurrence = {}
        schedule = []
        for row_index, row in enumerate(rows):
            n = occurrence.get(row["cluster_id"], 0)
            occurrence[row["cluster_id"]] = n + 1
            offset = (int(digest({"plan": plan_id, "cluster": row["cluster_id"]})[:8], 16) + n) % 4
            order = list(ARM_IDS[offset:] + ARM_IDS[:offset])
            if int(digest({"plan": plan_id, "row": row_index})[-8:], 16) % 2:
                order = [order[0], order[3], order[2], order[1]]
            for position, arm in enumerate(order):
                schedule.append({"cell_id": f"{plan_id}:{row_index}:{arm}",
                                 "row_index": row_index, "arm": arm,
                                 "position": position})

        protocol = {
            "benchmark_id": self._adapter.id,
            "benchmark_snapshot": deepcopy(executor.snapshot),
            "benchmark_descriptor_digest": _descriptor_digest(self._adapter),
            "adapter_fingerprint": _adapter_fingerprint(self._adapter),
            "execution_environment_digest": executor.environment_digest,
            "split": split, "seeds": list(seeds), "tasks": rows, "arms": arms,
            "episode_budget": episode_budget, "provider": provider, "model": model,
            "resolved_model": resolved_model,
            "model_profile_digest": model_profile_digest,
            "expected_observed_model": observed_model,
            "expected_provider_revision": provider_revision,
            "model_version_binding": (
                "provider_reported_revision" if provider_revision is not None else
                "request_alias_time_window" if provider != "none" else "none"),
            "require_model_calls": require_model_calls,
            "suite_role": role, "outcome_policy": outcome_policy(),
            "arm_order_strategy": "cluster_stratified_latin_rotation_v1",
            "missing_policy": "whole_quartet_fail_closed",
        }
        record = {"schema": FOUR_ARM_PLAN_SCHEMA, "id": plan_id,
                  "status": "registered", "created_at": time.time(),
                  **protocol, "schedule": schedule,
                  "protocol_digest": digest(protocol)}
        encoded, record_digest = _encode(record), digest(record)
        snapshot_digest = digest(executor.snapshot)
        unit_digests = [digest({"benchmark_id": self._adapter.id,
                                "snapshot_digest": snapshot_digest,
                                "statistical_unit_id": row["statistical_unit_id"]})
                        for row in rows]
        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            for unit_digest in unit_digests:
                prior = db.execute(
                    "SELECT plan_id FROM task_rsi_holdout_claims WHERE unit_digest=?",
                    (unit_digest,)).fetchone()
                if prior:
                    raise ContractError(
                        "A final-holdout unit was already reserved by " + prior[0])
            db.execute("INSERT INTO task_four_arm_study_plans VALUES(?,?,?)",
                       (plan_id, encoded, record_digest))
            db.executemany("INSERT INTO task_rsi_holdout_claims VALUES(?,?,?)",
                           [(item, plan_id, time.time()) for item in unit_digests])
        return {**deepcopy(record), "record_digest": record_digest}

    @staticmethod
    def _binding(cell):
        return {key: deepcopy(cell.get(key)) for key in _CELL_BINDING_KEYS}

    def _canonical_cell(self, plan, scheduled):
        row = plan["tasks"][scheduled["row_index"]]
        arm = plan["arms"][scheduled["arm"]]
        cell = {
            "id": scheduled["cell_id"], "plan_id": plan["id"],
            "row_index": scheduled["row_index"], "arm": scheduled["arm"],
            "position": scheduled["position"], "seed": row["seed"],
            "task_index": row["task_index"], "task": deepcopy(row["task"]),
            "task_digest": row["task_digest"],
            "statistical_unit_id": row["statistical_unit_id"],
            "cluster_id": row["cluster_id"],
            "package_id": arm["package_id"],
            "package_digest": arm["package_digest"],
            "memory_release_digest": arm["memory_release_digest"],
        }
        cell["binding_digest"] = digest(self._binding(cell))
        return cell

    def _cell(self, identity):
        with self.store.connect() as db:
            row = db.execute(
                "SELECT data FROM task_four_arm_study_cells WHERE id=?", (identity,)).fetchone()
        return json.loads(row[0]) if row else None

    def _validate_cell(self, plan, scheduled, cell):
        canonical = self._canonical_cell(plan, scheduled)
        if (not isinstance(cell, dict)
                or self._binding(cell) != self._binding(canonical)
                or cell.get("binding_digest") != canonical["binding_digest"]
                or digest(cell.get("task")) != canonical["task_digest"]
                or cell.get("status") not in {"preparing", "ready", *_TERMINAL}):
            raise ContractError("Four-arm cell differs from its frozen plan")
        return canonical

    def _reserve_cell(self, plan, scheduled, owner):
        canonical = self._canonical_cell(plan, scheduled)
        value = {**canonical, "status": "preparing", "episode_id": None}
        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            claim = db.execute(
                "SELECT status FROM task_four_arm_study_claims WHERE plan_id=?",
                (plan["id"],)).fetchone()
            if claim != (owner,):
                raise ContractError("Four-arm runner lost its claim")
            row = db.execute(
                "SELECT data FROM task_four_arm_study_cells WHERE id=?", (value["id"],)).fetchone()
            if row:
                existing = json.loads(row[0])
                self._validate_cell(plan, scheduled, existing)
                return existing, False
            db.execute("INSERT INTO task_four_arm_study_cells VALUES(?,?,?,?,?)",
                       (value["id"], plan["id"], value["status"],
                        _encode(value), time.time()))
        return deepcopy(value), True

    def _advance(self, plan, scheduled, owner, expected, updates):
        updates = _copy(updates, "Four-arm cell update")
        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if db.execute(
                    "SELECT status FROM task_four_arm_study_claims WHERE plan_id=?",
                    (plan["id"],)).fetchone() != (owner,):
                raise ContractError("Four-arm runner lost its claim")
            row = db.execute(
                "SELECT data FROM task_four_arm_study_cells WHERE id=?",
                (scheduled["cell_id"],)).fetchone()
            cell = json.loads(row[0]) if row else None
            self._validate_cell(plan, scheduled, cell)
            if cell["status"] != expected or expected in _TERMINAL:
                raise ContractError("Four-arm cell changed before transition")
            changed = {**cell, **updates}
            if self._binding(changed) != self._binding(cell):
                raise ContractError("Four-arm transition changed the frozen binding")
            self._validate_cell(plan, scheduled, changed)
            db.execute("UPDATE task_four_arm_study_cells SET status=?,data=?,updated=? WHERE id=?",
                       (changed["status"], _encode(changed), time.time(), cell["id"]))
        return changed

    def _claim(self, plan_id):
        owner, now = "running:" + uuid.uuid4().hex, time.time()
        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                "SELECT status,run_id FROM task_four_arm_study_claims WHERE plan_id=?",
                (plan_id,)).fetchone()
            if row:
                if row[0] == "completed" and row[1]:
                    return None, row[1]
                if row[0] != "paused":
                    raise ContractError("Four-arm study is already running")
                db.execute("UPDATE task_four_arm_study_claims SET status=?,updated=? WHERE plan_id=?",
                           (owner, now, plan_id))
            else:
                db.execute("INSERT INTO task_four_arm_study_claims VALUES(?,?,?,?,?)",
                           (plan_id, owner, None, now, now))
        return owner, None

    def _heartbeat(self, plan_id, owner):
        with self.store.connect() as db:
            changed = db.execute(
                "UPDATE task_four_arm_study_claims SET updated=? "
                "WHERE plan_id=? AND status=? AND run_id IS NULL",
                (time.time(), plan_id, owner)).rowcount
        if changed != 1:
            raise ContractError("Four-arm runner lost its claim")

    def _pause(self, plan_id, owner):
        with self.store.connect() as db:
            changed = db.execute(
                "UPDATE task_four_arm_study_claims SET status='paused',updated=? "
                "WHERE plan_id=? AND status=? AND run_id IS NULL",
                (time.time(), plan_id, owner)).rowcount
        if changed != 1:
            raise ContractError("Four-arm runner lost its claim while pausing")

    def recover(self, plan_id, *, lease_seconds=FOUR_ARM_CLAIM_LEASE_SECONDS):
        """CAS-recover an expired runner without redrawing a study cell.

        Recovery never invokes a provider, tool, package, or evaluator.  It
        binds a preparing cell to its unique already-persisted Episode, leaves
        a provably untouched ready Episode resumable, and marks uncertain
        in-flight execution missing.  The recovered claim is finally paused so
        a normal ``run`` call can continue from this reconstructed state.
        """
        if (type(lease_seconds) not in {int, float} or lease_seconds < 0
                or lease_seconds > 7 * 24 * 3600):
            raise ContractError("Four-arm recovery lease must be bounded and nonnegative")
        plan = self.plan(plan_id)
        self._validate_executor(plan)
        now, recovery_owner = time.time(), "recovering:" + uuid.uuid4().hex
        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                "SELECT status,run_id,updated FROM task_four_arm_study_claims WHERE plan_id=?",
                (plan_id,)).fetchone()
            if row is None:
                raise ContractError("Four-arm study has no runner claim to recover")
            if row[0] == "completed" and row[1]:
                return {"plan_id": plan_id, "status": "completed",
                        "run_id": row[1], "recovered_cells": 0,
                        "failed_closed_cells": 0}
            if not row[0].startswith(("running:", "recovering:")):
                raise ContractError(
                    "Only an expired running or recovering four-arm claim can be recovered")
            if now - row[2] < lease_seconds:
                raise ContractError("Four-arm runner lease has not expired")
            changed = db.execute(
                "UPDATE task_four_arm_study_claims SET status=?,updated=? "
                "WHERE plan_id=? AND status=? AND run_id IS NULL AND updated=?",
                (recovery_owner, now, plan_id, row[0], row[2])).rowcount
            if changed != 1:
                raise ContractError("Four-arm claim changed during recovery takeover")

        recovered = failed_closed = 0
        try:
            for scheduled in plan["schedule"]:
                cell = self._cell(scheduled["cell_id"])
                if cell is None:
                    continue
                self._validate_cell(plan, scheduled, cell)
                if cell["status"] in _TERMINAL:
                    continue
                if cell["status"] == "preparing":
                    episode_id = self._episode_for_cell(cell["id"])
                    if episode_id is None:
                        self._advance(
                            plan, scheduled, recovery_owner, "preparing",
                            self._missing("recovery:preparation_identity_unavailable"))
                        failed_closed += 1
                        continue
                    try:
                        self._validate_episode(plan, cell, episode_id)
                    except Exception as exc:
                        self._advance(
                            plan, scheduled, recovery_owner, "preparing",
                            self._missing(self._error_category(exc, "recovery_binding"),
                                          episode_id))
                        failed_closed += 1
                        continue
                    cell = self._advance(
                        plan, scheduled, recovery_owner, "preparing",
                        {"status": "ready", "episode_id": episode_id})
                    recovered += 1

                state = self.tasks.get_private(cell["episode_id"])
                # A ready or paused Episode is durably between side effects;
                # a terminal Episode only needs host evaluation.  A running
                # projection may represent a call/tool effect whose completion
                # was never durably observed, so replay is forbidden.
                if state.get("status") == "running":
                    self._advance(
                        plan, scheduled, recovery_owner, "ready",
                        self._missing("recovery:in_flight_side_effect_uncertain",
                                      cell["episode_id"]))
                    failed_closed += 1
            self._pause(plan_id, recovery_owner)
        except Exception:
            # The CAS owner remains identifiable.  Make a best-effort transition
            # to paused; if that fails, the original exception still prevents a
            # second runner from silently taking over.
            try:
                self._pause(plan_id, recovery_owner)
            except Exception:
                pass
            raise
        return {"plan_id": plan_id, "status": "paused",
                "recovered_cells": recovered,
                "failed_closed_cells": failed_closed}

    def _episode_for_cell(self, cell_id):
        matches = [state["id"] for state in self.store.list()
                   if state.get("task", {}).get("context", {}).get("study_cell_id") == cell_id]
        if len(matches) > 1:
            raise ContractError("Four-arm cell has multiple Episodes")
        return matches[0] if matches else None

    def _prepare(self, plan, cell):
        package = self.store.package(cell["package_id"])
        if package["digest"] != cell["package_digest"]:
            raise ContractError("Frozen four-arm package changed")
        task = deepcopy(cell["task"])
        context = deepcopy(task.get("context") or {})
        context.update({
            "split": plan["split"], "split_role": "final_holdout",
            "memory_writeback": False, "rsi_role": "confirmatory_holdout",
            "study_plan_id": plan["id"], "study_cell_id": cell["id"],
            "provider_requirement": plan["provider"],
            "model_requirement": plan["model"],
        })
        registration = plan["arms"][cell["arm"]]["memory_release"]
        benchmark_registration = {
            "benchmark_id": plan["benchmark_id"], "task_ref": deepcopy(task),
            "snapshot": deepcopy(plan["benchmark_snapshot"]),
            "host_runtime": host_runtime_fingerprint(),
        }
        state = self.tasks.create(
            task["objective"], inputs=task.get("inputs"),
            deliverables=task.get("deliverables"), budget=plan["episode_budget"],
            capabilities=task.get("capabilities"), package=package, context=context,
            constraints=task.get("constraints"), entry=task.get("entry", "execute"),
            benchmark_registration=benchmark_registration,
            memory_channel=(registration or {}).get("channel"),
            expected_memory_registration=registration)
        self._validate_episode(plan, cell, state["id"])
        return state["id"]

    def _validate_episode(self, plan, cell, episode_id):
        TaskStudyExecutor.validate_episode(self._executor, plan, cell, episode_id)
        expected = plan["arms"][cell["arm"]]["memory_release"]
        actual = self.store.memory_registration(episode_id)
        state = self.tasks.get_private(episode_id)
        snapshot = self.store.memory_snapshot(state["memory_snapshot_id"], episode_id)
        if expected is None:
            if actual is not None or snapshot.get("items") or snapshot.get("item_version_refs"):
                raise ContractError("Empty-memory four-arm cell received memory")
        else:
            if (_release_projection(actual) != expected
                    or snapshot.get("source") != expected
                    or not isinstance(snapshot.get("items"), list)):
                raise ContractError("Four-arm Episode memory differs from its frozen release")
        return state

    @staticmethod
    def _error_category(exc, phase):
        name = type(exc).__name__
        if (not name.isidentifier() or len(name) > 80
                or not isinstance(phase, str) or not phase.isidentifier()
                or len(phase) > 40):
            return "host_failure:unclassified"
        return phase + ":" + name

    @staticmethod
    def _missing(reason, episode_id=None):
        if (not isinstance(reason, str) or not reason or len(reason) > 160
                or any(character not in
                       "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_:"
                       for character in reason)):
            reason = "host_failure:unclassified"
        return {"status": "missing", "episode_id": episode_id, "score": None,
                "accepted": None, "evaluation_digest": None, "usage": None,
                "usage_complete": False, "execution_status": "error",
                "failure_class": "infrastructure_missing",
                "reason": reason[:500]}

    def run(self, plan_id, *, stop_event=None):
        plan = self.plan(plan_id)
        self._validate_executor(plan)
        owner, prior_run = self._claim(plan_id)
        if prior_run is not None:
            return self.run_record(prior_run)
        for scheduled in plan["schedule"]:
            if stop_event is not None and stop_event.is_set():
                self._pause(plan_id, owner)
                return {"schema": FOUR_ARM_RUN_SCHEMA, "plan_id": plan_id,
                        "status": "paused"}
            self._heartbeat(plan_id, owner)
            cell, created = self._reserve_cell(plan, scheduled, owner)
            if cell["status"] == "preparing":
                recovered = self._episode_for_cell(cell["id"])
                if recovered is not None:
                    try:
                        self._validate_episode(plan, cell, recovered)
                        cell = self._advance(plan, scheduled, owner, "preparing",
                                             {"status": "ready", "episode_id": recovered})
                    except Exception as exc:
                        cell = self._advance(plan, scheduled, owner, "preparing",
                                             self._missing(
                                                 self._error_category(exc, "recovery_binding"),
                                                 recovered))
                elif not created:
                    cell = self._advance(
                        plan, scheduled, owner, "preparing",
                        self._missing("recovery:preparation_identity_unavailable"))
                else:
                    try:
                        episode_id = self._prepare(plan, cell)
                        cell = self._advance(plan, scheduled, owner, "preparing",
                                             {"status": "ready", "episode_id": episode_id})
                    except Exception as exc:
                        cell = self._advance(
                            plan, scheduled, owner, "preparing",
                            self._missing(self._error_category(exc, "prepare"),
                                          self._episode_for_cell(cell["id"])))
            if cell["status"] in _TERMINAL:
                continue
            try:
                self._validate_episode(plan, cell, cell["episode_id"])
                receipt = TaskStudyExecutor.finish(
                    self._executor, plan, cell, cell["episode_id"], stop_event=stop_event)
                if receipt is None:
                    self._pause(plan_id, owner)
                    return {"schema": FOUR_ARM_RUN_SCHEMA, "plan_id": plan_id,
                            "status": "paused"}
                self._validate_episode(plan, cell, cell["episode_id"])
                self._advance(plan, scheduled, owner, "ready", receipt)
            except Exception as exc:
                self._advance(plan, scheduled, owner, "ready",
                              self._missing(self._error_category(exc, "finish"),
                                            cell["episode_id"]))

        cells = []
        for scheduled in plan["schedule"]:
            cell = self._cell(scheduled["cell_id"])
            self._validate_cell(plan, scheduled, cell)
            if cell["status"] not in _TERMINAL:
                raise ContractError("Four-arm study has nonterminal cells")
            if cell.get("episode_id") is not None:
                self._validate_episode(plan, cell, cell["episode_id"])
                # Evaluator-produced terminal evidence is reproducible from the
                # immutable Episode.  Host/infrastructure missingness has no
                # evaluation digest, so only its Episode binding can be checked.
                if cell.get("evaluation_digest") is not None:
                    receipt = TaskStudyExecutor.finish(
                        self._executor, plan, cell, cell["episode_id"], stop_event=None)
                    evidence_keys = (
                        "status", "episode_id", "score", "accepted",
                        "evaluation_digest", "usage", "usage_complete",
                        "execution_status", "failure_class", "reason",
                    )
                    if (receipt is None or any(
                            cell.get(key) != receipt.get(key) for key in evidence_keys)):
                        raise ContractError("Four-arm terminal cell evidence changed")
            cells.append(cell)
        quartets = []
        for row_index, row in enumerate(plan["tasks"]):
            members = [cell for cell in cells if cell["row_index"] == row_index]
            statuses = {cell["arm"]: cell["status"] for cell in members}
            if set(statuses) != set(ARM_IDS):
                raise ContractError("Four-arm quartet is incomplete")
            quartets.append({
                "row_index": row_index,
                "statistical_unit_id": row["statistical_unit_id"],
                "cluster_id": row["cluster_id"], "arm_statuses": statuses,
                "status": "measured" if all(value == "measured" for value in statuses.values())
                          else "missing",
            })
        run_record = {
            "schema": FOUR_ARM_RUN_SCHEMA,
            "id": "four-arm-study-run-" + digest({
                "plan": plan_id,
                "cells": [(cell["id"], cell["status"], cell.get("episode_id"),
                           cell.get("evaluation_digest")) for cell in cells],
            })[:24],
            "plan_id": plan_id, "plan_digest": plan["record_digest"],
            "protocol_digest": plan["protocol_digest"], "created_at": time.time(),
            "status": "completed",
            "measurement_complete": all(item["status"] == "measured" for item in quartets),
            "quartets": quartets,
            "cells": [{key: cell.get(key) for key in (
                "id", "row_index", "arm", "position", "task_digest",
                "statistical_unit_id", "cluster_id", "package_id", "package_digest",
                "memory_release_digest", "binding_digest", "status", "episode_id",
                "score", "accepted", "evaluation_digest", "usage", "usage_complete",
                "execution_status", "failure_class", "reason")}
                      for cell in cells],
        }
        encoded, record_digest = _encode(run_record), digest(run_record)
        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("INSERT INTO task_four_arm_study_runs VALUES(?,?,?)",
                       (run_record["id"], encoded, record_digest))
            changed = db.execute(
                "UPDATE task_four_arm_study_claims SET status='completed',run_id=?,updated=? "
                "WHERE plan_id=? AND status=? AND run_id IS NULL",
                (run_record["id"], time.time(), plan_id, owner)).rowcount
            if changed != 1:
                raise ContractError("Four-arm claim changed before completion")
        return {**run_record, "record_digest": record_digest}
