from nexgent.tasks.outcomes import classify_benchmark_outcome, outcome_policy


def test_outcome_policy_only_scores_attributable_terminal_failures_as_zero():
    policy = outcome_policy()
    assert policy["observed_failure_statuses"] == ["failed"]
    assert policy["observed_failure_domains"] == ["agent", "protocol"]

    for domain in ("agent", "protocol"):
        result = classify_benchmark_outcome(
            {"status": "failed", "failure_domain": domain})
        assert result["measurement_status"] == "measured"
        assert result["failure_class"] == "observed_system_failure"
        assert result["evaluation"]["score"] == 0.0
        assert result["evaluation"]["accepted"] is False

    infrastructure = classify_benchmark_outcome(
        {"status": "failed", "failure_domain": "infrastructure"})
    assert infrastructure["measurement_status"] == "missing"
    assert infrastructure["failure_class"] == "infrastructure_missing"
    assert infrastructure["evaluation"]["score_available"] is False

    interrupted = classify_benchmark_outcome(
        {"status": "cancelled", "failure_domain": "protocol"})
    assert interrupted["measurement_status"] == "missing"
    assert interrupted["failure_class"] == "interrupted_missing"
    assert "score" not in interrupted["evaluation"]


def test_completed_evaluator_unavailable_remains_missing():
    result = classify_benchmark_outcome(
        {"status": "completed", "failure_domain": None},
        {"status": "unavailable", "score_available": False, "accepted": None})
    assert result["measurement_status"] == "missing"
    assert result["failure_class"] == "evaluator_missing"
    assert result["evaluation"]["score_available"] is False
    assert result["evaluation"]["accepted"] is None
