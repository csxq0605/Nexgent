"""Public fixed-program execution, cost admission and interruption semantics."""
from copy import deepcopy
import json
import threading

import pytest

from nexgent.benchmarks import BenchmarkSpec
from nexgent.benchmarks.evaluation import run_benchmark
from nexgent.evolution.controller import StudyController
from nexgent.kernel.programs import digest, make_bundle
from nexgent.models.gateway import ModelGateway


STATIC_TASK = "def solve(problem, tools):\n    return {'answer': problem['value']}\n"
MODEL_TASK = "def solve(problem, tools):\n    return tools.ask('solver', 'Return the answer as JSON', problem, max_tokens=128)\n"


class FixedFixture:
    spec = BenchmarkSpec("fixed_fixture", "Fixed evaluator fixture", "Protocol tests, not research evidence", "Return {'answer': value}", work_unit="fixture_operations")
    evaluator_digest = "fixed-fixture-v1"

    def __init__(self):
        self.invocations = []

    def initial_files(self):
        return {"task.py": STATIC_TASK}

    def snapshot(self):
        return {"fixture_version": "fixed-fixture-v1"}

    def research_context(self):
        return {}

    def evaluate(self, bundle, split, seed, runner, *, stop_event=None, max_work_units=1000):
        self.invocations.append(seed)
        result = runner.run(bundle, "solve_batch", {"problems": [{"value": seed % 2}]},
                            stop_event=stop_event, max_work_units=max_work_units, timeout=20)
        entry = result["value"][0]
        score = float(entry.get("ok") and entry["submission"]["answer"] == seed % 2)
        return {"score": score, "score_available": True, "status": "ok", "split": split, "seed": seed,
                "suite_digest": f"fixture-{split}-{seed}", "evaluator_digest": self.evaluator_digest,
                "work_units": 7, "tasks": [{"task_id": str(seed), "score": score, "status": "ok"}],
                "groups": {}, "execution": result["execution"]}


def make_controller(tmp_path, benchmark=None, *, model=False):
    requests = []
    if model:
        (tmp_path / "models.json").write_text(json.dumps({"providers": {"fixture": {
            "base_url": "https://example.invalid/v1", "api_key": "test-only",
            "models": {"fixture": {}}}}, "defaults": {"main": "fixture/fixture"}}))

    def transport(profile, parameters):
        requests.append(parameters)
        assert model, "Static benchmark unexpectedly requested a model"
        problem = json.loads(parameters["messages"][-1]["content"])
        return {"content": json.dumps({"answer": problem["value"]}), "finish_reason": "stop",
                "usage": {"prompt_tokens": 10, "completion_tokens": 2, "total_tokens": 12}}

    class Gateway(ModelGateway):
        def preflight(self):
            raise AssertionError("Fixed benchmark must not perform provider preflight")

    benchmark = benchmark or FixedFixture()
    controller = StudyController(tmp_path, benchmark=benchmark, search=lambda q: {"status": "test"},
                                 gateway_factory=lambda *args, **kwargs: Gateway(*args, **kwargs, transport=transport))
    return controller, benchmark, requests


def test_static_program_runs_without_model_configuration_or_improvement(tmp_path):
    controller, benchmark, requests = make_controller(tmp_path)
    state = run_benchmark(controller, benchmark_id="fixed_fixture", seeds=(3, 8), split="evaluation")
    assert state["status"] == "completed" and state["kind"] == "benchmark_evaluation"
    assert state["generation"] == state["max_generations"] == 0
    assert benchmark.invocations == [3, 8] and requests == []
    assert state["usage"]["model_calls"] == 0 and state["usage"]["numeric_work_units"] == 14
    assert state["conclusion"]["mean_score"] == 1 and state["conclusion"]["rsi_effect"] is False
    assert state["conclusion"]["kind"] == "fixed_program_benchmark"
    assert not any(event["kind"] == "offspring_generated" for event in state["events"])
    assert all(row["report"]["execution"]["entry"] == "solve_batch" for row in state["benchmark_evaluation"]["results"])
    exported = json.loads(open(controller.export(state["id"]), encoding="utf-8").read())
    assert exported["study"]["benchmark_evaluation"]["results"][1]["report"]["tasks"]


def test_model_using_task_calls_are_admitted_by_same_study_ledger(tmp_path):
    controller, benchmark, requests = make_controller(tmp_path, model=True)
    program = make_bundle({"task.py": MODEL_TASK, "meta.py": "def improve(context, broker):\n    raise ValueError('Do not execute improver')\n"})
    controller.store.put_bundle(program)
    state = run_benchmark(controller, program_id=program["id"], seeds=(4, 9), budget={"max_model_calls": 2, "max_completion_tokens": 256})
    assert state["status"] == "completed" and state["conclusion"]["mean_score"] == 1
    assert state["initial_program"] == state["active_program"] == program["id"]
    assert len(requests) == state["usage"]["model_calls"] == 2
    assert state["usage"]["reserved_completion_tokens"] == 256
    assert state["usage"]["reported_total_tokens"] == 24
    assert state["usage"]["unknown_usage_calls"] == 0
    assert all(call["status"] == "received" for call in state["calls"])
    assert any(event["kind"] == "capability" for event in state["events"])


