/**
 * The real-model layer of accept-step3 (R01–R08, plan §真实模型验收). Not
 * wired yet: the restock material (scripts/real-task/step3-restock/) and its
 * hidden check (scripts/real-task/step3-restock-hidden.mjs) exist; the
 * per-form runs land in round 5. Until then the layer
 * reports itself not runnable after the key and budget checks, so the script
 * exits 2 and never calls a model.
 */
import { budgetGate, REAL_MODEL, realModelKeySource } from './step3-checks.mjs'

/**
 * Real-layer prerequisites, in order: a key in the environment, budget left, a wired scenario.
 * @param env - process environment (only variable names are read out).
 * @param budgetUsd - total cap.
 * @param spent - estimated costs of earlier runs.
 * @returns `{ ok: false, reason }` (nothing is wired yet) — the key value is never read into the result.
 */
export function realPrerequisites(env, budgetUsd, spent) {
  const keySource = realModelKeySource(env)
  if (keySource === undefined) return { ok: false, reason: `no API key (${REAL_MODEL.keyEnv.join(' or ')} is not set)` }
  const gate = budgetGate(budgetUsd, spent)
  if (!gate.ok) return { ok: false, reason: gate.reason }
  return { ok: false, reason: `key from ${keySource}, ${gate.remainingUsd.toFixed(2)} USD left, but the step-3 real-model scenario is not wired yet (round 5); no model call made` }
}
