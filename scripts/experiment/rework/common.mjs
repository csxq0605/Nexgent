// @ts-check
/**
 * Shared shapes of the rework measurement (ADR 0019 §8; docs/plan/rework-partition.md M1):
 * the case, rubric point and family types, the rubric rules every case keeps, the generic
 * line every task message ends with, the weighted score of a judged run, and the C1
 * practice-case form of a case (`packages/kernel/src/contracts/learning.ts`).
 *
 * Text matching, CSV, file trees and answers come from the step-6 pilot (`../step6/pilot/common.mjs`)
 * and are re-exported, so a family module imports from here only.
 *
 * A rubric point is judged one of two ways:
 *   check  deterministic, by the case's checker; the score counts only these
 *   none   a one-off preference (`taste`): said once in feedback, never scored
 * The external reviewer judges the same points for the report only (ADR 0019 §8: it never
 * enters the loop and never changes a score).
 *
 * Linux, macOS and Windows; Node built-ins only.
 */
import { createHash } from 'node:crypto'

export {
  amountForms, applyAnswer, bytesOf, citationTail, citesAll, dateForms, firstTableDifference, hasAny, hasNumber,
  headings, listFiles, normalize, parseCsv, readBytes, readText, sameBytes, sameCell, toCsv, writeFiles,
} from '../step6/pilot/common.mjs'

/**
 * @typedef {'train' | 'holdout' | 'guard'} Split
 *   train: the training stream (learners see it); holdout: the two whole families held
 *   out, measured only; guard: one generic case per training family for the product's
 *   regression guard set (G1), never shown to learners.
 * @typedef {'wrong-result' | 'missing' | 'format' | 'unverified' | 'convention' | 'taste'} PointType
 * @typedef {'check' | 'none'} JudgedBy
 * @typedef {{ id: string, type: PointType, text: string, feedback: string, by: JudgedBy, weight: 1 | 2 | 3 }} Point
 *   `text` says what a good deliverable does (shown to the external reviewer and copied
 *   into the C1 rubric); `feedback` is what the simulated user says when the point is not
 *   met and never contains the expected value.
 * @typedef {{ write: Record<string, string | Uint8Array>, remove: string[] }} Answer
 * @typedef {{ pass: boolean, detail: string }} CheckOutcome
 * @typedef {(dir: string) => Promise<CheckOutcome>} Checker
 *   `dir` is the case folder (where the case's files were written).
 * @typedef {{
 *   variant: string,
 *   message: string,
 *   files: Record<string, string | Uint8Array>,
 *   outputs: string[],
 *   rubric: Point[],
 *   traps: string[],
 *   fingerprints: string[],
 *   hidden: Record<string, any>,
 * }} InnerCase
 *   What a family generator returns, paths relative to the case folder. `traps` names the
 *   input problems this case carries (drawn from the family's pool); `fingerprints` are
 *   strings that only this case's inputs contain (the isolation check looks for them).
 * @typedef {InnerCase & { id: string, family: string, split: Split, index: number, seed: string, folder: string }} ReworkCase
 *   A case as the plan holds it: paths relative to the project (inside `folder`).
 * @typedef {{ build: (seed: string, options: { convention: boolean }) => InnerCase,
 *   checkers: (task: InnerCase) => Record<string, Checker>,
 *   good: (task: InnerCase) => Answer,
 *   bad: (task: InnerCase) => Array<{ point: string, answer: Answer }>,
 * }} FamilyCode
 * @typedef {FamilyCode & {
 *   name: string, title: string, habit: string, trapPool: readonly string[],
 *   convention: { text: string, feedback: string },
 * }} Family
 *   `habit` names the general way of working the family's points reward (documentation,
 *   never shown to the model); `trapPool` the input problems a case may carry; the
 *   convention is said only in feedback.
 * @typedef {{ id: string, type: PointType, by: JudgedBy, weight: number, pass: boolean | null, detail: string }} PointResult
 * @typedef {{ score: number | null, pass: boolean | null, points: PointResult[], problems: string[] }} Judged
 *   `score`: weighted share of checked points passed (0–1); `pass`: all checked points
 *   passed; both null when any checked point is unknown.
 */

/** Point types with their Chinese names (same six as the step-6 pilot). */
export const POINT_TYPES = /** @type {const} */ ({
  'wrong-result': '结果错误',
  missing: '漏做',
  format: '格式不对',
  unverified: '没核对就交',
  convention: '项目约定',
  taste: '个人口味',
})

/**
 * The generic closing line of every task message, the same in every family: it makes the
 * "input problem" points fair to ask for, without naming any problem.
 * @param {string} notePath where the deliverable explains how input problems were handled
 */
export const problemLine = notePath => `如果资料或输入本身有问题（比如对不上、缺失、重复、格式不对），请在 ${notePath} 里写明发现了什么、怎么处理的。`

/**
 * Rubric rules every case keeps: 3–6 scored points; at least one result point and one
 * point about an input problem; at most one project convention; taste points and only they
 * are judged by nobody; weights 1–3; unique ids `r1`… in order (C1 `RubricItem`), with the
 * taste point last as `t`.
 * @param {ReworkCase} task
 * @returns {string[]} problems
 */
