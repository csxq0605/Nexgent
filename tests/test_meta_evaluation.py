"""Protocol/cost tests; scripted source outputs are not scientific gain evidence."""

from copy import deepcopy
import json

import pytest

from nexgent.evolution.meta_evaluation import MetaEvaluationError, evaluate_improvers
from nexgent.kernel.programs import make_bundle, verify_bundle
from nexgent.kernel.runner import ProgramRunner


def task(value):
    return f"def solve(problem, tools):\n    return {{'answer': {value}}}\n"


def program(value=0, offspring=1):
    source = "def improve(context, broker):\n    return " + repr({
        "candidates": [{"files": {"task.py": task(offspring),
            "meta.py": "def improve(context, broker):\n    raise Exception('child meta must not run')\n",
            "workflow.py": "def solve(problem, tools):\n    return {'answer': 999}\n"},
            "rationale": "Scripted protocol fixture, not a scientific improvement"}],
        "research": {"hypothesis": "source identity check"}}) + "\n"
    return make_bundle({"task.py": task(value), "meta.py": source,
                        "workflow.py": "def helper():\n    return 0\n", "roles.json": '{}'})


def execution(bundle, entry="improve"):
    return {"bundle_id": bundle["id"], "source_digest": bundle["digest"], "entry": entry, "work_units": 0}


def report(bundle, split, seed, score=0):
    return {"score": score, "split": split, "seed": seed, "status": "ok", "work_units": 5,
            "tasks": [], "execution": execution(bundle, "solve_batch")}


def generation(parent, candidates):
    return {"candidates": candidates, "calls": [], "execution": execution(parent), "numerical_reports": []}


def test_actual_source_improvers_execute_from_common_start_and_project_joint_edits():
    runner = ProgramRunner()
    initial, evolved, start = program(0, 1), program(8, 2), program(0, 0)
    contexts, executed = [], []
    def generate(parent, context, label):
        contexts.append(deepcopy(context))
        result = runner.run(parent, "improve", context, timeout=10)
        executed.append(result["execution"])
        candidates = [make_bundle(item["files"], parent=parent, rationale=item["rationale"])
                      for item in result["value"]["candidates"]]
        return {**result["value"], "candidates": candidates, "calls": [],
                "execution": result["execution"], "numerical_reports": []}
    def evaluate(bundle, split, seed):
        result = runner.run(bundle, "solve_batch", {"problems": [{}]}, timeout=10)
        answer = result["value"][0]["submission"]["answer"]
        return {**report(bundle, split, seed, answer / 10), "execution": result["execution"]}
    result = evaluate_improvers(initial, evolved, start, [101], 1, generate, evaluate)
    assert len(executed) == 2 and all(row["entry"] == "improve" for row in executed)
    assert {context["parent"]["files"]["task.py"] for context in contexts} == {start["files"]["task.py"]}
    assert all(context["development"]["split"] == "development" for context in contexts)
    assert all("meta_transfer" not in json.dumps(context) for context in contexts)
    assert result["per_seed_pairs"][0]["difference"] == pytest.approx(.1)
    assert result["evidence"]["level"] == "matched_actual_source_offspring_comparison"
    for arm in result["arms"]:
        candidate = arm["attempts"][0]["candidates"][0]
        assert {row["file"] for row in candidate["discarded_non_task_changes"]} == {"meta.py", "workflow.py"}
        projected = result["artifacts"][candidate["projected_id"]]
        parent = result["artifacts"][arm["parent"]["id"]]
        assert projected["files"]["meta.py"] == parent["files"]["meta.py"]
        assert projected["files"]["workflow.py"] == parent["files"]["workflow.py"]
        assert candidate["original_id"] in result["artifacts"]
        verify_bundle(projected)
    assert result["cross_attribution"]["rows"][0]["contrasts"]["meta_transfer"]["task_effect_initial_meta"] == pytest.approx(.8)
    json.dumps(result, allow_nan=False)


def test_selection_uses_only_development_even_when_transfer_would_choose_differently():
    original = program()
    def generate(parent, context, label):
        return generation(parent, [make_bundle({"task.py": task(1)}, parent=parent),
                                   make_bundle({"task.py": task(2)}, parent=parent)])
    def evaluate(bundle, split, seed):
        value = next(i for i in (0, 1, 2) if bundle["files"]["task.py"] == task(i))
        scores = [0, .8, .4] if split == "development" else [0, .1, .9]
        return report(bundle, split, seed, scores[value])
    result = evaluate_improvers(original, original, original, [101], 2, generate, evaluate)
    assert all(arm["improvement_at_k"] == .1 for arm in result["arms"])
    # Second candidate's hidden score was never evaluated because it was not selected.
    unseen_digest = make_bundle({"task.py": task(2)}, parent=original)["digest"]
    assert not any(row["source_digest"] == unseen_digest and row["split"] == "meta_transfer"
                   for row in result["evaluations"].values())


def test_offspring_budget_bounds_empty_batches_and_excess_without_changing_parent():
    original, seen = program(), []
    def generate(parent, context, label):
        seen.append((label, parent["digest"], context["attempt"]))
        if context["attempt"] == 1:
            return generation(parent, [])
        return generation(parent, [make_bundle({"task.py": task(i)}, parent=parent) for i in (1, 2, 3)])
    result = evaluate_improvers(original, original, original, [101], 2, generate, report)
    assert len(seen) == 4 and len({row[1] for row in seen}) == 1
    for arm in result["arms"]:
        assert arm["offspring_slots_used"] == arm["generation_calls"] == 2
        assert len(arm["attempts"][1]["candidates"]) == 1
        assert len(arm["attempts"][1]["discarded_excess_candidates"]) == 2


