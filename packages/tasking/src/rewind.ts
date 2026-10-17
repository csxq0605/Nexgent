/**
 * Redesign 3.1: put the project files a session changed back to how they
 * were before one of its turns, from the snapshot every root turn takes
 * (`snapshots/tasks/<taskId>.t<turn>.json`, see task-records.ts).
 *
 * Only the files the session's `turn.files` records name for that turn and
 * the later ones are touched, so files nobody in this session changed
 * stay as they are. A file the snapshot has gets its old content back (and
 * its executable bit); a file it does not have was added since and is
 * deleted. {@link planRewind} only reads, so a host can show the list and
 * ask first; {@link applyRewind} writes.
 */
import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import * as nodePath from 'node:path'
import { createHash } from 'node:crypto'
import { NexgentError, SNAPSHOTS_DIR, type SnapshotFile, type SnapshotTree, type TaskSnapshotRecord, type WorkspaceLayout } from '@nexgent/kernel'
import { isNotFound } from './files-util.js'

/** One file a rewind changes. */
export interface RewindChange {
  /** Project-relative, `/`-separated. */
  readonly path: string
  /** `restore`: write the content it had before the turn; `delete`: it did not exist then. */
  readonly action: 'restore' | 'delete'
}

/** What {@link planRewind} found. */
export interface RewindPlan {
  readonly sessionId: string
  /** The turn whose start the files go back to. */
  readonly turn: number
  /** The snapshot the content comes from. */
  readonly takenAt: string
  /** Files that will change, by path. */
  readonly changes: readonly RewindChange[]
  /** Files the session changed that are already as they were (nothing to do). */
  readonly unchanged: readonly string[]
}

/** Input of {@link planRewind}. */
export interface PlanRewindInput {
  readonly layout: Pick<WorkspaceLayout, 'root' | 'dataDir'>
  readonly sessionId: string
  readonly turn: number
  /** Paths the session changed in `turn` and later (from its `turn.files` records). */
  readonly paths: readonly string[]
}

const sha256 = (body: Buffer): string => createHash('sha256').update(body).digest('hex')

function safePath(root: string, path: string): string {
  const parts = path.split('/')
  if (path === '' || nodePath.isAbsolute(path) || parts.some(part => part === '' || part === '.' || part === '..')) {
    throw new NexgentError('internal', `rewind: not a project path: ${path}`)
  }
  return nodePath.join(root, ...parts)
}

/** The snapshot taken before `turn` of `sessionId`, or `undefined`. */
async function findSnapshot(dir: string, sessionId: string, turn: number): Promise<TaskSnapshotRecord | undefined> {
  let names: string[]
  try {
    names = await readdir(nodePath.join(dir, 'tasks'))
  } catch (error) {
    if (isNotFound(error)) return undefined
    throw error
  }
  for (const name of names.filter(entry => entry.endsWith(`.t${turn}.json`))) {
    try {
      const record = JSON.parse(await readFile(nodePath.join(dir, 'tasks', name), 'utf8')) as TaskSnapshotRecord
      if (record.sessionId === sessionId && record.turn === turn) return record
    } catch {
      // A broken or half-written record is not this one.
    }
  }
  return undefined
}

/** Body and hash of a project file, or `undefined` when it does not exist. */
async function current(absolute: string): Promise<{ readonly sha256: string; readonly executable: boolean } | undefined> {
  try {
    const [body, info] = await Promise.all([readFile(absolute), stat(absolute)])
    return { sha256: sha256(body), executable: process.platform !== 'win32' && (info.mode & 0o111) !== 0 }
  } catch (error) {
    if (isNotFound(error) || (error as NodeJS.ErrnoException).code === 'EISDIR') return undefined
    throw error
  }
}

/**
 * Plan a rewind to the start of `turn` (reads only).
 * @throws `session/not-found` when no snapshot of that turn exists (taken
 *   before the snapshot was always on, pruned, or the project was too large).
 */
export async function planRewind(input: PlanRewindInput): Promise<RewindPlan> {
  const dir = nodePath.join(input.layout.dataDir, SNAPSHOTS_DIR)
  const record = await findSnapshot(dir, input.sessionId, input.turn)
  if (record === undefined) throw new NexgentError('session/not-found', `no snapshot of turn ${input.turn} of this session (it may be older than the retention period)`)
  if (record.tree === null) throw new NexgentError('session/not-found', `turn ${input.turn} has no snapshot: the project was too large to snapshot`)
  const tree = JSON.parse(await readFile(nodePath.join(dir, 'trees', `${record.tree}.json`), 'utf8')) as SnapshotTree
  const before = new Map<string, SnapshotFile>(tree.files.map(file => [file.path, file]))
  const changes: RewindChange[] = []
  const unchanged: string[] = []
  for (const path of [...new Set(input.paths)].sort()) {
    const now = await current(safePath(input.layout.root, path))
    const then = before.get(path)
    if (then === undefined) {
      if (now === undefined) unchanged.push(path)
      else changes.push({ path, action: 'delete' })
    } else if (now !== undefined && now.sha256 === then.sha256 && now.executable === (then.executable === true)) {
      unchanged.push(path)
    } else {
      changes.push({ path, action: 'restore' })
    }
  }
  return { sessionId: input.sessionId, turn: input.turn, takenAt: record.takenAt, changes, unchanged }
}

/**
 * Carry out a plan from {@link planRewind}: every `restore` gets its
 * snapshot content, every `delete` is removed. Stops at the first failure
 * (files changed before it stay changed; the error names the file).
 */
export async function applyRewind(layout: Pick<WorkspaceLayout, 'root' | 'dataDir'>, plan: RewindPlan): Promise<void> {
  const dir = nodePath.join(layout.dataDir, SNAPSHOTS_DIR)
  const record = await findSnapshot(dir, plan.sessionId, plan.turn)
  if (record?.tree === undefined || record.tree === null) throw new NexgentError('session/not-found', `no snapshot of turn ${plan.turn} of this session`)
  const tree = JSON.parse(await readFile(nodePath.join(dir, 'trees', `${record.tree}.json`), 'utf8')) as SnapshotTree
  const before = new Map<string, SnapshotFile>(tree.files.map(file => [file.path, file]))
  for (const change of plan.changes) {
    const absolute = safePath(layout.root, change.path)
    if (change.action === 'delete') {
      await rm(absolute, { force: true })
      continue
    }
    const file = before.get(change.path)
    if (file === undefined) throw new NexgentError('internal', `rewind: ${change.path} is not in the snapshot`)
    const body = await readFile(nodePath.join(dir, 'objects', file.sha256))
    if (sha256(body) !== file.sha256) throw new NexgentError('internal', `rewind: the stored copy of ${change.path} is damaged`)
    await mkdir(nodePath.dirname(absolute), { recursive: true })
    await writeFile(absolute, body)
    if (process.platform !== 'win32') {
      const mode = (await stat(absolute)).mode & 0o7777
      await chmod(absolute, file.executable === true ? mode | 0o111 : mode & ~0o111)
    }
  }
}
