"""Recoverable orchestration for one recursive-improver (P4) cycle.

The coordinator owns no evaluation or deployment authority.  It freezes one
cycle intent, checkpoints references to the immutable evidence produced by the
existing improver/meta/guard services, and reconciles terminal evidence after
an interrupted checkpoint before allowing any replay.
"""

from __future__ import annotations

from copy import deepcopy
from dataclasses import asdict
import json
import math
import re
import time
import uuid

from ..kernel.programs import digest
from .evolution import active_package_registration
from .meta_evaluation import AdmissionConflict, MetaEvaluationPolicy
from .packages import verify_package
from .tools import ContractError


RECURSIVE_CYCLE_SCHEMA = "nexgent.recursive-improver-cycle.v1"
_TERMINAL = frozenset({"generation_missing", "rejected", "completed", "rolled_back"})
_TRANSITIONS = {
    "registered": frozenset({"feedback_captured"}),
    "feedback_captured": frozenset({"generated", "generation_missing"}),
    "generated": frozenset({"meta_planned"}),
    "meta_planned": frozenset({"meta_run"}),
    "meta_run": frozenset({"meta_assessed"}),
    "meta_assessed": frozenset({"decision_recorded"}),
    "decision_recorded": frozenset({"guard_planned", "rejected"}),
    "guard_planned": frozenset({"promoted"}),
    "promoted": frozenset({"completed", "rolled_back"}),
}
_PUBLIC_REF_TYPES = {
    "improver_feedback_id": str, "improver_generation_id": str,
    "candidate_id": str, "r1_package_id": str, "r1_package_digest": str,
    "meta_plan_id": str, "meta_trial_id": str, "meta_evaluation_id": str,
    "improver_decision_id": str, "guard_plan_id": str,
    "promoted_revision": int, "promoted_package_id": str,
    "guard_action_id": str, "guard_run_id": str,
}
_PUBLIC_RESULT_TYPES = {
    "outcome": frozenset({"generation_missing", "rejected", "completed", "rolled_back"}),
    "meta_evaluation_id": str, "degraded": bool, "rolled_back": bool,
    "active_revision": int, "active_package_id": str,
    "active_package_digest": str,
}


def _copy(value, label="Recursive cycle value"):
    try:
        return json.loads(json.dumps(value, ensure_ascii=False, allow_nan=False))
    except (TypeError, ValueError, RecursionError) as exc:
        raise ContractError(f"{label} must be finite JSON: {str(exc)[:500]}") from None


def _public_scalars(value, fields):
    if not isinstance(value, dict):
        return {}
    result = {}
    for key, expected in fields.items():
        if key not in value:
            continue
        item = value[key]
        valid = (
            (expected is str and isinstance(item, str) and bool(item))
            or (expected is int and type(item) is int and item >= 0)
            or (expected is bool and type(item) is bool)
            or (isinstance(expected, frozenset)
                and isinstance(item, str) and item in expected)
        )
        if valid:
            result[key] = item
    return result


def _identifier(value, label):
    if not isinstance(value, str) or not re.fullmatch(r"[a-z][a-z0-9_.-]{0,99}", value):
        raise ContractError(f"{label} must be a bounded lowercase identifier")
    return value


def _ids(values, label, *, allow_empty=False):
    if (not isinstance(values, list) or (not values and not allow_empty)
            or len(values) > 256
            or any(not isinstance(value, str) or not value for value in values)
            or len(set(values)) != len(values)):
        raise ContractError(f"{label} must be a bounded list of unique ids")
    return list(values)


def public_recursive_cycle(record):
    """Return a bounded projection without source, tasks, evaluator, or policy."""
    runner = record.get("runner") or {}
    pending = record.get("pending_action") or {}
    workload = record.get("workload") or {}
    guard = record.get("guard") or {}
    refs = record.get("refs") if isinstance(record.get("refs"), dict) else {}
    raw_result = record.get("result")
    result = raw_result if isinstance(raw_result, dict) else {}
    return {
        "schema": record.get("schema"),
        "id": record.get("id"),
        "revision": record.get("revision"),
        "status": record.get("status"),
        "created_at": record.get("created_at"),
        "updated_at": record.get("updated_at"),
        "improver": {
            "channel": record.get("channel"),
            "revision": record.get("channel_revision"),
            "r0_package_id": record.get("r0_package_id"),
            "r0_package_digest": record.get("r0_package_digest"),
            "mutation_policy_digest": record.get("improver_mutation_policy_digest"),
            "capability_envelope_digest": record.get(
                "improver_capability_envelope_digest"),
        },
        "task_start": {
            "channel": record.get("task_channel"),
            "revision": record.get("task_channel_revision"),
            "package_id": record.get("task_agent_id"),
            "package_digest": record.get("task_agent_digest"),
            "feedback_bundle_id": record.get("task_feedback_bundle_id"),
            "feedback_bundle_digest": record.get("task_feedback_bundle_digest"),
            "mutation_policy_digest": record.get("task_mutation_policy_digest"),
        },
        "feedback": {
            "generation_count": len(record.get("feedback_generation_ids") or []),
            "decision_count": len(record.get("feedback_decision_ids") or []),
            "intent_digest": record.get("feedback_intent_digest"),
        },
        "workload": {
            "development_task_count": len(workload.get("development_tasks") or []),
            "selection_task_count": len(workload.get("selection_tasks") or []),
            "development_digest": workload.get("development_digest"),
            "selection_digest": workload.get("selection_digest"),
            "evaluator_digest": workload.get("evaluator_digest"),
            "meta_policy_digest": workload.get("meta_policy_digest"),
            "budget_digest": workload.get("budget_digest"),
        },
        "guard": {
            "task_count": len(guard.get("tasks") or []),
            "task_digest": guard.get("task_digest"),
            "evaluator_digest": guard.get("evaluator_digest"),
            "budget_digest": guard.get("budget_digest"),
            "min_mean_utility": guard.get("min_mean_utility"),
            "min_success_rate": guard.get("min_success_rate"),
        },
        "refs": _public_scalars(refs, _PUBLIC_REF_TYPES),
        "result": (_public_scalars(result, _PUBLIC_RESULT_TYPES)
                   if raw_result is not None else None),
        "runner": {"status": runner.get("status"), "error_type": runner.get("error_type")},
        "pending_action": pending.get("stage"),
    }


