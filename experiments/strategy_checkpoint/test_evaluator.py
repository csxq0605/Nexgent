from __future__ import annotations

from copy import deepcopy
import json

import pytest

from experiments.strategy_checkpoint.evaluator import EvaluatorInputError, evaluate


REPORTS = {
    "atlas_report.json": {
        "service": "atlas",
        "tests_passed": True,
        "coverage": 91,
        "open_sev1": 0,
        "open_sev2": 0,
        "rollback_minutes": 12,
        "evidence_age_hours": 3,
    },
    "borealis_report.json": {
        "service": "borealis",
        "tests_passed": True,
        "coverage": 88,
        "open_sev1": 0,
        "open_sev2": 1,
        "rollback_minutes": 9,
        "evidence_age_hours": 2,
    },
    "cygnus_report.json": {
        "service": "cygnus",
        "tests_passed": True,
        "coverage": 82,
        "open_sev1": 0,
        "open_sev2": 0,
        "rollback_minutes": 18,
        "evidence_age_hours": 6,
    },
}


def _frozen_inputs(coverage: int) -> dict:
    return {
        "base_policy": {
            "revision": 1,
            "service_pass_requires": {
                "tests_passed": True,
                "coverage_at_least": 80,
                "open_sev1": 0,
                "open_sev2": 0,
                "rollback_minutes_at_most": 15,
                "evidence_age_hours_at_most": 24,
            },
            "overall_rule": "approve_only_if_every_service_passes",
        },
        "policy_update.json": {
            "revision": 2,
            "service_pass_requires": {
                "tests_passed": True,
                "coverage_at_least": coverage,
                "open_sev1": 0,
                "open_sev2": 0,
                "rollback_minutes_at_most": 15,
                "evidence_age_hours_at_most": 24,
            },
            "overall_rule": "approve_only_if_every_service_passes",
        },
        **deepcopy(REPORTS),
    }


def _checks(*failed: str) -> dict[str, str]:
    failed_set = set(failed)
    return {
        name: "fail" if name in failed_set else "pass"
        for name in (
            "tests_passed",
            "coverage",
            "open_sev1",
            "open_sev2",
            "rollback_minutes",
            "evidence_age_hours",
        )
    }


def _review(coverage: int) -> dict:
    failures = {
        "atlas": [],
        "borealis": ["open_sev2"] if coverage == 80 else ["coverage", "open_sev2"],
        "cygnus": (
            ["rollback_minutes"]
            if coverage == 80
            else ["coverage", "rollback_minutes"]
        ),
    }
    return {
        "policy_revision": 2,
        "per_service": [
            {
                "service": service,
                "checks": _checks(*failures[service]),
                "passed": not failures[service],
                "blockers": failures[service],
                "evidence_refs": ["policy_update.json", f"{service}_report.json"],
            }
            for service in ("atlas", "borealis", "cygnus")
        ],
        "overall": "hold",
        "blocking_services": ["borealis", "cygnus"],
        "summary": (
            "Hold: borealis is blocked by "
            + " and ".join(failures["borealis"])
            + "; cygnus is blocked by "
            + " and ".join(failures["cygnus"])
            + "; atlas passes."
        ),
    }


@pytest.mark.parametrize(
    ("condition_id", "coverage", "borealis_blockers", "cygnus_blockers"),
    [
        (
            "D1C-SWITCH-PRIMARY",
            90,
            ["coverage", "open_sev2"],
            ["coverage", "rollback_minutes"],
        ),
        ("D1C-NO-GAP", 80, ["open_sev2"], ["rollback_minutes"]),
        ("D1C-INFRA-CONTROL", 80, ["open_sev2"], ["rollback_minutes"]),
        (
            "D1C-SWITCH-RECOVERY",
            90,
            ["coverage", "open_sev2"],
            ["coverage", "rollback_minutes"],
        ),
    ],
)
def test_preregistered_reviews_pass_all_twelve_exact_checks(
    condition_id, coverage, borealis_blockers, cygnus_blockers
):
    review = _review(coverage)

    result = evaluate(condition_id, json.dumps(review), _frozen_inputs(coverage))

    assert result["schema_valid"] is True
    assert result["score"] == result["score_possible"] == 12
    assert result["total"] == 12
    assert result["threshold"] == 12
    assert result["critical_passed"] is True
    assert result["passed"] is True
    assert len(result["criteria"]) == 12
    assert all(item["critical"] and item["passed"] for item in result["criteria"])
    rows = {row["service"]: row for row in review["per_service"]}
    assert rows["atlas"]["checks"] == {
        "tests_passed": "pass",
        "coverage": "pass",
        "open_sev1": "pass",
        "open_sev2": "pass",
        "rollback_minutes": "pass",
        "evidence_age_hours": "pass",
    }
    assert rows["atlas"]["passed"] is True
    assert rows["atlas"]["blockers"] == []
    assert rows["borealis"]["blockers"] == borealis_blockers
    assert rows["cygnus"]["blockers"] == cygnus_blockers


def test_condition_id_is_opaque_and_cannot_select_an_answer_key():
    inputs = _frozen_inputs(90)
    review = _review(90)

    switch = evaluate("D1C-SWITCH-PRIMARY", review, inputs)
    no_gap_label = evaluate("D1C-NO-GAP", review, inputs)

    assert switch["criteria"] == no_gap_label["criteria"]
    assert switch["score"] == no_gap_label["score"] == 12
    assert switch["passed"] is no_gap_label["passed"] is True
    assert switch["condition_id"] != no_gap_label["condition_id"]


