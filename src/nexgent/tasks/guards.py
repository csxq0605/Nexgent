"""One-shot downstream-utility guards for deployed recursive improvers."""

from __future__ import annotations

from copy import deepcopy
import json
import math
import time

from ..kernel.programs import digest
from .meta_evaluation import (
    EVALUATION_RECEIPT_SCHEMA,
    GENERATION_RECEIPT_SCHEMA,
    TaskMetaExecutor,
    _USAGE_KEYS,
    _LIMIT_KEYS,
    _copy,
    _id,
)
from .packages import verify_package
from .tools import ContractError


GUARD_PLAN_SCHEMA = "nexgent.improver-guard-plan.v1"
GUARD_RUN_SCHEMA = "nexgent.improver-guard-run.v1"
GUARD_ACTION_SCHEMA = "nexgent.improver-guard-action.v1"
# Longer than the maximum single package wall-time (currently 1,200 s).  The
# executor refreshes the lease between every generation/evaluation step.
GUARD_CLAIM_LEASE_SECONDS = 3600


class ImproverGuardService:
    """Pre-register, execute, and enforce a deployed-R rollback guard.

    A guard measures the utility of a task-agent descendant produced through
    the deployed improver channel.  Missing evidence fails closed and rolls the
    channel back along its recorded deployment edge.
    """

    def __init__(self, improver_service, generate_offspring, evaluate_descendant):
        if not callable(generate_offspring) or not callable(evaluate_descendant):
            raise TypeError("Guard executors must be callable host authorities")
        generator_owner = getattr(generate_offspring, "__self__", None)
        evaluator_owner = getattr(evaluate_descendant, "__self__", None)
        if (generator_owner is None or generator_owner is not evaluator_owner
                or generator_owner.__class__ is not TaskMetaExecutor
                or generator_owner.tasks.store is not improver_service.store):
            raise TypeError("Improver guard requires one trusted TaskMetaExecutor")
        self.improvers = improver_service
        self.store = improver_service.store
        self._executor = generator_owner
        with self.store.connect() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS task_improver_guard_plans(
                    id TEXT PRIMARY KEY, data TEXT NOT NULL, digest TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS task_improver_guard_runs(
                    id TEXT PRIMARY KEY, data TEXT NOT NULL, digest TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS task_improver_guard_actions(
                    id TEXT PRIMARY KEY, data TEXT NOT NULL, digest TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS task_improver_guard_claims(
                    plan_id TEXT PRIMARY KEY, status TEXT NOT NULL, action_id TEXT,
                    created REAL NOT NULL, updated REAL NOT NULL);
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
                raise ContractError("Cannot overwrite immutable improver guard evidence")
            db.execute(f"INSERT OR IGNORE INTO {table} VALUES(?,?,?)",
                       (record["id"], encoded, record_digest))
        result = deepcopy(record)
        result["record_digest"] = record_digest
        return result

    def _get(self, table, identity):
        with self.store.connect() as db:
            row = db.execute(
                f"SELECT data,digest FROM {table} WHERE id=?", (identity,)).fetchone()
        if row is None:
            raise KeyError(identity)
        record = json.loads(row[0])
        if digest(record) != row[1]:
            raise ContractError("Improver guard evidence digest mismatch")
        record["record_digest"] = row[1]
        return record

    def plan(self, plan_id):
        return self._get("task_improver_guard_plans", plan_id)

    def run_record(self, run_id):
        return self._get("task_improver_guard_runs", run_id)

    def action(self, action_id):
        return self._get("task_improver_guard_actions", action_id)

    @staticmethod
    def _budget(value):
        expected = set(_LIMIT_KEYS.values())
        if not isinstance(value, dict) or set(value) != expected:
            raise ContractError("Guard budget must freeze every supported resource limit")
        if any(type(value[key]) is not int or value[key] < 0 for key in expected):
            raise ContractError("Guard budget limits must be nonnegative integers")
        return {key: value[key] for key in sorted(expected)}

    def create_plan(self, *, candidate_id, task_agent, feedback_bundle,
                    task_channel, task_channel_revision, task_mutation_policy,
                    provider, model, outer_budget, memory, guard_tasks, evaluator,
                    min_mean_utility, min_success_rate=1.0):
        """Freeze a guard before the candidate is eligible for promotion."""
        candidate = self.improvers.candidate(candidate_id)
        self.improvers._verify_generation(candidate)
        task_agent = _copy(task_agent, "Guard TaskAgent")
        verify_package(task_agent)
        feedback_bundle = _copy(feedback_bundle, "Guard FeedbackBundle")
        try:
            stored_feedback = self._get(
                "task_feedback_bundles", feedback_bundle.get("id"))
        except KeyError:
            raise ContractError("Guard FeedbackBundle is not local immutable evidence") from None
        if stored_feedback != feedback_bundle:
            raise ContractError("Guard FeedbackBundle differs from its local immutable record")
        if (feedback_bundle.get("channel") != task_channel
                or feedback_bundle.get("channel_revision") != task_channel_revision
                or feedback_bundle.get("parent_package_id") != task_agent["id"]
                or feedback_bundle.get("parent_package_digest") != task_agent["digest"]):
            raise ContractError("Guard feedback does not bind the frozen TaskAgent start")
        task_mutation_policy = _copy(task_mutation_policy, "Guard mutation policy")
        if not isinstance(task_mutation_policy, dict) or not task_mutation_policy:
            raise ContractError("Guard mutation policy must be a nonempty object")
        guard_tasks = _copy(guard_tasks, "Guard tasks")
        if (not isinstance(guard_tasks, list) or not guard_tasks or len(guard_tasks) > 256
                or any(not isinstance(task, dict) for task in guard_tasks)):
            raise ContractError("Guard tasks must be a nonempty bounded list")
        task_digests = [digest(task) for task in guard_tasks]
        if len(set(task_digests)) != len(task_digests):
            raise ContractError("Guard tasks must have unique content digests")
        evaluator = _copy(evaluator, "Guard evaluator")
        if not isinstance(evaluator, dict) or not evaluator:
            raise ContractError("Guard evaluator descriptor must be nonempty")
        for value, label in ((min_mean_utility, "minimum utility"),
                             (min_success_rate, "minimum success rate")):
            if type(value) not in {int, float} or not math.isfinite(value):
                raise ContractError(f"Guard {label} must be finite")
        if not 0 <= min_success_rate <= 1:
            raise ContractError("Guard minimum success rate must be between zero and one")
        outer_budget = self._budget(outer_budget)
        memory = _copy(memory, "Guard memory")
        if memory != {"kind": "empty"}:
            raise ContractError("Improver guards currently require an explicit empty memory start")
        active = self.improvers.active(candidate["channel"])
        if (active["revision"] != candidate["channel_revision"]
                or active["package_id"] != candidate["parent_improver_id"]):
            raise ContractError("Guard candidate parent is no longer active")
        from .evolution import active_package_registration
        active_task = active_package_registration(self.store, task_channel)
        if (active_task["revision"] != task_channel_revision
                or active_task["package_id"] != task_agent["id"]
                or active_task["package_digest"] != task_agent["digest"]):
            raise ContractError("Guard TaskAgent start is not the active task channel revision")
        improver = {"id": candidate["package_id"], "digest": candidate["package_digest"]}
        shared = {
            "candidate_id": candidate_id,
            "task_agent_digest": task_agent["digest"],
            "feedback_digest": digest(feedback_bundle),
            "task_channel": task_channel,
            "task_channel_revision": task_channel_revision,
            "task_mutation_policy_digest": digest(task_mutation_policy),
            "improver_channel": candidate["channel"],
            "expected_deployed_revision": candidate["channel_revision"] + 1,
            "candidate_improver_digest": candidate["package_digest"],
            "task_multiset_digest": digest(task_digests),
            "evaluator_digest": digest(evaluator),
            "memory_digest": digest(memory),
            "provider": provider, "model": model,
        }
        record = {
            "schema": GUARD_PLAN_SCHEMA, "id": _id("improver-guard-plan"),
            "created_at": time.time(), "status": "ready",
            "candidate_id": candidate_id, "channel": candidate["channel"],
            "pre_promotion_revision": candidate["channel_revision"],
            "expected_deployed_revision": candidate["channel_revision"] + 1,
            "parent_improver_id": candidate["parent_improver_id"],
            "parent_improver_digest": candidate["parent_improver_digest"],
            "candidate_improver_id": candidate["package_id"],
            "candidate_improver_digest": candidate["package_digest"],
            "task_agent": task_agent, "feedback_bundle": feedback_bundle,
            "task_channel": task_channel, "task_channel_revision": task_channel_revision,
            "task_mutation_policy": task_mutation_policy,
            "provider": provider, "model": model, "outer_budget": outer_budget,
            "memory": memory, "guard_tasks": guard_tasks,
            "task_digests": task_digests, "evaluator": evaluator,
            "min_mean_utility": float(min_mean_utility),
            "min_success_rate": float(min_success_rate), "shared_binding": shared,
        }
        record["protocol_digest"] = digest({
            "shared": shared, "budget": outer_budget,
            "thresholds": [record["min_mean_utility"], record["min_success_rate"]],
        })
        stored = self._insert("task_improver_guard_plans", record)
        self.improvers._event(candidate["channel"], "improver_guard_planned", {
            "guard_plan_id": stored["id"], "candidate_id": candidate_id,
            "expected_deployed_revision": record["expected_deployed_revision"],
            "protocol_digest": record["protocol_digest"],
            "record_digest": stored["record_digest"],
        })
        return stored

    def _claim(self, plan_id):
        now = time.time()
        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                "SELECT status,action_id FROM task_improver_guard_claims WHERE plan_id=?",
                (plan_id,)).fetchone()
            if row:
                if row[0] == "completed" and row[1]:
                    return row[1]
                raise ContractError("Improver guard plan is already claimed")
            db.execute("INSERT INTO task_improver_guard_claims VALUES(?,?,?,?,?)",
                       (plan_id, "running", None, now, now))
        return None

    def _heartbeat(self, plan_id):
        with self.store.connect() as db:
            changed = db.execute(
                "UPDATE task_improver_guard_claims SET updated=? "
                "WHERE plan_id=? AND status='running' AND action_id IS NULL",
                (time.time(), plan_id)).rowcount
        if changed != 1:
            raise ContractError("Improver guard claim changed during execution")

    def _finish(self, plan_id, action_id):
        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            changed = db.execute(
                "UPDATE task_improver_guard_claims SET status='completed',action_id=?,updated=? "
                "WHERE plan_id=? AND status='running' AND action_id IS NULL",
                (action_id, time.time(), plan_id)).rowcount
            if changed != 1:
                raise ContractError("Improver guard claim changed before completion")

    def _trusted_executor(self):
        executor = self._executor
        if (executor.__class__ is not TaskMetaExecutor
                or executor.tasks.store is not self.store):
            raise ContractError("Improver guard executor authority changed")
        return executor

    @staticmethod
    def _insert_tx(db, table, record):
        encoded = json.dumps(record, ensure_ascii=False, sort_keys=True,
                             separators=(",", ":"), allow_nan=False)
        record_digest = digest(record)
        previous = db.execute(
            f"SELECT data,digest FROM {table} WHERE id=?", (record["id"],)).fetchone()
        if previous and previous != (encoded, record_digest):
            raise ContractError("Cannot overwrite immutable improver guard evidence")
        db.execute(f"INSERT OR IGNORE INTO {table} VALUES(?,?,?)",
                   (record["id"], encoded, record_digest))
        result = deepcopy(record)
        result["record_digest"] = record_digest
        return result

    def _complete(self, plan, run_record, *, stale_before=None):
        """Atomically persist the run, enforce rollback, and close the claim."""
        channel = plan["channel"]
        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            claim = db.execute(
                "SELECT status,action_id,updated FROM task_improver_guard_claims WHERE plan_id=?",
                (plan["id"],)).fetchone()
            if claim and claim[0] == "completed" and claim[1]:
                existing_action_id = claim[1]
            else:
                existing_action_id = None
                if claim is None or claim[0:2] != ("running", None):
                    raise ContractError("Improver guard claim is not executable")
                if stale_before is not None and claim[2] > stale_before:
                    raise ContractError("Improver guard lease was refreshed before recovery")
                row = db.execute(
                    "SELECT package_id,revision,data FROM task_improver_channels WHERE name=?",
                    (channel,)).fetchone()
                if row is None:
                    raise ContractError("Improver channel disappeared during guard enforcement")
                active = json.loads(row[2])
                if (row[0] != active.get("package_id") or row[1] != active.get("revision")
                        or active.get("revision") != plan["expected_deployed_revision"]
                        or active.get("package_id") != plan["candidate_improver_id"]
                        or active.get("package_digest") != plan["candidate_improver_digest"]
                        or (active.get("promotion") or {}).get("guard_plan_id") != plan["id"]):
                    raise ContractError("Guard deployment changed before atomic enforcement")

                run = self._insert_tx(db, "task_improver_guard_runs", run_record)
                rollback_state = None
                if run["degraded"]:
                    stack = deepcopy(active.get("deployment_stack") or [])
                    if not stack:
                        raise ContractError("Degraded improver has no deployment edge to roll back")
                    target = stack.pop()
                    rollback_state = {
                        "channel": channel,
                        "package_id": target["package_id"],
                        "package_digest": target["package_digest"],
                        "revision": active["revision"] + 1,
                        "mutation_policy_digest": active["mutation_policy_digest"],
                        "capability_envelope_digest": active["capability_envelope_digest"],
                        "promotion": deepcopy(target.get("promotion")),
                        "deployment_stack": stack, "updated_at": time.time(),
                    }
                    changed = db.execute(
                        "UPDATE task_improver_channels SET package_id=?,revision=?,data=? "
                        "WHERE name=? AND package_id=? AND revision=?",
                        (rollback_state["package_id"], rollback_state["revision"],
                         self.improvers._encode(rollback_state), channel,
                         active["package_id"], active["revision"])).rowcount
                    if changed != 1:
                        raise ContractError("Improver channel changed during guard rollback")
                    self.improvers._append_event(db, channel, "improver_rolled_back", {
                        "from_package_id": active["package_id"],
                        "to_package_id": rollback_state["package_id"],
                        "reason": "pre-registered downstream improver guard failed",
                        "evidence": {"guard_plan_id": plan["id"],
                                     "guard_run_id": run["id"],
                                     "guard_run_digest": run["record_digest"]},
                        "revision": rollback_state["revision"],
                    })
                after = rollback_state or active
                action_record = {
                    "schema": GUARD_ACTION_SCHEMA,
                    "id": "improver-guard-action-" + digest(
                        {"plan": plan["id"], "run": run["id"]})[:24],
                    "created_at": time.time(), "plan_id": plan["id"],
                    "run_id": run["id"], "run_digest": run["record_digest"],
                    "degraded": run["degraded"],
                    "rolled_back": rollback_state is not None,
                    "active_revision_after": after["revision"],
                    "active_package_id_after": after["package_id"],
                    "active_package_digest_after": after["package_digest"],
                }
                action = self._insert_tx(
                    db, "task_improver_guard_actions", action_record)
                self.improvers._append_event(db, channel, "improver_guard_enforced", {
                    "guard_plan_id": plan["id"], "guard_run_id": run["id"],
                    "guard_action_id": action["id"], "degraded": run["degraded"],
                    "rolled_back": rollback_state is not None,
                    "active_revision_after": action["active_revision_after"],
                    "record_digest": action["record_digest"],
                })
                changed = db.execute(
                    "UPDATE task_improver_guard_claims SET status='completed',action_id=?,updated=? "
                    "WHERE plan_id=? AND status='running' AND action_id IS NULL",
                    (action["id"], time.time(), plan["id"])).rowcount
                if changed != 1:
                    raise ContractError("Improver guard claim changed before completion")
                return action
        return self.action(existing_action_id)

    def _recover_stale_claim(self, plan, updated):
        if time.time() - updated < GUARD_CLAIM_LEASE_SECONDS:
            raise ContractError("Improver guard plan is already claimed")
        failure = {
            "phase": "recovery", "error_type": "GuardLeaseExpired",
            "message": "Previous guard execution ended without durable completion",
        }
        run = {
            "schema": GUARD_RUN_SCHEMA, "id": _id("improver-guard-run"),
            "created_at": time.time(), "plan_id": plan["id"],
            "plan_digest": plan["record_digest"],
            "protocol_digest": plan["protocol_digest"],
            "measurement_complete": False, "generation": None, "rows": [],
            "usage": {**{key: 0 for key in _USAGE_KEYS}, "usage_complete": False},
            "mean_utility": None, "success_rate": None,
            "passed": False, "degraded": True, "failures": [failure],
        }
        return self._complete(
            plan, run, stale_before=time.time() - GUARD_CLAIM_LEASE_SECONDS)

    @staticmethod
    def _receipt_usage(receipt):
        usage = receipt.get("usage") if isinstance(receipt, dict) else None
        if not isinstance(usage, dict) or usage.get("usage_complete") is not True:
            raise ContractError("Guard executor usage is incomplete")
        result = {key: usage.get(key) for key in _USAGE_KEYS}
        if any(type(value) is not int or value < 0 for value in result.values()):
            raise ContractError("Guard executor usage is invalid")
        return result

    @staticmethod
    def _add_usage(total, delta, plan):
        for key in _USAGE_KEYS:
            total[key] += delta[key]
            if total[key] > plan["outer_budget"][_LIMIT_KEYS[key]]:
                raise ContractError(f"Guard {key} budget exceeded")

    @staticmethod
    def _remaining(plan, total):
        return {_LIMIT_KEYS[key]: plan["outer_budget"][_LIMIT_KEYS[key]] - total[key]
                for key in _USAGE_KEYS}

    def run(self, plan_id):
        """Consume the guard once and roll back automatically on degradation."""
        plan = self.plan(plan_id)
        with self.store.connect() as db:
            existing = db.execute(
                "SELECT status,action_id,updated FROM task_improver_guard_claims WHERE plan_id=?",
                (plan_id,)).fetchone()
        if existing:
            if existing[0] == "completed" and existing[1]:
                return self.action(existing[1])
            if existing[0] == "running" and existing[1] is None:
                return self._recover_stale_claim(plan, existing[2])
            raise ContractError("Improver guard claim is invalid")
        active = self.improvers.active(plan["channel"])
        if (active["revision"] != plan["expected_deployed_revision"]
                or active["package_id"] != plan["candidate_improver_id"]
                or active["package_digest"] != plan["candidate_improver_digest"]
                or (active.get("promotion") or {}).get("guard_plan_id") != plan_id):
            raise ContractError("Guard can only measure its exact deployed improver")
        prior = self._claim(plan_id)
        if prior:
            return self.action(prior)
        executor = self._trusted_executor()

        usage = {key: 0 for key in _USAGE_KEYS}
        failures, rows, descendant = [], [], None
        generation_binding = {
            **plan["shared_binding"], "plan_id": plan_id,
            "protocol_digest": plan["protocol_digest"], "phase": "guard_generation",
            "call_budget_digest": digest(self._remaining(plan, usage)),
        }
        generation_request = {
            "kind": "generate_guard_offspring", "binding": generation_binding,
            "task_agent": plan["task_agent"],
            "feedback_bundle": plan["feedback_bundle"],
            "task_channel": plan["task_channel"],
            "task_channel_revision": plan["task_channel_revision"],
            "task_mutation_policy": plan["task_mutation_policy"],
            "improver": {"id": plan["candidate_improver_id"],
                         "digest": plan["candidate_improver_digest"]},
            "improver_channel": plan["channel"],
            "expected_improver_revision": plan["expected_deployed_revision"],
            "provider": plan["provider"], "model": plan["model"],
            "budget": self._remaining(plan, usage), "memory": plan["memory"],
        }
        try:
            self._heartbeat(plan_id)
            receipt = _copy(
                TaskMetaExecutor.generate_offspring(executor, generation_request),
                "Guard generation receipt")
            self._heartbeat(plan_id)
            if (receipt.get("schema") != GENERATION_RECEIPT_SCHEMA
                    or receipt.get("status") != "completed"
                    or receipt.get("binding") != generation_binding):
                raise ContractError("Guard generation receipt is not bound to the plan")
            descendant = receipt.get("package")
            verify_package(descendant, plan["task_agent"])
            self._add_usage(usage, self._receipt_usage(receipt), plan)
            generation = {
                "episode_id": receipt.get("episode_id"),
                "generation_id": receipt.get("generation_id"),
                "package_id": descendant["id"], "package_digest": descendant["digest"],
                "improver_registration": deepcopy(receipt.get("improver_registration")),
                "receipt_digest": digest(receipt),
            }
            registration = generation["improver_registration"] or {}
            if (registration.get("channel") != plan["channel"]
                    or registration.get("revision") != plan["expected_deployed_revision"]
                    or registration.get("package_digest") != plan["candidate_improver_digest"]):
                raise ContractError("Guard offspring was not produced by the deployed channel")
        except Exception as exc:
            generation = None
            failures.append({"phase": "generation", "error_type": type(exc).__name__,
                             "message": str(exc)[:500]})

        seen_episodes = set()
        if not failures:
            for index, task in enumerate(plan["guard_tasks"]):
                call_budget = self._remaining(plan, usage)
                binding = {
                    **plan["shared_binding"], "plan_id": plan_id,
                    "protocol_digest": plan["protocol_digest"], "phase": "guard_evaluation",
                    "task_index": index, "task_digest": plan["task_digests"][index],
                    "descendant_digest": descendant["digest"],
                    "call_budget_digest": digest(call_budget),
                }
                request = {
                    "kind": "evaluate_task_agent_descendant", "binding": binding,
                    "package": descendant, "task": task, "split": "guard",
                    "provider": plan["provider"], "model": plan["model"],
                    "budget": call_budget, "memory": plan["memory"],
                    "evaluator": plan["evaluator"],
                }
                try:
                    self._heartbeat(plan_id)
                    receipt = _copy(
                        TaskMetaExecutor.evaluate_descendant(executor, request),
                        "Guard evaluation receipt")
                    self._heartbeat(plan_id)
                    score = receipt.get("score")
                    if (receipt.get("schema") != EVALUATION_RECEIPT_SCHEMA
                            or receipt.get("status") != "completed"
                            or receipt.get("binding") != binding
                            or type(receipt.get("accepted")) is not bool
                            or type(score) not in {int, float} or not math.isfinite(score)):
                        raise ContractError("Guard evaluation receipt is incomplete")
                    episode_id = receipt.get("episode_id")
                    if not isinstance(episode_id, str) or episode_id in seen_episodes:
                        raise ContractError("Guard evaluation Episode identity is invalid or replayed")
                    seen_episodes.add(episode_id)
                    self._add_usage(usage, self._receipt_usage(receipt), plan)
                    rows.append({
                        "task_index": index, "task_digest": plan["task_digests"][index],
                        "episode_id": episode_id, "score": float(score),
                        "accepted": receipt["accepted"], "receipt_digest": digest(receipt),
                    })
                except Exception as exc:
                    failures.append({"phase": "evaluation", "task_index": index,
                                     "error_type": type(exc).__name__,
                                     "message": str(exc)[:500]})
                    break

        complete = (not failures and len(rows) == len(plan["guard_tasks"])
                    and [row["task_digest"] for row in rows] == plan["task_digests"])
        mean_utility = (sum(row["score"] for row in rows) / len(rows)) if complete else None
        success_rate = (sum(row["accepted"] for row in rows) / len(rows)) if complete else None
        passed = bool(complete and mean_utility >= plan["min_mean_utility"]
                      and success_rate >= plan["min_success_rate"])
        run = {
            "schema": GUARD_RUN_SCHEMA, "id": _id("improver-guard-run"),
            "created_at": time.time(), "plan_id": plan_id,
            "plan_digest": plan["record_digest"], "protocol_digest": plan["protocol_digest"],
            "measurement_complete": complete, "generation": generation,
            "rows": rows, "usage": {**usage, "usage_complete": complete},
            "mean_utility": mean_utility, "success_rate": success_rate,
            "passed": passed, "degraded": not passed, "failures": failures,
        }
        return self._complete(plan, run)
