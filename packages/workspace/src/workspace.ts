/**
 * The `ctx.workspace` implementation: one project directory and its
 * `.nexgent/` data layout (`docs/spec/data-formats.md` §`.nexgent/` 目录布局).
 */
import { mkdir, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as nodePath from 'node:path'
import {
  NEXGENT_DIR,
  NEXGENT_SUBDIRS,
  NexgentError,
  normalizeWorkspacePath,
  resolveWorkspaceLayout,
  type Workspace,
  type WorkspaceLayout,
} from '@nexgent/kernel'

/** Options for {@link openWorkspace}. */
export interface OpenWorkspaceOptions {
  /** Create the project directory when missing (default `false`). */
  readonly create?: boolean
  /** Also create `.nexgent/` and its subdirectories (default `false`). */
  readonly ensureLayout?: boolean
}

/** A local-filesystem {@link Workspace}. Construct with {@link openWorkspace}. */
export class LocalWorkspace implements Workspace {
  readonly root: string
  readonly layout: WorkspaceLayout

  /** @param root - absolute, already real (symlink-free) project root. */
  constructor(root: string) {
    this.layout = resolveWorkspaceLayout(root)
    this.root = this.layout.root
  }

  resolve(input: string): string {
    return normalizeWorkspacePath(this.root, input)
  }

  relative(absolute: string): string {
    const rel = nodePath.relative(this.root, absolute)
    return rel === '' ? '.' : rel
  }

  sessionDir(sessionId: string): string {
    if (sessionId === '' || sessionId === '.' || sessionId === '..' || /[\\/:]/.test(sessionId)) {
      throw new NexgentError('workspace/outside-root', `invalid session id: ${JSON.stringify(sessionId)}`)
    }
    return nodePath.join(this.layout.sessions, sessionId)
  }

  async ensureLayout(): Promise<void> {
    await mkdir(this.layout.dataDir, { recursive: true })
    for (const sub of NEXGENT_SUBDIRS) await mkdir(this.layout[sub], { recursive: true })
  }
}

/**
 * Open (and optionally create) a project directory. The root is resolved to
 * its real path so every later containment check compares real paths.
 * @throws `workspace/not-found` when the directory is missing and `create` is off, or is not a directory.
 */
export async function openWorkspace(root: string, options: OpenWorkspaceOptions = {}): Promise<LocalWorkspace> {
  const absolute = nodePath.resolve(root)
  if (options.create === true) await mkdir(absolute, { recursive: true })
  let real: string
  try {
    real = await realpath(absolute)
    if (!(await stat(real)).isDirectory()) throw new Error('not a directory')
  } catch (error) {
    throw new NexgentError('workspace/not-found', `project directory not found: ${absolute}`, { cause: error, details: { path: absolute } })
  }
  const workspace = new LocalWorkspace(real)
  if (options.ensureLayout === true) await workspace.ensureLayout()
  return workspace
}

/**
 * Find the nearest directory at or above `start` that contains `.nexgent/`;
 * `undefined` when none does.
 */
export async function locateWorkspace(start: string): Promise<string | undefined> {
  let dir = nodePath.resolve(start)
  while (true) {
    try {
      if ((await stat(nodePath.join(dir, NEXGENT_DIR))).isDirectory()) return dir
    } catch {
      // keep walking
    }
    const parent = nodePath.dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/** Prefix of per-session temporary directories under `os.tmpdir()`. */
export const SESSION_TEMP_PREFIX = 'nexgent-'

/** `<os.tmpdir()>/nexgent-<sessionId>` (not created). */
export function sessionTempDir(sessionId: string, base: string = tmpdir()): string {
  if (sessionId === '' || /[\\/:]/.test(sessionId) || sessionId === '..' || sessionId === '.') {
    throw new NexgentError('workspace/outside-root', `invalid session id: ${JSON.stringify(sessionId)}`)
  }
  return nodePath.join(base, `${SESSION_TEMP_PREFIX}${sessionId}`)
}

/** Create the session temp directory if missing; returns its path. */
export async function ensureSessionTempDir(sessionId: string, base?: string): Promise<string> {
  const dir = sessionTempDir(sessionId, base)
  await mkdir(dir, { recursive: true })
  return dir
}

/** Delete the session temp directory (host calls this when a session ends). */
export async function removeSessionTempDir(sessionId: string, base?: string): Promise<void> {
  await rm(sessionTempDir(sessionId, base), { recursive: true, force: true })
}
