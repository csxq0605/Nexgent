# Model-driven orchestration qualification · 2026-09-23

## Scope

One public BBH `boolean_expressions` development item was run through the same
canonical `TaskService` task and independent evaluator. The task id is
`bbh/bbh-two-task-task-v1/development/0/bbh-2cd2be58324283dbec774385`.
Both final arms had the same 3-call/4,800-reserved-completion-token ceiling and
used `mimo-v2.6-flash` for every observed model call. The provider did not
return a revision/fingerprint, so the model identity is bounded to this run's
time window. The code contains no BBH-specific answer or evaluator access.

| Attempt | Package behavior | Result | Observed usage |
| --- | --- | --- | --- |
| [1](receipts/attempt-1790135832878.json) | Multi-role, MiMo v2.5 | 3 model roles ran; publish rejected a direct-content response; observed protocol failure, score 0 | 3 calls, 1,404 prompt / 193 completion tokens |
| [2](receipts/attempt-1790135924396.json) | Multi-role, MiMo v2.5 | 3 roles ran; publish rejected a name-to-content response shape; observed protocol failure, score 0 | 3 calls, 1,312 / 105 tokens |
| [3](receipts/attempt-1790136081963.json) | Fixed multi-role, MiMo v2.6-flash | 2 parallel proposals, adjudication, publication and host evaluation completed; answer mismatched, score **0** | 3 calls, 1,318 / 210 tokens |
| [4](receipts/attempt-1790136238222.json) | One solver, 3 sequential calls, MiMo v2.6-flash | Publication and host evaluation completed; answer matched, score **1** | 3 calls, 1,248 / 122 tokens |

The first two failed attempts remain in the archive; their model and format
differences make them unsuitable for the final two-arm comparison. Attempts 3
and 4 show that benchmark execution is genuinely model-driven and that the
fixed multi-role graph can perform worse than an equal-call single-role graph.
This is **one public development case**, without randomized order, repeated
tasks, memory-only arm, generated O/S candidate, or a frozen holdout. It
establishes neither a general negative effect nor RSI benefit. The immediate
research question is whether feedback-generated orchestration or skill changes
can improve later unseen tasks under the same budget and whether they beat
fixed multi-role, single-role, and memory-only controls.
