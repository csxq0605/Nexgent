// @ts-check
/**
 * Statistics and verdicts of the rework measurement, frozen before any run (ADR 0019 §8):
 *
 * - the metric is a holdout run's weighted point score (checked points only, 0–100); a run
 *   whose judge could not finish is unknown, never counted, and listed;
 * - two arms are compared paired by holdout case, with a two-level bootstrap 95% interval
 *   (resample cases, then each arm's repeats inside a drawn case), 10 000 draws, seeded;
 *   lower bound > 0 is positive, upper bound < 0 negative, otherwise zero;
 * - the four criteria: (1) a layer is useful only when L1 − notes and (L1+L2) − L1 are
 *   both positive; (2) "evolved" only when (L1+L2) − notes is positive on the held-out
 *   families; (3) "recursive improvement" only when (L1+L2+L3) − (L1+L2) is positive;
 *   (4) the memorisation (literal) rate is 0, and cost-optimized changes are not counted;
 *   (5) every family and point type that got worse is listed;
 * - every comparison is also given per held-out family and per point type.
 *
 * Linux, macOS and Windows; no dependencies.
 */
import { rng } from '../step6/rng.mjs'
import { quantile, verdictOf } from '../step6/stats.mjs'

/**
 * @typedef {import('./arms.mjs').Arm} Arm
 * @typedef {import('../step6/stats.mjs').Verdict} Verdict
 * @typedef {{
 *   runId: string, family: string, caseId: string, arm: string, repeat: number,
 *   score: number | null, pass: boolean | null,
 *   points?: Array<{ id: string, type: string, weight: number, pass: boolean | null }>,
 *   costUsd?: number | null, followUp?: boolean, standIn?: boolean,
 * }} Run
 */

export const BOOTSTRAP = Object.freeze({ iterations: 10_000, seed: 'rework-m1', interval: 0.95, quantile: 'R type 7' })

/** The comparisons of ADR 0019 §8, then each arm against base. */
export const COMPARISONS = /** @type {const} */ ([
  { id: 'L1-notes', treatment: 'L1', control: 'notes', criterion: 1 },
  { id: 'L2-L1', treatment: 'L1+L2', control: 'L1', criterion: 1 },
  { id: 'L12-notes', treatment: 'L1+L2', control: 'notes', criterion: 2 },
  { id: 'L3-L12', treatment: 'L1+L2+L3', control: 'L1+L2', criterion: 3 },
  { id: 'format-base', treatment: 'format', control: 'base', criterion: null },
  { id: 'notes-base', treatment: 'notes', control: 'base', criterion: null },
  { id: 'notes-format', treatment: 'notes', control: 'format', criterion: null },
  { id: 'L1-base', treatment: 'L1', control: 'base', criterion: null },
  { id: 'L12-base', treatment: 'L1+L2', control: 'base', criterion: null },
  { id: 'L3-base', treatment: 'L1+L2+L3', control: 'base', criterion: null },
])

/** Wording of the criteria (frozen in the plan). */
export const CRITERIA = Object.freeze({
  1: '一层有用：L1 − notes 与 (L1+L2) − L1 的 95% 区间下限都大于 0',
  2: '进化了：在整类留出的任务类型上 (L1+L2) − notes 的 95% 区间下限大于 0',
  3: '递归改进：(L1+L2+L3) − (L1+L2) 在留出集上的 95% 区间下限大于 0',
  4: '背答案率为 0；cost-optimized 不计入',
  5: '报告所有变差的类别（留出类、要点类型）',
})

const tidy = (/** @type {number} */ x) => Math.round(x * 1e9) / 1e9
const mean = (/** @type {readonly number[]} */ list) => list.reduce((s, x) => s + x, 0) / list.length

/**
 * A run's value under a scope: the whole score, or the weighted share of one point type.
 * @param {Run} run
 * @param {string | undefined} pointType
 * @returns {number | null} 0–1
 */
function valueOf(run, pointType) {
  if (run.score === null) return null
  if (pointType === undefined) return run.score
  const mine = (run.points ?? []).filter(p => p.type === pointType)
  if (mine.length === 0 || mine.some(p => p.pass === null)) return null
  const total = mine.reduce((s, p) => s + p.weight, 0)
  return mine.filter(p => p.pass === true).reduce((s, p) => s + p.weight, 0) / total
}

/**
 * Known values of a case in one arm, in repeat order.
 * @param {readonly Run[]} runs @param {string} caseId @param {string} arm @param {string} [pointType]
 */
export function values(runs, caseId, arm, pointType) {
  return runs
    .filter(run => run.caseId === caseId && run.arm === arm)
    .sort((a, b) => a.repeat - b.repeat || a.runId.localeCompare(b.runId))
    .map(run => valueOf(run, pointType))
    .filter(/** @returns {v is number} */ v => v !== null)
}

