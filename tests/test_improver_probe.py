"""Development feedback boundaries; synthetic values do not establish RSI gains."""

from copy import deepcopy
import json

import pytest

from nexgent.evolution.meta_evaluation import evaluate_improver_probe
from nexgent.kernel.programs import make_bundle
from nexgent.kernel.runner import ProgramRunner


def task(value):
    return f"def solve(problem, tools):\n    return {{'answer': {value}}}\n"


def program(value, offspring):
    return make_bundle({"task.py": task(value), "meta.py":
        "def improve(context, broker):\n    return " + repr({"candidates": [{
            "files": {"task.py": task(offspring)}, "rationale": "Protocol fixture",
            "hypothesis": "Synthetic output differs"}]}) + "\n"})


def report(bundle, split, seed, score=0):
    return {"score": score, "status": "ok", "split": split, "seed": seed,
            "work_units": 5, "tasks": [], "execution": {
                "entry": "solve_batch", "source_digest": bundle["digest"], "bundle_id": bundle["id"]}}


def test_probe_executes_both_sources_and_never_opens_transfer():
    runner, seen = ProgramRunner(), []
    initial, proposed = program(0, 1), program(99, 2)

    def generate(parent, context, label):
        seen.append(deepcopy(context))
        result = runner.run(parent, "improve", context, timeout=10)
        candidates = [make_bundle(c["files"], parent) for c in result["value"]["candidates"]]
        return {"candidates": candidates, "execution": result["execution"], "calls": [], "numerical_reports": []}

    def evaluate(bundle, split, seed):
        assert split == "development"
        value = runner.run(bundle, "solve_batch", {"problems": [{}]}, timeout=10)
        return report(bundle, split, seed, value["value"][0]["submission"]["answer"] / 10)

    result = evaluate_improver_probe(initial, proposed, initial, seed=41, generate=generate, evaluate=evaluate)
    assert result["status"] == "completed"
    assert result["aggregate"]["paired_development_gain"] == pytest.approx(.1)
    assert len(seen) == 2
    assert all(c["parent"]["files"]["task.py"] == initial["files"]["task.py"] for c in seen)
    assert all(c["development"]["split"] == "development" for c in seen)
    assert all(row["split"] == "development" for row in result["evaluations"].values())
    assert len(result["costs"]["generation_executions"]) == 2
    json.dumps(result, allow_nan=False)


def test_same_improver_different_task_is_skipped_without_any_capability_cost():
    initial = program(0, 1)
    proposed = make_bundle({"task.py": task(9)}, initial)
    def forbidden(*args, **kwargs):
        raise AssertionError("Identical improvers must not run two paid samples")
    result = evaluate_improver_probe(initial, proposed, initial, seed=41, generate=forbidden, evaluate=forbidden)
    assert result["status"] == "skipped_identical_improver"
    assert result["aggregate"]["paired_development_gain"] is None


def test_failed_generation_is_missing_even_when_unchanged_baseline_is_available():
    initial, proposed = program(0, 1), program(0, 2)
    def generate(parent, context, label):
        raise RuntimeError("Admitted model call failed")
    result = evaluate_improver_probe(initial, proposed, initial, seed=41, generate=generate, evaluate=report)
    assert result["status"] == "incomplete"
    assert result["aggregate"]["paired_development_gain"] is None
    assert all(a.get("development_gain") is None for a in result["arms"])


def test_probe_resource_sentinel_cannot_turn_into_successful_zero_gain():
    initial, proposed = program(0, 1), program(0, 2)
    def evaluate(bundle, split, seed):
        return {**report(bundle, split, seed), "status": "budget_exhausted", "score_available": False}
    def forbidden(*args):
        raise AssertionError("An unmeasured baseline cannot support an offspring comparison")
    result = evaluate_improver_probe(initial, proposed, initial, seed=41, generate=forbidden, evaluate=evaluate)
    assert result["status"] == "incomplete"
    assert result["aggregate"]["paired_development_gain"] is None
