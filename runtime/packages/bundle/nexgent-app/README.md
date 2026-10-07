---
description: "MiMo defaults shipped with the Nexgent browser and headless application."
kind: "package-bundle"
---

# @nexgent/application

English | [中文](README.zh.md)

## Summary

The shipped `nexgent` and `nexgent-run` profiles complete general tasks using MiMo-V2.6-Pro, native tools and durable sessions. This private application layer supplies their defaults and local request records. It is built with the application's source and needs no separate installation into an external DSH deployment. Host-configured output policies can evaluate, adopt and reuse a candidate, then roll back an execution failure. Ordinary-task feedback and code-artifact evolution remain separate work.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

The application's shipped profiles include this layer after the inherited base and browser or headless layer. The application's root `start.ps1` and `run.ps1` select those profiles. Credentials come from `NEXGENT_API_KEY` through the native credential service. Endpoint overrides belong in the native model configuration. Architecture graphs run through the native workflow tool and are saved under the project data directory. New Sessions can explicitly execute a saved `architectureVersion`; this does not select or adopt it automatically.

The inserted `nexgent-architecture-trials` row loads `@nexgent/application/trials`. Its default empty `plans` list exposes no trial tool. A host supplies plans through a native profile patch: each plan contains `id`, `description`, a `baseline` graph and non-empty `cases` with unique `id`, JSON `input`, `outputNode` and JSON `expected`. Criteria and baseline are validated and detached at composition time; later mutation of the deployment object cannot change an active plan. Config fields `maxCaseMs` and `maxTotalAgents` bound each case (defaults 180000 milliseconds and 32 members).

For exploratory plans, `architecture_trial` accepts `planId` and exactly one candidate `architecture` or saved `architectureVersion`. The baseline and candidate execute each input separately through the native workflow engine, with fresh members and the inherited task policy. Host compilation replaces every member's global-tool mask with an empty allow list, retaining native scoped structured output. This mode evaluates output-producing graphs; it cannot evaluate file-writing or tool-dependent candidates. The graph digest still identifies the definition; the receipt additionally identifies this execution mode and the compiled script.

The host compares the actual selected node output with frozen JSON by exact structural equality. A candidate passes only when every candidate output matches and both arms have known outcomes. Non-matches are `fail`; execution, missing output, cancellation and cleanup failures are `unknown`. Every run is disposed before its case outcome is recorded. Cases execute once per call, without retries or replacement sampling. Unloading cancels and drains active calls. Synchronized receipt failure rejects the call and leaves an incomplete receipt; it cannot produce a successful trial. A pass neither adopts a version nor establishes relative improvement.

Optional `policies` contain `id`, `description`, `selectionPlanId`, `guardPlanId` and a positive `maxCandidates`; they require an absolute `activationDirectory`. Each policy freezes two different plans with the same baseline, one output node and disjoint inputs. Reserved plans cannot be called through the exploratory tool. The policy digest includes criteria, baseline compilation and execution limits. `architecture_adopt` accepts `policyId` and exactly one candidate graph or saved version. The candidate must pass every selection case, strictly improve the baseline's pass count and then pass every independent guard case with known outcomes. Ties, failures and unknown outcomes do not adopt. Each candidate consumes a persistent attempt slot before evaluation; repeated candidates, including interrupted attempts, cannot be resampled across processes.

`architecture_run` accepts `policyId` and an object `input`, then automatically resolves the accepted version or frozen baseline. Adopted execution retains the output-only tool mask and checks the approved compiled script digest; a compiler change requires new evaluation. Each task drains its native run before returning. Missing structured results, execution failure, deadline expiry or cleanup failure can commit a rollback to baseline for subsequent tasks; user cancellation and unload cannot. Rollback does not replay the failed task. A completed task output has no automatic quality score. Further evolution against an accepted candidate needs a newly frozen comparison policy.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [patch](cordis.patch.yml) replaces defaults by row identity. The inherited Agent owns model execution, filesystem tools and persistence; this layer adds no Python executor, model gateway or per-task SDK carrier. Profile overrides remain available through the native configuration surface. No invariant companion is published because this observer owns no cross-service mutable relation; inserted row owners retain their invariants. [Profile loading](../../boot/app-boot/README.md) and the [base runtime](../base/README.md) own composition and execution.

The application's `ExecutionLedger` observes the native `llm/stream` waterfall, including members and auxiliary calls. Each composition owns one exclusive JSONL file under `execution-ledgers` in the application data directory, synchronizes each append and closes the file on unload. Start and settlement records preserve route, supplied Session identity, purpose, termination and the last reported usage sample. Prompt text, credentials and provider error text are excluded. Missing or invalid usage stays explicit; reasoning is an output subset and is not added again. Shutdown records report storage failures. The reader rejects malformed records, duplicate settlements, incomplete lines and records after shutdown. Absent shutdown or unfinished requests prevent complete-observation claims. This sidecar adds no released Session event or generation.

With configured plans, the parent sees plan ids and descriptions, trial tool guidance, its candidate call and a JSON summary with `pass`, `fail` or `unknown`, case outcomes and `adopted: false`. Expected values are omitted from the schema, member inputs and returned summary. Native member sessions preserve their prompts and actual outputs. Trial receipts under `architecture-trials` link the parent, workflow and member identities to `execution-ledgers`; baseline and candidate definitions are saved under `architectures`. Missing terminal records are incomplete observations. No released Session type changes.

The [activation store](src/architecture-activation.ts) synchronizes a complete private file before publishing it through an exclusive hard link. Immutable numbered revisions link to the preceding record's digest; malformed or missing revisions reject execution. A concurrent winner prevents a stale adoption or rollback from replacing the revision observed before evaluation or task execution. Reservations and terminal decisions remain separate from activation revisions; a crash after reservation cannot authorize replay. A committed revision is authoritative even if a later tool-result write fails. These local unsigned records do not protect against a host that can rewrite them; file synchronization is not a cross-platform guarantee against directory-entry loss after power failure.

</details>

<a id="model-experience"></a>
## Model Experience

Indirectly, through each inserted row's module, whose native behavior is described above.

#### KV Cache effect

The application persona changes the system prefix. Inherited prompt and provider packages own request assembly and caching; this layer does not measure cache savings.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Frozen JSON comparisons and adoption cover configured output-only tasks. Code-artifact and tool adoption, ordinary-feedback candidate generation and routing, context/executor evolution and normal-task quality regression remain migration work. Selection and guard inputs are disjoint, but plans and local records are host-readable and reused within the frozen attempt budget; they are not a sealed final holdout or a tamper-resistant evaluator. Passing these cases establishes no general benefit, paid-cost improvement or recursive improvement.
- Stream observations include replay and middleware responses; adapter-internal transport retries are not separately observed. The local, unsigned ledger is not an invoice or an independent selection guard. Storage warnings, missing buckets and incomplete lifecycles prevent corresponding accounting claims.
- The application retains platform confinement requirements; Windows ACL errors remain tool failures rather than granting unrestricted execution.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
