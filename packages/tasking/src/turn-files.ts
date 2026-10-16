/**
 * `TurnFileTracker`: which project files a turn added, modified or deleted,
 * without walking the tree at turn start.
 *
 * - `beginTurn` only records the start time (and, when a baseline provider is
 *   configured, the paths of the latest task snapshot).
 * - Paths that write tools (`write_file`, `str_replace`) report in their
 *   `meta` are changes of the turn. `meta.created: true` marks an added file,
 *   `meta.deleted: true` a deleted one.
 * - When a shell-like tool ran in the turn (`bash`, `pwsh`, `run_code`, or any
 *   tool whose observed `effects` include `execute`), `endTurn` walks the
 *   tree once (`lstat` only, `.gitignore` honoured, never descending into
 *   ignored directories) and reports files whose mtime or ctime is at or
 *   after the turn start. Such a file is `added` when its birth time is at or
 *   after the start (less the clock-skew allowance) (file systems without a birth time report `modified`),
 *   otherwise `modified`. A shell-made deletion is only found when a baseline
 *   is available: a path of the baseline that the complete walk no longer
 *   finds.
 *
 * One tracker serves every session of the project. Write-tool reports are
 * remembered project-wide for a short time (path to session), so a scan at
 * the end of session A's turn does not attribute to A a file that session B's
 * write tool reported in the overlapping window. A shell change nobody
 * reported goes to every session whose shell tool ran in the window, and to
 * nobody when none did.
 */
import { lstat } from 'node:fs/promises'
import * as nodePath from 'node:path'
import { isInsideRoot, toPortablePath, type FileChange, type ToolCallObservation, type TurnFileTracker } from '@nexgent/kernel'
import { realpathNative } from './files-util.js'
import { walkProject } from './project-walk.js'
import { isInDataDir } from './project-paths.js'

/** Directory names skipped at any depth. */
export const IGNORED_DIR_NAMES: readonly string[] = ['node_modules', '.git']

/** Tools whose `meta.path` names a file they wrote (read tools report paths too, so the name decides). */
export const WRITE_TOOL_NAMES: readonly string[] = ['write_file', 'str_replace']

/** Tools that may write anywhere (the fallback when an observation carries no `effects`). */
export const SHELL_TOOL_NAMES: readonly string[] = ['bash', 'pwsh', 'run_code']

/** Default cap on entries one scan records; beyond it the scan reports itself incomplete. */
export const DEFAULT_SCAN_LIMIT = 200_000

/** Timestamps up to this far before the turn start still count (coarse file-system clocks). */
export const CLOCK_SKEW_MS = 5

/** Options of {@link LocalTurnFileTracker}. */
export interface LocalTurnFileTrackerOptions {
  /** Max entries per scan (default {@link DEFAULT_SCAN_LIMIT}). */
  readonly scanLimit?: number
  /**
   * The project-relative paths known at turn start (the latest task
   * snapshot's index), read once in `beginTurn`. Only with it can a
   * shell-made deletion be reported. `undefined` means no baseline.
   */
  readonly baseline?: () => Promise<ReadonlySet<string> | undefined>
  /** Wall clock in ms (tests pin it; default `Date.now`). */
  readonly clock?: () => number
}

/** An observation as the kernel may extend it: the observed tool's declared effects. */
type Observation = ToolCallObservation & { readonly effects?: readonly string[] }

interface Touch {
  deleted: boolean
  created: boolean
}

interface OpenTurn {
  readonly sessionId: string
  readonly startedAtMs: number
  readonly baseline: ReadonlySet<string> | undefined
  /** Portable paths this session's write tools reported. */
  readonly touched: Map<string, Touch>
  shell: boolean
}

function ignoredName(name: string): boolean {
  const lower = process.platform === 'win32' ? name.toLowerCase() : name
  return IGNORED_DIR_NAMES.includes(lower)
}

/** Whether a portable project path is outside what the tracker reports (not `.gitignore`-aware). */
export function isIgnoredPath(portable: string): boolean {
  if (portable === '' || isInDataDir(portable)) return true
  const segments = portable.split('/')
  return segments.slice(0, -1).some(ignoredName)
}

function isShellLike(observation: Observation): boolean {
  return observation.effects !== undefined ? observation.effects.includes('execute') : SHELL_TOOL_NAMES.includes(observation.name)
}

/** Tracks per-turn file changes of one project. */
export class LocalTurnFileTracker implements TurnFileTracker {
  private readonly turns = new Map<string, OpenTurn>()
  /** Project-wide: who a write tool reported a path for, and when. */
  private readonly owners = new Map<string, { sessionId: string; at: number }>()
  private readonly scanLimit: number
  private readonly clock: () => number
  private realRoot: string | undefined

  constructor(private readonly root: string, private readonly options: LocalTurnFileTrackerOptions = {}) {
    this.scanLimit = options.scanLimit ?? DEFAULT_SCAN_LIMIT
    this.clock = options.clock ?? Date.now
  }

  async beginTurn(sessionId: string, turn: number): Promise<void> {
    let baseline: ReadonlySet<string> | undefined
    try {
      baseline = await this.options.baseline?.()
    } catch {
      baseline = undefined
    }
    this.turns.set(key(sessionId, turn), { sessionId, startedAtMs: this.clock(), baseline, touched: new Map(), shell: false })
  }

