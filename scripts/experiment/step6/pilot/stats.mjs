// @ts-check
/**
 * Statistics of the pilot report (ADR 0011 decisions 6 and 7; partition §统计与报告):
 *
 * - the main metric, the rubric point pass rate of a run (scored points only; "can't tell"
 *   counts as not passed and is listed), compared between two arms paired by holdout case,
 *   with a two-level bootstrap 95% interval (resample cases, then each arm's repeats inside
 *   a drawn case), 2000 draws, seed `step6-pilot`, and the positive / zero / negative verdict;
 * - whole-case pass rate, run-to-run spread per case and arm, present follow-ups per arm;
 * - adopted components split into "project convention or fact" and "way of working";
 * - the rate of adopted components that carry a concrete value of the feedback task (the
 *   finder is ADR 0013's `findInstanceLiterals`, injected);
 * - agreement between the in-loop and the external reviewer (reported, no threshold).
 *
 * Linux, macOS and Windows; no dependencies.
 */
import { rng } from '../rng.mjs'
import { quantile, verdictOf } from '../stats.mjs'

/**
 * @typedef {'base' | 'memory' | 'parent' | 'child'} PilotArm
 * @typedef {{
 *   runId: string, family: string, caseId: string, arm: PilotArm, repeat: number,
 *   rate: number | null, pass: boolean | null, unclear?: number,
 *   costUsd?: number | null, followUp?: boolean, componentsUsed?: string[],
 * }} PilotRun
 *   `rate` / `pass` are null when the judge could not finish (unknown); unknown runs never
 *   count and are listed.
 * @typedef {import('../stats.mjs').Verdict} Verdict
 */

export const PILOT_ARMS = /** @type {const} */ (['base', 'memory', 'parent'])
export const COMPARISONS = /** @type {const} */ ([['parent', 'base'], ['memory', 'base'], ['parent', 'memory']])
export const BOOTSTRAP = Object.freeze({ iterations: 2000, seed: 'step6-pilot' })

const tidy = (/** @type {number} */ x) => Math.round(x * 1e9) / 1e9

/** Known point pass rates of a case in one arm, in repeat order. @param {readonly PilotRun[]} runs @param {string} caseId @param {PilotArm} arm */
export function rates(runs, caseId, arm) {
  return runs
    .filter(run => run.caseId === caseId && run.arm === arm && run.rate !== null)
    .sort((a, b) => a.repeat - b.repeat || a.runId.localeCompare(b.runId))
    .map(run => /** @type {number} */ (run.rate))
}

const mean = (/** @type {readonly number[]} */ list) => list.reduce((s, x) => s + x, 0) / list.length

/**
 * Paired difference `treatment − control` of the point pass rate, in percentage points.
 * @param {readonly PilotRun[]} runs holdout runs
 * @param {{ treatment: PilotArm, control: PilotArm, family?: string, iterations?: number, seed?: string }} options
 */
export function pairedRateDiff(runs, { treatment, control, family, iterations = BOOTSTRAP.iterations, seed = BOOTSTRAP.seed }) {
  const scoped = family === undefined ? runs : runs.filter(run => run.family === family)
  const caseIds = [...new Set(scoped.map(run => run.caseId))].sort()
  /** @type {Array<{ caseId: string, t: number[], c: number[], diff: number }>} */
  const cases = []
  /** @type {Array<{ caseId: string, arm: PilotArm }>} */
  const missing = []
  for (const caseId of caseIds) {
    const t = rates(scoped, caseId, treatment)
    const c = rates(scoped, caseId, control)
    if (t.length === 0) missing.push({ caseId, arm: treatment })
    if (c.length === 0) missing.push({ caseId, arm: control })
    if (t.length > 0 && c.length > 0) cases.push({ caseId, t, c, diff: tidy((mean(t) - mean(c)) * 100) })
  }
  if (cases.length === 0) return { treatment, control, family: family ?? null, n: 0, mean: null, ci: /** @type {[number, number] | null} */ (null), verdict: /** @type {Verdict} */ ('insufficient'), cases, missing }
  const next = rng(`${seed}:${family ?? 'all'}:${treatment}-${control}`)
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
  return { treatment, control, family: family ?? null, n: cases.length, mean: tidy(mean(cases.map(c => c.diff))), ci, verdict: verdictOf(ci), cases, missing }
}

