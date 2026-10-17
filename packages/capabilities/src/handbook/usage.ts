/**
 * How the handbook's entries are used, and retirement of the ones nobody
 * uses (`data-formats.md` §经验手册, “使用记录”). Like Codex memories
 * (`usage_count` / `last_usage`, dropped after `max_unused_days`), but an
 * entry is only retired for being idle when tasks did run in that time, so
 * a project left alone for months keeps its handbook.
 *
 * `usage.jsonl` sits next to `ops.jsonl` in each handbook directory. It is
 * bookkeeping, not part of the entries' history: a line per root turn the
 * handbook was asked for (`turn`) and a line per entry retrieval found for
 * it (`hit`, `given` when it was put in front of the model). “Used” is a
 * helpful vote in `ops.jsonl` (`handbook_mark` or the reflection). Lines are
 * small appends without the lock; a torn line is skipped.
 */
import { appendFile, mkdir, open, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { HandbookEntry, HandbookOp } from '@nexgent/kernel'
import { retryTransient } from '../fs-retry.js'

/** The usage file of a handbook directory. */
export const HANDBOOK_USAGE_FILE = 'usage.jsonl'

/** Days without being retrieved after which an entry is idle, by status. */
export const HANDBOOK_IDLE_DAYS = { active: 90, trial: 60 } as const

/** Root tasks that must have asked the handbook since an entry was last seen before it counts as idle. */
export const HANDBOOK_IDLE_MIN_TASKS = 10

/** A trial entry given to this many tasks without being used once is retired. */
export const HANDBOOK_UNUSED_GIVEN_LIMIT = 8

const DAY_MS = 24 * 60 * 60 * 1000

/** One line of `usage.jsonl`. */
export type HandbookUsageRecord =
  | { readonly formatVersion: 1; readonly kind: 'turn'; readonly at: string; readonly projectId: string; readonly sessionId: string }
  | { readonly formatVersion: 1; readonly kind: 'hit'; readonly at: string; readonly projectId: string; readonly sessionId: string; readonly entryId: string; readonly given: boolean }

type WithoutStamp<T> = T extends unknown ? Omit<T, 'formatVersion' | 'at'> : never

/** A record as a writer gives it: the log stamps `formatVersion` and `at`. */
export type HandbookUsageInput = WithoutStamp<HandbookUsageRecord>

/** One `usage.jsonl`. */
export class HandbookUsageLog {
  readonly directory: string
  readonly file: string
  readonly #now: () => Date
  #cache: { readonly size: number; readonly mtimeMs: number; readonly records: readonly HandbookUsageRecord[] } | undefined

  constructor(directory: string, options: { readonly now?: () => Date } = {}) {
    this.directory = directory
    this.file = join(directory, HANDBOOK_USAGE_FILE)
    this.#now = options.now ?? (() => new Date())
  }

  /** Every record in file order; a missing file is empty, a line that does not parse is skipped. */
  async read(): Promise<readonly HandbookUsageRecord[]> {
    let info
    try {
      info = await stat(this.file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    if (this.#cache !== undefined && this.#cache.size === info.size && this.#cache.mtimeMs === info.mtimeMs) return this.#cache.records
    const raw = await retryTransient(() => readFile(this.file, 'utf8'))
    const records: HandbookUsageRecord[] = []
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue
      try {
        const record = JSON.parse(line) as HandbookUsageRecord
        if (record !== null && typeof record === 'object' && (record.kind === 'turn' || record.kind === 'hit') && typeof record.at === 'string' && typeof record.sessionId === 'string') records.push(record)
      } catch {
        // A torn line.
      }
    }
    this.#cache = { size: Buffer.byteLength(raw), mtimeMs: info.mtimeMs, records }
    return records
  }

  async append(inputs: readonly HandbookUsageInput[]): Promise<void> {
    if (inputs.length === 0) return
    await mkdir(this.directory, { recursive: true })
    const at = this.#now().toISOString()
    const lead = (await endsTorn(this.file)) ? '\n' : ''
    await retryTransient(() => appendFile(this.file, lead + inputs.map(input => `${JSON.stringify({ formatVersion: 1, at, ...input })}\n`).join(''), 'utf8'))
  }
}

async function endsTorn(file: string): Promise<boolean> {
  const handle = await open(file, 'r').catch(() => undefined)
  if (handle === undefined) return false
  try {
    const { size } = await handle.stat()
    if (size === 0) return false
    const last = Buffer.alloc(1)
    await handle.read(last, 0, 1, size - 1)
    return last[0] !== 0x0a
  } finally {
    await handle.close()
  }
}

/** How one entry has been used. Times are ISO strings. */
export interface HandbookEntryUsage {
  /** Root tasks retrieval found it for. */
  readonly hits: number
  /** Root tasks it was given to. */
  readonly given: number
  readonly lastHitAt?: string
  readonly lastGivenAt?: string
  /** Helpful votes: the model or the reflection said it was used. */
  readonly used: number
  readonly lastUsedAt?: string
  /** Latest of: added, edited, used, brought back by the user, retrieved. Idleness counts from here. */
  readonly lastSeenAt: string
  /** Root tasks that asked the handbook after `lastSeenAt`. */
  readonly tasksSinceSeen: number
  /** Tasks it was given to since it was added, last used or brought back. */
  readonly givenSinceUsed: number
}

const later = (a: string | undefined, b: string | undefined): string | undefined => (a === undefined ? b : b === undefined || a >= b ? a : b)

/**
 * The usage of every entry (pure). `ops` is the entries' log; `records` the
 * same directory's usage file. Tasks are distinct root sessions.
 */
export function handbookUsage(entries: readonly HandbookEntry[], ops: readonly HandbookOp[], records: readonly HandbookUsageRecord[]): Map<string, HandbookEntryUsage> {
  const touched = new Map<string, { used: number; lastUsedAt?: string | undefined; lastResetAt?: string | undefined; lastEditAt?: string | undefined }>()
  for (const op of ops) {
    const mark = touched.get(op.entryId) ?? { used: 0 }
    if (op.op === 'upvote') {
      mark.used += 1
      mark.lastUsedAt = later(mark.lastUsedAt, op.at)
    } else if (op.op === 'edit') {
      mark.lastEditAt = later(mark.lastEditAt, op.at)
    } else if (op.op === 'status' && op.actor === 'user' && op.status !== 'retired') {
      mark.lastResetAt = later(mark.lastResetAt, op.at)
    }
    touched.set(op.entryId, mark)
  }
  const hitsOf = new Map<string, { at: string; given: boolean; sessionId: string }[]>()
  const turns: { at: string; sessionId: string }[] = []
  for (const record of records) {
    if (record.kind === 'turn') turns.push(record)
    else (hitsOf.get(record.entryId) ?? hitsOf.set(record.entryId, []).get(record.entryId)!).push(record)
  }
  const usage = new Map<string, HandbookEntryUsage>()
  for (const entry of entries) {
    const mark = touched.get(entry.id) ?? { used: 0 }
    const hits = hitsOf.get(entry.id) ?? []
    const hitTasks = new Set(hits.map(hit => hit.sessionId))
    const givenHits = hits.filter(hit => hit.given)
    const lastHitAt = hits.reduce<string | undefined>((at, hit) => later(at, hit.at), undefined)
    const lastGivenAt = givenHits.reduce<string | undefined>((at, hit) => later(at, hit.at), undefined)
    const quietSince = later(later(entry.createdAt, mark.lastUsedAt), mark.lastResetAt)!
    const lastSeenAt = later(later(quietSince, mark.lastEditAt), lastHitAt)!
    usage.set(entry.id, {
      hits: hitTasks.size,
      given: new Set(givenHits.map(hit => hit.sessionId)).size,
      ...(lastHitAt === undefined ? {} : { lastHitAt }),
      ...(lastGivenAt === undefined ? {} : { lastGivenAt }),
      used: mark.used,
      ...(mark.lastUsedAt === undefined ? {} : { lastUsedAt: mark.lastUsedAt }),
      lastSeenAt,
      tasksSinceSeen: new Set(turns.filter(turn => turn.at > lastSeenAt).map(turn => turn.sessionId)).size,
      givenSinceUsed: new Set(givenHits.filter(hit => hit.at > quietSince).map(hit => hit.sessionId)).size,
    })
  }
  return usage
}

/** Why an entry should be retired for not being used; `undefined` when it stays. */
export function idleReason(entry: Pick<HandbookEntry, 'status'>, usage: HandbookEntryUsage, now: Date): string | undefined {
  if (entry.status === 'retired') return undefined
  if (entry.status === 'trial' && usage.givenSinceUsed >= HANDBOOK_UNUSED_GIVEN_LIMIT) {
    return `unused: given to ${usage.givenSinceUsed} tasks, never marked helpful`
  }
  const days = Math.floor((now.getTime() - Date.parse(usage.lastSeenAt)) / DAY_MS)
  if (days >= HANDBOOK_IDLE_DAYS[entry.status] && usage.tasksSinceSeen >= HANDBOOK_IDLE_MIN_TASKS) {
    return `unused: not retrieved for ${days} days over ${usage.tasksSinceSeen} tasks`
  }
  return undefined
}
