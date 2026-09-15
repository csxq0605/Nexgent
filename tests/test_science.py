"""Scientific validity checks using observations and independent analytic truth."""
import json
import math

import numpy as np
import pytest

from nexgent.science import ResearchBenchmark, Toolbox, NumericalFailure, WorkBudgetExceeded, seed_task_files, strong_baseline_files
from nexgent.kernel.programs import make_bundle
from nexgent.kernel.runner import ProgramRunner


def _bundle(files):
    return make_bundle({**files, "meta.py": "def improve(context, broker):\n    return {'candidates': []}\n"})


class LocalRunner:
    """Test adapter for scientific controls; production uses ProgramRunner."""
    def run(self, bundle, entry, argument, **kwargs):
        namespace = {}
        exec(bundle["files"]["task.py"], namespace)
        toolbox = Toolbox(kwargs["max_work_units"])
        output = []
        for problem in argument["problems"]:
            try:
                output.append({"ok": True, "submission": namespace["solve"](problem, toolbox)})
            except Exception as exc:
                output.append({"ok": False, "error": str(exc)})
        return {"value": output, "execution": {"work_units": toolbox.work_units, "science_receipts": toolbox.receipts()}}


def test_analytic_decay_is_recovered_and_extrapolates():
    dt = 0.04
    observations = [[[initial * math.exp(-0.7 * i * dt)] for i in range(101)] for initial in (0.4, 1.1, 1.8)]
    tools = Toolbox()
    fitted = tools.fit_model(observations, dt, ["1", "x0", "x0*x0"], window=9, threshold=0.02)
    prediction = np.array(tools.integrate(fitted["model"], [2.2], dt, 180))[:, 0]
    truth = np.array([2.2 * math.exp(-0.7 * i * dt) for i in range(181)])
    assert np.max(np.abs(prediction - truth)) < 0.002
    assert abs(fitted["model"]["coefficients"][0][1] + 0.7) < 0.005


def test_integral_regression_handles_measurement_noise():
    rng = np.random.default_rng(73)
    dt = 0.04
    clean = np.array([[math.exp(-0.8 * i * dt)] for i in range(130)])
    observed = [(clean * initial + rng.normal(0, 0.012, clean.shape)).tolist() for initial in (0.5, 1.0, 1.7)]
    tools = Toolbox()
    fit = tools.fit_model(observed, dt, ["1", "x0"], window=13, weak_window=8, threshold=0.03)
    prediction = np.array(tools.integrate(fit["model"], [1.4], dt, 160))[:, 0]
    target = 1.4 * np.exp(-0.8 * dt * np.arange(161))
    assert np.sqrt(np.mean((prediction - target) ** 2)) < 0.04


def test_general_nonpolynomial_expression_extrapolates_against_analytic_solution():
    tools = Toolbox()
    dt, initial = 0.03, 1.7
    model = {"terms": ["sin(x0)"], "coefficients": [[-1.0]]}
    predicted = np.array(tools.integrate(model, [initial], dt, 180))[:, 0]
    truth = 2 * np.arctan(math.tan(initial / 2) * np.exp(-dt * np.arange(181)))
    assert np.max(np.abs(predicted - truth)) < 1e-6
    assert tools.feature_matrix([[2.0]], ["x0**-1"]) == [[0.5]]


@pytest.mark.parametrize("term", ["__import__('os')", "x0.__class__", "[x0]", "x0**999", "open('a')", "x7"])
def test_model_expression_cannot_escape_math_language(term):
    with pytest.raises(NumericalFailure):
        Toolbox().integrate({"terms": [term], "coefficients": [[1.0]]}, [1.0], 0.04, 3)


@pytest.mark.parametrize("model", [
    {"terms": ["x0"], "coefficients": [[float("nan")]]},
    {"terms": ["x0"], "coefficients": [[1e20]]},
    {"terms": ["x0*x0*x0"], "coefficients": [[10000.0]]},
    {"terms": ["1/x0"], "coefficients": [[1.0]]},
])
def test_nonfinite_or_unstable_models_fail(model):
    with pytest.raises(NumericalFailure):
        Toolbox().integrate(model, [0.0 if model["terms"] == ["1/x0"] else 2.0], 0.1, 20)


def test_work_budget_and_receipts_charge_failed_work():
    tools = Toolbox(100)
    with pytest.raises(WorkBudgetExceeded):
        tools.feature_matrix([[1.0]] * 100, ["x0*x0"])
    assert tools.work_units == 100
    assert tools.receipts()[-1]["status"] == "failed"
    assert tools.receipts()[-1]["work_units"] == 100


