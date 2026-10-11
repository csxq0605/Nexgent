/**
 * `files.list`: the project's regular files for the desktop's right panel.
 * Walks the project root breadth-first without following symbolic links,
 * skips host data, VCS and dependency directories, and stops at
 * {@link PROJECT_FILES_LIMIT} entries.
 */
import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { PROJECT_FILES_LIMIT, PROJECT_FILES_SKIPPED_DIRS, type ProjectFileEntry, type ProjectFileListing } from './api.js'

const SKIPPED = new Set<string>(PROJECT_FILES_SKIPPED_DIRS)

/** `.git` and `node_modules` are skipped at any depth, `.nexgent` only at the root (where the host keeps it). */
function skipped(dir: string, name: string): boolean {
  return SKIPPED.has(name) && (name !== '.nexgent' || dir === '')
}

/**
 * List the regular files under `root`.
 * @param limit - most entries returned (tests lower it).
 */
export async function listProjectFiles(root: string, limit = PROJECT_FILES_LIMIT): Promise<ProjectFileListing> {
  const files: ProjectFileEntry[] = []
  const queue: string[] = ['']
  let truncated = false
  while (queue.length > 0 && !truncated) {
    const dir = queue.shift()!
    let names: string[]
    try {
      names = (await readdir(join(root, dir))).sort()
    } catch {
      continue // vanished or unreadable directory: list what can be read
    }
    for (const name of names) {
      const rel = dir === '' ? name : `${dir}/${name}`
      let info
      try {
        info = await lstat(join(root, rel))
      } catch {
        continue
      }
      if (info.isDirectory()) {
        if (!skipped(dir, name)) queue.push(rel)
      } else if (info.isFile()) {
        if (files.length >= limit) {
          truncated = true
          break
        }
        files.push({ path: rel, size: info.size, modifiedAt: info.mtime.toISOString() })
      }
    }
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return { files, truncated }
}
