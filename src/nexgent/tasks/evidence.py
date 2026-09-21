"""Sanitized evidence exports for one complete package-evolution mechanism run.

The exporter is intentionally read-only.  It verifies the records already
written by ``GenerationService`` and ``EvolutionService`` and emits only
identities, digests, bounded usage summaries, gates, and event-chain refs.  In
particular it never exports AgentPackage source or evaluator-private payloads.
"""

from __future__ import annotations

from collections import Counter
from copy import deepcopy
import json
from pathlib import Path

from ..kernel.programs import digest
from .tools import ContractError


SCHEMA = "nexgent.rsi-mechanism-evidence.v1"
_USAGE_KEYS = (
    "model_calls", "reserved_completion_tokens", "charged_completion_tokens",
    "completion_tokens", "tool_calls", "reserved_tool_work_units",
    "tool_work_units", "charged_tool_work_units", "tool_usage_missing_call_ids",
    "nodes", "usage_complete",
)
def _usage(value):
    value = value or {}
    return {key: deepcopy(value.get(key)) for key in _USAGE_KEYS}


def _episode(tasks, identity):
    try:
        return tasks.get_private(identity)
    except KeyError:
        raise ContractError(f"Evidence Episode is not local: {identity}") from None


def _channel_registration(episode, channel):
    registration = episode["task"].get("context", {}).get("package_channel_registration")
    if not isinstance(registration, dict) or registration.get("channel") != channel:
        raise ContractError("Evidence Episode is not bound to the requested package channel")
    return registration


def _terminal(episode, label):
    if episode.get("status") not in {"completed", "failed"}:
        raise ContractError(f"{label} Episode is not terminal")


