"""Private synthetic system generation and independent submission scoring."""
from __future__ import annotations

import hashlib
import json
import math
import random
from pathlib import Path

import numpy as np

from .expressions import NumericalFailure, bounded_rk4, validate_model
from .toolbox import API_REFERENCE, Toolbox, WorkBudgetExceeded


BENCHMARK_VERSION = "source-science-ode-v1"
DOMAIN_DESCRIPTION = "Synthetic recovery of known dynamical systems under noisy observations, with new initial conditions and nonpolynomial mechanism transfer. This benchmark does not establish a new natural law."
RESOURCE_FAILURES = {"timeout", "interrupted", "budget_exhausted"}


def _resource_failure(exc):
    if isinstance(exc, TimeoutError):
        return "timeout"
    if isinstance(exc, InterruptedError):
        return "interrupted"
    if isinstance(exc, WorkBudgetExceeded):
        return "budget_exhausted"
    return None


def _entry_resource(entry):
    if not isinstance(entry, dict):
        return None
    if entry.get("failure_kind") in RESOURCE_FAILURES:
        return entry["failure_kind"]
    return {"WorkBudgetExceeded": "budget_exhausted", "TimeoutError": "timeout", "InterruptedError": "interrupted"}.get(entry.get("error_type"))


def _digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, allow_nan=False, separators=(",", ":")).encode()).hexdigest()


def _specifications(split):
    ordinary = [("linear_decay", 0.003), ("logistic", 0.003), ("cubic_relaxation", 0.004), ("damped_oscillator", 0.008), ("predator_prey", 0.004), ("duffing", 0.005), ("logistic", 0.015), ("damped_oscillator", 0.018)]
    if any(label in split.lower() for label in ("transfer", "audit", "report", "confirm")):
        return ordinary + [("pendulum", 0.005), ("saturating_decay", 0.007), ("trigonometric_flow", 0.005), ("rational_growth", 0.006)]
    return ordinary


def _field_and_initial(family, rng):
    a, b, c, d = [rng.uniform(0.65, 1.25) for _ in range(4)]
    if family == "linear_decay":
        return lambda x, t: [-a * x[0]], lambda: [rng.uniform(0.3, 1.8)], 1
    if family == "logistic":
        return lambda x, t: [a * x[0] - b * x[0] ** 2], lambda: [rng.uniform(0.12, 1.6)], 1
    if family == "cubic_relaxation":
        return lambda x, t: [a * x[0] - b * x[0] ** 3], lambda: [rng.choice([-1, 1]) * rng.uniform(0.15, 1.65)], 1
    if family == "damped_oscillator":
        return lambda x, t: [x[1], -a * x[0] - 0.3 * b * x[1]], lambda: [rng.uniform(-1.5, 1.5), rng.uniform(-1.1, 1.1)], 2
    if family == "predator_prey":
        return lambda x, t: [a * x[0] - b * x[0] * x[1], c * x[0] * x[1] - d * x[1]], lambda: [rng.uniform(0.45, 1.7), rng.uniform(0.45, 1.7)], 2
    if family == "duffing":
        return lambda x, t: [x[1], a * x[0] - b * x[0] ** 3 - 0.35 * c * x[1]], lambda: [rng.uniform(-1.6, 1.6), rng.uniform(-0.9, 0.9)], 2
    if family == "pendulum":
        return lambda x, t: [x[1], -a * math.sin(x[0]) - 0.2 * b * x[1]], lambda: [rng.uniform(-2.5, 2.5), rng.uniform(-0.8, 0.8)], 2
    if family == "saturating_decay":
        return lambda x, t: [-a * math.tanh(x[0])], lambda: [rng.choice([-1, 1]) * rng.uniform(0.4, 3.0)], 1
    if family == "trigonometric_flow":
        return lambda x, t: [-a * math.sin(x[0]) + 0.4 * b * x[1], -c * x[1] + 0.35 * math.sin(x[0])], lambda: [rng.uniform(-2.6, 2.6), rng.uniform(-1.0, 1.0)], 2
    if family == "rational_growth":
        return lambda x, t: [a * x[0] / (1 + x[0] ** 2) - 0.35 * b * x[0]], lambda: [rng.choice([-1, 1]) * rng.uniform(0.15, 2.8)], 1
    raise ValueError("unknown private family")


