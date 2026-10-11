// Adapted from deepseek-harness@46a7f68b packages/util/atomic-write/src/index.ts and packages/storage/storage-json/src/atomic.ts (MIT)
/**
 * Crash-safe whole-file replacement: write a same-directory temp file with
 * exclusive create and the caller's mode, fsync it, rename it over the target
 * and fsync the parent directory (POSIX). Readers see either the old or the
 * new complete content, never a prefix.
 */
import { randomBytes } from 'node:crypto'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'

const WINDOWS_TRANSIENT_RENAME_ERRORS: ReadonlySet<string> = new Set(['EACCES', 'EBUSY', 'EPERM'])
const RENAME_RETRY_INITIAL_MS = 20
const RENAME_RETRY_MAX_MS = 200
const RENAME_RETRY_LIMIT = 8

/** Options for {@link writeFileAtomic}. */
export interface WriteFileAtomicOptions {
  /** Permission bits of the new file (subject to umask); default `0o600`. */
  readonly mode?: number
  /** Permission bits for parent directories this call creates; default mkdir's. */
  readonly dirMode?: number
}

function isTransientWindowsRenameError(error: unknown): boolean {
  if (process.platform !== 'win32') return false
  return WINDOWS_TRANSIENT_RENAME_ERRORS.has((error as NodeJS.ErrnoException | null)?.code ?? '')
}

/** Rename with bounded retries for transient Windows sharing violations. */
async function renameWithRetry(from: string, to: string): Promise<void> {
  let delay = RENAME_RETRY_INITIAL_MS
  for (let retries = 0; ; retries += 1) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      if (!isTransientWindowsRenameError(error) || retries >= RENAME_RETRY_LIMIT) throw error
    }
    await new Promise(resolve => setTimeout(resolve, delay))
    delay = Math.min(delay * 2, RENAME_RETRY_MAX_MS)
  }
}

/** fsync a directory so a just-renamed entry survives a crash; a no-op on Windows. */
export async function fsyncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/**
 * Durably replace `filename` with `content`, creating parent directories.
 * On failure the temp file is removed and the error rethrown; the target is
 * left untouched.
 * @param filename - final path.
 * @param content - complete new content (UTF-8 for strings).
 * @param options - file and directory modes.
 */
export async function writeFileAtomic(
  filename: string,
  content: string | Uint8Array,
  options: WriteFileAtomicOptions = {},
): Promise<void> {
  const dir = dirname(filename)
  await mkdir(dir, { recursive: true, ...(options.dirMode === undefined ? {} : { mode: options.dirMode }) })
  const temp = `${filename}.${randomBytes(6).toString('hex')}.tmp`
  try {
    const handle = await open(temp, 'wx', options.mode ?? 0o600)
    try {
      await handle.writeFile(content)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await renameWithRetry(temp, filename)
    await fsyncDirectory(dir)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}