def build_rsi_mechanism_evidence(
    tasks,
    evolution,
    generation,
    *,
    channel,
    feedback_bundle_id,
    generation_id,
    selection_plan_id,
    trial_id,
    decision_id,
    monitor_plan_id,
    promoted_episode_id,
    guard_episode_ids,
    rollback_episode_id,
):
    """Verify and summarize one deterministic RSI mechanism closure.

    This proves that the control-plane mechanism executed end to end.  It does
    not make a statistical or scientific claim that the candidate is better.
    """
    if not isinstance(guard_episode_ids, list) or not guard_episode_ids:
        raise ContractError("Evidence export requires guard Episode identities")

    feedback = generation.feedback(feedback_bundle_id)
    generated = generation.generation(generation_id)
    candidate = evolution.candidate(generated["candidate_id"])
    plan = evolution.plan(selection_plan_id)
    trial = evolution.trial(trial_id)
    decision = evolution.decision(decision_id)
    monitor_plan = evolution.monitor_plan(monitor_plan_id)
    monitor_run = evolution.monitor_run(monitor_plan_id)
    events = evolution.events(channel)
    active = evolution.active(channel)
    verified_generation = evolution._verify_generated_candidate(candidate)

    if generated.get("status") != "generated":
        raise ContractError("Evidence generation did not produce a candidate")
    if not (
        feedback["channel"] == generated["channel"] == candidate["channel"] == channel
        and generated["feedback_bundle_id"] == feedback_bundle_id
        and verified_generation.get("id") == generated["id"] == generation_id
        and candidate["id"] == generated["candidate_id"]
        and candidate["origin"] == "generated"
        and plan["id"] == trial["plan_id"] == selection_plan_id
        and plan["candidate_id"] == trial["candidate_id"] == decision["candidate_id"] == candidate["id"]
        and trial["id"] == decision["trial_id"] == trial_id
        and plan["split_role"] == trial["split_role"] == "selection"
        and monitor_plan["candidate_id"] == candidate["id"]
        and monitor_plan["id"] == monitor_plan_id
        and monitor_run["monitor_plan_id"] == monitor_plan_id
        and monitor_run["suite_digest"] == monitor_plan["suite_digest"]
        and Counter(monitor_run["episode_ids"]) == Counter(guard_episode_ids)
    ):
        raise ContractError("RSI evidence records do not form one linked closure")
    if generated.get("execution", {}).get("entry") != "improve":
        raise ContractError("Candidate generation lacks an actual improve-entry receipt")
    if generated.get("execution", {}).get("package_digest") != generated["improver_package_digest"]:
        raise ContractError("Improver execution package identity changed")
    if not decision.get("eligible") or not all(decision.get("gates", {}).values()):
        raise ContractError("Selection decision did not pass every frozen gate")
    if decision["gates"].get("behavior_activated") is not True:
        raise ContractError("Candidate component activation was not observed")

    promoted = _episode(tasks, promoted_episode_id)
    _terminal(promoted, "Post-promotion")
    promoted_registration = _channel_registration(promoted, channel)
    if (
        promoted["package_id"] != candidate["package_id"]
        or promoted["package_digest"] != candidate["package_digest"]
        or promoted_registration.get("package_id") != candidate["package_id"]
    ):
        raise ContractError("Post-promotion Episode did not load the generated child")

    guard_rows = []
    planned_tasks = Counter(digest(task) for task in monitor_plan["suite"]["tasks"])
    observed_tasks = Counter()
    run_reports = {row.get("episode_id"): row for row in monitor_run.get("reports", [])
                   if isinstance(row, dict) and isinstance(row.get("episode_id"), str)}
    if (len(run_reports) != len(monitor_run.get("reports", []))
            or Counter(run_reports.keys()) != Counter(monitor_run.get("episode_ids", []))):
        raise ContractError("Monitoring run reports do not match its Episode identities")
    for identity in guard_episode_ids:
        episode = _episode(tasks, identity)
        _terminal(episode, "Guard")
        registration = _channel_registration(episode, channel)
        monitoring = episode["task"].get("context", {}).get("monitoring_registration")
        if (
            episode["package_id"] != candidate["package_id"]
            or registration.get("package_id") != candidate["package_id"]
            or not isinstance(monitoring, dict)
            or monitoring.get("monitor_plan_id") != monitor_plan_id
            or monitoring.get("suite_digest") != monitor_plan["suite_digest"]
            or monitoring.get("task_ref_digest") not in planned_tasks
        ):
            raise ContractError("Guard Episode is outside the pre-registered monitor plan")
        if not isinstance(episode.get("evaluation"), dict):
            raise ContractError("Guard Episode has no evaluator-bound report")
        frozen_report = run_reports.get(identity)
        if (not isinstance(frozen_report, dict)
                or frozen_report.get("evaluation") != episode.get("evaluation")):
            raise ContractError("Guard Episode changed after its immutable monitor run")
        if episode.get("usage", {}).get("usage_complete") is not True:
            raise ContractError("Guard Episode usage is incomplete")
        observed_tasks[monitoring["task_ref_digest"]] += 1
        guard_rows.append({
            "episode_id": identity,
            "package_id": episode["package_id"],
            "package_digest": episode["package_digest"],
            "task_ref_digest": monitoring["task_ref_digest"],
            "evaluation_digest": digest(episode["evaluation"]),
            "usage": _usage(episode.get("usage")),
        })
    if observed_tasks != planned_tasks:
        raise ContractError("Guard Episodes do not cover the complete planned task multiset")

    rolled_back = _episode(tasks, rollback_episode_id)
    _terminal(rolled_back, "Post-rollback")
    rollback_registration = _channel_registration(rolled_back, channel)
    if (
        active["package_id"] != candidate["parent_package_id"]
        or rolled_back["package_id"] != candidate["parent_package_id"]
        or rollback_registration.get("package_id") != candidate["parent_package_id"]
        or rollback_registration.get("revision") != active["revision"]
    ):
        raise ContractError("Post-rollback Episode did not load the restored parent")

    event_refs = [
        {"sequence": event["sequence"], "kind": event["kind"],
         "previous": event["previous"], "digest": event["digest"]}
        for event in events
    ]

    def linked_event(kind, matches):
        selected = [event for event in events
                    if event["kind"] == kind and matches(event["content"])]
        if not selected:
            raise ContractError(f"RSI evidence lacks linked event: {kind}")
        return selected[-1]

    linked_events = [
        linked_event("channel_registered", lambda content:
                     content.get("package_id") == candidate["parent_package_id"]),
        linked_event("feedback_captured", lambda content:
                     content.get("feedback_bundle_id") == feedback["id"]),
        linked_event("candidate_admitted", lambda content:
                     content.get("candidate_id") == candidate["id"]),
        linked_event("candidate_generated", lambda content:
                     content.get("generation_id") == generated["id"]
                     and content.get("candidate_id") == candidate["id"]),
        linked_event("paired_trial_planned", lambda content:
                     content.get("plan_id") == plan["id"]),
        linked_event("paired_trial_recorded", lambda content:
                     content.get("trial_id") == trial["id"]
                     and content.get("plan_id") == plan["id"]),
        linked_event("promotion_assessed", lambda content:
                     content.get("decision_id") == decision["id"]
                     and content.get("trial_id") == trial["id"]),
        linked_event("monitoring_planned", lambda content:
                     content.get("monitor_plan_id") == monitor_plan["id"]),
        linked_event("package_promoted", lambda content:
                     content.get("candidate_id") == candidate["id"]
                     and content.get("decision_id") == decision["id"]
                     and content.get("monitor_plan_id") == monitor_plan["id"]),
        linked_event("monitoring_run_recorded", lambda content:
                     content.get("monitor_run_id") == monitor_run["id"]
                     and content.get("monitor_plan_id") == monitor_plan["id"]
                     and Counter(content.get("episode_ids", [])) == Counter(guard_episode_ids)),
        linked_event("deployment_monitored", lambda content:
                     content.get("degraded") is True
                     and {row.get("episode_id") for row in content.get("observations", [])}
                     == set(guard_episode_ids)),
        linked_event("package_rolled_back", lambda content:
                     content.get("from_package_id") == candidate["package_id"]
                     and content.get("to_package_id") == candidate["parent_package_id"]
                     and content.get("reason") == "monitoring_regression"),
    ]
    if [event["sequence"] for event in linked_events] != sorted(
            event["sequence"] for event in linked_events):
        raise ContractError("RSI evidence event chain is out of order")

    paired_runs = []
    for pair in trial["pairs"]:
        paired_runs.append({
            "task_ref_digest": pair["task_ref_digest"],
            "memory_seed_digest": pair["memory_seed_digest"],
            "arm_order": deepcopy(pair["arm_order"]),
            "parent": {
                "episode_id": pair["parent"]["episode_id"],
                "evaluation_digest": digest(pair["parent"]["evaluation"]),
                "usage": _usage(pair["parent"].get("usage")),
            },
            "candidate": {
                "episode_id": pair["candidate"]["episode_id"],
                "evaluation_digest": digest(pair["candidate"]["evaluation"]),
                "usage": _usage(pair["candidate"].get("usage")),
            },
        })

    feedback_episode_refs = []
    for row in feedback["episode_refs"]:
        if not isinstance(row.get("evaluation"), dict):
            raise ContractError("Mechanism evidence requires evaluator-bound development feedback")
        feedback_episode_refs.append({
            "episode_id": row["episode_id"],
            "package_id": row["package_id"],
            "package_digest": row["package_digest"],
            "task_digest": row["task"]["digest"],
            "evaluation_digest": row["evaluation"]["digest"],
            "usage_digest": row["usage"]["digest"],
            "usage": deepcopy(row["usage"]["summary"]),
        })

    body = {
        "schema": SCHEMA,
        "claim_scope": {
            "mechanism_closed_loop": True,
            "statistical_rsi_benefit_established": False,
            "claim": "deterministic_mechanism_closure_only",
        },
        "channel": channel,
        "packages": {
            "parent": {"id": candidate["parent_package_id"],
                       "digest": candidate["parent_package_digest"]},
            "candidate": {"id": candidate["package_id"],
                          "digest": candidate["package_digest"]},
            "improver": {"id": generated["improver_package_id"],
                         "digest": generated["improver_package_digest"],
                         "entry": generated["improver_entry"],
                         "closure_digest": generated["improver_closure_digest"]},
        },
        "feedback": {
            "bundle_id": feedback["id"], "bundle_digest": feedback["digest"],
            "record_digest": feedback["record_digest"],
            "episode_refs": feedback_episode_refs,
        },
        "generation": {
            "generation_id": generated["id"],
            "record_digest": generated["record_digest"],
            "improver_episode_id": generated["episode_id"],
            "behavior_patch_digest": generated["patch_digest"],
            "candidate_id": candidate["id"],
            "candidate_record_digest": candidate["record_digest"],
            "candidate_evidence_digest": candidate["evidence_digest"],
            "component_delta": deepcopy(candidate["component_delta"]),
            "activation_probe": deepcopy(candidate["activation_probe"]),
            "usage": _usage(generated.get("usage")),
        },
        "selection": {
            "plan_id": plan["id"], "plan_digest": plan["record_digest"],
            "suite_digest": plan["suite_digest"], "policy_digest": plan["policy_digest"],
            "trial_id": trial["id"], "trial_digest": trial["record_digest"],
            "decision_id": decision["id"], "decision_digest": decision["record_digest"],
            "eligible": decision["eligible"], "gates": deepcopy(decision["gates"]),
            "measurements": deepcopy(decision["measurements"]),
            "paired_runs": paired_runs,
        },
        "deployment": {
            "promoted_episode_id": promoted["id"],
            "promoted_registration": deepcopy(promoted_registration),
            "promoted_episode_usage": _usage(promoted.get("usage")),
        },
        "monitoring": {
            "monitor_plan_id": monitor_plan["id"],
            "monitor_plan_digest": monitor_plan["record_digest"],
            "monitor_run_id": monitor_run["id"],
            "monitor_run_digest": monitor_run["record_digest"],
            "suite_digest": monitor_plan["suite_digest"],
            "guard_episodes": guard_rows,
            "rollback_observed": True,
        },
        "rollback": {
            "active_parent_id": active["package_id"],
            "active_parent_digest": active["package_digest"],
            "channel_revision": active["revision"],
            "post_rollback_episode_id": rolled_back["id"],
            "post_rollback_registration": deepcopy(rollback_registration),
            "post_rollback_episode_usage": _usage(rolled_back.get("usage")),
        },
        "events": event_refs,
    }
    return {**body, "integrity_digest": digest(body)}


