// @ts-check
/**
 * The pilot's sixteen cases (ADR 0011): document writing and file handling, eight each,
 * split dev 2 / selection 2 / guard 1 / holdout 3, plus one entry point per case for its
 * deterministic checks, its known good and bad end states, and its taste point.
 *
 * Set checks (sizes, unique ids and seeds, no shared fingerprints, a holdout variant dev
 * never had) and holdout isolation reuse `../cases.mjs`.
 *
 * Linux, macOS and Windows; Node built-ins only.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { checkSets } from '../cases.mjs'
import { checkRubric, runChecks } from './common.mjs'
import { docsBad, docsCases, docsCheckers, docsGood, docsTaste, referencePairs } from './docs.mjs'
import { filesBad, filesCases, filesCheckers, filesGood, filesTaste } from './files.mjs'

/**
 * @typedef {import('./common.mjs').PilotCase} PilotCase
 * @typedef {import('./common.mjs').PilotJudge} PilotJudge
 * @typedef {import('./common.mjs').Answer} Answer
 * @typedef {import('./common.mjs').Checker} Checker
 */

export const PILOT_FAMILIES = /** @type {const} */ (['docs', 'files'])

/**
 * Every case works in a folder of its own, named by its seed: its starting files and its
 * outputs live there and the message says so. A family's cases share one project, so
 * without it the tasks would leave inputs and outputs in the same `materials/`, `data/` or
 * `output/` for the next task to trip over (a holdout run would find a history task's
 * files where its own should be).
 * @param {PilotCase} task
 */
export const folderOf = task => task.seed

/** The cases as the family generators build them (paths relative to the case folder). @returns {PilotCase[]} */
const innerCases = () => [...docsCases(), ...filesCases()]

/** @param {string} folder @param {Answer} answer @returns {Answer} */
const inFolder = (folder, answer) => ({
  write: Object.fromEntries(Object.entries(answer.write).map(([path, content]) => [`${folder}/${path}`, content])),
  remove: answer.remove.map(path => `${folder}/${path}`),
})

/** @param {PilotCase} inner @returns {PilotCase} */
function wrap(inner) {
  const folder = folderOf(inner)
  return {
    ...inner,
    message: `这次用到的文件都在项目的 ${folder}/ 目录下，下面说的路径都相对于这个目录。${inner.message}`,
    files: Object.fromEntries(Object.entries(inner.files).map(([path, content]) => [`${folder}/${path}`, content])),
    outputs: inner.outputs.map(path => `${folder}/${path}`),
  }
}

/** All sixteen cases, documents first, each family in plan order, each in its folder. @returns {PilotCase[]} */
export const pilotCases = () => innerCases().map(wrap)

/** The generator's case behind a pilot case. @param {PilotCase} task */
function innerOf(task) {
  const inner = innerCases().find(c => c.id === task.id)
  if (inner === undefined) throw new Error(`unknown pilot case ${task.id}`)
  return inner
}

/** Deterministic checkers of a case, run on the project directory. @param {PilotCase} task @returns {Record<string, Checker>} */
export function checkersOf(task) {
  const inner = innerOf(task)
  const checkers = inner.family === 'docs' ? docsCheckers(inner) : filesCheckers(inner)
  return Object.fromEntries(Object.entries(checkers).map(([id, check]) => [id, /** @type {Checker} */ (dir => check(join(dir, folderOf(task))))]))
}

/** Known good end state, relative to the project. @param {PilotCase} task @returns {Answer} */
export const goodOf = task => {
  const inner = innerOf(task)
  return inFolder(folderOf(task), inner.family === 'docs' ? docsGood(inner) : filesGood(inner))
}

/** Known bad end states, one per checked point, relative to the project. @param {PilotCase} task */
export const badOf = task => {
  const inner = innerOf(task)
  return (inner.family === 'docs' ? docsBad(inner) : filesBad(inner)).map(bad => ({ point: bad.point, answer: inFolder(folderOf(task), bad.answer) }))
}

/** The six reference pairs of reliability criterion 2 (docs.mjs `referencePairs`). */
export const pilotReferencePairs = () => referencePairs(innerCases())

/**
 * Run a case's deterministic checks in a project directory (review points stay unknown
 * until the external reviewer fills them).
 * @param {PilotCase} task
 * @param {string} dir
 * @returns {Promise<PilotJudge>}
 */
export const judgePilotCase = (task, dir) => runChecks(task, checkersOf(task), dir)

/**
 * Whether the deliverable already matches the case's taste point.
 * @param {PilotCase} task
 * @param {string} dir the project directory
 * @returns {Promise<boolean>}
 */
export async function tasteMet(task, dir) {
  const inner = innerOf(task)
  const here = join(dir, folderOf(task))
  if (inner.family === 'files') return filesTaste(inner, here)
  try {
    return docsTaste(inner, (await readFile(join(here, inner.outputs[0]))).toString('utf8'))
  } catch {
    return false
  }
}

/**
 * Plan problems: set split (sizes, ids, seeds, fingerprints, a holdout variant dev never
 * had) and rubric rules, for both families.
 * @param {PilotCase[]} [cases]
 * @returns {string[]}
 */
export function checkPilotPlan(cases = pilotCases()) {
  const asTaskCases = cases.map(task => ({ ...task, family: /** @type {any} */ (task.family), materials: [], files: {} }))
  return [...checkSets(/** @type {any} */ (asTaskCases)), ...cases.flatMap(checkRubric)]
}
