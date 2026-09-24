"""Durable terminal-Episode trigger for ordinary-task feedback development.

The synchronous TaskService hook only calls :meth:`observe_terminal`.  Policy
checks, feedback projection, and all later development work run from ``drain``
or ``scan`` so task completion never waits for an evolution cycle.
"""

from __future__ import annotations

from copy import deepcopy
import json
import time

from ..kernel.programs import digest
from .tools import ContractError


WORK_SCHEMA = "nexgent.ordinary-feedback-work.v1"
POLICY_SCHEMA = "nexgent.ordinary-feedback-policy.v1"
_CANDIDATE_TYPES = frozenset({
    "tool", "service_provider", "orchestration", "no_change",
})
_TERMINAL = frozenset({"completed", "failed", "cancelled"})
_PRIVATE_SOURCE_KINDS = frozenset({"benchmark", "holdout"})
_BUDGET_KEYS = frozenset({
    "max_model_calls", "max_completion_tokens", "max_tool_calls",
    "max_tool_work_units", "max_nodes",
})
_EFFECT_CLASSES = frozenset({
    "read", "artifact_write", "local_compute", "external_compute",
})
_PROMOTION_KEYS = frozenset({
    "min_quality_delta", "min_success_rate", "max_cost_ratio",
    "max_absolute_cost_when_parent_zero", "max_regressions",
    "monitor_min_score", "monitor_min_success_rate",
})


def _finite_json(value, label, maximum=65_536):
    try:
        encoded = json.dumps(value, ensure_ascii=False, sort_keys=True,
                             separators=(",", ":"), allow_nan=False)
    except (TypeError, ValueError, RecursionError):
        raise ContractError(f"{label} must be finite JSON") from None
    if len(encoded.encode("utf-8")) > maximum:
        raise ContractError(f"{label} exceeds its {maximum}-byte bound")
    return json.loads(encoded)


def _policy(value):
    """Normalize the host policy whose digest is frozen into each work item."""
    value = _finite_json(value, "Feedback trigger policy")
    if not isinstance(value, dict):
        raise ContractError("Feedback trigger policy must be an object")
    allowed = {
        "evaluator_id", "candidate_types", "development_split",
        "selection_split", "guard_split", "budget", "permissions",
        "improver", "promotion_policy",
    }
    if not set(value) <= allowed:
        raise ContractError("Feedback trigger policy contains unknown fields")
    evaluator_id = value.get("evaluator_id")
    if (not isinstance(evaluator_id, str) or not evaluator_id
            or len(evaluator_id) > 200):
        raise ContractError("Feedback trigger policy needs a bounded evaluator id")
    candidate_types = value.get("candidate_types", sorted(_CANDIDATE_TYPES))
    if (not isinstance(candidate_types, list) or not candidate_types
            or len(set(candidate_types)) != len(candidate_types)
            or any(item not in _CANDIDATE_TYPES for item in candidate_types)):
        raise ContractError("Feedback trigger candidate types are invalid")
    splits = {
        "development_split": value.get("development_split", "development"),
        "selection_split": value.get("selection_split", "selection"),
        "guard_split": value.get("guard_split", "guard"),
    }
    if (splits["development_split"] != "development"
            or any(not isinstance(item, str) or not item or len(item) > 100
                   for item in splits.values())
            or len(set(splits.values())) != len(splits)):
        raise ContractError("Feedback trigger task splits must be distinct and bounded")
    budget = value.get("budget") or {}
    if (not isinstance(budget, dict) or not set(budget) <= _BUDGET_KEYS
            or any(type(item) is not int or item < 0 or item > 1_000_000_000
                   for item in budget.values())):
        raise ContractError("Feedback trigger budget fields are invalid")
    permissions = value.get("permissions") or {}
    if not isinstance(permissions, dict) or not set(permissions) <= {"allowed_effects"}:
        raise ContractError("Feedback trigger permission fields are invalid")
    effects = permissions.get("allowed_effects", [])
    if (not isinstance(effects, list) or len(set(effects)) != len(effects)
            or any(effect not in _EFFECT_CLASSES for effect in effects)):
        raise ContractError("Feedback trigger allowed effects are invalid")
    promotion = value.get("promotion_policy") or {}
    if (not isinstance(promotion, dict) or not set(promotion) <= _PROMOTION_KEYS
            or any(type(item) not in {int, float} for item in promotion.values())
            or ("max_regressions" in promotion
                and (type(promotion["max_regressions"]) is not int
                     or promotion["max_regressions"] < 0))):
        raise ContractError("Feedback trigger promotion policy fields are invalid")
    improver = value.get("improver")
    if improver is not None:
        improver_keys = {"channel", "revision", "package_id", "package_digest"}
        if (not isinstance(improver, dict) or not set(improver) <= improver_keys
                or set(improver) not in ({"channel", "revision"}, improver_keys)
                or not isinstance(improver.get("channel"), str)
                or not improver["channel"] or len(improver["channel"]) > 200
                or type(improver.get("revision")) is not int
                or improver["revision"] < 0
                or any(not isinstance(improver.get(key), str) or not improver[key]
                       for key in set(improver) - {"channel", "revision"})):
            raise ContractError("Feedback trigger improver identity is invalid")
    return {
        "schema": POLICY_SCHEMA,
        "evaluator_id": evaluator_id,
        "candidate_types": sorted(candidate_types),
        **splits,
        "budget": deepcopy(budget),
        "permissions": {"allowed_effects": list(effects)},
        "improver": deepcopy(improver),
        "promotion_policy": deepcopy(promotion),
    }