def export_rsi_mechanism_evidence(destination, *args, **kwargs):
    """Build evidence, write canonical JSON, and return its absolute path."""
    evidence = build_rsi_mechanism_evidence(*args, **kwargs)
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(
        json.dumps(evidence, ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False) + "\n",
        encoding="utf-8",
    )
    return str(destination.resolve())


P3_E1_SCHEMA = "nexgent.p3-e1-evidence.v1"
_P3_E1_REFS = frozenset({
    "feedback_bundle_id", "generation_id", "candidate_id",
    "selection_plan_id", "trial_id", "decision_id", "monitor_plan_id",
    "promoted_revision", "promoted_package_id", "monitor_run_id",
    "guard_episode_ids",
})
_PUBLIC_EVALUATION_KEYS = (
    "status", "score", "score_available", "accepted", "execution_status",
)


def _p3_e1_episode(tasks, identity, label):
    episode = _episode(tasks, identity)
    if episode.get("status") != "completed":
        raise ContractError(f"{label} Episode must be completed")
    if episode.get("usage", {}).get("usage_complete") is not True:
        raise ContractError(f"{label} Episode usage is incomplete")
    return episode


def _public_evaluation_metrics(value):
    if not isinstance(value, dict):
        return None
    return {key: deepcopy(value[key]) for key in _PUBLIC_EVALUATION_KEYS if key in value}


def _deliverable_digests(tasks, episode):
    refs = episode.get("output_refs")
    if not isinstance(refs, dict) or not refs:
        raise ContractError("Paired Episode has no delivered result")
    result = {}
    for name, artifact_id in refs.items():
        if not isinstance(name, str) or not isinstance(artifact_id, str):
            raise ContractError("Paired Episode deliverable references are invalid")
        try:
            artifact = tasks.store.read(artifact_id, episode["id"])
        except (KeyError, PermissionError, ValueError) as exc:
            raise ContractError("Paired Episode deliverable is unavailable") from exc
        producer = artifact.get("producer") or {}
        if (producer.get("episode_id") != episode["id"]
                or producer.get("package_digest") != episode["package_digest"]
                or not isinstance(artifact.get("content_digest"), str)):
            raise ContractError("Paired Episode deliverable provenance is invalid")
        result[name] = artifact["content_digest"]
    return result


def _event_ref(event):
    return {key: event[key] for key in ("sequence", "kind", "created", "previous", "digest")}


_HOST_TASK_CONTEXT_KEYS = frozenset({
    "package_channel_registration", "evolution_registration",
    "monitoring_registration", "improver_channel_registration",
    "memory_channel_registration", "memory_registration_digest",
    "memory_writeback",
})


def _task_identity_digest(task):
    """Digest caller-visible task identity without host execution bindings."""
    if not isinstance(task, dict):
        raise ContractError("P3 E1 task identity is invalid")
    context = deepcopy(task.get("context") or {})
    context_identity = context.pop("task_identity", None)
    identity = task.get("id") or context_identity
    if not isinstance(identity, str) or not identity:
        raise ContractError("P3 E1 task identity must be explicit")
    for key in _HOST_TASK_CONTEXT_KEYS:
        context.pop(key, None)
    public_task = {
        "id": identity,
        "statistical_unit_id": (task.get("statistical_unit_id")
                                or context.get("statistical_unit_id")),
        "cluster_id": task.get("cluster_id") or context.get("cluster_id"),
        "objective": task.get("objective"),
        "inputs": deepcopy(task.get("inputs") or {}),
        "deliverables": deepcopy(task.get("deliverables") or []),
        "capabilities": deepcopy(task.get("capabilities") or []),
        "constraints": deepcopy(task.get("constraints") or {}),
        "context": context,
    }
    return digest(public_task)


def _task_content_digest(task):
    """Digest task semantics while excluding partition and identity labels."""
    if not isinstance(task, dict):
        raise ContractError("P3 E1 task content is invalid")
    context = deepcopy(task.get("context") or {})
    for key in (_HOST_TASK_CONTEXT_KEYS | frozenset({
            "split", "split_role", "task_identity", "statistical_unit_id",
            "cluster_id", "qualification_role"})):
        context.pop(key, None)
    return digest({
        "objective": task.get("objective"),
        "inputs": deepcopy(task.get("inputs") or {}),
        "deliverables": deepcopy(task.get("deliverables") or []),
        "capabilities": deepcopy(task.get("capabilities") or []),
        "constraints": deepcopy(task.get("constraints") or {}),
        "context": context,
    })


