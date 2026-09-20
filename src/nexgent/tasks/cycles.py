"""Recoverable orchestration for one feedback-driven RSI cycle.

The service is deliberately a coordinator.  Generation, paired selection,
promotion, and deployment monitoring remain owned by their existing services
and continue to produce their own immutable evidence.  A cycle record stores
only frozen intent, state-machine progress, and references to that evidence.
"""

from __future__ import annotations

from copy import deepcopy
from dataclasses import asdict
import json
import re
import time
import uuid

from ..kernel.programs import digest
from .evolution import PromotionPolicy
from .packages import verify_package
from .tools import ContractError


CYCLE_SCHEMA = "nexgent.rsi-cycle.v1"
_TERMINAL = frozenset({"generation_missing", "rejected", "completed", "guard_failed", "rolled_back"})
_TRANSITIONS = {
    "registered": frozenset({"feedback_captured"}),
    "feedback_captured": frozenset({"generated", "generation_missing"}),
    "generated": frozenset({"selection_planned"}),
    "selection_planned": frozenset({"selection_run"}),
    "selection_run": frozenset({"selected", "rejected"}),
    "selected": frozenset({"guard_planned"}),
    "guard_planned": frozenset({"promoted"}),
    "promoted": frozenset({"guard_run"}),
    "guard_run": frozenset({"completed", "guard_failed", "rolled_back"}),
}


def _copy(value, label="RSI cycle value"):
    try:
        return json.loads(json.dumps(value, ensure_ascii=False, allow_nan=False))
    except (TypeError, ValueError, RecursionError) as exc:
        raise ContractError(f"{label} must be finite JSON: {str(exc)[:500]}") from None


def _identifier(value, label):
    if not isinstance(value, str) or not re.fullmatch(r"[a-z][a-z0-9_.-]{0,99}", value):
        raise ContractError(f"{label} must be a bounded lowercase identifier")
    return value


def _adapter_binding(adapter, label):
    identity = _identifier(getattr(adapter, "id", ""), f"{label} benchmark id")
    snapshot = _copy(adapter.snapshot(), f"{label} benchmark snapshot")
    if not isinstance(snapshot, dict):
        raise ContractError(f"{label} benchmark snapshot must be an object")
    return {"benchmark_id": identity, "snapshot": snapshot,
            "snapshot_digest": digest(snapshot)}


def public_rsi_cycle(record):
    """Return a bounded projection without evaluator, policy, or package content."""
    runner = record.get("runner") or {}
    pending = record.get("pending_action") or {}
    result = record.get("result")
    return {
        "schema": record.get("schema"), "id": record.get("id"),
        "revision": record.get("revision"), "status": record.get("status"),
        "created_at": record.get("created_at"), "updated_at": record.get("updated_at"),
        "channel": record.get("channel"),
        "channel_revision": record.get("channel_revision"),
        "parent_package_id": record.get("parent_package_id"),
        "parent_package_digest": record.get("parent_package_digest"),
        "improver_package_id": record.get("improver_package_id"),
        "improver_package_digest": record.get("improver_package_digest"),
        "improver": {
            "source": "channel" if record.get("improver_registration") else "package",
            "channel": (record.get("improver_registration") or {}).get("channel"),
            "revision": (record.get("improver_registration") or {}).get("revision"),
            "package_id": record.get("improver_package_id"),
            "package_digest": record.get("improver_package_digest"),
        },
        "feedback_episode_count": len(record.get("feedback_episode_ids") or []),
        "selection": {key: (record.get("selection") or {}).get(key) for key in (
            "benchmark_id", "snapshot_digest", "split", "split_role", "seed")},
        "guard": {key: (record.get("guard") or {}).get(key) for key in (
            "benchmark_id", "snapshot_digest", "split", "seed")},
        "refs": _copy(record.get("refs") or {}),
        "result": _copy(result) if result is not None else None,
        "runner": {"status": runner.get("status"),
                   "error_type": runner.get("error_type")},
        "pending_action": pending.get("name"),
    }


