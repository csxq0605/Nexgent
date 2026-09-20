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
    "completion_tokens", "tool_calls", "nodes", "usage_complete",
)
def _usage(value):
    value = value or {}
    return {key: deepcopy(value.get(key)) for key in _USAGE_KEYS}


def _episode(tasks, identity):
    try:
        return tasks.get(identity)
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