def _p3_e1_registration(tasks, episode, cycle, label):
    registration = tasks.store.benchmark_registration(episode["id"])
    selection = cycle.get("selection") or {}
    guard = cycle.get("guard") or {}
    if (selection.get("benchmark_id") != guard.get("benchmark_id")
            or selection.get("snapshot_digest") != guard.get("snapshot_digest")):
        raise ContractError("P3 E1 adapters do not share one frozen benchmark")
    if (not isinstance(registration, dict)
            or registration.get("benchmark_id") != selection.get("benchmark_id")
            or digest(registration.get("snapshot")) != selection.get("snapshot_digest")
            or not isinstance(registration.get("task_ref"), dict)):
        raise ContractError(f"{label} Episode lacks the frozen P3 E1 benchmark binding")
    task_ref = registration["task_ref"]
    context = episode.get("task", {}).get("context", {})
    if (context.get("task_identity") != task_ref.get("id")
            or context.get("statistical_unit_id") != task_ref.get("statistical_unit_id")
            or context.get("cluster_id") != task_ref.get("cluster_id")):
        raise ContractError(f"{label} Episode task identity differs from its frozen task")
    evaluation_events = [event for event in episode.get("events") or []
                         if event.get("kind") == "benchmark_evaluated"]
    if (not evaluation_events
            or evaluation_events[-1].get("content", {}).get("report")
            != episode.get("evaluation")
            or digest(evaluation_events[-1].get("content", {}).get("snapshot"))
            != selection.get("snapshot_digest")):
        raise ContractError(f"{label} Episode evaluation is outside its frozen benchmark")
    return task_ref


def _statistical_identity(task_ref, label):
    unit = task_ref.get("statistical_unit_id")
    cluster = task_ref.get("cluster_id")
    if (not isinstance(unit, str) or not unit
            or not isinstance(cluster, str) or not cluster):
        raise ContractError(f"{label} task lacks statistical unit or cluster identity")
    return unit, cluster


def _p3_e1_model_receipt(generation_episode, generated):
    calls = generation_episode.get("calls") or []
    if len(calls) != 1:
        raise ContractError("P3 E1 generation requires exactly one model call")
    call = calls[0]
    identity_keys = (
        "model", "provider_model", "configured_provider_model",
        "observed_provider_model", "request_digest", "profile_digest",
    )
    usage = call.get("usage")
    if (call.get("role") != "rsi_improver"
            or call.get("status") != "received"
            or call.get("billing_status") != "usage_reported"
            or any(not isinstance(call.get(key), str) or not call[key]
                   for key in identity_keys)
            or type(call.get("finished_at")) not in {int, float}
            or not isinstance(usage, dict)):
        raise ContractError("P3 E1 model receipt identity or terminal status is incomplete")
    required_usage = {key: usage.get(key) for key in (
        "prompt_tokens", "completion_tokens", "total_tokens")}
    if (any(type(value) is not int or value < 0 for value in required_usage.values())
            or required_usage["prompt_tokens"] + required_usage["completion_tokens"]
            != required_usage["total_tokens"]):
        raise ContractError("P3 E1 model receipt usage is inconsistent")
    for value in usage.values():
        if isinstance(value, dict):
            if any(type(item) is not int or item < 0 for item in value.values()):
                raise ContractError("P3 E1 model detail usage is inconsistent")
        elif type(value) is not int or value < 0:
            raise ContractError("P3 E1 model usage contains an invalid counter")
    if digest(call.get("output")) != generated.get("patch_digest"):
        raise ContractError("P3 E1 model output does not match the admitted patch")
    aggregate = generation_episode.get("usage") or {}
    known = aggregate.get("known_usage") or {}
    if (aggregate.get("usage_complete") is not True
            or aggregate.get("model_calls") != 1
            or aggregate.get("completion_tokens") != required_usage["completion_tokens"]
            or any(known.get(key) != value for key, value in required_usage.items())
            or aggregate.get("usage_missing_call_ids") != []
            or aggregate.get("billing_unknown_call_ids") != []):
        raise ContractError("P3 E1 aggregate model usage differs from its receipt")
    revision = call.get("provider_revision")
    assurance = "provider_revision" if isinstance(revision, str) and revision else (
        "request_alias_time_window")
    return {
        "call_id_digest": digest(call.get("call_id")),
        "role": "rsi_improver",
        "status": "received",
        "billing_status": "usage_reported",
        "model_identity_digest": digest({key: call[key] for key in identity_keys[:4]}),
        "request_digest": call["request_digest"],
        "profile_digest": call["profile_digest"],
        "provider_revision_digest": digest(revision) if assurance == "provider_revision" else None,
        "identity_assurance": assurance,
        "output_digest": generated["patch_digest"],
        "usage": required_usage,
    }


