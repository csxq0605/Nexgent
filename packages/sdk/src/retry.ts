/**
 * "Try another way": redo a conversation's latest task in a copy of the
 * project with another organization, then let the user keep either result.
 *
 * - The copy starts from the snapshot taken before the task's turn and runs
 *   in its own process (the replay entry). It asks nobody anything:
 *   approvals are denied. Its cost cap is the project's per-task cap.
 * - The organization is chosen by the organization library: alone when the
 *   task had a team, otherwise the team organization tried least on similar
 *   tasks. There is no setting.
 * - Keeping the new result writes the copy's state of every file the task or
 *   the copy changed into the project, after backing those files up; "undo"
 *   puts the backups back while nothing has changed them since.
 * - The choice goes to the organization library: the side kept went well,
 *   the other one is marked reworked.
 *
 * Records live in `<dataDir>/retries/<retryId>.json`, the copy and the
 * backups in `<dataDir>/retries/<retryId>/`.
 */
import { createHash, randomUUID } from 'node:crypto'
import { chmod, cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  OrganizationLibrary,
  prepareReplayProject,
  processReplayRunner,
  type ReplayCase,
  type ReplayRunResult,
} from '@nexgent/capabilities'
import {
  BASELINE_VERSION,
  NexgentError,
  resolveWorkspaceLayout,
  RETRY_ORGANIZATION_FILE,
  SNAPSHOTS_DIR,
  type OrganizationName,
  type RetryOrganization,
  type SessionRecord,
  type TaskSnapshotRecord,
  type WorkspaceLayout,
} from '@nexgent/kernel'
import { JsonlSessionStore } from '@nexgent/session'
import { historyItems, withTurnCosts } from './history.js'

/** How a side of a retry was organized. */
export interface RetrySide {
  readonly decision: 'solo' | 'team'
  /** The team's organization, when known. */
  readonly organization?: OrganizationName
}

/** One file the copy changed against the task's starting point. */
export interface RetryFileChange {
  /** Project-relative, `/`-separated. */
  readonly path: string
  readonly change: 'added' | 'changed' | 'deleted'
}

/**
 * A retry's state. `running`: the copy is working; `ready`: it finished and
 * waits for the user's choice; `failed` / `stopped`: it ended without a
 * result to choose; `kept-original`, `applied` (the new result is in the
 * project) and `undone` (it was put back) are the user's choices.
 */
export type RetryStatus = 'running' | 'ready' | 'failed' | 'stopped' | 'kept-original' | 'applied' | 'undone'

/** What `retries.*` return. */
export interface RetryView {
  readonly retryId: string
  readonly sessionId: string
  /** The task's turn that was redone. */
  readonly turn: number
  readonly status: RetryStatus
  readonly startedAt: string
  readonly endedAt?: string
  readonly original: {
    readonly side: RetrySide
    /** Estimated dollars of the turn (members included). */
    readonly usd: number
    /** Files the turn changed. */
    readonly files: readonly string[]
  }
  readonly retry: {
    readonly side: RetrySide
    readonly usd?: number
    readonly files?: readonly RetryFileChange[]
    /** The copy's last reply (shortened). */
    readonly reply?: string
    /** Why it failed, in a few words. */
    readonly detail?: string
  }
  /** With `applied`: whether "undo" can still put the files back. */
  readonly undoable?: boolean
}

/** What `retries.get` returns for a conversation. */
export interface RetryState {
  /** Present when the latest task can be redone now. */
  readonly offer?: { readonly turn: number; readonly side: RetrySide; readonly estimateUsd: number }
  /** The conversation's latest retry. */
  readonly latest?: RetryView
}

/** The longest a retry copy may work. */
export const RETRY_TIMEOUT_MS = 4 * 60 * 60 * 1000
/** Characters of the copy's reply kept. */
const REPLY_CHARS = 2_000
/** Directories left out when comparing the copy with its start. */
const SKIPPED_DIRS = new Set(['.nexgent', '.git', 'node_modules'])

