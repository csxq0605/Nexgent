"""Budgeted numerical primitives. No hidden case or scoring state lives here."""
from __future__ import annotations

import hashlib
import json
import math
import functools

import numpy as np
from scipy.signal import savgol_filter

from .expressions import NumericalFailure, bounded_rk4, expression, validate_model


class WorkBudgetExceeded(RuntimeError):
    pass


def _array(values, *, minimum=1):
    array = np.asarray(values, dtype=float)
    if array.ndim != 2 or not minimum <= len(array) <= 4000 or not 1 <= array.shape[1] <= 128 or not np.isfinite(array).all() or np.max(np.abs(array)) > 1e8:
        raise NumericalFailure("expected a finite, bounded two-dimensional numeric array")
    return array


def _record(function):
    @functools.wraps(function)
    def call(self, *args, **kwargs):
        before = self.work_units
        receipt = {"method": function.__name__, "status": "running"}
        try:
            output = function(self, *args, **kwargs)
            receipt["status"] = "ok"
            receipt["result_digest"] = hashlib.sha256(json.dumps(output, sort_keys=True, allow_nan=False, separators=(",", ":")).encode()).hexdigest()
            return output
        except Exception as exc:
            receipt.update(status="failed", error=f"{type(exc).__name__}: {str(exc)[:180]}")
            raise
        finally:
            receipt.update(work_units=self.work_units - before, cumulative_work_units=self.work_units)
            self._receipts.append(receipt)
    return call


