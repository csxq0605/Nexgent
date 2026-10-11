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
  type SessionStartRecord,
  type SessionState,
  type SessionStore,
  type SessionTruncation,
  type WorkspaceLayout,
} from '@nexgent/kernel'
import { checkSequence, encodeLine, scanSessionLog } from './jsonl.js'
import { acquireLockFile, LOCK_FILE_NAME, releaseLockFile, type LockIdentity } from './lock.js'
import { DEFAULT_CHECKPOINT_EVERY, initialState, replay, SessionProjector, shouldCheckpoint } from './projection.js'
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
  /** Present when the file had an invalid tail. */
  readonly truncation?: SessionTruncation
  /** The turn closed with `turn.end { kind: 'interrupted' }` by this resume (lock holders only). */
  readonly interruptedTurn?: number
}

/** In-memory state of a session this store holds the lock for. */
interface Writer {
  readonly lock: SessionLock
  readonly handle: FileHandle
  /** Byte length of the valid file content; the next write position. */
  size: number
  lastSeq: number
  lastCheckpointSeq: number
  readonly projector: SessionProjector
  /** Invalid tail found at lock time; repaired before the next append. */
  pendingTruncation: SessionTruncation | undefined
  chain: Promise<unknown>
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
          projector: new SessionProjector(initialState(start)),
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
          lastSeq: scan.records.length,
          lastCheckpointSeq: lastCheckpoint?.seq ?? 0,
          projector,
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
    return scan.truncation === undefined
      ? { records: scan.records }
      : { records: scan.records, truncation: scan.truncation }
  }

  async latestCheckpoint(sessionId: string): Promise<CheckpointRecord | undefined> {
    const { records } = await this.readAll(sessionId)
    return findLastCheckpoint(records)
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
    const { records, truncation } = await this.readAll(sessionId)
    const loaded = startingPoint(records)
    const replayed = replay(loaded.state, records, loaded.from)
    let state = replayed.state
    let interruptedTurn: number | undefined
    const openTurn = state.metadata.openTurn
    const writer = this.writers.get(sessionId)
    if (openTurn !== undefined && writer !== undefined) {
      await this.append(sessionId, { type: 'turn.end', turn: openTurn, reason: { kind: 'interrupted' } })
      interruptedTurn = openTurn
      state = writer.projector.snapshot()
    }
    return {
      state,
      folded: replayed.folded,
      ...(loaded.checkpointSeq === undefined ? {} : { checkpointSeq: loaded.checkpointSeq }),
      ...(truncation === undefined ? {} : { truncation }),
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

  private async writeCheckpoint(writer: Writer): Promise<CheckpointRecord> {
    const state = writer.projector.snapshot()
    return (await this.writeRecord(writer, { type: 'checkpoint', coversSeq: writer.lastSeq, state })) as CheckpointRecord
  }

  private async writeRecord(writer: Writer, input: SessionRecordInput): Promise<SessionRecord> {
    const sessionId = writer.lock.sessionId
    const { type, ...rest } = input as SessionRecordInput & Partial<Record<'seq' | 'ts' | 'sessionId', unknown>>
    delete rest.seq
    delete rest.ts
    delete rest.sessionId
    const record = { type, seq: writer.lastSeq + 1, ts: this.now(), sessionId, ...rest } as SessionRecord
    assertSessionRecord(record)
    const violation = checkSequence(record, writer.lastSeq, sessionId)
    if (violation !== undefined) throw invalidRecord(violation)
    if (record.type === 'checkpoint' && !jsonEqual(record.state, writer.projector.snapshot())) {
      throw invalidRecord('checkpoint.state does not equal the projection of the records it covers')
    }
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
    if (record.type === 'checkpoint') writer.lastCheckpointSeq = record.seq
    return record
  }
}

/** Where resume starts: the latest checkpoint's state, or the state after `session.start`. */
function startingPoint(records: readonly SessionRecord[]): {
  state: SessionState
  from: number
  checkpointSeq?: number
} {
  for (let index = records.length - 1; index >= 1; index -= 1) {
    const record = records[index] as SessionRecord
    if (record.type === 'checkpoint') {
      const state: SessionState = { ...record.state, metadata: { ...record.state.metadata, lastSeq: record.seq } }
      return { state, from: index + 1, checkpointSeq: record.seq }
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
