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

`python -m experiments.orchestration_qualification.improve_v3 --root PROJECT
--feedback-episode EPISODE_ID` freezes development feedback from a prior
qualification Episode and asks the reference R0 to generate a PackagePatch v3.
The receipt is saved before the model call. This step can yield a generated
candidate or durable missing evidence; generation alone never proves benefit.
The complete child manifest makes this a demanding model-output contract.
The reference R0 also accepts a compact model proposal containing only
changed manifest registry entries; it assembles the complete child for the
same host validator. `python -m experiments.orchestration_qualification.select_v3
--root PROJECT --data BBH_DATA --candidate-id CANDIDATE_ID` pre-registers
disjoint BBH selection tasks, then runs the parent/candidate pair under the
same three-call hard budget and records the independent decision. Use the
current worktree's `src` and `benchmarks/bbh/src` on `PYTHONPATH` when a
different editable BBH checkout is installed in the Python environment.

Before spending the selection pool, `python -m
experiments.orchestration_qualification.preflight_v3 --root PROJECT --data
BBH_DATA --candidate-id CANDIDATE_ID --seed 1` runs a paired development
preflight through the same `EvolutionService` and `TaskService`. It rejects
overlap with the generating feedback task before model calls, records only
bounded execution/score/activation diagnostics, and makes no promotion
decision. A candidate that fails publication or schema checks here should be
revised using new development evidence; a selection split used for revision
is spent and cannot be counted as independent selection again.
