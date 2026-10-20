/**
 * The per-session summary cache `sessions/<id>/summary.json`: what a session
 * list needs, so listing does not parse every session file in full.
 *
 * The store writes it after each `turn.end` and when it releases the lock;
 * a reader trusts it only while the session file still has the size and
 * mtime recorded in it, and otherwise rebuilds it from the file. The cache is
 * a derived file: it can be deleted at any time, and a failed write is ignored.
 */
import { randomUUID } from 'node:crypto'
import { readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Goal, MemberIdentity, SessionMetadata, SessionRecord, SessionState, ThreadOrigin } from '@nexgent/kernel'
import { scanSessionLog } from './jsonl.js'
import { projectSession } from './projection.js'

/** Base name of the cache file inside a session directory. */
export const SUMMARY_FILE_NAME = 'summary.json'

const SESSION_FILE = 'session.jsonl'
const SUMMARY_VERSION = 1

/** What a session list shows, apart from whether a turn is running right now. */
export interface SessionIndexEntry {
  readonly sessionId: string
  readonly title?: string
  /** The first prompt the user typed, trimmed, at most 200 characters. */
  readonly firstMessage?: string
  readonly createdAt: string
  /** `ts` of the last valid record. */
  readonly updatedAt: string
  readonly lastTurn: number
  /** The session counts as interrupted when nothing is running in it (the SDK knows whether that holds). */
  readonly interrupted: boolean
  readonly goal?: Goal
  readonly parentSessionId?: string
  readonly member?: MemberIdentity
  /** Coordinator step two: the session is a thread of this coordinator. */
  readonly thread?: ThreadOrigin
  /** `session.start.purpose` is `improvement`. */
  readonly improvement: boolean
}

/** Contents of `summary.json`. */
export interface SessionSummaryFile {
  readonly version: 1
  /** The session file this was built from. */
  readonly source: { readonly size: number; readonly mtimeMs: number; readonly lastSeq: number }
  readonly entry: SessionIndexEntry
}

/** Folds records into the facts of a {@link SessionIndexEntry} that the final state does not carry. */
export class SummaryFold {
  private createdAt: string | undefined
  private updatedAt: string | undefined
  private firstMessage: string | undefined
  private improvement = false
  private lastEnd: { turn: number; kind: string } | undefined

  apply(record: SessionRecord): void {
    this.updatedAt = record.ts
    if (record.type === 'session.start') {
      this.createdAt = record.ts
      this.improvement = record.purpose === 'improvement'
    } else if (record.type === 'turn.end') {
      this.lastEnd = { turn: record.turn, kind: record.reason.kind }
    } else if (
      this.firstMessage === undefined &&
      record.type === 'user.message' &&
      record.source === 'user' &&
      record.content.trim() !== ''
    ) {
      this.firstMessage = record.content.trim().slice(0, 200)
    }
  }

  /** The entry for the projection of everything applied so far. */
  entry(sessionId: string, meta: SessionMetadata): SessionIndexEntry {
    const interrupted =
      meta.openTurn !== undefined ||
      (this.lastEnd !== undefined && this.lastEnd.kind === 'interrupted' && this.lastEnd.turn === meta.lastTurn)
    return {
      sessionId,
      ...(meta.title === undefined ? {} : { title: meta.title }),
      ...(this.firstMessage === undefined ? {} : { firstMessage: this.firstMessage }),
      createdAt: this.createdAt ?? meta.createdAt,
      updatedAt: this.updatedAt ?? meta.createdAt,
      lastTurn: meta.lastTurn,
      interrupted,
      ...(meta.goal === undefined ? {} : { goal: meta.goal }),
      ...(meta.parentSessionId === undefined ? {} : { parentSessionId: meta.parentSessionId }),
      ...(meta.member === undefined ? {} : { member: meta.member }),
      ...(meta.thread === undefined ? {} : { thread: meta.thread }),
      improvement: this.improvement,
    }
  }
}

/** The entry of a whole record list (`records[0]` is `session.start`). */
export function summarizeSession(records: readonly SessionRecord[], state: SessionState = projectSession(records)): SessionIndexEntry {
  const fold = new SummaryFold()
  for (const record of records) fold.apply(record)
  return fold.entry(state.sessionId, state.metadata)
}

/**
 * Write the cache for a session whose file is at its final state for now.
 * Atomic (temp file plus rename); every failure is swallowed.
 */
export async function writeSessionSummary(sessionDir: string, entry: SessionIndexEntry, lastSeq: number): Promise<void> {
  const temp = join(sessionDir, `${SUMMARY_FILE_NAME}.${randomUUID()}.tmp`)
  try {
    const stats = await stat(join(sessionDir, SESSION_FILE))
    const file: SessionSummaryFile = { version: SUMMARY_VERSION, source: { size: stats.size, mtimeMs: stats.mtimeMs, lastSeq }, entry }
    await writeFile(temp, JSON.stringify(file), 'utf8')
    await rename(temp, join(sessionDir, SUMMARY_FILE_NAME))
  } catch {
    await unlink(temp).catch(() => {})
  }
}

/**
 * The list entry of a session: from `summary.json` while it matches the
 * session file's size and mtime, else from a full read (which then rewrites
 * the cache; `rewrite: false` leaves it alone).
 * @returns `undefined` when the session has no readable `session.start`.
 */
export async function readSessionSummary(
  sessionsDir: string,
  sessionId: string,
  options: { readonly rewrite?: boolean } = {},
): Promise<SessionIndexEntry | undefined> {
  const dir = join(sessionsDir, sessionId)
  const file = join(dir, SESSION_FILE)
  let before
  try {
    before = await stat(file)
  } catch {
    return undefined
  }
  try {
    const cached = JSON.parse(await readFile(join(dir, SUMMARY_FILE_NAME), 'utf8')) as Partial<SessionSummaryFile>
    if (
      cached.version === SUMMARY_VERSION &&
      cached.source?.size === before.size &&
      cached.source.mtimeMs === before.mtimeMs &&
      cached.entry?.sessionId === sessionId
    ) {
      return cached.entry
    }
  } catch {
    // missing or damaged cache: rebuild
  }
  const scan = scanSessionLog(await readFile(file), sessionId)
  if (scan.records.length === 0) return undefined
  const entry = summarizeSession(scan.records)
  // Only cache what was read from the unchanged file.
  const after = await stat(file).catch(() => undefined)
  if (options.rewrite !== false && after?.size === before.size && after.mtimeMs === before.mtimeMs) {
    await writeSessionSummary(dir, entry, scan.lastSeq)
  }
  return entry
}