interface StoredRetry extends RetryView {
  readonly text: string
  readonly projectRoot: string
  readonly copyRoot?: string
  /** With `applied`: each written path and its content hash now (`null`: deleted). */
  readonly applied?: readonly { readonly path: string; readonly sha256: string | null; readonly existed: boolean }[]
  readonly libraryRunId?: string
}

/** What a {@link RetryManager} needs from its host. */
export interface RetryManagerOptions {
  readonly layout: WorkspaceLayout
  /** Every record of a session. */
  readonly records: (sessionId: string) => Promise<readonly SessionRecord[]>
  /** Whether a turn of the session is running. */
  readonly busy: (sessionId: string) => boolean
  /** The user's organization library (absent: built-in choice, nothing recorded). */
  readonly organizations?: OrganizationLibrary
  /** The replay entry: `node <entry> replay`. */
  readonly entry: string
  /** Environment of the copy's process. */
  readonly env: NodeJS.ProcessEnv
  readonly emit: (sessionId: string, view: RetryView) => void
  readonly now?: () => Date
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

function publicView(stored: StoredRetry): RetryView {
  const { text: _text, projectRoot: _root, copyRoot: _copy, applied: _applied, libraryRunId: _run, ...view } = stored
  return view
}

function safePath(root: string, path: string): string {
  const parts = path.split('/')
  if (path === '' || parts.some(part => part === '' || part === '.' || part === '..') || /^[a-zA-Z]:/.test(path) || path.startsWith('/')) {
    throw new NexgentError('internal', `retry: not a project path: ${path}`)
  }
  return join(root, ...parts)
}

async function fileHash(absolute: string): Promise<string | null> {
  try {
    return sha256(await readFile(absolute))
  } catch {
    return null
  }
}

/** The snapshot taken before `turn` of `sessionId`. */
async function findSnapshot(dataDir: string, sessionId: string, turn: number): Promise<TaskSnapshotRecord | undefined> {
  const dir = join(dataDir, SNAPSHOTS_DIR, 'tasks')
  for (const name of (await readdir(dir).catch(() => [] as string[])).filter(entry => entry.endsWith(`.t${turn}.json`))) {
    try {
      const record = JSON.parse(await readFile(join(dir, name), 'utf8')) as TaskSnapshotRecord
      if (record.sessionId === sessionId && record.turn === turn) return record
    } catch {
      // not this one
    }
  }
  return undefined
}

/** Files under `root` with their hashes (skipping {@link SKIPPED_DIRS}). */
async function treeHashes(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const visit = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) await visit(join(directory, entry.name), path)
      } else if (entry.isFile()) {
        const bytes = await readFile(join(directory, entry.name)).catch(() => undefined)
        if (bytes !== undefined) out.set(path, sha256(bytes))
      }
    }
  }
  await visit(root, '')
  return out
}

/** Pure: what the copy changed against the files it started from. */
export function diffTrees(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): RetryFileChange[] {
  const out: RetryFileChange[] = []
  for (const [path, hash] of after) {
    if (!before.has(path)) out.push({ path, change: 'added' })
    else if (before.get(path) !== hash) out.push({ path, change: 'changed' })
  }
  for (const path of before.keys()) if (!after.has(path) && !path.startsWith('.nexgent/')) out.push({ path, change: 'deleted' })
  return out.sort((l, r) => (l.path < r.path ? -1 : l.path > r.path ? 1 : 0))
}

/**
 * Pure: the message the copy is given: the task's own text, after the
 * conversation's earlier requests (their results are already in the files).
 */
export function retryMessage(earlier: readonly string[], text: string): string {
  if (earlier.length === 0) return text
  return [
    'Earlier requests in this conversation (already done; their results are in the project files):',
    ...earlier.map(request => `- ${request.replace(/\s+/g, ' ').slice(0, 500)}`),
    '',
    'Now do this request:',
    text,
  ].join('\n')
}

/** What a session's latest task is, when it can be redone. */
interface LatestTask {
  readonly turn: number
  readonly text: string
  readonly earlier: readonly string[]
  readonly materialIds: readonly string[]
  readonly side: RetrySide
  readonly usd: number
  readonly files: readonly string[]
}

