/**
 * Rework K4 D4: line-based three-way merge (diff3) of text files, for
 * merging a member's copy of the project back. Changes of the two sides
 * that touch the same or adjacent base lines count as a conflict, as in
 * `git merge-file`, unless both sides made the same change.
 */
import { diffLines } from './diff.js'

/** One change of a side against the base: base lines `[start, end)` replaced by `lines`. */
interface Hunk {
  readonly start: number
  readonly end: number
  readonly lines: readonly string[]
}

/** Split keeping each line's terminator, so the merge gives back the exact bytes. */
function splitKeep(text: string): string[] {
  if (text === '') return []
  return text.split(/(?<=\n)/)
}

function hunks(base: readonly string[], side: readonly string[]): Hunk[] {
  const out: Hunk[] = []
  let index = 0
  let open: { start: number; lines: string[] } | undefined
  const close = () => {
    if (open !== undefined) out.push({ start: open.start, end: index, lines: open.lines })
    open = undefined
  }
  for (const line of diffLines(base, side)) {
    if (line.op === 'context') {
      close()
      index += 1
      continue
    }
    open ??= { start: index, lines: [] }
    if (line.op === 'remove') index += 1
    else open.lines.push(line.text)
  }
  close()
  return out
}

/** The side's text of base lines `[start, end)`, given its hunks that lie inside. */
function sideText(base: readonly string[], start: number, end: number, own: readonly Hunk[]): string[] {
  const out: string[] = []
  let index = start
  for (const hunk of own) {
    out.push(...base.slice(index, hunk.start), ...hunk.lines)
    index = hunk.end
  }
  out.push(...base.slice(index, end))
  return out
}

/**
 * Merge `ours` and `theirs`, both derived from `base`. Returns the merged
 * text, or `undefined` when the changes overlap.
 */
export function mergeText(base: string, ours: string, theirs: string): string | undefined {
  if (ours === theirs) return ours
  if (ours === base) return theirs
  if (theirs === base) return ours
  const lines = splitKeep(base)
  const tagged = [
    ...hunks(lines, splitKeep(ours)).map(hunk => ({ hunk, side: 0 })),
    ...hunks(lines, splitKeep(theirs)).map(hunk => ({ hunk, side: 1 })),
  ].sort((a, b) => a.hunk.start - b.hunk.start || a.hunk.end - b.hunk.end)
  const out: string[] = []
  let index = 0
  let i = 0
  while (i < tagged.length) {
    // A group: hunks whose base ranges overlap or touch, transitively.
    const group = [tagged[i]!]
    let start = tagged[i]!.hunk.start
    let end = tagged[i]!.hunk.end
    i += 1
    while (i < tagged.length && tagged[i]!.hunk.start <= end) {
      group.push(tagged[i]!)
      end = Math.max(end, tagged[i]!.hunk.end)
      i += 1
    }
    start = Math.min(start, ...group.map(entry => entry.hunk.start))
    out.push(...lines.slice(index, start))
    const ourHunks = group.filter(entry => entry.side === 0).map(entry => entry.hunk)
    const theirHunks = group.filter(entry => entry.side === 1).map(entry => entry.hunk)
    if (ourHunks.length === 0) out.push(...sideText(lines, start, end, theirHunks))
    else if (theirHunks.length === 0) out.push(...sideText(lines, start, end, ourHunks))
    else {
      const a = sideText(lines, start, end, ourHunks)
      const b = sideText(lines, start, end, theirHunks)
      if (a.length !== b.length || a.some((line, k) => line !== b[k])) return undefined
      out.push(...a)
    }
    index = end
  }
  out.push(...lines.slice(index))
  return out.join('')
}