  observe(observation: ToolCallObservation): void {
    const open = this.turns.get(key(observation.sessionId, observation.turn))
    if (open === undefined || observation.isError) return
    if (isShellLike(observation as Observation)) open.shell = true
    if (!WRITE_TOOL_NAMES.includes(observation.name)) return
    const flags = metaFlags(observation.meta)
    for (const absolute of metaPaths(observation.meta)) {
      const portable = this.toPortable(absolute)
      if (portable === undefined || isIgnoredPath(portable)) continue
      const touch = open.touched.get(portable) ?? { deleted: false, created: false }
      touch.deleted = flags.deleted
      touch.created = touch.created || flags.created
      open.touched.set(portable, touch)
      this.owners.set(portable, { sessionId: observation.sessionId, at: this.clock() })
    }
  }

  async endTurn(sessionId: string, turn: number, signal?: AbortSignal): Promise<readonly FileChange[]> {
    const id = key(sessionId, turn)
    const open = this.turns.get(id)
    this.turns.delete(id)
    if (open === undefined) return []
    const changes = new Map<string, FileChange['change']>()

    for (const [reported, touch] of open.touched) {
      const stat = await this.lstatOf(reported)
      if (stat === undefined) {
        if (touch.deleted || open.baseline?.has(reported) === true) changes.set(reported, 'deleted')
        continue
      }
      const path = await this.canonical(reported)
      changes.set(path, touch.created || (stat.birthtimeMs > 0 && stat.birthtimeMs >= open.startedAtMs - CLOCK_SKEW_MS) ? 'added' : 'modified')
    }

    if (open.shell && signal?.aborted !== true) await this.scanShellChanges(open, changes, signal)

    this.pruneOwners()
    return [...changes.entries()]
      .map(([path, change]) => ({ path, change }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  }

  /** Forget open turns (e.g. after a crash-restart of the host object). */
  reset(): void {
    this.turns.clear()
    this.owners.clear()
  }

  private async scanShellChanges(open: OpenTurn, changes: Map<string, FileChange['change']>, signal: AbortSignal | undefined): Promise<void> {
    const root = await this.realRootPath()
    if (root === undefined) return
    const since = open.startedAtMs - CLOCK_SKEW_MS
    const reportedByOthers = (path: string): boolean => {
      const owner = this.owners.get(path)
      return owner !== undefined && owner.sessionId !== open.sessionId && owner.at >= since
    }
    const walked = await walkProject(root, { limit: this.scanLimit, symlinks: true, ...(signal === undefined ? {} : { signal }) })
    const present = open.baseline === undefined || !walked.complete ? undefined : new Set<string>()
    for (const file of walked.files) {
      present?.add(file.path)
      if (changes.has(file.path) || reportedByOthers(file.path)) continue
      if (Math.max(file.mtimeMs, file.ctimeMs) < since) continue
      changes.set(file.path, file.birthtimeMs > 0 && file.birthtimeMs >= since ? 'added' : 'modified')
    }
    if (present === undefined || open.baseline === undefined) return
    for (const path of open.baseline) {
      if (present.has(path) || changes.has(path) || reportedByOthers(path) || isIgnoredPath(path)) continue
      if ((await this.lstatOf(path)) === undefined) changes.set(path, 'deleted')
    }
  }

  /** Drop owner entries no open turn could still need. */
  private pruneOwners(): void {
    let oldest = Number.POSITIVE_INFINITY
    for (const open of this.turns.values()) oldest = Math.min(oldest, open.startedAtMs)
    const floor = oldest - CLOCK_SKEW_MS
    for (const [path, owner] of this.owners) if (owner.at < floor) this.owners.delete(path)
  }

  private toPortable(absolute: string): string | undefined {
    const root = this.realRoot ?? this.root
    for (const base of [root, this.root]) {
      if (isInsideRoot(base, absolute)) return toPortablePath(nodePath.relative(base, absolute))
    }
    return undefined
  }

  private async realRootPath(): Promise<string | undefined> {
    if (this.realRoot === undefined) {
      try {
        this.realRoot = await realpathNative(this.root)
      } catch {
        return undefined
      }
    }
    return this.realRoot
  }

  private async lstatOf(portable: string): Promise<{ birthtimeMs: number } | undefined> {
    const root = (await this.realRootPath()) ?? this.root
    try {
      return await lstat(nodePath.join(root, ...portable.split('/')))
    } catch {
      return undefined
    }
  }

  /** On case-insensitive file systems a tool may report another letter case than the disk has; use the disk's. */
  private async canonical(portable: string): Promise<string> {
    if (process.platform !== 'win32' && process.platform !== 'darwin') return portable
    const root = (await this.realRootPath()) ?? this.root
    try {
      const real = await realpathNative(nodePath.join(root, ...portable.split('/')))
      return isInsideRoot(root, real) ? toPortablePath(nodePath.relative(root, real)) : portable
    } catch {
      return portable
    }
  }
}

function key(sessionId: string, turn: number): string {
  return `${sessionId}#${turn}`
}

function metaFlags(meta: unknown): { deleted: boolean; created: boolean } {
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return { deleted: false, created: false }
  const record = meta as Record<string, unknown>
  return { deleted: record.deleted === true, created: record.created === true }
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