export function checkRubric(task) {
  const problems = []
  const scored = task.rubric.filter(p => p.by === 'check')
  if (scored.length < 3 || scored.length > 6) problems.push(`${task.id}: ${scored.length} scored points, expected 3–6`)
  if (!scored.some(p => p.type === 'wrong-result')) problems.push(`${task.id}: no result point`)
  if (!scored.some(p => p.type === 'unverified')) problems.push(`${task.id}: no input-problem point`)
  if (task.rubric.filter(p => p.type === 'convention').length > 1) problems.push(`${task.id}: more than one project-convention point`)
  scored.forEach((point, i) => { if (point.id !== `r${i + 1}`) problems.push(`${task.id}/${point.id}: scored points are r1, r2, … in order`) })
  for (const point of task.rubric) {
    if (!(point.type in POINT_TYPES)) problems.push(`${task.id}/${point.id}: unknown type ${point.type}`)
    if ((point.type === 'taste') !== (point.by === 'none')) problems.push(`${task.id}/${point.id}: taste points and only they are judged by nobody`)
    if (![1, 2, 3].includes(point.weight)) problems.push(`${task.id}/${point.id}: weight ${point.weight}`)
    if (point.text.length > 300) problems.push(`${task.id}/${point.id}: text longer than 300 characters`)
    if (point.feedback === '' || point.text === '') problems.push(`${task.id}/${point.id}: empty text or feedback`)
  }
  const ids = task.rubric.map(p => p.id)
  if (new Set(ids).size !== ids.length) problems.push(`${task.id}: duplicate point ids`)
  if (task.traps.length < 2) problems.push(`${task.id}: ${task.traps.length} input problems, expected at least 2`)
  if (task.fingerprints.length === 0) problems.push(`${task.id}: no fingerprints`)
  return problems
}

const tidy = (/** @type {number} */ x) => Math.round(x * 1e9) / 1e9

/**
 * Put checker outcomes together: the weighted score over checked points (taste points are
 * left out). A checker that throws is unknown and listed.
 * @param {ReworkCase | InnerCase & { id?: string }} task
 * @param {Record<string, Checker>} checkers
 * @param {string} dir the case folder
 * @returns {Promise<Judged>}
 */
export async function runChecks(task, checkers, dir) {
  /** @type {PointResult[]} */
  const points = []
  const problems = []
  for (const point of task.rubric) {
    if (point.by !== 'check') continue
    const checker = checkers[point.id]
    const base = { id: point.id, type: point.type, by: point.by, weight: point.weight }
    if (checker === undefined) { points.push({ ...base, pass: null, detail: 'no checker' }); problems.push(`${point.id}: no checker`); continue }
    try {
      const outcome = await checker(dir)
      points.push({ ...base, pass: outcome.pass, detail: outcome.detail.slice(0, 300) })
    } catch (error) {
      points.push({ ...base, pass: null, detail: 'checker failed' })
      problems.push(`${point.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return summarize(points, problems)
}

/** @param {PointResult[]} points @param {string[]} problems @returns {Judged} */
export function summarize(points, problems) {
  const unknown = points.some(p => p.pass === null)
  const total = points.reduce((s, p) => s + p.weight, 0)
  const got = points.filter(p => p.pass === true).reduce((s, p) => s + p.weight, 0)
  return {
    score: unknown || total === 0 ? null : tidy(got / total),
    pass: unknown ? null : points.every(p => p.pass === true),
    points,
    problems,
  }
}

const ok = (/** @type {string} */ detail = 'ok') => ({ pass: true, detail })
const no = (/** @type {string} */ detail) => ({ pass: false, detail })
export { no, ok }

/** Two-digit zero padding. @param {number} n */
export const pad = n => String(n).padStart(2, '0')

/** Lowercase hex SHA-256. @param {string | Uint8Array} data */
export const sha256 = data => createHash('sha256').update(data).digest('hex')

/**
 * A uuid v4 shaped id derived from text (C1 `PracticeCase.id` is a lowercase uuid v4), so
 * the same case always gets the same id.
 * @param {string} text
 */
export function stableUuid(text) {
  const hex = sha256(`nexgent-rework-case:${text}`)
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/** Fixed creation time of the plan's practice cases (the freeze date; no clock is read). */
export const PLAN_DATE = '2026-10-16T00:00:00.000Z'

/**
 * Lowercase keywords of a case for C1 `similarityKey` (≤16): the family name, the variant,
 * the traps, then the output file extensions.
 * @param {ReworkCase} task
 */
export function similarityKey(task) {
  const exts = task.outputs.map(path => (/\.([a-z0-9]+)$/i.exec(path)?.[1] ?? 'dir').toLowerCase())
  return [...new Set([task.family, task.variant, ...task.traps, ...exts].map(k => k.toLowerCase()))].slice(0, 16)
}

/**
 * The C1 practice-case form of a case (`learning.v1.schema.json`): what G1 loads for the
 * generic guard set. The cluster is the family, so a family never straddles splits; the
 * starting files stay in the plan (a practice case only names a snapshot tree for task
 * cases), so `input` is absent.
 * @param {ReworkCase} task
 */
export function practiceCaseOf(task) {
  const scored = task.rubric.filter(p => p.by === 'check')
  return {
    formatVersion: 1,
    id: stableUuid(task.id),
    source: task.split === 'guard' ? 'generic' : 'task',
    createdAt: PLAN_DATE,
    prompt: task.message,
    similarityKey: similarityKey(task),
    clusterId: `rework-family-${task.family}`,
    split: task.split === 'guard' ? 'guard' : task.split === 'holdout' ? 'holdout' : 'train',
    rubric: {
      items: scored.map(point => ({ id: point.id, text: point.text, ...(point.weight === 1 ? {} : { weight: point.weight }) })),
      model: 'rework-m1-plan',
      createdAt: PLAN_DATE,
      generator: 'rework-m1',
    },
  }
}
