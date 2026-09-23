# Pure-M qualification pilot

This experiment drives the real framework path:

`development Episode -> FeedbackBundle -> default R0 -> generated M candidate -> host selection -> MemoryService promotion -> frozen reuse`

It is domain-neutral. The task package contains the existing three-role
model-driven workflow plus one explicit `M` resource. Its prepare skill performs
a bounded retrieval and passes the retrieved items to the roles. The benchmark
adapter still owns task sampling and private evaluation; this experiment never
reads an expected answer or copies evaluator-private content into the improver
input.

## Evidence claim

One completed run establishes only that a real model-generated pure-M candidate
can pass through independent host selection, CAS promotion, and a later Episode
that freezes and consumes the promoted version. It does not isolate an M effect:
there is no paired parent arm or repeated estimate here. The confirmatory
four-arm study remains responsible for causal comparison.

An abstention, invalid patch, rejected benchmark result, absent memory
consumption, or reuse failure is retained as a negative qualification result.
The pilot never promotes after any of those outcomes.

The current `FeedbackBundle` gives R0 the public objective and host-owned
outcome status, but no hidden gold answer or answer-derived correction. R0 is
expected to abstain when that projection cannot support a falsifiable complete
memory-surface replacement. A future richer signal must be a benchmark SDK
feature that explicitly declares a bounded development-diagnostic projection;
the pilot must not infer or extract one from the private evaluator.

## Before running

- The project root must have an installed canonical task benchmark and a model
  configuration. For the current real run, the temporary lab configuration
  should resolve all task and improver roles to `mimo-v2.6-flash`.
- The benchmark must supply `development` and `selection` tasks with stable
  `statistical_unit_id` values. A fresh development unit is also required for
  reuse.
- Choose seeds whose units have not been used by an older experiment outside
  this pilot's ledger. The local ledger prevents replay and cross-attempt reuse
  only for attempts created by this script; it cannot discover historical units
  that another runner failed to record.
- Do not point `--reuse-split` at a final, transfer, meta-transfer, or
  confirmation pool. Those split names are rejected by the script.

Run from the repository root with the source and installed benchmark on
`PYTHONPATH`:

```powershell
$env:PYTHONPATH = 'src;benchmarks\bbh\src'
& 'E:\PKU\program\2026\Aug\te\NExgent\.venv\Scripts\python.exe' `
  -m experiments.memory_qualification.pilot `
  --root 'E:\PKU\program\2026\Aug\te\NExgent-orchestration-lab' `
  --benchmark bbh `
  --bbh-data 'E:\PKU\program\2026\Aug\te\NExgent\.nexgent\benchmarks\bbh' `
  --feedback-seed 5 `
  --selection-seed 29 `
  --reuse-seed 7 `
  --attempt-id memory-attempt-bbh-mimo26-001
```

These three seeds currently resolve to pairwise-disjoint public BBH statistical
units. They still must be checked against every older experiment database and
receipt immediately before the real run. `--bbh-data` is an explicit adapter
construction path for a source checkout where Python entry-point discovery does
not expose BBH; the qualification core remains benchmark-neutral.

## Anti-double-spend and receipts

Before the first model-bearing Episode runs, the pilot:

1. resolves all three public task references;
2. verifies their statistical units are pairwise disjoint;
3. writes a sanitized attempt receipt; and
4. atomically reserves the units in experiment-owned SQLite ledger tables.

The development Episode id is checkpointed immediately after creation. After
generation returns, its generation and Episode ids are checkpointed. The memory
selection plan id is checkpointed before candidate execution, and the reuse
Episode id is checkpointed before execution. A rerun cannot automatically
replay the attempt or spend any reserved unit under another attempt id.

There is one explicit recovery limit: `GenerationService` allocates its
generation id internally, so an interruption during its single external call
can leave only the feedback bundle and the underlying admitted Episode/call
ledger as recovery evidence. The pilot fails closed and will not issue a second
call. An operator must audit the task database rather than rerun the attempt.

Exported JSON contains ids, digests, public score fields, usage, activation
booleans, and provider/model receipt metadata. It excludes public task payloads,
memory bodies, evaluator-private answers, credentials, and raw exception text.

## First real MiMo v2.6-flash attempt · 2026-09-23

The [sanitized attempt receipt](receipts/mimo26-pure-m-attempt-1.json) used BBH
development seed 5, selection seed 29, and reuse development seed 7. Their
statistical units were checked against this lab's earlier benchmark
registrations before the call. The development Episode made three received
MiMo role calls, completed evaluation, and scored 0. Default R0 then made one
received MiMo call (7,913 prompt / 94 completion tokens) and explicitly
returned `decision=abstain`. Generation is recorded as `missing` with a
`PackageError` from the frozen improver output contract; it did **not** create
an M candidate. The pilot stopped before selection, promotion, or reuse.

This is a real negative generation result, not an M effect estimate. In this
case the bounded public feedback did not support a falsifiable full M-surface
replacement. The selection/reuse task payloads and hidden answers were not
shown to R0. The reserved units remain marked spent in the attempt ledger;
any revised pilot needs new independent units.