class RecursiveImproverCycleService:
    """Persist and resume the mandatory P4 recursive-improver state machine."""

    def __init__(self, improver_service, meta_evaluation_service, guard_service):
        if (meta_evaluation_service.store is not improver_service.store
                or guard_service.store is not improver_service.store
                or guard_service.improvers is not improver_service):
            raise ValueError("Recursive cycle services must share one task store")
        self.improvers = improver_service
        self.meta = meta_evaluation_service
        self.guards = guard_service
        self.store = improver_service.store
        with self.store.connect() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS task_recursive_improver_cycles(
                    id TEXT PRIMARY KEY, revision INTEGER NOT NULL,
                    status TEXT NOT NULL, data TEXT NOT NULL,
                    digest TEXT NOT NULL, updated REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS task_recursive_improver_cycle_events(
                    cycle_id TEXT NOT NULL, sequence INTEGER NOT NULL,
                    kind TEXT NOT NULL, created REAL NOT NULL, data TEXT NOT NULL,
                    previous TEXT NOT NULL, digest TEXT NOT NULL,
                    PRIMARY KEY(cycle_id,sequence));
            """)

    @staticmethod
    def _encode(value):
        return json.dumps(value, ensure_ascii=False, sort_keys=True,
                          separators=(",", ":"), allow_nan=False)

    def _append_event(self, db, cycle_id, kind, content):
        row = db.execute(
            "SELECT sequence,digest FROM task_recursive_improver_cycle_events "
            "WHERE cycle_id=? ORDER BY sequence DESC LIMIT 1", (cycle_id,)).fetchone()
        sequence, previous = (row[0] + 1, row[1]) if row else (1, "genesis")
        event = {"cycle_id": cycle_id, "sequence": sequence, "kind": kind,
                 "created": time.time(), "content": _copy(content), "previous": previous}
        event_digest = digest(event)
        db.execute("INSERT INTO task_recursive_improver_cycle_events VALUES(?,?,?,?,?,?,?)", (
            cycle_id, sequence, kind, event["created"], self._encode(event["content"]),
            previous, event_digest))

    def get(self, cycle_id):
        with self.store.connect() as db:
            row = db.execute(
                "SELECT revision,status,data,digest FROM task_recursive_improver_cycles "
                "WHERE id=?", (cycle_id,)).fetchone()
        if row is None:
            raise KeyError(cycle_id)
        record = json.loads(row[2])
        if (record.get("revision") != row[0] or record.get("status") != row[1]
                or digest(record) != row[3]):
            raise ContractError("Recursive improver cycle record digest mismatch")
        return {**record, "record_digest": row[3]}

    def events(self, cycle_id):
        self.get(cycle_id)
        with self.store.connect() as db:
            rows = db.execute(
                "SELECT sequence,kind,created,data,previous,digest "
                "FROM task_recursive_improver_cycle_events WHERE cycle_id=? "
                "ORDER BY sequence", (cycle_id,)).fetchall()
        result, previous = [], "genesis"
        for sequence, kind, created, data, stored_previous, record_digest in rows:
            event = {"cycle_id": cycle_id, "sequence": sequence, "kind": kind,
                     "created": created, "content": json.loads(data),
                     "previous": stored_previous}
            if stored_previous != previous or digest(event) != record_digest:
                raise ContractError("Recursive improver cycle event chain is invalid")
            event["digest"] = record_digest
            result.append(event)
            previous = record_digest
        return result

    def show(self, cycle_id):
        return public_recursive_cycle(self.get(cycle_id))

    def _replace(self, old, changed, kind, content, *, transaction_hook=None):
        if transaction_hook is not None and not callable(transaction_hook):
            raise TypeError("transaction_hook must be callable")
        body = deepcopy(changed)
        body.pop("record_digest", None)
        body["revision"] = old["revision"] + 1
        body["updated_at"] = time.time()
        encoded, record_digest = self._encode(body), digest(body)
        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            updated = db.execute(
                "UPDATE task_recursive_improver_cycles SET revision=?,status=?,data=?,"
                "digest=?,updated=? WHERE id=? AND revision=? AND digest=?", (
                    body["revision"], body["status"], encoded, record_digest,
                    body["updated_at"], body["id"], old["revision"],
                    old["record_digest"])).rowcount
            if updated != 1:
                raise ContractError("Recursive improver cycle changed concurrently")
            if transaction_hook is not None:
                transaction_hook(db, body)
            self._append_event(db, body["id"], kind, content)
        return {**body, "record_digest": record_digest}

    def start(self, *, channel, expected_revision, generation_ids, decision_ids,
              task_agent, task_feedback_bundle, task_channel, task_channel_revision,
              task_mutation_policy, provider, model, development_tasks,
              selection_tasks, evaluator, meta_budget, guard_budget, guard_tasks,
              guard_min_mean_utility, self_generation_budget=None, memory=None,
              meta_policy=None, offspring_per_arm=1, guard_evaluator=None,
              guard_min_success_rate=1.0):
        """Freeze one complete P4 cycle without starting an Episode."""
        channel = _identifier(channel, "Improver channel")
        active = self.improvers.active(channel)
        if type(expected_revision) is not int or active["revision"] != expected_revision:
            raise ContractError("Recursive cycle expected improver revision is stale")
        generation_ids = _ids(generation_ids, "Task-agent generation ids")
        decision_ids = _ids(decision_ids, "Task-agent decision ids", allow_empty=True)
        task_agent = _copy(task_agent, "Common TaskAgent A0")
        verify_package(task_agent)
        task_channel = _identifier(task_channel, "Task-agent channel")
        task_active = active_package_registration(self.store, task_channel)
        if (type(task_channel_revision) is not int
                or task_active["revision"] != task_channel_revision
                or task_active["package_id"] != task_agent["id"]
                or task_active["package_digest"] != task_agent["digest"]):
            raise ContractError("Recursive cycle common TaskAgent A0 is stale")
        task_feedback_bundle = _copy(task_feedback_bundle, "Task FeedbackBundle")
        try:
            stored_feedback = self.meta._external(
                "task_feedback_bundles", task_feedback_bundle.get("id"))
        except KeyError:
            raise ContractError("Task FeedbackBundle is not local immutable evidence") from None
        if stored_feedback != task_feedback_bundle:
            raise ContractError("Task FeedbackBundle differs from immutable evidence")
        if (task_feedback_bundle.get("channel") != task_channel
                or task_feedback_bundle.get("channel_revision") != task_channel_revision
                or task_feedback_bundle.get("parent_package_id") != task_agent["id"]
                or task_feedback_bundle.get("parent_package_digest") != task_agent["digest"]):
            raise ContractError("Task FeedbackBundle does not bind common TaskAgent A0")
        task_mutation_policy = _copy(task_mutation_policy, "Task mutation policy")
        if not isinstance(task_mutation_policy, dict) or not task_mutation_policy:
            raise ContractError("Task mutation policy must be a nonempty object")
        development_tasks = self.meta._tasks(development_tasks, "Development")
        selection_tasks = self.meta._tasks(selection_tasks, "Selection")
        evaluator = _copy(evaluator, "Meta evaluator")
        guard_evaluator = _copy(
            evaluator if guard_evaluator is None else guard_evaluator, "Guard evaluator")
        if (not isinstance(evaluator, dict) or not evaluator
                or not isinstance(guard_evaluator, dict) or not guard_evaluator):
            raise ContractError("Recursive cycle evaluators must be nonempty objects")
        guard_tasks = self.meta._tasks(guard_tasks, "Guard")
        meta_budget = self.meta._budget(meta_budget)
        guard_budget = self.guards._budget(guard_budget)
        self_generation_budget = self.improvers._budget(
            active["version"], self_generation_budget)
        if memory is None:
            memory = {"kind": "empty"}
        memory = _copy(memory, "Memory starting point")
        if memory != {"kind": "empty"}:
            raise ContractError("Recursive cycle requires an explicit empty memory start")
        if meta_policy is None:
            meta_policy = MetaEvaluationPolicy()
        if isinstance(meta_policy, MetaEvaluationPolicy):
            meta_policy = asdict(meta_policy)
        else:
            try:
                meta_policy = asdict(MetaEvaluationPolicy(
                    **_copy(meta_policy, "Meta policy")))
            except (TypeError, ValueError) as exc:
                raise ContractError(f"Invalid meta-evaluation policy: {str(exc)[:500]}") from None
        if type(offspring_per_arm) is not int or not 1 <= offspring_per_arm <= 16:
            raise ContractError("offspring_per_arm must be between 1 and 16")
        for value, label in ((guard_min_mean_utility, "guard minimum utility"),
                             (guard_min_success_rate, "guard minimum success rate")):
            if type(value) not in {int, float} or not math.isfinite(value):
                raise ContractError(f"{label} must be finite")
        if not 0 <= guard_min_success_rate <= 1:
            raise ContractError("guard minimum success rate must be between zero and one")
        if not isinstance(provider, str) or not provider or not isinstance(model, str) or not model:
            raise ContractError("Provider and model must be nonempty text")

        workload = {
            "development_tasks": development_tasks,
            "selection_tasks": selection_tasks,
            "evaluator": evaluator,
            "development_digest": digest(development_tasks),
            "selection_digest": digest(selection_tasks),
            "evaluator_digest": digest(evaluator),
            "meta_policy": meta_policy,
            "meta_policy_digest": digest(meta_policy),
            "meta_budget": meta_budget,
            "self_generation_budget": self_generation_budget,
            "budget_digest": digest({"self": self_generation_budget, "meta": meta_budget}),
            "offspring_per_arm": offspring_per_arm,
            "provider": provider, "model": model, "memory": memory,
        }
        guard = {
            "tasks": guard_tasks, "task_digest": digest(guard_tasks),
            "evaluator": guard_evaluator,
            "evaluator_digest": digest(guard_evaluator),
            "budget": guard_budget, "budget_digest": digest(guard_budget),
            "min_mean_utility": float(guard_min_mean_utility),
            "min_success_rate": float(guard_min_success_rate),
        }
        now = time.time()
        record = {
            "schema": RECURSIVE_CYCLE_SCHEMA,
            "id": "recursive-cycle-" + uuid.uuid4().hex[:16],
            "revision": 0, "status": "registered",
            "created_at": now, "updated_at": now,
            "channel": channel, "channel_revision": active["revision"],
            "r0_package_id": active["package_id"],
            "r0_package_digest": active["package_digest"],
            "improver_mutation_policy": _copy(active["version"]["mutation_policy"]),
            "improver_mutation_policy_digest": active["mutation_policy_digest"],
            "improver_capability_envelope_digest": active[
                "capability_envelope_digest"],
            "feedback_generation_ids": generation_ids,
            "feedback_decision_ids": decision_ids,
            "feedback_intent_digest": digest({
                "generations": generation_ids, "decisions": decision_ids}),
            "task_agent": task_agent, "task_agent_id": task_agent["id"],
            "task_agent_digest": task_agent["digest"],
            "task_feedback_bundle": task_feedback_bundle,
            "task_feedback_bundle_id": task_feedback_bundle["id"],
            "task_feedback_bundle_digest": task_feedback_bundle["record_digest"],
            "task_channel": task_channel,
            "task_channel_revision": task_channel_revision,
            "task_mutation_policy": task_mutation_policy,
            "task_mutation_policy_digest": digest(task_mutation_policy),
            "workload": workload, "guard": guard,
            "refs": {}, "result": None, "pending_action": None,
            "runner": {"status": "idle", "token": None, "updated_at": now,
                       "last_error": None, "error_type": None},
        }
        encoded, record_digest = self._encode(record), digest(record)
        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("INSERT INTO task_recursive_improver_cycles VALUES(?,?,?,?,?,?)", (
                record["id"], 0, record["status"], encoded, record_digest, now))
            self._append_event(db, record["id"], "cycle_started", {
                "channel": channel, "channel_revision": active["revision"],
                "r0_package_id": active["package_id"],
                "feedback_intent_digest": record["feedback_intent_digest"],
                "task_agent_digest": task_agent["digest"],
                "workload_digest": workload["budget_digest"],
                "guard_digest": guard["task_digest"],
            })
        return {**record, "record_digest": record_digest}

    def _claim(self, cycle_id):
        old = self.get(cycle_id)
        if old["status"] in _TERMINAL:
            return self._finalize_terminal(old), None
        if old.get("pending_action") is not None or old.get("runner", {}).get("status") in {
                "running", "recovery_required"}:
            raise ContractError("Recursive improver cycle requires recover() before resume")
        token = uuid.uuid4().hex
        changed = deepcopy(old)
        changed["runner"] = {"status": "running", "token": token,
                             "updated_at": time.time(), "last_error": None,
                             "error_type": None}
        return self._replace(old, changed, "cycle_claimed", {
            "token_digest": digest(token)}), token

    def _finalize_terminal(self, record):
        runner = record.get("runner") or {}
        if record.get("pending_action") is not None:
            raise ContractError("Terminal recursive cycle retains a pending action")
        if runner.get("status") == "completed" and runner.get("token") is None:
            return record
        changed = deepcopy(record)
        changed["runner"] = {"status": "completed", "token": None,
                             "updated_at": time.time(), "last_error": None,
                             "error_type": None}
        return self._replace(record, changed, "terminal_claim_reconciled", {
            "status": record["status"],
            "previous_runner_status": runner.get("status")})

    def _release(self, cycle_id, token, error=None):
        current = self.get(cycle_id)
        if (current["status"] in _TERMINAL
                and current.get("runner", {}).get("status") == "completed"
                and current.get("runner", {}).get("token") is None
                and current.get("pending_action") is None):
            return current
        if current.get("runner", {}).get("token") != token:
            raise ContractError("Recursive improver cycle runner lost its claim")
        changed = deepcopy(current)
        changed["runner"] = {
            "status": "completed" if current["status"] in _TERMINAL else "paused",
            "token": None, "updated_at": time.time(),
            "last_error": str(error)[:1000] if error else None,
            "error_type": type(error).__name__ if error else None,
        }
        return self._replace(current, changed, "cycle_released", {
            "runner_status": changed["runner"]["status"],
            "error_type": changed["runner"]["error_type"]})

    def _begin_action(self, cycle_id, token):
        current = self.get(cycle_id)
        if current.get("runner", {}).get("token") != token:
            raise ContractError("Recursive improver cycle runner lost its claim")
        if current.get("pending_action") is not None:
            raise ContractError("Recursive improver cycle already has a pending action")
        changed = deepcopy(current)
        started_at = time.time()
        action_id = "recursive-action-" + uuid.uuid4().hex
        nonce = uuid.uuid4().hex
        changed["pending_action"] = {
            "stage": current["status"], "action_id": action_id,
            "nonce": nonce, "started_at": started_at,
        }
        if current["status"] == "feedback_captured":
            changed["pending_action"]["generation_claim_token"] = uuid.uuid4().hex
        changed["pending_action"]["intent_digest"] = digest(
            self._action_intent(current, changed["pending_action"]))
        changed["runner"]["updated_at"] = time.time()
        transaction_hook = None
        if current["status"] == "feedback_captured":
            invocation = self._generation_invocation(changed)
            claim_token = changed["pending_action"]["generation_claim_token"]

            def reserve_invocation(db, _body):
                self.improvers.reserve_generation_invocation(
                    db, invocation, claim_token)

            transaction_hook = reserve_invocation
        return self._replace(current, changed, "cycle_action_started", {
            "stage": current["status"], "action_id": action_id,
            "intent_digest": changed["pending_action"]["intent_digest"]},
            transaction_hook=transaction_hook)

    @staticmethod
    def _action_intent(record, action):
        return {
            "cycle_id": record["id"], "stage": action.get("stage"),
            "action_id": action.get("action_id"), "nonce": action.get("nonce"),
            "started_at": action.get("started_at"), "channel": record["channel"],
            "generation_claim_token_digest": (
                digest(action["generation_claim_token"])
                if action.get("generation_claim_token") is not None else None),
            "expected_revision": record["channel_revision"],
            "r0_package_id": record["r0_package_id"],
            "r0_package_digest": record["r0_package_digest"],
            "feedback_id": record["refs"].get("improver_feedback_id"),
            "self_generation_budget": record["workload"]["self_generation_budget"],
            "mutation_policy_digest": record["improver_mutation_policy_digest"],
            "capability_envelope_digest": record[
                "improver_capability_envelope_digest"],
        }

    @staticmethod
    def _generation_invocation(record):
        action = record.get("pending_action") or {}
        required = ("action_id", "nonce", "started_at", "intent_digest",
                    "generation_claim_token")
        if action.get("stage") != "feedback_captured" or any(
                action.get(key) is None for key in required):
            raise ContractError("Recursive generation action claim is incomplete")
        if action["intent_digest"] != digest(
                RecursiveImproverCycleService._action_intent(record, action)):
            raise ContractError("Recursive generation action intent changed")
        return {
            "schema": "nexgent.recursive-cycle-invocation.v1",
            "cycle_id": record["id"], "action_id": action["action_id"],
            "nonce": action["nonce"], "started_at": action["started_at"],
            "intent_digest": action["intent_digest"],
        }

    def _checkpoint(self, old, status, *, refs=None, result=None, recovery=False):
        if status not in _TRANSITIONS.get(old["status"], frozenset()):
            raise ContractError("Recursive improver cycle transition would skip a mandatory stage")
        changed = deepcopy(old)
        changed["status"] = status
        changed["pending_action"] = None
        if refs:
            changed["refs"].update(_copy(refs, "Recursive cycle evidence references"))
        if result is not None:
            changed["result"] = _copy(result, "Recursive cycle result")
        if status in _TERMINAL:
            changed["runner"] = {
                "status": "completed", "token": None, "updated_at": time.time(),
                "last_error": None, "error_type": None,
            }
        elif recovery:
            changed["runner"] = {
                "status": "paused",
                "token": None, "updated_at": time.time(),
                "last_error": None, "error_type": None,
            }
        else:
            changed["runner"]["updated_at"] = time.time()
        return self._replace(old, changed,
                             "cycle_reconciled" if recovery else "cycle_transitioned", {
                                 "from": old["status"], "to": status,
                                 "reference_keys": sorted((refs or {}).keys())})

    def _advance(self, cycle_id, token, expected, status, *, refs=None, result=None):
        current = self.get(cycle_id)
        if current["status"] != expected:
            raise ContractError(
                f"Recursive improver cycle expected {expected}, found {current['status']}")
        if current.get("runner", {}).get("token") != token:
            raise ContractError("Recursive improver cycle runner lost its claim")
        return self._checkpoint(current, status, refs=refs, result=result)

    def _step(self, record, token, stop_event):
        status, refs = record["status"], record["refs"]
        if status == "registered":
            feedback = self.improvers.capture_feedback(
                record["channel"], record["feedback_generation_ids"],
                record["feedback_decision_ids"], record["channel_revision"])
            return self._advance(record["id"], token, status, "feedback_captured",
                                 refs={"improver_feedback_id": feedback["id"]})
        if status == "feedback_captured":
            generation = self.improvers.generate_candidate(
                record["channel"], refs["improver_feedback_id"],
                record["channel_revision"],
                budget=record["workload"]["self_generation_budget"],
                stop_event=stop_event,
                invocation=self._generation_invocation(record),
                invocation_claim_token=record["pending_action"].get(
                    "generation_claim_token"),
                admission_check=lambda _admission: self._verify_action_admission(record))
            generation_refs = {"improver_generation_id": generation["id"]}
            if generation["status"] != "generated":
                return self._advance(
                    record["id"], token, status, "generation_missing",
                    refs=generation_refs,
                    result={"outcome": "generation_missing"})
            generation_refs["candidate_id"] = generation["candidate_id"]
            generation_refs["r1_package_id"] = generation["candidate_package_id"]
            generation_refs["r1_package_digest"] = generation["candidate_package_digest"]
            return self._advance(record["id"], token, status, "generated",
                                 refs=generation_refs)
        if status == "generated":
            candidate = self.improvers.candidate(refs["candidate_id"])
            plan = self.meta.create_plan(
                candidate_id=candidate["id"], channel=record["channel"],
                channel_revision=record["channel_revision"],
                task_agent=record["task_agent"],
                feedback_bundle=record["task_feedback_bundle"],
                task_channel=record["task_channel"],
                task_channel_revision=record["task_channel_revision"],
                task_mutation_policy=record["task_mutation_policy"],
                improvers={
                    "R0": {"id": record["r0_package_id"],
                           "digest": record["r0_package_digest"]},
                    "R1": {"id": candidate["package_id"],
                           "digest": candidate["package_digest"]},
                },
                provider=record["workload"]["provider"],
                model=record["workload"]["model"],
                outer_budget=record["workload"]["meta_budget"],
                memory=record["workload"]["memory"],
                development_tasks=record["workload"]["development_tasks"],
                selection_tasks=record["workload"]["selection_tasks"],
                evaluator=record["workload"]["evaluator"],
                offspring_per_arm=record["workload"]["offspring_per_arm"],
                policy=record["workload"]["meta_policy"])
            return self._advance(record["id"], token, status, "meta_planned",
                                 refs={"meta_plan_id": plan["id"]})
        if status == "meta_planned":
            trial = self.meta.run(
                refs["meta_plan_id"],
                admission_check=lambda _admission: self._verify_action_admission(record))
            return self._advance(record["id"], token, status, "meta_run",
                                 refs={"meta_trial_id": trial["id"]})
        if status == "meta_run":
            assessment = self.meta.assess(refs["meta_trial_id"])
            return self._advance(record["id"], token, status, "meta_assessed",
                                 refs={"meta_evaluation_id": assessment["id"]})
        if status == "meta_assessed":
            decision = self.improvers.record_decision(
                refs["candidate_id"], refs["meta_evaluation_id"])
            return self._advance(record["id"], token, status, "decision_recorded",
                                 refs={"improver_decision_id": decision["id"]})
        if status == "decision_recorded":
            decision = self.improvers.decision(refs["improver_decision_id"])
            if decision["eligible"] is not True:
                return self._advance(
                    record["id"], token, status, "rejected",
                    result={"outcome": "rejected",
                            "meta_evaluation_id": refs["meta_evaluation_id"]})
            guard = record["guard"]
            plan = self.guards.create_plan(
                candidate_id=refs["candidate_id"], task_agent=record["task_agent"],
                feedback_bundle=record["task_feedback_bundle"],
                task_channel=record["task_channel"],
                task_channel_revision=record["task_channel_revision"],
                task_mutation_policy=record["task_mutation_policy"],
                provider=record["workload"]["provider"],
                model=record["workload"]["model"],
                outer_budget=guard["budget"], memory=record["workload"]["memory"],
                guard_tasks=guard["tasks"], evaluator=guard["evaluator"],
                min_mean_utility=guard["min_mean_utility"],
                min_success_rate=guard["min_success_rate"])
            return self._advance(record["id"], token, status, "guard_planned",
                                 refs={"guard_plan_id": plan["id"]})
        if status == "guard_planned":
            promoted = self.improvers.promote(
                refs["candidate_id"], refs["improver_decision_id"],
                record["channel_revision"], guard_plan_id=refs["guard_plan_id"])
            return self._advance(
                record["id"], token, status, "promoted",
                refs={"promoted_revision": promoted["revision"],
                      "promoted_package_id": promoted["package_id"]})
        if status == "promoted":
            action = self.guards.run(
                refs["guard_plan_id"],
                admission_check=lambda _admission: self._verify_action_admission(record))
            final = "rolled_back" if action["rolled_back"] else "completed"
            return self._advance(
                record["id"], token, status, final,
                refs={"guard_action_id": action["id"],
                      "guard_run_id": action["run_id"]},
                result={"outcome": final, "degraded": action["degraded"],
                        "rolled_back": action["rolled_back"],
                        "active_revision": action["active_revision_after"],
                        "active_package_id": action["active_package_id_after"],
                        "active_package_digest": action["active_package_digest_after"]})
        raise ContractError(f"Unsupported recursive cycle state: {status}")

    def _verify_frozen_pointers(self, record):
        task_active = active_package_registration(self.store, record["task_channel"])
        if (task_active["revision"] != record["task_channel_revision"]
                or task_active["package_id"] != record["task_agent_id"]
                or task_active["package_digest"] != record["task_agent_digest"]):
            raise ContractError("Recursive cycle common TaskAgent A0 changed")
        active = self.improvers.active(record["channel"])
        if record["status"] == "promoted":
            expected = (record["refs"].get("promoted_revision"),
                        record["refs"].get("r1_package_id"),
                        record["refs"].get("r1_package_digest"))
        else:
            expected = (record["channel_revision"], record["r0_package_id"],
                        record["r0_package_digest"])
        if (active["revision"], active["package_id"], active["package_digest"]) != expected:
            raise ContractError("Recursive cycle improver channel changed")

    def _verify_action_admission(self, claimed):
        current = self.get(claimed["id"])
        if (current.get("pending_action") != claimed.get("pending_action")
                or current.get("runner", {}).get("token")
                != claimed.get("runner", {}).get("token")):
            raise AdmissionConflict(
                "Recursive cycle action claim changed before admission")
        try:
            self._verify_frozen_pointers(current)
        except ContractError as exc:
            raise AdmissionConflict(str(exc)) from None

    def resume(self, cycle_id, *, stop_event=None, max_steps=None):
        """Run from the latest durable checkpoint through completion or a step bound."""
        if max_steps is not None and (type(max_steps) is not int or max_steps < 1):
            raise ValueError("max_steps must be a positive integer")
        record, token = self._claim(cycle_id)
        if token is None:
            return record
        steps = 0
        try:
            while record["status"] not in _TERMINAL:
                if max_steps is not None and steps >= max_steps:
                    break
                self._verify_frozen_pointers(record)
                record = self._begin_action(cycle_id, token)
                record = self._step(record, token, stop_event)
                steps += 1
        except Exception as exc:
            self._release(cycle_id, token, error=exc)
            raise
        return self._release(cycle_id, token)

    def _table_records(self, table):
        with self.store.connect() as db:
            rows = db.execute(f"SELECT data,digest FROM {table} ORDER BY rowid").fetchall()
        result = []
        for data, record_digest in rows:
            record = json.loads(data)
            if digest(record) != record_digest:
                raise ContractError(f"Immutable evidence digest mismatch in {table}")
            result.append({**record, "record_digest": record_digest})
        return result

    def _find_feedback(self, record):
        for item in self._table_records("task_improver_feedback"):
            if (item.get("channel") == record["channel"]
                    and item.get("channel_revision") == record["channel_revision"]
                    and item.get("parent_improver_id") == record["r0_package_id"]
                    and item.get("parent_improver_digest") == record["r0_package_digest"]
                    and [row.get("id") for row in item.get("task_generations", [])]
                    == record["feedback_generation_ids"]
                    and [row.get("id") for row in item.get("task_decisions", [])]
                    == record["feedback_decision_ids"]):
                return item
        return None

    def _find_generation(self, record):
        feedback_id = record["refs"].get("improver_feedback_id")
        invocation = self._generation_invocation(record)
        expected_budget = record["workload"]["self_generation_budget"]
        item = self.improvers.generation_for_invocation(invocation)
        if item is None:
            return None
        if not (item.get("channel") == record["channel"]
                and item.get("channel_revision") == record["channel_revision"]
                and item.get("parent_improver_id") == record["r0_package_id"]
                and item.get("parent_improver_digest") == record["r0_package_digest"]
                and item.get("feedback_id") == feedback_id
                and item.get("outer_budget") == expected_budget
                and item.get("outer_budget_digest") == digest(expected_budget)
                and item.get("mutation_policy_digest")
                == record["improver_mutation_policy_digest"]
                and item.get("capability_envelope_digest")
                == record["improver_capability_envelope_digest"]
                and item.get("created_at", 0) >= invocation["started_at"]
                and item.get("status") in {"generated", "missing"}):
            raise ContractError(
                "Recursive generation claim terminal evidence violates its frozen intent")
        return item

    def _plan_matches(self, plan, record):
        refs, workload = record["refs"], record["workload"]
        return (
            plan.get("candidate_id") == refs.get("candidate_id")
            and plan.get("channel") == record["channel"]
            and plan.get("channel_revision") == record["channel_revision"]
            and plan.get("improvers") == {
                "R0": {"id": record["r0_package_id"],
                       "digest": record["r0_package_digest"]},
                "R1": {"id": refs.get("r1_package_id"),
                       "digest": refs.get("r1_package_digest")}}
            and plan.get("task_agent", {}).get("digest") == record["task_agent_digest"]
            and plan.get("feedback_bundle", {}).get("id") == record["task_feedback_bundle_id"]
            and plan.get("task_channel") == record["task_channel"]
            and plan.get("task_channel_revision") == record["task_channel_revision"]
            and plan.get("task_mutation_policy") == record["task_mutation_policy"]
            and plan.get("provider") == workload["provider"]
            and plan.get("model") == workload["model"]
            and plan.get("outer_budget") == workload["meta_budget"]
            and plan.get("memory") == workload["memory"]
            and plan.get("development_tasks") == workload["development_tasks"]
            and plan.get("selection_tasks") == workload["selection_tasks"]
            and plan.get("evaluator") == workload["evaluator"]
            and plan.get("offspring_per_arm") == workload["offspring_per_arm"]
            and plan.get("policy") == workload["meta_policy"])

    def _find_meta_plan(self, record):
        return next((item for item in self._table_records("task_improver_meta_plans")
                     if self._plan_matches(item, record)), None)

    def _find_meta_trial(self, record):
        plan_id = record["refs"].get("meta_plan_id")
        with self.store.connect() as db:
            claim = db.execute(
                "SELECT status,trial_id FROM task_improver_meta_run_claims WHERE plan_id=?",
                (plan_id,)).fetchone()
        if claim and claim[0] == "completed" and claim[1]:
            return self.meta.trial(claim[1])
        trials = [item for item in self._table_records("task_improver_meta_trials")
                  if item.get("plan_id") == plan_id]
        if len(trials) == 1:
            trial = self.meta.trial(trials[0]["id"])
            if claim and claim[0] == "running" and claim[1] is None:
                self.meta._finish(plan_id, trial["id"])
            return trial
        return None

    def _find_meta_evaluation(self, record):
        trial_id = record["refs"].get("meta_trial_id")
        return next((item for item in self._table_records("task_improver_meta_evaluations")
                     if item.get("trial_id") == trial_id
                     and item.get("candidate_id") == record["refs"].get("candidate_id")), None)

    def _find_decision(self, record):
        return next((item for item in self._table_records("task_improver_decisions")
                     if item.get("candidate_id") == record["refs"].get("candidate_id")
                     and item.get("meta_evaluation_id")
                     == record["refs"].get("meta_evaluation_id")), None)

    def _find_guard_plan(self, record):
        guard = record["guard"]
        for item in self._table_records("task_improver_guard_plans"):
            if (item.get("candidate_id") == record["refs"].get("candidate_id")
                    and item.get("channel") == record["channel"]
                    and item.get("pre_promotion_revision") == record["channel_revision"]
                    and item.get("candidate_improver_id")
                    == record["refs"].get("r1_package_id")
                    and item.get("candidate_improver_digest")
                    == record["refs"].get("r1_package_digest")
                    and item.get("task_agent", {}).get("digest") == record["task_agent_digest"]
                    and item.get("feedback_bundle", {}).get("id")
                    == record["task_feedback_bundle_id"]
                    and item.get("task_channel") == record["task_channel"]
                    and item.get("task_channel_revision") == record["task_channel_revision"]
                    and item.get("task_mutation_policy") == record["task_mutation_policy"]
                    and item.get("provider") == record["workload"]["provider"]
                    and item.get("model") == record["workload"]["model"]
                    and item.get("memory") == record["workload"]["memory"]
                    and item.get("outer_budget") == guard["budget"]
                    and item.get("guard_tasks") == guard["tasks"]
                    and item.get("evaluator") == guard["evaluator"]
                    and item.get("min_mean_utility") == guard["min_mean_utility"]
                    and item.get("min_success_rate") == guard["min_success_rate"]):
                return item
        return None

    def _find_promotion(self, record):
        active = self.improvers.active(record["channel"])
        promotion = active.get("promotion") or {}
        if (active["revision"] == record["channel_revision"] + 1
                and active["package_id"] == record["refs"].get("r1_package_id")
                and active["package_digest"] == record["refs"].get("r1_package_digest")
                and promotion.get("candidate_id") == record["refs"].get("candidate_id")
                and promotion.get("decision_id") == record["refs"].get("improver_decision_id")
                and promotion.get("guard_plan_id") == record["refs"].get("guard_plan_id")):
            return active
        return None

    def _find_guard_action(self, record):
        plan_id = record["refs"].get("guard_plan_id")
        with self.store.connect() as db:
            claim = db.execute(
                "SELECT status,action_id FROM task_improver_guard_claims WHERE plan_id=?",
                (plan_id,)).fetchone()
        if claim and claim[0] == "completed" and claim[1]:
            return self.guards.action(claim[1])
        return None

    def _reconcile(self, record):
        status = record["status"]
        if status == "registered":
            feedback = self._find_feedback(record)
            return (("feedback_captured", {"improver_feedback_id": feedback["id"]}, None)
                    if feedback else None)
        if status == "feedback_captured":
            generation = self._find_generation(record)
            if not generation:
                return None
            refs = {"improver_generation_id": generation["id"]}
            if generation["status"] != "generated":
                return "generation_missing", refs, {"outcome": "generation_missing"}
            refs.update(candidate_id=generation["candidate_id"],
                        r1_package_id=generation["candidate_package_id"],
                        r1_package_digest=generation["candidate_package_digest"])
            return "generated", refs, None
        if status == "generated":
            plan = self._find_meta_plan(record)
            return ("meta_planned", {"meta_plan_id": plan["id"]}, None) if plan else None
        if status == "meta_planned":
            trial = self._find_meta_trial(record)
            return ("meta_run", {"meta_trial_id": trial["id"]}, None) if trial else None
        if status == "meta_run":
            assessment = self._find_meta_evaluation(record)
            return (("meta_assessed", {"meta_evaluation_id": assessment["id"]}, None)
                    if assessment else None)
        if status == "meta_assessed":
            decision = self._find_decision(record)
            return (("decision_recorded", {"improver_decision_id": decision["id"]}, None)
                    if decision else None)
        if status == "decision_recorded":
            decision = self.improvers.decision(record["refs"]["improver_decision_id"])
            if decision["eligible"] is not True:
                return "rejected", {}, {"outcome": "rejected",
                                        "meta_evaluation_id": record["refs"]["meta_evaluation_id"]}
            plan = self._find_guard_plan(record)
            return ("guard_planned", {"guard_plan_id": plan["id"]}, None) if plan else None
        if status == "guard_planned":
            active = self._find_promotion(record)
            return (("promoted", {"promoted_revision": active["revision"],
                                  "promoted_package_id": active["package_id"]}, None)
                    if active else None)
        if status == "promoted":
            action = self._find_guard_action(record)
            if not action:
                return None
            final = "rolled_back" if action["rolled_back"] else "completed"
            return final, {"guard_action_id": action["id"],
                           "guard_run_id": action["run_id"]}, {
                               "outcome": final, "degraded": action["degraded"],
                               "rolled_back": action["rolled_back"],
                               "active_revision": action["active_revision_after"],
                               "active_package_id": action["active_package_id_after"],
                               "active_package_digest": action["active_package_digest_after"]}
        return None

    def _discard_uncommitted_claim(self, record):
        if record["status"] == "meta_planned":
            plan_id = record["refs"].get("meta_plan_id")
            with self.store.connect() as db:
                db.execute("BEGIN IMMEDIATE")
                trials = db.execute(
                    "SELECT 1 FROM task_improver_meta_trials "
                    "WHERE json_extract(data,'$.plan_id')=?",
                    (plan_id,)).fetchone()
                if trials is None:
                    db.execute(
                        "DELETE FROM task_improver_meta_run_claims WHERE plan_id=? "
                        "AND status='running' AND trial_id IS NULL", (plan_id,))
        if record["status"] == "promoted":
            plan_id = record["refs"].get("guard_plan_id")
            with self.store.connect() as db:
                db.execute("BEGIN IMMEDIATE")
                action = db.execute(
                    "SELECT 1 FROM task_improver_guard_actions "
                    "WHERE json_extract(data,'$.plan_id')=?", (plan_id,)).fetchone()
                if action is None:
                    db.execute(
                        "DELETE FROM task_improver_guard_claims WHERE plan_id=? "
                        "AND status='running' AND action_id IS NULL", (plan_id,))

    def recover(self, cycle_id, *, confirm_no_external_commit=False):
        """Reconcile a terminal action, or explicitly release an uncommitted action."""
        if type(confirm_no_external_commit) is not bool:
            raise TypeError("confirm_no_external_commit must be boolean")
        old = self.get(cycle_id)
        if old["status"] in _TERMINAL:
            return self._finalize_terminal(old)
        pending = old.get("pending_action")
        if pending is None:
            changed = deepcopy(old)
            changed["runner"] = {"status": "paused", "token": None,
                                 "updated_at": time.time(), "last_error": None,
                                 "error_type": None}
            return self._replace(old, changed, "cycle_recovered", {"stage": None})
        reconciled = self._reconcile(old)
        if reconciled is not None:
            status, refs, result = reconciled
            return self._checkpoint(
                old, status, refs=refs, result=result, recovery=True)
        changed = deepcopy(old)
        if confirm_no_external_commit:
            self._discard_uncommitted_claim(old)
            changed["pending_action"] = None
            changed["runner"] = {"status": "paused", "token": None,
                                 "updated_at": time.time(), "last_error": None,
                                 "error_type": None}
            return self._replace(old, changed, "cycle_recovered", {
                "stage": pending.get("stage"), "external_commit_excluded": True})
        changed["runner"] = {"status": "recovery_required", "token": None,
                             "updated_at": time.time(), "last_error": None,
                             "error_type": "UncertainExternalCommit"}
        return self._replace(old, changed, "cycle_recovery_required", {
            "stage": pending.get("stage")})
