"""Independent statistical assessment of sealed four-arm RSI study records.

The assessor is deliberately pure: it receives an immutable plan and run,
validates their bindings, and returns a deterministic report.  It never owns a
benchmark adapter, TaskService, model client, or final-holdout capability.
"""

from __future__ import annotations

from copy import deepcopy
import math
import random

from ..kernel.programs import digest
from .costs import STANDARD_COST_WEIGHTS, normalized_work_projection
from .four_arm_studies import (
    ARM_IDS, FOUR_ARM_PLAN_SCHEMA, FOUR_ARM_RUN_SCHEMA,
)
from .tools import ContractError


FOUR_ARM_ASSESSMENT_SCHEMA = "nexgent.four-arm-assessment.v1"

# This is a versioned analysis contract, rather than a caller-controlled set of
# knobs.  Changing any value requires a new assessment schema.
_COMPARISONS = (
    ("E-F", "E", "F", "primary"),
    ("F-S", "F", "S", "auxiliary"),
    ("M-F", "M", "F", "auxiliary"),
)
_MIN_INDEPENDENT_CLUSTERS = 5
_CONFIDENCE = 0.95
_ALPHA = 0.05
_BOOTSTRAP_RESAMPLES = 10_000


def assessment_policy():
    """Return the frozen v1 analysis policy as finite JSON data."""
    return {
        "schema": "nexgent.four-arm-assessment-policy.v1",
        "primary_comparison": "E-F",
        "comparisons": [
            {"id": name, "treatment_arm": treatment,
             "reference_arm": reference, "role": role}
            for name, treatment, reference, role in _COMPARISONS
        ],
        "independent_unit": "source_cluster",
        "within_cluster_aggregation": "equal_weight_unit_mean",
        "across_cluster_aggregation": "equal_weight_cluster_mean",
        "missing_policy": "whole_quartet_fail_closed",
        "minimum_independent_clusters": _MIN_INDEPENDENT_CLUSTERS,
        "confidence": _CONFIDENCE,
        "alpha": _ALPHA,
        "interval": "cluster_percentile_bootstrap",
        "bootstrap_resamples": _BOOTSTRAP_RESAMPLES,
        "quality_test": "paired_two_sided_sign_flip",
        "multiple_comparison_adjustment": "holm",
        "success_gate": "primary_cluster_mean_noninferiority_at_zero",
        "charged_work_gate": "primary_cluster_mean_noninferiority_at_zero",
        "cost_projection_weights": deepcopy(STANDARD_COST_WEIGHTS),
    }


def _record_payload(record, label):
    if not isinstance(record, dict) or not isinstance(record.get("record_digest"), str):
        raise ContractError(f"{label} is not a sealed record")
    payload = {key: deepcopy(value) for key, value in record.items()
               if key != "record_digest"}
    if digest(payload) != record["record_digest"]:
        raise ContractError(f"{label} record digest mismatch")
    return payload


def _finite_number(value):
    return type(value) in {int, float} and math.isfinite(value)


def _percentile_interval(values, confidence, seed, resamples):
    if not values:
        return None
    rng = random.Random(seed)
    count = len(values)
    means = [
        sum(values[rng.randrange(count)] for _ in range(count)) / count
        for _ in range(resamples)
    ]
    means.sort()
    tail = (1.0 - confidence) / 2.0
    low = max(0, min(resamples - 1, int(tail * resamples)))
    high = max(0, min(resamples - 1,
                      int((1.0 - tail) * resamples) - 1))
    return [means[low], means[high]]


def _sign_flip_p(values, seed):
    """Return a two-sided paired randomization p-value over source clusters."""
    if not values:
        return None
    observed = abs(sum(values) / len(values))
    count = len(values)
    tolerance = 1e-15
    if count <= 20:
        total, extreme = 1 << count, 0
        for mask in range(total):
            mean = sum(
                value if mask & (1 << index) else -value
                for index, value in enumerate(values)
            ) / count
            extreme += abs(mean) >= observed - tolerance
        return extreme / total
    rng, samples, extreme = random.Random(seed), 100_000, 0
    for _ in range(samples):
        mean = sum(value if rng.randrange(2) else -value
                   for value in values) / count
        extreme += abs(mean) >= observed - tolerance
    return (extreme + 1) / (samples + 1)


def _holm_adjust(raw):
    """Holm-adjust a complete mapping of comparison id to raw p-value."""
    ordered = sorted(raw.items(), key=lambda item: (item[1], item[0]))
    adjusted, running, total = {}, 0.0, len(ordered)
    for rank, (name, value) in enumerate(ordered):
        running = max(running, min(1.0, (total - rank) * value))
        adjusted[name] = running
    return adjusted


def _mean(values):
    return sum(values) / len(values) if values else None


