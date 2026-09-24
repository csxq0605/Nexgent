"""Durable terminal-Episode trigger for ordinary-task feedback development.

The synchronous TaskService hook only calls :meth:`observe_terminal`.  Policy
checks, feedback projection, and all later development work run from ``drain``
or ``scan`` so task completion never waits for an evolution cycle.
"""

from __future__ import annotations

from copy import deepcopy
import json
import math
import time

from ..kernel.programs import digest
from .tools import ContractError


WORK_SCHEMA = "nexgent.ordinary-feedback-work.v1"
POLICY_SCHEMA = "nexgent.ordinary-feedback-policy.v1"
DEVELOPMENT_PLAN_SCHEMA = "nexgent.ordinary-development-plan.v1"
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
_SEARCH_BUDGET_KEYS = frozenset({
    "max_model_calls", "max_completion_tokens", "max_tool_calls", "max_nodes",
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
        "improver", "promotion_policy", "orchestration_search",
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
    search = value.get("orchestration_search")
    if search is not None:
        # Project composition validates policy once before attaching the
        # coordinator, which validates it again. Preserve the same canonical
        # contract across both boundaries rather than rejecting our own output.
        canonical_keys = {
            "policy", "first_seed", "max_seed_scan",
            "development_episode_budget",
        }
        if isinstance(search, dict) and set(search) == canonical_keys:
            canonical = search.get("policy")
            if (not isinstance(canonical, dict)
                    or canonical.get("target_qualified") != 1):
                raise ContractError("Feedback orchestration search policy is invalid")
            search = {
                **{key: item for key, item in canonical.items()
                   if key != "target_qualified"},
                "first_seed": search["first_seed"],
                "max_seed_scan": search["max_seed_scan"],
                "development_episode_budget": search[
                    "development_episode_budget"],
            }
        allowed_search = {
            "max_attempts", "first_seed", "max_seed_scan", "minimum_mean_delta",
            "max_model_calls", "max_completion_tokens", "max_tool_calls", "max_nodes",
            "development_episode_budget",
        }
        required_search = {"max_attempts"} | _SEARCH_BUDGET_KEYS
        if (not isinstance(search, dict) or not set(search) <= allowed_search
                or not required_search <= set(search)
                or type(search.get("max_attempts")) is not int
                or not 1 <= search["max_attempts"] <= 16
                or type(search.get("first_seed", 0)) is not int
                or type(search.get("max_seed_scan", 128)) is not int
                or not 1 <= search.get("max_seed_scan", 128) <= 10_000
                or type(search.get("minimum_mean_delta", 0.0)) not in {int, float}
                or not math.isfinite(search.get("minimum_mean_delta", 0.0))
                or any(type(search[key]) is not int or search[key] < 0
                       for key in _SEARCH_BUDGET_KEYS)):
            raise ContractError("Feedback orchestration search policy is invalid")
        development_budget = search.get("development_episode_budget")
        if development_budget is not None and (
                not isinstance(development_budget, dict)
                or set(development_budget) != _SEARCH_BUDGET_KEYS
                or any(type(development_budget[key]) is not int
                       or development_budget[key] < 0
                       for key in _SEARCH_BUDGET_KEYS)
                or development_budget["max_nodes"] < 1):
            raise ContractError(
                "Feedback orchestration development budget is invalid")
        search = {
            "policy": {
                "max_attempts": search["max_attempts"],
                "target_qualified": 1,
                "minimum_mean_delta": search.get("minimum_mean_delta", 0.0),
                **{key: search[key] for key in sorted(_SEARCH_BUDGET_KEYS)},
            },
            "first_seed": search.get("first_seed", 0),
            "max_seed_scan": search.get("max_seed_scan", 128),
            "development_episode_budget": deepcopy(development_budget),
        }
    result = {
        "schema": POLICY_SCHEMA,
        "evaluator_id": evaluator_id,
        "candidate_types": sorted(candidate_types),
        **splits,
        "budget": deepcopy(budget),
        "permissions": {"allowed_effects": list(effects)},
        "improver": deepcopy(improver),
        "promotion_policy": deepcopy(promotion),
    }
    if search is not None:
        result["orchestration_search"] = search
    return result


class AutoEvolutionService:
    """Coordinate ordinary feedback through development and guarded adoption."""

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
        if context.get("rsi_role") == "ordinary_feedback_development":
            # rsi_role itself is public context.  Only the host-owned improver
            # registration plus an already-frozen work item can establish the
            # internal coordinator boundary.
            registration = context.get("improver_channel_registration")
            work_id = context.get("feedback_work_id")
            try:
                work = self.store.feedback_trigger(work_id)
            except (KeyError, TypeError):
                work = None
            intent = work.get("development_intent") if isinstance(work, dict) else None
            if (isinstance(registration, dict) and isinstance(intent, dict)
                    and registration == intent.get("improver")
                    and context.get("feedback_bundle_id")
                    == intent.get("feedback_bundle", {}).get("id")):
                return "internal_rsi"
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
        if source_kind == "ordinary_development":
            # This is a bounded local projection only.  It never evaluates the
            # task or changes its outcome, so it is safe in the terminal hook.
            self._record_reuse(episode, registration)
        if source_kind == "internal_rsi":
            return None
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

    @staticmethod
    def _plan_schema():
        hypothesis = {
            "type": "object",
            "required": ["failure_mechanism", "expected_behavior",
                         "applicability", "falsifier"],
            "properties": {
                key: {"type": "string", "minLength": 1, "maxLength": 5000}
                for key in ("failure_mechanism", "expected_behavior",
                            "applicability", "falsifier")
            },
            "additionalProperties": False,
        }
        return {
            "$id": DEVELOPMENT_PLAN_SCHEMA,
            "type": "object",
            "required": ["schema", "candidate_type", "source_ref",
                         "hypothesis", "reason"],
            "properties": {
                "schema": {"const": DEVELOPMENT_PLAN_SCHEMA},
                "candidate_type": {"enum": sorted(_CANDIDATE_TYPES)},
                "source_ref": {"type": ["string", "null"]},
                "hypothesis": {"oneOf": [hypothesis, {"type": "null"}]},
                "reason": {"type": "string", "minLength": 1, "maxLength": 5000},
            },
            "additionalProperties": False,
        }

    def _candidate_options(self, work, episode, active):
        """Return bounded reusable receipts; never expose source or private context."""
        from .task_capability_adoption import TaskCapabilityAdoptionService

        allowed = set(work["policy"]["candidate_types"])
        options = []
        with self.store.connect() as db:
            rows = db.execute(
                "SELECT id,data FROM task_capability_definitions "
                "WHERE origin_episode=? ORDER BY id",
                (episode["id"],),
            ).fetchall()
        adoption = TaskCapabilityAdoptionService(
            self.tasks, self._services()[0], self._services()[1])
        # Reserve four slots for episode O/S, direct O/S patching, bounded O
        # search, and explicit abstention while keeping the total at 64.
        for definition_id, encoded in rows[:60]:
            try:
                projected = json.loads(encoded)
                kind = projected.get("kind")
                if kind not in {"tool", "service_provider"} or kind not in allowed:
                    continue
                loader = (self.store.tool_definition if kind == "tool"
                          else self.store.service_definition)
                definition = loader(definition_id)
                if not adoption._used(episode, definition):
                    continue
                options.append({
                    "candidate_type": kind,
                    "source_ref": definition_id,
                    "evidence": {
                        "definition_digest": definition["digest"],
                        "successful_use": True,
                    },
                })
            except (KeyError, ValueError, ContractError):
                continue

        if "orchestration" in allowed:
            workflow_ref = episode.get("plan_workflow_ref")
            has_workflow = (isinstance(workflow_ref, str)
                            and workflow_ref.startswith("generated://"))
            has_skill = any(
                event.get("kind") == "task_skill_compiled"
                for event in episode.get("events") or [])
            source_completed = (episode.get("status") == "completed"
                                and episode.get("usage", {}).get("usage_complete") is True)
            if source_completed and (has_workflow or has_skill):
                options.append({
                    "candidate_type": "orchestration", "source_ref": "episode_os",
                    "evidence": {
                        "workflow_digest": (workflow_ref.removeprefix("generated://")
                                            if has_workflow else None),
                        "compiled_skill_observed": has_skill,
                    },
                })
            mutation_policy = self._mutation_policy(active["package"])
            if mutation_policy is not None:
                options.append({
                    "candidate_type": "orchestration", "source_ref": "package_patch",
                    "evidence": {"parent_component_registry_digest": digest(
                        self._services()[1].feedback(
                            work["feedback_bundle"]["id"])["parent_component_registry"])},
                })
            search_policy = work["policy"].get("orchestration_search")
            orchestration_policy = self._orchestration_mutation_policy(
                active["package"])
            if search_policy is not None and orchestration_policy is not None:
                options.append({
                    "candidate_type": "orchestration",
                    "source_ref": "orchestration_search",
                    "evidence": {
                        "search_policy_digest": digest(search_policy),
                        "parent_component_registry_digest": digest(
                            self._services()[1].feedback(
                                work["feedback_bundle"]["id"])[
                                    "parent_component_registry"]),
                        "target_class": "O",
                    },
                })
        if "no_change" in allowed:
            options.append({
                "candidate_type": "no_change", "source_ref": None,
                "evidence": {"abstention_allowed": True},
            })
        return _finite_json(options, "Feedback development options", maximum=32_768)

    @staticmethod
    def _mutation_policy(parent):
        """Derive a package-local O/S envelope without evaluator or permission state."""
        manifest = parent["manifest"]
        if manifest.get("manifest_version", 1) == 2:
            from .generation import _component_registry_snapshot

            registry = _component_registry_snapshot(parent)["components"]
            improve_ref = manifest["entries"].get("improve")
            improve_path = improve_ref.split(":", 1)[0] if improve_ref else None
            mutable = sorted(
                component_id for component_id, descriptor in registry.items()
                if descriptor.get("class") in {"O", "S"}
                and len(descriptor.get("files") or []) == 1
                and descriptor["files"][0] != improve_path
            )
            if not mutable:
                return None
            tools = set(manifest.get("tools") or {})
            for registration in (manifest.get("workflows") or {}).values():
                try:
                    definition = json.loads(parent["files"][registration["ref"]])
                except (KeyError, TypeError, ValueError):
                    continue
                pending = list(definition.get("nodes") or [])
                while pending:
                    node = pending.pop()
                    if not isinstance(node, dict):
                        continue
                    if node.get("method") == "tool":
                        name = (node.get("params") or {}).get("name")
                        if isinstance(name, str):
                            tools.add(name)
                    body = node.get("body")
                    if isinstance(body, dict):
                        pending.extend(body.get("nodes") or [])
            return {
                "patch_contract": "nexgent.package-patch.v3",
                "mutable_components": mutable,
                "allow_add": True,
                "allow_remove": True,
                "max_patch_bytes": 500_000,
                "capability_ceiling": sorted({
                    capability
                    for role in (manifest.get("roles") or {}).values()
                    for capability in role.get("capabilities", [])
                }),
                "tool_ceiling": sorted(tools),
                "max_parallel": max((
                    registration.get("max_parallel", 4)
                    for registration in (manifest.get("workflows") or {}).values()
                ), default=1),
            }

        entries = manifest.get("entries") or {}
        execute_path = entries["execute"].split(":", 1)[0]
        improve_ref = entries.get("improve")
        improve_path = improve_ref.split(":", 1)[0] if improve_ref else None
        paths = [execute_path]
        classes = {execute_path: "O"}
        for skill in (manifest.get("skills") or {}).values():
            ref = skill.get("ref")
            path = ref.split(":", 1)[0] if skill.get("kind") == "controlled_code" else ref
            if isinstance(path, str) and path != improve_path and path in parent["files"]:
                paths.append(path)
                classes[path] = "S"
        paths = sorted(set(path for path in paths if path != improve_path))
        if not paths:
            return None
        return {
            "mutable_paths": paths,
            "component_classes": {path: classes[path] for path in paths},
            "allowed_operations": ["replace"],
            "max_patch_bytes": 300_000,
        }

    @classmethod
    def _orchestration_mutation_policy(cls, parent):
        """Narrow the optional search surface to O while preserving direct O/S."""
        policy = cls._mutation_policy(parent)
        if policy is None:
            return None
        if policy.get("patch_contract") == "nexgent.package-patch.v3":
            from .generation import _component_registry_snapshot

            registry = _component_registry_snapshot(parent)["components"]
            mutable = [identity for identity in policy["mutable_components"]
                       if registry[identity].get("class") == "O"]
            if not mutable:
                return None
            return {**deepcopy(policy), "mutable_components": mutable}
        classes = policy.get("component_classes") or {}
        paths = [path for path in policy["mutable_paths"]
                 if classes.get(path) == "O"]
        if not paths:
            return None
        return {
            **deepcopy(policy),
            "mutable_paths": paths,
            "component_classes": {path: "O" for path in paths},
        }

    @staticmethod
    def _plan_reference(artifact, plan):
        return {
            "artifact_id": artifact["id"],
            "digest": artifact["content_digest"],
            "candidate_type": plan["candidate_type"],
            "source_ref": plan["source_ref"],
            "hypothesis_digest": (digest(plan["hypothesis"])
                                  if plan["hypothesis"] is not None else None),
        }

    @staticmethod
    def _validate_plan(value, options):
        value = _finite_json(value, "Feedback development plan", maximum=32_768)
        required = {"schema", "candidate_type", "source_ref", "hypothesis", "reason"}
        if (not isinstance(value, dict) or set(value) != required
                or value.get("schema") != DEVELOPMENT_PLAN_SCHEMA
                or value.get("candidate_type") not in _CANDIDATE_TYPES
                or not isinstance(value.get("reason"), str)
                or not value["reason"].strip() or len(value["reason"]) > 5000):
            raise ContractError("Feedback development plan is invalid")
        selected = {
            "candidate_type": value["candidate_type"],
            "source_ref": value["source_ref"],
        }
        allowed = [
            {"candidate_type": option["candidate_type"],
             "source_ref": option["source_ref"]}
            for option in options
        ]
        if selected not in allowed:
            raise ContractError("Feedback development plan selects unavailable evidence")
        if value["candidate_type"] == "no_change":
            if value["source_ref"] is not None or value["hypothesis"] is not None:
                raise ContractError("No-change development must not invent a hypothesis")
            return value
        fields = {"failure_mechanism", "expected_behavior", "applicability", "falsifier"}
        hypothesis = value.get("hypothesis")
        if (not isinstance(hypothesis, dict) or set(hypothesis) != fields
                or any(not isinstance(hypothesis[field], str)
                       or not hypothesis[field].strip()
                       or len(hypothesis[field]) > 5000 for field in fields)):
            raise ContractError("Feedback development hypothesis is invalid")
        return value

    def _development_episode(self, work, intent):
        with self.store.connect() as db:
            rows = db.execute(
                "SELECT state FROM task_episodes "
                "WHERE json_extract(state,'$.task.context.rsi_role')=? "
                "AND json_extract(state,'$.task.context.feedback_work_id')=? "
                "AND json_extract(state,'$.task.context.feedback_bundle_id')=? "
                "AND json_extract(state,'$.task.context.improver_channel_registration.channel')=? "
                "AND json_extract(state,'$.task.context.improver_channel_registration.revision')=? "
                "AND json_extract(state,'$.task.context.improver_channel_registration.package_id')=? "
                "AND json_extract(state,'$.task.context.improver_channel_registration.package_digest')=? "
                "ORDER BY id LIMIT 2",
                ("ordinary_feedback_development", work["id"],
                 intent["feedback_bundle"]["id"],
                 intent["improver"]["channel"],
                 intent["improver"]["revision"],
                 intent["improver"]["package_id"],
                 intent["improver"]["package_digest"]),
            ).fetchall()
        matches = [json.loads(row[0]) for row in rows]
        if len(matches) > 1:
            raise ContractError("Feedback work has multiple development Episodes")
        if matches:
            episode = matches[0]
            if (episode["package_id"] != intent["improver"]["package_id"]
                    or episode["package_digest"] != intent["improver"]["package_digest"]):
                raise ContractError("Feedback development Episode improver changed")
            return episode
        feedback = self._services()[1].feedback(intent["feedback_bundle"]["id"])
        public_keys = {
            "schema", "id", "digest", "channel", "channel_revision",
            "parent_package_id", "parent_package_digest",
            "parent_component_registry", "episode_refs", "created_at",
        }
        public_feedback = {
            key: deepcopy(feedback[key]) for key in public_keys if key in feedback
        }
        registration = intent["improver"]
        from .improvers import active_improver_registration
        active_improver = active_improver_registration(self.store, registration["channel"])
        if any(active_improver[key] != registration[key]
               for key in ("channel", "revision", "package_id", "package_digest")):
            raise ContractError("Feedback development improver revision changed")
        return self.tasks.create(
            "Select one task-agnostic candidate from bounded public task feedback",
            inputs={"feedback_bundle": public_feedback,
                    "candidate_options": deepcopy(intent["options"])},
            deliverables=[{"name": "development_plan",
                           "schema": self._plan_schema()}],
            budget=deepcopy(work["policy"]["budget"]), capabilities=[],
            package=active_improver["package"], entry="execute",
            context={
                "split": work["policy"]["development_split"],
                "split_role": "development",
                "rsi_role": "ordinary_feedback_development",
                "feedback_work_id": work["id"],
                "feedback_bundle_id": intent["feedback_bundle"]["id"],
                "channel": work["channel_id"],
                "channel_revision": work["parent_revision"],
            },
            constraints={"allowed_effects": [], "wall_seconds": 1200},
            improver_channel_registration={
                key: registration[key]
                for key in ("channel", "revision", "package_id", "package_digest")
            },
        )

    def _candidate_reference(self, generated, candidate_type):
        if generated.get("status") != "generated":
            return None
        candidate_id = generated.get("candidate_id")
        if not isinstance(candidate_id, str):
            return None
        candidate = self._services()[0].candidate(candidate_id)
        return {
            "kind": candidate_type,
            "candidate_id": candidate["id"],
            "candidate_package_id": candidate["package_id"],
            "generation_id": generated["id"],
            "record_digest": generated["record_digest"],
        }

    def _search_intent(self, work):
        adapter, snapshot = self._adapter(work)
        search = deepcopy(work["policy"].get("orchestration_search"))
        if search is None:
            raise ContractError("Orchestration search is not configured")
        snapshot = _finite_json(
            snapshot, "Orchestration search evaluator snapshot", maximum=32_768)
        identity = "orchestration-search-" + digest({
            "feedback_work_id": work["id"],
            "feedback_bundle_id": work["feedback_bundle"]["id"],
            "parent_revision": work["parent_revision"],
            "development_plan": work["development_plan"],
            "search_policy": search,
            "evaluator_snapshot_digest": digest(snapshot),
        })[:40]
        return {
            "id": identity,
            "evaluator_id": work["policy"]["evaluator_id"],
            "evaluator_snapshot": snapshot,
            "evaluator_snapshot_digest": digest(snapshot),
            "policy": deepcopy(search["policy"]),
            "first_seed": search["first_seed"],
            "max_seed_scan": search["max_seed_scan"],
            "development_episode_budget": deepcopy(
                search["development_episode_budget"]),
            "source_statistical_units": [
                "ordinary:" + work["source_episode_id"]],
        }

    def _search_candidate_reference(self, result):
        qualified = result.get("qualified_candidate_ids") or []
        if result.get("status") != "qualified" or len(qualified) != 1:
            return None
        candidate_id = qualified[0]
        attempts = [event.get("content") or {} for event in result.get("events") or []
                    if event.get("kind") == "attempt_finished"]
        matches = [event for event in attempts
                   if event.get("candidate_id") == candidate_id
                   and isinstance(event.get("generation_id"), str)]
        if len(matches) != 1:
            raise ContractError("Qualified search candidate has no unique generation")
        generated = self._services()[1].generation(matches[0]["generation_id"])
        reference = self._candidate_reference(generated, "orchestration")
        if reference is None or reference["candidate_id"] != candidate_id:
            raise ContractError("Qualified search candidate generation is inconsistent")
        return reference

    def _run_orchestration_search(self, work, *, stop_event=None):
        from .orchestration_development import DevelopmentOrchestrationQualifier
        from .orchestration_search import BoundedOrchestrationSearch

        evolution, generation = self._services()
        intent = work.get("search_intent")
        if not isinstance(intent, dict):
            raise ContractError("Orchestration search lacks its frozen intent")
        adapter, snapshot = self._adapter(work)
        if (adapter.id != intent["evaluator_id"]
                or digest(snapshot) != intent["evaluator_snapshot_digest"]
                or snapshot != intent["evaluator_snapshot"]):
            raise ContractError("Orchestration search evaluator snapshot changed")
        qualifier = DevelopmentOrchestrationQualifier(
            self.tasks, evolution, adapter,
            snapshot=deepcopy(intent["evaluator_snapshot"]),
            seed=intent["first_seed"],
            source_statistical_units=intent["source_statistical_units"],
            source_episode_id=work["source_episode_id"],
            development_episode_budget=deepcopy(
                intent["development_episode_budget"]),
            stop_event=stop_event,
            max_seed_scan=intent["max_seed_scan"],
        )
        parent = evolution.active(work["channel_id"])["package"]
        mutation_policy = self._orchestration_mutation_policy(parent)
        if mutation_policy is None:
            raise ContractError("Active package has no mutable orchestration surface")
        improver = work["development_intent"]["improver"]

        def generate(_attempt, attempt_id, repair, remaining):
            budget = {"max_" + key: value for key, value in remaining.items()}
            return generation.generate(
                work["channel_id"], work["feedback_bundle"]["id"], None,
                mutation_policy, work["parent_revision"],
                improver_channel=improver["channel"],
                expected_improver_revision=improver["revision"],
                budget=budget, stop_event=stop_event,
                search_attempt_id=attempt_id, repair_brief=repair)

        return BoundedOrchestrationSearch(
            self.tasks, evolution, generation).run(
                work["channel_id"], work["feedback_bundle"]["id"],
                work["parent_revision"], deepcopy(intent["policy"]),
                search_id=intent["id"], generate=generate, qualify=qualifier)

    def _dispatch_plan(self, work, plan, *, stop_event=None):
        evolution, generation = self._services()
        source = self.tasks.get_private(work["source_episode_id"])
        common = (work["channel_id"], work["feedback_bundle"]["id"],
                  work["parent_revision"], plan["hypothesis"])
        if plan["candidate_type"] in {"tool", "service_provider"}:
            from .task_capability_adoption import TaskCapabilityAdoptionService
            result = TaskCapabilityAdoptionService(
                self.tasks, evolution, generation).adopt(
                    common[0], plan["source_ref"], source["id"], common[1],
                    common[2], common[3], budget=deepcopy(work["policy"]["budget"]),
                    stop_event=stop_event)
            return result["generation"]
        if plan["source_ref"] == "episode_os":
            from .task_skill_adoption import TaskSkillAdoptionService
            result = TaskSkillAdoptionService(
                self.tasks, evolution, generation).adopt_episode(
                    common[0], None, source["id"], common[1], common[2], common[3],
                    budget=deepcopy(work["policy"]["budget"]),
                    stop_event=stop_event)
            return result["generation"]
        if plan["source_ref"] == "package_patch":
            policy = self._mutation_policy(evolution.active(common[0])["package"])
            if policy is None:
                raise ContractError("Active package has no mutable orchestration surface")
            improver = work["development_intent"]["improver"]
            return generation.generate(
                common[0], common[1], None, policy, common[2],
                improver_channel=improver["channel"],
                expected_improver_revision=improver["revision"],
                budget=deepcopy(work["policy"]["budget"]),
                stop_event=stop_event)
        if plan["source_ref"] == "orchestration_search":
            return self._run_orchestration_search(work, stop_event=stop_event)
        raise ContractError("Feedback development plan has no supported dispatch")

    def _stored_development_plan(self, work):
        reference = work.get("development_plan") or {}
        artifact = self.store.read(
            reference["artifact_id"], work["development_episode"]["id"])
        plan = self._validate_plan(
            artifact["content"], work["development_intent"]["options"])
        if (artifact.get("content_digest") != reference.get("digest")
                or self._plan_reference(artifact, plan) != reference):
            raise ContractError("Stored development plan differs from its reference")
        return plan

    def develop(self, identity, *, stop_event=None):
        """Autonomously plan and propose one candidate; never score or promote it."""
        work = self.store.feedback_trigger(identity)
        with self.store.lock(work["source_episode_id"]):
            work = self.store.feedback_trigger(identity)
            if work["status"] in {"candidate_ready", "no_change", "rejected", "deferred"}:
                return work
            if work["status"] == "feedback_captured":
                episode = self.tasks.get_private(work["source_episode_id"])
                evolution, _ = self._services()
                active = evolution.active(work["channel_id"])
                if (active["revision"] != work["parent_revision"]
                        or active["package_id"] != work["source"]["package_id"]
                        or active["package_digest"] != work["source"]["package_digest"]):
                    return self._defer(work, "parent_revision_changed")
                improver_policy = work["policy"].get("improver")
                if not isinstance(improver_policy, dict):
                    return self._defer(work, "improver_unavailable")
                from .improvers import active_improver_registration
                try:
                    improver = active_improver_registration(
                        self.store, improver_policy["channel"])
                except (KeyError, ContractError):
                    return self._defer(work, "improver_unavailable")
                if (improver["revision"] != improver_policy["revision"]
                        or any(improver.get(key) != improver_policy.get(key)
                               for key in ("package_id", "package_digest")
                               if key in improver_policy)):
                    return self._defer(work, "improver_revision_changed")
                options = self._candidate_options(work, episode, active)
                if not options:
                    return self._defer(work, "no_candidate_type_available")
                registration = {key: deepcopy(improver[key]) for key in (
                    "channel", "revision", "package_id", "package_digest")}
                intent = {
                    "feedback_bundle": deepcopy(work["feedback_bundle"]),
                    "improver": registration,
                    "options": options,
                    "options_digest": digest(options),
                }
                work = self.store.transition_feedback_trigger(
                    work["id"], expected_revision=work["revision"],
                    status="development_planned", development_intent=intent)
            if work["status"] == "development_planned":
                try:
                    episode = self._development_episode(work, work["development_intent"])
                except ContractError:
                    return self._defer(work, "development_episode_rejected")
                work = self.store.transition_feedback_trigger(
                    work["id"], expected_revision=work["revision"],
                    status="development_run", development_episode={
                        "id": episode["id"], "package_id": episode["package_id"],
                        "package_digest": episode["package_digest"],
                    })
            resuming_search = work["status"] == "candidate_generation_started" \
                and (work.get("development_plan") or {}).get("source_ref") \
                == "orchestration_search"
            if work["status"] == "candidate_generation_started" and not resuming_search:
                # Direct generation has no caller-supplied idempotency key. A
                # restart cannot distinguish an uncalled provider from an
                # uncommitted response, so it must never replay that boundary.
                return self._defer(work, "candidate_generation_outcome_unknown")
            if work["status"] not in {"development_run", "candidate_generation_started"}:
                return work
            if resuming_search:
                try:
                    plan = self._stored_development_plan(work)
                except (KeyError, ValueError, ContractError):
                    return self._defer(work, "orchestration_search_intent_invalid")
            else:
                episode = self.tasks.get_private(work["development_episode"]["id"])
                if episode["status"] not in _TERMINAL:
                    try:
                        episode = self.tasks.run(episode["id"], stop_event=stop_event)
                    except Exception:
                        # The same Episode remains the only recovery identity. A
                        # later drain may resume it without creating a duplicate.
                        return self.store.feedback_trigger(work["id"])
                if episode["status"] not in _TERMINAL:
                    return self.store.feedback_trigger(work["id"])
                if episode["status"] != "completed" or episode.get("usage", {}).get(
                        "usage_complete") is not True:
                    return self.store.transition_feedback_trigger(
                        work["id"], expected_revision=work["revision"], status="rejected",
                        reason="development_episode_incomplete")
                try:
                    if set(episode["output_refs"]) != {"development_plan"}:
                        raise ContractError("Development Episode did not publish one plan")
                    artifact = self.store.read(
                        episode["output_refs"]["development_plan"], episode["id"])
                    plan = self._validate_plan(
                        artifact["content"], work["development_intent"]["options"])
                    plan_ref = self._plan_reference(artifact, plan)
                except (KeyError, ValueError, ContractError):
                    return self.store.transition_feedback_trigger(
                        work["id"], expected_revision=work["revision"], status="rejected",
                        reason="development_plan_rejected")
                if plan["candidate_type"] == "no_change":
                    return self.store.transition_feedback_trigger(
                        work["id"], expected_revision=work["revision"], status="no_change",
                        reason=plan["reason"][:200], development_plan=plan_ref)
                if stop_event is not None and stop_event.is_set():
                    return work
                if plan["source_ref"] == "orchestration_search":
                    provisional = {**work, "development_plan": plan_ref}
                    try:
                        search_intent = self._search_intent(provisional)
                    except (KeyError, ValueError, ContractError):
                        return self.store.transition_feedback_trigger(
                            work["id"], expected_revision=work["revision"],
                            status="rejected", reason="orchestration_search_unavailable",
                            development_plan=plan_ref)
                else:
                    search_intent = None
                work = self.store.transition_feedback_trigger(
                    work["id"], expected_revision=work["revision"],
                    status="candidate_generation_started", development_plan=plan_ref,
                    search_intent=search_intent)
            try:
                generated = self._dispatch_plan(work, plan, stop_event=stop_event)
                candidate = (self._search_candidate_reference(generated)
                             if plan["source_ref"] == "orchestration_search"
                             else self._candidate_reference(
                                 generated, plan["candidate_type"]))
            except (KeyError, ValueError, ContractError):
                if plan["source_ref"] == "orchestration_search":
                    return self._defer(work, "orchestration_search_outcome_unknown")
                candidate = None
            except Exception:
                return self._defer(
                    work, "orchestration_search_outcome_unknown"
                    if plan["source_ref"] == "orchestration_search"
                    else "candidate_generation_outcome_unknown")
            if candidate is None:
                if stop_event is not None and stop_event.is_set():
                    # The generation boundary was entered but produced no
                    # candidate. Repetition is unsafe after cancellation.
                    return self._defer(work, "candidate_generation_interrupted")
                return self.store.transition_feedback_trigger(
                    work["id"], expected_revision=work["revision"], status="rejected",
                    reason=("orchestration_search_" + generated.get("status", "rejected")
                            if plan["source_ref"] == "orchestration_search"
                            else "candidate_generation_rejected"))
            return self.store.transition_feedback_trigger(
                work["id"], expected_revision=work["revision"], status="candidate_ready",
                candidate=candidate)

    def drain_development(self, *, limit=16, stop_event=None):
        """Advance captured work without running selection, guard, or promotion."""
        rows = self.store.feedback_triggers(
            statuses=["feedback_captured", "development_planned", "development_run",
                      "candidate_generation_started"],
            limit=limit)
        results = []
        for row in rows:
            if stop_event is not None and stop_event.is_set():
                break
            results.append(self.develop(row["id"], stop_event=stop_event))
        return results

    def _adapter(self, work):
        """Resolve only the host-installed evaluator frozen by policy."""
        evaluator_id = work["policy"]["evaluator_id"]
        try:
            adapter = self.tasks._benchmark_registry().get(evaluator_id)
        except Exception as exc:
            raise ContractError("Independent evaluator is unavailable") from exc
        if getattr(adapter, "id", None) != evaluator_id:
            raise ContractError("Independent evaluator identity changed")
        snapshot = _finite_json(adapter.snapshot(), "Independent evaluator snapshot")
        frozen = ((work.get("evolution") or {}).get("selection_intent") or {}).get(
            "snapshot_digest")
        if frozen is not None and frozen != digest(snapshot):
            raise ContractError("Independent evaluator snapshot changed")
        return adapter, snapshot

    @staticmethod
    def _reference(record, *, fields=("id", "record_digest")):
        result = {key: deepcopy(record[key]) for key in fields}
        if any(not isinstance(value, str) or not value for value in result.values()):
            raise ContractError("Evolution evidence reference is invalid")
        return result

    def _recover_run(self, kind, plan_id, adapter, runner, *, stop_event=None):
        """Return an immutable completed run or decline to replay uncertainty."""
        evolution, _ = self._services()
        claim = evolution.inspect_run_claim(kind, plan_id)
        if claim is None:
            return None
        if claim["status"] == "running" and claim.get("durable_record_id") is not None:
            evolution.recover_run_claim(kind, plan_id)
            claim = evolution.inspect_run_claim(kind, plan_id)
        if claim is None or claim["status"] != "completed":
            return None
        return runner(plan_id, adapter, stop_event=stop_event)

    def evolve(self, identity, *, stop_event=None):
        """Advance one ready candidate through independent selection and guard."""
        work = self.store.feedback_trigger(identity)
        with self.store.lock(work["source_episode_id"]):
            work = self.store.feedback_trigger(identity)
            terminal = {"completed", "rejected", "rolled_back", "deferred",
                        "no_change"}
            if work["status"] in terminal:
                return work
            if work["status"] in {"selection_plan_started", "guard_plan_started"}:
                # Neither planning API accepts a caller idempotency key.  A
                # restart cannot prove whether its immutable plan committed.
                return self._defer(work, work["status"] + "_outcome_unknown")
            if work["status"] not in {
                    "candidate_ready", "selection_planned", "selection_run",
                    "paired_assessed", "guard_planned", "promoted", "guard_run",
                    "guard_assessed"}:
                return work

            evolution, _ = self._services()
            try:
                adapter, snapshot = self._adapter(work)
            except ContractError:
                return self._defer(work, "independent_evaluator_unavailable_or_changed")
            candidate_id = work["candidate"]["candidate_id"]

            if work["status"] == "candidate_ready":
                if stop_event is not None and stop_event.is_set():
                    return work
                intent = {
                    "evaluator_id": work["policy"]["evaluator_id"],
                    "snapshot_digest": digest(snapshot),
                    "split": work["policy"]["selection_split"], "seed": 0,
                }
                work = self.store.transition_feedback_trigger(
                    work["id"], expected_revision=work["revision"],
                    status="selection_plan_started",
                    evolution_update={"selection_intent": intent})
                try:
                    from .evolution import PromotionPolicy
                    plan = evolution.plan_pair(
                        candidate_id, adapter, split=intent["split"],
                        split_role="selection", seed=intent["seed"],
                        budget=deepcopy(work["policy"]["budget"]),
                        policy=PromotionPolicy(**work["policy"]["promotion_policy"]))
                except ContractError:
                    return self._defer(work, "selection_plan_rejected")
                except Exception:
                    return self._defer(work, "selection_plan_outcome_unknown")
                work = self.store.transition_feedback_trigger(
                    work["id"], expected_revision=work["revision"],
                    status="selection_planned",
                    evolution_update={"selection_plan": self._reference(plan)})

            if work["status"] == "selection_planned":
                if stop_event is not None and stop_event.is_set():
                    return work
                plan_id = work["evolution"]["selection_plan"]["id"]
                try:
                    trial = evolution.run_pair(
                        plan_id, adapter, stop_event=stop_event)
                except Exception:
                    try:
                        trial = self._recover_run(
                            "paired", plan_id, adapter, evolution.run_pair,
                            stop_event=stop_event)
                    except Exception:
                        trial = None
                    if trial is None:
                        return self._defer(work, "selection_run_outcome_unknown")
                if stop_event is not None and stop_event.is_set():
                    # run_pair is idempotent after its durable claim commits;
                    # keep the coordinator before assessment and promotion.
                    return work
                work = self.store.transition_feedback_trigger(
                    work["id"], expected_revision=work["revision"],
                    status="selection_run",
                    evolution_update={"selection_trial": self._reference(trial)})

            if work["status"] == "selection_run":
                if stop_event is not None and stop_event.is_set():
                    return work
                try:
                    decision = evolution.assess(
                        work["evolution"]["selection_trial"]["id"])
                except ContractError:
                    return self.store.transition_feedback_trigger(
                        work["id"], expected_revision=work["revision"],
                        status="rejected", reason="paired_assessment_rejected")
                decision_ref = self._reference(decision)
                decision_ref["eligible"] = decision["eligible"] is True
                work = self.store.transition_feedback_trigger(
                    work["id"], expected_revision=work["revision"],
                    status="paired_assessed",
                    evolution_update={"selection_decision": decision_ref})

            if work["status"] == "paired_assessed":
                if work["evolution"]["selection_decision"]["eligible"] is not True:
                    return self.store.transition_feedback_trigger(
                        work["id"], expected_revision=work["revision"],
                        status="rejected", reason="independent_selection_rejected")
                if stop_event is not None and stop_event.is_set():
                    return work
                intent = {
                    "evaluator_id": work["policy"]["evaluator_id"],
                    "snapshot_digest": digest(snapshot),
                    "split": work["policy"]["guard_split"], "seed": 0,
                }
                work = self.store.transition_feedback_trigger(
                    work["id"], expected_revision=work["revision"],
                    status="guard_plan_started",
                    evolution_update={"guard_intent": intent})
                try:
                    plan = evolution.plan_monitor(
                        candidate_id, adapter, split=intent["split"],
                        seed=intent["seed"],
                        budget=deepcopy(work["policy"]["budget"]))
                except ContractError:
                    return self._defer(work, "guard_plan_rejected")
                except Exception:
                    return self._defer(work, "guard_plan_outcome_unknown")
                work = self.store.transition_feedback_trigger(
                    work["id"], expected_revision=work["revision"],
                    status="guard_planned",
                    evolution_update={"guard_plan": self._reference(plan)})

            if work["status"] == "guard_planned":
                if stop_event is not None and stop_event.is_set():
                    return work
                decision_id = work["evolution"]["selection_decision"]["id"]
                monitor_plan_id = work["evolution"]["guard_plan"]["id"]
                candidate = evolution.candidate(candidate_id)
                active = evolution.active(work["channel_id"])
                promotion = active.get("promotion") or {}
                if (active["package_id"] == candidate["package_id"]
                        and promotion.get("candidate_id") == candidate_id
                        and promotion.get("decision_id") == decision_id
                        and promotion.get("monitor_plan_id") == monitor_plan_id):
                    promoted = active
                else:
                    try:
                        promoted = evolution.promote(
                            candidate_id, decision_id,
                            monitor_plan_id=monitor_plan_id)
                    except Exception:
                        active = evolution.active(work["channel_id"])
                        promotion = active.get("promotion") or {}
                        if not (active["package_id"] == candidate["package_id"]
                                and promotion.get("candidate_id") == candidate_id
                                and promotion.get("decision_id") == decision_id
                                and promotion.get("monitor_plan_id") == monitor_plan_id):
                            return self._defer(work, "promotion_outcome_unknown")
                        promoted = active
                work = self.store.transition_feedback_trigger(
                    work["id"], expected_revision=work["revision"], status="promoted",
                    evolution_update={"promotion": {
                        "revision": promoted["revision"],
                        "package_id": promoted["package_id"],
                        "package_digest": promoted["package_digest"],
                    }})

            if work["status"] == "promoted":
                if stop_event is not None and stop_event.is_set():
                    return work
                promoted = work["evolution"]["promotion"]
                plan_id = work["evolution"]["guard_plan"]["id"]
                try:
                    guard = evolution.run_monitor(
                        work["channel_id"], adapter,
                        stop_event=stop_event,
                        expected_revision=promoted["revision"],
                        expected_package_id=promoted["package_id"],
                        expected_monitor_plan_id=plan_id)
                except Exception:
                    try:
                        guard = self._recover_run(
                            "monitor", plan_id, adapter,
                            lambda identity, frozen_adapter, *, stop_event=None:
                            evolution.run_monitor(
                                work["channel_id"], frozen_adapter,
                                stop_event=stop_event,
                                expected_revision=promoted["revision"],
                                expected_package_id=promoted["package_id"],
                                expected_monitor_plan_id=identity),
                            stop_event=stop_event)
                    except Exception:
                        guard = None
                    if guard is None:
                        return self._defer(work, "guard_run_outcome_unknown")
                if stop_event is not None and stop_event.is_set():
                    # The monitor claim can be replayed without running tasks;
                    # defer assessment/rollback until the caller resumes.
                    return work
                guard_ref = self._reference(guard)
                guard_ref["episode_ids"] = list(guard["episode_ids"])
                work = self.store.transition_feedback_trigger(
                    work["id"], expected_revision=work["revision"],
                    status="guard_run", evolution_update={"guard_run": guard_ref})

            if work["status"] == "guard_run":
                if stop_event is not None and stop_event.is_set():
                    return work
                promoted = work["evolution"]["promotion"]
                plan_id = work["evolution"]["guard_plan"]["id"]
                try:
                    result = evolution.monitor(
                        work["channel_id"],
                        work["evolution"]["guard_run"]["episode_ids"],
                        rollback_on_regression=True,
                        expected_revision=promoted["revision"],
                        expected_package_id=promoted["package_id"],
                        expected_monitor_plan_id=plan_id)
                except Exception:
                    return self._defer(work, "guard_assessment_outcome_unknown")
                assessment = {
                    "degraded": result["degraded"] is True,
                    "rolled_back": result["rolled_back"] is True,
                    "metrics_digest": digest(result["metrics"]),
                    "active_package_id": result["active"]["package_id"],
                    "active_revision": result["active"]["revision"],
                }
                work = self.store.transition_feedback_trigger(
                    work["id"], expected_revision=work["revision"],
                    status="guard_assessed",
                    evolution_update={"guard_assessment": assessment})

            if work["status"] == "guard_assessed":
                assessment = work["evolution"]["guard_assessment"]
                if assessment["rolled_back"]:
                    status, reason = "rolled_back", "guard_regression_rolled_back"
                elif assessment["degraded"]:
                    status, reason = "rejected", "guard_regression"
                else:
                    status, reason = "completed", None
                return self.store.transition_feedback_trigger(
                    work["id"], expected_revision=work["revision"],
                    status=status, reason=reason)
            return work

    def drain_evolution(self, *, limit=16, stop_event=None):
        """Advance a bounded page of ready/active adoption work."""
        rows = self.store.feedback_triggers(statuses=[
            "candidate_ready", "selection_plan_started", "selection_planned",
            "selection_run", "paired_assessed", "guard_plan_started",
            "guard_planned", "promoted", "guard_run", "guard_assessed",
        ], limit=limit)
        results = []
        for row in rows:
            if stop_event is not None and stop_event.is_set():
                break
            results.append(self.evolve(row["id"], stop_event=stop_event))
        return results

    def advance(self, *, limit=16, stop_event=None):
        """Run one bounded coordinator pass across all three durable queues."""
        captured = self.drain(limit=limit)
        developed = self.drain_development(limit=limit, stop_event=stop_event)
        evolved = self.drain_evolution(limit=limit, stop_event=stop_event)
        return {"feedback": captured, "development": developed,
                "evolution": evolved}

    def _record_reuse(self, episode, registration):
        if registration is None:
            return []
        completed = self.store.feedback_triggers(statuses=["completed"], limit=256)
        recorded = []
        for work in completed:
            promoted = (work.get("evolution") or {}).get("promotion") or {}
            if (work.get("channel_id") != registration["channel"]
                    or promoted.get("revision") != registration["revision"]
                    or promoted.get("package_id") != episode.get("package_id")
                    or promoted.get("package_digest") != episode.get("package_digest")):
                continue
            try:
                candidate = self._services()[0].candidate(
                    work["candidate"]["candidate_id"])
                package = self.store.package(candidate["package_id"])
                execution = episode.get("execution") or {}
                target = candidate.get("component_target")
                if target is not None:
                    from .evolution import _loaded_evidence
                    activation = _loaded_evidence(target, execution, package)
                else:
                    probe = candidate.get("activation_probe") or {}
                    path = probe.get("path")
                    loaded = path in (execution.get("loaded_modules") or [])
                    activation = {"loaded": loaded, "legacy": True, "path": path}
                if activation.get("loaded") is not True:
                    continue
                evidence = {
                    "episode_id": episode["id"], "package_id": episode["package_id"],
                    "package_digest": episode["package_digest"],
                    "channel_revision": registration["revision"],
                    "component_id": candidate.get("component_id"),
                    "activation": activation,
                    "activation_digest": digest(activation),
                }
                recorded.append(self.store.record_feedback_reuse(work["id"], evidence))
            except (KeyError, ValueError, ContractError):
                continue
        return recorded

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
        if episode.get("failure_domain") == "infrastructure":
            return self._defer(work, "source_infrastructure_failure")
        if self.store.usage(episode["id"]).get("usage_complete") is not True:
            return self._defer(work, "source_usage_incomplete")
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
        observed = []
        for identity in episode_ids:
            record = self.observe_terminal(identity)
            if record is not None:
                observed.append(record)
        advanced = self.drain(limit=limit) if drain else []
        return {
            "observed": observed,
            "advanced": advanced,
            "next_cursor": episode_ids[-1] if len(episode_ids) == limit else None,
        }
