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

## Multi-component R0 generation qualification

The host now accepts one atomic `PackagePatch v3` spanning O/S workflow,
roles, prompts, skills, and manifest changes. A deterministic model double
completed the whole feedback → generated candidate → paired selection →
promotion → guard path with a package that replaced a workflow, role prompt,
and publishing skill, removed a role, and added a new role. This verifies the
contract and evidence plumbing, **not model quality**.

The same public BBH development feedback then went to the reference R0 with
`mimo-v2.6-flash` and a 6,000-token completion ceiling:

| Receipt | Outcome |
| --- | --- |
| [Setup](receipts/improve-v3-setup-failure.json) | Requested 12,000 tokens exceeded the TaskService host ceiling; zero model calls. |
| [Dependency](receipts/improve-v3-dependency-failure.json) | Wrong Python environment lacked `openai`; one failed local worker call, no provider response. |
| [Thinking budget](receipts/improve-v3-budget-exhausted.json) | MiMo returned `finish_reason=length`, using all 6,000 completion tokens; no candidate. |
| [Non-thinking](receipts/improve-v3-invalid-patch.json) | MiMo returned 1,248 completion tokens, but the patch was invalid; no candidate. |

The last response included three role replacements, but placed
`activation_targets` inside `child_manifest` and omitted a valid workflow
registry reference. Moving that field alone still leaves an invalid child,
so this is a model-output failure rather than a hidden evaluator result.
The gateway now sends MiMo's verified `thinking: disabled` setting for this
model, giving JSON output room within the host ceiling. There is **no real
model-generated v3 candidate and no measured RSI improvement** yet. Next,
reduce the model-facing manifest burden while retaining host-side atomic
validation, then rerun selection on unseen development tasks.