def test_failed_paid_generation_keeps_unknown_receipt_and_is_missing_not_zero():
    original, labels = program(), []
    def generate(parent, context, label):
        labels.append(label)
        failure = RuntimeError("host model budget exhausted after a started call")
        failure.calls = [
            {"call_id": label, "status": "started", "max_tokens": 100, "usage": {}},
            {"call_id": label, "status": "interrupted", "billing_status": "unknown", "usage": {}}]
        failure.execution = execution(parent)
        failure.numerical_reports = [{"work_units": 13, "science_receipts": [{"work_units": 9999}]}]
        raise failure
    result = evaluate_improvers(original, original, original, [101], 5, generate, report)
    assert len(labels) == 2  # Never retry a failed source/model request to fill k.
    assert result["aggregate"]["paired_difference"]["mean"] is None
    assert result["aggregate"]["incomplete_seeds"] == [101]
    assert all(arm["improvement_at_k"] is None for arm in result["arms"])
    costs = result["costs"]
    assert costs["model_calls_with_identity"] == 2 and costs["reserved_completion_tokens"] == 200
    assert len(costs["usage_missing_call_ids"]) == len(costs["billing_unknown_call_ids"]) == 2
    assert costs["numerical_work_units_known"] == 26 + 5 * len(result["evaluations"])


def test_resource_limited_science_report_is_missing_even_if_its_score_is_zero():
    original = program()
    def generate(parent, context, label):
        return generation(parent, [make_bundle({"task.py": task(1)}, parent=parent)])
    def evaluate(bundle, split, seed):
        result = report(bundle, split, seed, .5)
        if bundle["files"]["task.py"] == task(1):
            result.update(score=0, status="budget_exhausted")
        return result
    result = evaluate_improvers(original, original, original, [101], 1, generate, evaluate)
    assert result["per_seed_pairs"][0]["difference"] is None
    assert all(arm["status"] == "incomplete" for arm in result["arms"])
    assert any("not a zero score" in row["error"]["message"] for row in result["failures"])


def test_broker_and_evaluation_reuse_counts_host_measurement_identity_once():
    original = program()
    def evaluate(bundle, split, seed):
        return {**report(bundle, split, seed), "measurement_key": bundle["digest"] + split + str(seed)}
    def generate(parent, context, label):
        result = generation(parent, [])
        result["numerical_reports"] = [evaluate(parent, "development", context["seed"])]
        return result
    result = evaluate_improvers(original, original, original, [101], 1, generate, evaluate)
    costs = result["costs"]
    assert len(costs["deduplicated_measurement_keys"]) == 2
    assert costs["numerical_work_units_known"] == 10
    assert len(costs["reused_measurements"]) == 2
    assert costs["numerical_reports_without_identity"] == []


def test_receipts_count_actual_usage_once_and_missing_evidence_is_not_invented():
    original = program()
    def generate(parent, context, label):
        return {"candidates": [], "calls": [
            {"call_id": label, "status": "started", "reserved_completion_tokens": 100},
            {"call_id": label, "status": "received", "usage": {"prompt_tokens": 40, "completion_tokens": 20, "total_tokens": 60}}]}
    result = evaluate_improvers(original, original, original, [101], 1, generate, report)
    assert result["costs"]["known_usage"]["total_tokens"] == 120
    assert result["costs"]["reserved_completion_tokens"] == 200
    assert result["evidence"]["level"] == "comparison_with_missing_execution_or_cost_evidence"
    assert {row["kind"] for row in result["evidence"]["missing"]} == {"improve_execution", "generation_numerical_costs"}


def test_wrong_source_receipt_fails_and_does_not_publish_a_gain():
    original = program()
    def generate(parent, context, label):
        result = generation(parent, [])
        result["execution"]["source_digest"] = "different-source"
        return result
    result = evaluate_improvers(original, original, original, [101], 1, generate, report)
    assert result["aggregate"]["paired_difference"]["n"] == 0
    assert any("identity mismatch" in row["error"]["message"] for row in result["failures"])


def test_callback_cannot_mutate_experiment_origins_or_other_arm_input():
    original = program()
    frozen = deepcopy(original)
    observed = []
    def generate(parent, context, label):
        observed.append(context["parent"]["files"]["task.py"])
        receipt = generation(parent, [])
        parent["files"]["task.py"] = task(999)
        context["parent"]["files"]["task.py"] = task(998)
        return receipt
    result = evaluate_improvers(original, original, original, [101, 202], 1, generate, report)
    assert original == frozen and observed == [task(0)] * 4
    assert [row["arm"] for row in result["arms"]] == ["initial", "evolved", "evolved", "initial"]


@pytest.mark.parametrize("k,seeds", [(True, [101]), (0, [101]), (1, []), (1, [True]), (1, [101, 101])])
def test_invalid_specification_cannot_spend_callbacks(k, seeds):
    original = program()
    def prohibited(*args):
        pytest.fail("Invalid specification invoked a callback")
    with pytest.raises(MetaEvaluationError):
        evaluate_improvers(original, original, original, seeds, k, prohibited, prohibited)
