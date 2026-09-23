# Four-arm confirmatory RSI protocol (design, not yet executed)

Status: protocol design for the next implementation stage. The existing
[`RSIStudyService`](../../src/nexgent/tasks/studies.py) is a two-arm,
empty-memory final-holdout executor. The [four-arm qualification harness](../../experiments/orchestration_controls/harness.py)
checks execution contracts on non-holdout data, but cannot establish a causal
effect. Neither is this confirmatory protocol yet.

## Question and frozen treatments

Use a single registered `F/S/M/E` quartet for each held-out task:

| Arm | Package | Initial memory | Interpretation |
| --- | --- | --- | --- |
| F | Fixed multi-role O/S | Empty | Multi-agent reference |
| S | Single-role, same task hard limits | Empty | Architecture/resource control |
| M | **Same package digest as F** | Frozen accepted M release | Memory-only effect against F |
| E | Frozen evolved O/S package | Frozen M release, if claimed | Full deployed system |

The primary contrast is `E − F` in independent task quality, with success and
conservative work as co-reported constraints. `F − S` checks the fixed
multi-agent architecture; `M − F` checks frozen memory. `E − M` measures the
additional deployed treatment, but **cannot isolate O/S** if E also changes M.
To claim an O/S-by-M interaction, preregister a fifth evolved-O/S/empty-M arm
and analyze a factorial design. Four arms alone do not identify that interaction.

## Registration and execution contract

1. Before inspecting final outcomes, pin benchmark adapter code and snapshot,
   provider/model profile, task family, seeds, statistical unit and source
   cluster IDs, arm packages, accepted M releases, arm order, evaluator identity,
   task capabilities, and all five per-Episode hard limits. A package/release
   digest is the treatment identity; the user-visible name is not.
2. Reserve each final-holdout statistical unit **once for the whole quartet**
   in the same host transaction as the immutable plan. Separate two-arm plans
   must not consume a unit and later be combined into a four-arm report.
3. Randomize the four arm orders within each task, using a frozen schedule
   balanced across source clusters. Each arm receives byte-equivalent public
   task inputs. Memory is frozen per arm and writeback is disabled. The hidden
   evaluator remains host-owned and cannot enter any role prompt or memory.
4. Persist a cell before its first provider/tool side effect. Resume that
   exact Episode after interruption; do not redraw a favorable answer. Check
   real provider receipts and component activation against registered arms.
5. If any cell has infrastructure/evaluator missingness, the entire quartet
   is missing for the primary paired contrast. Retain all raw receipts and
   report missingness by arm and cluster. An observed agent/protocol failure
   remains a measured zero under the frozen outcome policy.
6. Gate comparisons on the host's charged work projection and report actual
   provider prompt/completion tokens separately. Register a total search
   ledger covering failed candidates, feedback Episodes, M admission and
   selection, guard and rollback. Report this outer cost both as a total and
   amortized over a **predeclared** deployment-task horizon; never subtract it
   from only the E arm after seeing results.

## Estimation and decision

The source cluster is the independent unit. Aggregate task-level quartet
contrasts within clusters, then estimate cluster means and intervals from
frozen cluster bootstrap repetitions. Predeclare the three comparisons
`E−F`, `F−S`, and `M−F`; apply Holm adjustment across their p-values. Record
quality, success, regressions, completion, charged work, reported tokens, and
missingness. A positive RSI claim requires an activated evolved treatment,
complete provider/evaluator provenance, positive adjusted `E−F` evidence,
and acceptable frozen safety/cost gates. A null or negative result is still a
completed study if the protocol ran as registered.

## Implementation gates

- Add a separate trusted four-arm study service with atomic quartet-level
  final-holdout reservation, immutable plan/cell/run/report records, and
  memory-release authority checks. Do not relax the two-arm service's old
  protocol or reinterpret its historical reports.
- Exercise registration, interruption recovery, provider/model mismatch,
  cross-arm information leakage, release drift, and quartet missingness with
  deterministic fixtures before any private holdout is reserved.
- Run the public qualification harness first with real F/S/M/E calls and an
  accepted M release. Its descriptive output cannot satisfy the final gate.

Current status: none of these confirmatory execution gates is complete; no
final-holdout quartet has been registered or consumed.
