# Four-arm assessment contract v1

`FourArmAssessmentService` is a downstream, domain-neutral reader for sealed
`FourArmStudyService` records. Its trusted entry point accepts a run ID, reads
the run and plan through `run_record()` and `plan()` (which verify the private
SQLite records), and then performs a pure deterministic assessment. It has no
benchmark adapter, TaskService, model client, execution method, or holdout
reservation capability. Unit tests use the pure assessor so they do not consume
final-holdout units.

## Frozen estimands

The v1 schema fixes one family of three quality comparisons:

1. `E−F` is primary: the deployed evolved treatment versus fixed multi-role.
2. `F−S` is auxiliary: fixed multi-role versus the single-role control.
3. `M−F` is auxiliary: frozen accepted memory versus empty memory under the
   identical F package.

The source `cluster_id` is the independent unit. Task-level values are first
averaged inside each source cluster; clusters then receive equal weight. Thus,
adding seed variants from one source cannot increase the independent sample
count or dominate an estimate.

For each comparison, the report retains cluster-level and aggregate quality,
success, and host-charged work contrasts. It gives deterministic 95% percentile
intervals from 10,000 source-cluster bootstrap resamples. Quality uses a paired,
two-sided sign-flip test. The three predeclared quality p-values form one Holm
family, including auxiliary comparisons whether or not they look favorable.

## Missingness and decisions

The missingness rule is shared across the entire comparison family. If any arm
in a task lacks a measured finite score, boolean success outcome, or valid
host-charged work projection, the whole quartet is excluded from all three
contrasts and retained in `missing_quartets` with per-arm status and reason.
Any missing quartet blocks a positive result.

The v1 sample gate is at least five independent source clusters, matching the
default confirmatory threshold used by the existing two-arm study layer. This
threshold, confidence level, resample count, sign-flip test, and Holm ordering
are constants of the versioned assessment schema; callers cannot tune them
after outcomes are visible.

Statistical support and engineering constraints are separate fields. The
primary quality interval must be strictly positive and its Holm-adjusted
p-value below 0.05. Missing quartets or fewer than five clusters produce
`inconclusive`. With complete data, the quality decision is named either
`benchmark_local_quality_treatment_effect_supported` or
`benchmark_local_quality_treatment_effect_not_established`.

Success and charged work are independent engineering results. Their
source-cluster mean noninferiority flags remain visible, and quality support
plus charged-work noninferiority yields `efficiency_supported`. Increased work
does not erase an otherwise supported quality treatment effect. Conversely,
all arms sharing the same hard ceilings does not mean they used the same actual
work: if E consumes more calls or tokens, this design cannot attribute its
quality effect specifically to orchestration rather than additional compute.

This layer is never eligible to emit an RSI-gain claim. The current four-arm
plan does not authenticate E as a descendant of the R0 generation, selection,
promotion, and guard chain. Package assignment also does not show that changed
O/S components actually ran, or that registered memory was retrieved and
affected an Episode. Four arms cannot identify an O/S-by-memory interaction,
and this report does not include outer feedback, generation, selection, guard,
rollback, or failed-search cost. Those lineage, activation, and full-cost
records require a separate joined evidence layer before any benchmark-local RSI
claim; cross-benchmark evidence is additionally required for a general RSI
claim.
