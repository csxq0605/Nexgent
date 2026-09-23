# Model-driven orchestration qualification

`python -m experiments.orchestration_qualification.run --root PROJECT --data BBH_DATA --arm fixed_multi`
runs one development item from the pinned two-task BBH subset through the
domain-neutral `multirole_package`. Two proposer roles run from the same public
task, an adjudicator reads both proposals, and a generic skill publishes the
chosen artifact. The BBH adapter scores it independently. An attempt receipt is
written before the first provider call and updated even when the run fails.

Use `--arm single_equal_calls` with the same `--seed` and `--case-index` for a
one-role, three-call draft/review/finalize control. Both packages request at
most three model calls and reserve 1,600 completion tokens per call. The
receipt records actual usage, which must be compared as well as the ceilings.

This is an execution qualification, not an orchestration benefit or RSI result.
The benchmark is public and narrow. A later study must compare fixed multi-role,
equal-budget single-role, memory-only, and evolved O/S packages on unseen tasks.
