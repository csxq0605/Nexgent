"""Pre-registered meta-evaluation of versioned improvers.

The experiment in this module compares improvers by the utility of the
TaskAgent descendants they actually produce.  Source-code similarity,
improver self-ratings, and proposal text are deliberately absent from the
decision rule.

The host injects two trusted executors.  ``generate_offspring`` runs an
improver from a frozen starting point and returns a generation receipt.
``evaluate_descendant`` runs a frozen host evaluator against the resulting
package and returns a measurement receipt.  Both receipts are strictly bound
to the plan and must contain complete usage accounting.
"""

from __future__ import annotations

from copy import deepcopy
from dataclasses import asdict, dataclass
import json
import math
import re
import time
import uuid

from ..kernel.programs import digest
from .benchmarks import host_runtime_fingerprint
from .packages import verify_package
from .tools import ContractError


PLAN_SCHEMA = "nexgent.improver-meta-plan.v1"
TRIAL_SCHEMA = "nexgent.improver-meta-trial.v1"
DECISION_SCHEMA = "nexgent.improver-meta-evaluation.v1"
GENERATION_RECEIPT_SCHEMA = "nexgent.meta-generation-receipt.v1"
EVALUATION_RECEIPT_SCHEMA = "nexgent.meta-evaluation-receipt.v1"
_ARMS = ("R0", "R1")
_USAGE_KEYS = (
    "model_calls", "charged_completion_tokens", "tool_calls",
    "charged_tool_work_units", "nodes",
)
_LIMIT_KEYS = {
    "model_calls": "max_model_calls",
    "charged_completion_tokens": "max_completion_tokens",
    "tool_calls": "max_tool_calls",
    "charged_tool_work_units": "max_tool_work_units",
    "nodes": "max_nodes",
}


def _copy(value, label="Meta-evaluation value"):
    try:
        encoded = json.dumps(value, ensure_ascii=False, sort_keys=True,
                             separators=(",", ":"), allow_nan=False)
        return json.loads(encoded)
    except (TypeError, ValueError, RecursionError) as exc:
        raise ContractError(f"{label} must be finite JSON: {str(exc)[:500]}") from None


def _id(prefix):
    return prefix + "-" + uuid.uuid4().hex[:16]


def _text(value, label, limit=240):
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        raise ContractError(f"{label} must be nonempty bounded text")
    return value


def _digest_text(value, label):
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{64}", value):
        raise ContractError(f"{label} must be a SHA-256 digest")
    return value


def _identifier(value, label):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:/-]{0,239}", value):
        raise ContractError(f"{label} must be a bounded identifier")
    return value


def _finite(value, label):
    if type(value) not in {int, float} or not math.isfinite(value):
        raise ContractError(f"{label} must be finite")
    return float(value)


@dataclass(frozen=True)
class MetaEvaluationPolicy:
    """Frozen gates over descendant utility and normalized resource usage."""

    min_utility_delta: float = 0.0
    min_success_rate: float = 1.0
    max_cost_ratio: float = 1.0
    max_absolute_cost_when_r0_zero: float = 0.0
    max_regressions: int = 0
    model_call_weight: float = 1.0
    completion_token_weight: float = 0.001
    tool_call_weight: float = 1.0
    tool_work_unit_weight: float = 1.0
    node_weight: float = 0.1

    def __post_init__(self):
        numeric = (
            self.min_utility_delta, self.min_success_rate, self.max_cost_ratio,
            self.max_absolute_cost_when_r0_zero, self.model_call_weight,
            self.completion_token_weight, self.tool_call_weight, self.node_weight,
            self.tool_work_unit_weight,
        )
        if (any(type(value) not in {int, float} or not math.isfinite(value)
                for value in numeric)
                or not 0 <= self.min_success_rate <= 1
                or self.max_cost_ratio < 0
                or self.max_absolute_cost_when_r0_zero < 0
                or any(value < 0 for value in numeric[4:])
                or type(self.max_regressions) is not int
                or self.max_regressions < 0):
            raise ValueError("Invalid meta-evaluation policy")


