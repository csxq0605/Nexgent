"""Pure contract for durable mid-execution strategy checkpoints.

The runtime owns every identity passed to this module.  A model may only
suggest a target component (or ``None`` to continue) and a reason.  This
module resolves that suggestion against a frozen strategy candidate set and
binds it to durable Episode, plan, trigger, artifact, and root-budget facts.

Persistence, receipt lookup, artifact lookup, permission checks, and backend
execution deliberately remain outside this module.
"""

from __future__ import annotations

from copy import deepcopy
import json
import re

from ..kernel.programs import digest
from .strategy_decisions import validate_strategy_candidate_set
from .tools import ContractError


STRATEGY_CHECKPOINT_SCHEMA = "nexgent.strategy-checkpoint.v1"
MAX_STRATEGY_SWITCHES = 1
ROOT_BUDGET_FIELDS = frozenset({
    "model_calls", "completion_tokens", "tool_calls", "tool_work_units",
    "nodes",
})
ATTRIBUTABLE_TRIGGER_DOMAINS = frozenset({"agent", "protocol"})

_CHECKPOINT_FIELDS = frozenset({
    "schema", "episode_id", "root_episode_id", "package_digest",
    "candidate_set_digest", "decision_digest", "source_segment", "trigger",
    "plan", "root_budget", "handoff_artifact", "resolution",
    "checkpoint_digest",
})
_SOURCE_SEGMENT_FIELDS = frozenset({
    "segment_id", "component_id", "component_digest", "backend",
    "source_digest",
})
_TRIGGER_FIELDS = frozenset({
    "node_id", "receipt_digest", "receipt_status", "failure_domain",
})
_PLAN_FIELDS = frozenset({
    "ref", "revision", "completed_artifact_refs", "pending_node_ids",
})
_ROOT_BUDGET_FIELDS = frozenset({"usage", "remaining"})
_HANDOFF_FIELDS = frozenset({"ref", "digest"})
_MODEL_SUGGESTION_FIELDS = frozenset({"target_component_id", "reason"})
_RESOLUTION_FIELDS = frozenset({
    "action", "selected_component_id", "component_digest", "backend",
    "source_digest", "reason",
})

_DIGEST = re.compile(r"[0-9a-f]{64}")
_MAX_TEXT = 2000
_MAX_IDENTITY = 1000
_MAX_ITEMS = 512
_MAX_BUDGET_VALUE = 1_000_000_000_000_000


def _finite_json(value, label):
    try:
        return json.loads(json.dumps(value, ensure_ascii=False, allow_nan=False))
    except (TypeError, ValueError, RecursionError) as exc:
        raise ContractError(f"{label} must be finite JSON") from exc


def _identity(value, label):
    if (not isinstance(value, str) or not value.strip()
            or value != value.strip() or len(value) > _MAX_IDENTITY):
        raise ContractError(f"{label} must be a bounded nonempty text identity")
    return value


def _digest(value, label):
    if not isinstance(value, str) or _DIGEST.fullmatch(value) is None:
        raise ContractError(f"{label} must be a lowercase SHA-256 digest")
    return value


def _canonical_identities(value, label, *, allow_empty):
    if (not isinstance(value, (list, tuple)) or len(value) > _MAX_ITEMS
            or not allow_empty and not value):
        qualifier = "bounded" if allow_empty else "nonempty bounded"
        raise ContractError(f"{label} must be a {qualifier} identity list")
    result = [_identity(item, label) for item in value]
    if len(set(result)) != len(result):
        raise ContractError(f"{label} must not contain duplicates")
    return sorted(result)


def _budget_values(value, label):
    if not isinstance(value, dict) or set(value) != ROOT_BUDGET_FIELDS:
        raise ContractError(f"{label} must contain the exact root budget fields")
    result = {}
    for key in sorted(ROOT_BUDGET_FIELDS):
        amount = value[key]
        if type(amount) is not int or not 0 <= amount <= _MAX_BUDGET_VALUE:
            raise ContractError(
                f"{label}.{key} must be a bounded nonnegative integer")
        result[key] = amount
    return result


