"""Safe read models for package evolution status surfaces.

The control plane retains complete immutable records.  Product surfaces expose
only deployment identities, decisions, aggregate measurements, and digests so
an evaluator implementation or private task payload cannot leak through an
information window.
"""

from __future__ import annotations

from copy import deepcopy


_EVENT_FIELDS = {
    "channel_registered": ("package_id", "package_digest"),
    "candidate_admitted": (
        "candidate_id", "parent_package_id", "package_id", "evidence_digest",
        "record_digest",
    ),
    "feedback_captured": (
        "feedback_bundle_id", "feedback_digest", "episode_ids", "parent_package_id",
        "channel_revision", "record_digest",
    ),
    "candidate_generated": (
        "generation_id", "feedback_bundle_id", "improver_episode_id", "improver_package_id",
        "improver_closure_digest", "patch_digest", "candidate_id", "candidate_package_id",
        "record_digest",
    ),
    "candidate_generation_missing": (
        "generation_id", "feedback_bundle_id", "episode_id", "reason_type",
        "reason_digest", "record_digest",
    ),
    "paired_trial_planned": (
        "candidate_id", "plan_id", "suite_digest", "policy_digest", "record_digest",
    ),
    "paired_trial_recorded": (
        "candidate_id", "plan_id", "trial_id", "suite_digest", "policy_digest",
        "record_digest",
    ),
    "monitoring_planned": (
        "candidate_id", "monitor_plan_id", "suite_digest", "record_digest",
    ),
    "monitoring_run_recorded": (
        "monitor_run_id", "monitor_plan_id", "suite_digest", "episode_ids", "record_digest",
    ),
    "promotion_assessed": (
        "decision_id", "trial_id", "eligible", "record_digest",
    ),
    "package_promoted": (
        "from_package_id", "to_package_id", "candidate_id", "decision_id",
        "trial_id", "monitor_plan_id", "monitor_plan_digest", "policy",
        "monitoring_thresholds", "decision_record_digest",
    ),
    "package_rolled_back": ("from_package_id", "to_package_id", "reason"),
    "deployment_monitored": ("metrics", "degraded", "thresholds"),
}


def public_channel_state(state):
    """Project an active channel without embedding AgentPackage source files."""
    return {key: deepcopy(state.get(key)) for key in (
        "channel", "package_id", "package_digest", "revision", "promotion",
        "updated_at",
    )}


def public_evolution_event(event):
    """Project an audit event through a kind-specific public allowlist."""
    kind = event.get("kind")
    content = event.get("content") if isinstance(event.get("content"), dict) else {}
    fields = _EVENT_FIELDS.get(kind, ())
    return {
        "channel": event.get("channel"),
        "sequence": event.get("sequence"),
        "kind": kind,
        "created": event.get("created"),
        "content": {key: deepcopy(content.get(key)) for key in fields if key in content},
        "previous": event.get("previous"),
        "digest": event.get("digest"),
    }


def public_channel_view(active, events, *, limit=50):
    """Build a bounded status view ordered as stored by the event chain."""
    if type(limit) is not int or limit < 1 or limit > 1000:
        raise ValueError("Evolution event limit must be between 1 and 1000")
    selected = list(events)[-limit:]
    return {
        "active": public_channel_state(active),
        "events": [public_evolution_event(event) for event in selected],
    }