def test_public_input_does_not_reveal_hidden_tasks_and_splits_are_disjoint():
    benchmark = ResearchBenchmark()
    development = benchmark.problems("development", 1)
    report = benchmark.problems("final_report", 1)
    assert not set(p["task_id"] for p in development) & set(p["task_id"] for p in report)
    assert len(report) > len(development)
    for problem in development + report:
        assert not {"family", "parameters", "truth", "forecasts", "noise_std", "seed", "split"} & set(problem)
        assert len(problem["observations"]) == 3
    assert development == benchmark.problems("development", 1)


def test_strong_executable_baseline_improves_real_hidden_forecasts_and_cost_is_complete():
    benchmark = ResearchBenchmark()
    seed = benchmark.evaluate(_bundle(seed_task_files()), "development", 4, LocalRunner())
    strong = benchmark.evaluate(_bundle(strong_baseline_files()), "development", 4, LocalRunner())
    assert strong["suite_digest"] == seed["suite_digest"]
    assert strong["score"] > seed["score"] + 0.15
    assert len(strong["tasks"]) == 8
    assert strong["work_units"] == strong["dataset_generation_work_units"] + strong["scoring_work_units"] + strong["execution"]["work_units"]
    assert strong["work_units"] <= 20_000_000
    json.dumps(strong, allow_nan=False)


def test_nonpolynomial_transfer_is_separately_reported_and_self_reported_score_ignored():
    files = {"task.py": "def solve(problem, tools):\n    return {'model': {'terms': ['1'], 'coefficients': [[0.0] for i in range(problem['dimension'])]}, 'score': 1.0}\n"}
    result = ResearchBenchmark().evaluate(_bundle(files), "meta_transfer", 2, LocalRunner())
    assert result["groups"]["in_family"]["tasks"] == 8
    assert result["groups"]["different_family"]["tasks"] == 4
    assert result["score"] < 0.5
    assert all(row["score"] < 1 for row in result["tasks"])


def test_real_source_runner_uses_observation_only_tools():
    problem = ResearchBenchmark().problems("development", 2)[0]
    result = ProgramRunner().run(_bundle(seed_task_files()), "solve_batch", {"problems": [problem]}, timeout=30)
    assert result["value"][0]["ok"], result
    assert result["execution"]["work_units"] > 0
    assert result["execution"]["science_receipts"]


def test_too_small_budget_is_an_explicit_scientific_failure():
    result = ResearchBenchmark().evaluate(_bundle(seed_task_files()), "development", 3, LocalRunner(), max_work_units=10)
    assert result["status"] == "budget_exhausted"
    assert result["score"] == 0
    assert result["work_units"] <= 10


def test_private_grading_rejects_nonfinite_submissions_without_dropping_tasks():
    files = {"task.py": "def solve(problem, tools):\n    return {'model': {'terms': ['x0'], 'coefficients': [[float('nan')] for i in range(problem['dimension'])]}}\n"}
    result = ResearchBenchmark().evaluate(_bundle(files), "development", 11, LocalRunner())
    assert result["score"] == 0
    assert len(result["tasks"]) == 8
    assert all(row["status"] == "failed" for row in result["tasks"])
    assert result["score_available"]
    json.dumps(result, allow_nan=False)


@pytest.mark.parametrize("failure,status", [(TimeoutError("deadline"), "timeout"), (InterruptedError("stop"), "interrupted"), (WorkBudgetExceeded("budget"), "budget_exhausted")])
def test_external_source_resource_failure_is_missing_not_algorithm_zero(failure, status):
    class UnavailableRunner:
        def run(self, *args, **kwargs):
            raise failure
    result = ResearchBenchmark().evaluate(_bundle(seed_task_files()), "development", 9, UnavailableRunner())
    assert result["status"] == result["failure_kind"] == status
    assert result["score_available"] is False
    assert len(result["missing_task_ids"]) == len(result["tasks"]) == 8
    assert all(row["status"] == status and not row["score_available"] for row in result["tasks"])
    assert result["execution"]["failure_kind"] == status
    assert 0 < result["work_units"] <= 20_000_000


def test_source_entry_budget_status_is_preserved_and_valid_tasks_are_not_dropped():
    class PartlyUnavailableRunner:
        def run(self, bundle, entry, argument, **kwargs):
            values = [{"ok": True, "submission": {"model": {"terms": ["1"], "coefficients": [[0] for _ in range(problem["dimension"])]}}} for problem in argument["problems"]]
            values[-1] = {"ok": False, "error_type": "WorkBudgetExceeded", "error": "out of work units"}
            return {"value": values, "execution": {"work_units": 100}}
    result = ResearchBenchmark().evaluate(_bundle(seed_task_files()), "development", 7, PartlyUnavailableRunner())
    assert result["status"] == "budget_exhausted" and not result["score_available"]
    assert len(result["tasks"]) == 8
    assert sum(row["score_available"] for row in result["tasks"]) == 7
