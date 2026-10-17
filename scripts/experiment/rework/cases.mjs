// @ts-check
/**
 * The rework practice set (ADR 0019 §8; docs/plan/rework-partition.md M1): six procedural
 * task families, two of them held out as whole families by a seeded draw, 8 training
 * cases per training family (32), 10 cases per held-out family (20), and one generic
 * guard case per training family for the product's regression guard set (G1).
 *
 * Every case:
 *   - works in a folder of its own (a neutral name derived from its id), so cases of one
 *     project never see each other's files;
 *   - carries 2–3 input problems drawn from its family's pool, so no single remembered
 *     rule solves it;
 *   - has at most one project-convention point (in about half the cases, by a seeded
 *     draw), said only in feedback, worth at most a fifth of the case's score;
 *   - may carry a one-off preference (`taste`), said once in feedback, never scored.
 *
 * Also here: the training order (round robin over the training families), which training
 * cases get human feedback (half of each family, seeded), the plan checks and the holdout
 * isolation check over project and home directories.
 *
 * Linux, macOS and Windows; Node built-ins only.
 */
import { join } from 'node:path'
import { checkIsolation } from '../step6/cases.mjs'
import { picker } from '../step6/rng.mjs'
import { checkRubric, practiceCaseOf, runChecks, sha256 } from './common.mjs'
import { citedReport } from './families/cited-report.mjs'
import { codeTests } from './families/code-tests.mjs'
import { fileBatch } from './families/file-batch.mjs'
import { multiStep } from './families/multi-step.mjs'
import { reconcile } from './families/reconcile.mjs'
import { recompute } from './families/recompute.mjs'

/**
 * @typedef {import('./common.mjs').Family} Family
 * @typedef {import('./common.mjs').ReworkCase} ReworkCase
 * @typedef {import('./common.mjs').InnerCase} InnerCase
 * @typedef {import('./common.mjs').Answer} Answer
 * @typedef {import('./common.mjs').Checker} Checker
 * @typedef {import('./common.mjs').Judged} Judged
 */

/** The six families in plan order (the order the partition lists them). */
export const FAMILIES = /** @type {readonly Family[]} */ ([reconcile, codeTests, citedReport, fileBatch, recompute, multiStep])
export const FAMILY_NAMES = FAMILIES.map(f => f.name)

/** Sizes fixed by the partition (M1). */
export const SIZES = Object.freeze({ trainFamilies: 4, holdoutFamilies: 2, trainPerFamily: 8, holdoutPerFamily: 20, guardPerTrainFamily: 1 })

/** Seed of the holdout draw; fixed before any case was generated or run. */
export const HOLDOUT_SEED = 'rework-m1-holdout-2026-10-16'

/** The two held-out families, drawn once by seed, in plan order. */
export const HOLDOUT_FAMILIES = picker(HOLDOUT_SEED).shuffle(FAMILY_NAMES).slice(0, SIZES.holdoutFamilies).sort((a, b) => FAMILY_NAMES.indexOf(a) - FAMILY_NAMES.indexOf(b))
export const TRAIN_FAMILIES = FAMILY_NAMES.filter(name => !HOLDOUT_FAMILIES.includes(name))

/** Share of cases with a convention point, and the cap on its weight share. */
export const CONVENTION_RATE = 0.5
export const CONVENTION_MAX_SHARE = 0.2

/**
 * One-off preferences a simulated user may add once (never scored). A learner that turns
 * them into standing rules is learning noise.
 */
export const TASTE_LINES = Object.freeze([
  '这次的说明写短一点就行',
  '这次文件里不用加标题',
  '这次能顺便告诉我你先看了哪个文件吗',
  '这次的说明用英文写也可以',
])
export const TASTE_RATE = 1 / 3

/** @param {string} name */
export const familyOf = name => {
  const family = FAMILIES.find(f => f.name === name)
  if (family === undefined) throw new Error(`unknown family ${name}`)
  return family
}

/** @param {string} family @param {'train' | 'holdout' | 'guard'} split @param {number} index */
export const caseId = (family, split, index) => `${family}/${split}/${String(index).padStart(2, '0')}`

/** Neutral folder name of a case (no family or split in it). @param {string} id */
export const folderOf = id => `job-${sha256(`folder:${id}`).slice(0, 8)}`

/** @param {string} folder @param {Answer} answer @returns {Answer} */
const inFolder = (folder, answer) => ({
  write: Object.fromEntries(Object.entries(answer.write).map(([path, content]) => [`${folder}/${path}`, content])),
  remove: answer.remove.map(path => `${folder}/${path}`),
})