/** Pure: the session's latest turn when it is a finished user task the organizer decided (else `undefined`). */
export function latestTask(records: readonly SessionRecord[]): Omit<LatestTask, 'usd'> | undefined {
  let turn = 0
  for (const record of records) if (record.type === 'turn.start' && record.turn > turn) turn = record.turn
  if (turn === 0) return undefined
  const start = records.find(record => record.type === 'turn.start' && record.turn === turn)
  if (start?.type !== 'turn.start' || start.organization === undefined) return undefined
  if (!records.some(record => record.type === 'turn.end' && record.turn === turn)) return undefined
  const message = records.find(record => record.type === 'user.message' && record.turn === turn)
  if (message?.type !== 'user.message' || message.source !== 'user') return undefined
  const earlier = records.flatMap(record => (record.type === 'user.message' && record.source === 'user' && record.turn < turn ? [record.content] : []))
  let organization: OrganizationName | undefined
  for (const record of records) if (record.type === 'organization' && record.turn === turn) organization = record.name
  const files = [...new Set(records.flatMap(record => (record.type === 'turn.files' && record.turn === turn ? record.changes.map(change => change.path) : [])))].sort()
  return {
    turn,
    text: message.content,
    earlier,
    materialIds: message.materials ?? [],
    side: { decision: start.organization.decision, ...(organization === undefined ? {} : { organization }) },
    files,
  }
}

/** Retries of one open project. */
export class RetryManager {
  readonly #options: RetryManagerOptions
  readonly #dir: string
  readonly #running = new Map<string, AbortController>()
  readonly #now: () => Date

  constructor(options: RetryManagerOptions) {
    this.#options = options
    this.#dir = join(options.layout.dataDir, 'retries')
    this.#now = options.now ?? (() => new Date())
  }

