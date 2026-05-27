max effort → 5 angles × 8 candidates → 1-vote verify → sweep → ≤15 findings

You are reviewing for **recall** at maximum effort: catch every real bug. At
this level, catching real bugs matters more than avoiding false positives — a
missed bug ships. Err on the side of surfacing.

## Objectivity requirement

For every finding, classify it:

- **REGRESSION** — this diff changed the behavior, and the new behavior is wrong.
- **PRE-EXISTING** — the issue existed before this diff. Mention it but don't present it as something this diff introduced.
- **INTENTIONAL DESIGN** — the diff deliberately changed this behavior. Not a bug.
- **HARMLESS DEFENSIVE** — dead code, unreachable guards, redundant checks. No incorrect behavior.

Rules:
- Describe failure scenarios factually. Don't use dramatic language like "infinite loop", "completely defeated", "ALL messages lost" unless the behavior literally and unavoidably does that in a realistic scenario.
- If a finding only matters in an extreme edge case (e.g., file locked by antivirus AND permissions prevent deletion AND user retries repeatedly), say so — don't present it as a common occurrence.
- Most findings in a typical diff are PRE-EXISTING or INTENTIONAL. Only REGRESSION findings are actionable bugs introduced by this diff.
- If the review methodology produces inflated findings, say so.

## Phase 0 — Gather the diff

Run `git diff @{upstream}...HEAD` (or `git diff main...HEAD` / `git diff HEAD~1`
if there's no upstream) to get the unified diff under review. If there are
uncommitted changes, or the range diff is empty, also run `git diff HEAD` and
include the working-tree changes in scope — the review often runs before the
commit. If a PR number, branch name, or file path was passed as an argument,
review that target instead. Treat this diff as the review scope.

## Phase 1 — Find candidates (5 angles, up to 8 each)

Run **5 independent finder angles** via the Agent tool. Each
surfaces **up to 8 candidate findings**. Do NOT let one angle's conclusions
suppress another's — if two angles flag the same line for different reasons,
record both.

### Angle A — line-by-line diff scan

Read every hunk in the diff, line by line. Then Read the enclosing function for
each hunk — bugs in unchanged lines of a touched function are in scope (the PR
re-exposes or fails to fix them). For every line ask: what input, state, timing,
or platform makes this line wrong? Look for inverted/wrong conditions,
off-by-one, null/undefined deref, missing `await`, falsy-zero checks,
wrong-variable copy-paste, error swallowed in catch, unescaped regex metachars.

### Angle B — removed-behavior auditor

For every line the diff DELETES or replaces, name the invariant or behavior it
enforced, then search the new code for where that invariant is re-established.
If you can't find it, that's a candidate: a removed guard, a dropped error
path, a narrowed validation, a deleted test that was covering a real case.

### Angle C — cross-file tracer

For each function the diff changes, find its callers (Grep for the symbol) and
check whether the change breaks any call site: a new precondition, a changed
return shape, a new exception, a timing/ordering dependency. Also check callees:
does a parallel change in the same PR make a call unsafe?

### Angle D — language-pitfall specialist

Scan for the classic pitfalls of the diff's language/framework — for example:
JS falsy-zero, `==` coercion, closure-captured loop var; Python mutable default
args, late-binding closures; Go nil-map write, range-var capture; SQL injection;
timezone/DST drift; float equality. Flag any instance the diff introduces.

### Angle E — wrapper/proxy correctness

When the PR adds or modifies a type that wraps another (cache, proxy, decorator,
adapter): check that every method routes to the wrapped instance and not back
through a registry/session/global — e.g. a caching provider holding a
`delegate` field that resolves IDs via `session.get(...)` instead of
`delegate.get(...)` will re-enter the cache or recurse. Also check that the
wrapper forwards all the methods the callers actually use.

## Phase 2 — Verify (1-vote, 3-state)

Dedup candidates that point at the same line/mechanism, keeping the one with
the most concrete failure scenario. For each remaining candidate, run **one
verifier** via the Agent tool: give it the diff, the relevant
file(s), and the candidate, and have it return exactly one of:

- **CONFIRMED** — can name the inputs/state that trigger it and the wrong
  output or crash. Quote the line.
- **PLAUSIBLE** — mechanism is real, trigger is uncertain (timing, env,
  config). State what would confirm it.
- **REFUTED** — factually wrong (code doesn't say that) or guarded elsewhere.
  Quote the line that proves it.

Keep candidates where the vote is CONFIRMED or PLAUSIBLE.

This is recall mode — a single non-REFUTED vote carries the finding. Do NOT
drop on uncertainty.

After verification, classify each finding into REGRESSION / PRE-EXISTING /
INTENTIONAL DESIGN / HARMLESS DEFENSIVE. Only REGRESSION findings should be
presented as actionable bugs introduced by this diff.

## Phase 3 — Sweep for gaps

Run **one more finder** as a fresh reviewer who has the verified list. Re-read
the diff and enclosing functions looking ONLY for defects not already listed.
Do not re-derive or re-confirm anything already there — the job is gaps. Focus
on what the first pass tends to miss: moved/extracted code that dropped a guard
or anchor; second-tier footguns (dataclass default evaluated once, `hash()`
non-determinism, lock-scope shrink, predicate methods with side effects);
setup/teardown asymmetry in tests; config defaults flipped.

Surface **up to 8 additional candidates**, each naming a defect not already on
the list. If nothing new, return an empty sweep — do not pad.

## Output

Return findings as a JSON array of at most 15 objects:

```json
[
  {
    "file": "path/to/file.ext",
    "line": 123,
    "category": "REGRESSION",
    "summary": "one-sentence statement of the bug",
    "failure_scenario": "concrete inputs/state → wrong output/crash"
  }
]
```

Ranked most-severe first. Category must be one of: REGRESSION, PRE-EXISTING,
INTENTIONAL DESIGN, HARMLESS DEFENSIVE. If more than 15 survive, keep the 15
most severe. If nothing survives verification, return `[]`.
