/**
 * ADR 0018 decision 2: deterministic checks a task's result can be held to
 * whatever the task was, beyond the recorded `file-exists` / `parses` /
 * `test-command` (G1). They read files only: no command runs, nothing is
 * written, no model is asked.
 *
 * - `references-exist`: the project files the final answer and the text
 *   deliverables point to (in backticks or Markdown links) exist.
 * - `totals-recompute`: a table (CSV, or a Markdown pipe table) whose last
 *   row is labelled as a total has, in every numeric column, the sum of the
 *   rows above it. A table with subtotal rows is not checked.
 *
 * Each check is only reported when it applies (a reference was found, a
 * table had a total row), so a task without either gets no generic check.
 */
import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, join, normalize, posix } from 'node:path'
import type { TaskCheck } from '@nexgent/kernel'

/** Generic check names (`TaskCheck.name`). */
export const GENERIC_CHECK_NAMES = ['references-exist', 'totals-recompute'] as const

/** Text files the checks read, at most this many bytes each. */
const MAX_FILE_BYTES = 2 * 1024 * 1024
/** References checked per text, at most. */
const MAX_REFERENCES = 50

/** Labels of a grand-total row (first non-empty cell, case-insensitive). */
const TOTAL_LABEL = /^(?:grand\s+total|totals?|sum|overall|合计|总计|总和|合計|總計|総計)[:：]?$/i
/** Labels of a subtotal row: a table with one is not recomputed. */
const SUBTOTAL_LABEL = /^(?:sub-?\s*totals?|小计|小計)\b/i

function isPathLike(token: string): boolean {
  if (token.length === 0 || token.length > 300) return false
  if (/^[a-z][a-z0-9+.-]*:/i.test(token)) return false // URLs, drive letters, schemes
  if (token.startsWith('#') || token.startsWith('-') || /\s/.test(token)) return false
  if (token.includes('*') || token.includes('{') || token.includes('$') || token.includes('<')) return false
  // A file name with an extension of letters, or a path with a separator.
  return /\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(token) && /[A-Za-z0-9_\-一-鿿]/.test(token.slice(0, -1))
}

/**
 * The project-relative paths a text refers to: backticked tokens and
 * Markdown link targets that look like file paths (`references-exist`).
 */