  /** Stop every running copy (the SDK is closing). */
  dispose(): void {
    for (const controller of this.#running.values()) controller.abort()
  }

  async #read(retryId: string): Promise<StoredRetry> {
    if (typeof retryId !== 'string' || !/^[0-9a-f-]{36}$/.test(retryId)) throw new NexgentError('internal', 'retryId must be a retry id')
    let stored: StoredRetry
    try {
      stored = JSON.parse(await readFile(join(this.#dir, `${retryId}.json`), 'utf8')) as StoredRetry
    } catch (error) {
      throw new NexgentError('session/not-found', `no retry ${retryId}`, { cause: error })
    }
    // A copy that was working when Nexgent last closed did not finish.
    if (stored.status === 'running' && !this.#running.has(retryId)) {
      stored = await this.#write({ ...stored, status: 'stopped', endedAt: this.#now().toISOString(), retry: { ...stored.retry, detail: 'Nexgent was closed' } })
    }
    return stored
  }

  async #write(stored: StoredRetry): Promise<StoredRetry> {
    await mkdir(this.#dir, { recursive: true })
    const file = join(this.#dir, `${stored.retryId}.json`)
    await writeFile(`${file}.tmp`, `${JSON.stringify(stored, null, 2)}\n`)
    await rename(`${file}.tmp`, file)
    return stored
  }

  async #update(stored: StoredRetry): Promise<RetryView> {
    await this.#write(stored)
    const view = await this.#view(stored)
    this.#options.emit(stored.sessionId, view)
    return view
  }

  async #view(stored: StoredRetry): Promise<RetryView> {
    const view = publicView(stored)
    return stored.status === 'applied' ? { ...view, undoable: await this.#undoable(stored) } : view
  }

  async #latest(sessionId: string): Promise<StoredRetry | undefined> {
    let latest: StoredRetry | undefined
    for (const name of await readdir(this.#dir).catch(() => [] as string[])) {
      if (!name.endsWith('.json')) continue
      try {
        const stored = JSON.parse(await readFile(join(this.#dir, name), 'utf8')) as StoredRetry
        if (stored.sessionId === sessionId && (latest === undefined || stored.startedAt > latest.startedAt)) latest = stored
      } catch {
        // a torn record
      }
    }
    return latest === undefined ? undefined : this.#read(latest.retryId)
  }

  async #task(sessionId: string): Promise<LatestTask | undefined> {
    const records = await this.#options.records(sessionId)
    const task = latestTask(records)
    if (task === undefined) return undefined
    const start = records.find(record => record.type === 'session.start')
    const model = start?.type === 'session.start' ? start.model : ''
    const end = withTurnCosts(historyItems([...records]), [...records], model).find(item => item.kind === 'turn.end' && item.turn === task.turn)
    const usd = end?.kind === 'turn.end' ? end.cost?.usd ?? 0 : 0
    return { ...task, usd }
  }

  async #alternative(side: RetrySide, text: string): Promise<RetrySide> {
    const library = this.#options.organizations
    const chosen: RetryOrganization = library === undefined
      ? side.decision === 'team' ? { decision: 'solo' } : { decision: 'team', organization: 'lead-checker' }
      : await library.retryFor({ decision: side.decision, text })
    return { decision: chosen.decision, ...(chosen.organization === undefined ? {} : { organization: chosen.organization }) }
  }

  /** The conversation's offer and latest retry. */
  async state(sessionId: string): Promise<RetryState> {
    const latest = await this.#latest(sessionId)
    const task = this.#options.busy(sessionId) || latest?.status === 'running' ? undefined : await this.#task(sessionId)
    const snapshot = task === undefined ? undefined : await findSnapshot(this.#options.layout.dataDir, sessionId, task.turn)
    const offer = task === undefined || snapshot?.tree === undefined || snapshot.tree === null
      ? undefined
      : { turn: task.turn, side: await this.#alternative(task.side, task.text), estimateUsd: task.usd }
    return { ...(offer === undefined ? {} : { offer }), ...(latest === undefined ? {} : { latest: await this.#view(latest) }) }
  }

  /** Start redoing the conversation's latest task in a copy. */
  async start(sessionId: string): Promise<RetryView> {
    if (this.#options.busy(sessionId)) throw new NexgentError('session/locked', `a turn is running in session ${sessionId}`)
    const previous = await this.#latest(sessionId)
    if (previous?.status === 'running') throw new NexgentError('session/locked', 'this task is already being redone')
    const task = await this.#task(sessionId)
    if (task === undefined) throw new NexgentError('session/not-found', 'the latest task of this conversation cannot be redone')
    const snapshot = await findSnapshot(this.#options.layout.dataDir, sessionId, task.turn)
    if (snapshot?.tree === undefined || snapshot.tree === null) throw new NexgentError('session/not-found', `turn ${task.turn} has no snapshot to start from`)
    const side = await this.#alternative(task.side, task.text)
    const retryId = randomUUID()
    const stored: StoredRetry = {
      retryId,
      sessionId,
      turn: task.turn,
      status: 'running',
      startedAt: this.#now().toISOString(),
      original: { side: task.side, usd: task.usd, files: task.files },
      retry: { side },
      text: task.text,
      projectRoot: this.#options.layout.root,
    }
    const controller = new AbortController()
    this.#running.set(retryId, controller)
    const view = await this.#update(stored)
    const message = { text: retryMessage(task.earlier, task.text), ...(task.materialIds.length === 0 ? {} : { materialIds: task.materialIds }) }
    const replay = { caseId: sessionId, tree: snapshot.tree, takenAt: snapshot.takenAt, messages: [message], feedback: [] } as unknown as ReplayCase
    void this.#run(stored, replay, snapshot.capabilityVersion ?? BASELINE_VERSION, controller.signal).finally(() => this.#running.delete(retryId))
    return view
  }

  async #run(stored: StoredRetry, replay: ReplayCase, version: string, signal: AbortSignal): Promise<void> {
    let copyRoot: string | undefined
    try {
      const work = join(this.#dir, stored.retryId)
      await mkdir(work, { recursive: true })
      const copy = await prepareReplayProject({ layout: this.#options.layout, replay, version, budget: {}, tempRoot: work })
      copyRoot = copy.root
      const forced: RetryOrganization = { decision: stored.retry.side.decision, ...(stored.retry.side.organization === undefined ? {} : { organization: stored.retry.side.organization }) }
      await writeFile(join(resolveWorkspaceLayout(copy.root).dataDir, RETRY_ORGANIZATION_FILE), `${JSON.stringify(forced)}\n`)
      await this.#write({ ...stored, copyRoot })
      const runner = processReplayRunner({ args: [this.#options.entry, 'replay'], env: this.#options.env })
      const result: ReplayRunResult = await runner.run({
        trialId: stored.retryId,
        arm: 'candidate',
        set: 'selection',
        caseId: stored.sessionId,
        repeat: 1,
        projectRoot: copy.root,
        ledgersDir: this.#options.layout.ledgers,
        messages: replay.messages,
        timeoutMs: RETRY_TIMEOUT_MS,
      }, signal)
      const usd = typeof result.estimatedUsd === 'number' ? result.estimatedUsd : undefined
      const files = diffTrees(copy.files, await treeHashes(copy.root))
      const ran = await this.#copyRun(copy.root)
      const organization = stored.retry.side.decision === 'team' ? ran.organization ?? stored.retry.side.organization : undefined
      const side: RetrySide = { decision: stored.retry.side.decision, ...(organization === undefined ? {} : { organization }) }
      const ended = this.#now().toISOString()
      if (result.outcome === 'completed') {
        await this.#update({ ...stored, copyRoot, status: 'ready', endedAt: ended, retry: { side, files, ...(usd === undefined ? {} : { usd }), ...(ran.reply === undefined ? {} : { reply: ran.reply }) } })
        return
      }
      await this.#update({
        ...stored,
        status: result.outcome === 'cancelled' ? 'stopped' : 'failed',
        endedAt: ended,
        retry: { side, ...(usd === undefined ? {} : { usd }), detail: (result.detail ?? result.outcome).slice(0, 300) },
      })
      await this.#dropCopy(stored.retryId)
    } catch (error) {
      await this.#update({ ...stored, status: 'failed', endedAt: this.#now().toISOString(), retry: { ...stored.retry, detail: (error instanceof Error ? error.message : String(error)).slice(0, 300) } }).catch(() => undefined)
      await this.#dropCopy(stored.retryId)
    }
  }

  /** The copy's root session: its last reply and the organization it ran last. */
  async #copyRun(root: string): Promise<{ readonly reply?: string; readonly organization?: OrganizationName }> {
    const store = new JsonlSessionStore({ sessionsDir: resolveWorkspaceLayout(root).sessions })
    for (const id of await readdir(store.sessionsDir).catch(() => [] as string[])) {
      const records = (await store.readAll(id).catch(() => undefined))?.records
      const start = records?.find(record => record.type === 'session.start')
      if (records === undefined || start?.type !== 'session.start' || start.parentSessionId !== undefined) continue
      let reply: string | undefined
      let organization: OrganizationName | undefined
      for (const record of records) {
        if (record.type === 'assistant.message' && record.content.trim() !== '') reply = record.content.trim()
        if (record.type === 'organization') organization = record.name
      }
      return { ...(reply === undefined ? {} : { reply: reply.length > REPLY_CHARS ? `${reply.slice(0, REPLY_CHARS)}…` : reply }), ...(organization === undefined ? {} : { organization }) }
    }
    return {}
  }

  async #dropCopy(retryId: string): Promise<void> {
    const work = join(this.#dir, retryId)
    for (const name of await readdir(work).catch(() => [] as string[])) {
      if (name !== 'backup') await rm(join(work, name), { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined)
    }
  }

  /** Stop a running copy. */
  async stop(retryId: string): Promise<RetryView> {
    const stored = await this.#read(retryId)
    this.#running.get(retryId)?.abort()
    return this.#view(stored)
  }

  /** The user's choice on a finished copy. */
  async choose(retryId: string, keep: 'retry' | 'original'): Promise<RetryView> {
    if (keep !== 'retry' && keep !== 'original') throw new NexgentError('internal', 'keep must be retry or original')
    const stored = await this.#read(retryId)
    if (stored.status !== 'ready') throw new NexgentError('internal', `this retry is ${stored.status}, not waiting for a choice`)
    let next: StoredRetry
    if (keep === 'original') {
      next = { ...stored, status: 'kept-original' }
    } else {
      if (this.#options.busy(stored.sessionId)) throw new NexgentError('session/locked', `a turn is running in session ${stored.sessionId}`)
      const task = await this.#task(stored.sessionId)
      if (task?.turn !== stored.turn) throw new NexgentError('internal', 'the conversation has gone on since; the new result can no longer replace it')
      next = { ...stored, status: 'applied', applied: await this.#apply(stored, task.files) }
    }
    const library = this.#options.organizations
    const runId = library === undefined ? undefined : await library.noteRetry({
      sessionId: stored.sessionId,
      turn: stored.turn,
      text: stored.text,
      projectRoot: stored.projectRoot,
      retry: { decision: stored.retry.side.decision, ...(stored.retry.side.organization === undefined ? {} : { organization: { name: stored.retry.side.organization, roles: [] } }), completed: true, usd: stored.retry.usd ?? 0 },
      kept: keep,
    }).catch(() => undefined)
    const view = await this.#update({ ...next, ...(runId === undefined ? {} : { libraryRunId: runId }) })
    await this.#dropCopy(retryId)
    return view
  }

  /** Back up, then give every file the task or the copy changed its state in the copy. */
  async #apply(stored: StoredRetry, originalFiles: readonly string[]): Promise<NonNullable<StoredRetry['applied']>> {
    if (stored.copyRoot === undefined) throw new NexgentError('internal', 'the copy of this retry is gone')
    const root = this.#options.layout.root
    const backup = join(this.#dir, stored.retryId, 'backup')
    const paths = [...new Set([...originalFiles, ...(stored.retry.files ?? []).map(file => file.path)])].sort()
    const plan: { path: string; existed: boolean }[] = []
    for (const path of paths) {
      const target = safePath(root, path)
      const existed = (await stat(target).then(info => info.isFile(), () => false))
      if (existed) {
        await mkdir(dirname(safePath(backup, path)), { recursive: true })
        await cp(target, safePath(backup, path), { preserveTimestamps: true })
      }
      plan.push({ path, existed })
    }
    const applied: { path: string; sha256: string | null; existed: boolean }[] = []
    for (const { path, existed } of plan) {
      const source = safePath(stored.copyRoot, path)
      const target = safePath(root, path)
      const info = await stat(source).catch(() => undefined)
      if (info?.isFile() === true) {
        await mkdir(dirname(target), { recursive: true })
        await cp(source, target)
        if (process.platform !== 'win32') await chmod(target, info.mode & 0o7777)
        applied.push({ path, sha256: await fileHash(target), existed })
      } else {
        await rm(target, { force: true })
        applied.push({ path, sha256: null, existed })
      }
    }
    return applied
  }

  async #undoable(stored: StoredRetry): Promise<boolean> {
    if (stored.applied === undefined || this.#options.busy(stored.sessionId)) return false
    for (const file of stored.applied) {
      if (await fileHash(safePath(this.#options.layout.root, file.path)) !== file.sha256) return false
    }
    return true
  }

  /** Put back the files a kept retry replaced, while nothing has changed them since. */
  async undo(retryId: string): Promise<RetryView> {
    const stored = await this.#read(retryId)
    if (stored.status !== 'applied' || stored.applied === undefined) throw new NexgentError('internal', `this retry is ${stored.status}, nothing to undo`)
    if (!(await this.#undoable(stored))) throw new NexgentError('internal', 'the files have changed since; undo would overwrite those changes')
    const root = this.#options.layout.root
    const backup = join(this.#dir, retryId, 'backup')
    for (const file of stored.applied) {
      const target = safePath(root, file.path)
      if (file.existed) {
        await mkdir(dirname(target), { recursive: true })
        await cp(safePath(backup, file.path), target)
      } else {
        await rm(target, { force: true })
      }
    }
    if (stored.libraryRunId !== undefined) await this.#options.organizations?.noteRetryUndone({ runId: stored.libraryRunId }).catch(() => undefined)
    const view = await this.#update({ ...stored, status: 'undone' })
    await rm(backup, { recursive: true, force: true }).catch(() => undefined)
    return view
  }
}
