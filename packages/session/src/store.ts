/**
 * `JsonlSessionStore`: the `ctx.session` implementation over
 * `.nexgent/sessions/<id>/session.jsonl`.
 *
 * Normative text: `docs/spec/data-formats.md` §会话 JSONL v1 (append and
 * truncation rule, checkpoint, recovery algorithm, concurrent-write
 * protection). Contract: `packages/kernel/src/contracts/session.ts`.
 *
 * Durability: every line is written with one positioned `write` of the whole
 * line; by default every record is `fsync`ed (`fsync: 'always'`). With
 * `fsync: 'boundaries'` only `turn.end`, `checkpoint` and `error` records
 * (and the truncation repair) are synced, which the spec permits.
 *
 * Reading never deletes: a complete line that is not a valid record is skipped
 * and reported (`readAll().skipped`), and only a torn final line is cut by a
 * lock holder. New checkpoints are incremental (see `checkpoint.ts`).
 *
 * Design reference: deepseek-harness@46a7f68b
 * `session/session-persistence-jsonl` (per-handle mutation chain, torn-tail
 * truncation before the first new append, one writer per session id).
 */
import { mkdir, open, readFile, stat, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import {
  NexgentError,
  SESSION_FORMAT_VERSION,
  type CheckpointRecord,
  type SessionInit,
  type SessionLock,
  type SessionReadResult,
  type SessionRecord,
  type SessionRecordInput,
  type SessionSkippedLine,
  type SessionStartRecord,
  type SessionState,
  type SessionStore,
  type SessionTruncation,
  type WorkspaceLayout,
} from '@nexgent/kernel'
import { MAX_CHECKPOINT_CHAIN, resolveLatestCheckpoint } from './checkpoint.js'
import { checkSequence, encodeLine, scanSessionLog } from './jsonl.js'
import { acquireLockFile, LOCK_FILE_NAME, releaseLockFile, type LockIdentity } from './lock.js'
import { DEFAULT_CHECKPOINT_EVERY, foldRecord, initialState, replay, SessionProjector, shouldCheckpoint } from './projection.js'
import { SummaryFold, writeSessionSummary } from './summary.js'
import { jsonEqual } from './schema/evaluator.js'
import { assertSessionRecord } from './schema/session-schema.js'

/** File name of the session log inside its directory. */
export const SESSION_FILE_NAME = 'session.jsonl'

/** Which appends are `fsync`ed. */
export type SessionFsyncPolicy = 'always' | 'boundaries'

/** Options for {@link JsonlSessionStore}. Give `layout` or `sessionsDir`. */
export interface JsonlSessionStoreOptions extends LockIdentity {
  /** Workspace layout; sessions live in `layout.sessions`. */
  readonly layout?: WorkspaceLayout
  /** Absolute sessions directory; overrides `layout`. */
  readonly sessionsDir?: string
  /** Checkpoint threshold N (records since the last checkpoint); default 50. */
  readonly checkpointEvery?: number
  /** Write a checkpoint on `release`/`close` when records were written since the last one; default true. */
  readonly checkpointOnRelease?: boolean
  /** Default `'always'`. */
  readonly fsync?: SessionFsyncPolicy
}

/** What {@link JsonlSessionStore.resumeDetailed} reports besides the state. */
export interface ResumeResult {
  readonly state: SessionState
  /** Records folded after the starting point (the latest checkpoint, or `session.start`). */
  readonly folded: number
  /** `seq` of the checkpoint resume started from, when there was one. */
  readonly checkpointSeq?: number
  /** Present when the file had a torn final line. */
  readonly truncation?: SessionTruncation
  /** Complete lines that were skipped (unknown or damaged records); absent when none. */
  readonly skipped?: readonly SessionSkippedLine[]
  /** `tool.result` records this resume wrote for calls the dead process never answered (lock holders only). */
  readonly interruptedToolCalls?: number
  /** The turn closed with `turn.end { kind: 'interrupted' }` by this resume (lock holders only). */
  readonly interruptedTurn?: number
}

/** In-memory state of a session this store holds the lock for. */
interface Writer {
  readonly lock: SessionLock
  readonly handle: FileHandle
  /** Byte length of the valid file content; the next write position. */
  size: number
  /** Highest `seq` in the file (valid or skipped); the next record is `lastSeq + 1`. */
  lastSeq: number
  lastCheckpointSeq: number
  /** The latest usable checkpoint a new one can build on; absent after a compaction or when there is none. */
  checkpointBase: CheckpointBase | undefined
  readonly projector: SessionProjector
  /** Facts for the summary cache. */
  readonly summary: SummaryFold
  /** Records were written since the summary cache was last written. */
  summaryStale: boolean
  /** Invalid tail found at lock time; repaired before the next append. */
  pendingTruncation: SessionTruncation | undefined
  chain: Promise<unknown>
}

/** What an incremental checkpoint needs from the one before it. */
interface CheckpointBase {
  readonly seq: number
  /** Messages in the full state it stood for. */
  readonly count: number
  /** Incremental links behind it. */
  readonly depth: number
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** The JSONL v1 session store. */
export class JsonlSessionStore implements SessionStore {
  /** Absolute sessions directory. */
  readonly sessionsDir: string
  private readonly checkpointEvery: number
  private readonly checkpointOnRelease: boolean
  private readonly fsyncPolicy: SessionFsyncPolicy
  private readonly identity: LockIdentity
  private readonly writers = new Map<string, Writer>()
  /** Session ids with a `create`/`lock` in flight, so a concurrent second call fails fast. */
  private readonly opening = new Set<string>()

  constructor(options: JsonlSessionStoreOptions) {
    const dir = options.sessionsDir ?? options.layout?.sessions
    if (dir === undefined) throw new TypeError('JsonlSessionStore needs `layout` or `sessionsDir`')
    this.sessionsDir = dir
    this.checkpointEvery = options.checkpointEvery ?? DEFAULT_CHECKPOINT_EVERY
    if (!Number.isSafeInteger(this.checkpointEvery) || this.checkpointEvery < 1) {
      throw new RangeError('checkpointEvery must be a positive integer')
    }
    this.checkpointOnRelease = options.checkpointOnRelease ?? true
    this.fsyncPolicy = options.fsync ?? 'always'
    const identity: { -readonly [K in keyof LockIdentity]: LockIdentity[K] } = {}
    if (options.pid !== undefined) identity.pid = options.pid
    if (options.host !== undefined) identity.host = options.host
    if (options.isAlive !== undefined) identity.isAlive = options.isAlive
    if (options.now !== undefined) identity.now = options.now
    if (options.startTimeOf !== undefined) identity.startTimeOf = options.startTimeOf
    this.identity = identity
  }

  /** `<sessionsDir>/<id>`. @throws `session/invalid-record` for an id that is not a safe path segment. */
  sessionDir(sessionId: string): string {
    if (!SESSION_ID_PATTERN.test(sessionId) || sessionId.length > 128) {
      throw new NexgentError('session/invalid-record', `invalid session id: ${JSON.stringify(sessionId)}`)
    }
    return join(this.sessionsDir, sessionId)
  }

  /** `<sessionsDir>/<id>/session.jsonl`. */
  sessionFile(sessionId: string): string {
    return join(this.sessionDir(sessionId), SESSION_FILE_NAME)
  }

  /** `<sessionsDir>/<id>/.lock`. */
  lockFile(sessionId: string): string {
    return join(this.sessionDir(sessionId), LOCK_FILE_NAME)
  }

  /** Whether this store currently holds the lock of `sessionId`. */
  holds(sessionId: string): boolean {
    return this.writers.has(sessionId)
  }

  async create(init: SessionInit): Promise<SessionLock> {
    const { sessionId } = init
    if ((init.member === undefined) !== (init.parentSessionId === undefined)) {
      throw new NexgentError('session/invalid-record', 'a child session needs both parentSessionId and member')
    }
    if ((init.purpose === 'improvement') !== (init.improvement !== undefined)) {
      throw new NexgentError('session/invalid-record', 'an improvement session needs both purpose "improvement" and improvement')
    }
    const dir = this.sessionDir(sessionId)
    const file = this.sessionFile(sessionId)
    this.beginOpening(sessionId)
    try {
      if (await exists(file)) throw existsError(sessionId)
      await mkdir(dir, { recursive: true })
      const lock = await this.takeLock(sessionId)
      let handle: FileHandle | undefined
      try {
        try {
          handle = await open(file, 'wx+')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw existsError(sessionId)
          throw error
        }
        const start: SessionStartRecord = {
          type: 'session.start',
          seq: 1,
          ts: this.now(),
          sessionId,
          version: SESSION_FORMAT_VERSION,
          projectRoot: init.projectRoot,
          model: init.model,
          sandboxMode: init.sandboxMode,
          ...(init.parentSessionId === undefined ? {} : { parentSessionId: init.parentSessionId }),
          ...(init.title === undefined ? {} : { title: init.title }),
          ...(init.member === undefined ? {} : { member: init.member }),
          ...(init.capabilityVersion === undefined ? {} : { capabilityVersion: init.capabilityVersion }),
          ...(init.purpose === undefined ? {} : { purpose: init.purpose }),
          ...(init.improvement === undefined ? {} : { improvement: init.improvement }),
        }
        assertSessionRecord(start)
        const bytes = Buffer.from(encodeLine(start), 'utf8')
        await writeFully(handle, bytes, 0)
        await handle.sync()
        await syncDirectory(dir)
        this.writers.set(sessionId, {
          lock,
          handle,
          size: bytes.length,
          lastSeq: 1,
          lastCheckpointSeq: 0,
          checkpointBase: undefined,
          projector: new SessionProjector(initialState(start)),
          summary: foldSummary([start]),
          summaryStale: true,
          pendingTruncation: undefined,
          chain: Promise.resolve(),
        })
        return lock
      } catch (error) {
        await handle?.close().catch(() => {})
        await releaseLockFile(lock.path, lock.info).catch(() => {})
        throw error
      }
    } finally {
      this.opening.delete(sessionId)
    }
  }

  async lock(sessionId: string): Promise<SessionLock> {
    const file = this.sessionFile(sessionId)
    this.beginOpening(sessionId)
    try {
      if (!(await exists(file))) throw notFoundError(sessionId)
      const lock = await this.takeLock(sessionId)
      let handle: FileHandle | undefined
      try {
        handle = await open(file, 'r+')
        const scan = scanSessionLog(await handle.readFile(), sessionId)
        const start = scan.records[0]
        if (start?.type !== 'session.start') throw corruptError(sessionId, scan.truncation)
        const loaded = startingPoint(scan.records)
        const projector = new SessionProjector(replay(loaded.state, scan.records, loaded.from).state)
        const lastCheckpoint = findLastCheckpoint(scan.records)
        this.writers.set(sessionId, {
          lock,
          handle,
          size: scan.validBytes,
          lastSeq: scan.lastSeq,
          lastCheckpointSeq: lastCheckpoint?.seq ?? 0,
          checkpointBase: loaded.base,
          projector,
          summary: foldSummary(scan.records),
          summaryStale: false,
          pendingTruncation: scan.truncation,
          chain: Promise.resolve(),
        })
        return lock
      } catch (error) {
        await handle?.close().catch(() => {})
        await releaseLockFile(lock.path, lock.info).catch(() => {})
        throw error
      }
    } finally {
      this.opening.delete(sessionId)
    }
  }

  async append(sessionId: string, record: SessionRecordInput): Promise<SessionRecord> {
    const writer = this.requireWriter(sessionId)
    return this.enqueue(writer, async () => {
      await this.repairTail(writer)
      const written = await this.writeRecord(writer, record)
      if (shouldCheckpoint(written, writer.lastCheckpointSeq, this.checkpointEvery)) {
        await this.writeCheckpoint(writer)
      }
      if (written.type === 'turn.end') await this.writeSummary(writer)
      return written
    })
  }

  /**
   * Write a checkpoint now when records were written since the last one.
   * Requires the lock.
   * @returns the checkpoint written, or `undefined` when the latest record already is one.
   */
  async checkpoint(sessionId: string): Promise<CheckpointRecord | undefined> {
    const writer = this.requireWriter(sessionId)
    return this.enqueue(writer, async () => {
      if (writer.lastSeq === writer.lastCheckpointSeq) return undefined
      await this.repairTail(writer)
      return this.writeCheckpoint(writer)
    })
  }

  async readAll(sessionId: string): Promise<SessionReadResult> {
    const writer = this.writers.get(sessionId)
    if (writer !== undefined) await writer.chain.catch(() => {})
    const scan = await this.scan(sessionId)
    return {
      records: scan.records,
      ...(scan.skipped.length === 0 ? {} : { skipped: scan.skipped }),
      ...(scan.truncation === undefined ? {} : { truncation: scan.truncation }),
    }
  }

  /**
   * The latest usable checkpoint with its complete state (an incremental one
   * is returned resolved: no `base`/`keep`, all messages).
   */
  async latestCheckpoint(sessionId: string): Promise<CheckpointRecord | undefined> {
    const { records } = await this.readAll(sessionId)
    const resolved = resolveLatestCheckpoint(records)
    if (resolved === undefined) return undefined
    const { base: _base, keep: _keep, ...rest } = resolved.record
    return { ...rest, state: resolved.state }
  }

  async resume(sessionId: string): Promise<SessionState> {
    return (await this.resumeDetailed(sessionId)).state
  }

  /**
   * The spec's recovery algorithm, with its bookkeeping exposed: read every
   * valid record, start from the latest checkpoint (or `session.start`), fold
   * only the records after it, and — when this store holds the lock and a turn
   * was left open by a dead process — append `turn.end { kind: 'interrupted' }`
   * (preceded by the truncation `error` record when the tail was repaired).
   * Without the lock the open turn is kept in `metadata.openTurn`.
   *
   * Call it at startup, not in the middle of a turn this process is running:
   * a lock holder's open turn is always treated as interrupted.
   */
  async resumeDetailed(sessionId: string): Promise<ResumeResult> {
    const { records, truncation, skipped } = await this.readAll(sessionId)
    const loaded = startingPoint(records)
    const replayed = replay(loaded.state, records, loaded.from)
    let state = replayed.state
    let interruptedTurn: number | undefined
    const openTurn = state.metadata.openTurn
    const writer = this.writers.get(sessionId)
    let interruptedToolCalls = 0
    if (openTurn !== undefined && writer !== undefined) {
      // Tell the truth about calls the dead process never answered, before closing the turn.
      for (const call of unansweredToolCalls(records, openTurn)) {
        await this.append(sessionId, {
          type: 'tool.result',
          turn: openTurn,
          step: call.step,
          toolCallId: call.id,
          name: call.name,
          content: 'Error: the call was interrupted before it returned a result.',
          isError: true,
          error: { name: 'NexgentError', code: 'tool/aborted', message: 'interrupted before it returned a result' },
          durationMs: 0,
        })
        interruptedToolCalls += 1
      }
      await this.append(sessionId, { type: 'turn.end', turn: openTurn, reason: { kind: 'interrupted' } })
      interruptedTurn = openTurn
      state = writer.projector.snapshot()
    }
    return {
      state,
      folded: replayed.folded,
      ...(loaded.checkpointSeq === undefined ? {} : { checkpointSeq: loaded.checkpointSeq }),
      ...(truncation === undefined ? {} : { truncation }),
      ...(skipped === undefined ? {} : { skipped }),
      ...(interruptedToolCalls === 0 ? {} : { interruptedToolCalls }),
      ...(interruptedTurn === undefined ? {} : { interruptedTurn }),
    }
  }

  async release(lock: SessionLock): Promise<void> {
    const writer = this.writers.get(lock.sessionId)
    if (writer !== undefined && sameLock(writer.lock, lock)) {
      try {
        await writer.chain.catch(() => {})
        // Nothing to snapshot for a session that only has its session.start.
        const fresh = writer.lastSeq > Math.max(writer.lastCheckpointSeq, 1)
        if (this.checkpointOnRelease && fresh && writer.pendingTruncation === undefined) {
          await this.enqueue(writer, () => this.writeCheckpoint(writer)).catch(() => {})
        }
        if (writer.summaryStale) await this.writeSummary(writer)
      } finally {
        this.writers.delete(lock.sessionId)
        await writer.handle.close().catch(() => {})
      }
    }
    await releaseLockFile(lock.path, lock.info)
  }

  /** Release every lock this store holds (writing closing checkpoints per policy). */
  async close(): Promise<void> {
    await Promise.all([...this.writers.values()].map(writer => this.release(writer.lock)))
  }

  // -------------------------------------------------------------------------

  private now(): string {
    return (this.identity.now?.() ?? new Date()).toISOString()
  }

  private beginOpening(sessionId: string): void {
    if (this.writers.has(sessionId) || this.opening.has(sessionId)) {
      throw new NexgentError('session/locked', `session ${sessionId} is already locked by this store`, {
        details: { sessionId, pid: this.identity.pid ?? process.pid },
      })
    }
    this.opening.add(sessionId)
  }

  private async takeLock(sessionId: string): Promise<SessionLock> {
    const path = this.lockFile(sessionId)
    const info = await acquireLockFile(path, sessionId, this.identity)
    return { sessionId, path, info }
  }

  private requireWriter(sessionId: string): Writer {
    const writer = this.writers.get(sessionId)
    if (writer === undefined) {
      throw new NexgentError('session/locked', `append to session ${sessionId} requires its lock`, {
        details: { sessionId },
      })
    }
    return writer
  }

  private enqueue<T>(writer: Writer, task: () => Promise<T>): Promise<T> {
    const result = writer.chain.catch(() => {}).then(task)
    writer.chain = result
    return result
  }

  private async scan(sessionId: string) {
    let data: Buffer
    try {
      data = await readFile(this.sessionFile(sessionId))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw notFoundError(sessionId)
      throw error
    }
    const scan = scanSessionLog(data, sessionId)
    if (scan.records.length === 0) throw corruptError(sessionId, scan.truncation)
    return scan
  }

  /** Spec §截断: cut the invalid tail, then record the loss as an `error` record. */
  private async repairTail(writer: Writer): Promise<void> {
    const truncation = writer.pendingTruncation
    if (truncation === undefined) return
    await writer.handle.truncate(truncation.byteOffset)
    await writer.handle.sync()
    writer.size = truncation.byteOffset
    writer.pendingTruncation = undefined
    await this.writeRecord(writer, {
      type: 'error',
      error: {
        name: 'NexgentError',
        code: 'session/corrupt',
        message: `discarded the invalid tail from line ${truncation.line} (byte ${truncation.byteOffset}): ${truncation.reason}`,
        details: { line: truncation.line, byteOffset: truncation.byteOffset, reason: truncation.reason },
      },
      fatal: false,
    })
  }

  /** Refresh `summary.json` (a derived cache; failures are ignored). */
  private async writeSummary(writer: Writer): Promise<void> {
    await writeSessionSummary(this.sessionDir(writer.lock.sessionId), writer.summary.entry(writer.lock.sessionId, writer.projector.metadata()), writer.lastSeq)
    writer.summaryStale = false
  }

  private async writeCheckpoint(writer: Writer): Promise<CheckpointRecord> {
    const state = writer.projector.snapshot()
    // Written as a full state; `writeRecord` stores it incrementally when it can.
    return (await this.writeRecord(writer, { type: 'checkpoint', coversSeq: writer.lastSeq, state })) as CheckpointRecord
  }

  private async writeRecord(writer: Writer, input: SessionRecordInput): Promise<SessionRecord> {
    const sessionId = writer.lock.sessionId
    const { type, ...rest } = input as SessionRecordInput & Partial<Record<'seq' | 'ts' | 'sessionId', unknown>>
    delete rest.seq
    delete rest.ts
    delete rest.sessionId
    // Skipped lines can leave `lastSeq` ahead of the projection's `lastSeq`; the checkpoint covers up to `lastSeq`.
    if (type === 'checkpoint' && (rest as { coversSeq?: unknown }).coversSeq === writer.projector.lastSeq) {
      ;(rest as { coversSeq?: number }).coversSeq = writer.lastSeq
    }
    let record = { type, seq: writer.lastSeq + 1, ts: this.now(), sessionId, ...rest } as SessionRecord
    assertSessionRecord(record)
    const violation = checkSequence(record, writer.lastSeq, sessionId)
    if (violation !== undefined) throw invalidRecord(violation)
    let nextBase: CheckpointBase | undefined
    if (record.type === 'checkpoint') {
      const snapshot = writer.projector.snapshot()
      record = this.incremental(writer, record, snapshot)
      nextBase = {
        seq: record.seq,
        count: snapshot.messages.length,
        depth: record.type === 'checkpoint' && record.base !== undefined ? (writer.checkpointBase?.depth ?? 0) + 1 : 0,
      }
    }
    // Records whose projection can fail are folded into a copy first, so a bad one never reaches the file.
    if (record.type === 'goal.update' || record.type === 'compaction') foldRecord(writer.projector.snapshot(), record)
    const bytes = Buffer.from(encodeLine(record), 'utf8')
    try {
      await writeFully(writer.handle, bytes, writer.size)
      if (this.fsyncPolicy === 'always' || isBoundary(record)) await writer.handle.sync()
    } catch (error) {
      // Undo a partial line so the file keeps ending at a record boundary.
      await writer.handle.truncate(writer.size).catch(() => {})
      throw error
    }
    writer.size += bytes.length
    writer.lastSeq = record.seq
    writer.projector.apply(record)
    writer.summary.apply(record)
    writer.summaryStale = true
    if (record.type === 'checkpoint') {
      writer.lastCheckpointSeq = record.seq
      writer.checkpointBase = nextBase
    } else if (record.type === 'compaction' || record.type === 'fork.seed') {
      // The messages are rewritten: the next checkpoint is a full one.
      writer.checkpointBase = undefined
    }
    return record
  }

  /**
   * Check a checkpoint against the projection and return it in the form to
   * store: a full one is rewritten as an incremental one on the latest usable
   * checkpoint when it can be (messages not rewritten since, chain not too
   * long, something to share).
   */
  private incremental(writer: Writer, record: CheckpointRecord, snapshot: SessionState): CheckpointRecord {
    const base = writer.checkpointBase
    if (record.base === undefined) {
      if (!jsonEqual(record.state, snapshot)) {
        throw invalidRecord('checkpoint.state does not equal the projection of the records it covers')
      }
      if (base === undefined || base.count === 0 || base.depth >= MAX_CHECKPOINT_CHAIN) return record
      return { ...record, base: base.seq, keep: base.count, state: { ...snapshot, messages: snapshot.messages.slice(base.count) } }
    }
    const keep = record.keep ?? 0
    if (base === undefined || record.base !== base.seq || keep > base.count) {
      throw invalidRecord('checkpoint.base is not the latest usable checkpoint')
    }
    const full = { ...record.state, messages: [...snapshot.messages.slice(0, keep), ...record.state.messages] }
    if (!jsonEqual(full, snapshot)) {
      throw invalidRecord('checkpoint.state does not equal the projection of the records it covers')
    }
    return record
  }
}

/** Where resume starts: the latest checkpoint's state, or the state after `session.start`. */
function startingPoint(records: readonly SessionRecord[]): {
  state: SessionState
  from: number
  checkpointSeq?: number
  /** What the next checkpoint can build on (absent when a compaction or fork seed came after the checkpoint). */
  base?: CheckpointBase | undefined
} {
  const resolved = resolveLatestCheckpoint(records)
  if (resolved !== undefined) {
    const { record } = resolved
    const state: SessionState = { ...resolved.state, metadata: { ...resolved.state.metadata, lastSeq: record.seq } }
    const rewritten = records.slice(resolved.index + 1).some(later => later.type === 'compaction' || later.type === 'fork.seed')
    return {
      state,
      from: resolved.index + 1,
      checkpointSeq: record.seq,
      base: rewritten ? undefined : { seq: record.seq, count: resolved.state.messages.length, depth: resolved.depth },
    }
  }
  const start = records[0]
  if (start?.type !== 'session.start') throw new NexgentError('session/corrupt', 'session has no session.start record')
  return { state: initialState(start), from: 1 }
}

function findLastCheckpoint(records: readonly SessionRecord[]): CheckpointRecord | undefined {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index] as SessionRecord
    if (record.type === 'checkpoint') return record
  }
  return undefined
}

