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
import { docsBad, docsCases, docsCheckers, docsGood, docsTaste } from './docs.mjs'
import { filesBad, filesCases, filesCheckers, filesGood, filesTaste } from './files.mjs'

/**
 * @typedef {import('./common.mjs').PilotCase} PilotCase
 * @typedef {import('./common.mjs').PilotJudge} PilotJudge
 */

export const PILOT_FAMILIES = /** @type {const} */ (['docs', 'files'])

/** All sixteen cases, documents first, each family in plan order. @returns {PilotCase[]} */
export const pilotCases = () => [...docsCases(), ...filesCases()]

/** Deterministic checkers of a case. @param {PilotCase} task */
export const checkersOf = task => (task.family === 'docs' ? docsCheckers(task) : filesCheckers(task))

/** Known good end state. @param {PilotCase} task */
export const goodOf = task => (task.family === 'docs' ? docsGood(task) : filesGood(task))

/** Known bad end states, one per checked point. @param {PilotCase} task */
export const badOf = task => (task.family === 'docs' ? docsBad(task) : filesBad(task))

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
 * @param {string} dir
 * @returns {Promise<boolean>}
 */
export async function tasteMet(task, dir) {
  if (task.family === 'files') return filesTaste(task, dir)
  try {
    return docsTaste(task, (await readFile(join(dir, task.outputs[0]))).toString('utf8'))
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
