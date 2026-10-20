/**
 * The one project walk the snapshot recorder and the turn file tracker share:
 * `readdir` plus `lstat` (never a file read), honouring `.gitignore`
 * ({@link IgnoreScope}) and never descending into an ignored directory.
 * `.git/`, `node_modules/` and the root `.nexgent/` are always skipped.
 */
import { lstat, readdir } from 'node:fs/promises'
import * as nodePath from 'node:path'
import { childScope, isAlwaysSkipped, rootScope, type IgnoreScope } from './gitignore.js'

/** One file the walk found. */
export interface WalkedEntry {
  /** Project-relative, `/`-separated. */
  readonly path: string
  readonly size: number
  readonly mtimeMs: number
  readonly ctimeMs: number
  /** `0` when the file system keeps no creation time. */
  readonly birthtimeMs: number
  readonly mode: number
  readonly symlink: boolean
}

/** Options of {@link walkProject}. */
export interface WalkOptions {
  /** Stop early (`complete: false`) once aborted. */
  readonly signal?: AbortSignal
  /** Stop early (`complete: false`) after this many files. */
  readonly limit?: number
  /** Also report symbolic links (never followed); default regular files only. */
  readonly symlinks?: boolean
  /** Rework K4 D4: told of each directory the walk does not enter (`.gitignore`d, or always skipped such as `node_modules/`). */
  readonly onSkippedDir?: (portable: string) => void
}

/** What {@link walkProject} found, sorted by path when complete or not. */
export interface WalkResult {
  readonly files: WalkedEntry[]
  /** `false` when the walk stopped at the limit or on abort. */
  readonly complete: boolean
}

/** Directories listed and `lstat`ed concurrently. */
const WALK_CONCURRENCY = 16
const STAT_BATCH = 128

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Walk the project below `root` (project files only, sorted by path). */
export async function walkProject(root: string, options: WalkOptions = {}): Promise<WalkResult> {
  const files: WalkedEntry[] = []
  const limit = options.limit ?? Number.POSITIVE_INFINITY
  let complete = true
  const stopped = (): boolean => {
    if (options.signal?.aborted === true || files.length >= limit) complete = false
    return !complete
  }

  type Pending = { readonly dir: string; readonly parent: IgnoreScope | undefined }

  const visit = async ({ dir, parent }: Pending): Promise<Pending[]> => {
    if (stopped()) return []
    const scope = parent === undefined ? await rootScope(root) : await childScope(root, parent, dir)
    let entries
    try {
      entries = await readdir(dir === '' ? root : nodePath.join(root, ...dir.split('/')), { withFileTypes: true })
    } catch {
      return [] // vanished, or not readable
    }
    const subdirs: Pending[] = []
    const leaves: Array<{ portable: string; symlink: boolean }> = []
    for (const entry of entries) {
      const portable = dir === '' ? entry.name : `${dir}/${entry.name}`
      if (entry.isDirectory()) {
        if (isAlwaysSkipped(entry.name, dir === '') || scope.ignores(portable, true)) {
          options.onSkippedDir?.(portable)
          continue
        }
        subdirs.push({ dir: portable, parent: scope })
        continue
      }
      const symlink = entry.isSymbolicLink()
      if (!entry.isFile() && !(symlink && options.symlinks === true)) continue
      if (dir === '' && isAlwaysSkipped(entry.name, true)) continue
      if (scope.ignores(portable, false)) continue
      leaves.push({ portable, symlink })
    }
    for (let i = 0; i < leaves.length; i += STAT_BATCH) {
      if (stopped()) break
      const batch = leaves.slice(i, i + STAT_BATCH)
      const infos = await Promise.all(batch.map(async leaf => {
        try {
          return await lstat(nodePath.join(root, ...leaf.portable.split('/')))
        } catch {
          return undefined // vanished between readdir and lstat
        }
      }))
      infos.forEach((info, index) => {
        if (info === undefined || files.length >= limit) return
        files.push({
          path: batch[index]!.portable,
          size: info.size,
          mtimeMs: info.mtimeMs,
          ctimeMs: info.ctimeMs,
          birthtimeMs: info.birthtimeMs,
          mode: info.mode,
          symlink: batch[index]!.symlink,
        })
      })
    }
    return subdirs
  }

  let queue: Pending[] = [{ dir: '', parent: undefined }]
  while (queue.length > 0 && !stopped()) {
    const next: Pending[] = []
    for (let i = 0; i < queue.length; i += WALK_CONCURRENCY) {
      if (stopped()) break
      const results = await Promise.all(queue.slice(i, i + WALK_CONCURRENCY).map(visit))
      for (const subdirs of results) next.push(...subdirs)
    }
    queue = next
  }
  stopped()
  files.sort((a, b) => compare(a.path, b.path))
  return { files, complete }
}