def test_pause_resumes_only_unadmitted_seeds_and_completed_is_read_only(tmp_path):
    controller, benchmark, _ = make_controller(tmp_path)
    stop = threading.Event()

    def progress(state):
        if state["benchmark_evaluation"]["summary"]["measured"] == 1:
            stop.set()

    paused = run_benchmark(controller, seeds=(7, 19), split="custom_partition", stop_event=stop, progress=progress)
    assert paused["status"] == "paused" and benchmark.invocations == [7]
    result = run_benchmark(controller, study_id=paused["id"])
    assert result["status"] == "completed" and benchmark.invocations == [7, 19]
    assert result["usage"]["evaluations"] == 2
    # Old completed evidence remains readable after a code upgrade.
    controller._implementation_digest = lambda benchmark: "new-implementation"
    again = run_benchmark(controller, study_id=result["id"])
    assert again["benchmark_evaluation"] == result["benchmark_evaluation"]
    assert benchmark.invocations == [7, 19]


def test_crashed_admitted_measurement_is_missing_and_never_reissued(tmp_path):
    class CrashOnce(FixedFixture):
        crashed = False

        def evaluate(self, bundle, split, seed, runner, **kwargs):
            if not self.crashed:
                self.crashed = True
                self.invocations.append(seed)
                raise SystemExit("Fixture simulates process termination after admission")
            return super().evaluate(bundle, split, seed, runner, **kwargs)

    controller, benchmark, _ = make_controller(tmp_path, CrashOnce())
    with pytest.raises(SystemExit):
        run_benchmark(controller, seeds=(1, 2))
    registered = controller.list_studies()[0]
    assert registered["benchmark_evaluation"]["results"][0]["status"] == "admitted"
    result = run_benchmark(controller, study_id=registered["id"])
    assert result["status"] == "completed" and benchmark.invocations == [1, 2]
    assert result["usage"]["evaluations"] == 2
    assert result["conclusion"]["mean_score"] is None
    assert result["conclusion"]["observed_mean_score"] == 1
    assert result["conclusion"]["missing_seeds"] == [1]
    assert result["conclusion"]["unknown_work_seeds"] == [1]
    assert result["benchmark_evaluation"]["results"][0]["report"] is None


@pytest.mark.parametrize("change", ["implementation", "evaluator", "model"])
def test_unfinished_evaluation_rejects_runtime_or_model_drift(tmp_path, change):
    controller, benchmark, _ = make_controller(tmp_path)
    stopped = threading.Event(); stopped.set()
    paused = run_benchmark(controller, seeds=(5,), stop_event=stopped)
    assert paused["status"] == "paused" and benchmark.invocations == []
    if change == "implementation":
        controller._implementation_digest = lambda benchmark: "different"
    elif change == "evaluator":
        benchmark.evaluator_digest = "changed-evaluator"
    else:
        controller._model_identity = lambda: {"defaults": {"main": "changed"}}
    with pytest.raises(ValueError, match="changed"):
        run_benchmark(controller, study_id=paused["id"])
    assert benchmark.invocations == []


@pytest.mark.parametrize("options", [{"seeds": (101,)}, {"split": "final_transfer"}, {"budget": {"max_model_calls": 999}}, {"benchmark_id": "other"}, {"program_id": "other"}])
def test_explicit_resume_options_cannot_change_even_default_valued_registration(tmp_path, options):
    controller, _, _ = make_controller(tmp_path)
    state = run_benchmark(controller, seeds=(6,), split="other_partition")
    with pytest.raises(ValueError, match="Cannot change"):
        run_benchmark(controller, study_id=state["id"], **options)


def test_ledger_registration_cannot_be_rewritten_by_changing_state_digest(tmp_path):
    controller, _, _ = make_controller(tmp_path)
    stopped = threading.Event(); stopped.set()
    state = run_benchmark(controller, stop_event=stopped)
    raw = controller.store.get(state["id"])
    raw["registration"]["budget"]["max_model_calls"] += 1
    raw["budget"] = deepcopy(raw["registration"]["budget"])
    raw["registration_digest"] = digest(raw["registration"])
    controller.store.save(raw)
    with pytest.raises(ValueError, match="ledger event"):
        run_benchmark(controller, study_id=state["id"])


def test_resource_failure_stays_missing_and_other_registered_seeds_continue(tmp_path):
    class TimeoutFirst(FixedFixture):
        def evaluate(self, bundle, split, seed, runner, **kwargs):
            if seed == 10:
                self.invocations.append(seed)
                raise TimeoutError("Fixture deadline")
            return super().evaluate(bundle, split, seed, runner, **kwargs)

    controller, benchmark, _ = make_controller(tmp_path, TimeoutFirst())
    result = run_benchmark(controller, seeds=(10, 11))
    assert result["status"] == "completed" and benchmark.invocations == [10, 11]
    assert result["conclusion"]["mean_score"] is None and result["conclusion"]["missing_seeds"] == [10]
    assert result["benchmark_evaluation"]["results"][0]["failure_kind"] == "timeout"
    assert result["benchmark_evaluation"]["results"][1]["status"] == "measured"


def test_measured_algorithm_failure_is_zero_score_not_resource_missing(tmp_path):
    controller, _, _ = make_controller(tmp_path)
    wrong = make_bundle({"task.py": "def solve(problem, tools):\n    return {'answer': -99}\n", "meta.py": "def improve(context, broker):\n    return {'candidates': []}\n"})
    controller.store.put_bundle(wrong)
    result = run_benchmark(controller, program_id=wrong["id"])
    assert result["conclusion"]["mean_score"] == 0
    assert result["conclusion"]["missing_seeds"] == []