/** @type {Map<string, { inner: InnerCase, task: ReworkCase }>} */
const cache = new Map()

/**
 * Build one case.
 * @param {string} familyName
 * @param {'train' | 'holdout' | 'guard'} split
 * @param {number} index 1-based
 */
export function buildCase(familyName, split, index) {
  const id = caseId(familyName, split, index)
  const hit = cache.get(id)
  if (hit !== undefined) return hit
  const family = familyOf(familyName)
  const draw = picker(`case:${id}`)
  const convention = draw.next() < CONVENTION_RATE
  const taste = draw.next() < TASTE_RATE ? draw.pick(TASTE_LINES) : null
  const inner = family.build(id, { convention })
  const folder = folderOf(id)
  const rubric = taste === null ? inner.rubric : [...inner.rubric, { id: 't', type: /** @type {const} */ ('taste'), by: /** @type {const} */ ('none'), weight: /** @type {const} */ (1), text: `（一次性的要求，不计分）${taste}`, feedback: taste }]
  /** @type {ReworkCase} */
  const task = {
    ...inner,
    rubric,
    id, family: familyName, split, index, seed: id, folder,
    message: `这次用到的文件都在项目的 ${folder}/ 目录下，下面说的路径都相对于这个目录。${inner.message}`,
    files: Object.fromEntries(Object.entries(inner.files).map(([path, content]) => [`${folder}/${path}`, content])),
    outputs: inner.outputs.map(path => `${folder}/${path}`),
  }
  const built = { inner, task }
  cache.set(id, built)
  return built
}

/** Every case of the plan: training families (train then guard), then holdout families. @returns {ReworkCase[]} */
export function allCases() {
  const out = []
  for (const name of FAMILY_NAMES) {
    if (HOLDOUT_FAMILIES.includes(name)) {
      for (let i = 1; i <= SIZES.holdoutPerFamily; i += 1) out.push(buildCase(name, 'holdout', i).task)
    } else {
      for (let i = 1; i <= SIZES.trainPerFamily; i += 1) out.push(buildCase(name, 'train', i).task)
      for (let i = 1; i <= SIZES.guardPerTrainFamily; i += 1) out.push(buildCase(name, 'guard', i).task)
    }
  }
  return out
}

/** @param {string} id */
export function caseById(id) {
  const task = allCases().find(c => c.id === id)
  if (task === undefined) throw new Error(`unknown case ${id}`)
  return task
}

/**
 * The training stream: round robin over the training families (case 1 of each, then
 * case 2, …), so learning meets every family early and the order is the same each run.
 * @param {readonly string[]} [families]
 */
export function trainingOrder(families = TRAIN_FAMILIES) {
  const out = []
  for (let i = 1; i <= SIZES.trainPerFamily; i += 1) for (const name of families) out.push(caseId(name, 'train', i))
  return out
}

/**
 * Which training cases also get template human feedback: half of each family, by a seeded
 * draw (the others carry only the product's own signals, evolution-gap-analysis.md §6).
 */
export function feedbackCases() {
  const out = []
  for (const name of TRAIN_FAMILIES) {
    const picked = picker(`feedback:${name}`).shuffle(Array.from({ length: SIZES.trainPerFamily }, (_, i) => i + 1)).slice(0, SIZES.trainPerFamily / 2).sort((a, b) => a - b)
    out.push(...picked.map(i => caseId(name, 'train', i)))
  }
  return out
}

/** The generic guard set for G1 in the C1 practice-case form. */
export const guardPracticeCases = () => allCases().filter(c => c.split === 'guard').map(practiceCaseOf)

/** Deterministic checkers of a case, on the project directory. @param {ReworkCase} task @returns {Record<string, Checker>} */
export function checkersOf(task) {
  const { inner } = buildCase(task.family, task.split, task.index)
  const checkers = familyOf(task.family).checkers(inner)
  return Object.fromEntries(Object.entries(checkers).map(([id, check]) => [id, /** @type {Checker} */ (dir => check(join(dir, task.folder)))]))
}

/** Judge a case in a project directory. @param {ReworkCase} task @param {string} dir @returns {Promise<Judged>} */
export const judgeCase = (task, dir) => runChecks(task, checkersOf(task), dir)