def build_p3_e1_evidence(cycles, *, cycle_id, reuse_episode_ids):
    """Verify and sanitize one successful real-model P3 E1 pilot.

    The cycle remains the authoritative coordinator.  This function only
    follows its immutable references and proves that the promoted behavior was
    subsequently loaded by ordinary channel work.  No package source,
    FeedbackBundle body, evaluator-private field, or model response is copied.
    """
    if (not isinstance(reuse_episode_ids, list) or not reuse_episode_ids
            or len(reuse_episode_ids) > 128
            or any(not isinstance(item, str) or not item for item in reuse_episode_ids)
            or len(set(reuse_episode_ids)) != len(reuse_episode_ids)):
        raise ContractError(
            "P3 E1 evidence requires unique reuse Episode ids")

    tasks = cycles.tasks
    evolution = cycles.evolution
    generation_service = cycles.generation
    cycle = cycles.get(cycle_id)
    if cycle.get("status") != "completed":
        raise ContractError("P3 E1 evidence requires a completed RSI cycle")
    result = cycle.get("result") or {}
    if (result.get("outcome") != "completed"
            or result.get("degraded") is not False
            or result.get("rolled_back") is not False):
        raise ContractError("P3 E1 guard must complete without degradation or rollback")
    refs = cycle.get("refs") or {}
    if not _P3_E1_REFS <= set(refs):
        raise ContractError("P3 E1 cycle evidence references are incomplete")
    if (not isinstance(refs.get("guard_episode_ids"), list)
            or not refs["guard_episode_ids"]):
        raise ContractError("P3 E1 cycle has no guard Episodes")

    generated = generation_service.generation(refs["generation_id"])
    if generated.get("status") != "generated":
        raise ContractError("P3 E1 generation did not produce a candidate")
    from .improver_seed import default_improver_package
    reference_improver = default_improver_package()
    if (generated.get("improver_package_id") != reference_improver["id"]
            or generated.get("improver_package_digest") != reference_improver["digest"]):
        raise ContractError("P3 E1 generation did not use the reference-os-v1 improver")
    candidate = evolution.candidate(refs["candidate_id"])
    verified_generation = evolution._verify_generated_candidate(candidate)
    feedback = generation_service.feedback(refs["feedback_bundle_id"])
    plan = evolution.plan(refs["selection_plan_id"])
    trial = evolution.trial(refs["trial_id"])
    decision = evolution.decision(refs["decision_id"])
    monitor_plan = evolution.monitor_plan(refs["monitor_plan_id"])
    monitor_run = evolution.monitor_run(refs["monitor_plan_id"])

    if not (
        generated["id"] == verified_generation.get("id") == refs["generation_id"]
        and generated.get("feedback_bundle_id") == feedback["id"]
        == refs["feedback_bundle_id"]
        and generated.get("candidate_id") == candidate["id"] == refs["candidate_id"]
        and generated.get("channel") == candidate.get("channel") == cycle.get("channel")
        and candidate.get("origin") == "generated"
        and candidate.get("parent_package_id") == cycle.get("parent_package_id")
        and candidate.get("parent_package_digest") == cycle.get("parent_package_digest")
        and plan["id"] == trial.get("plan_id") == refs["selection_plan_id"]
        and plan.get("candidate_id") == trial.get("candidate_id")
        == decision.get("candidate_id") == candidate["id"]
        and trial["id"] == decision.get("trial_id") == refs["trial_id"]
        and decision["id"] == refs["decision_id"]
        and plan.get("split_role") == trial.get("split_role") == "selection"
        and (plan.get("suite") or {}).get("benchmark_id")
        == cycle.get("selection", {}).get("benchmark_id")
        and digest((plan.get("suite") or {}).get("snapshot"))
        == cycle.get("selection", {}).get("snapshot_digest")
        and monitor_plan["id"] == monitor_run.get("monitor_plan_id")
        == refs["monitor_plan_id"]
        and (monitor_plan.get("suite") or {}).get("benchmark_id")
        == cycle.get("guard", {}).get("benchmark_id")
        and digest((monitor_plan.get("suite") or {}).get("snapshot"))
        == cycle.get("guard", {}).get("snapshot_digest")
        and monitor_plan.get("candidate_id") == candidate["id"]
        and monitor_run.get("id") == refs["monitor_run_id"]
        and monitor_run.get("channel") == cycle.get("channel")
        and monitor_run.get("package_id") == candidate.get("package_id")
        and monitor_run.get("package_digest") == candidate.get("package_digest")
        and monitor_run.get("suite_digest") == monitor_plan.get("suite_digest")
        and Counter(monitor_run.get("episode_ids") or [])
        == Counter(refs["guard_episode_ids"])
        and refs.get("promoted_package_id") == candidate.get("package_id")
        and result.get("active_package_id") == candidate.get("package_id")
        and result.get("active_revision") == refs.get("promoted_revision")
    ):
        raise ContractError("P3 E1 cycle references do not form one closed chain")

    generation_episode = _p3_e1_episode(
        tasks, generated.get("episode_id"), "Improver")
    if (generation_episode.get("package_id") != generated.get("improver_package_id")
            or generation_episode.get("package_digest")
            != generated.get("improver_package_digest")
            or generated.get("usage") != generation_episode.get("usage")
            or generated.get("execution") != generation_episode.get("execution")):
        raise ContractError("P3 E1 improver Episode does not match generation")
    model_receipt = _p3_e1_model_receipt(generation_episode, generated)

    activation = candidate.get("activation_probe") or {}
    if (decision.get("eligible") is not True
            or decision.get("gates", {}).get("behavior_activated") is not True
            or activation.get("kind") != "component_loaded"
            or not isinstance(activation.get("path"), str)):
        raise ContractError("P3 E1 selection lacks eligible component-loaded evidence")
    measurements = decision.get("measurements") or {}
    parent_measurements = measurements.get("parent") or {}
    candidate_measurements = measurements.get("candidate") or {}
    gains = {}
    for name in ("quality", "success_rate"):
        parent_value = parent_measurements.get(name)
        candidate_value = candidate_measurements.get(name)
        gains[name] = (candidate_value - parent_value
                       if type(parent_value) in {int, float}
                       and type(candidate_value) in {int, float} else None)

    paired_rows = []
    observable_change = False
    for pair in trial.get("pairs") or []:
        parent_run = pair.get("parent") or {}
        candidate_run = pair.get("candidate") or {}
        parent_episode = _p3_e1_episode(
            tasks, parent_run.get("episode_id"), "Selection parent")
        candidate_episode = _p3_e1_episode(
            tasks, candidate_run.get("episode_id"), "Selection candidate")
        if (parent_episode.get("package_id") != candidate.get("parent_package_id")
                or candidate_episode.get("package_id") != candidate.get("package_id")
                or activation["path"] not in (
                    (candidate_episode.get("execution") or {}).get("loaded_modules") or [])):
            raise ContractError("P3 E1 paired Episodes do not load the tested packages")
        parent_evaluation = _public_evaluation_metrics(parent_run.get("evaluation"))
        candidate_evaluation = _public_evaluation_metrics(candidate_run.get("evaluation"))
        parent_deliverables = _deliverable_digests(tasks, parent_episode)
        candidate_deliverables = _deliverable_digests(tasks, candidate_episode)
        changed_deliverables = sorted(
            name for name in set(parent_deliverables) & set(candidate_deliverables)
            if parent_deliverables[name] != candidate_deliverables[name])
        evaluation_changed = parent_evaluation != candidate_evaluation
        changed = evaluation_changed or bool(changed_deliverables)
        observable_change = observable_change or changed
        paired_rows.append({
            "task_ref_digest": pair.get("task_ref_digest"),
            "parent_episode_id": parent_episode["id"],
            "candidate_episode_id": candidate_episode["id"],
            "public_evaluation_changed": evaluation_changed,
            "changed_deliverables": changed_deliverables,
            "observable_change": changed,
        })
    if not paired_rows or not observable_change:
        raise ContractError("P3 E1 has no paired observable behavior change")
    if not any(type(value) in {int, float} and value > 0 for value in gains.values()):
        raise ContractError("P3 E1 paired selection has no strict measured gain")

    planned_guard_tasks = Counter(
        digest(task) for task in (monitor_plan.get("suite") or {}).get("tasks", []))
    observed_guard_tasks = Counter()
    reports = {row.get("episode_id"): row for row in monitor_run.get("reports") or []
               if isinstance(row, dict) and isinstance(row.get("episode_id"), str)}
    if (len(reports) != len(monitor_run.get("reports") or [])
            or Counter(reports.keys()) != Counter(refs["guard_episode_ids"])):
        raise ContractError("P3 E1 guard run reports are incomplete")
    guard_rows = []
    for identity in refs["guard_episode_ids"]:
        episode = _p3_e1_episode(tasks, identity, "Guard")
        registration = _channel_registration(episode, cycle["channel"])
        monitoring = episode.get("task", {}).get("context", {}).get(
            "monitoring_registration") or {}
        task_digest = monitoring.get("task_ref_digest")
        if (episode.get("package_id") != candidate.get("package_id")
                or episode.get("package_digest") != candidate.get("package_digest")
                or registration.get("revision") != refs["promoted_revision"]
                or registration.get("package_id") != candidate.get("package_id")
                or monitoring.get("monitor_plan_id") != monitor_plan["id"]
                or monitoring.get("suite_digest") != monitor_plan.get("suite_digest")
                or task_digest not in planned_guard_tasks
                or reports[identity].get("evaluation") != episode.get("evaluation")):
            raise ContractError("P3 E1 guard Episode is outside the frozen guard run")
        observed_guard_tasks[task_digest] += 1
        guard_rows.append({
            "episode_id": identity,
            "task_ref_digest": task_digest,
            "evaluation_digest": digest(episode.get("evaluation")),
            "usage": _usage(episode.get("usage")),
        })
    if observed_guard_tasks != planned_guard_tasks:
        raise ContractError("P3 E1 guard task coverage is incomplete")

    origin_task_digests = set()
    qualification_task_refs = []
    for row in feedback.get("episode_refs") or []:
        origin_episode = _p3_e1_episode(tasks, row.get("episode_id"), "Development")
        origin_task_ref = _p3_e1_registration(
            tasks, origin_episode, cycle, "Development")
        qualification_task_refs.append(origin_task_ref)
        origin_task_digests.add(_task_identity_digest(origin_episode.get("task")))
    selection_tasks = (plan.get("suite") or {}).get("tasks", [])
    guard_tasks = (monitor_plan.get("suite") or {}).get("tasks", [])
    qualification_task_refs.extend(selection_tasks)
    qualification_task_refs.extend(guard_tasks)
    selection_task_digests = {_task_identity_digest(task) for task in selection_tasks}
    guard_task_digests = {_task_identity_digest(task) for task in guard_tasks}
    prior_task_digests = (
        origin_task_digests | selection_task_digests | guard_task_digests)
    if not origin_task_digests or not selection_task_digests or not guard_task_digests:
        raise ContractError("P3 E1 qualification task identities are incomplete")
    statistical_identities = [
        _statistical_identity(task_ref, "Qualification")
        for task_ref in qualification_task_refs]
    prior_units = {unit for unit, _cluster in statistical_identities}
    clusters = {cluster for _unit, cluster in statistical_identities}
    if (len(prior_units) != len(statistical_identities) or len(clusters) != 1):
        raise ContractError("P3 E1 qualification statistical units are not independent")
    qualification_task_ref_digests = {
        digest(task_ref) for task_ref in qualification_task_refs}
    qualification_content_digests = {
        _task_content_digest(task_ref) for task_ref in qualification_task_refs}

    evolution_events = evolution.events(cycle["channel"])
    promotion_events = [event for event in evolution_events
                        if event["kind"] == "package_promoted"
                        and event["content"].get("candidate_id") == candidate["id"]
                        and event["content"].get("decision_id") == decision["id"]
                        and event["content"].get("monitor_plan_id") == monitor_plan["id"]
                        and event["content"].get("to_package_id") == candidate["package_id"]]
    if len(promotion_events) != 1:
        raise ContractError("P3 E1 promotion event is missing or ambiguous")
    promotion_event = promotion_events[0]
    monitor_run_events = [event for event in evolution_events
                          if event["kind"] == "monitoring_run_recorded"
                          and event["content"].get("monitor_run_id") == monitor_run["id"]
                          and Counter(event["content"].get("episode_ids") or [])
                          == Counter(refs["guard_episode_ids"])]
    monitor_events = [event for event in evolution_events
                      if event["kind"] == "deployment_monitored"
                      and event["content"].get("degraded") is False
                      and {row.get("episode_id") for row in
                           event["content"].get("observations") or []}
                      == set(refs["guard_episode_ids"])]
    if not monitor_run_events or not monitor_events:
        raise ContractError("P3 E1 successful guard events are missing")
    monitor_run_event = monitor_run_events[-1]
    monitor_event = monitor_events[-1]
    if not (promotion_event["sequence"] < monitor_run_event["sequence"]
            < monitor_event["sequence"]):
        raise ContractError("P3 E1 promotion and guard events are out of order")
    if any(event["kind"] == "package_rolled_back"
           and event["content"].get("from_package_id") == candidate["package_id"]
           for event in evolution_events[promotion_event["sequence"]:]):
        raise ContractError("P3 E1 promoted package was rolled back")

    reuse_rows = []
    for identity in reuse_episode_ids:
        episode = _p3_e1_episode(tasks, identity, "Reuse")
        registration = _channel_registration(episode, cycle["channel"])
        if (episode.get("package_id") != candidate.get("package_id")
                or episode.get("package_digest") != candidate.get("package_digest")
                or registration.get("revision") != refs["promoted_revision"]
                or registration.get("package_id") != candidate.get("package_id")
                or registration.get("package_digest") != candidate.get("package_digest")):
            raise ContractError("Reuse Episode is not bound to the promoted package revision")
        if (type(episode.get("created_at")) not in {int, float}
                or episode["created_at"] <= promotion_event["created"]
                or episode["created_at"] <= cycle.get("updated_at", 0)):
            raise ContractError("Reuse Episode did not occur after the completed promotion cycle")
        task_digest = _task_identity_digest(episode.get("task"))
        if task_digest in prior_task_digests:
            raise ContractError("Reuse Episode task was already used by qualification")
        reuse_task_ref = _p3_e1_registration(tasks, episode, cycle, "Reuse")
        task_ref_digest = digest(reuse_task_ref)
        reuse_unit, reuse_cluster = _statistical_identity(reuse_task_ref, "Reuse")
        if (task_ref_digest in qualification_task_ref_digests
                or reuse_unit in prior_units or reuse_cluster not in clusters):
            raise ContractError("Reuse Episode is not an unseen unit in the qualification cluster")
        content_digest = _task_content_digest(reuse_task_ref)
        if content_digest in qualification_content_digests:
            raise ContractError("Reuse Episode duplicates qualification task content")
        evaluation = episode.get("evaluation")
        public_evaluation = _public_evaluation_metrics(evaluation)
        if (not isinstance(evaluation, dict)
                or evaluation.get("score_available") is not True
                or evaluation.get("accepted") is not True):
            raise ContractError(
                "Reuse Episode requires a bound accepted public evaluation")
        reuse_rows.append({
            "episode_id": identity,
            "package_id": episode["package_id"],
            "package_digest": episode["package_digest"],
            "channel_revision": registration["revision"],
            "task_digest": task_digest,
            "task_ref_digest": task_ref_digest,
            "task_content_digest": content_digest,
            "statistical_unit_digest": digest(reuse_unit),
            "cluster_digest": digest(reuse_cluster),
            "deliverables": _deliverable_digests(tasks, episode),
            "evaluation_digest": digest(evaluation),
            "public_evaluation": public_evaluation,
            "usage": _usage(episode.get("usage")),
        })

    cycle_events = cycles.events(cycle_id)
    body = {
        "schema": P3_E1_SCHEMA,
        "claim_scope": {
            "single_persistent_behavior_instance": True,
            "cross_task_benefit_established": False,
            "statistical_rsi_benefit_established": False,
            "recursive_improver_benefit_established": False,
        },
        "cycle": {
            "id": cycle["id"], "record_digest": cycle["record_digest"],
            "channel": cycle["channel"], "status": cycle["status"],
            "events": [_event_ref(event) for event in cycle_events],
        },
        "packages": {
            "parent": {"id": candidate["parent_package_id"],
                       "digest": candidate["parent_package_digest"]},
            "candidate": {"id": candidate["package_id"],
                          "digest": candidate["package_digest"]},
            "improver": {"id": generated["improver_package_id"],
                         "digest": generated["improver_package_digest"]},
        },
        "generation": {
            "feedback_bundle_id": feedback["id"],
            "feedback_digest": feedback["digest"],
            "generation_id": generated["id"],
            "generation_record_digest": generated["record_digest"],
            "improver_episode_id": generation_episode["id"],
            "patch_digest": generated["patch_digest"],
            "candidate_id": candidate["id"],
            "candidate_record_digest": candidate["record_digest"],
            "model_receipt": model_receipt,
            "usage": _usage(generation_episode.get("usage")),
        },
        "selection": {
            "plan_id": plan["id"], "plan_digest": plan["record_digest"],
            "trial_id": trial["id"], "trial_digest": trial["record_digest"],
            "decision_id": decision["id"],
            "decision_digest": decision["record_digest"],
            "eligible": True, "activation_probe": deepcopy(activation),
            "gates": deepcopy(decision["gates"]),
            "strict_gain": gains,
            "paired_tasks": paired_rows,
        },
        "promotion": {
            "revision": refs["promoted_revision"],
            "package_id": refs["promoted_package_id"],
            "event": _event_ref(promotion_event),
        },
        "guard": {
            "monitor_plan_id": monitor_plan["id"],
            "monitor_plan_digest": monitor_plan["record_digest"],
            "monitor_run_id": monitor_run["id"],
            "monitor_run_digest": monitor_run["record_digest"],
            "degraded": False, "rolled_back": False,
            "episodes": guard_rows,
            "run_event": _event_ref(monitor_run_event),
            "assessment_event": _event_ref(monitor_event),
        },
        "reuse": reuse_rows,
    }
    return {**body, "integrity_digest": digest(body)}


