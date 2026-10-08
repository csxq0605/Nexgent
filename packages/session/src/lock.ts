/**
 * The single-writer lock file `sessions/<id>/.lock`.
 *
 * Normative rules: `docs/spec/data-formats.md` §并发写保护. The lock is taken
 * by exclusive creation (`wx`); when that fails the existing content is read
 * and the lock is taken over only when it is stale: same `host` and its `pid`
 * is no longer alive. A lock from another host is never taken over (its pid
 * cannot be checked from here). Takeover itself is serialized through a
 * short-lived `.lock.takeover` guard so two processes that both see the same
 * stale lock cannot both win.
 *
 * Design reference: deepseek-harness@46a7f68b
 * `session/session-persistence-jsonl/src/lease.ts` (whole-lifetime write
 * lease, contention reported as an ownership error). DSH arbitrates with a
 * kernel `flock`/named semaphore; Nexgent uses the spec's portable pid file.
 */
import { open, readFile, stat, unlink } from 'node:fs/promises'
import { hostname } from 'node:os'
import { NexgentError, type SessionLockFile } from '@nexgent/kernel'

/** Base name of the lock file inside a session directory. */
export const LOCK_FILE_NAME = '.lock'

/** An unparsable lock (or takeover guard) older than this is considered abandoned. */
export const ABANDONED_LOCK_MS = 10_000

/** Identity and liveness hooks; tests override them to simulate other processes. */
export interface LockIdentity {
  /** Owning process id; default `process.pid`. */
  readonly pid?: number
  /** Host name; default `os.hostname()`. */
  readonly host?: string
  /** Liveness probe; default {@link isProcessAlive}. */
  readonly isAlive?: (pid: number) => boolean
  /** Clock; default `new Date()`. */
  readonly now?: () => Date
}

/**
 * Whether a process with this pid exists on this host. `EPERM` (exists but
 * owned by someone else) counts as alive.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Parse lock file content; `undefined` when it is not a valid {@link SessionLockFile}. */
export function parseLockFile(text: string): SessionLockFile | undefined {
  try {
    const value: unknown = JSON.parse(text)
    if (typeof value !== 'object' || value === null) return undefined
    const { pid, ts, host } = value as Record<string, unknown>
    if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || typeof ts !== 'string' || typeof host !== 'string') {
      return undefined
    }
    return { pid, ts, host }
  } catch {
    return undefined
  }
}

/**
 * Take the lock at `path` for `sessionId`.
 * @returns the lock file content now on disk.
 * @throws {NexgentError} `session/locked` (details: holder `pid`, `ts`, `host`) when another live process holds it.
 */
export async function acquireLockFile(path: string, sessionId: string, identity: LockIdentity = {}): Promise<SessionLockFile> {
  const info: SessionLockFile = {
    pid: identity.pid ?? process.pid,
    ts: (identity.now?.() ?? new Date()).toISOString(),
    host: identity.host ?? hostname(),
  }
  const isAlive = identity.isAlive ?? isProcessAlive
  const content = JSON.stringify(info)
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (await createExclusive(path, content)) return info
    const existing = await readExisting(path)
    if (existing === undefined) continue // released between our attempts: retry
    const holder = existing.info
    const stale =
      holder === undefined
        ? Date.now() - existing.mtimeMs > ABANDONED_LOCK_MS
        : holder.host === info.host && !isAlive(holder.pid)
    if (!stale) throw lockedError(sessionId, holder)
    await takeOver(path, existing.raw, sessionId)
  }
  throw lockedError(sessionId, undefined)
}

/**
 * Remove the lock file when it still holds `info` (it is left alone when
 * another process has since taken it over).
 */
export async function releaseLockFile(path: string, info: SessionLockFile): Promise<void> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  const current = parseLockFile(text)
  if (current?.pid === info.pid && current.ts === info.ts && current.host === info.host) {
    await unlinkIfPresent(path)
  }
}

function lockedError(sessionId: string, holder: SessionLockFile | undefined): NexgentError {
  return new NexgentError('session/locked', `session ${sessionId} is locked by another writer`, {
    details: holder === undefined ? { sessionId } : { sessionId, pid: holder.pid, ts: holder.ts, host: holder.host },
  })
}

/** Create `path` exclusively with `content` (fsynced); `false` when it already exists. */
async function createExclusive(path: string, content: string): Promise<boolean> {
  let handle
  try {
    handle = await open(path, 'wx')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } catch (error) {
    await handle.close().catch(() => {})
    await unlinkIfPresent(path)
    throw error
  }
  await handle.close()
  return true
}

async function readExisting(
  path: string,
): Promise<{ raw: string; info: SessionLockFile | undefined; mtimeMs: number } | undefined> {
  try {
    const [raw, stats] = await Promise.all([readFile(path, 'utf8'), stat(path)])
    return { raw, info: parseLockFile(raw), mtimeMs: stats.mtimeMs }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** Remove a stale lock whose content is still `raw`, under the takeover guard. */
async function takeOver(path: string, raw: string, sessionId: string): Promise<void> {
  const guard = `${path}.takeover`
  if (!(await createExclusive(guard, String(process.pid)))) {
    const stats = await stat(guard).catch(() => undefined)
    if (stats !== undefined && Date.now() - stats.mtimeMs > ABANDONED_LOCK_MS) {
      await unlinkIfPresent(guard)
      return // retry from the top
    }
    throw lockedError(sessionId, undefined)
  }
  try {
    const current = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (current === raw) await unlinkIfPresent(path)
  } finally {
    await unlinkIfPresent(guard)
  }
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}
