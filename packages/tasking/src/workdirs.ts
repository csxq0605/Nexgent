/**
 * Rework K4 D4: each member that may write works in its own copy of the
 * project (`ctx.workdirs`, see `MemberWorkdirs` in the kernel).
 *
 * - The copy is made when the member opens: the project files the snapshot
 *   walk sees (`.gitignore` honoured; `.git/` and the root `.nexgent/` left
 *   out). Dependency directories the walk skips (`node_modules/`, `.venv/`,
 *   `venv/`) are linked, not copied, so commands find installed packages.
 *   A project above {@link WORKDIR_MAX_BYTES} or {@link WORKDIR_MAX_FILES}
 *   gets no copy (the member works in the project directory, as before).
 * - The copies live in `<tmp>/nexgent-workdirs/<project key>/<sessionId>/`;
 *   the base content of every copied file is kept once per project in
 *   `objects/` (content-addressed), for three-way merges.
 * - At the end of each member turn {@link LocalMemberWorkdir.merge} brings
 *   what the member changed into the project, file by file against the base
 *   (the project as it was when the copy was last in sync):
 *   only the member changed it: written (or deleted) in the project;
 *   both changed it: merged line by line when both are text and the
 *   changes do not overlap, else a conflict: the project keeps its version
 *   and the member's is saved under `conflicts/<sessionId>/<n>/` for the
 *   parent to read. Merges of one project run one at a time.
 * - {@link LocalMemberWorkdir.refresh} (start of a member turn, and after
 *   each merge) brings files the project changed into the copy where the
 *   member has not changed them.
 *
 * A member of an agent that has its own copy (a thread) gets a copy of that
 * copy (`open({ from })`): it is made from it and merges back into it; the
 * thread merges into the project at the end of its own turn.
 *
 * Symbolic links are copied as links (not on Windows) and never merged.
 */
import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, readdir, readFile, readlink, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as nodePath from 'node:path'
import type { MemberWorkdir, MemberWorkdirs, SandboxMode, WorkdirConflict, WorkdirMerge } from '@nexgent/kernel'
import { MEMBER_WORKDIRS_DIR } from '@nexgent/kernel'
import { isNotFound } from './files-util.js'
import { mergeText } from './merge3.js'
import { walkProject } from './project-walk.js'

/** A project larger than this (bytes of copied files) gets no member copies. */
export const WORKDIR_MAX_BYTES = 200 * 1024 * 1024
/** A project with more files than this gets no member copies. */
export const WORKDIR_MAX_FILES = 20_000
/** Text files up to this size are merged line by line; larger ones conflict when both sides changed them. */
export const MERGE_MAX_TEXT_BYTES = 1024 * 1024
/** Skipped directories linked into a copy instead of copied (installed dependencies). */
export const LINKED_DIR_NAMES: readonly string[] = ['node_modules', '.venv', 'venv']
/** Copies and conflict copies older than this are removed when the next copy of the project is made. */
export const WORKDIR_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

/** Options of {@link LocalMemberWorkdirs}. */
export interface LocalMemberWorkdirsOptions {
  /** Default `<os.tmpdir()>/nexgent-workdirs`. */
  readonly base?: string
  readonly maxBytes?: number
  readonly maxFiles?: number
}

/** A file's content as compared: its hash and executable bit. */
interface FileState {
  readonly sha256: string
  readonly executable: boolean
}

/** A file's state as last seen, with the stat that lets an unchanged file skip hashing. */
interface Seen extends FileState {
  readonly size: number
  readonly mtimeMs: number
}

const sha256 = (body: Buffer): string => createHash('sha256').update(body).digest('hex')
const isWindows = process.platform === 'win32'
const executableOf = (mode: number): boolean => !isWindows && (mode & 0o111) !== 0

function same(a: FileState | undefined, b: FileState | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  return a.sha256 === b.sha256 && a.executable === b.executable
}

function abs(root: string, path: string): string {
  return nodePath.join(root, ...path.split('/'))
}

function isText(body: Buffer): boolean {
  if (body.length > MERGE_MAX_TEXT_BYTES || body.includes(0)) return false
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(body)
    return true
  } catch {
    return false
  }
}

