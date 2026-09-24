"""Host-owned benchmark outcome classification for task Episodes.

The runtime records why an Episode failed.  Benchmark control planes use this
module to apply one frozen interpretation of that evidence: attributable
agent/protocol failures are observed system outcomes, while infrastructure and
interruption remain missing measurements.  Evaluator output for completed
Episodes is never replaced or repaired here.
"""

from __future__ import annotations

from copy import deepcopy
import math


OUTCOME_POLICY_ID = "terminal-responsibility-v1"
ATTRIBUTABLE_FAILURE_DOMAINS = frozenset({"agent", "protocol"})


def outcome_policy():
    """Return the finite policy frozen into benchmark plans."""
    return {
        "id": OUTCOME_POLICY_ID,
        "observed_failure_statuses": ["failed"],
        "observed_failure_domains": sorted(ATTRIBUTABLE_FAILURE_DOMAINS),
        "observed_failure_score": 0.0,
        "infrastructure": "missing",
        "interrupted": "missing",
        "evaluator_unavailable": "missing",
    }


def classify_benchmark_outcome(state, evaluation=None):
    """Classify one Episode without turning unknown failures into zero scores.

    ``evaluation`` is authoritative only for a completed Episode.  A failed
    Episode is an observed zero only when the runtime attributed the terminal
    failure to the agent or its protocol.  Every other non-completed state is
    missing, including infrastructure faults and interrupted execution.
    """
    if not isinstance(state, dict):
        raise TypeError("Benchmark outcome state must be an object")
    status = state.get("status")
    failure_domain = state.get("failure_domain")

    if status == "completed":
        report = deepcopy(evaluation) if isinstance(evaluation, dict) else {
            "status": "unavailable", "score_available": False, "accepted": None,
            "execution_status": status,
        }
        report.setdefault("execution_status", status)
        measured = _measured(report)
        return {
            "policy_id": OUTCOME_POLICY_ID,
            "measurement_status": "measured" if measured else "missing",
            "failure_class": None if measured else "evaluator_missing",
            "evaluation": report,
        }

    if status == "failed" and failure_domain in ATTRIBUTABLE_FAILURE_DOMAINS:
        report = {
            "status": "observed_failure",
            "score_available": True,
            "score": 0.0,
            "accepted": False,
            "execution_status": status,
            "failure_domain": failure_domain,
            "outcome_policy_id": OUTCOME_POLICY_ID,
        }
        return {
            "policy_id": OUTCOME_POLICY_ID,
            "measurement_status": "measured",
            "failure_class": "observed_system_failure",
            "evaluation": report,
        }

    interrupted = status in {"ready", "running", "paused", "waiting_input", "cancelled"}
    report = {
        "status": "unavailable",
        "score_available": False,
        "accepted": None,
        "execution_status": status,
        "failure_domain": failure_domain,
        "outcome_policy_id": OUTCOME_POLICY_ID,
    }
    return {
        "policy_id": OUTCOME_POLICY_ID,
        "measurement_status": "missing",
        "failure_class": "interrupted_missing" if interrupted else "infrastructure_missing",
        "evaluation": report,
    }


def _measured(report):
    value = report.get("score")
    return (report.get("score_available") is True
            and type(report.get("accepted")) is bool
            and type(value) in {int, float}
            and math.isfinite(value))


__all__ = [
    "ATTRIBUTABLE_FAILURE_DOMAINS", "OUTCOME_POLICY_ID",
    "classify_benchmark_outcome", "outcome_policy",
]