class MetaEvaluationService:
    """Run one-shot R0/R1 experiments over their actual TaskAgent offspring.

    Executor contracts are intentionally narrow.  They are host authorities,
    not callbacks controlled by an improver package.  Every request includes a
    ``binding`` object; the returned receipt must repeat it exactly.

    ``generate_offspring(request)`` returns a mapping containing
    ``schema``, ``status='completed'``, ``episode_id``, ``package``, ``usage``
    and ``binding``.  The package must be a direct child of the frozen A0.

    ``evaluate_descendant(request)`` returns ``schema``,
    ``status='completed'``, ``episode_id``, finite ``score``, boolean
    ``accepted``, complete ``usage`` and the exact ``binding``.  The host may
    retain private diagnostics elsewhere; they are neither requested nor used.
    """

    def __init__(self, store, generate_offspring, evaluate_descendant):
        if not callable(generate_offspring) or not callable(evaluate_descendant):
            raise TypeError("Meta-evaluation executors must be callable host authorities")
        generator_owner = getattr(generate_offspring, "__self__", None)
        evaluator_owner = getattr(evaluate_descendant, "__self__", None)
        if (generator_owner is None or generator_owner is not evaluator_owner
                or generator_owner.__class__ is not TaskMetaExecutor
                or generator_owner.tasks.store is not store):
            raise TypeError("Meta-evaluation requires one trusted TaskMetaExecutor")
        self.store = store
        self._executor = generator_owner
        with self.store.connect() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS task_improver_meta_plans(
                    id TEXT PRIMARY KEY, data TEXT NOT NULL, digest TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS task_improver_meta_trials(
                    id TEXT PRIMARY KEY, data TEXT NOT NULL, digest TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS task_improver_meta_evaluations(
                    id TEXT PRIMARY KEY, data TEXT NOT NULL, digest TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS task_improver_meta_run_claims(
                    plan_id TEXT PRIMARY KEY, status TEXT NOT NULL, trial_id TEXT,
                    created REAL NOT NULL, updated REAL NOT NULL);
            """)

    @staticmethod
    def _encode(value):
        return json.dumps(value, ensure_ascii=False, sort_keys=True,
                          separators=(",", ":"), allow_nan=False)

    def _trusted_executor(self):
        executor = self._executor
        if (executor.__class__ is not TaskMetaExecutor
                or executor.tasks.store is not self.store
                or executor.generation.tasks is not executor.tasks):
            raise ContractError("Trusted meta executor identity changed")
        return executor

    def _insert(self, table, record):
        encoded, record_digest = self._encode(record), digest(record)
        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            old = db.execute(
                f"SELECT data,digest FROM {table} WHERE id=?", (record["id"],)).fetchone()
            if old and old != (encoded, record_digest):
                raise ContractError("Cannot overwrite an immutable meta-evaluation record")
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
        value = json.loads(row[0])
        if digest(value) != row[1]:
            raise ContractError("Meta-evaluation record digest mismatch")
        value["record_digest"] = row[1]
        return value

    def _external(self, table, identity):
        if not re.fullmatch(r"[a-z_][a-z0-9_]*", table):
            raise ContractError("External meta-evaluation table is invalid")
        return self._get(table, identity)

    @staticmethod
    def _legacy_usage(value):
        """Project pre-metering usage into the current read contract.

        This runs only after the stored digest has been verified.  The
        persisted evidence and its digest remain unchanged; callers merely
        receive the explicit zero baseline that existed before numerical tool
        work was introduced.
        """
        result = deepcopy(value)
        if isinstance(result, dict):
            result.setdefault("charged_tool_work_units", 0)
        return result

    @classmethod
    def _normalize_plan_read(cls, record):
        result = deepcopy(record)
        for key in ("outer_budget", "arm_budget"):
            if isinstance(result.get(key), dict):
                result[key].setdefault("max_tool_work_units", 0)
        if isinstance(result.get("policy"), dict):
            result["policy"].setdefault("tool_work_unit_weight", 1.0)
        return result

    @classmethod
    def _normalize_trial_read(cls, record):
        result = deepcopy(record)
        for values in (result.get("descendants") or {}).values():
            for item in values if isinstance(values, list) else []:
                if isinstance(item, dict) and "usage" in item:
                    item["usage"] = cls._legacy_usage(item["usage"])
        for key in ("development_rows", "selection_rows"):
            for item in result.get(key) or []:
                if isinstance(item, dict) and "usage" in item:
                    item["usage"] = cls._legacy_usage(item["usage"])
        usage = result.get("usage")
        if isinstance(usage, dict):
            if "total" in usage:
                usage["total"] = cls._legacy_usage(usage["total"])
            if isinstance(usage.get("by_arm"), dict):
                usage["by_arm"] = {
                    arm: cls._legacy_usage(value)
                    for arm, value in usage["by_arm"].items()
                }
        for failure in result.get("failures") or []:
            execution = failure.get("execution") if isinstance(failure, dict) else None
            if isinstance(execution, dict) and "usage" in execution:
                execution["usage"] = cls._legacy_usage(execution["usage"])
        return result

    def plan(self, plan_id):
        return self._normalize_plan_read(
            self._get("task_improver_meta_plans", plan_id))

    def trial(self, trial_id):
        return self._normalize_trial_read(
            self._get("task_improver_meta_trials", trial_id))

    def evaluation(self, evaluation_id):
        """Load meta-evidence consumed by ImproverService.record_decision."""
        return self._get("task_improver_meta_evaluations", evaluation_id)

    @staticmethod
    def _budget(value):
        if not isinstance(value, dict):
            raise ContractError("Outer budget must be an object")
        expected = set(_LIMIT_KEYS.values())
        value = dict(value)
        # Pre-metering callers have an explicit zero baseline. They cannot
        # consume numerical tool work until they opt into the new limit.
        value.setdefault("max_tool_work_units", 0)
        if set(value) != expected:
            raise ContractError("Outer budget must freeze every supported resource limit")
        result = {}
        for key in sorted(expected):
            if type(value[key]) is not int or value[key] < 0:
                raise ContractError("Outer budget limits must be nonnegative integers")
            result[key] = value[key]
        return result

    @staticmethod
    def _tasks(values, label):
        if not isinstance(values, list) or not values or len(values) > 256:
            raise ContractError(f"{label} tasks must be a nonempty bounded list")
        result = [_copy(value, f"{label} task") for value in values]
        if any(not isinstance(value, dict) for value in result):
            raise ContractError(f"{label} tasks must be JSON objects")
        identities = [digest(value) for value in result]
        if len(set(identities)) != len(identities):
            raise ContractError(f"{label} tasks must have unique content digests")
        return result

    @staticmethod
    def _improvers(value):
        if not isinstance(value, dict) or set(value) != set(_ARMS):
            raise ContractError("Improvers must contain exactly the R0 and R1 arms")
        result = {}
        for arm in _ARMS:
            descriptor = _copy(value[arm], f"{arm} improver descriptor")
            if not isinstance(descriptor, dict):
                raise ContractError("Improver descriptors must be objects")
            _identifier(descriptor.get("id"), f"{arm} improver id")
            _digest_text(descriptor.get("digest"), f"{arm} improver digest")
            result[arm] = descriptor
        if result["R0"]["digest"] == result["R1"]["digest"]:
            raise ContractError("R0 and R1 must be distinct immutable improvers")
        return result

    def create_plan(self, *, candidate_id, channel, channel_revision,
                    task_agent, feedback_bundle, task_channel, task_channel_revision,
                    task_mutation_policy, improvers, provider, model,
                    outer_budget, memory, development_tasks, selection_tasks,
                    evaluator, offspring_per_arm=1, policy=None):
        """Freeze both arms and their complete experiment before execution."""
        candidate_id = _identifier(candidate_id, "Improver candidate id")
        channel = _identifier(channel, "Improver channel")
        if type(channel_revision) is not int or channel_revision < 0:
            raise ContractError("Improver channel revision must be a nonnegative integer")
        task_agent = _copy(task_agent, "TaskAgent A0")
        try:
            verify_package(task_agent)
        except Exception as exc:
            raise ContractError(f"TaskAgent A0 is invalid: {str(exc)[:500]}") from None
        feedback_bundle = _copy(feedback_bundle, "FeedbackBundle")
        if not isinstance(feedback_bundle, dict) or not feedback_bundle.get("id"):
            raise ContractError("FeedbackBundle must be an immutable identified object")
        try:
            stored_feedback = self._external(
                "task_feedback_bundles", feedback_bundle["id"])
        except KeyError:
            raise ContractError("FeedbackBundle is not local immutable evidence") from None
        if stored_feedback != feedback_bundle:
            raise ContractError("FeedbackBundle differs from its local immutable record")
        task_channel = _identifier(task_channel, "Task-agent channel")
        if type(task_channel_revision) is not int or task_channel_revision < 0:
            raise ContractError("Task-agent channel revision must be a nonnegative integer")
        task_mutation_policy = _copy(task_mutation_policy, "Task-agent mutation policy")
        if not isinstance(task_mutation_policy, dict) or not task_mutation_policy:
            raise ContractError("Task-agent mutation policy must be a nonempty object")
        if (feedback_bundle.get("channel") != task_channel
                or feedback_bundle.get("channel_revision") != task_channel_revision
                or feedback_bundle.get("parent_package_id") != task_agent["id"]
                or feedback_bundle.get("parent_package_digest") != task_agent["digest"]):
            raise ContractError("FeedbackBundle does not bind the frozen TaskAgent start")
        improvers = self._improvers(improvers)
        try:
            candidate = self._external("task_improver_candidates", candidate_id)
        except KeyError:
            raise ContractError("Improver candidate is not local immutable evidence") from None
        if (candidate.get("channel") != channel
                or candidate.get("channel_revision") != channel_revision
                or improvers["R0"].get("id") != candidate.get("parent_improver_id")
                or improvers["R0"].get("digest") != candidate.get("parent_improver_digest")
                or improvers["R1"].get("id") != candidate.get("package_id")
                or improvers["R1"].get("digest") != candidate.get("package_digest")):
            raise ContractError("Meta plan does not bind the exact recursive candidate")
        from .evolution import active_package_registration
        active_task = active_package_registration(self.store, task_channel)
        if (active_task["revision"] != task_channel_revision
                or active_task["package_id"] != task_agent["id"]
                or active_task["package_digest"] != task_agent["digest"]):
            raise ContractError("TaskAgent start is not the active frozen task channel revision")
        for arm in _ARMS:
            package = self.store.package(improvers[arm]["id"])
            if package["digest"] != improvers[arm]["digest"]:
                raise ContractError("Improver descriptor does not match the local package archive")
        provider = _identifier(provider, "Provider")
        model = _text(model, "Model")
        outer_budget = self._budget(outer_budget)
        memory = _copy(memory, "Memory starting point")
        if memory != {"kind": "empty"}:
            raise ContractError("Meta-evaluation currently requires an explicit empty memory start")
        development_tasks = self._tasks(development_tasks, "Development")
        selection_tasks = self._tasks(selection_tasks, "Selection")
        evaluator = _copy(evaluator, "Evaluator")
        if not isinstance(evaluator, dict) or not evaluator:
            raise ContractError("Evaluator descriptor must be a nonempty object")
        if type(offspring_per_arm) is not int or not 1 <= offspring_per_arm <= 16:
            raise ContractError("offspring_per_arm must be between 1 and 16")
        if policy is None:
            policy = MetaEvaluationPolicy()
        if isinstance(policy, MetaEvaluationPolicy):
            policy = asdict(policy)
        else:
            try:
                policy = asdict(MetaEvaluationPolicy(**_copy(policy, "Meta policy")))
            except (TypeError, ValueError) as exc:
                raise ContractError(f"Invalid meta-evaluation policy: {str(exc)[:500]}") from None

        generation_schedule = []
        for slot in range(offspring_per_arm):
            order = _ARMS if slot % 2 == 0 else tuple(reversed(_ARMS))
            generation_schedule.extend({"arm": arm, "slot": slot} for arm in order)
        development_schedule = []
        for slot in range(offspring_per_arm):
            for task_index in range(len(development_tasks)):
                order = _ARMS if (slot + task_index) % 2 == 0 else tuple(reversed(_ARMS))
                development_schedule.extend(
                    {"arm": arm, "slot": slot, "task_index": task_index} for arm in order)
        selection_schedule = []
        for task_index in range(len(selection_tasks)):
            order = _ARMS if task_index % 2 == 0 else tuple(reversed(_ARMS))
            selection_schedule.extend(
                {"arm": arm, "task_index": task_index} for arm in order)

        shared = {
            "task_agent_digest": task_agent["digest"],
            "feedback_digest": digest(feedback_bundle),
            "task_channel": task_channel,
            "task_channel_revision": task_channel_revision,
            "task_mutation_policy_digest": digest(task_mutation_policy),
            "provider": provider,
            "model": model,
            "outer_budget": outer_budget,
            "memory_digest": digest(memory),
            "development_digest": digest(development_tasks),
            "selection_digest": digest(selection_tasks),
            "evaluator_digest": digest(evaluator),
        }
        record = {
            "schema": PLAN_SCHEMA, "id": _id("meta-plan"), "created": time.time(),
            "candidate_id": candidate_id, "channel": channel,
            "channel_revision": channel_revision,
            "task_agent": task_agent, "feedback_bundle": feedback_bundle,
            "task_channel": task_channel,
            "task_channel_revision": task_channel_revision,
            "task_mutation_policy": task_mutation_policy,
            "improvers": improvers, "provider": provider, "model": model,
            "outer_budget": outer_budget,
            "arm_budget": {_LIMIT_KEYS[key]: outer_budget[_LIMIT_KEYS[key]] // 2
                           for key in _USAGE_KEYS},
            "memory": memory, "development_tasks": development_tasks,
            "selection_tasks": selection_tasks, "evaluator": evaluator,
            "offspring_per_arm": offspring_per_arm, "policy": policy,
            "policy_digest": digest(policy),
            "shared_binding": shared,
            "schedule": {"generation": generation_schedule,
                         "development": development_schedule,
                         "selection": selection_schedule},
        }
        record["protocol_digest"] = digest({
            "shared": shared, "improvers": improvers, "policy": policy,
            "schedule": record["schedule"],
        })
        return self._insert("task_improver_meta_plans", record)

    def _claim(self, plan_id):
        now = time.time()
        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                "SELECT status,trial_id FROM task_improver_meta_run_claims WHERE plan_id=?",
                (plan_id,)).fetchone()
            if row:
                if row[0] == "completed" and row[1]:
                    return row[1]
                raise ContractError("Meta-evaluation plan is already claimed and cannot be repeated")
            db.execute("INSERT INTO task_improver_meta_run_claims VALUES(?,?,?,?,?)",
                       (plan_id, "running", None, now, now))
        return None

    def _finish(self, plan_id, trial_id):
        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            changed = db.execute(
                "UPDATE task_improver_meta_run_claims SET status='completed',trial_id=?,updated=? "
                "WHERE plan_id=? AND status='running' AND trial_id IS NULL",
                (trial_id, time.time(), plan_id)).rowcount
            if changed != 1:
                raise ContractError("Meta-evaluation plan claim changed before completion")

    @staticmethod
    def _empty_usage():
        return {key: 0 for key in _USAGE_KEYS}

    @staticmethod
    def _receipt_usage(receipt):
        usage = receipt.get("usage")
        if not isinstance(usage, dict) or usage.get("usage_complete") is not True:
            raise ContractError("Executor receipt has incomplete usage accounting")
        result = {}
        for key in _USAGE_KEYS:
            value = usage.get(key, 0) if key == "charged_tool_work_units" else usage.get(key)
            if type(value) is not int or value < 0:
                raise ContractError("Executor receipt has invalid usage accounting")
            result[key] = value
        return result

    @staticmethod
    def _add_usage(totals, arm_totals, arm, delta, plan):
        for key in _USAGE_KEYS:
            totals[key] += delta[key]
            arm_totals[arm][key] += delta[key]
            if totals[key] > plan["outer_budget"][_LIMIT_KEYS[key]]:
                raise ContractError(f"Outer {key} budget exceeded")
            if arm_totals[arm][key] > plan["arm_budget"][_LIMIT_KEYS[key]]:
                raise ContractError(f"{arm} {key} budget exceeded")

    @staticmethod
    def _runner_failure(phase, row, exc, execution=None):
        failure = {"phase": phase, "row": deepcopy(row),
                   "error_type": type(exc).__name__, "message": str(exc)[:500]}
        if isinstance(execution, dict):
            failure["execution"] = {key: deepcopy(execution.get(key)) for key in
                                    ("episode_id", "receipt_digest", "binding_digest", "usage")}
        return failure

    @staticmethod
    def _admit_episode(seen, episode_id):
        if episode_id in seen:
            raise ContractError("Executor replayed one Episode across experiment rows")
        seen.add(episode_id)

    @staticmethod
    def _remaining_budget(plan, totals, arm_totals, arm):
        return {_LIMIT_KEYS[key]: min(
                    plan["outer_budget"][_LIMIT_KEYS[key]] - totals[key],
                    plan["arm_budget"][_LIMIT_KEYS[key]] - arm_totals[arm][key])
                for key in _USAGE_KEYS}

    def _generation_request(self, plan, row, call_budget):
        arm, slot = row["arm"], row["slot"]
        binding = {
            "plan_id": plan["id"], "protocol_digest": plan["protocol_digest"],
            "arm": arm, "slot": slot, **plan["shared_binding"],
            "improver_digest": plan["improvers"][arm]["digest"],
            "call_budget_digest": digest(call_budget),
        }
        return {
            "kind": "generate_task_agent_offspring", "binding": binding,
            "task_agent": plan["task_agent"], "feedback_bundle": plan["feedback_bundle"],
            "task_channel": plan["task_channel"],
            "task_channel_revision": plan["task_channel_revision"],
            "task_mutation_policy": plan["task_mutation_policy"],
            "improver": plan["improvers"][arm], "provider": plan["provider"],
            "model": plan["model"], "budget": call_budget,
            "memory": plan["memory"], "development_tasks": plan["development_tasks"],
            "selection_tasks": plan["selection_tasks"],
        }

    def _validate_generation(self, plan, request, receipt):
        receipt = _copy(receipt, "Generation receipt")
        if (not isinstance(receipt, dict)
                or receipt.get("schema") != GENERATION_RECEIPT_SCHEMA
                or receipt.get("status") != "completed"
                or receipt.get("binding") != request["binding"]):
            raise ContractError("Generation receipt is incomplete or not bound to the plan")
        _identifier(receipt.get("episode_id"), "Generation Episode id")
        package = receipt.get("package")
        try:
            verify_package(package, parent=plan["task_agent"])
        except Exception as exc:
            raise ContractError(f"Improver did not produce a valid A0 descendant: {str(exc)[:500]}") from None
        usage = self._receipt_usage(receipt)
        return {"arm": request["binding"]["arm"], "slot": request["binding"]["slot"],
                "episode_id": receipt["episode_id"], "package": package,
                "package_id": package["id"], "package_digest": package["digest"],
                "usage": {**usage, "usage_complete": True},
                "binding_digest": digest(request["binding"]),
                "receipt_digest": digest(receipt)}

    def _evaluation_request(self, plan, descendant, task, split, call_budget):
        arm, slot = descendant["arm"], descendant["slot"]
        binding = {
            "plan_id": plan["id"], "protocol_digest": plan["protocol_digest"],
            "arm": arm, "slot": slot, "split": split,
            "descendant_digest": descendant["package_digest"],
            "task_digest": digest(task), "provider": plan["provider"],
            "model": plan["model"], "memory_digest": plan["shared_binding"]["memory_digest"],
            "evaluator_digest": plan["shared_binding"]["evaluator_digest"],
            "call_budget_digest": digest(call_budget),
        }
        return {
            "kind": "evaluate_task_agent_descendant", "binding": binding,
            "package": descendant["package"], "task": task, "split": split,
            "provider": plan["provider"], "model": plan["model"],
            "budget": call_budget, "memory": plan["memory"],
            "evaluator": plan["evaluator"],
        }

    def _validate_evaluation(self, request, receipt):
        receipt = _copy(receipt, "Evaluation receipt")
        if (not isinstance(receipt, dict)
                or receipt.get("schema") != EVALUATION_RECEIPT_SCHEMA
                or receipt.get("status") != "completed"
                or receipt.get("binding") != request["binding"]
                or type(receipt.get("accepted")) is not bool):
            raise ContractError("Evaluation receipt is incomplete or not bound to the plan")
        _identifier(receipt.get("episode_id"), "Evaluation Episode id")
        score = _finite(receipt.get("score"), "Evaluator score")
        usage = self._receipt_usage(receipt)
        binding = request["binding"]
        return {"arm": binding["arm"], "slot": binding["slot"],
                "split": binding["split"], "task_digest": binding["task_digest"],
                "package_digest": binding["descendant_digest"],
                "episode_id": receipt["episode_id"], "score": score,
                "accepted": receipt["accepted"],
                "usage": {**usage, "usage_complete": True},
                "binding_digest": digest(request["binding"]),
                "receipt_digest": digest(receipt)}

    @staticmethod
    def _select_development(descendants, rows, task_count, policy):
        selected, aggregates = {}, {}
        for arm in _ARMS:
            choices = []
            for descendant in descendants[arm]:
                relevant = [row for row in rows if row["arm"] == arm
                            and row["slot"] == descendant["slot"]]
                if len(relevant) != task_count:
                    raise ContractError("Development measurement coverage is incomplete")
                score = sum(row["score"] for row in relevant) / task_count
                success_rate = sum(row["accepted"] for row in relevant) / task_count
                usage = {key: (descendant["usage"][key]
                               + sum(row["usage"][key] for row in relevant))
                         for key in _USAGE_KEYS}
                work = MetaEvaluationService._normalized_work(usage, policy)
                choices.append({"arm": arm, "slot": descendant["slot"],
                                "package_id": descendant["package_id"],
                                "package_digest": descendant["package_digest"],
                                "mean_score": score, "success_rate": success_rate,
                                "tie_break_work": work})
            choices.sort(key=lambda value: (-value["mean_score"],
                                            -value["success_rate"],
                                            value["tie_break_work"],
                                            value["package_digest"]))
            selected[arm], aggregates[arm] = choices[0], choices
        return selected, aggregates

    def run(self, plan_id):
        """Consume a plan once and return its immutable descendant trial."""
        plan = self.plan(plan_id)
        prior = self._claim(plan_id)
        if prior:
            return self.trial(prior)

        totals = self._empty_usage()
        arm_totals = {arm: self._empty_usage() for arm in _ARMS}
        seen_episode_ids = set()
        descendants = {arm: [] for arm in _ARMS}
        development_rows, selection_rows, failures = [], [], []
        selected, development_aggregates = {}, {}

        for row in plan["schedule"]["generation"]:
            result = None
            call_budget = self._remaining_budget(
                plan, totals, arm_totals, row["arm"])
            request = self._generation_request(plan, row, call_budget)
            try:
                executor = self._trusted_executor()
                receipt = TaskMetaExecutor.generate_offspring(executor, _copy(request))
                result = self._validate_generation(plan, request, receipt)
                self._admit_episode(seen_episode_ids, result["episode_id"])
                self._add_usage(totals, arm_totals, row["arm"], result["usage"], plan)
                descendants[row["arm"]].append(result)
            except Exception as exc:
                failures.append(self._runner_failure("generation", row, exc, result))
                break

        if not failures:
            lookup = {(item["arm"], item["slot"]): item
                      for arm in _ARMS for item in descendants[arm]}
            for row in plan["schedule"]["development"]:
                descendant = lookup[(row["arm"], row["slot"])]
                task = plan["development_tasks"][row["task_index"]]
                result = None
                call_budget = self._remaining_budget(
                    plan, totals, arm_totals, row["arm"])
                request = self._evaluation_request(
                    plan, descendant, task, "development", call_budget)
                try:
                    executor = self._trusted_executor()
                    receipt = TaskMetaExecutor.evaluate_descendant(executor, _copy(request))
                    result = self._validate_evaluation(request, receipt)
                    self._admit_episode(seen_episode_ids, result["episode_id"])
                    self._add_usage(totals, arm_totals, row["arm"], result["usage"], plan)
                    development_rows.append(result)
                except Exception as exc:
                    failures.append(self._runner_failure("development", row, exc, result))
                    break

        if not failures:
            try:
                selected, development_aggregates = self._select_development(
                    descendants, development_rows, len(plan["development_tasks"]),
                    plan["policy"])
            except Exception as exc:
                failures.append(self._runner_failure("development_selection", {}, exc))

        if not failures:
            chosen = {}
            for arm in _ARMS:
                chosen[arm] = next(
                    item for item in descendants[arm]
                    if item["slot"] == selected[arm]["slot"])
            for row in plan["schedule"]["selection"]:
                arm = row["arm"]
                task = plan["selection_tasks"][row["task_index"]]
                result = None
                call_budget = self._remaining_budget(plan, totals, arm_totals, arm)
                request = self._evaluation_request(
                    plan, chosen[arm], task, "selection", call_budget)
                try:
                    executor = self._trusted_executor()
                    receipt = TaskMetaExecutor.evaluate_descendant(executor, _copy(request))
                    result = self._validate_evaluation(request, receipt)
                    self._admit_episode(seen_episode_ids, result["episode_id"])
                    self._add_usage(totals, arm_totals, arm, result["usage"], plan)
                    selection_rows.append(result)
                except Exception as exc:
                    failures.append(self._runner_failure("selection", row, exc, result))
                    break

        expected_generation = plan["offspring_per_arm"] * 2
        expected_development = (plan["offspring_per_arm"]
                                * len(plan["development_tasks"]) * 2)
        expected_selection = len(plan["selection_tasks"]) * 2
        complete = (not failures
                    and sum(len(values) for values in descendants.values()) == expected_generation
                    and len(development_rows) == expected_development
                    and len(selection_rows) == expected_selection)
        record = {
            "schema": TRIAL_SCHEMA, "id": _id("meta-trial"),
            "created_at": time.time(),
            "plan_id": plan["id"], "plan_digest": plan["record_digest"],
            "protocol_digest": plan["protocol_digest"],
            "measurement_complete": complete,
            "descendants": descendants, "development_rows": development_rows,
            "development_aggregates": development_aggregates,
            "selected_descendants": selected, "selection_rows": selection_rows,
            "usage": {"total": totals, "by_arm": arm_totals,
                      "usage_complete": complete},
            "failures": failures,
        }
        stored = self._insert("task_improver_meta_trials", record)
        self._finish(plan_id, stored["id"])
        return stored

    @staticmethod
    def _normalized_work(usage, policy):
        return (usage["model_calls"] * policy["model_call_weight"]
                + usage["charged_completion_tokens"] * policy["completion_token_weight"]
                + usage["tool_calls"] * policy["tool_call_weight"]
                + usage.get("charged_tool_work_units", 0)
                * policy.get("tool_work_unit_weight", 1.0)
                + usage["nodes"] * policy["node_weight"])

    def assess(self, trial_id):
        """Derive a local immutable decision solely from selection receipts."""
        trial = self.trial(trial_id)
        plan = self.plan(trial["plan_id"])
        if trial["plan_digest"] != plan["record_digest"]:
            raise ContractError("Trial is not bound to the current immutable plan")
        decision_id = "meta-evaluation-" + digest({
            "trial_id": trial["id"], "trial_digest": trial["record_digest"],
            "policy": plan["policy"],
        })[:24]
        if not trial["measurement_complete"]:
            record = {
                "schema": DECISION_SCHEMA, "id": decision_id,
                "candidate_id": plan["candidate_id"], "channel": plan["channel"],
                "channel_revision": plan["channel_revision"],
                "parent_improver_id": plan["improvers"]["R0"]["id"],
                "parent_improver_digest": plan["improvers"]["R0"]["digest"],
                "candidate_improver_id": plan["improvers"]["R1"]["id"],
                "candidate_improver_digest": plan["improvers"]["R1"]["digest"],
                "plan_id": plan["id"], "plan_digest": plan["record_digest"],
                "trial_id": trial["id"], "trial_digest": trial["record_digest"],
                "protocol_digest": plan["protocol_digest"],
                "r0_improver": plan["improvers"]["R0"],
                "r1_improver": plan["improvers"]["R1"],
                "selected_descendants": trial["selected_descendants"],
                "policy_digest": plan["policy_digest"],
                "measurement_complete": False, "eligible": False,
                "measurements": {
                    "parent": {"quality": None, "success_rate": None, "cost": None,
                               "usage_complete": False},
                    "candidate": {"quality": None, "success_rate": None, "cost": None,
                                  "usage_complete": False},
                    "utility_delta": None, "cost_ratio": None, "regressions": None,
                    "failure_reasons": deepcopy(trial["failures"]),
                },
                "gates": {"measurement_complete": False},
                "created_at": trial["created_at"],
                "reason": "missing, invalid, or incompletely accounted host measurement",
            }
            return self._insert("task_improver_meta_evaluations", record)

        rows = trial["selection_rows"]
        expected_task_digests = [digest(task) for task in plan["selection_tasks"]]
        metrics, by_arm = {}, {}
        for arm in _ARMS:
            arm_rows = [row for row in rows if row["arm"] == arm]
            if ([row["task_digest"] for row in arm_rows] != expected_task_digests
                    or any(row["usage"].get("usage_complete") is not True for row in arm_rows)):
                raise ContractError("Immutable selection coverage is inconsistent with the plan")
            by_arm[arm] = {row["task_digest"]: row for row in arm_rows}
            mean_score = sum(row["score"] for row in arm_rows) / len(arm_rows)
            success_rate = sum(row["accepted"] for row in arm_rows) / len(arm_rows)
            work = self._normalized_work(trial["usage"]["by_arm"][arm], plan["policy"])
            metrics[arm] = {"mean_descendant_utility": mean_score,
                            "success_rate": success_rate,
                            "normalized_work": work,
                            "usage": trial["usage"]["by_arm"][arm]}
        delta = metrics["R1"]["mean_descendant_utility"] - metrics["R0"]["mean_descendant_utility"]
        regressions = sum(by_arm["R1"][identity]["score"] < by_arm["R0"][identity]["score"]
                          for identity in expected_task_digests)
        r0_cost, r1_cost = metrics["R0"]["normalized_work"], metrics["R1"]["normalized_work"]
        if r0_cost == 0:
            cost_gate = r1_cost <= plan["policy"]["max_absolute_cost_when_r0_zero"]
            cost_ratio = None
        else:
            cost_ratio = r1_cost / r0_cost
            cost_gate = cost_ratio <= plan["policy"]["max_cost_ratio"]
        gates = {
            "measurement_complete": True,
            "utility_delta": delta >= plan["policy"]["min_utility_delta"],
            "success_rate": metrics["R1"]["success_rate"] >= plan["policy"]["min_success_rate"],
            "cost": cost_gate,
            "regressions": regressions <= plan["policy"]["max_regressions"],
        }
        promote = all(gates.values())
        record = {
            "schema": DECISION_SCHEMA, "id": decision_id,
            "candidate_id": plan["candidate_id"], "channel": plan["channel"],
            "channel_revision": plan["channel_revision"],
            "parent_improver_id": plan["improvers"]["R0"]["id"],
            "parent_improver_digest": plan["improvers"]["R0"]["digest"],
            "candidate_improver_id": plan["improvers"]["R1"]["id"],
            "candidate_improver_digest": plan["improvers"]["R1"]["digest"],
            "plan_id": plan["id"], "plan_digest": plan["record_digest"],
            "trial_id": trial["id"], "trial_digest": trial["record_digest"],
            "protocol_digest": plan["protocol_digest"],
            "r0_improver": plan["improvers"]["R0"],
            "r1_improver": plan["improvers"]["R1"],
            "selected_descendants": trial["selected_descendants"],
            "policy_digest": plan["policy_digest"],
            "measurement_complete": True, "eligible": promote,
            "measurements": {
                "parent": {"quality": metrics["R0"]["mean_descendant_utility"],
                           "success_rate": metrics["R0"]["success_rate"],
                           "cost": metrics["R0"]["normalized_work"],
                           "usage": metrics["R0"]["usage"], "usage_complete": True},
                "candidate": {"quality": metrics["R1"]["mean_descendant_utility"],
                              "success_rate": metrics["R1"]["success_rate"],
                              "cost": metrics["R1"]["normalized_work"],
                              "usage": metrics["R1"]["usage"], "usage_complete": True},
                "utility_delta": delta, "cost_ratio": cost_ratio,
                "regressions": regressions, "failure_reasons": [],
            },
            "gates": gates,
            "created_at": trial["created_at"],
            "reason": "all preregistered descendant-utility gates passed" if promote
                      else "one or more preregistered gates failed",
        }
        return self._insert("task_improver_meta_evaluations", record)


class TaskMetaExecutor:
    """Trusted bridge from meta protocols to real task-runtime Episodes.

    The bridge never accepts a score or a package from an improver.  It invokes
    :class:`GenerationService`, loads the admitted descendant from the local
    package store, then runs the frozen benchmark adapter through
    :class:`TaskService`.
    """

    def __init__(self, task_service, generation_service, adapter):
        if generation_service.tasks is not task_service:
            raise ValueError("Meta executor services must share one TaskService")
        if not isinstance(getattr(adapter, "id", None), str):
            raise TypeError("Meta executor adapter needs a stable id")
        self.tasks = task_service
        self.generation = generation_service
        self.adapter = adapter
        self.snapshot = _copy(adapter.snapshot(), "Meta evaluator snapshot")

    @staticmethod
    def _usage(value):
        if not isinstance(value, dict) or value.get("usage_complete") is not True:
            raise ContractError("Runtime Episode has incomplete usage accounting")
        result = {key: (value.get(key, 0) if key == "charged_tool_work_units"
                        else value.get(key)) for key in _USAGE_KEYS}
        if any(type(item) is not int or item < 0 for item in result.values()):
            raise ContractError("Runtime Episode has invalid usage accounting")
        return {**result, "usage_complete": True}

    def _check_evaluator(self, descriptor):
        if (not isinstance(descriptor, dict)
                or descriptor.get("benchmark_id") != self.adapter.id
                or descriptor.get("snapshot") != self.snapshot):
            raise ContractError("Executor adapter does not match the frozen evaluator")

    def _check_runtime_receipts(self, episode, provider, model):
        snapshot = self.tasks.store.memory_snapshot(
            episode["memory_snapshot_id"], episode["id"])
        if snapshot.get("items") or snapshot.get("item_version_refs"):
            raise ContractError("Meta execution did not start from empty memory")
        calls = episode.get("calls") or []
        if provider == "none" and model == "none":
            if calls:
                raise ContractError("A no-model meta plan emitted model calls")
            return
        expected = provider + "/" + model
        if any(call.get("model") != expected for call in calls):
            raise ContractError("Meta execution used a model outside the frozen requirement")

    def generate_offspring(self, request):
        request = _copy(request, "Meta generation request")
        binding = request.get("binding")
        improver = request.get("improver") or {}
        try:
            package = self.tasks.store.package(improver["id"])
        except (KeyError, TypeError):
            raise ContractError("Frozen improver package is unavailable locally") from None
        if package["digest"] != improver.get("digest"):
            raise ContractError("Frozen improver package digest changed")
        channel = request.get("task_channel")
        revision = request.get("task_channel_revision")
        feedback = request.get("feedback_bundle") or {}
        if request.get("kind") == "generate_guard_offspring":
            improver_channel = request.get("improver_channel")
            expected_improver_revision = request.get("expected_improver_revision")
            raw_package = None
        else:
            improver_channel = None
            expected_improver_revision = None
            raw_package = package
        result = self.generation.generate(
            channel, feedback.get("id"), raw_package,
            request.get("task_mutation_policy"), revision,
            improver_channel=improver_channel,
            expected_improver_revision=expected_improver_revision,
            budget=request.get("budget"))
        stored = self.generation.generation(result["id"])
        if stored["record_digest"] != result["record_digest"]:
            raise ContractError("Candidate generation record changed after execution")
        if result.get("status") != "generated":
            raise ContractError("Real task-agent candidate generation did not complete: "
                                + str(result.get("reason") or result.get("status")))
        descendant = self.tasks.store.package(result["candidate_package_id"])
        if descendant["digest"] != result.get("candidate_package_digest"):
            raise ContractError("Admitted descendant digest mismatch")
        episode = self.tasks.get_private(result["episode_id"])
        if (episode.get("execution", {}).get("entry") != "improve"
                or episode.get("execution", {}).get("package_digest") != package["digest"]
                or episode.get("package_digest") != package["digest"]
                or result.get("parent_package_id") != request["task_agent"]["id"]
                or result.get("parent_package_digest") != request["task_agent"]["digest"]
                or result.get("feedback_bundle_id") != feedback.get("id")
                or result.get("feedback_digest") != feedback.get("digest")):
            raise ContractError("Candidate generation lacks a complete local execution closure")
        self._check_runtime_receipts(episode, request.get("provider"), request.get("model"))
        if request.get("kind") == "generate_guard_offspring":
            registration = result.get("improver_registration")
            if (not isinstance(registration, dict)
                    or registration.get("channel") != improver_channel
                    or registration.get("revision") != expected_improver_revision
                    or registration.get("package_id") != package["id"]
                    or registration.get("package_digest") != package["digest"]):
                raise ContractError("Guard generation did not resolve the deployed improver channel")
        return {
            "schema": GENERATION_RECEIPT_SCHEMA, "status": "completed",
            "episode_id": result["episode_id"], "package": descendant,
            "usage": self._usage(result["usage"]), "binding": binding,
            "generation_id": result["id"],
            "improver_registration": deepcopy(result.get("improver_registration")),
        }

    def evaluate_descendant(self, request):
        request = _copy(request, "Meta evaluation request")
        self._check_evaluator(request.get("evaluator"))
        task_ref = request.get("task")
        if not isinstance(task_ref, dict) or not isinstance(task_ref.get("objective"), str):
            raise ContractError("Meta evaluation task is invalid")
        package = request.get("package")
        verify_package(package)
        context = deepcopy(task_ref.get("context") or {})
        if "benchmark_registration" in context:
            raise ContractError("Meta task cannot provide benchmark registration authority")
        context.update({
            "split": request.get("split"),
            "split_role": {"development": "development", "selection": "selection",
                           "guard": "monitoring"}.get(
                               request.get("split"), request.get("split")),
            "memory_writeback": False,
            "rsi_role": "improver_descendant_evaluation",
            "meta_binding_digest": digest(request.get("binding")),
            "provider_requirement": request.get("provider"),
            "model_requirement": request.get("model"),
        })
        benchmark_registration = {
            "benchmark_id": self.adapter.id,
            "task_ref": deepcopy(task_ref),
            "snapshot": deepcopy(self.snapshot),
            "host_runtime": host_runtime_fingerprint(),
        }
        state = self.tasks.create(
            task_ref["objective"], inputs=task_ref.get("inputs"),
            deliverables=task_ref.get("deliverables"), budget=request.get("budget"),
            capabilities=task_ref.get("capabilities"), package=package, context=context,
            constraints=task_ref.get("constraints"), entry=task_ref.get("entry", "execute"),
            benchmark_registration=benchmark_registration)
        state = self.tasks.run(state["id"])
        evaluated = self.tasks.evaluate(
            state["id"], self.adapter, task_ref, snapshot=deepcopy(self.snapshot))
        report = evaluated["evaluation"]
        episode = self.tasks.get_private(state["id"])
        if (episode.get("package_digest") != package["digest"]
                or self.tasks.store.benchmark_registration(state["id"]) != benchmark_registration
                or not any(event.get("kind") == "benchmark_evaluated"
                           for event in episode.get("events") or [])):
            raise ContractError("Descendant evaluation lacks a complete local benchmark closure")
        self._check_runtime_receipts(episode, request.get("provider"), request.get("model"))
        score = report.get("score")
        if (report.get("score_available") is not True
                or type(report.get("accepted")) is not bool
                or type(score) not in {int, float} or not math.isfinite(score)):
            raise ContractError("Frozen evaluator did not return a complete utility measurement")
        return {
            "schema": EVALUATION_RECEIPT_SCHEMA, "status": "completed",
            "episode_id": state["id"], "score": float(score),
            "accepted": report["accepted"],
            "usage": self._usage(evaluated["usage"]),
            "binding": request.get("binding"),
            "evaluation_digest": digest(report),
        }