/** Known good end state, relative to the project. @param {ReworkCase} task */
export const goodOf = task => inFolder(task.folder, familyOf(task.family).good(buildCase(task.family, task.split, task.index).inner))

/** Known bad end states, one per checked point, relative to the project. @param {ReworkCase} task */
export const badOf = task => familyOf(task.family).bad(buildCase(task.family, task.split, task.index).inner).map(bad => ({ point: bad.point, answer: inFolder(task.folder, bad.answer) }))

/**
 * Plan problems: sizes, splits, unique ids / folders / fingerprints, rubric rules, the
 * convention share, distinct input-problem combinations per family, and that no case can
 * be passed by one remembered convention.
 * @param {ReworkCase[]} [cases]
 * @returns {string[]}
 */
export function checkPlan(cases = allCases()) {
  const problems = []
  if (HOLDOUT_FAMILIES.length !== SIZES.holdoutFamilies || TRAIN_FAMILIES.length !== SIZES.trainFamilies) problems.push('family split is not 4 + 2')
  const count = (/** @type {string} */ split, /** @type {string} */ family) => cases.filter(c => c.split === split && c.family === family).length
  for (const name of TRAIN_FAMILIES) {
    if (count('train', name) !== SIZES.trainPerFamily) problems.push(`${name}: ${count('train', name)} train cases`)
    if (count('holdout', name) !== 0) problems.push(`${name}: a training family has holdout cases`)
    if (count('guard', name) !== SIZES.guardPerTrainFamily) problems.push(`${name}: ${count('guard', name)} guard cases`)
  }
  for (const name of HOLDOUT_FAMILIES) {
    if (count('holdout', name) !== SIZES.holdoutPerFamily) problems.push(`${name}: ${count('holdout', name)} holdout cases`)
    if (count('train', name) + count('guard', name) !== 0) problems.push(`${name}: a held-out family has train or guard cases`)
  }
  for (const key of /** @type {const} */ (['id', 'folder'])) {
    const values = cases.map(c => c[key])
    if (new Set(values).size !== values.length) problems.push(`duplicate ${key}s`)
  }
  /** @type {Map<string, string>} */
  const owner = new Map()
  for (const task of cases) {
    for (const print of task.fingerprints) {
      const other = owner.get(print)
      if (other !== undefined && other !== task.id) problems.push(`fingerprint ${print.slice(0, 40)} shared by ${other} and ${task.id}`)
      owner.set(print, task.id)
    }
  }
  for (const task of cases) {
    problems.push(...checkRubric(task))
    const scored = task.rubric.filter(p => p.by === 'check')
    const total = scored.reduce((s, p) => s + p.weight, 0)
    const convention = scored.filter(p => p.type === 'convention').reduce((s, p) => s + p.weight, 0)
    if (convention / total > CONVENTION_MAX_SHARE + 1e-9) problems.push(`${task.id}: convention is ${Math.round((convention / total) * 100)}% of the score`)
    if (scored.filter(p => p.type !== 'convention').length < 3) problems.push(`${task.id}: fewer than three points besides the convention`)
    for (const word of ['train', 'holdout', 'guard', task.family]) {
      const visible = [task.message, ...Object.keys(task.files), ...Object.values(task.files).filter(v => typeof v === 'string')].join('\n')
      if (new RegExp(`\\b${word}\\b`, 'i').test(visible)) problems.push(`${task.id}: the word "${word}" is visible to the model`)
    }
  }
  for (const name of FAMILY_NAMES) {
    const mine = cases.filter(c => c.family === name && c.split !== 'guard')
    const combos = new Set(mine.map(c => c.traps.join('+')))
    if (mine.length > 0 && combos.size < 3) problems.push(`${name}: only ${combos.size} input-problem combinations`)
  }
  return problems
}

/**
 * Holdout isolation (M1 done criterion): no held-out case's fingerprint, message or folder
 * name appears under any of the roots (training projects and their `.nexgent`, every
 * arm's NEXGENT_HOME, the notes policy), before the holdout runs.
 * @param {readonly string[]} roots
 * @param {ReworkCase[]} [cases]
 */
export async function holdoutIsolation(roots, cases = allCases()) {
  const holdout = cases.filter(c => c.split === 'holdout').map(c => ({ ...c, set: 'holdout', fingerprints: [...c.fingerprints, c.folder, c.message.slice(c.message.indexOf('。') + 1, c.message.indexOf('。') + 41)] }))
  return checkIsolation(/** @type {any} */ (holdout), roots)
}