def _candidate_index(candidate_set):
    candidates = validate_strategy_candidate_set(candidate_set)
    return candidates, {
        candidate["component_id"]: candidate
        for candidate in candidates["candidates"]
    }


def _source_segment(segment_id, candidate):
    return {
        "segment_id": _identity(segment_id, "Source strategy segment id"),
        "component_id": candidate["component_id"],
        "component_digest": candidate["component_digest"],
        "backend": candidate["backend"],
        "source_digest": candidate["source_digest"],
    }


def _resolution(model_suggestion, source, candidate_by_id):
    suggestion = _finite_json(model_suggestion, "Strategy checkpoint suggestion")
    if (not isinstance(suggestion, dict)
            or set(suggestion) != _MODEL_SUGGESTION_FIELDS):
        raise ContractError(
            "Strategy checkpoint suggestion may contain only target_component_id and reason")
    reason = suggestion.get("reason")
    if (not isinstance(reason, str) or not reason.strip()
            or len(reason) > _MAX_TEXT):
        raise ContractError("Strategy checkpoint reason must be bounded nonempty text")

    target_id = suggestion.get("target_component_id")
    if target_id is None:
        action, selected = "continue", source
    else:
        _identity(target_id, "Strategy checkpoint target component id")
        if target_id not in candidate_by_id:
            raise ContractError("Strategy checkpoint selected an unknown component")
        if target_id == source["component_id"]:
            raise ContractError(
                "Continuing the source strategy must use a null target_component_id")
        action, selected = "switch", candidate_by_id[target_id]
        if selected["kind"] != "entry" or selected["backend"] != "controlled_code":
            raise ContractError(
                "StrategyCheckpoint v1 can switch only to an open-loop entry")
    return {
        "action": action,
        "selected_component_id": selected["component_id"],
        "component_digest": selected["component_digest"],
        "backend": selected["backend"],
        "source_digest": selected["source_digest"],
        "reason": reason.strip(),
    }


