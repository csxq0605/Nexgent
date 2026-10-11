/**
 * Paths a delegate is told to read: checked to lie inside the project and
 * turned into project-relative `/`-separated paths (the form records and
 * prompts use on every platform). Pure apart from {@link assertFilesExist}.
 */
import { stat } from 'node:fs/promises'
import * as nodePath from 'node:path'
import { NexgentError } from '@nexgent/kernel'

/** Path flavor: the host's, or one forced by tests. */
export type PathFlavor = 'posix' | 'win32'

/** The flavor of this process. */
export function hostFlavor(): PathFlavor {
  return process.platform === 'win32' ? 'win32' : 'posix'
}

/**
 * Normalize the `files` argument: each path, relative to the project root
 * or absolute inside it (on Windows `\` and `/` both separate, drive letters
 * compare case-insensitively), becomes a project-relative portable path.
 * Duplicates are dropped, order is kept.
 * @throws `tool/invalid-input` for an empty path or one outside the project.
 */
export function normalizeMemberFiles(root: string, files: readonly string[], flavor: PathFlavor = hostFlavor()): string[] {
  const path = flavor === 'win32' ? nodePath.win32 : nodePath.posix
  const out: string[] = []
  for (const raw of files) {
    const input = raw.trim()
    if (input === '') throw new NexgentError('tool/invalid-input', 'files entries must be non-empty paths')
    const absolute = path.resolve(root, input)
    const relative = path.relative(root, absolute)
    if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new NexgentError('tool/invalid-input', `files entry "${raw}" is not a path inside the project`, { details: { path: raw } })
    }
    const portable = relative.split(path.sep).join('/')
    if (!out.includes(portable)) out.push(portable)
  }
  return out
}

/**
 * Check that every normalized path exists under `root`.
 * @throws `tool/invalid-input` naming the missing paths.
 */
export async function assertFilesExist(root: string, files: readonly string[]): Promise<void> {
  const missing: string[] = []
  for (const file of files) {
    try {
      await stat(nodePath.join(root, ...file.split('/')))
    } catch {
      missing.push(file)
    }
  }
  if (missing.length > 0) {
    throw new NexgentError('tool/invalid-input', `files not found in the project: ${missing.join(', ')}`, { details: { missing } })
  }
}