def test_supported_summary_can_name_blockers_before_a_later_atlas_pass_sentence():
    review = _review(90)
    review["summary"] = (
        "Hold: borealis and cygnus have policy blockers. "
        "Atlas passes all applicable checks."
    )

    result = evaluate("opaque-condition", review, _frozen_inputs(90))

    assert result["passed"] is True


def test_supported_summary_may_explicitly_say_atlas_is_not_a_blocker():
    review = _review(90)
    review["summary"] = (
        "Hold because borealis and cygnus fail policy checks; "
        "atlas is not a blocker."
    )

    result = evaluate("opaque-condition", review, _frozen_inputs(90))

    assert result["passed"] is True


def test_effective_policy_from_inputs_changes_exact_expected_service_results():
    result = evaluate("opaque-condition", _review(80), _frozen_inputs(90))

    by_id = {item["id"]: item for item in result["criteria"]}
    assert by_id["C02"]["passed"] is True
    assert by_id["C03"]["passed"] is False
    assert by_id["C04"]["passed"] is False
    assert result["passed"] is False


def test_schema_validation_is_strict_and_still_returns_twelve_critical_items():
    review = _review(90)
    review["runtime"] = {"cost": 1}

    result = evaluate("opaque-condition", review, _frozen_inputs(90))

    assert result["schema_valid"] is False
    assert any("Additional properties" in error for error in result["schema_errors"])
    assert len(result["criteria"]) == 12
    assert result["score"] == 0
    assert result["passed"] is False


def test_evidence_must_name_effective_policy_and_own_report_only():
    review = _review(90)
    review["per_service"][0]["evidence_refs"] = [
        "policy_update.json",
        "atlas_report.json",
        "borealis_report.json",
    ]

    result = evaluate("opaque-condition", review, _frozen_inputs(90))

    criterion = next(item for item in result["criteria"] if item["id"] == "C05")
    assert criterion["passed"] is False
    assert result["passed"] is False


def test_blockers_must_equal_failed_check_fields_in_schema_order():
    review = _review(90)
    borealis = review["per_service"][1]
    borealis["blockers"] = ["open_sev2", "coverage"]

    result = evaluate("opaque-condition", review, _frozen_inputs(90))

    by_id = {item["id"]: item for item in result["criteria"]}
    assert by_id["C03"]["passed"] is False
    assert by_id["C12"]["passed"] is False


@pytest.mark.parametrize(
    "summary",
    [
        "Hold: borealis and cygnus block release; atlas fails coverage.",
        "Hold because borealis and cygnus create customer impact in region 7.",
        "Hold due to invented_metric even though service rows are unchanged.",
    ],
)
def test_summary_rejects_atlas_blocking_and_input_unsupported_claims(summary):
    review = _review(90)
    review["summary"] = summary

    result = evaluate("opaque-condition", review, _frozen_inputs(90))

    by_id = {item["id"]: item for item in result["criteria"]}
    assert not (by_id["C09"]["passed"] and by_id["C10"]["passed"])
    assert result["passed"] is False


@pytest.mark.parametrize(
    ("target", "metadata"),
    [
        ("inputs", {"StrategyStart": {"component_id": "checkpoint-release-dag"}}),
        ("inputs", {"selector_receipt": {"target": "handoff-recovery-entry"}}),
        ("final", {"backend": "controlled_code"}),
        ("final", {"checkpoint": "checkpoint-1"}),
    ],
)
def test_route_checkpoint_selector_and_backend_metadata_are_rejected(target, metadata):
    inputs = _frozen_inputs(90)
    review = _review(90)
    if target == "inputs":
        inputs.update(metadata)
    else:
        review.update(metadata)

    with pytest.raises(EvaluatorInputError, match="route metadata is forbidden"):
        evaluate("opaque-condition", review, inputs)


@pytest.mark.parametrize(
    "summary",
    [
        "Hold after the DAG switched strategy.",
        "Hold; the checkpoint selector chose a controlled_code backend.",
    ],
)
def test_free_text_route_claims_are_rejected_before_quality_scoring(summary):
    review = _review(90)
    review["summary"] = summary

    with pytest.raises(EvaluatorInputError, match="route metadata is forbidden"):
        evaluate("opaque-condition", review, _frozen_inputs(90))


def test_multiple_effective_policy_bindings_are_rejected_as_ambiguous():
    inputs = _frozen_inputs(90)
    inputs["effective_policy"] = deepcopy(inputs["policy_update.json"])

    with pytest.raises(EvaluatorInputError, match="ambiguous effective-policy"):
        evaluate("opaque-condition", _review(90), inputs)


def test_nested_input_form_binds_explicit_artifact_references():
    flat = _frozen_inputs(90)
    nested = {
        "effective_policy": flat["policy_update.json"],
        "service_reports": {
            service: flat[f"{service}_report.json"]
            for service in ("atlas", "borealis", "cygnus")
        },
        "evidence_refs": {
            "policy": "updated-policy-artifact",
            "services": {
                service: f"{service}-report-artifact"
                for service in ("atlas", "borealis", "cygnus")
            },
        },
    }
    review = _review(90)
    for row in review["per_service"]:
        row["evidence_refs"] = [
            "updated-policy-artifact",
            f"{row['service']}-report-artifact",
        ]

    result = evaluate("opaque-condition", review, nested)

    assert result["passed"] is True
    assert result["score"] == 12
