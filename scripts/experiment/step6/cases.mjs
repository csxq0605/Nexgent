// @ts-check
/**
 * Step-6 measurement cases: the two task families split into four sets that
 * never overlap (docs/plan/step-6-work-partition.md §测量, user decision 6):
 *
 *   dev 2        tasks that get feedback and start improvement jobs
 *   selection 2  project history the gate picks comparison cases from
 *   guard 1      project history clearly unlike dev, for the gate's guard set
 *   holdout 3    never in any experiment project's history; run only in arm copies;
 *                at least one variant dev never had
 *
 * plus the checks that keep them apart: set disjointness, holdout isolation
 * (no holdout message, seed or material in a project's sessions, snapshots or
 * receipts) and "the gate only picked dev ∪ selection ∪ guard".
 *
 * Linux, macOS and Windows; no dependencies.
 */
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { codeCase, judgeCodeCase } from './code.mjs'
import { judgeTableCase, tableCase } from './tables.mjs'

/**
 * @typedef {'dev' | 'selection' | 'guard' | 'holdout'} CaseSet
 * @typedef {'tables' | 'code'} Family
 * @typedef {{ kind: string, detail: string }} Issue
 * @typedef {{ pass: boolean | null, issues: Issue[], problems: string[] }} JudgeResult
 *   `pass: null` is unknown (the judge could not finish); it never counts as a success.
 * @typedef {{
 *   id: string, family: Family, set: CaseSet, variant: string, seed: string | number,
 *   message: string,
 *   files: Record<string, string>,
 *   materials: Array<{ name: string, content: string }>,
 *   outputs: string[],
 *   fingerprints: string[],
 *   hidden: Record<string, unknown>,
 * }} TaskCase
 *   `files` are written into the project (relative paths) before the task runs; `materials`
 *   are attached as the project's materials; `hidden` is for the judge only and is never
 *   written into a project.
 */

export const SETS = /** @type {const} */ (['dev', 'selection', 'guard', 'holdout'])
export const FAMILIES = /** @type {const} */ (['tables', 'code'])

/** Required size of each set (user decision 6). */
/**
 * What the experiment's user says when a history or dev task ended without a deliverable:
 * feedback attaches to a deliverable, so the user asks for one (same session, one more turn).
 */
export const PRESENT_REQUEST = '请把这次改动或生成的文件用 present 提交成成果，我要在成果里看。'

export const SET_SIZES = { dev: 2, selection: 2, guard: 1, holdout: 3 }

/** The case plan: set, variant and seed of every case. Changing it is a new experiment. */
export const PLAN = {
  tables: [
    { set: 'dev', variant: 'region', seed: '2026-09' },
    { set: 'dev', variant: 'region', seed: '2026-10' },
    { set: 'selection', variant: 'region', seed: '2026-07' },
    { set: 'selection', variant: 'category', seed: '2026-08' },
    { set: 'guard', variant: 'summary', seed: '2026-06' },
    { set: 'holdout', variant: 'region', seed: '2026-12' },
    { set: 'holdout', variant: 'category', seed: '2027-01' },
    { set: 'holdout', variant: 'returns', seed: '2027-02' },
  ],
  code: [
    { set: 'dev', variant: 'bugfix', seed: 101 },
    { set: 'dev', variant: 'feature', seed: 102 },
    { set: 'selection', variant: 'bugfix', seed: 103 },
    { set: 'selection', variant: 'feature', seed: 104 },
    { set: 'guard', variant: 'refactor', seed: 107 },
    { set: 'holdout', variant: 'bugfix', seed: 109 },
    { set: 'holdout', variant: 'feature', seed: 106 },
    { set: 'holdout', variant: 'refactor', seed: 108 },
  ],
}

/**
 * Every case of one family, in plan order.
 * @param {Family} family
 * @returns {TaskCase[]}
 */
export function familyCases(family) {
  return PLAN[family].map(entry => {
    const id = `${family}/${entry.set}/${entry.variant}-${entry.seed}`
    const set = /** @type {CaseSet} */ (entry.set)
    return family === 'tables'
      ? tableCase({ id, set, variant: /** @type {any} */ (entry.variant), month: String(entry.seed) })
      : codeCase({ id, set, variant: /** @type {any} */ (entry.variant), seed: Number(entry.seed) })
  })
}

/** Both families. */
export function allCases() {
  return FAMILIES.flatMap(familyCases)
}

/**
 * Judge a case in a project directory (or an arm copy).
 * @param {TaskCase} task
 * @param {string} projectDir
 * @returns {Promise<JudgeResult>}
 */
export function judgeCase(task, projectDir) {
  return task.family === 'tables' ? judgeTableCase(task, projectDir) : judgeCodeCase(task, projectDir)
}

/**
 * Write a case's starting files and materials into a directory (materials under
 * `materials/`, for tests and for an experiment that copies them in itself).
 * @param {TaskCase} task
 * @param {string} dir
 */
