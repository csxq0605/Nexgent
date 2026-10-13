/**
 * Renames that tolerate a transient Windows sharing violation: while another
 * process (a reader, an indexer, antivirus) has the source or the target
 * open, `rename` can fail for a moment with EPERM / EBUSY / EACCES. Those
 * failures are retried with backoff; any other error, or the last
 * attempt's, is thrown. EACCES counts as transient only on Windows (on POSIX
 * it is a real permission error).
 */
import { rename } from 'node:fs/promises'

/** Error codes of a transient sharing violation on a platform (EACCES only on Windows). */
export function transientRenameCodes(platform: NodeJS.Platform = process.platform): ReadonlySet<string> {
  return new Set(platform === 'win32' ? ['EPERM', 'EBUSY', 'EACCES'] : ['EPERM', 'EBUSY'])
}

/** {@link transientRenameCodes} of this platform. */
export const TRANSIENT_RENAME_CODES: ReadonlySet<string> = transientRenameCodes()

/** Waits between attempts (about 1.6 s in all, 9 attempts). */
export const RENAME_RETRY_DELAYS_MS: readonly number[] = [10, 20, 40, 80, 160, 320, 500, 500]

/** Options of {@link renameRetrying}. */
export interface RenameRetryOptions {
  /** Checked after a transient failure; `true` stops retrying (e.g. the destination appeared). */
  readonly stop?: () => Promise<boolean>
  readonly delays?: readonly number[]
  /** The rename to use (tests substitute a failing one). */
  readonly rename?: (from: string, to: string) => Promise<void>
}

/** Whether an error is a transient sharing violation (EPERM / EBUSY, and EACCES on Windows). */
export function isTransientFsError(error: unknown, platform: NodeJS.Platform = process.platform): boolean {
  return (platform === process.platform ? TRANSIENT_RENAME_CODES : transientRenameCodes(platform)).has((error as NodeJS.ErrnoException | null)?.code ?? '')
}

/** Run a file operation, retrying it with backoff while it fails with a transient sharing violation. */
export async function retryTransient<T>(op: () => Promise<T>, delays: readonly number[] = RENAME_RETRY_DELAYS_MS): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await op()
    } catch (error) {
      if (!isTransientFsError(error) || attempt >= delays.length) throw error
      await new Promise(resolve => setTimeout(resolve, delays[attempt]))
    }
  }
}

/** `rename(from, to)`, retried while it fails with a transient sharing violation. */
export async function renameRetrying(from: string, to: string, options: RenameRetryOptions = {}): Promise<void> {
  const delays = options.delays ?? RENAME_RETRY_DELAYS_MS
  const move = options.rename ?? rename
  for (let attempt = 0; ; attempt += 1) {
    try {
      await move(from, to)
      return
    } catch (error) {
      if (!TRANSIENT_RENAME_CODES.has((error as NodeJS.ErrnoException | null)?.code ?? '') || attempt >= delays.length) throw error
      if (options.stop !== undefined && await options.stop()) throw error
      await new Promise(resolve => setTimeout(resolve, delays[attempt]))
    }
  }
}