/** Whole-case pass rate of an arm (known runs), and how many runs were unknown. @param {readonly PilotRun[]} runs @param {PilotArm} arm @param {string} [family] */
export function wholePass(runs, arm, family) {
  const mine = runs.filter(run => run.arm === arm && (family === undefined || run.family === family))
  const known = mine.filter(run => run.pass !== null)
  return { runs: mine.length, known: known.length, passed: known.filter(run => run.pass).length, rate: known.length === 0 ? null : tidy(known.filter(run => run.pass).length / known.length), unknown: mine.length - known.length }
}

/** Run-to-run spread of a case in one arm. @param {readonly PilotRun[]} runs @param {string} caseId @param {PilotArm} arm */
export function repeatSpread(runs, caseId, arm) {
  const list = rates(runs, caseId, arm)
  const unknown = runs.filter(run => run.caseId === caseId && run.arm === arm && run.rate === null).length
  if (list.length === 0) return { rates: list, min: null, max: null, range: null, unknown }
  return { rates: list.map(tidy), min: tidy(Math.min(...list)), max: tidy(Math.max(...list)), range: tidy(Math.max(...list) - Math.min(...list)), unknown }
}

/** "Can't tell" verdicts per arm (they count as not passed; listed). @param {readonly PilotRun[]} runs */
export function unclearByArm(runs) {
  /** @type {Record<string, number>} */
  const out = {}
  for (const run of runs) out[run.arm] = (out[run.arm] ?? 0) + (run.unclear ?? 0)
  return out
}

/** Runs where the orchestration had to ask for the deliverable, per arm. @param {readonly PilotRun[]} runs */
export function followUpsByArm(runs) {
  /** @type {Record<string, { runs: number, followUps: number }>} */
  const out = {}
  for (const run of runs) {
    const entry = out[run.arm] ?? { runs: 0, followUps: 0 }
    entry.runs += 1
    if (run.followUp === true) entry.followUps += 1
    out[run.arm] = entry
  }
  return out
}

/**
 * Class of an adopted component (frozen rule): a context policy is a "project convention
 * or fact" unless its instructions read as a procedure (two or more numbered steps, or a
 * check-before-delivering instruction); every other kind (skill, function module, preset,
 * team template, architecture, plugin) is a "way of working".
 * @param {{ kind: string, text?: string }} component `text`: the policy's instructions
 * @returns {'convention-or-fact' | 'way-of-working'}
 */
export function componentClass(component) {
  if (component.kind !== 'context-policy') return 'way-of-working'
  const text = component.text ?? ''
  const steps = (text.match(/(?:^|\s|[(（])(?:\d+[.)）、]|[①-⑨])/g) ?? []).length
  const checks = /(before (presenting|delivering|submitting)|交付前|提交前|交之前|先(核对|检查|校验)|reconcile|self-check|verify)/i.test(text)
  return steps >= 2 || checks ? 'way-of-working' : 'convention-or-fact'
}

/** Counts of adopted components by class. @param {ReadonlyArray<{ kind: string, text?: string }>} components */
export function componentClasses(components) {
  const out = { 'convention-or-fact': 0, 'way-of-working': 0 }
  for (const component of components) out[componentClass(component)] += 1
  return out
}

/**
 * Share of adopted components that carry a concrete value of their feedback task.
 * @param {ReadonlyArray<{ name: string, texts: string[], sources: string[], projectMessages: string[] }>} components
 * @param {(componentTexts: string[], sources: string[], projectMessages: string[]) => ReadonlyArray<unknown>} findInstanceLiterals ADR 0013's function
 */
export function literalRate(components, findInstanceLiterals) {
  const hits = components.map(c => ({ name: c.name, hits: findInstanceLiterals(c.texts, c.sources, c.projectMessages).length }))
  const withLiterals = hits.filter(h => h.hits > 0).length
  return { components: components.length, withLiterals, rate: components.length === 0 ? null : tidy(withLiterals / components.length), hits }
}

/**
 * Agreement of two judges on the same items (`null` items are left out and counted).
 * @param {ReadonlyArray<{ a: boolean | null, b: boolean | null }>} items
 */
export function agreementRate(items) {
  const known = items.filter(item => item.a !== null && item.b !== null)
  const agree = known.filter(item => item.a === item.b).length
  return { items: items.length, known: known.length, agree, rate: known.length === 0 ? null : tidy(agree / known.length) }
}
