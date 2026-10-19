/**
 * One handbook operation log (`data-formats.md` §经验手册): `ops.jsonl` in
 * the user-level `<NEXGENT_HOME>/handbook/` or a project's
 * `<NEXGENT_HOME>/projects/<projectId>/handbook/`. JSON Lines, append only,
 * `seq` from 1 without gaps. Appends from several processes (two projects
 * open at once share the user log) take `ops.lock`, a file created
 * exclusively that names the writing process; a lock whose process is gone
 * is broken.
 */
import { appendFile, mkdir, open, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  foldHandbook,
  HANDBOOK_ACTORS,
  HANDBOOK_ENTRY_STATUSES,
  HANDBOOK_LIMITS,
  HANDBOOK_OP_KINDS,
  HANDBOOK_SCOPES,
  NexgentError,
  type HandbookEntry,
  type HandbookOp,
} from '@nexgent/kernel'
import { retryTransient } from '../fs-retry.js'

/** The log file of a handbook directory. */
export const HANDBOOK_LOG_FILE = 'ops.jsonl'
/** The append lock of a handbook directory. */
export const HANDBOOK_LOCK_FILE = 'ops.lock'

type WithoutStamp<T> = T extends unknown ? Omit<T, 'formatVersion' | 'seq' | 'at'> : never

/** An operation as a writer gives it: the log stamps `formatVersion`, `seq` and `at`. */
export type HandbookOpInput = WithoutStamp<HandbookOp>

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function invalid(message: string): never {
  throw new NexgentError('tool/invalid-input', `handbook: ${message}`)
}

function checkText(text: unknown, field: string): void {
  if (typeof text !== 'string' || text.trim() === '') invalid(`${field} must be non-empty text`)
  if ([...text].length > HANDBOOK_LIMITS.maxTextChars) invalid(`${field} is longer than ${HANDBOOK_LIMITS.maxTextChars} characters`)
}

function checkKeywords(keywords: unknown): void {
  if (!Array.isArray(keywords)) invalid('keywords must be a list')
  if (keywords.length > HANDBOOK_LIMITS.maxKeywords) invalid(`at most ${HANDBOOK_LIMITS.maxKeywords} keywords`)
  for (const keyword of keywords) {
    if (typeof keyword !== 'string' || keyword === '' || keyword !== keyword.toLowerCase() || keyword.length > HANDBOOK_LIMITS.maxKeywordChars) {
      invalid(`keyword ${JSON.stringify(keyword)} must be lowercase, 1–${HANDBOOK_LIMITS.maxKeywordChars} characters`)
    }
  }
}

/**
 * Validate an operation before it is written (shape and `HANDBOOK_LIMITS`).
 * @throws `tool/invalid-input`.
 */
export function checkHandbookOp(op: HandbookOpInput): void {
  if (!HANDBOOK_OP_KINDS.includes(op.op)) invalid(`unknown operation ${JSON.stringify(op.op)}`)
  if (typeof op.entryId !== 'string' || !UUID_V4.test(op.entryId)) invalid('entryId must be a lowercase uuid v4')
  if (!HANDBOOK_ACTORS.includes(op.actor)) invalid(`unknown actor ${JSON.stringify(op.actor)}`)
  if (op.reason !== undefined && (typeof op.reason !== 'string' || [...op.reason].length > HANDBOOK_LIMITS.maxReasonChars)) invalid(`reason is longer than ${HANDBOOK_LIMITS.maxReasonChars} characters`)
  if (op.source !== undefined && (typeof op.source.taskId !== 'string' || op.source.taskId === '')) invalid('source.taskId must be non-empty')
  switch (op.op) {
    case 'add':
      checkText(op.text, 'text')
      checkKeywords(op.keywords)
      if (!HANDBOOK_SCOPES.includes(op.scope)) invalid(`unknown scope ${JSON.stringify(op.scope)}`)
      if (op.scope === 'project' && (op.projectId === undefined || op.projectId === '')) invalid('a project entry needs projectId')
      if (op.status !== undefined && op.status !== 'trial' && op.status !== 'active') invalid('a new entry starts as trial or active')
      for (const id of op.supersedes ?? []) if (!UUID_V4.test(id)) invalid('supersedes must list entry ids')
      break
    case 'edit':
      if (op.text === undefined && op.keywords === undefined) invalid('an edit changes text or keywords')
      if (op.text !== undefined) checkText(op.text, 'text')
      if (op.keywords !== undefined) checkKeywords(op.keywords)
      break
    case 'status':
      if (!HANDBOOK_ENTRY_STATUSES.includes(op.status)) invalid(`unknown status ${JSON.stringify(op.status)}`)
      break
  }
}