def build_strategy_checkpoint(
        *, episode_id, root_episode_id, candidate_set, decision_digest,
        source_segment_id, source_component_id, trigger, plan, root_budget,
        handoff_artifact, model_suggestion):
    """Build one host-attributed ``StrategyCheckpoint``.

    ``model_suggestion`` has exactly two fields: ``target_component_id`` and
    ``reason``.  A null target means continue.  All remaining arguments are
    durable host observations; candidate and source identities are projected
    from ``candidate_set`` rather than copied from model output.
    """
    candidates, candidate_by_id = _candidate_index(candidate_set)
    _identity(source_component_id, "Source strategy component id")
    source = candidate_by_id.get(source_component_id)
    if source is None:
        raise ContractError("Source strategy segment uses an unknown component")
    if source["kind"] != "workflow" or source["backend"] != "executable_plan":
        raise ContractError("StrategyCheckpoint v1 source must be a DAG workflow")

    trigger = _finite_json(trigger, "Strategy checkpoint trigger")
    if not isinstance(trigger, dict) or set(trigger) != _TRIGGER_FIELDS:
        raise ContractError("Strategy checkpoint trigger fields are invalid")
    failure_domain = trigger.get("failure_domain")
    if failure_domain not in ATTRIBUTABLE_TRIGGER_DOMAINS:
        raise ContractError(
            "Strategy checkpoint trigger must be an attributable agent or protocol failure")
    trigger_record = {
        "node_id": _identity(trigger.get("node_id"), "Trigger node id"),
        "receipt_digest": _digest(
            trigger.get("receipt_digest"), "Trigger receipt digest"),
        "receipt_status": trigger.get("receipt_status"),
        "failure_domain": failure_domain,
    }
    if trigger_record["receipt_status"] != "completed":
        raise ContractError("Strategy checkpoint trigger receipt must be completed")

    plan = _finite_json(plan, "Strategy checkpoint plan")
    if not isinstance(plan, dict) or set(plan) != _PLAN_FIELDS:
        raise ContractError("Strategy checkpoint plan fields are invalid")
    revision = plan.get("revision")
    if type(revision) is not int or revision < 1:
        raise ContractError("Strategy checkpoint plan revision must be positive")
    plan_record = {
        "ref": _identity(plan.get("ref"), "Strategy checkpoint plan ref"),
        "revision": revision,
        "completed_artifact_refs": _canonical_identities(
            plan.get("completed_artifact_refs"), "Completed artifact refs",
            allow_empty=True),
        "pending_node_ids": _canonical_identities(
            plan.get("pending_node_ids"), "Pending node ids", allow_empty=True),
    }
    if trigger_record["node_id"] in plan_record["pending_node_ids"]:
        raise ContractError("A durable trigger node cannot remain pending")

    root_budget = _finite_json(root_budget, "Strategy checkpoint root budget")
    if not isinstance(root_budget, dict) or set(root_budget) != _ROOT_BUDGET_FIELDS:
        raise ContractError("Strategy checkpoint root budget fields are invalid")
    budget_record = {
        "usage": _budget_values(root_budget.get("usage"), "Root budget usage"),
        "remaining": _budget_values(
            root_budget.get("remaining"), "Root budget remaining"),
    }

    handoff_artifact = _finite_json(
        handoff_artifact, "Strategy checkpoint handoff artifact")
    if (not isinstance(handoff_artifact, dict)
            or set(handoff_artifact) != _HANDOFF_FIELDS):
        raise ContractError("Strategy checkpoint handoff artifact fields are invalid")
    handoff_record = {
        "ref": _identity(handoff_artifact.get("ref"), "Handoff artifact ref"),
        "digest": _digest(
            handoff_artifact.get("digest"), "Handoff artifact digest"),
    }
    # The handoff is a new host artifact created at the checkpoint.  It is
    # intentionally distinct from artifacts produced by completed DAG nodes.

    body = {
        "schema": STRATEGY_CHECKPOINT_SCHEMA,
        "episode_id": _identity(episode_id, "Checkpoint Episode id"),
        "root_episode_id": _identity(
            root_episode_id, "Checkpoint root Episode id"),
        "package_digest": candidates["package_digest"],
        "candidate_set_digest": candidates["candidate_set_digest"],
        "decision_digest": _digest(decision_digest, "Strategy decision digest"),
        "source_segment": _source_segment(source_segment_id, source),
        "trigger": trigger_record,
        "plan": plan_record,
        "root_budget": budget_record,
        "handoff_artifact": handoff_record,
        "resolution": _resolution(model_suggestion, source, candidate_by_id),
    }
    return {**body, "checkpoint_digest": digest(body)}


