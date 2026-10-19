/**
 * Line diff (Myers, O((N+M)·D)) and unified-diff hunks with 3 lines of
 * context, for `DeliverableStore.diff`.
 */
import type { DiffHunk, DiffLine } from '@nexgent/kernel'

/** Lines of context around each change. */
export const DIFF_CONTEXT = 3

/** Split text into lines; `\r\n` and `\n` both end a line, a final newline adds no empty line. */
export function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split(/\r?\n/)
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

type Op = DiffLine['op']

/** Max saved frontier cells (Int32) before the diff falls back to "replace the changed middle". */
const MYERS_BUDGET = 16_000_000

/** The edit script turning `a` into `b`, one entry per line. */
export function diffLines(a: readonly string[], b: readonly string[]): DiffLine[] {
  // Trim the common prefix and suffix first: the usual case (a few edited lines) then costs O(N).
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const middle = myers(a.slice(start, endA), b.slice(start, endB))
  return [
    ...a.slice(0, start).map(text => ({ op: 'context' as const, text })),
    ...middle,
    ...a.slice(endA).map(text => ({ op: 'context' as const, text })),
  ]
}

function myers(a: readonly string[], b: readonly string[]): DiffLine[] {
  const n = a.length
  const m = b.length
  if (n === 0) return b.map(text => ({ op: 'add', text }))
  if (m === 0) return a.map(text => ({ op: 'remove', text }))
  const max = n + m
  const offset = max
  let v = new Int32Array(2 * max + 2)
  const trace: Int32Array[] = []
  let found = false
  for (let d = 0; d <= max && !found; d++) {
    // Each saved frontier costs 2·(N+M) ints; past the budget, give up on minimality.
    if ((d + 1) * v.length > MYERS_BUDGET) return [...a.map(text => ({ op: 'remove' as const, text })), ...b.map(text => ({ op: 'add' as const, text }))]
    trace.push(v.slice())
    const next = v
    for (let k = -d; k <= d; k += 2) {
      let x: number
      if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) x = v[offset + k + 1]!
      else x = v[offset + k - 1]! + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      next[offset + k] = x
      if (x >= n && y >= m) {
        found = true
        break
      }
    }
    v = next
  }
  // Backtrack through the saved frontiers.
  const out: DiffLine[] = []
  let x = n
  let y = m
  for (let d = trace.length - 1; d >= 0; d--) {
    const frontier = trace[d]!
    const k = x - y
    let prevK: number
    if (k === -d || (k !== d && frontier[offset + k - 1]! < frontier[offset + k + 1]!)) prevK = k + 1
    else prevK = k - 1
    const prevX = frontier[offset + prevK]!
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      out.push({ op: 'context', text: a[x - 1]! })
      x--
      y--
    }
    if (d === 0) break
    if (x === prevX) out.push({ op: 'add', text: b[y - 1]! })
    else out.push({ op: 'remove', text: a[x - 1]! })
    x = prevX
    y = prevY
  }
  return out.reverse()
}

/** Group an edit script into unified-diff hunks (1-based starts; a zero-length side starts at the line before, as `diff -u` does). */
export function toHunks(script: readonly DiffLine[], context = DIFF_CONTEXT): DiffHunk[] {
  const changed: number[] = []
  script.forEach((line, index) => {
    if (line.op !== 'context') changed.push(index)
  })
  if (changed.length === 0) return []
  // Ranges of script indices, merged when their context would touch.
  const ranges: Array<[number, number]> = []
  for (const index of changed) {
    const from = Math.max(0, index - context)
    const to = Math.min(script.length - 1, index + context)
    const last = ranges[ranges.length - 1]
    if (last !== undefined && from <= last[1] + 1) last[1] = Math.max(last[1], to)
    else ranges.push([from, to])
  }
  // Line numbers before each script index.
  const fromBefore: number[] = []
  const toBefore: number[] = []
  let fromLine = 0
  let toLine = 0
  for (const line of script) {
    fromBefore.push(fromLine)
    toBefore.push(toLine)
    if (line.op !== 'add') fromLine++
    if (line.op !== 'remove') toLine++
  }
  return ranges.map(([from, to]) => {
    const lines = script.slice(from, to + 1)
    const fromLines = lines.filter(line => line.op !== 'add').length
    const toLines = lines.filter(line => line.op !== 'remove').length
    return {
      fromStart: fromLines === 0 ? fromBefore[from]! : fromBefore[from]! + 1,
      fromLines,
      toStart: toLines === 0 ? toBefore[from]! : toBefore[from]! + 1,
      toLines,
      lines,
    }
  })
}

/** Hunks between two texts. */
export function textHunks(before: string, after: string, context = DIFF_CONTEXT): DiffHunk[] {
  return toHunks(diffLines(splitLines(before), splitLines(after)), context)
}

/** Render hunks as unified-diff text (for tool results and logs). */
export function renderHunks(hunks: readonly DiffHunk[]): string {
  const prefix: Record<Op, string> = { context: ' ', add: '+', remove: '-' }
  return hunks
    .map(hunk => [
      `@@ -${hunk.fromStart},${hunk.fromLines} +${hunk.toStart},${hunk.toLines} @@`,
      ...hunk.lines.map(line => `${prefix[line.op]}${line.text}`),
    ].join('\n'))
    .join('\n')
}