async function setExecutable(path: string, executable: boolean): Promise<void> {
  if (isWindows) return
  const mode = (await stat(path)).mode & 0o7777
  const next = executable ? mode | 0o111 : mode & ~0o111
  if (next !== mode) await chmod(path, next)
}

/** Write `body` at `path` (parents created), with the executable bit. */
async function put(path: string, body: Buffer, executable: boolean): Promise<void> {
  await mkdir(nodePath.dirname(path), { recursive: true })
  await writeFile(path, body)
  await setExecutable(path, executable)
}

/**
 * The current state of every regular file below `root` the walk sees,
 * hashing only files whose size or mtime differ from `cache` (updated in
 * place).
 */
async function scan(root: string, cache: Map<string, Seen>): Promise<Map<string, Seen>> {
  const { files } = await walkProject(root)
  const now = new Map<string, Seen>()
  for (const file of files) {
    if (file.symlink) continue
    const known = cache.get(file.path)
    const executable = executableOf(file.mode)
    if (known !== undefined && known.size === file.size && known.mtimeMs === file.mtimeMs && known.executable === executable) {
      now.set(file.path, known)
      continue
    }
    let body: Buffer
    try {
      body = await readFile(abs(root, file.path))
    } catch (error) {
      if (isNotFound(error)) continue
      throw error
    }
    now.set(file.path, { sha256: sha256(body), executable, size: file.size, mtimeMs: file.mtimeMs })
  }
  cache.clear()
  for (const [path, seen] of now) cache.set(path, seen)
  return now
}

/** The stat of a file just written, as {@link Seen}. */
async function seenAfterWrite(path: string, state: FileState): Promise<Seen> {
  const info = await stat(path)
  return { ...state, size: info.size, mtimeMs: info.mtimeMs }
}

/** `ctx.workdirs` for one project. */
export class LocalMemberWorkdirs implements MemberWorkdirs {
  private readonly options: Required<Omit<LocalMemberWorkdirsOptions, 'base'>> & { readonly base: string }
  /** Merges and refreshes of this project, one at a time. */
  private queue: Promise<unknown> = Promise.resolve()
  private pruned = false

  constructor(private readonly projectRoot: string, options: LocalMemberWorkdirsOptions = {}) {
    this.options = {
      base: options.base ?? nodePath.join(tmpdir(), MEMBER_WORKDIRS_DIR),
      maxBytes: options.maxBytes ?? WORKDIR_MAX_BYTES,
      maxFiles: options.maxFiles ?? WORKDIR_MAX_FILES,
    }
  }

