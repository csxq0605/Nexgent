# Framework MemoryService lifecycle

Date: 2026-09-21  
Status: auditable M-data engineering slice; no claim of memory-policy RSI benefit

## Purpose

`MemoryService` makes reusable memory an explicit, versioned behavior resource
bound to an `AgentPackage`. It is part of the general task runtime and has no
benchmark, demo, domain answer or evaluator logic. Benchmark plugins remain
responsible only for supplying tasks and host-private evaluation.

This slice closes the storage and deployment mechanism for M-data. It does not
establish that an evolved retrieval/writeback policy improves tasks, nor does it
attribute an observed gain to M-policy rather than changed data. Such a claim
requires a pre-registered paired experiment that independently varies and
measures those factors.

## Objects and authority

A `MemoryVersion` is immutable and contains two separately hashed subobjects:

- `policy`: the bounded retrieval and writeback behavior enforced by the runtime;
- `data`: accepted memory items, including scope, counterexamples and evidence refs.

The policy here is only the runtime's small declarative envelope (literal lookup
limit and writeback kinds). Executable M logic still belongs to the immutable
`AgentPackage`; changing that logic requires a package generation. A
`MemoryVersion` therefore cannot supply code or replace the package's O/M/S
components, and every release is bound to one exact package id and digest.

Each version records its AgentPackage id/digest, parent id and generation. The
lifecycle status is `candidate`, `accepted`, `rejected` or `retired`. Status is an
archive/assessment property; it is separate from deployment. A `MemoryRelease`
channel is a CAS pointer to one accepted version plus a monotonically increasing
revision. Promotion and rollback move only that pointer. Retirement is a separate
host action and refuses the active version and the exact predecessor required to
roll that active deployment back.

Only trusted host code can create a selection plan, record a decision, promote,
rollback or retire. Package capabilities expose search and candidate writeback,
not lifecycle methods. This implementation assumes one trusted host/process
security domain around the SQLite ledger. It does not yet provide principals,
remote authorization or cryptographic signatures between mutually distrustful
services.

## Selection and release contract

The host admits proposed content as `candidate`; admission alone never makes it
visible to later Episodes. Before deciding, `plan_selection(...)` freezes:

- candidate, parent and AgentPackage identities;
- host criteria and evaluator snapshot/digest;
- for a child, the exact target channel revision and active parent release.

`assess(...)` rejects evaluator or release drift. An accepted child can be
promoted only if its decision points to that frozen plan and the release still
matches. The SQL update compares channel, active memory id and revision. A stale
or concurrent writer fails closed. Rollback follows the recorded deployment edge
and uses the same CAS conditions.

Root versions use a selection plan without an existing release edge. This is the
explicit bootstrap path; there is no implicit acceptance.

## Episode freeze and information boundary

`TaskService.create(..., memory_channel=..., expected_memory_registration=...)`
resolves an accepted version and checks that it belongs to the selected
AgentPackage. Registration and the full memory snapshot are written in the same
SQLite transaction as Episode creation. Validation, integrity or size failure
therefore leaves no half-created Episode with a missing snapshot.

The snapshot copies policy, item versions and source release identity. In-flight
and delegated Episodes keep that snapshot even if the channel is promoted or
rolled back. A delegated Episode cannot switch the inherited version or use it
with another package.

Legacy `remember(...)` writes an untrusted `candidate` claim. That claim can be
read by its producing Episode for explicit audit/snapshot work, but another
Episode cannot retrieve it. Accepted/released MemoryService data is the only
default cross-Episode seed. Final holdout and `memory_writeback=False` restrictions
remain stronger than a version's writeback policy.

The package-visible task context contains no channel registration. Full resource
content, provenance, selection criteria, evaluator snapshot, decision reason and
evidence stay in private tables. Public projections use allowlists and expose only
version/channel identities, digests, lineage, status, item count, decision identity
and hash-linked release events. Hidden evaluator data and task content are not
projected.

Package and memory channels are separate CAS pointers. Episode creation rejects
a pair whose package ids or digests differ. Moving both pointers is not an atomic
compound deployment in this slice, so a coordinated package-plus-memory rollout
can have a temporary fail-closed interval until both heads match; a compound
release object is required before claiming availability-preserving joint rollout.

## Current boundaries and next work

Implemented and contract-tested:

- candidate isolation; accepted/rejected/retired archive states;
- version lineage and AgentPackage binding;
- frozen host selection input and release edge;
- CAS promotion/rollback and stable historical Episode snapshots;
- policy enforcement, public redaction and corruption fail-closed checks.

Not implemented in this slice:

- principal-aware authorization across multiple trust domains;
- automatic consolidation of Episode candidate claims into a new version;
- a benchmark-independent paired runner that separately identifies M-policy and
  M-data effects;
- guard thresholds and statistical evidence of memory improvement.
- an atomic compound release for coordinated AgentPackage and memory-channel
  promotion/rollback.

Until those are implemented and run with real Episodes, this is an auditable
deployment mechanism, not evidence that memory evolution or RSI is effective.
