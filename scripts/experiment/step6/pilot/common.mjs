// @ts-check
/**
 * Shared shapes and helpers of the step-6 pilot (ADR 0011): the case and rubric types,
 * the six point types, text matching that tolerates the usual ways a number or a date is
 * written, CSV, file trees, and how a judge result is put together from deterministic
 * checks and the external reviewer's verdicts.
 *
 * A rubric point is judged one of three ways:
 *   check   deterministic, by the case's checker
 *   review  by the external reviewer (document family only), yes / no / can't tell
 *   none    a "personal taste" point: it shows up in feedback only, never in the score
 *
 * Linux, macOS and Windows; Node built-ins only.
 */
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * @typedef {'docs' | 'files'} PilotFamily
 * @typedef {'dev' | 'selection' | 'guard' | 'holdout'} CaseSet
 * @typedef {'wrong-result' | 'missing' | 'format' | 'unverified' | 'convention' | 'taste'} PointType
 * @typedef {'check' | 'review' | 'none'} JudgedBy
 * @typedef {{ id: string, type: PointType, text: string, feedback: string, by: JudgedBy }} Point
 *   `text` says what a good deliverable does (shown to the reviewer); `feedback` is the
 *   simulated user's words when the point is not met (never contains the expected value).
 * @typedef {{
 *   id: string, family: PilotFamily, set: CaseSet, variant: string, seed: string,
 *   message: string,
 *   files: Record<string, string | Uint8Array>,
 *   outputs: string[],
 *   fingerprints: string[],
 *   rubric: Point[],
 *   hidden: Record<string, any>,
 * }} PilotCase
 *   `files` are written into the project before the task; `outputs` are the paths (files or
 *   directories) the task writes; `hidden` is for the judge only.
 * @typedef {{ write: Record<string, string | Uint8Array>, remove: string[] }} Answer
 *   A project's end state relative to its start: files written (created or replaced) and
 *   files removed.
 * @typedef {{ pass: boolean, detail: string }} CheckOutcome
 * @typedef {(dir: string) => Promise<CheckOutcome>} Checker
 * @typedef {{ id: string, type: PointType, by: JudgedBy, pass: boolean | null, unclear?: boolean, detail: string }} PointResult
 *   `unclear`: the reviewer answered "can't tell"; it counts as not passed and is listed.
 * @typedef {{ pass: boolean | null, rate: number | null, points: PointResult[], problems: string[] }} PilotJudge
 *   `pass`: every scored (non-taste) point passed; `null` when any scored point is unknown.
 *   `rate`: passed / scored points; `null` when any is unknown.
 */

/** Point types, with their Chinese names (ADR 0011 decision 4). */
export const POINT_TYPES = /** @type {const} */ ({
  'wrong-result': '结果错误',
  missing: '漏做',
  format: '格式不对',
  unverified: '没核对就交',
  convention: '项目约定',
  taste: '个人口味',
})

export const SET_SIZES = { dev: 2, selection: 2, guard: 1, holdout: 3 }

/**
 * Rubric rules every case keeps: 3–6 points; at most one project convention; taste points
 * are judged by nobody; review points only in the document family.
 * @param {PilotCase} task
 * @returns {string[]} problems
 */
export function checkRubric(task) {
  const problems = []
  const n = task.rubric.length
  if (n < 3 || n > 6) problems.push(`${task.id}: ${n} rubric points, expected 3–6`)
  if (task.rubric.filter(p => p.type === 'convention').length > 1) problems.push(`${task.id}: more than one project-convention point`)
  for (const point of task.rubric) {
    if (!(point.type in POINT_TYPES)) problems.push(`${task.id}/${point.id}: unknown type ${point.type}`)
    if ((point.type === 'taste') !== (point.by === 'none')) problems.push(`${task.id}/${point.id}: taste points and only they are judged by nobody`)
    if (point.by === 'review' && task.family !== 'docs') problems.push(`${task.id}/${point.id}: review points are for the document family only`)
  }
  const ids = task.rubric.map(p => p.id)
  if (new Set(ids).size !== ids.length) problems.push(`${task.id}: duplicate point ids`)
  return problems
}

// ---------------------------------------------------------------------------
// Text matching
// ---------------------------------------------------------------------------

/**
 * Text with the noise of number writing removed: full-width digits and punctuation to
 * ASCII, thousands separators and spaces between digits and units dropped.
 * @param {string} text
 */
export function normalize(text) {
  return text
    .replace(/[０-９]/g, d => String.fromCharCode(d.charCodeAt(0) - 0xFEE0))
    .replace(/[，]/g, ',').replace(/[．]/g, '.').replace(/[：]/g, ':').replace(/[／]/g, '/')
    .replace(/(\d),(?=\d{3}(?!\d))/g, '$1')
    .replace(/(\d)\s+(?=[万元%个人条次分钟小时天周月年号日])/g, '$1')
}

/**
 * Ways a date may be written: `2026-10-12`, `2026/10/12`, `2026年10月12日`, `10月12日`,
 * `10-12`, `10/12`, `10.12`.
 * @param {string} iso YYYY-MM-DD
 */
