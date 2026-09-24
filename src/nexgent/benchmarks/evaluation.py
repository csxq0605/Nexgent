"""Durable, fixed-program evaluation through the shared benchmark and cost ledger.

There is no improvement entry point or provider preflight in this workflow.
Task source can still request model capabilities, admitted by the usual ledger.
"""
from __future__ import annotations

from copy import deepcopy
import math
import statistics
import threading
import time

from ..kernel.programs import digest
from ..kernel.store import BudgetExhausted
from ..models.gateway import ModelBudgetError


class _DefaultSeeds(tuple):
    """Distinguish an omitted default from an explicitly changed resume request."""


class _DefaultSplit(str):
    """A string default marker retains the public signature's usual value."""


_DEFAULT_SEEDS = _DefaultSeeds((101,))
_DEFAULT_SPLIT = _DefaultSplit("final_transfer")
_RESOURCE_FAILURES = {"timeout", "interrupted", "stopped", "budget_exhausted", "missing", "execution_unavailable"}


def _seeds(values):
    if isinstance(values, (str, bytes)):
        raise ValueError("Benchmark seeds must be a sequence of distinct integers")
    try:
        result = list(values)
    except TypeError as exc:
        raise ValueError("Benchmark seeds must be a sequence of distinct integers") from exc
    if not result or len(result) > 1000 or any(type(value) is not int for value in result) or len(set(result)) != len(result):
        raise ValueError("Register 1..1000 distinct integer benchmark seeds")
    return result


def _split(value):
    if not isinstance(value, str) or not value.strip() or len(value) > 200:
        raise ValueError("Benchmark split must be nonempty text within 200 characters")
    return str(value)


def _available(report):
    if not isinstance(report, dict) or report.get("score_available") is False:
        return False
    if report.get("status") in _RESOURCE_FAILURES or report.get("failure_kind") in _RESOURCE_FAILURES:
        return False
    score = report.get("score")
    if type(score) not in (int, float) or not math.isfinite(score):
        return False
    return all(task.get("score_available") is not False and task.get("status") not in _RESOURCE_FAILURES and task.get("failure_kind") not in _RESOURCE_FAILURES for task in report.get("tasks", []))


def _summarize(state):
    rows = state["benchmark_evaluation"]["results"]
    measured = [row for row in rows if row["status"] == "measured" and _available(row.get("report"))]
    missing = [row["seed"] for row in rows if row["status"] == "missing"]
    scores = [row["report"]["score"] for row in measured]
    complete = len(measured) == len(rows)
    summary = {
        "planned": len(rows), "measured": len(measured), "missing": len(missing),
        "remaining": sum(row["status"] == "planned" for row in rows),
        "missing_seeds": missing,
        "mean_score": statistics.fmean(scores) if complete else None,
        "observed_mean_score": statistics.fmean(scores) if scores else None,
        "unknown_work_seeds": [row["seed"] for row in rows if row["status"] == "missing" and row.get("report") is None],
        "reported_work_units": sum(row["report"].get("work_units", 0) for row in rows if isinstance(row.get("report"), dict)),
        "scope": "Fixed program benchmark; seed replications do not measure recursive self-improvement",
    }
    state["benchmark_evaluation"]["summary"] = summary
    state["conclusion"] = {
        "kind": "fixed_program_benchmark", "rsi_effect": False,
        "program_id": state["registration"]["program_id"],
        "benchmark_id": state["registration"]["benchmark_id"],
        "split": state["registration"]["split"], "seeds": state["registration"]["seeds"],
        "mean_score": summary["mean_score"], "observed_mean_score": summary["observed_mean_score"],
        "missing_seeds": missing, "unknown_work_seeds": summary["unknown_work_seeds"],
        "protocol_completed": all(row["status"] in {"measured", "missing"} for row in rows),
        "statement": "One frozen program was evaluated without an improvement cycle. Scores and task-model costs are benchmark evidence, not RSI effectiveness.",
    }