def validate_strategy_checkpoint(checkpoint, candidate_set):
    """Validate a persisted checkpoint against its frozen candidate set."""
    checkpoint = _finite_json(checkpoint, "Strategy checkpoint")
    if (not isinstance(checkpoint, dict)
            or set(checkpoint) != _CHECKPOINT_FIELDS
            or checkpoint.get("schema") != STRATEGY_CHECKPOINT_SCHEMA):
        raise ContractError("Strategy checkpoint envelope is invalid")

    candidates, candidate_by_id = _candidate_index(candidate_set)
    if (checkpoint.get("package_digest") != candidates["package_digest"]
            or checkpoint.get("candidate_set_digest")
            != candidates["candidate_set_digest"]):
        raise ContractError("Strategy checkpoint candidate identity changed")
    _identity(checkpoint.get("episode_id"), "Checkpoint Episode id")
    _identity(checkpoint.get("root_episode_id"), "Checkpoint root Episode id")
    _digest(checkpoint.get("decision_digest"), "Strategy decision digest")

    source_segment = checkpoint.get("source_segment")
    if (not isinstance(source_segment, dict)
            or set(source_segment) != _SOURCE_SEGMENT_FIELDS):
        raise ContractError("Strategy checkpoint source segment is invalid")
    source_id = source_segment.get("component_id")
    source = candidate_by_id.get(source_id)
    if source is None or source_segment != _source_segment(
            source_segment.get("segment_id"), source):
        raise ContractError("Strategy checkpoint source identity changed")
    if source["kind"] != "workflow" or source["backend"] != "executable_plan":
        raise ContractError("StrategyCheckpoint v1 source must be a DAG workflow")

    trigger = checkpoint.get("trigger")
    if (not isinstance(trigger, dict) or set(trigger) != _TRIGGER_FIELDS
            or trigger.get("failure_domain") not in ATTRIBUTABLE_TRIGGER_DOMAINS
            or trigger.get("receipt_status") != "completed"):
        raise ContractError("Strategy checkpoint trigger is not attributable")
    _identity(trigger.get("node_id"), "Trigger node id")
    _digest(trigger.get("receipt_digest"), "Trigger receipt digest")

    plan = checkpoint.get("plan")
    if not isinstance(plan, dict) or set(plan) != _PLAN_FIELDS:
        raise ContractError("Strategy checkpoint plan is invalid")
    _identity(plan.get("ref"), "Strategy checkpoint plan ref")
    if type(plan.get("revision")) is not int or plan["revision"] < 1:
        raise ContractError("Strategy checkpoint plan revision must be positive")
    completed = _canonical_identities(
        plan.get("completed_artifact_refs"), "Completed artifact refs",
        allow_empty=True)
    pending = _canonical_identities(
        plan.get("pending_node_ids"), "Pending node ids", allow_empty=True)
    if (completed != plan["completed_artifact_refs"]
            or pending != plan["pending_node_ids"]
            or trigger["node_id"] in pending):
        raise ContractError("Strategy checkpoint plan identities are not canonical")

    root_budget = checkpoint.get("root_budget")
    if not isinstance(root_budget, dict) or set(root_budget) != _ROOT_BUDGET_FIELDS:
        raise ContractError("Strategy checkpoint root budget is invalid")
    if (_budget_values(root_budget.get("usage"), "Root budget usage")
            != root_budget["usage"]
            or _budget_values(root_budget.get("remaining"), "Root budget remaining")
            != root_budget["remaining"]):
        raise ContractError("Strategy checkpoint root budget is not canonical")

    handoff = checkpoint.get("handoff_artifact")
    if (not isinstance(handoff, dict) or set(handoff) != _HANDOFF_FIELDS):
        raise ContractError("Strategy checkpoint handoff artifact is invalid")
    _identity(handoff.get("ref"), "Handoff artifact ref")
    _digest(handoff.get("digest"), "Handoff artifact digest")

    resolution = checkpoint.get("resolution")
    if not isinstance(resolution, dict) or set(resolution) != _RESOLUTION_FIELDS:
        raise ContractError("Strategy checkpoint resolution is invalid")
    selected = candidate_by_id.get(resolution.get("selected_component_id"))
    if selected is None:
        raise ContractError("Strategy checkpoint resolution selected an unknown component")
    expected_resolution = {
        "action": resolution.get("action"),
        "selected_component_id": selected["component_id"],
        "component_digest": selected["component_digest"],
        "backend": selected["backend"],
        "source_digest": selected["source_digest"],
        "reason": resolution.get("reason"),
    }
    reason = resolution.get("reason")
    if (not isinstance(reason, str) or not reason.strip()
            or reason != reason.strip() or len(reason) > _MAX_TEXT
            or resolution != expected_resolution):
        raise ContractError("Strategy checkpoint resolution identity changed")
    if ((resolution["action"] == "continue"
         and selected["component_id"] != source_id)
            or (resolution["action"] == "switch"
                and selected["component_id"] == source_id)
            or (resolution["action"] == "switch"
                and (selected["kind"] != "entry"
                     or selected["backend"] != "controlled_code"))
            or resolution["action"] not in {"continue", "switch"}):
        raise ContractError("Strategy checkpoint resolution action is inconsistent")

    body = {key: deepcopy(checkpoint[key])
            for key in _CHECKPOINT_FIELDS - {"checkpoint_digest"}}
    if checkpoint.get("checkpoint_digest") != digest(body):
        raise ContractError("Strategy checkpoint identity changed")
    return checkpoint


__all__ = [
    "ATTRIBUTABLE_TRIGGER_DOMAINS", "MAX_STRATEGY_SWITCHES",
    "ROOT_BUDGET_FIELDS",
    "STRATEGY_CHECKPOINT_SCHEMA", "build_strategy_checkpoint",
    "validate_strategy_checkpoint",
]