def export_p3_e1_evidence(destination, cycles, *, cycle_id, reuse_episode_ids):
    """Build a P3 E1 evidence document and write canonical JSON."""
    evidence = build_p3_e1_evidence(
        cycles, cycle_id=cycle_id, reuse_episode_ids=reuse_episode_ids)
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(
        json.dumps(evidence, ensure_ascii=False, sort_keys=True, indent=2,
                   allow_nan=False) + "\n",
        encoding="utf-8",
    )
    return str(destination.resolve())


RECURSIVE_SCHEMA = "nexgent.recursive-improver-evidence.v1"


def build_recursive_improver_evidence(
    tasks, generation, improvers, meta, guards, *, channel,
    improver_feedback_id, improver_generation_id, meta_plan_id, meta_trial_id,
    meta_evaluation_id, improver_decision_id, guard_plan_id, guard_action_id,
    post_promotion_generation_id, next_improver_generation_id,
    recovery_generation_id,
):
    """Verify and sanitize one P4 recursive-improver mechanism closure."""
    feedback = improvers.feedback(improver_feedback_id)
    r1_generation = improvers.generation(improver_generation_id)
    candidate = improvers.candidate(r1_generation["candidate_id"])
    improvers._verify_generation(candidate)
    plan = meta.plan(meta_plan_id)
    trial = meta.trial(meta_trial_id)
    assessment = meta.evaluation(meta_evaluation_id)
    decision = improvers.decision(improver_decision_id)
    guard_plan = guards.plan(guard_plan_id)
    action = guards.action(guard_action_id)
    guard_run = guards.run_record(action["run_id"])
    post = generation.generation(post_promotion_generation_id)
    r2_generation = improvers.generation(next_improver_generation_id)
    r2_candidate = improvers.candidate(r2_generation["candidate_id"])
    improvers._verify_generation(r2_candidate)
    recovery = generation.generation(recovery_generation_id)
    active = improvers.active(channel)

    if not (
        feedback["channel"] == candidate["channel"] == plan["channel"] == channel
        and r1_generation["feedback_id"] == feedback["id"] == improver_feedback_id
        and candidate["generation_id"] == r1_generation["id"] == improver_generation_id
        and plan["candidate_id"] == assessment["candidate_id"] == decision["candidate_id"]
        == guard_plan["candidate_id"] == candidate["id"]
        and trial["plan_id"] == plan["id"] == meta_plan_id
        and assessment["trial_id"] == trial["id"] == meta_trial_id
        and decision["meta_evaluation_id"] == assessment["id"] == meta_evaluation_id
        and action["plan_id"] == guard_plan["id"] == guard_plan_id
        and guard_run["plan_id"] == guard_plan_id
        and action["run_id"] == guard_run["id"]
        and assessment.get("eligible") is True
        and action.get("degraded") is True and action.get("rolled_back") is True
    ):
        raise ContractError("Recursive improver records do not form one linked closure")
    if (post.get("status") != "generated"
            or post.get("improver_registration", {}).get("package_id") != candidate["package_id"]
            or post.get("improver_registration", {}).get("revision")
               != guard_plan["expected_deployed_revision"]):
        raise ContractError("Post-promotion generation did not load R1 through its channel")
    if (r2_generation.get("status") != "generated"
            or r2_generation.get("parent_improver_id") != candidate["package_id"]
            or r2_generation.get("candidate_id") != r2_candidate["id"]
            or r2_candidate.get("package_id") != r2_generation.get("candidate_package_id")):
        raise ContractError("Deployed R1 did not generate a direct R2 candidate")
    if (guard_run.get("generation", {}).get("improver_registration", {}).get("package_id")
            != candidate["package_id"]):
        raise ContractError("Guard did not load deployed R1 through its channel")
    if (active["package_id"] != candidate["parent_improver_id"]
            or recovery.get("status") != "generated"
            or recovery.get("improver_registration", {}).get("package_id") != active["package_id"]
            or recovery.get("improver_registration", {}).get("revision") != active["revision"]):
        raise ContractError("Recovery generation did not load rolled-back R0")

    events = improvers.events(channel)
    required = (
        ("improver_candidate_generated", lambda value:
         value.get("generation_id") == r1_generation["id"]),
        ("improver_promotion_assessed", lambda value:
         value.get("decision_id") == decision["id"]),
        ("improver_promoted", lambda value:
         value.get("candidate_id") == candidate["id"]
         and value.get("guard_plan_id") == guard_plan["id"]),
        ("improver_candidate_generated", lambda value:
         value.get("generation_id") == r2_generation["id"]),
        ("improver_rolled_back", lambda value:
         value.get("from_package_id") == candidate["package_id"]
         and value.get("to_package_id") == candidate["parent_improver_id"]),
    )
    selected = []
    start = 0
    for kind, predicate in required:
        match = next((event for event in events[start:]
                      if event["kind"] == kind and predicate(event["content"])), None)
        if match is None:
            raise ContractError(f"Recursive evidence lacks ordered event: {kind}")
        selected.append(match)
        start = events.index(match) + 1

    def generation_ref(record):
        registration = record.get("improver_registration") or {}
        return {
            "id": record["id"], "record_digest": record["record_digest"],
            "episode_id": record.get("episode_id"), "status": record.get("status"),
            "improver_package_id": record.get("improver_package_id"),
            "improver_package_digest": record.get("improver_package_digest"),
            "improver_channel": {key: registration.get(key) for key in
                                 ("channel", "revision", "package_id", "package_digest")},
            "candidate_id": record.get("candidate_id"),
            "candidate_package_id": record.get("candidate_package_id"),
            "candidate_package_digest": record.get("candidate_package_digest"),
            "usage": _usage(record.get("usage")),
        }

    body = {
        "schema": RECURSIVE_SCHEMA,
        "claim_scope": {
            "recursive_mechanism_closed_loop": True,
            "real_model_recursive_benefit_established": False,
            "statistical_rsi_benefit_established": False,
            "claim": "deterministic_recursive_mechanism_only",
        },
        "channel": channel,
        "improvers": {
            "R0": {"id": candidate["parent_improver_id"],
                   "digest": candidate["parent_improver_digest"]},
            "R1": {"id": candidate["package_id"], "digest": candidate["package_digest"]},
            "R2": {"id": r2_generation["candidate_package_id"],
                   "digest": r2_generation["candidate_package_digest"], "deployed": False},
        },
        "self_update": {
            "feedback_id": feedback["id"], "feedback_digest": feedback["digest"],
            "generation_id": r1_generation["id"],
            "generation_digest": r1_generation["record_digest"],
            "episode_id": r1_generation["episode_id"],
            "patch_digest": r1_generation["patch_digest"],
            "usage": _usage(r1_generation.get("usage")),
        },
        "meta_evaluation": {
            "plan_id": plan["id"], "plan_digest": plan["record_digest"],
            "protocol_digest": plan["protocol_digest"],
            "trial_id": trial["id"], "trial_digest": trial["record_digest"],
            "assessment_id": assessment["id"],
            "assessment_digest": assessment["record_digest"],
            "decision_id": decision["id"], "decision_digest": decision["record_digest"],
            "eligible": assessment["eligible"], "gates": deepcopy(assessment["gates"]),
            "measurements": deepcopy(assessment["measurements"]),
            "selected_descendants": deepcopy(assessment["selected_descendants"]),
        },
        "deployment": generation_ref(post),
        "next_self_update": {
            "generation_id": r2_generation["id"],
            "generation_digest": r2_generation["record_digest"],
            "episode_id": r2_generation["episode_id"],
            "candidate_id": r2_generation["candidate_id"],
            "candidate_package_id": r2_generation["candidate_package_id"],
            "candidate_package_digest": r2_generation["candidate_package_digest"],
            "usage": _usage(r2_generation.get("usage")),
        },
        "guard": {
            "plan_id": guard_plan["id"], "plan_digest": guard_plan["record_digest"],
            "protocol_digest": guard_plan["protocol_digest"],
            "run_id": guard_run["id"], "run_digest": guard_run["record_digest"],
            "action_id": action["id"], "action_digest": action["record_digest"],
            "measurement_complete": guard_run["measurement_complete"],
            "mean_utility": guard_run["mean_utility"],
            "success_rate": guard_run["success_rate"],
            "degraded": action["degraded"], "rolled_back": action["rolled_back"],
            "usage": _usage(guard_run.get("usage")),
        },
        "recovery": generation_ref(recovery),
        "events": [{"sequence": event["sequence"], "kind": event["kind"],
                    "previous": event["previous"], "digest": event["digest"]}
                   for event in events],
    }
    return {**body, "integrity_digest": digest(body)}


def export_recursive_improver_evidence(destination, *args, **kwargs):
    evidence = build_recursive_improver_evidence(*args, **kwargs)
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(
        json.dumps(evidence, ensure_ascii=False, sort_keys=True, indent=2,
                   allow_nan=False) + "\n", encoding="utf-8")
    return str(destination.resolve())