export function referencedPaths(text: string): string[] {
  const found = new Set<string>()
  for (const match of text.matchAll(/`([^`\n]{1,300})`/g)) {
    const token = match[1]!.trim().replace(/^\.\//, '')
    if (isPathLike(token)) found.add(token)
  }
  for (const match of text.matchAll(/\]\(([^)\s]{1,300})\)/g)) {
    const token = decodeURIComponentSafe(match[1]!.trim()).replace(/^\.\//, '').replace(/#.*$/, '')
    if (isPathLike(token)) found.add(token)
  }
  return [...found].filter(path => !isAbsolute(path) && !path.split(/[\\/]/).includes('..')).slice(0, MAX_REFERENCES)
}

function decodeURIComponentSafe(text: string): string {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

async function exists(root: string, path: string): Promise<boolean> {
  return stat(join(root, normalize(path))).then(entry => entry.isFile() || entry.isDirectory(), () => false)
}

/** A parsed number of a table cell (thousands separators, currency marks, a trailing %), or `undefined`. */
export function cellNumber(cell: string): number | undefined {
  let text = cell.trim().replace(/^[*_]+|[*_]+$/g, '')
  if (text === '') return undefined
  let negative = false
  if (/^\(.*\)$/.test(text)) {
    negative = true
    text = text.slice(1, -1)
  }
  text = text.replace(/^[$€£¥￥]|[$€£¥￥]$/g, '').replace(/%$/, '').trim()
  if (!/^[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/.test(text)) return undefined
  const value = Number(text.replace(/,/g, ''))
  return Number.isFinite(value) ? (negative ? -value : value) : undefined
}

/** Rows of a CSV text (quotes handled). */
export function csvRows(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 1
        } else quoted = false
      } else field += char
      continue
    }
    if (char === '"') quoted = true
    else if (char === ',') {
      row.push(field)
      field = ''
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i += 1
      row.push(field)
      if (row.some(cell => cell.trim() !== '')) rows.push(row)
      row = []
      field = ''
    } else field += char
  }
  row.push(field)
  if (row.some(cell => cell.trim() !== '')) rows.push(row)
  return rows
}

/** Markdown pipe tables of a text, each as its rows (header first, separator row dropped). */
export function markdownTables(text: string): string[][][] {
  const tables: string[][][] = []
  let current: string[][] = []
  const flush = () => {
    if (current.length >= 2) tables.push(current)
    current = []
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('|')) {
      flush()
      continue
    }
    const cells = trimmed.replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim())
    if (cells.every(cell => /^:?-{2,}:?$/.test(cell))) continue
    current.push(cells)
  }
  flush()
  return tables
}

/**
 * Whether a table's grand-total row equals the sum of the rows above it in
 * every numeric column: `undefined` when the table has no total row as its
 * last row, has a subtotal row, or no column to check.
 */
export function totalsProblem(rows: readonly (readonly string[])[]): { readonly checked: number; readonly mismatched: number } | undefined {
  if (rows.length < 3) return undefined
  const label = (row: readonly string[]) => row.find(cell => cell.trim() !== '')?.trim() ?? ''
  const last = rows[rows.length - 1]!
  if (!TOTAL_LABEL.test(label(last))) return undefined
  const body = rows.slice(1, -1)
  if (body.some(row => SUBTOTAL_LABEL.test(label(row)) || TOTAL_LABEL.test(label(row)))) return undefined
  let checked = 0
  let mismatched = 0
  for (let column = 0; column < last.length; column += 1) {
    const total = cellNumber(last[column] ?? '')
    if (total === undefined) continue
    const values = body.map(row => cellNumber(row[column] ?? ''))
    // A column is a number column when every body cell that is not empty is a number.
    const filled = body.filter(row => (row[column] ?? '').trim() !== '')
    if (filled.length === 0 || values.filter(value => value !== undefined).length !== filled.length) continue
    const sum = values.reduce<number>((acc, value) => acc + (value ?? 0), 0)
    checked += 1
    const tolerance = Math.max(0.01, Math.abs(sum) * 1e-6)
    if (Math.abs(sum - total) > tolerance) mismatched += 1
  }
  return checked === 0 ? undefined : { checked, mismatched }
}

async function readText(root: string, path: string): Promise<string | undefined> {
  try {
    const file = join(root, ...path.split('/'))
    const info = await stat(file)
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return undefined
    return new TextDecoder('utf-8', { fatal: true }).decode(await readFile(file))
  } catch {
    return undefined
  }
}

/**
 * The generic checks of a finished task: `files` are the project-relative
 * paths of what the task delivered or changed, `answer` the final assistant
 * text. Missing or unreadable files are skipped (the recorded checks report
 * them).
 */
export async function genericChecks(root: string, files: readonly string[], answer: string): Promise<TaskCheck[]> {
  const checks: TaskCheck[] = []
  const texts: { readonly path?: string; readonly text: string }[] = [{ text: answer }]
  const tables: string[][][] = []
  for (const path of files) {
    const extension = posix.extname(path).toLowerCase()
    if (!['.md', '.markdown', '.txt', '.csv', '.tsv'].includes(extension)) continue
    const text = await readText(root, path)
    if (text === undefined) continue
    if (extension === '.csv') tables.push(csvRows(text))
    else if (extension === '.tsv') tables.push(text.split(/\r?\n/).filter(line => line.trim() !== '').map(line => line.split('\t')))
    else {
      texts.push({ path, text })
      tables.push(...markdownTables(text))
    }
  }
  tables.push(...markdownTables(answer))

  const references = new Set<string>()
  for (const { path, text } of texts) {
    for (const reference of referencedPaths(text)) {
      // A reference inside a file is relative to the project root, or to the file's directory.
      references.add(reference)
      if (path !== undefined && posix.dirname(path) !== '.') references.add(`?${posix.join(posix.dirname(path), reference)}|${reference}`)
    }
  }
  const plain = [...references].filter(reference => !reference.startsWith('?'))
  if (plain.length > 0) {
    let missing = 0
    for (const reference of plain) {
      if (await exists(root, reference)) continue
      const alternative = [...references].find(item => item.startsWith('?') && item.endsWith(`|${reference}`))?.slice(1).split('|')[0]
      if (alternative !== undefined && await exists(root, alternative)) continue
      missing += 1
    }
    checks.push({ name: 'references-exist', passed: missing === 0, ...(missing === 0 ? {} : { detail: `${missing} of ${plain.length} referenced files missing` }) })
  }

  let checked = 0
  let mismatched = 0
  for (const table of tables) {
    const result = totalsProblem(table)
    if (result === undefined) continue
    checked += result.checked
    mismatched += result.mismatched
  }
  if (checked > 0) checks.push({ name: 'totals-recompute', passed: mismatched === 0, ...(mismatched === 0 ? {} : { detail: `${mismatched} of ${checked} total columns do not add up` }) })
  return checks
}