class AutoEvolutionService:
    """Observe terminal ordinary Episodes and project bounded public feedback.

    This is the E3-B.2a trigger/outbox boundary.  It deliberately does not
    generate candidates, run benchmark tasks, score outputs, or promote a
    package.  Those are later coordinator states.
    """

    def __init__(self, task_service, *, policies=None, evolution_service=None,
                 generation_service=None, evaluator_available=None, attach=True):
        self.tasks = task_service
        self.store = task_service.store
        if policies is not None and not isinstance(policies, dict):
            raise ContractError("Feedback trigger policies must be a channel mapping")
        self.policies = {
            channel: _policy(value)
            for channel, value in (policies or {}).items()
        }
        if any(not isinstance(channel, str) or not channel or len(channel) > 200
               for channel in self.policies):
            raise ContractError("Feedback trigger channel ids must be bounded text")
        self._evolution = evolution_service
        self._generation = generation_service
        if (evolution_service is not None
                and evolution_service.tasks is not task_service):
            raise ValueError("Feedback trigger services must share one TaskService")
        if generation_service is not None:
            if (evolution_service is None
                    or generation_service.tasks is not task_service
                    or generation_service.evolution is not evolution_service):
                raise ValueError("Feedback trigger services must share one TaskService")
        if evaluator_available is not None and not callable(evaluator_available):
            raise TypeError("Evaluator availability resolver must be callable")
        self._evaluator_available = evaluator_available
        if attach:
            task_service.attach_feedback_trigger(self)

    @staticmethod
    def _registration(episode):
        context = episode.get("task", {}).get("context") or {}
        registration = context.get("package_channel_registration")
        keys = {"channel", "revision", "package_id", "package_digest"}
        if (not isinstance(registration, dict) or set(registration) != keys
                or not isinstance(registration.get("channel"), str)
                or not registration["channel"]
                or type(registration.get("revision")) is not int
                or registration["revision"] < 0
                or registration.get("package_id") != episode.get("package_id")
                or registration.get("package_digest") != episode.get("package_digest")):
            return None
        return registration

    def _source_kind(self, episode):
        if self.store.benchmark_registration(episode["id"]) is not None:
            return "benchmark"
        context = episode.get("task", {}).get("context") or {}
        split, role = context.get("split"), context.get("split_role")
        if split in {"selection", "guard", "final_holdout", "holdout"} or role in {
                "selection", "monitoring", "guard", "final_holdout", "holdout"}:
            return "holdout"
        if split == "development" and role == "development":
            return "ordinary_development"
        return "unscoped"

    @staticmethod
    def _trigger_key(channel, parent_revision, source_episode_id):
        return digest({
            "schema": WORK_SCHEMA,
            "channel_id": channel,
            "parent_revision": parent_revision,
            "source_episode_id": source_episode_id,
        })

    def observe_terminal(self, episode_id):
        """Do only the bounded, idempotent write used by TaskService.run."""
        episode = self.store.get(episode_id)
        if episode.get("status") not in _TERMINAL:
            return None
        registration = self._registration(episode)
        channel = registration["channel"] if registration else None
        parent_revision = registration["revision"] if registration else None
        source_kind = self._source_kind(episode)
        policy = deepcopy(self.policies.get(channel)) if channel is not None else None
        if registration is None:
            status, reason = "deferred", "missing_package_channel"
        elif source_kind in _PRIVATE_SOURCE_KINDS:
            status, reason = "deferred", f"{source_kind}_source_excluded"
        elif source_kind != "ordinary_development":
            status, reason = "deferred", "source_not_development"
        elif policy is None:
            status, reason = "deferred", "missing_channel_policy"
        else:
            status, reason = "observed", None
        key = self._trigger_key(channel, parent_revision, episode_id)
        now = time.time()
        record = {
            "id": "feedback-work-" + key[:24],
            "schema": WORK_SCHEMA,
            "trigger_key": key,
            "channel_id": channel,
            "parent_revision": parent_revision,
            "source_episode_id": episode_id,
            "status": status,
            "reason": reason,
            "policy": policy,
            "policy_digest": digest(policy) if policy is not None else None,
            "source": {
                "kind": source_kind,
                "terminal_status": episode["status"],
                "package_id": episode["package_id"],
                "package_digest": episode["package_digest"],
            },
            "created_at": now,
            "updated_at": now,
            "revision": 0,
        }
        return self.store.put_feedback_trigger(record)

    def _has_evaluator(self, evaluator_id):
        try:
            if self._evaluator_available is not None:
                return self._evaluator_available(evaluator_id) is True
            return evaluator_id in self.tasks._benchmark_registry().adapters()
        except Exception:
            return False

    def _services(self):
        if self._evolution is None:
            from .evolution import EvolutionService
            self._evolution = EvolutionService(self.tasks)
        if self._generation is None:
            from .generation import GenerationService
            self._generation = GenerationService(self.tasks, self._evolution)
        return self._evolution, self._generation

    def _matching_feedback(self, work):
        """Find a bundle committed before a coordinator interruption."""
        _, generation = self._services()
        try:
            with self.store.connect() as db:
                rows = db.execute(
                    "SELECT id FROM task_feedback_bundles "
                    "WHERE json_extract(data,'$.channel')=? "
                    "AND json_extract(data,'$.channel_revision')=? "
                    "ORDER BY json_extract(data,'$.created_at'),id",
                    (work["channel_id"], work["parent_revision"])).fetchall()
        except Exception:
            return None
        for row in rows:
            try:
                bundle = generation.feedback(row[0])
            except (KeyError, ContractError):
                continue
            refs = bundle.get("episode_refs") or []
            if (len(refs) == 1
                    and refs[0].get("episode_id") == work["source_episode_id"]
                    and bundle.get("parent_package_id") == work["source"]["package_id"]
                    and bundle.get("parent_package_digest")
                    == work["source"]["package_digest"]):
                return bundle
        return None

    def _defer(self, work, reason):
        return self.store.transition_feedback_trigger(
            work["id"], expected_revision=work["revision"],
            status="deferred", reason=reason)

    def process(self, identity):
        """Advance one item through public feedback capture, without scoring."""
        work = self.store.feedback_trigger(identity)
        with self.store.lock(work["source_episode_id"]):
            # Serialize restart recovery for one source. The lock is released
            # by the OS after a coordinator crash, while the durable capture
            # intent remains available to the next worker.
            return self._process_locked(work["id"])

    def _process_locked(self, identity):
        work = self.store.feedback_trigger(identity)
        if work["status"] in {"feedback_captured", "deferred"}:
            return work
        episode = self.store.get(work["source_episode_id"])
        if episode.get("status") not in _TERMINAL:
            return self._defer(work, "source_no_longer_terminal")
        if self._source_kind(episode) != "ordinary_development":
            return self._defer(work, "source_boundary_changed")
        policy = work.get("policy")
        if (not isinstance(policy, dict)
                or digest(policy) != work.get("policy_digest")):
            return self._defer(work, "missing_channel_policy")
        if not self._has_evaluator(policy["evaluator_id"]):
            return self._defer(work, "independent_evaluator_unavailable")
        evolution, generation = self._services()
        try:
            active = evolution.active(work["channel_id"])
        except Exception:
            return self._defer(work, "package_channel_unavailable")
        if (active.get("revision") != work["parent_revision"]
                or active.get("package_id") != work["source"]["package_id"]
                or active.get("package_digest") != work["source"]["package_digest"]):
            return self._defer(work, "parent_revision_changed")

        if work["status"] == "observed":
            existing = self._matching_feedback(work)
            work = self.store.transition_feedback_trigger(
                work["id"], expected_revision=work["revision"],
                status="feedback_capture_started")
            if existing is not None:
                return self.store.transition_feedback_trigger(
                    work["id"], expected_revision=work["revision"],
                    status="feedback_captured",
                    feedback_bundle={"id": existing["id"],
                                     "digest": existing["digest"]})

        recovered = self._matching_feedback(work)
        if recovered is not None:
            return self.store.transition_feedback_trigger(
                work["id"], expected_revision=work["revision"],
                status="feedback_captured",
                feedback_bundle={"id": recovered["id"],
                                 "digest": recovered["digest"]})
        try:
            bundle = generation.capture_feedback(
                work["channel_id"], [work["source_episode_id"]],
                expected_revision=work["parent_revision"])
        except ContractError:
            return self._defer(work, "feedback_capture_rejected")
        return self.store.transition_feedback_trigger(
            work["id"], expected_revision=work["revision"],
            status="feedback_captured",
            feedback_bundle={"id": bundle["id"], "digest": bundle["digest"]})

    def drain(self, *, limit=64):
        """Advance a bounded number of pending items after task completion."""
        rows = self.store.feedback_triggers(
            statuses=["feedback_capture_started", "observed"], limit=limit)
        return [self.process(row["id"]) for row in rows]

    def scan(self, *, after_id=None, limit=256, drain=True):
        """Discover one restart-safe page of terminal Episodes and optionally drain it."""
        episode_ids = self.store.terminal_episode_ids(after_id=after_id, limit=limit)
        observed = [self.observe_terminal(identity) for identity in episode_ids]
        advanced = self.drain(limit=limit) if drain else []
        return {
            "observed": observed,
            "advanced": advanced,
            "next_cursor": episode_ids[-1] if len(episode_ids) == limit else None,
        }
