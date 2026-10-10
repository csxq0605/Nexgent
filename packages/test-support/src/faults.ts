/**
 * Fault injection helpers: file truncation (a `kill -9` mid-write),
 * process-tree kill, deadlines, and an unreachable endpoint (network down).
 */
import { execFile } from 'node:child_process'
import { appendFile, stat, truncate } from 'node:fs/promises'
import { createServer } from 'node:net'

/** Where {@link truncateFile} cuts. */
export type TruncateAt = { readonly atByte: number } | { readonly dropLastBytes: number }

/** What {@link truncateFile} did. */
export interface TruncateResult {
  readonly originalSize: number
  readonly newSize: number
}

/**
 * Cut a file to simulate a writer killed mid-write.
 * `atByte` keeps the first N bytes; `dropLastBytes` removes the last N.
 * Both are clamped to `[0, size]`.
 * @param path - file to truncate in place.
 * @param at - cut position.
 */
export async function truncateFile(path: string, at: TruncateAt): Promise<TruncateResult> {
  const originalSize = (await stat(path)).size
  const raw = 'atByte' in at ? at.atByte : originalSize - at.dropLastBytes
  const newSize = Math.max(0, Math.min(originalSize, Math.floor(raw)))
  await truncate(path, newSize)
  return { originalSize, newSize }
}

/**
 * Append `text` with no trailing newline: the half line a killed JSONL
 * writer leaves behind.
 * @param path - file to append to.
 * @param text - partial line content.
 */
export async function appendPartialLine(path: string, text: string): Promise<void> {
  await appendFile(path, text.replace(/\n+$/, ''), 'utf8')
}

/** Whether a process with this pid exists (signal 0 probe; EPERM counts as alive). */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function exec(file: string, args: readonly string[]): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true }, (error, stdout) => {
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1
      resolve({ stdout: String(stdout), code })
    })
  })
}

/** All descendant pids of `pid` (POSIX, via `ps`), deepest first. */
export async function descendantPids(pid: number): Promise<number[]> {
  if (process.platform === 'win32') return []
  const { stdout } = await exec('ps', ['-A', '-o', 'pid=,ppid='])
  const children = new Map<number, number[]>()
  for (const line of stdout.split('\n')) {
    const [child, parent] = line.trim().split(/\s+/).map(Number)
    if (child === undefined || parent === undefined || Number.isNaN(child) || Number.isNaN(parent)) continue
    const list = children.get(parent) ?? []
    list.push(child)
    children.set(parent, list)
  }
  const out: number[] = []
  const walk = (p: number): void => {
    for (const c of children.get(p) ?? []) {
      walk(c)
      out.push(c)
    }
  }
  walk(pid)
  return out
}

/**
 * Kill a process and all its descendants.
 * Windows: `taskkill /PID <pid> /T /F` (signal ignored, always forceful).
 * POSIX: collects descendants with `ps`, then signals children first and
 * the root last. Already-dead processes are ignored.
 * @param pid - root process id.
 * @param signal - POSIX signal (default `SIGKILL`).
 */
export async function killProcessTree(pid: number, signal: NodeJS.Signals = 'SIGKILL'): Promise<void> {
  if (process.platform === 'win32') {
    await exec('taskkill', ['/PID', String(pid), '/T', '/F'])
    return
  }
  const pids = [...await descendantPids(pid), pid]
  for (const p of pids) {
    try {
      process.kill(p, signal)
    } catch {
      // already gone
    }
  }
}

/** Error thrown by {@link withTimeout} and {@link deadline}. */
export class TimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TimeoutError'
  }
}

/**
 * Reject with {@link TimeoutError} if `promise` does not settle in `ms`.
 * @param promise - the work.
 * @param ms - limit in milliseconds.
 * @param label - names the work in the error message.
 */
export function withTimeout<T>(promise: PromiseLike<T>, ms: number, label = 'operation'): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(`${label} timed out after ${ms}ms`)), ms)
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/** A shared deadline for a multi-step test or acceptance run. */
export interface Deadline {
  /** Aborts (with a {@link TimeoutError} reason) when the deadline passes. */
  readonly signal: AbortSignal
  /** Milliseconds left (never negative). */
  remainingMs(): number
  /** Whether the deadline has passed. */
  expired(): boolean
  /** {@link withTimeout} bounded by the remaining time. */
  race<T>(promise: PromiseLike<T>, label?: string): Promise<T>
  /** Cancel the timer (call when done so the process can exit). */
  clear(): void
}

/**
 * Start a deadline `ms` from now.
 * @param ms - total budget in milliseconds.
 */
export function deadline(ms: number): Deadline {
  const end = Date.now() + ms
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new TimeoutError(`deadline of ${ms}ms passed`)), ms)
  const remainingMs = (): number => Math.max(0, end - Date.now())
  return {
    signal: controller.signal,
    remainingMs,
    expired: () => remainingMs() === 0,
    race: (promise, label) => withTimeout(promise, remainingMs(), label),
    clear: () => clearTimeout(timer),
  }
}

/**
 * Poll `predicate` until it returns truthy, or reject after `timeoutMs`.
 * @param predicate - condition (may be async).
 * @param options - `timeoutMs` (default 5000), `intervalMs` (default 25), `label`.
 */
export async function waitFor<T>(
  predicate: () => T | Promise<T>,
  options: { readonly timeoutMs?: number; readonly intervalMs?: number; readonly label?: string } = {},
): Promise<NonNullable<T>> {
  const timeoutMs = options.timeoutMs ?? 5000
  const end = Date.now() + timeoutMs
  for (;;) {
    const value = await predicate()
    if (value) return value as NonNullable<T>
    if (Date.now() >= end) throw new TimeoutError(`${options.label ?? 'condition'} not met within ${timeoutMs}ms`)
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 25))
  }
}

/**
 * A base URL on loopback where nothing listens (connection refused):
 * the "network down" fault. The port was free a moment ago; a race with
 * another process binding it is possible but unlikely.
 * @param path - path suffix (default `/v1`).
 */
export async function closedPortUrl(path = ''): Promise<string> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return `http://127.0.0.1:${port}${path}`
}
