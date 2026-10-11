/**
 * `TurnFileTracker`: which project files a turn added, modified or deleted.
 * Two sources are combined: the paths file tools report in their `meta`, and
 * a before/after scan of the project (so changes made through `bash` /
 * `pwsh` are found too). `.nexgent/` at the root and every `node_modules/`
 * and `.git/` directory are skipped.
 */
import { lstat, readdir } from 'node:fs/promises'
import * as nodePath from 'node:path'
import { isInsideRoot, toPortablePath, type FileChange, type ToolCallObservation, type TurnFileTracker } from '@nexgent/kernel'
import { isNotFound, realpathNative } from './files-util.js'
import { isInDataDir } from './project-paths.js'

/** Directory names skipped at any depth. */
export const IGNORED_DIR_NAMES: readonly string[] = ['node_modules', '.git']

/** Tools whose `meta.path` names a file they wrote (read tools report paths too, so the name decides). */
export const WRITE_TOOL_NAMES: readonly string[] = ['write_file', 'str_replace']

/** Default cap on entries one scan records; beyond it the scan reports itself incomplete. */
export const DEFAULT_SCAN_LIMIT = 200_000

/** Options of {@link LocalTurnFileTracker}. */
export interface LocalTurnFileTrackerOptions {
  /** Max entries per scan (default {@link DEFAULT_SCAN_LIMIT}). */
  readonly scanLimit?: number
}

/** A file's identity for change detection: type, size and modification / change times in ns. */
type Signature = string

interface Scan {
  readonly files: Map<string, Signature>
  /** `false` when the scan stopped early (limit or abort). */
  readonly complete: boolean
}

interface OpenTurn {
  readonly before: Scan | undefined
  /** Portable paths file tools reported touching. */
  readonly touched: Set<string>
}

function ignoredName(name: string): boolean {
  const lower = process.platform === 'win32' ? name.toLowerCase() : name
  return IGNORED_DIR_NAMES.includes(lower)
}

/** Whether a portable project path is outside what the tracker reports. */
export function isIgnoredPath(portable: string): boolean {
  if (portable === '' || isInDataDir(portable)) return true
  const segments = portable.split('/')
  return segments.slice(0, -1).some(ignoredName)
}

/** Tracks per-turn file changes of one project. */
export class LocalTurnFileTracker implements TurnFileTracker {
  private readonly turns = new Map<string, OpenTurn>()
  private readonly scanLimit: number
  private realRoot: string | undefined

  constructor(private readonly root: string, options: LocalTurnFileTrackerOptions = {}) {
    this.scanLimit = options.scanLimit ?? DEFAULT_SCAN_LIMIT
  }

  async beginTurn(sessionId: string, turn: number): Promise<void> {
    const before = await this.scan()
    this.turns.set(key(sessionId, turn), { before, touched: new Set() })
  }

  observe(observation: ToolCallObservation): void {
    if (observation.isError || !WRITE_TOOL_NAMES.includes(observation.name)) return
    const open = this.turns.get(key(observation.sessionId, observation.turn))
    if (open === undefined) return
    for (const absolute of metaPaths(observation.meta)) {
      const portable = this.toPortable(absolute)
      if (portable !== undefined && !isIgnoredPath(portable)) open.touched.add(portable)
    }
  }

  async endTurn(sessionId: string, turn: number, signal?: AbortSignal): Promise<readonly FileChange[]> {
    const id = key(sessionId, turn)
    const open = this.turns.get(id)
    this.turns.delete(id)
    if (open === undefined) return []
    const after = await this.scan(signal)
    const changes = new Map<string, FileChange['change']>()
    const before = open.before
    if (before !== undefined) {
      for (const [path, signature] of after.files) {
        const previous = before.files.get(path)
        if (previous === undefined) {
          // A file missing from an incomplete before-scan may simply not have been reached.
          if (before.complete || open.touched.has(path)) changes.set(path, 'added')
        } else if (previous !== signature) changes.set(path, 'modified')
      }
      for (const path of before.files.keys()) {
        if (after.files.has(path)) continue
        if (after.complete || !(await this.exists(path))) changes.set(path, 'deleted')
      }
    }
    for (const reported of open.touched) {
      const path = canonical(reported, after.files, before?.files)
      if (changes.has(path)) continue
      const existsNow = after.files.has(path) || (!after.complete && (await this.exists(path)))
      const existedBefore = before?.files.has(path)
      if (existsNow) changes.set(path, existedBefore === false && before?.complete === true ? 'added' : 'modified')
      else if (existedBefore === true) changes.set(path, 'deleted')
    }
    return [...changes.entries()]
      .map(([path, change]) => ({ path, change }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  }

  /** Forget open turns (e.g. after a crash-restart of the host object). */
  reset(): void {
    this.turns.clear()
  }

  private toPortable(absolute: string): string | undefined {
    const root = this.realRoot ?? this.root
    for (const base of [root, this.root]) {
      if (isInsideRoot(base, absolute)) return toPortablePath(nodePath.relative(base, absolute))
    }
    return undefined
  }

  private async exists(portable: string): Promise<boolean> {
    try {
      await lstat(nodePath.join(this.realRoot ?? this.root, ...portable.split('/')))
      return true
    } catch (error) {
      if (isNotFound(error)) return false
      return true
    }
  }

  private async scan(signal?: AbortSignal): Promise<Scan> {
    if (this.realRoot === undefined) {
      try {
        this.realRoot = await realpathNative(this.root)
      } catch {
        return { files: new Map(), complete: false }
      }
    }
    const root = this.realRoot
    const files = new Map<string, Signature>()
    const pending: string[] = ['']
    while (pending.length > 0) {
      if (signal?.aborted === true || files.size >= this.scanLimit) return { files, complete: false }
      const dir = pending.pop()!
      let entries
      try {
        entries = await readdir(dir === '' ? root : nodePath.join(root, ...dir.split('/')), { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        const portable = dir === '' ? entry.name : `${dir}/${entry.name}`
        if (entry.isDirectory()) {
          if (ignoredName(entry.name) || (dir === '' && isInDataDir(entry.name))) continue
          pending.push(portable)
          continue
        }
        try {
          const info = await lstat(nodePath.join(root, ...portable.split('/')), { bigint: true })
          const kind = info.isSymbolicLink() ? 'l' : info.isFile() ? 'f' : 'o'
          files.set(portable, `${kind}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`)
        } catch {
          // vanished between readdir and lstat
        }
      }
    }
    return { files, complete: true }
  }
}

/**
 * On case-insensitive file systems (Windows, macOS) a tool may report a path
 * in another letter case than the scan saw; use the scanned spelling.
 */
function canonical(path: string, ...scans: ReadonlyArray<ReadonlyMap<string, Signature> | undefined>): string {
  if (process.platform !== 'win32' && process.platform !== 'darwin') return path
  const lower = path.toLowerCase()
  for (const scan of scans) {
    if (scan === undefined) continue
    if (scan.has(path)) return path
    for (const candidate of scan.keys()) if (candidate.toLowerCase() === lower) return candidate
  }
  return path
}

function key(sessionId: string, turn: number): string {
  return `${sessionId}#${turn}`
}

/** Absolute paths a tool's `meta` names (`path`, or each string of `paths`). */
function metaPaths(meta: unknown): string[] {
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return []
  const record = meta as Record<string, unknown>
  const found: string[] = []
  if (typeof record.path === 'string' && nodePath.isAbsolute(record.path)) found.push(record.path)
  if (Array.isArray(record.paths)) {
    for (const path of record.paths) if (typeof path === 'string' && nodePath.isAbsolute(path)) found.push(path)
  }
  return found
}
