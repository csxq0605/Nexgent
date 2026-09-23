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
model, giving JSON output room within the host ceiling. At this point there
was no valid model-generated candidate.

## Compact proposal and independent selection

To remove the full-manifest copying burden, R0 now asks the model only for
changed registry declarations. It assembles the complete child manifest from
the frozen parent and passes the resulting PackagePatch v3 to the **same
host-side validator**. A deterministic gateway test covers the entire
generation, selection, promotion, and guard path with this compact input.

With the unchanged feedback Episode, MiMo v2.6-flash [generated a valid
candidate](receipts/improve-v3-compact-generated.json) in one call (8,744
prompt and 830 completion tokens). The candidate changed the generic
publishing skill. This proves model-to-candidate generation, not improvement.

The candidate and its parent then ran on two BBH `selection` items disjoint
from the development feedback. The frozen [paired result](receipts/select-v3-compact-rejected.json)
used the same three-call/4,800-reserved-token ceiling per arm and actual
three calls for every Episode. The persisted call ledger records
`mimo-v2.6-flash` for all twelve calls, with no provider revision supplied:

| Arm | Exact-answer scores | Success rate | Normalized work |
| --- | --- | --- | --- |
| Parent fixed multi-role | 1, 1 | 100% | 17.0 |
| Generated skill candidate | 0, 0 | 0% | 17.0 |

The candidate failed before publication in both tasks: its edited skill
selected a string-valued `answer` field as the entire deliverable although
the task required an object. The host rejected the artifact schema, the
changed skill did not complete, and component activation was false. All
quality, success, regression, completion, and activation gates failed;
**the candidate was not promoted**. This is a measured negative result for
one candidate on a two-item public selection slice, not a general estimate
of RSI effectiveness. The next research step is to feed rejected-candidate
diagnostics into generation without leaking selection answers, then compare
more than one candidate against fixed, equal-call single-role, and memory-only
controls on independent tasks.