/** The lowercase keywords of a writer's list: trimmed, deduplicated, cut to the limits. */
export function normalizeKeywords(keywords: readonly string[]): string[] {
  const out: string[] = []
  for (const raw of keywords) {
    const keyword = raw.trim().toLowerCase().slice(0, HANDBOOK_LIMITS.maxKeywordChars)
    if (keyword !== '' && !out.includes(keyword)) out.push(keyword)
    if (out.length === HANDBOOK_LIMITS.maxKeywords) break
  }
  return out
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Waits between attempts to take the lock (about 10 s in all). */
const LOCK_DELAYS_MS = [5, 10, 20, 40, 80, 160, 250, 250, 250, 250, 500, 500, 500, 500, 1000, 1000, 1000, 1000, 1000, 1000, 1000]

/** One `ops.jsonl` and its lock. */
export class HandbookLog {
  readonly directory: string
  readonly file: string
  readonly #now: () => Date
  #cache: { readonly size: number; readonly mtimeMs: number; readonly ops: readonly HandbookOp[] } | undefined

  constructor(directory: string, options: { readonly now?: () => Date } = {}) {
    this.directory = directory
    this.file = join(directory, HANDBOOK_LOG_FILE)
    this.#now = options.now ?? (() => new Date())
  }

  /**
   * Every operation, in `seq` order. A missing file is an empty log; a line
   * that does not parse (a torn last line of a crashed writer) is skipped.
   */
  async read(): Promise<readonly HandbookOp[]> {
    let info
    try {
      info = await stat(this.file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    if (this.#cache !== undefined && this.#cache.size === info.size && this.#cache.mtimeMs === info.mtimeMs) return this.#cache.ops
    const raw = await retryTransient(() => readFile(this.file, 'utf8'))
    const ops: HandbookOp[] = []
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue
      try {
        const op = JSON.parse(line) as HandbookOp
        if (op !== null && typeof op === 'object' && typeof op.seq === 'number' && typeof op.op === 'string') ops.push(op)
      } catch {
        // A torn line: skipped, the next append starts a fresh line.
      }
    }
    ops.sort((a, b) => a.seq - b.seq)
    this.#cache = { size: Buffer.byteLength(raw), mtimeMs: info.mtimeMs, ops }
    return ops
  }

  /** The entries as of `untilSeq` (default: now). */
  async entries(untilSeq?: number): Promise<HandbookEntry[]> {
    return foldHandbook(await this.read(), untilSeq)
  }

  /**
   * Append operations under the lock, stamping `seq` (after the last one on
   * disk) and `at`. `prepare` runs under the lock with the current log and
   * returns the operations to write (so a writer can decide on fresh state).
   */
  async append(prepare: (ops: readonly HandbookOp[]) => readonly HandbookOpInput[] | Promise<readonly HandbookOpInput[]>): Promise<HandbookOp[]> {
    await mkdir(this.directory, { recursive: true })
    await this.#lock()
    try {
      const current = await this.read()
      const inputs = await prepare(current)
      if (inputs.length === 0) return []
      for (const input of inputs) checkHandbookOp(input)
      let seq = current.at(-1)?.seq ?? 0
      const at = this.#now().toISOString()
      const written = inputs.map(input => ({ formatVersion: 1, seq: ++seq, at, ...input }) as HandbookOp)
      // A torn last line (no newline) is closed first so the new lines stay whole.
      const raw = await readFile(this.file, 'utf8').catch(() => '')
      const lead = raw !== '' && !raw.endsWith('\n') ? '\n' : ''
      await retryTransient(() => appendFile(this.file, lead + written.map(op => `${JSON.stringify(op)}\n`).join(''), 'utf8'))
      return written
    } finally {
      await retryTransient(() => rm(join(this.directory, HANDBOOK_LOCK_FILE), { force: true }))
    }
  }

  async #lock(): Promise<void> {
    const path = join(this.directory, HANDBOOK_LOCK_FILE)
    for (let attempt = 0; ; attempt += 1) {
      try {
        const handle = await open(path, 'wx', 0o644)
        try {
          await handle.writeFile(`${process.pid}\n`)
        } finally {
          await handle.close()
        }
        return
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') throw error
      }
      const pid = Number.parseInt((await readFile(path, 'utf8').catch(() => '')).trim(), 10)
      if (Number.isSafeInteger(pid) && pid > 0 && !alive(pid)) {
        await rm(path, { force: true }).catch(() => undefined)
        continue
      }
      const delay = LOCK_DELAYS_MS[attempt]
      if (delay === undefined) throw new NexgentError('internal', `handbook: ${path} is held by another process`)
      await sleep(delay)
    }
  }
}