export function dateForms(iso) {
  const [y, m, d] = iso.split('-')
  const mi = String(Number(m))
  const di = String(Number(d))
  return [...new Set([
    `${y}-${m}-${d}`, `${y}/${m}/${d}`, `${y}.${m}.${d}`, `${y}年${mi}月${di}日`, `${y}年${m}月${d}日`,
    `${mi}月${di}日`, `${m}月${d}日`, `${m}-${d}`, `${m}/${d}`, `${mi}/${di}`, `${m}.${d}`, `${mi}.${di}`,
  ])]
}

/**
 * Ways an amount may be written after `normalize`: plain (with or without trailing zeros
 * of two decimals), and in 万 with up to two decimals.
 * @param {number} value
 */
export function amountForms(value) {
  const forms = new Set([String(value), value.toFixed(2), value.toFixed(1).replace(/\.0$/, '')])
  if (Number.isInteger(value)) forms.add(String(value))
  const wan = value / 10_000
  if (Math.abs(value) >= 10_000) {
    for (const digits of [0, 1, 2]) {
      const text = wan.toFixed(digits)
      if (Math.abs(Number(text) - wan) <= 0.5 * 10 ** -digits + 1e-9) forms.add(`${text}万`)
    }
    forms.add(`${wan.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}万`)
  }
  return [...forms]
}

/**
 * Whether a number form occurs in text as a whole number (not inside a longer number).
 * @param {string} text normalized
 * @param {string} form
 */