/**
 * Paired difference `treatment − control`, in points (0–100 scale).
 * @param {readonly Run[]} runs holdout runs
 * @param {{ treatment: string, control: string, family?: string, pointType?: string, iterations?: number, seed?: string }} options
 */
export function pairedDiff(runs, { treatment, control, family, pointType, iterations = BOOTSTRAP.iterations, seed = BOOTSTRAP.seed }) {
  const scoped = runs.filter(run => !run.standIn && (family === undefined || run.family === family))
  const caseIds = [...new Set(scoped.map(run => run.caseId))].sort()
  /** @type {Array<{ caseId: string, t: number[], c: number[], diff: number }>} */
  const cases = []
  /** @type {Array<{ caseId: string, arm: string }>} */
  const missing = []
  for (const caseId of caseIds) {
    const t = values(scoped, caseId, treatment, pointType)
    const c = values(scoped, caseId, control, pointType)
    if (t.length === 0) missing.push({ caseId, arm: treatment })
    if (c.length === 0) missing.push({ caseId, arm: control })
    if (t.length > 0 && c.length > 0) cases.push({ caseId, t, c, diff: tidy((mean(t) - mean(c)) * 100) })
  }
  const base = { treatment, control, family: family ?? null, pointType: pointType ?? null }
  if (cases.length === 0) return { ...base, n: 0, mean: null, ci: /** @type {[number, number] | null} */ (null), verdict: /** @type {Verdict} */ ('insufficient'), cases, missing }
  const next = rng(`${seed}:${family ?? 'all'}:${pointType ?? 'score'}:${treatment}-${control}`)
  const draw = (/** @type {number} */ n) => Math.floor(next() * n)
  const resampled = (/** @type {number[]} */ list) => {
    let sum = 0
    for (let i = 0; i < list.length; i += 1) sum += list[draw(list.length)]
    return sum / list.length
  }
  const means = new Array(iterations)
  for (let b = 0; b < iterations; b += 1) {
    let sum = 0
    for (let i = 0; i < cases.length; i += 1) {
      const item = cases[draw(cases.length)]
      sum += (resampled(item.t) - resampled(item.c)) * 100
    }
    means[b] = sum / cases.length
  }
  means.sort((a, b) => a - b)
  /** @type {[number, number]} */
  const ci = [tidy(quantile(means, 0.025)), tidy(quantile(means, 0.975))]
  return { ...base, n: cases.length, mean: tidy(mean(cases.map(c => c.diff))), ci, verdict: verdictOf(ci), cases, missing }
}

/**
 * Every comparison whose two arms both have runs: pooled, per family, per point type.
 * @param {readonly Run[]} runs
 * @param {{ iterations?: number }} [options]
 */
export function comparisons(runs, options = {}) {
  const arms = new Set(runs.filter(r => !r.standIn).map(r => r.arm))
  const families = [...new Set(runs.map(r => r.family))].sort()
  const types = [...new Set(runs.flatMap(r => (r.points ?? []).map(p => p.type)))].sort()
  return COMPARISONS.filter(c => arms.has(c.treatment) && arms.has(c.control)).map(c => ({
    ...c,
    pooled: pairedDiff(runs, { ...c, ...options }),
    byFamily: families.map(family => pairedDiff(runs, { ...c, family, ...options })),
    byPointType: types.map(pointType => pairedDiff(runs, { ...c, pointType, ...options })),
  }))
}

/**
 * The criteria verdicts. A criterion whose arms did not run is `not-run`.
 * @param {ReturnType<typeof comparisons>} compared
 * @param {{ literalRate: number | null, costOptimized: number | null }} learned
 */
export function criteria(compared, learned) {
  const verdict = (/** @type {string} */ id) => compared.find(c => c.id === id)?.pooled.verdict ?? 'not-run'
  const both = (/** @type {string[]} */ ids) => {
    const v = ids.map(verdict)
    if (v.includes('not-run')) return 'not-run'
    return v.every(x => x === 'positive') ? 'met' : 'not-met'
  }
  const worse = compared.flatMap(c => [...c.byFamily, ...c.byPointType]
    .filter(d => d.mean !== null && d.mean < 0)
    .map(d => ({ comparison: c.id, family: d.family, pointType: d.pointType, mean: d.mean, verdict: d.verdict })))
  return {
    1: both(['L1-notes', 'L2-L1']),
    2: both(['L12-notes']),
    3: both(['L3-L12']),
    4: learned.literalRate === null ? 'not-run' : learned.literalRate === 0 ? 'met' : 'not-met',
    costOptimized: learned.costOptimized,
    5: worse,
  }
}

/** Whole-case pass rate of an arm (known runs). @param {readonly Run[]} runs @param {string} arm @param {string} [family] */
export function wholePass(runs, arm, family) {
  const mine = runs.filter(run => run.arm === arm && (family === undefined || run.family === family))
  const known = mine.filter(run => run.pass !== null)
  return { runs: mine.length, known: known.length, passed: known.filter(run => run.pass).length, rate: known.length === 0 ? null : tidy(known.filter(run => run.pass).length / known.length), unknown: mine.length - known.length }
}