export async function writeCaseFiles(task, dir) {
  for (const [path, text] of Object.entries(task.files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true })
    await writeFile(join(dir, path), text)
  }
  for (const material of task.materials) {
    await mkdir(join(dir, 'materials'), { recursive: true })
    await writeFile(join(dir, 'materials', material.name), material.content)
  }
}

/**
 * Check one family's sets: sizes, unique ids and seeds, no shared fingerprints across
 * cases, holdout has a variant dev never had (and, for code, a bug or feature kind).
 * @param {TaskCase[]} cases
 * @returns {string[]} problems; empty when the split is sound
 */
export function checkSets(cases) {
  const problems = []
  for (const family of new Set(cases.map(task => task.family))) {
    const mine = cases.filter(task => task.family === family)
    for (const set of SETS) {
      const n = mine.filter(task => task.set === set).length
      if (n !== SET_SIZES[set]) problems.push(`${family}: ${set} has ${n} cases, expected ${SET_SIZES[set]}`)
    }
    const seeds = mine.map(task => String(task.seed))
    for (const seed of new Set(seeds)) if (seeds.filter(s => s === seed).length > 1) problems.push(`${family}: seed ${seed} is used more than once`)
    const devVariants = new Set(mine.filter(task => task.set === 'dev').map(task => task.variant))
    if (!mine.some(task => task.set === 'holdout' && !devVariants.has(task.variant))) problems.push(`${family}: every holdout variant also appears in dev`)
  }
  const ids = cases.map(task => task.id)
  for (const id of new Set(ids)) if (ids.filter(x => x === id).length > 1) problems.push(`case id ${id} is used more than once`)
  for (const a of cases) {
    for (const b of cases) {
      if (a.id >= b.id) continue
      for (const print of a.fingerprints) if (b.fingerprints.includes(print) || b.message.includes(print)) problems.push(`${a.id} and ${b.id} share ${JSON.stringify(print.slice(0, 40))}`)
    }
  }
  return problems
}

/**
 * The gate may only pick history cases (dev ∪ selection ∪ guard).
 * @param {readonly string[]} pickedIds case ids the gate used for comparison or guard
 * @param {TaskCase[]} cases
 * @returns {string[]} problems
 */
export function checkGatePicks(pickedIds, cases) {
  return pickedIds.flatMap(id => {
    const task = cases.find(c => c.id === id)
    if (task === undefined) return [`gate picked ${id}, which is not a planned case`]
    return task.set === 'holdout' ? [`gate picked holdout case ${id}`] : []
  })
}

/**
 * Text forms a fingerprint may take in stored files: raw, and JSON-escaped (sessions and
 * receipts are JSON lines, so newlines and quotes are escaped there).
 * @param {string} print
 */
function forms(print) {
  const escaped = JSON.stringify(print).slice(1, -1)
  return escaped === print ? [print] : [print, escaped]
}

/**
 * Search files under the given roots (a project's `.nexgent/sessions`, snapshots, receipts…)
 * for any holdout case's fingerprints. Binary-looking and oversized files are skipped
 * and reported.
 * @param {TaskCase[]} cases
 * @param {readonly string[]} roots
 * @param {{ maxBytes?: number }} [options]
 * @returns {Promise<{ leaks: Array<{ caseId: string, file: string, fingerprint: string }>, scanned: number, skipped: string[] }>}
 */
export async function checkIsolation(cases, roots, { maxBytes = 32 * 1024 * 1024 } = {}) {
  const holdout = cases.filter(task => task.set === 'holdout')
  const needles = holdout.flatMap(task => task.fingerprints.flatMap(print => forms(print).map(form => ({ caseId: task.id, print, form }))))
  /** @type {Array<{ caseId: string, file: string, fingerprint: string }>} */
  const leaks = []
  /** @type {string[]} */
  const skipped = []
  let scanned = 0
  /** @param {string} root @param {string} path */
  async function visit(root, path) {
    let info
    try {
      info = await stat(path)
    } catch {
      return
    }
    if (info.isDirectory()) {
      for (const name of (await readdir(path)).sort()) await visit(root, join(path, name))
      return
    }
    if (!info.isFile()) return
    if (info.size > maxBytes) { skipped.push(path); return }
    const buffer = await readFile(path)
    if (buffer.includes(0)) { skipped.push(path); return }
    const text = buffer.toString('utf8')
    scanned += 1
    const seen = new Set()
    for (const needle of needles) {
      if (seen.has(`${needle.caseId}\0${needle.print}`)) continue
      if (text.includes(needle.form)) {
        seen.add(`${needle.caseId}\0${needle.print}`)
        leaks.push({ caseId: needle.caseId, file: relative(root, path) || path, fingerprint: needle.print.slice(0, 80) })
      }
    }
  }
  for (const root of roots) await visit(root, root)
  return { leaks, scanned, skipped }
}