export function hasNumber(text, form) {
  const escaped = form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![\\d.])${escaped}(?![\\d]|\\.\\d)`).test(text)
}

/** @param {string} text @param {readonly string[]} forms */
export const hasAny = (text, forms) => forms.some(form => (/^[\d.]+万?$/.test(form) ? hasNumber(text, form) : text.includes(form)))

/** Markdown heading lines. @param {string} text */
export const headings = text => text.split(/\r?\n/).filter(line => /^#{1,6}\s/.test(line))

/**
 * The part of a document where cited sources belong: everything after the last heading
 * that names references or sources, else the last ten non-empty lines.
 * @param {string} text
 */
export function citationTail(text) {
  const lines = text.split(/\r?\n/)
  let at = -1
  lines.forEach((line, i) => { if (/^#{1,6}\s.*(引用|参考|资料|来源|出处|References|Sources)/i.test(line)) at = i })
  if (at >= 0) return lines.slice(at + 1).join('\n')
  return lines.filter(line => line.trim() !== '').slice(-10).join('\n')
}

/** Whether every name is cited at the end of the document. @param {string} text @param {readonly string[]} names */
export const citesAll = (text, names) => {
  const tail = citationTail(text)
  return names.filter(name => !tail.includes(name))
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/**
 * Rows of a CSV text (RFC 4180 quotes; a leading BOM is dropped; `,` or `;` or tab,
 * whichever splits the header into most fields).
 * @param {string} text
 * @returns {string[][]}
 */
export function parseCsv(text) {
  const body = text.replace(/^﻿/, '')
  const firstLine = body.split(/\r?\n/, 1)[0] ?? ''
  const delimiter = [',', ';', '\t'].map(d => [d, firstLine.split(d).length]).sort((a, b) => Number(b[1]) - Number(a[1]))[0][0]
  /** @type {string[][]} */
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i]
    if (quoted) {
      if (char === '"' && body[i + 1] === '"') { field += '"'; i += 1 }
      else if (char === '"') quoted = false
      else field += char
    } else if (char === '"' && field === '') quoted = true
    else if (char === delimiter) { row.push(field); field = '' }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && body[i + 1] === '\n') i += 1
      row.push(field); rows.push(row); row = []; field = ''
    } else field += char
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row) }
  return rows.filter(r => !(r.length === 1 && r[0] === ''))
}

/** CSV text (LF line ends, quotes where needed). @param {ReadonlyArray<ReadonlyArray<string | number>>} rows */
export const toCsv = rows => `${rows.map(row => row.map(cell => {
  const text = String(cell)
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}).join(',')).join('\n')}\n`

/** Cells equal as written values: numbers by value, text trimmed. @param {unknown} a @param {unknown} b */
export function sameCell(a, b) {
  const text = (/** @type {unknown} */ v) => (v === null || v === undefined ? '' : String(v).trim())
  const x = text(a)
  const y = text(b)
  if (x === y) return true
  return x !== '' && y !== '' && !Number.isNaN(Number(x)) && !Number.isNaN(Number(y)) && Math.abs(Number(x) - Number(y)) < 1e-9
}

/** Table rows equal cell by cell (trailing empty cells ignored). @param {ReadonlyArray<ReadonlyArray<unknown>>} got @param {ReadonlyArray<ReadonlyArray<unknown>>} want */
export function firstTableDifference(got, want) {
  const trim = (/** @type {ReadonlyArray<unknown>} */ row) => {
    const out = [...row]
    while (out.length > 0 && (out.at(-1) === null || out.at(-1) === undefined || String(out.at(-1)).trim() === '')) out.pop()
    return out
  }
  const rows = got.map(trim).filter(r => r.length > 0)
  if (rows.length !== want.length) return `${rows.length} rows, expected ${want.length}`
  for (let r = 0; r < want.length; r += 1) {
    if (rows[r].length !== want[r].length) return `row ${r + 1}: ${rows[r].length} cells, expected ${want[r].length}`
    for (let c = 0; c < want[r].length; c += 1) if (!sameCell(rows[r][c], want[r][c])) return `row ${r + 1} column ${c + 1}: ${JSON.stringify(rows[r][c])}, expected ${JSON.stringify(want[r][c])}`
  }
  return null
}

// ---------------------------------------------------------------------------
// File trees
// ---------------------------------------------------------------------------

/**
 * Files under a directory, as sorted POSIX paths relative to it (empty when missing).
 * `.nexgent` is skipped.
 * @param {string} dir
 * @param {string} [prefix]
 * @returns {Promise<string[]>}
 */
export async function listFiles(dir, prefix = '') {
  let names
  try {
    names = (await readdir(join(dir, prefix))).sort()
  } catch {
    return []
  }
  const out = []
  for (const name of names) {
    if (prefix === '' && name === '.nexgent') continue
    const rel = prefix === '' ? name : `${prefix}/${name}`
    const info = await stat(join(dir, rel))
    if (info.isDirectory()) out.push(...await listFiles(dir, rel))
    else if (info.isFile()) out.push(rel)
  }
  return out
}

/** @param {string} dir @param {string} rel */
export const readBytes = async (dir, rel) => new Uint8Array(await readFile(join(dir, rel)))

/** @param {string} dir @param {string} rel */
export const readText = async (dir, rel) => (await readFile(join(dir, rel))).toString('utf8')

/** @param {string} dir @param {Record<string, string | Uint8Array>} files */
export async function writeFiles(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, rel)), { recursive: true })
    await writeFile(join(dir, rel), content)
  }
}

/** Put an answer's end state into a directory that holds the case's starting files. @param {string} dir @param {Answer} answer */
export async function applyAnswer(dir, answer) {
  for (const rel of answer.remove) await rm(join(dir, rel), { force: true })
  await writeFiles(dir, answer.write)
}

/** Bytes equal. @param {Uint8Array} a @param {Uint8Array} b */
export const sameBytes = (a, b) => a.length === b.length && Buffer.from(a).equals(Buffer.from(b))

/** Content of a starting file as bytes. @param {string | Uint8Array} content */
export const bytesOf = content => (typeof content === 'string' ? new Uint8Array(Buffer.from(content, 'utf8')) : content)

// ---------------------------------------------------------------------------
// Judge results
// ---------------------------------------------------------------------------

/**
 * Run the deterministic checkers of a case. Review points stay unknown (`pass: null`)
 * until `withReview` fills them; taste points are left out.
 * @param {PilotCase} task
 * @param {Record<string, Checker>} checkers
 * @param {string} dir
 * @returns {Promise<PilotJudge>}
 */
export async function runChecks(task, checkers, dir) {
  /** @type {PointResult[]} */
  const points = []
  const problems = []
  for (const point of task.rubric) {
    if (point.by === 'none') continue
    if (point.by === 'review') { points.push({ id: point.id, type: point.type, by: 'review', pass: null, detail: 'not reviewed yet' }); continue }
    const checker = checkers[point.id]
    if (checker === undefined) { points.push({ id: point.id, type: point.type, by: 'check', pass: null, detail: 'no checker' }); problems.push(`${task.id}/${point.id}: no checker`); continue }
    try {
      const outcome = await checker(dir)
      points.push({ id: point.id, type: point.type, by: 'check', pass: outcome.pass, detail: outcome.detail })
    } catch (error) {
      points.push({ id: point.id, type: point.type, by: 'check', pass: null, detail: 'checker failed' })
      problems.push(`${task.id}/${point.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return summarize(points, problems)
}

/**
 * Fill review points with the external reviewer's verdicts (`yes` / `no` / `unclear`;
 * missing → unknown).
 * @param {PilotJudge} judged
 * @param {Record<string, { verdict: 'yes' | 'no' | 'unclear', reason: string }> | null} verdicts `null`: the review failed
 * @returns {PilotJudge}
 */
export function withReview(judged, verdicts) {
  const points = judged.points.map(point => {
    if (point.by !== 'review') return point
    const v = verdicts?.[point.id]
    if (v === undefined) return { ...point, pass: null, detail: verdicts === null ? 'review failed' : 'reviewer gave no verdict' }
    return v.verdict === 'unclear' ? { ...point, pass: false, unclear: true, detail: v.reason } : { ...point, pass: v.verdict === 'yes', detail: v.reason }
  })
  return summarize(points, verdicts === null ? [...judged.problems, 'external review failed'] : judged.problems)
}

/** @param {PointResult[]} points @param {string[]} problems @returns {PilotJudge} */
function summarize(points, problems) {
  const unknown = points.some(p => p.pass === null)
  const passed = points.filter(p => p.pass === true).length
  return {
    pass: unknown ? null : passed === points.length,
    rate: unknown || points.length === 0 ? null : passed / points.length,
    points,
    problems,
  }
}