class RSICycleService:
    """Persist and resume the mandatory P3 feedback-to-guard state machine."""

    def __init__(self, task_service, evolution_service, generation_service):
        if evolution_service.tasks is not task_service:
            raise ValueError("Cycle and evolution services must share one TaskService")
        if (generation_service.tasks is not task_service
                or generation_service.evolution is not evolution_service):
            raise ValueError("Cycle and generation services must share task/evolution services")
        self.tasks = task_service
        self.evolution = evolution_service
        self.generation = generation_service
        self.store = task_service.store
        with self.store.connect() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS task_rsi_cycles(
                    id TEXT PRIMARY KEY, revision INTEGER NOT NULL, status TEXT NOT NULL,
                    data TEXT NOT NULL, digest TEXT NOT NULL, updated REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS task_rsi_cycle_events(
                    cycle_id TEXT NOT NULL, sequence INTEGER NOT NULL, kind TEXT NOT NULL,
                    created REAL NOT NULL, data TEXT NOT NULL, previous TEXT NOT NULL,
                    digest TEXT NOT NULL, PRIMARY KEY(cycle_id,sequence));
            """)

    @staticmethod
    def _encode(value):
        return json.dumps(value, ensure_ascii=False, sort_keys=True,
                          separators=(",", ":"), allow_nan=False)

    def _append_event(self, db, cycle_id, kind, content):
        row = db.execute(
            "SELECT sequence,digest FROM task_rsi_cycle_events WHERE cycle_id=? "
            "ORDER BY sequence DESC LIMIT 1", (cycle_id,)).fetchone()
        sequence, previous = (row[0] + 1, row[1]) if row else (1, "genesis")
        event = {"cycle_id": cycle_id, "sequence": sequence, "kind": kind,
                 "created": time.time(), "content": _copy(content), "previous": previous}
        event["digest"] = digest(event)
        db.execute("INSERT INTO task_rsi_cycle_events VALUES(?,?,?,?,?,?,?)", (
            cycle_id, sequence, kind, event["created"], self._encode(event["content"]),
            previous, event["digest"]))
        return event

    def get(self, cycle_id):
        with self.store.connect() as db:
            row = db.execute(
                "SELECT revision,status,data,digest FROM task_rsi_cycles WHERE id=?",
                (cycle_id,)).fetchone()
        if row is None:
            raise KeyError(cycle_id)
        record = json.loads(row[2])
        if (record.get("revision") != row[0] or record.get("status") != row[1]
                or digest(record) != row[3]):
            raise ContractError("RSI cycle record digest mismatch")
        return {**record, "record_digest": row[3]}

    def events(self, cycle_id):
        self.get(cycle_id)
        with self.store.connect() as db:
            rows = db.execute(
                "SELECT sequence,kind,created,data,previous,digest "
                "FROM task_rsi_cycle_events WHERE cycle_id=? ORDER BY sequence",
                (cycle_id,)).fetchall()
        result, previous = [], "genesis"
        for sequence, kind, created, data, stored_previous, record_digest in rows:
            event = {"cycle_id": cycle_id, "sequence": sequence, "kind": kind,
                     "created": created, "content": json.loads(data),
                     "previous": stored_previous}
            if stored_previous != previous or digest(event) != record_digest:
                raise ContractError("RSI cycle event chain is invalid")
            event["digest"] = record_digest
            result.append(event)
            previous = record_digest
        return result

    def public(self, cycle_id):
        return public_rsi_cycle(self.get(cycle_id))

    def _replace(self, old, changed, kind, content):
        body = deepcopy(changed)
        body["revision"] = old["revision"] + 1
        body["updated_at"] = time.time()
        encoded, record_digest = self._encode(body), digest(body)
        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            updated = db.execute(
                "UPDATE task_rsi_cycles SET revision=?,status=?,data=?,digest=?,updated=? "
                "WHERE id=? AND revision=? AND digest=?",
                (body["revision"], body["status"], encoded, record_digest,
                 body["updated_at"], body["id"], old["revision"],
                 old["record_digest"])).rowcount
            if updated != 1:
                raise ContractError("RSI cycle changed concurrently")
            self._append_event(db, body["id"], kind, content)
        return {**body, "record_digest": record_digest}

    def create(self, *, channel, feedback_episode_ids, improver_package=None,
               improver_channel=None, expected_improver_revision=None,
               mutation_policy, expected_revision, selection_adapter, guard_adapter,
               selection_seed=0, guard_seed=0, generation_budget=None,
               selection_budget=None, guard_budget=None, policy=None,
               selection_options=None, guard_options=None,
               rollback_on_regression=True):
        """Freeze a complete cycle intent before generation or evaluation starts."""
        channel = _identifier(channel, "Package channel")
        active = self.evolution.active(channel)
        if type(expected_revision) is not int or expected_revision != active["revision"]:
            raise ContractError("RSI cycle expected revision is stale")
        if (not isinstance(feedback_episode_ids, list) or not feedback_episode_ids
                or len(feedback_episode_ids) > 128
                or any(not isinstance(item, str) or not item for item in feedback_episode_ids)
                or len(set(feedback_episode_ids)) != len(feedback_episode_ids)):
            raise ContractError("RSI cycle needs unique feedback Episode ids")
        if improver_package is not None and improver_channel is not None:
            raise ContractError("Specify either an improver package or an improver channel")
        if improver_channel is not None:
            if type(expected_improver_revision) is not int:
                raise ContractError(
                    "Improver channel requires an expected improver revision")
            from .improvers import active_improver_registration
            resolved_improver = active_improver_registration(self.store, improver_channel)
            if resolved_improver["revision"] != expected_improver_revision:
                raise ContractError("Improver channel expected revision is stale")
            improver_package = resolved_improver["package"]
            improver_registration = {
                key: resolved_improver[key] for key in
                ("channel", "revision", "package_id", "package_digest")}
        else:
            if expected_improver_revision is not None:
                raise ContractError(
                    "An expected improver revision requires an improver channel")
            if improver_package is None:
                raise ContractError(
                    "RSI cycle requires an improver package or improver channel")
            verify_package(improver_package)
            if "improve" not in improver_package["manifest"].get("entries", {}):
                raise ContractError("RSI cycle improver must register the improve entry")
            self.store.put_package(improver_package)
            improver_registration = None
        policy = PromotionPolicy() if policy is None else policy
        if not isinstance(policy, PromotionPolicy):
            raise TypeError("policy must be a PromotionPolicy")
        if type(selection_seed) is not int or type(guard_seed) is not int:
            raise ContractError("RSI cycle seeds must be integers")
        if type(rollback_on_regression) is not bool:
            raise ContractError("rollback_on_regression must be boolean")
        selection = _adapter_binding(selection_adapter, "Selection")
        guard = _adapter_binding(guard_adapter, "Guard")
        now = time.time()
        record = {
            "schema": CYCLE_SCHEMA, "id": "rsi-cycle-" + uuid.uuid4().hex[:16],
            "revision": 0, "status": "registered", "created_at": now,
            "updated_at": now, "channel": channel,
            "channel_revision": active["revision"],
            "parent_package_id": active["package_id"],
            "parent_package_digest": active["package_digest"],
            "feedback_episode_ids": list(feedback_episode_ids),
            "improver_package_id": improver_package["id"],
            "improver_package_digest": improver_package["digest"],
            "improver_registration": improver_registration,
            "mutation_policy": _copy(mutation_policy, "Mutation policy"),
            "generation_budget": _copy(generation_budget, "Generation budget"),
            "selection": {**selection, "split": "selection", "split_role": "selection",
                          "seed": selection_seed,
                          "budget": _copy(selection_budget, "Selection budget"),
                          "options": _copy(selection_options or {}, "Selection options"),
                          "policy": asdict(policy)},
            "guard": {**guard, "split": "guard", "seed": guard_seed,
                      "budget": _copy(guard_budget, "Guard budget"),
                      "options": _copy(guard_options or {}, "Guard options"),
                      "rollback_on_regression": rollback_on_regression},
            "refs": {}, "result": None,
            "pending_action": None,
            "runner": {"status": "idle", "token": None, "updated_at": now,
                       "last_error": None, "error_type": None},
        }
        encoded, record_digest = self._encode(record), digest(record)
        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("INSERT INTO task_rsi_cycles VALUES(?,?,?,?,?,?)", (
                record["id"], 0, record["status"], encoded, record_digest, now))
            self._append_event(db, record["id"], "cycle_registered", {
                "channel": channel, "channel_revision": active["revision"],
                "parent_package_id": active["package_id"],
                "improver_registration": improver_registration,
                "selection_snapshot_digest": selection["snapshot_digest"],
                "guard_snapshot_digest": guard["snapshot_digest"]})
        return {**record, "record_digest": record_digest}

    @staticmethod
    def _verify_adapter(binding, adapter, label):
        current = _adapter_binding(adapter, label)
        if (current["benchmark_id"] != binding["benchmark_id"]
                or current["snapshot_digest"] != binding["snapshot_digest"]
                or current["snapshot"] != binding["snapshot"]):
            raise ContractError(f"{label} benchmark changed from the frozen RSI cycle")

    def _claim(self, cycle_id):
        old = self.get(cycle_id)
        if old["status"] in _TERMINAL:
            return old, None
        runner = old.get("runner") or {}
        if old.get("pending_action") is not None:
            raise ContractError(
                "RSI cycle has an uncertain external action; call recover() explicitly")
        if runner.get("status") == "running":
            raise ContractError(
                "RSI cycle runner may have been interrupted; call recover() explicitly")
        token = uuid.uuid4().hex
        changed = deepcopy(old)
        changed.pop("record_digest", None)
        changed["runner"] = {"status": "running", "token": token,
                             "updated_at": time.time(), "last_error": None,
                             "error_type": None}
        return self._replace(old, changed, "cycle_claimed", {"token_digest": digest(token)}), token

    def _release(self, record, token, *, paused=False, error=None):
        current = self.get(record["id"])
        if current["status"] in _TERMINAL:
            desired = "completed"
        else:
            desired = "paused" if paused else "idle"
        if current.get("runner", {}).get("token") != token:
            raise ContractError("RSI cycle runner lost its claim")
        changed = deepcopy(current)
        changed.pop("record_digest", None)
        changed["runner"] = {"status": desired, "token": None,
                             "updated_at": time.time(),
                             "last_error": str(error)[:1000] if error else None,
                             "error_type": type(error).__name__ if error else None}
        return self._replace(current, changed, "cycle_released", {
            "runner_status": desired,
            "error_type": type(error).__name__ if error else None})

    def recover(self, cycle_id, *, confirm_no_external_commit=False):
        """Release an interrupted claim without silently replaying side effects.

        A claim with no pending action is safe to release.  When an action was
        pending, the caller must explicitly attest that it did not commit.  If
        that cannot be established, the record remains ``recovery_required``
        for manual evidence reconciliation.
        """
        if type(confirm_no_external_commit) is not bool:
            raise TypeError("confirm_no_external_commit must be boolean")
        old = self.get(cycle_id)
        if old["status"] in _TERMINAL:
            return old
        pending = old.get("pending_action")
        run_claim = None
        if pending is not None and old["status"] in {"selection_planned", "promoted"}:
            kind = "paired" if old["status"] == "selection_planned" else "monitor"
            plan_key = "selection_plan_id" if kind == "paired" else "monitor_plan_id"
            run_claim = self.evolution.inspect_run_claim(kind, old["refs"][plan_key])
            if run_claim is not None and run_claim["status"] == "completed":
                # The existing service will return the same immutable record on
                # resume, so linking it is safe and does not replay execution.
                confirm_no_external_commit = True
            elif run_claim is not None and run_claim["status"] == "running":
                if run_claim.get("durable_record_id") is not None:
                    run_claim = self.evolution.recover_run_claim(
                        kind, old["refs"][plan_key])
                    confirm_no_external_commit = True
                elif confirm_no_external_commit:
                    self.evolution.recover_run_claim(
                        kind, old["refs"][plan_key], confirm_no_external_commit=True)
                else:
                    confirm_no_external_commit = False
        changed = deepcopy(old)
        changed.pop("record_digest", None)
        if pending is not None and not confirm_no_external_commit:
            changed["runner"] = {
                "status": "recovery_required", "token": None,
                "updated_at": time.time(), "last_error": None,
                "error_type": "UncertainExternalCommit"}
            return self._replace(old, changed, "cycle_recovery_required", {
                "action": pending.get("name")})
        changed["pending_action"] = None
        changed["runner"] = {"status": "paused", "token": None,
                             "updated_at": time.time(), "last_error": None,
                             "error_type": None}
        return self._replace(old, changed, "cycle_recovered", {
            "action": pending.get("name") if pending else None,
            "external_commit_excluded": pending is not None and run_claim is None,
            "completed_run_linked": bool(
                run_claim is not None and run_claim["status"] == "completed")})

    def _begin_action(self, record, token):
        current = self.get(record["id"])
        if current.get("runner", {}).get("token") != token:
            raise ContractError("RSI cycle runner lost its claim")
        if current.get("pending_action") is not None:
            raise ContractError("RSI cycle already has a pending external action")
        changed = deepcopy(current)
        changed.pop("record_digest", None)
        action = current["status"]
        changed["pending_action"] = {"name": action, "started_at": time.time()}
        changed["runner"]["updated_at"] = time.time()
        return self._replace(current, changed, "cycle_action_started", {"action": action})

    def _advance(self, record, token, expected, status, refs=None, result=None):
        current = self.get(record["id"])
        if current["status"] != expected:
            raise ContractError(f"RSI cycle expected {expected}, found {current['status']}")
        if current.get("runner", {}).get("token") != token:
            raise ContractError("RSI cycle runner lost its claim")
        if status not in _TRANSITIONS.get(expected, frozenset()):
            raise ContractError("RSI cycle transition would skip a mandatory stage")
        changed = deepcopy(current)
        changed.pop("record_digest", None)
        changed["status"] = status
        changed["pending_action"] = None
        if refs:
            changed["refs"].update(_copy(refs, "RSI cycle evidence references"))
        if result is not None:
            changed["result"] = _copy(result, "RSI cycle result")
        changed["runner"]["updated_at"] = time.time()
        return self._replace(current, changed, "cycle_transitioned", {
            "from": expected, "to": status,
            "reference_keys": sorted((refs or {}).keys())})

    def _step(self, record, token, selection_adapter, guard_adapter, stop_event):
        status, refs = record["status"], record["refs"]
        if status == "registered":
            feedback = self.generation.capture_feedback(
                record["channel"], record["feedback_episode_ids"],
                record["channel_revision"])
            return self._advance(record, token, status, "feedback_captured",
                                 {"feedback_bundle_id": feedback["id"]})
        if status == "feedback_captured":
            improver_registration = record.get("improver_registration")
            if improver_registration is None:
                improver = self.store.package(record["improver_package_id"])
                if improver["digest"] != record["improver_package_digest"]:
                    raise ContractError("RSI cycle improver package digest changed")
                improver_channel = None
                expected_improver_revision = None
            else:
                improver = None
                improver_channel = improver_registration["channel"]
                expected_improver_revision = improver_registration["revision"]
            generation = self.generation.generate(
                record["channel"], refs["feedback_bundle_id"], improver,
                record["mutation_policy"], record["channel_revision"],
                improver_channel=improver_channel,
                expected_improver_revision=expected_improver_revision,
                budget=record["generation_budget"], stop_event=stop_event)
            generated_refs = {"generation_id": generation["id"]}
            if generation["status"] != "generated":
                return self._advance(record, token, status, "generation_missing",
                                     generated_refs, {"outcome": "generation_missing",
                                                      "reason_type": generation.get("reason_type")})
            generated_refs["candidate_id"] = generation["candidate_id"]
            return self._advance(record, token, status, "generated", generated_refs)
        if status == "generated":
            config = record["selection"]
            plan = self.evolution.plan_pair(
                refs["candidate_id"], selection_adapter, split=config["split"],
                split_role="selection", seed=config["seed"], budget=config["budget"],
                policy=PromotionPolicy(**config["policy"]), **config["options"])
            return self._advance(record, token, status, "selection_planned",
                                 {"selection_plan_id": plan["id"]})
        if status == "selection_planned":
            trial = self.evolution.run_pair(
                refs["selection_plan_id"], selection_adapter, stop_event=stop_event)
            return self._advance(record, token, status, "selection_run",
                                 {"trial_id": trial["id"]})
        if status == "selection_run":
            decision = self.evolution.assess(refs["trial_id"])
            decision_refs = {"decision_id": decision["id"]}
            if not decision["eligible"]:
                return self._advance(record, token, status, "rejected", decision_refs,
                                     {"outcome": "rejected", "gates": decision["gates"]})
            return self._advance(record, token, status, "selected", decision_refs)
        if status == "selected":
            config = record["guard"]
            plan = self.evolution.plan_monitor(
                refs["candidate_id"], guard_adapter, split=config["split"],
                seed=config["seed"], budget=config["budget"], **config["options"])
            return self._advance(record, token, status, "guard_planned",
                                 {"monitor_plan_id": plan["id"]})
        if status == "guard_planned":
            active = self.evolution.active(record["channel"])
            candidate = self.evolution.candidate(refs["candidate_id"])
            promotion = active.get("promotion") or {}
            if (active["package_id"] == candidate["package_id"]
                    and promotion.get("candidate_id") == candidate["id"]
                    and promotion.get("decision_id") == refs["decision_id"]
                    and promotion.get("monitor_plan_id") == refs["monitor_plan_id"]):
                promoted = active
            else:
                promoted = self.evolution.promote(
                    refs["candidate_id"], refs["decision_id"],
                    monitor_plan_id=refs["monitor_plan_id"])
            return self._advance(record, token, status, "promoted", {
                "promoted_revision": promoted["revision"],
                "promoted_package_id": promoted["package_id"]})
        if status == "promoted":
            guard = self.evolution.run_monitor(
                record["channel"], guard_adapter, stop_event=stop_event,
                expected_revision=refs["promoted_revision"],
                expected_package_id=refs["promoted_package_id"],
                expected_monitor_plan_id=refs["monitor_plan_id"])
            return self._advance(record, token, status, "guard_run", {
                "monitor_run_id": guard["id"],
                "guard_episode_ids": guard["episode_ids"]})
        if status == "guard_run":
            monitored = self.evolution.monitor(
                record["channel"], refs["guard_episode_ids"],
                rollback_on_regression=record["guard"]["rollback_on_regression"],
                expected_revision=refs["promoted_revision"],
                expected_package_id=refs["promoted_package_id"],
                expected_monitor_plan_id=refs["monitor_plan_id"])
            if monitored["rolled_back"]:
                terminal = "rolled_back"
            elif monitored["degraded"]:
                terminal = "guard_failed"
            else:
                terminal = "completed"
            return self._advance(record, token, status, terminal, result={
                "outcome": terminal, "degraded": monitored["degraded"],
                "rolled_back": monitored["rolled_back"],
                "metrics": monitored["metrics"],
                "active_package_id": monitored["active"]["package_id"],
                "active_revision": monitored["active"]["revision"]})
        raise ContractError(f"Unsupported RSI cycle state: {status}")

    def run(self, cycle_id, selection_adapter, guard_adapter, *, stop_event=None,
            max_steps=None):
        """Run to a terminal state, or checkpoint after ``max_steps`` stages."""
        if max_steps is not None and (type(max_steps) is not int or max_steps < 1):
            raise ValueError("max_steps must be a positive integer")
        record, token = self._claim(cycle_id)
        if token is None:
            return record
        try:
            self._verify_adapter(record["selection"], selection_adapter, "Selection")
            self._verify_adapter(record["guard"], guard_adapter, "Guard")
            steps = 0
            while record["status"] not in _TERMINAL:
                if stop_event is not None and stop_event.is_set():
                    return self._release(record, token, paused=True)
                record = self._begin_action(record, token)
                record = self._step(record, token, selection_adapter, guard_adapter, stop_event)
                steps += 1
                if max_steps is not None and steps >= max_steps:
                    return self._release(record, token)
            return self._release(record, token)
        except Exception as exc:
            self._release(record, token, paused=True, error=exc)
            raise

    resume = run
