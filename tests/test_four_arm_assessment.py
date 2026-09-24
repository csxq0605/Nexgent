from copy import deepcopy
from pathlib import Path
import sys

import pytest


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from nexgent.kernel.programs import digest
from nexgent.tasks.four_arm_assessment import (
    FourArmAssessmentService, assess_four_arm,
)
from nexgent.tasks.four_arm_studies import (
    ARM_IDS, FOUR_ARM_PLAN_SCHEMA, FOUR_ARM_RUN_SCHEMA,
)
from nexgent.tasks.tools import ContractError


def _seal(value):
    value = deepcopy(value)
    value["record_digest"] = digest(value)
    return value


def _usage(work=10):
    return {
        "model_calls": work,
        "charged_completion_tokens": 0,
        "tool_calls": 0,
        "charged_tool_work_units": 0,
        "nodes": 0,
        "known_usage": {
            "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0,
        },
        "usage_missing_call_ids": [], "usage_complete": True,
    }


def _records(clusters, *, scores=None, success=None, work=None, missing=None):
    scores = scores or {"F": 0.4, "S": 0.2, "M": 0.6, "E": 0.8}
    success = success or {"F": False, "S": False, "M": True, "E": True}
    work = work or {arm: 10 for arm in ARM_IDS}
    missing = missing or set()
    arms = {
        arm: {
            "package_id": f"package-{arm}",
            "package_digest": f"package-digest-{arm}",
            "memory_release_digest": f"memory-{arm}" if arm in {"M", "E"} else None,
        }
        for arm in ARM_IDS
    }
    # M really uses F's frozen package in the execution contract.
    arms["M"]["package_id"] = arms["F"]["package_id"]
    arms["M"]["package_digest"] = arms["F"]["package_digest"]
    tasks, schedule = [], []
    for index, cluster_id in enumerate(clusters):
        tasks.append({
            "seed": index, "task_index": index,
            "task": {"objective": f"task {index}"},
            "task_digest": f"task-digest-{index}",
            "statistical_unit_id": f"unit-{index}", "cluster_id": cluster_id,
        })
        for position, arm in enumerate(ARM_IDS):
            schedule.append({"cell_id": f"cell-{index}-{arm}",
                             "row_index": index, "arm": arm,
                             "position": position})
    plan = _seal({
        "schema": FOUR_ARM_PLAN_SCHEMA, "id": "plan-1", "status": "registered",
        "protocol_digest": "protocol-1", "missing_policy": "whole_quartet_fail_closed",
        "tasks": tasks, "schedule": schedule, "arms": arms,
    })

    cells, quartets = [], []
    for index, task in enumerate(tasks):
        statuses = {}
        for position, arm in enumerate(ARM_IDS):
            is_missing = (index, arm) in missing
            status = "missing" if is_missing else "measured"
            statuses[arm] = status
            cells.append({
                "id": f"cell-{index}-{arm}", "row_index": index,
                "arm": arm, "position": position,
                "task_digest": task["task_digest"],
                "statistical_unit_id": task["statistical_unit_id"],
                "cluster_id": task["cluster_id"],
                "package_id": arms[arm]["package_id"],
                "package_digest": arms[arm]["package_digest"],
                "memory_release_digest": arms[arm]["memory_release_digest"],
                "status": status, "episode_id": f"episode-{index}-{arm}",
                "score": None if is_missing else scores[arm],
                "accepted": None if is_missing else success[arm],
                "usage": None if is_missing else _usage(work[arm]),
                "usage_complete": not is_missing,
                "failure_class": "infrastructure_missing" if is_missing else None,
                "reason": "finish:FixtureFailure" if is_missing else None,
            })
        quartets.append({
            "row_index": index,
            "statistical_unit_id": task["statistical_unit_id"],
            "cluster_id": task["cluster_id"], "arm_statuses": statuses,
            "status": ("measured" if all(value == "measured"
                                           for value in statuses.values())
                       else "missing"),
        })
    run = _seal({
        "schema": FOUR_ARM_RUN_SCHEMA, "id": "run-1", "status": "completed",
        "plan_id": plan["id"], "plan_digest": plan["record_digest"],
        "protocol_digest": plan["protocol_digest"],
        "measurement_complete": all(row["status"] == "measured" for row in quartets),
        "quartets": quartets, "cells": cells,
    })
    return plan, run


def test_assessment_supports_only_frozen_primary_after_cluster_inference_and_holm():
    plan, run = _records([f"source-{index}" for index in range(8)])

    report = assess_four_arm(plan, run)

    assert report["conclusion"] == (
        "benchmark_local_quality_treatment_effect_supported")
    assert report["quality_treatment_effect_supported"] is True
    assert report["efficiency_supported"] is True
    assert report["rsi_claim_eligible"] is False
    assert "rsi_gain_supported" not in report
    assert "rsi" not in report["conclusion"]
    assert report["claim_scope"] == "benchmark_local_quality_treatment_effect"
    assert report["independent_cluster_count"] == 8
    assert report["statistical_gates"] == {
        "minimum_independent_clusters": True,
        "primary_quality_support": True,
    }
    assert report["engineering_gates"] == {
        "whole_quartet_complete": True,
        "primary_success_noninferiority": True,
        "primary_charged_work_noninferiority": True,
    }
    assert list(report["comparisons"]) == ["E-F", "F-S", "M-F"]
    assert report["comparisons"]["E-F"]["mean_quality_delta"] == pytest.approx(0.4)
    assert report["comparisons"]["E-F"]["quality_interval"][0] > 0
    assert {row["paired_sign_flip_p"] for row in report["comparisons"].values()} == {
        0.0078125}
    assert {row["holm_adjusted_p"] for row in report["comparisons"].values()} == {
        0.0234375}
    assert report["comparisons"]["E-F"]["charged_work_ratio"] == 1.0
    assert report["policy"]["primary_comparison"] == "E-F"
    assert report["policy"]["minimum_independent_clusters"] == 5
    assert report["policy_digest"] == digest(report["policy"])
    assert assess_four_arm(plan, run) == report