def _check_registration(controller, state, *, benchmark_id, program_id, seeds, split, budget):
    if state.get("kind") != "benchmark_evaluation":
        raise ValueError("The supplied study is not a registered fixed benchmark evaluation")
    registration = state.get("registration", {})
    if state.get("registration_digest") != digest(registration):
        raise ValueError("Fixed benchmark registration was changed")
    registered_events = [event["content"] for event in controller.store.events(state["id"]) if event["kind"] == "benchmark_registration"]
    if len(registered_events) != 1 or registered_events[0].get("registration") != registration:
        raise ValueError("Fixed benchmark registration differs from its original ledger event")
    if benchmark_id is not None and benchmark_id != registration["benchmark_id"]:
        raise ValueError("Cannot change the registered benchmark")
    if program_id is not None and program_id != registration["program_id"]:
        raise ValueError("Cannot change the registered fixed program")
    if seeds is not _DEFAULT_SEEDS and _seeds(seeds) != registration["seeds"]:
        raise ValueError("Cannot change registered benchmark seeds or their order")
    if split is not _DEFAULT_SPLIT and _split(split) != registration["split"]:
        raise ValueError("Cannot change the registered benchmark split")
    if budget is not None and (not isinstance(budget, dict) or any(registration["budget"].get(key) != value for key, value in budget.items())):
        raise ValueError("Cannot change the registered benchmark budget")
    if any(state.get(key) != registration["program_id"] for key in ("initial_program", "active_program", "research_program")):
        raise ValueError("Fixed benchmark source references changed")
    if state["budget"] != registration["budget"] or state["benchmark"] != registration["benchmark"] or state["protocol"] != registration["protocol"]:
        raise ValueError("Registered benchmark settings changed")
    if state.get("implementation_digest") != registration["implementation_digest"] or state["evaluator_digest"] != registration["evaluator_digest"] or digest(state.get("model_configuration")) != registration["model_configuration_digest"]:
        raise ValueError("Registered runtime or model identity changed")
    rows = state["benchmark_evaluation"]["results"]
    if [row["seed"] for row in rows] != registration["seeds"]:
        raise ValueError("Registered benchmark schedule changed")
    bundle = controller.store.bundle(registration["program_id"])
    if bundle["digest"] != registration["source_digest"]:
        raise ValueError("Registered program source changed")
    return bundle


def _check_environment(controller, state):
    benchmark = controller._benchmark(state)
    if benchmark.spec.as_dict() != state["registration"]["benchmark"] or benchmark.evaluator_digest != state["evaluator_digest"]:
        raise ValueError("Benchmark evaluator changed; register a new fixed evaluation")
    if controller._implementation_digest(benchmark) != state["implementation_digest"]:
        raise ValueError("Implementation changed; register a new fixed evaluation")
    if controller._model_identity() != state["model_configuration"]:
        raise ValueError("Model identity changed; register a new fixed evaluation")


