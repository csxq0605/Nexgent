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
