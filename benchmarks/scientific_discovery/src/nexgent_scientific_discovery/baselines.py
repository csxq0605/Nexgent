"""Executable controls; these are scientific programs, not policy dictionaries."""


def seed_task_files():
    return {"task.py": '''def solve(problem, tools):
    terms = ["1"] + ["x" + str(i) for i in range(problem["dimension"])]
    fit = tools.fit_model(problem["observations"], problem["dt"], terms, window=5, degree=2, ridge=0.000001, threshold=0.01)
    return {"model": fit["model"], "hypotheses": [{"claim": "A linear field explains these observations", "falsifier": "Poor withheld-trajectory prediction"}], "experiments": [{"kind": "fit", "training_rmse": fit["training_rmse"]}], "limitations": ["Linear starting model; nonlinear mechanisms may require new expressions", "Synthetic system recovery does not discover a new natural law"]}
'''}


def strong_baseline_files():
    """A frozen SINDy-inspired portfolio with trajectory-level model selection."""
    return {"task.py": '''def make_library(dimension, nonlinear, extended):
    terms = ["1"]
    variables = ["x" + str(i) for i in range(dimension)]
    terms = terms + variables
    if nonlinear:
        for i in range(dimension):
            for j in range(i, dimension):
                terms.append(variables[i] + "*" + variables[j])
                for k in range(j, dimension):
                    terms.append(variables[i] + "*" + variables[j] + "*" + variables[k])
    if extended:
        for variable in variables:
            terms.append("sin(" + variable + ")")
            terms.append("tanh(" + variable + ")")
            terms.append(variable + "/(1+" + variable + "**2)")
    return terms

def solve(problem, tools):
    observations = problem["observations"]
    training = observations[:-1]
    validation = observations[-1:]
    experiments = []
    best = None
    best_value = -1000000
    for nonlinear, extended in [(False, False), (True, False), (True, True)]:
        terms = make_library(problem["dimension"], nonlinear, extended)
        for window, weak_window, threshold in [(9, 0, 0.04), (13, 7, 0.06)]:
            try:
                fitted = tools.fit_model(training, problem["dt"], terms, window=window, degree=3, ridge=0.000001, threshold=threshold, weak_window=weak_window)
                checked = tools.validate(fitted["model"], validation, problem["dt"], fraction=0.15)
                value = checked["score"] - 0.0008 * checked["complexity"]
                experiments.append({"terms": terms, "window": window, "weak_window": weak_window, "validation": checked, "training_rmse": fitted["training_rmse"]})
                if checked["stable"] and value > best_value:
                    best_value = value
                    best = {"terms": terms, "window": window, "weak_window": weak_window, "threshold": threshold}
            except Exception as error:
                experiments.append({"terms": terms, "window": window, "error": str(error)})
    if best is None:
        raise ValueError("No numerically valid observation-validated model")
    final = tools.fit_model(observations, problem["dt"], best["terms"], window=best["window"], degree=3, ridge=0.000001, threshold=best["threshold"], weak_window=best["weak_window"])
    return {"model": final["model"], "hypotheses": [{"claim": "Sparse expressions explain the observed state derivatives", "falsifier": "Failure on independent initial conditions or longer horizons"}], "experiments": experiments, "limitations": ["Selected on one withheld noisy observation trajectory then refitted", "This integral-collocation portfolio is not a full WSINDy reproduction", "Prediction support alone does not establish unique mechanisms or a new natural law"]}
'''}