class ResearchBenchmark:
    """Only this host-side object holds hidden fields and future trajectories."""
    def __init__(self):
        directory = Path(__file__).parent
        self.evaluator_digest = _digest({path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted(directory.glob("*.py"))})

    def _cases(self, split, seed, ledger):
        if not isinstance(split, str) or not split or type(seed) is not int:
            raise ValueError("split and integer seed are required")
        cases = []
        for index, (family, noise) in enumerate(_specifications(split)):
            identifier = _digest([BENCHMARK_VERSION, split, seed, index])
            rng = random.Random(int(identifier, 16))
            field, initial, dimension = _field_and_initial(family, rng)
            dt = rng.uniform(0.035, 0.05)
            charge = lambda: ledger._charge(dimension * 10)
            observed = []
            for _ in range(3):
                clean = bounded_rk4(field, initial(), dt, 100, substeps=5, charge=charge)
                observed.append([[value + rng.gauss(0, noise) for value in state] for state in clean])
            forecasts = []
            for _ in range(2):
                forecasts.append(bounded_rk4(field, initial(), dt, 150, substeps=7, charge=charge))
            public = {"task_id": identifier[:24], "dimension": dimension, "dt": dt, "observations": observed,
                      "question": "Recover a parsimonious continuous-time vector field from noisy state observations and explain how it can be falsified.",
                      "requirements": ["Return a finite executable expression model", "Use observation-only validation for method selection", "Report numerical experiments and limitations", "Predictions will be tested from unseen initial conditions over longer horizons"], "tool_api": API_REFERENCE}
            cases.append({"problem": public, "family": family, "group": "different_family" if family in {"pendulum", "saturating_decay", "trigonometric_flow", "rational_growth"} else "in_family", "forecasts": forecasts})
        return cases

    def problems(self, split, seed):
        return [case["problem"] for case in self._cases(split, seed, Toolbox(1_000_000_000))]

    def evaluate(self, bundle, split, seed, runner, *, stop_event=None, max_work_units=20_000_000):
        ledger = Toolbox(max_work_units)
        try:
            cases = self._cases(split, seed, ledger)
        except WorkBudgetExceeded:
            return {"score": 0.0, "score_available": False, "failure_kind": "budget_exhausted", "status": "budget_exhausted", "tasks": [], "split": split, "seed": seed, "suite_digest": _digest([BENCHMARK_VERSION, split, seed]), "evaluator_digest": self.evaluator_digest, "work_units": ledger.work_units, "dataset_generation_work_units": ledger.work_units, "scoring_work_units": 0, "groups": {}, "execution": {}, "domain": DOMAIN_DESCRIPTION, "evidence_scope": "Resource-limited missing evaluation; numeric score is a compatibility sentinel, not observed algorithm performance."}
        generation_work = ledger.work_units
        suite_digest = _digest([{ "problem": case["problem"], "forecasts": case["forecasts"], "family": case["family"]} for case in cases])
        # Explicit fixed reservation prevents a valid agent using every unit before grading.
        scoring_reserve = min(3_000_000, max_work_units // 4)
        source_budget = max_work_units - generation_work - scoring_reserve
        execution = {"work_units": 0}
        output = []
        source_error = None
        source_failure_kind = None
        if source_budget > 0 and not (stop_event and stop_event.is_set()):
            try:
                result = runner.run(bundle, "solve_batch", {"problems": [case["problem"] for case in cases]}, stop_event=stop_event, max_work_units=source_budget)
                output, execution = result["value"], result["execution"]
                if not isinstance(output, list):
                    raise NumericalFailure("solve_batch must return a list")
            except Exception as exc:
                source_error = f"{type(exc).__name__}: {str(exc)[:240]}"
                source_failure_kind = _resource_failure(exc)
                # Runner failures should expose usage. Conservatively charge the cap otherwise.
                execution = getattr(exc, "execution", {"work_units": source_budget, "error": source_error, "work_units_status": "reserved_upper_bound_actual_usage_unavailable"})
                if source_failure_kind:
                    execution = {**execution, "failure_kind": source_failure_kind}
        else:
            source_error = "stopped" if stop_event and stop_event.is_set() else "insufficient numerical budget"
            source_failure_kind = "interrupted" if stop_event and stop_event.is_set() else "budget_exhausted"
            execution["failure_kind"] = source_failure_kind
        source_work = int(execution.get("work_units", 0))
        ledger._charge(source_work) if source_work else None
        grading_start = ledger.work_units
        tasks = []
        for index, case in enumerate(cases):
            problem = case["problem"]
            row = {"task_id": problem["task_id"], "family": case["family"], "group": case["group"], "score": 0.0, "score_available": True, "nrmse": 1e6, "stable": False, "status": "failed", "equation": [], "submission": None, "experiment_claims_verified": False}
            before = ledger.work_units
            resource_kind = source_failure_kind
            try:
                if source_failure_kind:
                    raise RuntimeError(source_error or "source resource limit")
                if stop_event and stop_event.is_set():
                    raise InterruptedError("stopped")
                entry = output[index] if index < len(output) else {"ok": False, "error": source_error or "missing submission"}
                resource_kind = _entry_resource(entry)
                if resource_kind:
                    raise RuntimeError(entry.get("error", "source resource limit"))
                if not isinstance(entry, dict) or not entry.get("ok"):
                    raise NumericalFailure(entry.get("error", "invalid submission") if isinstance(entry, dict) else "invalid output entry")
                submission = entry.get("submission")
                if not isinstance(submission, dict):
                    raise NumericalFailure("submission must be an object")
                # Ensure evaluator output cannot propagate nonfinite or unbounded agent prose.
                encoded = json.dumps(submission, allow_nan=False)
                if len(encoded) > 180_000:
                    raise NumericalFailure("submission is too large")
                model = submission.get("model")
                terms, coefficients, _ = validate_model(model)
                if len(coefficients) != problem["dimension"]:
                    raise NumericalFailure("submission dimension mismatch")
                row["submission"] = submission
                row["equation"] = [" + ".join(f"{float(coef):.6g}*({term})" for term, coef in zip(terms, line) if coef != 0) or "0" for line in coefficients]
                errors = []
                for target_list in case["forecasts"]:
                    target = np.asarray(target_list)
                    prediction = np.asarray(ledger.integrate(model, target_list[0], problem["dt"], len(target_list) - 1, substeps=3))
                    # RMS state scale stays meaningful for decaying/near-constant trajectories.
                    scale = np.maximum(np.sqrt(np.mean(target ** 2, axis=0)), 0.05)
                    errors.append(float(np.sqrt(np.mean(((prediction - target) / scale) ** 2))))
                nrmse = float(np.mean(errors))
                row.update(score=1 / (1 + 10 * nrmse), nrmse=nrmse, stable=True, status="ok", complexity=int(np.count_nonzero(coefficients)), forecast_nrmse=errors)
            except Exception as exc:
                row["error"] = f"{type(exc).__name__}: {str(exc)[:240]}"
                resource_kind = resource_kind or _resource_failure(exc)
                if resource_kind:
                    row.update(status=resource_kind, failure_kind=resource_kind, score_available=False)
            row["scoring_work_units"] = ledger.work_units - before
            tasks.append(row)
        groups = {}
        for name in ("in_family", "different_family"):
            selected = [row for row in tasks if row["group"] == name]
            if selected:
                groups[name] = {"score": float(np.mean([row["score"] for row in selected])), "score_available": all(row["score_available"] for row in selected), "nrmse": float(np.mean([row["nrmse"] for row in selected])), "tasks": len(selected), "failures": sum(row["status"] != "ok" for row in selected), "missing": sum(not row["score_available"] for row in selected)}
        missing = [row for row in tasks if not row["score_available"]]
        failure_kind = source_failure_kind or (missing[0]["failure_kind"] if missing else None)
        status = failure_kind or ("ok" if all(row["status"] == "ok" for row in tasks) else "partial_failure")
        return {"score": float(np.mean([row["score"] for row in tasks])), "score_available": not missing, "failure_kind": failure_kind, "status": status, "missing_task_ids": [row["task_id"] for row in missing], "tasks": tasks, "split": split, "seed": seed, "suite_digest": suite_digest, "evaluator_digest": self.evaluator_digest, "groups": groups, "work_units": ledger.work_units, "dataset_generation_work_units": generation_work, "scoring_work_units": ledger.work_units - grading_start, "execution": execution, "domain": DOMAIN_DESCRIPTION, "evidence_scope": "Independent hidden-trajectory forecast evaluation. When score_available is false, numeric score/nrmse fields are compatibility sentinels and must not be aggregated as observed performance. Numerical instability remains an observed zero-score failure. Submitted experiment and hypothesis text is not independently verified here."}
