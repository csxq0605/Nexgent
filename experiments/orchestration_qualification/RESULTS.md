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

The candidate failed during publication in both tasks: its adjudicator
returned a string-valued `answer` inside the deliverables mapping although the
task required an object. The host rejected the artifact schema. This input
took a publisher path shared by parent and candidate, so the candidate's edited
branch did not complete or activate. All
quality, success, regression, completion, and activation gates failed;
**the candidate was not promoted**. This is a measured negative result for
one candidate on a two-item public selection slice, not a general estimate
of RSI effectiveness. The next research step is to feed rejected-candidate
diagnostics into generation without leaking selection answers, then compare
more than one candidate against fixed, equal-call single-role, and memory-only
controls on independent tasks.

### Failure audit

The generated hypothesis is contradicted by its own development evidence.
That Episode completed, delivered an artifact, and passed host schema
validation; only independent exact-answer evaluation rejected it. The bounded
FeedbackBundle previously exposed the evaluation status and an opaque outcome
digest, but not the host-owned delivery/schema statuses. R0 therefore had too
little positive evidence to justify changing the publishing boundary and
nevertheless guessed a response-shape failure.

The paired score drop cannot be attributed causally to the edited skill. In
both candidate Episodes the adjudicator returned
`{"deliverables":{"answer": <string>}}`; both parent and candidate publish
implementations take the shared `decision.get("deliverables")` path for that
shape and would publish the invalid string. The parent arm happened to receive
nested object values from its separate stochastic model calls and passed. The
candidate's new `if name in decision` branch was not exercised, although it is
a latent regression for a different top-level single-deliverable shape because
it can unwrap an object-schema deliverable to a scalar. The recorded
`behavior_activated=false` is therefore accurate: this trial rejects the
candidate but does not isolate a beneficial or harmful causal effect of its
only code change. Repeated runs or controlled model outputs are required to
separate package effects from provider-output variance.

This was not a completion-budget or truncation failure. Candidate generation
returned 830 completion tokens under a 6,000-token ceiling, and all six
selection Episodes completed their three model calls with short provider
responses before the candidate failed in the deterministic publish skill. The
earlier 6,000-token `finish_reason=length` attempt is evidence that the original
full-manifest output contract was too large for this setup; the compact delta
contract removed that separate failure mode.

The reference feedback now includes only fixed host-owned outcome statuses
(`delivery_status`, `acceptance_status`, and `schema_validation`), never
artifact contents or evaluator diagnostics. Its prompt treats a delivered,
schema-valid Episode as evidence against a publisher/schema diagnosis, treats
digests as identities rather than contents, requires abstention when the
bounded projection cannot distinguish causes, and preserves object deliverable
types across publisher changes. These are domain-neutral generation guards;
they do not use BBH names, answers, or evaluator logic.

### Development preflight after the rejection

The same rejected candidate was later run through a new development preflight
with seed 1. Its two BBH statistical units differed from the generating
development unit; the preflight did not reuse the selection cases. The
[attempt receipt](receipts/preflight-v3-development.json) records all four
parent/candidate Episodes; the [host call ledger](receipts/preflight-v3-call-ledger.json)
records twelve received MiMo v2.6-flash calls, three per Episode. The
parent had one protocol failure and one correct answer (scores 0, 1); the
candidate had two protocol failures (scores 0, 0), and neither changed
component loaded. The Episode-level error was a generic missing
`deliverables` binding, but the persisted publish-node receipts locate the
causal failures at host schema validation: one parent adjudicator supplied an
object encoded as a string; both candidate runs passed a string where the
deliverable schema required an object. The changed publisher branch was not
shown to execute, so these runs do not causally attribute the failure to the
candidate edit. They show a shared brittle model-to-artifact boundary and
candidate non-activation.

This post-selection run is **diagnostic development evidence**, not a second
independent selection or a rescue of the rejected candidate. It motivates
pre-selection execution checks and generic structured-output repair. A later
candidate needs fresh selection units after using these diagnostics.

### Revised R0: second generated candidate and independent selection

With the host-owned outcome statuses above, the same public development
feedback produced [one valid S candidate](receipts/improve-v3-r0-diagnostic-generated.json)
using MiMo v2.6-flash: one model call, 9,495 prompt and 502 completion tokens.
It changed only the adjudicator-role prompt to require a single JSON object
whose top-level keys are the required deliverables. This is a generated
hypothesis about the model-to-artifact handoff, not an orchestration change.

The new [development preflight](receipts/preflight-v3-r0-diagnostic-development.json)
used seed 2 and two statistical units disjoint from generating feedback and
the earlier preflight. Both candidate Episodes completed and scored **1**, and
both loaded the changed role; the two parent Episodes failed
schema validation and scored **0**. This was a promising execution check, but
model outputs differ across paired runs, so it cannot isolate the prompt's
causal effect.

The frozen candidate then used previously unused seed 11 selection units.
The [selection receipt](receipts/select-v3-r0-diagnostic-selection.json)
records **parent 1/2, candidate 1/2**, with the candidate loaded on both tasks.
One task was correct in both arms; the other failed in both. Conservative
normalized work was equal at 29.6 per arm; provider-reported token work was
22.888 versus 22.949. The success-rate and candidate-completion gates failed,
so `eligible=false` and **the candidate was not promoted**. The development
contrast did not replicate on independent selection. These public two-task
samples do not establish an RSI benefit, and the used selection units are now
spent for adaptation.
