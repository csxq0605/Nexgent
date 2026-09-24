# Workbench task plugin

An optional, independent non-CFD plugin for the vNext task executor. Install it
with `python -m pip install -e benchmarks/workbench`. Its entry points are
`nexgent.domains:workbench` and `nexgent.task_benchmarks:workbench`; core does not
need to import or install this package to run ordinary tasks.

The small authored operational fixture contains versioned invoice rows from an
ERP and a billing export: newer revisions, identical duplicates, unresolved
equal-version conflicts, deletion, invalid currency/amount/revision, and stable
row/record IDs. This is a real artifact-processing task, using authored data. It
is not external population data or evidence of statistical effectiveness.

The public exclusion contract is exact: `excluded_rows` contains every invalid
input row exactly once and contains no valid row. A valid lower-revision row is
superseded when selecting the reconciled record, but it is still valid and is
not an exclusion. For an invalid row, `reason` is the first failing field in the
published `invalid_reason_order`. This rule is part of the task input and does
not disclose any fixture-specific answer.

`benchmark_adapter().tasks("development", 0)` returns one manageable task with
the sources and explicit policy as JSON inputs, two JSON delivery contracts
(`ledger`, `report`), allowed effects and public capabilities. The agent must
inspect its source artifact, reconcile the data itself, publish ledger and
report artifacts, check their schemas, repair errors, and deliver them. The
tools do not generate the reconciled answer:

- `workbench.inspect_sources(source_ref)` reads an artifact and returns shape
  issues, revision inventory, and its content digest.
- `workbench.validate_delivery(ledger_ref, report_ref)` reads actual delivery
  artifacts and returns public schema and policy-consistency errors plus the
  delivery digest. Feedback uses rule-level error codes and never returns the
  expected records, values, totals, or the hidden acceptance result. Agents are
  expected to repair a rejected draft, republish it, and validate the final
  artifact versions; mentioning the tool name in prose does not create a receipt.

The host passes resolved final delivery values plus original frozen inputs and
actual broker receipts to the independent evaluator. Acceptance requires exact
ledger/provenance, conflict sets, aggregate/exclusion results, frozen input
integrity and matching successful inspection/schema-validation receipts. A
validated draft does not satisfy the contract for a different final delivery.
The evaluator/oracle is host-only and is never a tool or part of task inputs.
Feedback provides correctness flags and reasons, without disclosing expected
answers. The host must isolate benchmark implementation and evaluator files
from candidate code and must supply receipts itself; agent-authored receipts
are not accepted execution evidence.

`development`, `selection`, `guard` and `final_holdout` have separate
deterministic source/record identities at every seed. `dev` aliases
`development` only. Seeds change order and amounts within their own split. The
snapshot fingerprints the fixture, policy, schemas and evaluator source.
`guard` is reserved for post-promotion monitoring and does not feed candidate
generation or selection. Final holdout is for a frozen evaluation protocol,
not tuning; research comparisons and efficacy conclusions belong to P5.

For the authorized real-provider smoke task, select development seed 0, choose
the installed domain and the normal task executor/package, and configure a
modest root budget (for example 12 model calls and 8 tool calls). This package
does not call providers or launch experiments. Such a run can establish actual
task execution, not general efficacy.

`tasks("development", 0, controlled_failure=True)` opts into a clearly labeled
synthetic recovery trial. The first admitted inspection throws
`ControlledToolFailure`; subsequent calls proceed normally. `context.once(key)`
must be an atomic, durable root-task-scoped host claim shared by descendants,
so stop/resume, retries, and delegation do not inject another failure. All
original acceptance criteria remain active. Acceptance also requires exactly
one matching synthetic failure receipt, plus successful inspection and final
delivery validation. Missing or repeated injection is rejected.

`tests/test_workbench_plugin.py` contains deterministic **contract tests** with
a fake artifact context and host-style receipts. They do not establish real
provider behavior, runtime recovery, RSI benefit, or statistical improvement.
