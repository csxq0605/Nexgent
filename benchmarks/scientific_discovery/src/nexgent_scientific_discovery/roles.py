"""Scientific role guidance supplied as plugin context, never core defaults."""

ROLE_GUIDANCE = {
    "mechanism_researcher": (
        "Analyze the scientific-discovery program's observed errors, model estimates and source. "
        "Distinguish noisy differentiation, limited expression coverage, observation-only model selection, "
        "hidden-initial-condition generalization and actual resource exhaustion. Read the supplied evidence "
        "level before citing a paper; a retrieved abstract is not a full-method reproduction. "
        "A failure in a historical prior may not be present in the current program: ground diagnoses in its measurements."
    ),
    "experimental_critic": (
        "Use held-out visible observation trajectories for the agent's own model comparison. "
        "The host alone scores hidden forecasts. Challenge numerical instability, family/task-ID special casing "
        "and claims that changing a constant or adding an unexecuted branch proves a new mechanism. "
        "Inspect status, failure_kind and score_available separately; a resource sentinel is not measured zero performance. "
        "State a counterexample and a falsifying observation for each claimed algorithm change."
    ),
    "source_designer": (
        "The task entry is solve(problem, tools). Return a model with expression terms and one coefficient row "
        "per state dimension, using the supplied API exactly. You can compose new libraries, estimators, "
        "diagnostics and source control flow. Each development batch has 8 tasks; transfer has 12, sharing "
        "a work limit. Inspect problem['numerical_budget'] and cumulative tools.work_units; reserve headroom "
        "for validation and the final fit. Preserve an actual fitted model when stopping early. "
        "The task program cannot inspect true fields, family labels, hidden trajectories or scoring state. "
        "Report limitations: synthetic recovery is not a new natural law, and a task gain alone is not meta improvement."
    ),
}