/** Mean score of an arm (known runs, 0–100). @param {readonly Run[]} runs @param {string} arm @param {string} [family] */
export function meanScore(runs, arm, family) {
  const known = runs.filter(run => run.arm === arm && (family === undefined || run.family === family) && run.score !== null).map(run => /** @type {number} */ (run.score))
  return known.length === 0 ? null : tidy(mean(known) * 100)
}

/** Run-to-run spread of a case in one arm (0–100). @param {readonly Run[]} runs @param {string} caseId @param {string} arm */
export function repeatSpread(runs, caseId, arm) {
  const list = values(runs, caseId, arm).map(v => tidy(v * 100))
  if (list.length === 0) return { values: list, range: null }
  return { values: list, range: tidy(Math.max(...list) - Math.min(...list)) }
}

/**
 * Agreement of the deterministic judge and the external reviewer on the same points
 * (`null` on either side is left out and counted).
 * @param {ReadonlyArray<{ judge: boolean | null, reviewer: boolean | null }>} items
 */
export function agreement(items) {
  const known = items.filter(item => item.judge !== null && item.reviewer !== null)
  const agree = known.filter(item => item.judge === item.reviewer).length
  return { items: items.length, known: known.length, agree, rate: known.length === 0 ? null : tidy(agree / known.length) }
}

/** Score at or above which a result counts as a success (C1 `SUCCESS_SCORE`; a test keeps the copy equal). */
export const SUCCESS_SCORE = 0.8
/** Below this a result counts as a failure (C1 `FAILURE_SCORE`). */
export const FAILURE_SCORE = 0.5

/** The C1 band of a 0–1 score. @param {number} score */
export const band = score => (score >= SUCCESS_SCORE ? 'success' : score < FAILURE_SCORE ? 'failure' : 'mixed')

/** Minimum agreement of the product's self-evaluation with the deterministic judge (checkpoint 1). */
export const SELF_EVAL_MIN_AGREEMENT = 0.8

/**
 * Agreement of the product's own self-evaluation (G1, before the user's feedback) with the
 * deterministic judge on the same tasks: both scores put in the C1 bands; "agree" when
 * both say success or both say not success (the decision a learner acts on); the three
 * bands are reported too. Tasks either side could not score are left out and counted.
 * @param {ReadonlyArray<{ caseId: string, judgeScore: number | null, selfOutcome: string | null }>} items judge score 0–1; self outcome success | mixed | failure | unknown
 */
export function selfEvalAgreement(items) {
  const known = items.filter(item => item.judgeScore !== null && item.selfOutcome !== null && item.selfOutcome !== 'unknown')
  const pairs = known.map(item => ({ caseId: item.caseId, judge: band(/** @type {number} */ (item.judgeScore)), self: /** @type {string} */ (item.selfOutcome) }))
  const agree = pairs.filter(p => (p.judge === 'success') === (p.self === 'success')).length
  const sameBand = pairs.filter(p => p.judge === p.self).length
  /** @type {Record<string, number>} */
  const confusion = {}
  for (const p of pairs) confusion[`${p.self}/${p.judge}`] = (confusion[`${p.self}/${p.judge}`] ?? 0) + 1
  const rate = pairs.length === 0 ? null : tidy(agree / pairs.length)
  return {
    items: items.length, known: pairs.length, agree, rate, sameBand, sameBandRate: pairs.length === 0 ? null : tidy(sameBand / pairs.length),
    confusion: Object.fromEntries(Object.entries(confusion).sort()), threshold: SELF_EVAL_MIN_AGREEMENT,
    met: rate === null ? null : rate >= SELF_EVAL_MIN_AGREEMENT,
    selfTooKind: pairs.filter(p => p.self === 'success' && p.judge !== 'success').map(p => p.caseId),
    selfTooHarsh: pairs.filter(p => p.self !== 'success' && p.judge === 'success').map(p => p.caseId),
  }
}

/**
 * Share of learned texts (notes lines, handbook entries, skills) that carry a concrete value
 * of a training case (ADR 0013 `findInstanceLiterals`, injected).
 * @param {ReadonlyArray<{ name: string, texts: Array<{ path: string, text: string }> }>} learned
 * @param {Array<{ kind: 'feedback' | 'deliverable', ref: string, text: string }>} sources
 * @param {Array<{ taskId: string, text: string }>} messages
 * @param {(texts: any[], sources: any[], messages: any[]) => ReadonlyArray<unknown>} findInstanceLiterals
 */
export function literalRate(learned, sources, messages, findInstanceLiterals) {
  const hits = learned.map(item => ({ name: item.name, hits: findInstanceLiterals(item.texts, sources, messages).length }))
  const withLiterals = hits.filter(h => h.hits > 0).length
  return { items: learned.length, withLiterals, rate: learned.length === 0 ? null : tidy(withLiterals / learned.length), hits }
}