def test_too_few_source_clusters_is_inconclusive_even_with_uniform_gain():
    plan, run = _records(["source-a", "source-b", "source-c", "source-d"])

    report = assess_four_arm(plan, run)

    assert report["complete_quartet_count"] == 4
    assert report["statistical_gates"]["minimum_independent_clusters"] is False
    assert report["conclusion"] == "inconclusive"
    assert report["quality_treatment_effect_supported"] is False


def test_many_seed_variants_from_one_source_are_still_one_cluster():
    plan, run = _records(["one-source"] * 8)

    report = assess_four_arm(plan, run)

    assert report["complete_quartet_count"] == 8
    assert report["independent_cluster_count"] == 1
    assert report["statistical_gates"]["minimum_independent_clusters"] is False
    assert report["conclusion"] == "inconclusive"


def test_any_missing_cell_excludes_whole_quartet_from_every_comparison():
    plan, run = _records(
        [f"source-{index}" for index in range(8)], missing={(0, "M")})

    report = assess_four_arm(plan, run)

    assert report["complete_quartet_count"] == 7
    assert report["independent_cluster_count"] == 7
    assert report["engineering_gates"]["whole_quartet_complete"] is False
    assert report["conclusion"] == "inconclusive"
    assert report["quality_treatment_effect_supported"] is False
    missing = report["missing_quartets"][0]
    assert missing["arms"]["M"]["status"] == "missing"
    assert missing["missing_cells"] == [{
        "arm": "M", "status": "missing", "reason": "finish:FixtureFailure",
    }]
    # All comparison families use the same seven complete source clusters.
    assert {row["independent_cluster_count"]
            for row in report["comparisons"].values()} == {7}


def test_cluster_means_are_equal_weighted_instead_of_counting_seed_variants():
    scores_by_arm = {"F": 0.0, "S": 0.0, "M": 0.0, "E": 0.0}
    plan, run = _records(["source-a", "source-a", "source-b"],
                         scores=scores_by_arm)
    # source-a has two unit deltas averaging 0.3; source-b has one delta 0.9.
    by_index = {0: 0.2, 1: 0.4, 2: 0.9}
    for cell in run["cells"]:
        if cell["arm"] == "E":
            cell["score"] = by_index[cell["row_index"]]
    run["record_digest"] = digest({key: value for key, value in run.items()
                                    if key != "record_digest"})

    report = assess_four_arm(plan, run)

    assert report["independent_cluster_count"] == 2
    assert report["clusters"][0]["contrasts"]["E-F"]["quality_delta"] == pytest.approx(0.3)
    assert report["clusters"][1]["contrasts"]["E-F"]["quality_delta"] == pytest.approx(0.9)
    assert report["comparisons"]["E-F"]["mean_quality_delta"] == pytest.approx(0.6)
    assert report["conclusion"] == "inconclusive"


def test_quality_statistics_and_success_work_engineering_gates_are_separate():
    plan, run = _records(
        [f"source-{index}" for index in range(8)],
        success={"F": True, "S": False, "M": True, "E": False},
        work={"F": 10, "S": 10, "M": 10, "E": 11},
    )

    report = assess_four_arm(plan, run)

    assert report["statistical_gates"]["primary_quality_support"] is True
    assert report["engineering_gates"]["primary_success_noninferiority"] is False
    assert report["engineering_gates"]["primary_charged_work_noninferiority"] is False
    assert report["statistical_support"] is True
    assert report["engineering_acceptance"] is False
    assert report["comparisons"]["E-F"]["mean_success_delta"] == -1.0
    assert report["comparisons"]["E-F"]["mean_charged_work_delta"] == 1.0
    assert report["conclusion"] == (
        "benchmark_local_quality_treatment_effect_supported")
    assert report["quality_treatment_effect_supported"] is True
    assert report["efficiency_supported"] is False


def test_invalid_usage_causes_whole_quartet_missingness():
    plan, run = _records([f"source-{index}" for index in range(6)])
    run["cells"][0]["usage"] = {"model_calls": 1}
    run["record_digest"] = digest({key: value for key, value in run.items()
                                    if key != "record_digest"})

    report = assess_four_arm(plan, run)

    assert report["complete_quartet_count"] == 5
    assert report["conclusion"] == "inconclusive"
    assert report["missing_quartets"][0]["missing_cells"][0]["reason"] == (
        "invalid_or_missing_metric_or_charged_work")


def test_assessment_rejects_tampered_plan_run_binding():
    plan, run = _records([f"source-{index}" for index in range(5)])
    run["cells"][0]["package_digest"] = "substituted"
    run["record_digest"] = digest({key: value for key, value in run.items()
                                    if key != "record_digest"})

    with pytest.raises(ContractError, match="sealed treatment"):
        assess_four_arm(plan, run)


def test_service_reads_sealed_private_records_without_running_study():
    plan, run = _records([f"source-{index}" for index in range(5)])

    class Reader:
        def __init__(self):
            self.reads = []

        def run_record(self, identity):
            self.reads.append(("run", identity))
            return deepcopy(run)

        def plan(self, identity):
            self.reads.append(("plan", identity))
            return deepcopy(plan)

    reader = Reader()
    report = FourArmAssessmentService(reader).assess(run["id"])

    assert reader.reads == [("run", run["id"]), ("plan", plan["id"])]
    assert report["run_digest"] == run["record_digest"]
