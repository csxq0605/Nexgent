// @ts-check
/**
 * The pilot's "scoring is reliable" criteria (ADR 0011 decision 5), fixed before the pilot:
 *
 *   1. every deterministic checker passes the known good end state of its case and fails
 *      the known bad end state made for it — all correct;
 *   2. on the six known good / bad document pairs the external reviewer picks the good one
 *      in at least 5 pairs (a pair counts only when both orders pick it);
 *   3. pairwise preferences agree across the two orders in at least 80% of the pairs judged
 *      (the six reference pairs and the arm pairs of the pilot);
 *   4. agreement of the in-loop and the external reviewer: reported, no threshold.
 *
 * Scoring is reliable only when 1, 2 and 3 all hold; otherwise the report names the one that
 * failed and the full pilot does not start.
 *
 * Linux, macOS and Windows; Node built-ins only.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { badOf, goodOf, judgePilotCase } from './cases.mjs'
import { applyAnswer, writeFiles } from './common.mjs'
import { orderOutcome } from './reviewer.mjs'

/**
 * @typedef {import('./common.mjs').PilotCase} PilotCase
 * @typedef {import('./reviewer.mjs').Preference} Preference
 */

export const CRITERIA = Object.freeze({
  judges: '每个判定器对已知好答案判过、已知坏答案判不过，全对',
  pairs: { text: '6 组已知一好一差的文档成对样本，外部评审至少选对 5 组（两种顺序都选对才算）', minCorrect: 5, of: 6 },
  order: { text: '两两偏好在两种顺序下一致率不低于 80%（6 组参考成对样本加试点的两臂比较）', minRate: 0.8 },
  agreement: '循环内评审与外部评审在同一批要点上的一致率，照实报告，不设门槛',
})

/**
 * Criterion 1: run every case's checkers on its good end state and on each bad one.
 * @param {PilotCase[]} cases
 */
export async function checkJudges(cases) {
  /** @type {Array<{ caseId: string, sample: string, ok: boolean, detail: string }>} */
  const results = []
  for (const task of cases) {
    const samples = [{ point: null, answer: goodOf(task) }, ...badOf(task)]
    for (const sample of samples) {
      const dir = await mkdtemp(join(tmpdir(), 'nx6-pilot-'))
      try {
        await writeFiles(dir, task.files)
        await applyAnswer(dir, sample.answer)
        const judged = await judgePilotCase(task, dir)
        const checked = judged.points.filter(p => p.by === 'check')
        if (sample.point === null) {
          const failed = checked.filter(p => p.pass !== true)
          results.push({ caseId: task.id, sample: 'good', ok: failed.length === 0, detail: failed.map(p => `${p.id}: ${p.detail}`).join('; ') || 'ok' })
        } else {
          const target = checked.find(p => p.id === sample.point)
          results.push({ caseId: task.id, sample: `bad:${sample.point}`, ok: target?.pass === false, detail: target?.detail ?? 'no such point' })
        }
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    }
  }
  const covered = cases.flatMap(task => task.rubric.filter(p => p.by === 'check').map(p => `${task.id}/${p.id}`))
  const missing = covered.filter(key => !results.some(r => `${r.caseId}/${r.sample.replace(/^bad:/, '')}` === key))
  return { pass: missing.length === 0 && results.every(r => r.ok), results, uncovered: missing }
}

/**
 * Criterion 2 from the reference pairs' judgments (`ab`: the good document shown as A).
 * @param {ReadonlyArray<{ id: string, ab: Preference | null, ba: Preference | null }>} judgments
 */
export function pairAccuracy(judgments) {
  const correct = judgments.filter(j => orderOutcome(j.ab, j.ba).winner === 'first').length
  return { pairs: judgments.length, correct, pass: judgments.length === CRITERIA.pairs.of && correct >= CRITERIA.pairs.minCorrect }
}

/**
 * Criterion 3 over every pair judged in both orders.
 * @param {ReadonlyArray<{ ab: Preference | null, ba: Preference | null }>} judgments
 */
export function orderConsistency(judgments) {
  const outcomes = judgments.map(j => orderOutcome(j.ab, j.ba))
  const known = outcomes.filter(o => o.consistent !== null)
  const consistent = known.filter(o => o.consistent).length
  const rate = known.length === 0 ? null : Math.round((consistent / known.length) * 1e9) / 1e9
  return { pairs: judgments.length, known: known.length, consistent, rate, failedReplies: judgments.length - known.length, pass: rate !== null && known.length === judgments.length && rate >= CRITERIA.order.minRate }
}

/**
 * The overall verdict: reliable only when criteria 1–3 hold.
 * @param {{ judges: { pass: boolean }, pairs: { pass: boolean }, order: { pass: boolean } }} results
 */
export function reliabilityVerdict(results) {
  const failed = /** @type {Array<'judges' | 'pairs' | 'order'>} */ (['judges', 'pairs', 'order']).filter(key => !results[key].pass)
  return { reliable: failed.length === 0, failed }
}
