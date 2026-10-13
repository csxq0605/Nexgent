// @ts-check
/**
 * Statistics for the step-6 report (docs/plan/step-6-work-partition.md §测量, user
 * decision 7): hidden-judge pass rate per holdout case and arm, paired differences
 * between two arms with a 95% bootstrap interval, the positive / zero / negative
 * verdict, and amortization of the improvement spend.
 *
 * Pairing is by holdout case. The bootstrap is two-level: resample cases, then, inside
 * each drawn case, resample each arm's repeats, so both the case mix and run-to-run
 * model variance widen the interval. Seeded, so the same records give the same numbers.
 * Unknown runs (`pass: null`) never count as passes; they are left out of the rates
 * and listed.
 *
 * Linux, macOS and Windows; no dependencies.
 */
import { rng } from './rng.mjs'

/**
 * @typedef {'base' | 'parent' | 'child'} Arm
 * @typedef {{ runId: string, family: string, caseId: string, arm: Arm, repeat: number, pass: boolean | null, costUsd?: number | null, componentsUsed?: string[] }} RunRecord
 * @typedef {'positive' | 'zero' | 'negative' | 'insufficient'} Verdict
 */

export const ARMS = /** @type {const} */ (['base', 'parent', 'child'])

/**
 * Known results (true / false) of one case in one arm, in repeat order.
 * @param {readonly RunRecord[]} runs
 * @param {string} caseId
 * @param {Arm} arm
 */
export function outcomes(runs, caseId, arm) {
  return runs
    .filter(run => run.caseId === caseId && run.arm === arm && run.pass !== null)
    .sort((a, b) => a.repeat - b.repeat || a.runId.localeCompare(b.runId))
    .map(run => run.pass === true)
}

const rate = (/** @type {readonly boolean[]} */ list) => list.filter(Boolean).length / list.length

/**
 * Quantile with linear interpolation between order statistics (R type 7).
 * @param {readonly number[]} sorted ascending
 * @param {number} q in [0, 1]
 */
export function quantile(sorted, q) {
  if (sorted.length === 0) return Number.NaN
  const h = (sorted.length - 1) * q
  const lo = Math.floor(h)
  const hi = Math.ceil(h)
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo])
}

/** Round away float noise so printed numbers are stable across platforms. */
const tidy = (/** @type {number} */ x) => Math.round(x * 1e9) / 1e9

/**
 * Verdict from a 95% interval: lower bound above 0 → positive; upper bound below 0 →
 * negative; otherwise zero (no difference visible in the sample).
 * @param {[number, number] | null} ci
 * @returns {Verdict}
 */
export function verdictOf(ci) {
  if (ci === null) return 'insufficient'
  if (ci[0] > 0) return 'positive'
  if (ci[1] < 0) return 'negative'
  return 'zero'
}

/**
 * Paired difference `treatment − control` of the pass rate, in percentage points.
 * @param {readonly RunRecord[]} runs
 * @param {{ treatment: Arm, control: Arm, family?: string, iterations?: number, seed?: string }} options
 */
export function pairedDiff(runs, { treatment, control, family, iterations = 10_000, seed = 'step6-bootstrap' }) {
  const scoped = family === undefined ? runs : runs.filter(run => run.family === family)
  const caseIds = [...new Set(scoped.map(run => run.caseId))].sort()
  /** @type {Array<{ caseId: string, family: string, t: boolean[], c: boolean[], diff: number }>} */
  const cases = []
  /** @type {Array<{ caseId: string, arm: Arm }>} */
  const missing = []
  for (const caseId of caseIds) {
    const t = outcomes(scoped, caseId, treatment)
    const c = outcomes(scoped, caseId, control)
    if (t.length === 0) missing.push({ caseId, arm: treatment })
    if (c.length === 0) missing.push({ caseId, arm: control })
    if (t.length === 0 || c.length === 0) continue
    const fam = /** @type {RunRecord} */ (scoped.find(run => run.caseId === caseId)).family
    cases.push({ caseId, family: fam, t, c, diff: tidy((rate(t) - rate(c)) * 100) })
  }
  if (cases.length === 0) {
    return { treatment, control, family: family ?? null, n: 0, mean: null, ci: /** @type {[number, number] | null} */ (null), verdict: /** @type {Verdict} */ ('insufficient'), cases, missing }
  }
  const mean = tidy(cases.reduce((sum, item) => sum + item.diff, 0) / cases.length)
  const next = rng(`${seed}:${family ?? 'all'}:${treatment}-${control}`)
  const draw = (/** @type {number} */ n) => Math.floor(next() * n)
  const resampledRate = (/** @type {boolean[]} */ list) => {
    let passes = 0
    for (let i = 0; i < list.length; i += 1) if (list[draw(list.length)]) passes += 1
    return passes / list.length
  }
  const means = new Array(iterations)
  for (let b = 0; b < iterations; b += 1) {
    let sum = 0
    for (let i = 0; i < cases.length; i += 1) {
      const item = cases[draw(cases.length)]
      sum += (resampledRate(item.t) - resampledRate(item.c)) * 100
    }
    means[b] = sum / cases.length
  }
  means.sort((a, b) => a - b)
  /** @type {[number, number]} */
  const ci = [tidy(quantile(means, 0.025)), tidy(quantile(means, 0.975))]
  return { treatment, control, family: family ?? null, n: cases.length, mean, ci, verdict: verdictOf(ci), cases, missing }
}

/**
 * Mean estimated cost per run of one arm (known costs only), and how many runs had none.
 * @param {readonly RunRecord[]} runs
 * @param {Arm} arm
 * @param {string} [family]
 */
export function armCost(runs, arm, family) {
  const mine = runs.filter(run => run.arm === arm && (family === undefined || run.family === family))
  const known = mine.filter(run => typeof run.costUsd === 'number' && Number.isFinite(run.costUsd))
  const total = known.reduce((sum, run) => sum + /** @type {number} */ (run.costUsd), 0)
  return { runs: mine.length, priced: known.length, unpriced: mine.length - known.length, totalUsd: tidy(total), meanUsd: known.length === 0 ? null : tidy(total / known.length) }
}

/**
 * Amortization of the spend on improving (improvement and meta-improvement jobs).
 * Savings per task → how many later tasks pay it back; a quality gain → dollars per
 * percentage point. Neither → no benefit to amortize.
 * @param {{ investmentUsd: number, baseCostPerTask: number | null, treatedCostPerTask: number | null, gainPoints: number | null }} input
 */
export function amortize({ investmentUsd, baseCostPerTask, treatedCostPerTask, gainPoints }) {
  const savings = baseCostPerTask !== null && treatedCostPerTask !== null ? tidy(baseCostPerTask - treatedCostPerTask) : null
  return {
    investmentUsd: tidy(investmentUsd),
    savingsPerTaskUsd: savings,
    tasksToBreakEven: savings !== null && savings > 0 ? Math.ceil(tidy(investmentUsd / savings)) : null,
    usdPerPoint: gainPoints !== null && gainPoints > 0 ? tidy(investmentUsd / gainPoints) : null,
  }
}

/**
 * Run-to-run spread of one case in one arm: passes out of known runs, and unknown runs.
 * @param {readonly RunRecord[]} runs
 * @param {string} caseId
 * @param {Arm} arm
 */
export function spread(runs, caseId, arm) {
  const mine = runs.filter(run => run.caseId === caseId && run.arm === arm)
  const known = mine.filter(run => run.pass !== null)
  return { passes: known.filter(run => run.pass === true).length, known: known.length, unknown: mine.length - known.length, runIds: mine.map(run => run.runId).sort() }
}