def run_benchmark(controller, *, benchmark_id=None, program_id=None, seeds=_DEFAULT_SEEDS,
                  split=_DEFAULT_SPLIT, budget=None, study_id=None, stop_event=None, progress=None):
    """Register/evaluate fixed source, or resume only its unadmitted seed rows.

    Default new schedule is ``seeds=(101,), split='final_transfer'``. With a
    study_id, omitted options retain its registration; explicit options must
    match. Completed evidence is returned without executing against a newer
    environment. Interrupted admitted measurements are missing, never retried.
    """
    stop_event = stop_event or threading.Event()
    if study_id is None:
        selected_seeds, selected_split = _seeds(seeds), _split(split)
        seeds = selected_seeds
        created = controller.create("Benchmark evaluation: " + (benchmark_id or "selected plugin") + " / " + selected_split,
                                    generations=1, seed=selected_seeds[0], benchmark_id=benchmark_id,
                                    starting_program=program_id, budget=budget)
        study_id = created["id"]
        state = controller.store.get(study_id)
        source = controller.store.bundle(state["initial_program"])
        registration = {
            "schema": "nexgent-fixed-benchmark-registration-v1", "registered_at": time.time(),
            "benchmark_id": state["benchmark"]["id"], "benchmark": deepcopy(state["benchmark"]),
            "program_id": source["id"], "source_digest": source["digest"],
            "seeds": selected_seeds, "split": selected_split, "budget": deepcopy(state["budget"]),
            "protocol": deepcopy(state["protocol"]), "implementation_digest": state["implementation_digest"],
            "evaluator_digest": state["evaluator_digest"], "model_configuration_digest": digest(state["model_configuration"]),
            "evidence_scope": "fixed_program_benchmark", "improve_entry_calls": 0,
        }
        state.update(kind="benchmark_evaluation", max_generations=0, registration=registration,
                     registration_digest=digest(registration), stage="fixed benchmark registered",
                     benchmark_evaluation={"schema": "nexgent-fixed-benchmark-v1", "results": [
                         {"seed": seed, "status": "planned", "report": None} for seed in selected_seeds]})
        _summarize(state)
        controller._save(state)
        controller.store.event(study_id, "benchmark_registration", {"registration": registration, "registration_digest": state["registration_digest"]})
    with controller.store.lock(study_id):
        state = controller.store.get(study_id)
        bundle = _check_registration(controller, state, benchmark_id=benchmark_id, program_id=program_id,
                                     seeds=seeds, split=split, budget=budget)
        if state["status"] == "completed":
            return controller.get(study_id)
        _check_environment(controller, state)
        rows = state["benchmark_evaluation"]["results"]
        for row in rows:
            if row["status"] == "admitted":
                row.update(status="missing", failure_kind="interrupted", completed_at=time.time(),
                           error="Previously admitted evaluation has no committed seed result; it is not reissued")
                controller.store.event(study_id, "benchmark_measurement_missing", {"seed": row["seed"], "failure_kind": "interrupted", "reissued": False})
        state.update(status="running", stage="fixed benchmark evaluation")
        _summarize(state)
        try:
            controller._save(state, progress)
            for row in rows:
                if row["status"] != "planned" or stop_event.is_set():
                    continue
                _check_environment(controller, state)
                row.update(status="admitted", admitted_at=time.time(), reserved_work_units=state["budget"]["max_work_units_per_evaluation"])
                state["stage"] = "fixed benchmark: seed " + str(row["seed"])
                _summarize(state)
                controller._save(state, progress)
                controller.store.event(study_id, "benchmark_measurement_admitted", {"seed": row["seed"], "split": state["registration"]["split"], "source": bundle["digest"]})
                started = time.monotonic()
                try:
                    report = controller._measure(state, bundle, state["registration"]["split"], row["seed"], stop_event)
                    _check_environment(controller, state)
                    row.update(status="measured" if _available(report) else "missing", report=deepcopy(report),
                               failure_kind=report.get("failure_kind") or (None if _available(report) else "unavailable_score"))
                except (InterruptedError, KeyboardInterrupt) as exc:
                    stop_event.set()
                    row.update(status="missing", failure_kind="interrupted", error=f"{type(exc).__name__}: {str(exc)[:1200]}")
                except Exception as exc:
                    kind = "budget_exhausted" if isinstance(exc, (BudgetExhausted, ModelBudgetError)) else "timeout" if isinstance(exc, TimeoutError) else "execution_unavailable"
                    row.update(status="missing", failure_kind=kind, error=f"{type(exc).__name__}: {str(exc)[:1200]}")
                row.update(completed_at=time.time(), wall_seconds=time.monotonic() - started)
                _summarize(state)
                controller._save(state, progress)
                controller.store.event(study_id, "benchmark_measurement_completed", {"seed": row["seed"], "status": row["status"], "failure_kind": row.get("failure_kind"), "measurement_key": (row.get("report") or {}).get("measurement_key")})
                _check_environment(controller, state)
            state.update(status="paused" if any(row["status"] == "planned" for row in rows) else "completed",
                         stage="fixed benchmark paused" if any(row["status"] == "planned" for row in rows) else "fixed benchmark completed; evidence available")
            _summarize(state)
            controller._save(state, progress)
            controller.store.event(study_id, "benchmark_evaluation_finished", {"status": state["status"], "summary": state["benchmark_evaluation"]["summary"]})
        except Exception as exc:
            state.update(status="paused" if stop_event.is_set() else "failed", last_error=f"{type(exc).__name__}: {str(exc)[:1200]}", stage="fixed benchmark requires inspection")
            _summarize(state)
            controller._save(state)
            raise
        return controller.get(study_id)