class FourArmAssessment:
    """Validate and assess one already completed four-arm plan/run pair."""

    @staticmethod
    def _validate_records(plan_record, run_record):
        plan = _record_payload(plan_record, "Four-arm plan")
        run = _record_payload(run_record, "Four-arm run")
        if (plan.get("schema") != FOUR_ARM_PLAN_SCHEMA
                or plan.get("status") != "registered"):
            raise ContractError("Four-arm assessment requires a v1 plan")
        if run.get("schema") != FOUR_ARM_RUN_SCHEMA or run.get("status") != "completed":
            raise ContractError("Four-arm assessment requires a completed v1 run")
        if (run.get("plan_id") != plan.get("id")
                or run.get("plan_digest") != plan_record["record_digest"]
                or run.get("protocol_digest") != plan.get("protocol_digest")):
            raise ContractError("Four-arm run does not match its sealed plan")
        if (plan.get("missing_policy") != "whole_quartet_fail_closed"
                or set((plan.get("arms") or {})) != set(ARM_IDS)):
            raise ContractError("Four-arm plan has an unsupported treatment contract")
        tasks, schedule, cells = plan.get("tasks"), plan.get("schedule"), run.get("cells")
        if not isinstance(tasks, list) or not tasks:
            raise ContractError("Four-arm plan has no tasks")
        units = []
        for task in tasks:
            if (not isinstance(task, dict)
                    or not isinstance(task.get("task_digest"), str)
                    or not task["task_digest"]
                    or not isinstance(task.get("statistical_unit_id"), str)
                    or not task["statistical_unit_id"]
                    or not isinstance(task.get("cluster_id"), str)
                    or not task["cluster_id"]):
                raise ContractError("Four-arm plan task identity is invalid")
            units.append(task["statistical_unit_id"])
        if len(set(units)) != len(units):
            raise ContractError("Four-arm plan statistical units are not unique")
        if not isinstance(schedule, list) or not isinstance(cells, list):
            raise ContractError("Four-arm plan or run structure is invalid")
        expected = {(index, arm) for index in range(len(tasks)) for arm in ARM_IDS}
        scheduled = {}
        for item in schedule:
            key = (item.get("row_index"), item.get("arm")) if isinstance(item, dict) else None
            if key not in expected or key in scheduled or not isinstance(item.get("cell_id"), str):
                raise ContractError("Four-arm schedule is not one complete quartet per task")
            scheduled[key] = item
        if set(scheduled) != expected:
            raise ContractError("Four-arm schedule is not one complete quartet per task")
        for index in range(len(tasks)):
            if sorted(scheduled[(index, arm)].get("position") for arm in ARM_IDS) != [0, 1, 2, 3]:
                raise ContractError("Four-arm schedule positions are invalid")

        rows = {}
        for cell in cells:
            key = (cell.get("row_index"), cell.get("arm")) if isinstance(cell, dict) else None
            if key not in expected or key in rows:
                raise ContractError("Four-arm run has duplicate or unexpected cells")
            index, arm = key
            task, arm_plan, slot = tasks[index], plan["arms"][arm], scheduled[key]
            if (cell.get("id") != slot["cell_id"]
                    or cell.get("position") != slot.get("position")
                    or cell.get("task_digest") != task.get("task_digest")
                    or cell.get("statistical_unit_id") != task.get("statistical_unit_id")
                    or cell.get("cluster_id") != task.get("cluster_id")
                    or cell.get("package_id") != arm_plan.get("package_id")
                    or cell.get("package_digest") != arm_plan.get("package_digest")
                    or cell.get("memory_release_digest")
                       != arm_plan.get("memory_release_digest")
                    or cell.get("status") not in {"measured", "missing"}):
                raise ContractError("Four-arm cell differs from its sealed treatment")
            rows[key] = deepcopy(cell)
        if set(rows) != expected:
            raise ContractError("Four-arm run lacks a complete set of cell records")

        projected_quartets = []
        for index, task in enumerate(tasks):
            statuses = {arm: rows[(index, arm)]["status"] for arm in ARM_IDS}
            projected_quartets.append({
                "row_index": index,
                "statistical_unit_id": task.get("statistical_unit_id"),
                "cluster_id": task.get("cluster_id"),
                "arm_statuses": statuses,
                "status": ("measured" if all(value == "measured"
                                               for value in statuses.values())
                           else "missing"),
            })
        if run.get("quartets") != projected_quartets:
            raise ContractError("Four-arm quartet projection differs from its cells")
        expected_complete = all(row["status"] == "measured"
                                for row in projected_quartets)
        if (type(run.get("measurement_complete")) is not bool
                or run["measurement_complete"] != expected_complete):
            raise ContractError("Four-arm completion flag differs from its quartets")
        return plan, run, rows

    @staticmethod
    def _quartets(plan, rows):
        complete, missing = [], []
        for index, task in enumerate(plan["tasks"]):
            arms, reasons = {}, []
            for arm in ARM_IDS:
                cell = rows[(index, arm)]
                projection = normalized_work_projection(
                    cell.get("usage"), STANDARD_COST_WEIGHTS)
                valid_measurement = (
                    cell["status"] == "measured"
                    and _finite_number(cell.get("score"))
                    and type(cell.get("accepted")) is bool
                    and cell.get("usage_complete") is True
                    and projection is not None
                )
                arms[arm] = {
                    "status": cell["status"],
                    "episode_id": cell.get("episode_id"),
                    "score": cell.get("score"),
                    "accepted": cell.get("accepted"),
                    "charged_work": (projection or {}).get("conservative_work"),
                    "reported_token_work": (projection or {}).get("reported_token_work"),
                    "usage_complete": cell.get("usage_complete") is True,
                    "failure_class": cell.get("failure_class"),
                    "reason": cell.get("reason"),
                }
                if not valid_measurement:
                    reasons.append({
                        "arm": arm,
                        "status": cell["status"],
                        "reason": (cell.get("reason") if cell["status"] == "missing"
                                   else "invalid_or_missing_metric_or_charged_work"),
                    })
            quartet = {
                "row_index": index,
                "statistical_unit_id": task["statistical_unit_id"],
                "cluster_id": task["cluster_id"],
                "arms": arms,
            }
            if reasons:
                missing.append({**quartet, "missing_cells": reasons})
            else:
                complete.append(quartet)
        return complete, missing

    def assess(self, plan_record, run_record):
        plan, run, rows = self._validate_records(plan_record, run_record)
        policy = assessment_policy()
        complete, missing = self._quartets(plan, rows)
        by_cluster = {}
        for quartet in complete:
            by_cluster.setdefault(quartet["cluster_id"], []).append(quartet)

        cluster_rows = []
        for cluster_id, members in sorted(by_cluster.items()):
            arms = {}
            for arm in ARM_IDS:
                arms[arm] = {
                    "mean_quality": _mean([row["arms"][arm]["score"] for row in members]),
                    "mean_success": _mean([int(row["arms"][arm]["accepted"])
                                           for row in members]),
                    "mean_charged_work": _mean([
                        row["arms"][arm]["charged_work"] for row in members]),
                }
            contrasts = {}
            for name, treatment, reference, _role in _COMPARISONS:
                contrasts[name] = {
                    "quality_delta": (arms[treatment]["mean_quality"]
                                      - arms[reference]["mean_quality"]),
                    "success_delta": (arms[treatment]["mean_success"]
                                      - arms[reference]["mean_success"]),
                    "charged_work_delta": (arms[treatment]["mean_charged_work"]
                                           - arms[reference]["mean_charged_work"]),
                }
            cluster_rows.append({"cluster_id": cluster_id,
                                 "unit_count": len(members),
                                 "arms": arms, "contrasts": contrasts})

        raw_p = {}
        comparisons = {}
        for name, treatment, reference, role in _COMPARISONS:
            values = {metric: [row["contrasts"][name][metric]
                               for row in cluster_rows]
                      for metric in ("quality_delta", "success_delta",
                                     "charged_work_delta")}
            seed_base = int(digest({"protocol": plan["protocol_digest"],
                                    "comparison": name})[:16], 16)
            raw_p[name] = _sign_flip_p(values["quality_delta"], seed_base)
            treatment_work = _mean([
                row["arms"][treatment]["mean_charged_work"] for row in cluster_rows])
            reference_work = _mean([
                row["arms"][reference]["mean_charged_work"] for row in cluster_rows])
            comparisons[name] = {
                "role": role, "treatment_arm": treatment,
                "reference_arm": reference,
                "independent_cluster_count": len(cluster_rows),
                "mean_quality_delta": _mean(values["quality_delta"]),
                "quality_interval": _percentile_interval(
                    values["quality_delta"], _CONFIDENCE, seed_base,
                    _BOOTSTRAP_RESAMPLES),
                "mean_success_delta": _mean(values["success_delta"]),
                "success_interval": _percentile_interval(
                    values["success_delta"], _CONFIDENCE, seed_base + 1,
                    _BOOTSTRAP_RESAMPLES),
                "mean_charged_work_delta": _mean(values["charged_work_delta"]),
                "charged_work_interval": _percentile_interval(
                    values["charged_work_delta"], _CONFIDENCE, seed_base + 2,
                    _BOOTSTRAP_RESAMPLES),
                "charged_work_ratio": (
                    treatment_work / reference_work if reference_work
                    and treatment_work is not None else
                    1.0 if treatment_work == reference_work == 0 else None),
                "paired_sign_flip_p": raw_p[name],
            }
        adjusted = _holm_adjust(raw_p) if all(value is not None
                                                   for value in raw_p.values()) else {}
        for name, value in adjusted.items():
            comparisons[name]["holm_adjusted_p"] = value

        cluster_count = len(cluster_rows)
        primary = comparisons["E-F"]
        full_quartets = not missing and len(complete) == len(plan["tasks"])
        enough = cluster_count >= _MIN_INDEPENDENT_CLUSTERS
        statistical = bool(
            enough and primary["mean_quality_delta"] is not None
            and primary["mean_quality_delta"] > 0
            and primary["quality_interval"] is not None
            and primary["quality_interval"][0] > 0
            and primary.get("holm_adjusted_p") is not None
            and primary["holm_adjusted_p"] < _ALPHA
        )
        statistical_gates = {
            "minimum_independent_clusters": enough,
            "primary_quality_support": statistical,
        }
        engineering_gates = {
            "whole_quartet_complete": full_quartets,
            "primary_success_noninferiority": (
                primary["mean_success_delta"] is not None
                and primary["mean_success_delta"] >= 0),
            "primary_charged_work_noninferiority": (
                primary["mean_charged_work_delta"] is not None
                and primary["mean_charged_work_delta"] <= 0),
        }
        statistical_support = all(statistical_gates.values())
        engineering_acceptance = all(engineering_gates.values())
        quality_effect_supported = statistical_support and full_quartets
        efficiency_supported = bool(
            quality_effect_supported
            and engineering_gates["primary_charged_work_noninferiority"])
        if not full_quartets or not enough:
            conclusion = "inconclusive"
        elif quality_effect_supported:
            conclusion = "benchmark_local_quality_treatment_effect_supported"
        else:
            conclusion = "benchmark_local_quality_treatment_effect_not_established"

        report = {
            "schema": FOUR_ARM_ASSESSMENT_SCHEMA,
            "plan_id": plan["id"], "plan_digest": plan_record["record_digest"],
            "run_id": run["id"], "run_digest": run_record["record_digest"],
            "protocol_digest": plan["protocol_digest"],
            "policy": policy, "policy_digest": digest(policy),
            "planned_quartet_count": len(plan["tasks"]),
            "complete_quartet_count": len(complete),
            "independent_cluster_count": cluster_count,
            "planned_cluster_count": len({row["cluster_id"] for row in plan["tasks"]}),
            "complete_quartets": complete,
            "missing_quartets": missing,
            "clusters": cluster_rows,
            "comparisons": comparisons,
            "statistical_gates": statistical_gates,
            "engineering_gates": engineering_gates,
            "statistical_support": statistical_support,
            "engineering_acceptance": engineering_acceptance,
            "conclusion": conclusion,
            "quality_treatment_effect_supported": quality_effect_supported,
            "efficiency_supported": efficiency_supported,
            "rsi_claim_eligible": False,
            "claim_scope": "benchmark_local_quality_treatment_effect",
            "limitations": [
                "The four-arm design does not identify an O/S-by-memory interaction.",
                ("The plan does not authenticate E as the descendant of a generation, "
                 "selection, promotion, and guard lineage."),
                ("Package or memory assignment does not prove that changed O/S "
                 "components or retrieved memory affected an Episode."),
                ("Equal hard limits do not imply equal realized work; a quality "
                 "difference may be caused by additional computation rather than "
                 "orchestration structure."),
                "The report does not include outer search or improvement cost.",
                ("Treatment performance alone is not evidence of benchmark-local or "
                 "general RSI capability."),
            ],
        }
        report["id"] = "four-arm-assessment-" + digest(report)[:24]
        report["record_digest"] = digest(report)
        return report


class FourArmAssessmentService:
    """Read sealed records through ``FourArmStudyService`` and assess them.

    This wrapper is the trusted application entry point.  Keeping the pure
    assessor separate makes the statistics testable without registering or
    consuming final-holdout units.
    """

    def __init__(self, four_arm_studies):
        if (not callable(getattr(four_arm_studies, "plan", None))
                or not callable(getattr(four_arm_studies, "run_record", None))):
            raise TypeError("FourArmAssessmentService requires a four-arm study reader")
        self.studies = four_arm_studies
        self.assessor = FourArmAssessment()

    def assess(self, run_id):
        if not isinstance(run_id, str) or not run_id:
            raise ContractError("Four-arm run id must be a nonempty string")
        run = self.studies.run_record(run_id)
        plan = self.studies.plan(run["plan_id"])
        return self.assessor.assess(plan, run)


def assess_four_arm(plan, run):
    """Assess already trusted sealed records without executing any task."""
    return FourArmAssessment().assess(plan, run)
