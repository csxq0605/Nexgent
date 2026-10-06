# Tool work-unit accounting

Nexgent records tool invocation count and numerical work separately. A call to
a lightweight metadata reader and a call to an external solver therefore no
longer have to carry the same cost in P3 selection, recursive-improver
evaluation, guards, or P5 studies.

## Host contract

`ToolSpec.work_units_per_call` is a nonnegative integer reservation fixed when
the host installs the tool. The task budget contains `max_tool_work_units`.
Before calling the handler, `EpisodeStore.reserve_tool` atomically reserves the
declared amount against the root Episode, alongside the existing call-count
reservation.

A trusted handler may call `ToolContext.charge_work(positive_integer)` before
each additional unit or batch of numerical work. Each increment is validated
and committed to the host ledger before the handler continues. Negative,
floating-point, NaN, and post-settlement changes are rejected. Values returned
inside a domain result, including a field named `work_units`, have no accounting
authority.

Settlement records:

- `reserved_tool_work_units`: declared conservative baseline;
- `tool_work_units`: measured increments when every call settled;
- `charged_tool_work_units`: `max(reserved, measured)` per call, summed across
  the root Episode;
- `tool_usage_missing_call_ids`: reservations with no durable settlement.

Cost gates use `charged_tool_work_units`. A handler that measures less than its
reservation cannot obtain a refund. A crash after reservation is charged at
the reservation and makes `usage_complete=false`. RPC replay uses the durable
terminal receipt and does not invoke or charge the tool again.

Existing tools declare the explicit zero baseline by default and need no code
change. A task cannot run a tool with a positive reservation unless its frozen
budget opts into sufficient `max_tool_work_units`.

## Trust boundary and limitation

Task-authored and adopted controlled Python tools use a host worker meter
instead of a trusted handler's `charge_work` calls. Both paths count the same
CPython trace events (`call`, `line`, `return`, `exception`), reserve at least
one unit and cap each worker at the root's remaining work allowance, up to
200000 events. A portable tool's larger declared reservation remains a floor.
The default task API work budget is 200000; an explicit zero remains zero.
Existing frozen task and research budgets retain their original limits.

The host charges measured worker work before checking the output contract.
Worker exceptions and instruction exhaustion carry the measured count; the
event that triggers hard termination is included. `add_tool_work(consumed=True)`
commits that already consumed work even when it exceeds the budget, then
raises `BudgetExhausted`. It does not authorize more work or change the gate.
Other trusted-handler increments retain their admission-before-work behavior.

Timeout, cancellation or worker communication failure without a measurement
settles with `usage_complete=false`; its unknown work cannot become a complete
zero cost. Parallel workers use the remaining allowance observed at their own
start. They do not share an advance allocation of instruction quotas; if their
combined consumption exceeds the root budget, settlement preserves the actual
consumption and raises exhaustion. Trace work is not a CPU instruction count.

The framework controls validation, atomic accounting, aggregation, and replay.
Installed handlers are trusted host code. Nexgent cannot infer the FLOPs,
solver iterations, remote CPU time, or vendor billing of an arbitrary native
library or external service. A handler that performs undeclared dynamic work
without calling `charge_work` is still charged its fixed reservation, but the
framework cannot discover work above that baseline.

Canonical scientific plugins should therefore use a conservative fixed
reservation for irreducible work and charge deterministic solver operations at
their execution boundary. Work units are an auditable experiment-specific
proxy; they are not wall time, FLOPs, energy, or currency. Those measurements
must remain separate receipts when available.

## Shared P3/P5 cost projection

P3 selection and P5 studies use the same versioned normalized-work projection.
The gate value remains conservative: model calls, non-refundable charged
completion-token reservations, tool calls, charged tool work, and nodes are
weighted and summed. This value protects budgets and is the only projection
used by promotion or study work gates.

When every model call has complete provider-reported usage, the projection also
records a descriptive value that replaces charged completion tokens with the
reported prompt plus completion tokens. If any call lacks either token count,
that value is `null`; partial known totals are never presented as complete.
Provider-reported token work does not refund a reservation or alter a gate.

Both values are normalized estimates for comparisons under one frozen protocol.
They are not vendor prices, invoices, or monetary cost. Pricing requires a
separate provider/model price schedule and billing receipt.

## Native Main and workspace computation (2026-10-06)

Native DSH completions enter the same host model admission and receipt chain.
The workspace `run_python` handler now calls the shared metered worker through
its admitted ToolContext receipt, so a numerical verification is no longer
reported as zero worker work. A failed computation retains its measured count;
a missing timeout measurement remains unknown. Historical records are retained
as recorded and are not backfilled with inferred work.

Main's host evaluator limits verification actions to the remaining resources
and leaves a model admission slot for its verdict. Numerical/file requirements
still need actual verification receipts; a smaller action allowance does not
turn missing evidence into acceptance. The host can inspect immutable sources
of actually used candidate tools as data, without granting their execution.