  /** Run `work` after every earlier merge or refresh of this project. */
  serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work)
    this.queue = run.catch(() => undefined)
    return run
  }

  async open(input: { readonly sessionId: string; readonly sandboxMode: SandboxMode; readonly from?: MemberWorkdir }): Promise<MemberWorkdir | undefined> {
    if (input.sandboxMode === 'read-only' || !/^[A-Za-z0-9-]+$/.test(input.sessionId)) return undefined
    // A member of a thread copies the thread's copy and merges back into it.
    const project = await realpath(input.from?.root ?? this.projectRoot)
    const key = sha256(Buffer.from(project)).slice(0, 16)
    await mkdir(this.options.base, { recursive: true })
    const home = nodePath.join(await realpath(this.options.base), key)
    if (!this.pruned) {
      this.pruned = true
      await prune(home).catch(() => undefined)
    }
    const skipped: string[] = []
    const { files, complete } = await walkProject(project, { symlinks: !isWindows, limit: this.options.maxFiles + 1, onSkippedDir: path => skipped.push(path) })
    if (!complete || files.length > this.options.maxFiles) return undefined
    if (files.reduce((sum, file) => sum + (file.symlink ? 0 : file.size), 0) > this.options.maxBytes) return undefined
    const root = nodePath.join(home, input.sessionId)
    await rm(root, { recursive: true, force: true })
    await mkdir(root, { recursive: true })
    const objects = nodePath.join(home, 'objects')
    await mkdir(objects, { recursive: true })
    const workdir = new LocalMemberWorkdir(this, project, root, objects, nodePath.join(home, 'conflicts', input.sessionId))
    try {
      await this.serial(() => workdir.copyIn(files, skipped))
    } catch (error) {
      await rm(root, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
    return workdir
  }
}

/** Remove copies and conflict copies of a project not touched for {@link WORKDIR_RETENTION_MS}. */
async function prune(home: string): Promise<void> {
  const cutoff = Date.now() - WORKDIR_RETENTION_MS
  const old = async (dir: string) => {
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      return
    }
    for (const name of names) {
      const path = nodePath.join(dir, name)
      const info = await lstat(path).catch(() => undefined)
      if (info !== undefined && info.isDirectory() && info.mtimeMs < cutoff) await rm(path, { recursive: true, force: true }).catch(() => undefined)
    }
  }
  for (const name of await readdir(home).catch(() => [] as string[])) {
    if (name === 'objects') continue
    if (name === 'conflicts') await old(nodePath.join(home, name))
    else {
      const path = nodePath.join(home, name)
      const info = await lstat(path).catch(() => undefined)
      if (info !== undefined && info.isDirectory() && info.mtimeMs < cutoff) await rm(path, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}

/** One member's copy. */
export class LocalMemberWorkdir implements MemberWorkdir {
  /** The project as it was when the copy was last in sync, by path. */
  private readonly base = new Map<string, FileState>()
  private readonly projectSeen = new Map<string, Seen>()
  private readonly copySeen = new Map<string, Seen>()
  private merges = 0
  private closed = false

  constructor(
    private readonly owner: LocalMemberWorkdirs,
    private readonly project: string,
    readonly root: string,
    private readonly objects: string,
    private readonly conflictDir: string,
  ) {}

  /** Copy the walked files and link the skipped dependency directories (inside the owner's queue). */
  async copyIn(files: Awaited<ReturnType<typeof walkProject>>['files'], skipped: readonly string[]): Promise<void> {
    for (const file of files) {
      const from = abs(this.project, file.path)
      const to = abs(this.root, file.path)
      if (file.symlink) {
        try {
          await mkdir(nodePath.dirname(to), { recursive: true })
          await symlink(await readlink(from), to)
        } catch {
          // A link that cannot be copied is left out.
        }
        continue
      }
      let body: Buffer
      try {
        body = await readFile(from)
      } catch (error) {
        if (isNotFound(error)) continue
        throw error
      }
      const state: FileState = { sha256: sha256(body), executable: executableOf(file.mode) }
      await this.keep(state.sha256, body)
      await put(to, body, state.executable)
      this.base.set(file.path, state)
      this.projectSeen.set(file.path, { ...state, size: file.size, mtimeMs: file.mtimeMs })
      this.copySeen.set(file.path, await seenAfterWrite(to, state))
    }
    for (const dir of skipped) {
      if (!LINKED_DIR_NAMES.includes(nodePath.posix.basename(dir))) continue
      const to = abs(this.root, dir)
      try {
        await mkdir(nodePath.dirname(to), { recursive: true })
        await symlink(abs(this.project, dir), to, isWindows ? 'junction' : 'dir')
      } catch {
        // Without the link the member reinstalls what it needs.
      }
    }
  }

  /** Store a base body once per project. */
  private async keep(digest: string, body: Buffer): Promise<void> {
    const path = nodePath.join(this.objects, digest)
    try {
      await stat(path)
    } catch {
      const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}`
      await writeFile(temp, body)
      await rename(temp, path).catch(() => rm(temp, { force: true }))
    }
  }

  private async baseBody(state: FileState): Promise<Buffer | undefined> {
    try {
      const body = await readFile(nodePath.join(this.objects, state.sha256))
      return sha256(body) === state.sha256 ? body : undefined
    } catch {
      return undefined
    }
  }

  refresh(): Promise<void> {
    return this.owner.serial(() => this.refreshNow())
  }

  merge(): Promise<WorkdirMerge> {
    return this.owner.serial(async () => {
      const result = await this.mergeNow()
      await this.refreshNow()
      return result
    })
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.owner.serial(() => rm(this.root, { recursive: true, force: true }))
  }

  /** Copy into the copy every file the project changed since the last sync that the member left alone. */
  private async refreshNow(): Promise<void> {
    if (this.closed) return
    const project = await scan(this.project, this.projectSeen)
    const copy = await scan(this.root, this.copySeen)
    for (const path of new Set([...this.base.keys(), ...project.keys()])) {
      const before = this.base.get(path)
      const now = project.get(path)
      if (same(now, before) || !same(copy.get(path), before)) continue
      const target = abs(this.root, path)
      if (now === undefined) {
        await rm(target, { force: true })
        this.copySeen.delete(path)
        this.base.delete(path)
        continue
      }
      let body: Buffer
      try {
        body = await readFile(abs(this.project, path))
      } catch (error) {
        if (isNotFound(error)) continue
        throw error
      }
      const state: FileState = { sha256: sha256(body), executable: now.executable }
      await this.keep(state.sha256, body)
      await put(target, body, state.executable)
      this.copySeen.set(path, await seenAfterWrite(target, state))
      this.base.set(path, state)
    }
  }

  private async mergeNow(): Promise<WorkdirMerge> {
    const applied: string[] = []
    const merged: string[] = []
    const conflicts: WorkdirConflict[] = []
    if (this.closed) return { applied, merged, conflicts }
    const project = await scan(this.project, this.projectSeen)
    const copy = await scan(this.root, this.copySeen)
    const paths = [...new Set([...this.base.keys(), ...copy.keys()])].sort()
    let conflictRun: string | undefined
    for (const path of paths) {
      const before = this.base.get(path)
      const theirs = copy.get(path)
      if (same(theirs, before)) continue
      const ours = project.get(path)
      const target = abs(this.project, path)
      if (same(ours, before)) {
        // Only the member changed it.
        if (theirs === undefined) {
          await rm(target, { force: true })
          this.projectSeen.delete(path)
          this.base.delete(path)
        } else {
          const body = await readFile(abs(this.root, path))
          await this.keep(theirs.sha256, body)
          await put(target, body, theirs.executable)
          this.projectSeen.set(path, await seenAfterWrite(target, theirs))
          this.base.set(path, theirs)
        }
        applied.push(path)
        continue
      }
      if (same(ours, theirs)) {
        // Both made the same change.
        if (theirs === undefined) this.base.delete(path)
        else this.base.set(path, theirs)
        continue
      }
      if (before !== undefined && ours !== undefined && theirs !== undefined) {
        const text = await this.mergeBoth(path, before, ours, theirs)
        if (text !== undefined) {
          applied.push(path)
          merged.push(path)
          continue
        }
      }
      // A conflict: the project keeps its version; the member's is kept aside.
      let kept: string | undefined
      if (theirs !== undefined) {
        conflictRun ??= nodePath.join(this.conflictDir, String(++this.merges))
        kept = abs(conflictRun, path)
        await put(kept, await readFile(abs(this.root, path)), theirs.executable)
      }
      conflicts.push({
        path,
        kind: theirs === undefined ? 'deleted-by-member' : ours === undefined ? 'deleted-in-project' : 'both-changed',
        ...(kept === undefined ? {} : { copy: kept }),
      })
      // The copy now counts as in sync with the member's version, so the refresh gives it the project's.
      if (theirs === undefined) this.base.delete(path)
      else this.base.set(path, theirs)
    }
    return { applied, merged, conflicts }
  }

  /** Line-merge a file both sides changed; writes the result to both and returns it, or `undefined` when they overlap. */
  private async mergeBoth(path: string, before: FileState, ours: FileState, theirs: FileState): Promise<string | undefined> {
    if (ours.executable !== theirs.executable && ours.executable !== before.executable && theirs.executable !== before.executable) return undefined
    const [baseBody, ourBody, theirBody] = await Promise.all([this.baseBody(before), readFile(abs(this.project, path)), readFile(abs(this.root, path))])
    if (baseBody === undefined || !isText(baseBody) || !isText(ourBody) || !isText(theirBody)) return undefined
    const text = mergeText(baseBody.toString('utf8'), ourBody.toString('utf8'), theirBody.toString('utf8'))
    if (text === undefined) return undefined
    const body = Buffer.from(text, 'utf8')
    const executable = ours.executable !== before.executable ? ours.executable : theirs.executable
    const state: FileState = { sha256: sha256(body), executable }
    await this.keep(state.sha256, body)
    const target = abs(this.project, path)
    await put(target, body, executable)
    this.projectSeen.set(path, await seenAfterWrite(target, state))
    const own = abs(this.root, path)
    await put(own, body, executable)
    this.copySeen.set(path, await seenAfterWrite(own, state))
    this.base.set(path, state)
    return text
  }
}
