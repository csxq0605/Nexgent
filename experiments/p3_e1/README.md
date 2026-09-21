# P3 E1 qualification pilot

This runner makes one real `reference-os-v1` generation attempt through
`RSICycleService`, then runs selection, promotion, guard, and one new ordinary
task through the promoted package channel. It writes a sanitized receipt for
both success and failure. It never retries a missing/rejected/rolled-back run.
The single external request sends the bounded public `FeedbackBundle`, the
allowlisted `behavior.py` component, and the mutation policy to the configured
`rsi_improver` provider. Obtain explicit authorization for that payload and
destination before running it.

Run it from the repository root so the existing project `models.json` is used:

```powershell
python -m experiments.p3_e1.pilot --project-root . --output .nexgent/exports/p3-e1
```

Each run creates `OUTPUT/p3-e1-attempt-<id>/` and first persists a running
`p3-e1-pilot-receipt.json` before any model request. On success the same
attempt directory also contains `p3-e1-evidence.json` with schema
`nexgent.p3-e1-evidence.v1`. `OUTPUT/attempts.jsonl` is append-only, so a later
failure cannot overwrite an earlier receipt. The evidence makes only the E1
claim for one persistent promoted behavior instance; it does not claim
cross-task, statistical, or recursive benefit.
