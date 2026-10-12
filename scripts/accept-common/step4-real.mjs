/**
 * The real-model layer of accept-step4 (partition §真实模型验收). Round 1 has
 * only the gate in front of it: a key in the environment and room under the
 * budget. R01–R06 are not wired yet, so the script never calls a model; the
 * runs come in round 4, after the gate (W3) exists.
 */
import { budgetGate } from './step2-checks.mjs'
import { REAL_MODEL, realModelKeySource } from './step4-checks.mjs'

/**
 * Whether the real layer may start: a key variable is set and the earlier
 * runs' estimated spend leaves room under the cap. Reads which variable is
 * set, never its value.
 * @returns `{ ok: true, keySource, remainingUsd }` or `{ ok: false, reason }`.
 */
export function realPrerequisites(env, budgetUsd, spent) {
  const keySource = realModelKeySource(env)
  if (keySource === undefined) return { ok: false, reason: `no API key (${REAL_MODEL.keyEnv.join(' or ')} is not set)` }
  const gate = budgetGate(budgetUsd, spent)
  if (!gate.ok) return { ok: false, reason: gate.reason }
  return { ok: true, keySource, remainingUsd: gate.remainingUsd }
}