function foldSummary(records: readonly SessionRecord[]): SummaryFold {
  const fold = new SummaryFold()
  for (const record of records) fold.apply(record)
  return fold
}

/** Tool calls of the open `turn` that no `tool.result` answers, in call order. */
function unansweredToolCalls(records: readonly SessionRecord[], turn: number): { id: string; name: string; step: number }[] {
  const answered = new Set<string>()
  const calls: { id: string; name: string; step: number }[] = []
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index] as SessionRecord
    if (record.type === 'turn.start' && record.turn === turn) break
    if (record.type === 'tool.result' && record.turn === turn) answered.add(record.toolCallId)
    else if (record.type === 'assistant.message' && record.turn === turn) {
      calls.unshift(...(record.toolCalls ?? []).map(call => ({ id: call.id, name: call.name, step: record.step })))
    }
  }
  return calls.filter(call => !answered.has(call.id))
}

function isBoundary(record: SessionRecord): boolean {
  return record.type === 'turn.end' || record.type === 'checkpoint' || record.type === 'error'
}

function sameLock(a: SessionLock, b: SessionLock): boolean {
  return a.path === b.path && a.info.pid === b.info.pid && a.info.ts === b.info.ts && a.info.host === b.info.host
}

async function writeFully(handle: FileHandle, bytes: Buffer, position: number): Promise<void> {
  let written = 0
  while (written < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, written, bytes.length - written, position + written)
    if (bytesWritten === 0) throw new Error('write made no progress')
    written += bytesWritten
  }
}

/** Make a new directory entry durable (POSIX); a no-op on Windows, where directories cannot be fsynced. */
async function syncDirectory(dir: string): Promise<void> {
  if (process.platform === 'win32') return
  const handle = await open(dir, 'r')
  try {
    await handle.sync()
  } catch {
    // Some filesystems refuse fsync on directories; the file itself is synced.
  } finally {
    await handle.close()
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function existsError(sessionId: string): NexgentError {
  return new NexgentError('session/exists', `session ${sessionId} already exists`, { details: { sessionId } })
}

function notFoundError(sessionId: string): NexgentError {
  return new NexgentError('session/not-found', `session ${sessionId} does not exist`, { details: { sessionId } })
}

function corruptError(sessionId: string, truncation: SessionTruncation | undefined): NexgentError {
  return new NexgentError('session/corrupt', `session ${sessionId} has no readable session.start record`, {
    details: truncation === undefined ? { sessionId } : { sessionId, ...truncation },
  })
}

function invalidRecord(reason: string): NexgentError {
  return new NexgentError('session/invalid-record', `invalid session record: ${reason}`)
}
