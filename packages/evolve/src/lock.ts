/**
 * Small file helpers shared by the queue and the job files: a pid lock file
 * (exclusive create, broken only when its process is dead), process
 * liveness, and atomic JSON writes (temp file, fsync, rename).
 */
import { randomUUID } from 'node:crypto'
import { link, open, readFile, rename, rm, stat } from 'node:fs/promises'

/** A lock file without a pid younger than this is still being written, not stale. */
const EMPTY_LOCK_GRACE_MS = 5_000

/** Whether a process id names a live process (EPERM: alive, owned by someone else). */
export function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** The pid written in a lock file; `undefined` when there is no lock or it does not hold a pid. */
export async function readLockPid(path: string): Promise<number | undefined> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const pid = Number.parseInt(raw.trim(), 10)
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined
}

/** Whether a lock file names a live process. */
export async function lockHeld(path: string): Promise<boolean> {
  const pid = await readLockPid(path)
  return pid !== undefined && processAlive(pid)
}

/**
 * Create a lock file holding `pid` (exclusive create).
 * @returns `false` when the file already exists.
 */
export async function tryCreateLock(path: string, pid: number = process.pid): Promise<boolean> {
  let handle
  try {
    handle = await open(path, 'wx', 0o644)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
  try {
    await handle.writeFile(`${pid}\n`)
    await handle.sync()
  } finally {
    await handle.close()
  }
  return true
}

/**
 * Remove a lock whose process is dead. The file is first renamed aside, so
 * of several processes breaking the same stale lock only one removes it;
 * if what was moved aside turns out to name a live process (it was
 * replaced in between), it is put back.
 * @returns whether the stale lock was removed.
 */
export async function breakStaleLock(path: string): Promise<boolean> {
  const before = await readLockPid(path).catch(() => undefined)
  if (before !== undefined && processAlive(before)) return false
  if (before === undefined) {
    const age = await stat(path).then(info => Date.now() - info.mtimeMs, () => undefined)
    if (age === undefined || age < EMPTY_LOCK_GRACE_MS) return false
  }
  const aside = `${path}.stale-${randomUUID()}`
  try {
    await rename(path, aside)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  const moved = await readLockPid(aside).catch(() => undefined)
  if (moved !== before || (moved !== undefined && processAlive(moved))) {
    await link(aside, path).catch(() => undefined)
    await rm(aside, { force: true })
    return false
  }
  await rm(aside, { force: true })
  return true
}

/** Options of {@link withFileLock}. */
export interface FileLockOptions {
  /** Give up after this long (default 15 s). */
  readonly timeoutMs?: number
  /** Poll interval while another holder has it (default 10 ms). */
  readonly pollMs?: number
}

/**
 * Run `fn` while holding the lock file at `path`. Waits while a live process
 * (this one included) holds it; breaks a lock left by a dead process.
 * @throws `Error` when the lock cannot be taken within the timeout.
 */
export async function withFileLock<T>(path: string, fn: () => Promise<T>, options: FileLockOptions = {}): Promise<T> {
  const deadline = Date.now() + (options.timeoutMs ?? 15_000)
  const poll = options.pollMs ?? 10
  for (;;) {
    if (await tryCreateLock(path)) break
    if (await breakStaleLock(path)) continue
    if (Date.now() > deadline) throw new Error(`could not take the lock ${path}`)
    await new Promise(resolve => setTimeout(resolve, poll))
  }
  try {
    return await fn()
  } finally {
    await rm(path, { force: true })
  }
}

/** Write JSON atomically: a sibling temp file, fsync, rename over the target. */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`
  const handle = await open(temp, 'wx', 0o644)
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

/** Parse a JSON file; `undefined` when it does not exist. */
export async function readJson(path: string): Promise<unknown> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  return JSON.parse(raw) as unknown
}
