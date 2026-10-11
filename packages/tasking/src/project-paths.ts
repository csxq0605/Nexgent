/**
 * Resolving model-supplied paths to project files for `present`: inside the
 * project (also after following symlinks), an existing regular file, and not
 * under `.nexgent/`. Records keep the project-relative `/` form.
 */
import { lstat, stat } from 'node:fs/promises'
import * as nodePath from 'node:path'
import { isInsideRoot, NEXGENT_DIR, NexgentError, normalizeWorkspacePath, toPortablePath } from '@nexgent/kernel'
import { isNotFound, realpathNative } from './files-util.js'

/** A validated project file. */
export interface ProjectFile {
  /** Real absolute path. */
  readonly absolute: string
  /** Project-relative, `/`-separated (relative to the real root). */
  readonly path: string
}

/** Whether two path segments name the same entry on this platform (case-insensitive on Windows and macOS). */
function sameSegment(a: string, b: string): boolean {
  return process.platform === 'win32' || process.platform === 'darwin' ? a.toLowerCase() === b.toLowerCase() : a === b
}

/** Whether a project-relative portable path lies in `.nexgent/`. */
export function isInDataDir(portable: string): boolean {
  const first = portable.split('/')[0] ?? ''
  return sameSegment(first, NEXGENT_DIR)
}

/**
 * Resolve one path the model gave (relative to the project, or absolute).
 * @throws `workspace/outside-root`, `workspace/not-found` or `sandbox/denied`
 *   with a message that tells the model what to do instead.
 */
export async function resolveProjectFile(root: string, realRoot: string, input: string): Promise<ProjectFile> {
  const lexical = normalizeWorkspacePath(root, input)
  if (!isInsideRoot(root, lexical) && !isInsideRoot(realRoot, lexical)) {
    throw new NexgentError('workspace/outside-root', `${input} is outside the project (${root}); copy or write the file into the project first, then present it`, { details: { path: input } })
  }
  const lexicalRel = toPortablePath(nodePath.relative(isInsideRoot(root, lexical) ? root : realRoot, lexical))
  if (isInDataDir(lexicalRel)) {
    throw new NexgentError('sandbox/denied', `${input} is inside .nexgent/, which holds Nexgent's own data; present files you wrote in the project instead`, { details: { path: input } })
  }
  try {
    await lstat(lexical)
  } catch (error) {
    if (isNotFound(error)) throw new NexgentError('workspace/not-found', `${input} does not exist in the project; write it first, then present it`, { details: { path: input } })
    throw error
  }
  let real: string
  try {
    real = await realpathNative(lexical)
  } catch (error) {
    if (isNotFound(error)) throw new NexgentError('workspace/not-found', `${input} is a dangling link; present the file itself`, { details: { path: input } })
    throw error
  }
  if (!isInsideRoot(realRoot, real)) {
    throw new NexgentError('workspace/outside-root', `${input} resolves outside the project (${real}); copy the file into the project first, then present it`, { details: { path: input } })
  }
  const path = toPortablePath(nodePath.relative(realRoot, real))
  if (path === '' || isInDataDir(path)) {
    throw new NexgentError('sandbox/denied', `${input} is inside .nexgent/, which holds Nexgent's own data; present files you wrote in the project instead`, { details: { path: input } })
  }
  const info = await stat(real)
  if (!info.isFile()) {
    throw new NexgentError('workspace/not-found', `${input} is not a file; present the files inside it one by one`, { details: { path: input } })
  }
  return { absolute: real, path }
}

/** Reject a portable path that could climb out of a snapshot directory. */
export function assertSafePortablePath(path: string): void {
  const segments = path.split('/')
  if (path === '' || path.includes('\\') || nodePath.isAbsolute(path) || /^[A-Za-z]:/.test(path) || segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new NexgentError('tool/invalid-input', `not a project-relative path: ${path}`, { details: { path } })
  }
}