class Toolbox:
    """Numerical work is an explicit deterministic operation proxy, not FLOPs."""
    def __init__(self, max_work_units=20_000_000):
        self.max_work_units = int(max_work_units)
        self.work_units = 0
        self._receipts = []

    def _charge(self, units):
        units = max(1, int(units))
        if self.work_units + units > self.max_work_units:
            self.work_units = self.max_work_units
            raise WorkBudgetExceeded("numerical work budget exhausted")
        self.work_units += units

    def receipts(self):
        return [dict(receipt) for receipt in self._receipts]

    def _filtered(self, states, dt, window, degree, derivative):
        data = _array(states, minimum=5)
        if not math.isfinite(dt) or dt <= 0:
            raise NumericalFailure("dt must be positive")
        if type(window) is not int or type(degree) is not int or not 0 <= window <= 101 or not 1 <= degree <= 5:
            raise NumericalFailure("invalid smoothing window or degree")
        if window < 3:
            self._charge(data.size * (3 if derivative else 1))
            return np.gradient(data, dt, axis=0, edge_order=2) if derivative else data.copy()
        window = min(window, len(data) if len(data) % 2 else len(data) - 1)
        window = window if window % 2 else window - 1
        if window <= degree:
            raise NumericalFailure("smoothing window must exceed polynomial degree")
        self._charge(data.size * window * (degree + 1))
        return savgol_filter(data, window, degree, deriv=derivative, delta=dt, axis=0, mode="interp")

    @_record
    def smooth(self, states, window=9, degree=3):
        return self._filtered(states, 1.0, window, degree, 0).tolist()

    @_record
    def differentiate(self, states, dt, window=9, degree=3):
        return self._filtered(states, dt, window, degree, 1).tolist()

    @_record
    def feature_matrix(self, states, terms, times=None):
        data = _array(states)
        if data.shape[1] > 6 or not isinstance(terms, list) or not 1 <= len(terms) <= 64:
            raise NumericalFailure("invalid dimension or expression library")
        time = np.zeros(len(data)) if times is None else np.asarray(times, dtype=float)
        if time.shape != (len(data),) or not np.isfinite(time).all():
            raise NumericalFailure("times must match states")
        columns = []
        for term in terms:
            function, cost = expression(term, data.shape[1], vectorized=True)
            self._charge(len(data) * cost)
            with np.errstate(all="ignore"):
                values = np.broadcast_to(function(data.T, time), (len(data),))
            if not np.isfinite(values).all() or np.max(np.abs(values)) > 1e12:
                raise NumericalFailure("nonfinite or excessive library value")
            columns.append(values)
        return np.column_stack(columns).tolist()

    @_record
    def linear_fit(self, features, targets, ridge=1e-6, threshold=0.01, iterations=8):
        x, y = _array(features), _array(targets)
        if len(x) != len(y) or not math.isfinite(ridge) or not 0 <= ridge <= 100 or not math.isfinite(threshold) or not 0 <= threshold <= 10 or type(iterations) is not int or not 1 <= iterations <= 30:
            raise NumericalFailure("invalid regression parameters")
        scale = np.sqrt(np.mean(x * x, axis=0))
        scale[scale < 1e-12] = 1.0
        z = x / scale
        coefficients = np.zeros((x.shape[1], y.shape[1]))
        for output in range(y.shape[1]):
            active = np.ones(x.shape[1], dtype=bool)
            previous = None
            for _ in range(iterations):
                count = int(active.sum())
                if count == 0:
                    break
                self._charge(len(x) * count * count + count ** 3)
                design = z[:, active]
                augmented = np.vstack([design, math.sqrt(ridge * len(x)) * np.eye(count)])
                values = np.concatenate([y[:, output], np.zeros(count)])
                fitted = np.linalg.lstsq(augmented, values, rcond=1e-10)[0]
                coefficients[:, output] = 0.0
                coefficients[active, output] = fitted / scale[active]
                # Threshold normalized contribution, not raw coefficient units.
                updated = np.abs(coefficients[:, output] * scale) >= threshold * max(float(np.std(y[:, output])), 1e-8)
                if previous is not None and np.array_equal(updated, active):
                    break
                previous, active = active, updated
            coefficients[~active, output] = 0.0
        if not np.isfinite(coefficients).all():
            raise NumericalFailure("regression produced nonfinite coefficients")
        return {"coefficients": coefficients.T.tolist(), "training_rmse": float(np.sqrt(np.mean((x @ coefficients - y) ** 2))), "complexity": int(np.count_nonzero(coefficients)), "work_units": self.work_units}

    @_record
    def fit_model(self, observations, dt, terms, window=9, degree=3, ridge=1e-6, threshold=0.01, weak_window=0):
        if not isinstance(observations, list) or not 1 <= len(observations) <= 12 or type(weak_window) is not int or not 0 <= weak_window <= 50:
            raise NumericalFailure("invalid observations or integral window")
        matrices, targets = [], []
        for trajectory in observations:
            data = _array(trajectory, minimum=9)
            smooth = self._filtered(data, dt, window, degree, 0)
            matrix = np.asarray(self.feature_matrix(smooth.tolist(), terms, (np.arange(len(data)) * dt).tolist()))
            if weak_window >= 2:
                # Integral collocation across overlapping intervals. No true derivatives.
                span = min(weak_window, len(data) // 3)
                cumulative = np.vstack([np.zeros(matrix.shape[1]), np.cumsum((matrix[:-1] + matrix[1:]) * (dt / 2), axis=0)])
                matrices.extend((cumulative[span:] - cumulative[:-span]).tolist())
                targets.extend((smooth[span:] - smooth[:-span]).tolist())
                self._charge(matrix.size * 3)
            else:
                derivative = self._filtered(data, dt, window, degree, 1)
                edge = max(2, window // 2)
                matrices.extend(matrix[edge:-edge].tolist())
                targets.extend(derivative[edge:-edge].tolist())
        fit = self.linear_fit(matrices, targets, ridge, threshold)
        model = {"terms": list(terms), "coefficients": fit["coefficients"]}
        validate_model(model)
        return {"model": model, "training_rmse": fit["training_rmse"], "complexity": fit["complexity"], "work_units": self.work_units}

    @_record
    def integrate(self, model, initial, dt, steps, substeps=2, start_time=0.0):
        terms, coefficients, parsed = validate_model(model)
        if len(initial) != len(coefficients):
            raise NumericalFailure("initial state and model dimensions differ")
        # Skip zero columns without changing model semantics.
        active = [i for i in range(len(terms)) if np.any(coefficients[:, i] != 0)]
        columns = [[float(coefficients[j, i]) for i in active] for j in range(len(coefficients))]
        cost = sum(parsed[i][1] for i in active) + len(active) * len(coefficients) + 1

        def field(state, time):
            values = [parsed[i][0](state, time) for i in active]
            return [sum(coef * value for coef, value in zip(row, values)) for row in columns]

        return bounded_rk4(field, initial, dt, steps, substeps=substeps, start_time=start_time, charge=lambda: self._charge(cost))

    @_record
    def validate(self, model, observations, dt, fraction=0.65):
        if not math.isfinite(fraction) or not 0.1 <= fraction <= 0.9 or not isinstance(observations, list) or not 1 <= len(observations) <= 12:
            raise NumericalFailure("invalid observation validation request")
        errors = []
        try:
            for trajectory in observations:
                data = _array(trajectory, minimum=9)
                start = min(len(data) - 3, int(len(data) * fraction))
                prediction = np.asarray(self.integrate(model, data[start].tolist(), dt, len(data) - start - 1, start_time=start * dt))
                target = data[start:]
                scale = np.maximum(np.sqrt(np.mean(data ** 2, axis=0)), 0.05)
                errors.append(float(np.sqrt(np.mean(((prediction - target) / scale) ** 2))))
        except NumericalFailure:
            return {"score": 0.0, "nrmse": 1e6, "stable": False, "complexity": 0, "work_units": self.work_units}
        nrmse = float(np.mean(errors))
        _, coef, _ = validate_model(model)
        return {"score": 1 / (1 + 10 * nrmse), "nrmse": nrmse, "stable": True, "complexity": int(np.count_nonzero(coef)), "work_units": self.work_units}


API_REFERENCE = """Define solve(problem, tools), returning {'model':model,'hypotheses':list,'experiments':list,'limitations':list}.
problem: opaque task_id, observations=list of trajectories (trajectory=list of state vectors), dt, dimension, question, requirements. Observations contain measurement noise; no true field or test trajectory is supplied.
model={'terms':['1','x0','x1','x0*x1','sin(x0)',...], 'coefficients':[[coefficient for each term] for each state dimension]}; dx[j]/dt=sum(coefficients[j][k]*terms[k]). Expressions support x0..x5, t, finite constants, + - * / ** (literal exponent <=6), sin cos tanh exp sqrt log abs. Max 64 terms. Return finite JSON only.
tools.smooth(states, window=9, degree=3) -> smoothed states; window 0 disables smoothing.
tools.differentiate(states,dt,window=9,degree=3) -> derivative vectors from observations only.
tools.feature_matrix(states,terms,times=None) -> numeric design matrix.
tools.linear_fit(features,targets,ridge=1e-6,threshold=0.01,iterations=8) -> coefficients[state][term], training_rmse, complexity, work_units. Threshold is normalized contribution relative to target standard deviation.
tools.fit_model(observations,dt,terms,window=9,degree=3,ridge=1e-6,threshold=0.01,weak_window=0) -> model,training_rmse,complexity,work_units. weak_window>=2 fits integral collocation instead of derivatives; this is an integral regression primitive, not a complete WSINDy implementation.
tools.integrate(model,initial,dt,steps,substeps=2,start_time=0.0) -> trajectory including initial state; divergent predictions raise errors, never clip.
tools.validate(model,observations,dt,fraction=0.65) -> score,nrmse,stable,complexity,work_units on the visible trajectory suffix. Keep these trajectories out of fitting for independent observation validation! This is not the private evaluator.
tools.receipts() -> numerical-call receipts. Nested work_units overlap; use cumulative_work_units/runner total, never sum nested receipts.
You may implement functions, algorithms, continuous parameter search, new expression libraries, resampling, explicit validation splits and control flow in source. Tool budgets accumulate across calls and tasks. Public self-reported experiment text does not establish independent evidence; execution receipts and the trusted grader do.
"""
