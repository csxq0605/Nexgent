/**
 * The in-process SDK (`createSdk`): one Cordis application per open project,
 * one kernel agent per open session, and an event fan-out that turns the
 * agents' events into {@link SdkEvent}s.
 *
 * Beyond {@link NexgentSdk} (what crosses IPC), {@link LocalNexgentSdk} has a
 * few in-process extras the CLI needs and the renderer never gets: the raw
 * kernel event stream, a model override on create, a sandbox override on
 * open, the cancel cause, and the turn's completion promise.
 *
 * Accounting: every turn the SDK starts ends with one `task.outcome` ledger
 * record of that turn alone (a turn = a task; `accept-step2` H19). The agent
 * is closed with `skipOutcome`, except that the kernel's own record for a
 * cost-cap stop stands and the SDK adds none for that turn.
 */
import { randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { mkdir, open, readdir, readFile, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import {
  addUsage,
  appendProjectGrant,
  isNexgentError,
  nexgentHome,
  NexgentError,
  resolveProjectConfig,
  toErrorInfo,
  UNKNOWN_USAGE,
  type Agent,
  type AgentEvent,
  type ApprovalDecision,
  type ApprovalRequest,
  type ApprovalResponder,
  type AppProfilePatchEntry,
  type ErrorInfo,
  type FeedbackEntry,
  type LLMUsage,
  type NexgentApp,
  type Plugin,
  type SandboxMode,
  type SessionRecord,
  type TaskOutcomeStatus,
  type TurnCancelCause,
  type TurnEndReason,
  type TurnResult,
  type UserMessageSource,
} from '@nexgent/kernel'
import { projectSession, SESSION_FILE_NAME } from '@nexgent/session'
import { createFeedbackEntry, materialAddedRecord, type LocalTaskingService } from '@nexgent/tasking'
import {
  SDK_API_VERSION,
  SDK_METHOD_NAMES,
  type CreateSdkOptions,
  type CreateSessionInput,
  type NexgentSdk,
  type ProjectInfo,
  type SdkEvent,
  type SdkInput,
  type SdkMethodName,
  type SdkMethods,
  type SdkResult,
  type SendMessageInput,
  type SessionSummary,
  type SessionView,
  type TurnHandle,
  type Unsubscribe,
} from './api.js'
import { bootProjectApp } from './boot.js'
import { writeExportBundle } from './export.js'
import { listProjectFiles } from './files.js'
import { historyItems, sessionSummary, turnUsage } from './history.js'
import { RecentProjects } from './recent.js'
import { describeApiKey, readSettings, secretValues, setApiKey, updateSettings, type CredentialEnv } from './settings.js'

/** `deliverables.readText` limit. */
export const READ_TEXT_MAX_BYTES = 1024 * 1024

/** Options of {@link createSdk}: the contract's plus in-process wiring. */
export interface LocalSdkOptions extends CreateSdkOptions {
  /** Environment for credentials, `NEXGENT_HOME`, `NEXGENT_API_BASE_URL`, the compaction threshold; default `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>
  /**
   * A host-side approval prompt (the CLI's TTY prompt). Absent: requests are
   * answered through `approvals.respond` after the `approval.request` event.
   */
  readonly approvalResponder?: ApprovalResponder
  /** Approval answer deadline in ms; absent waits until answered or the turn is cancelled. */
  readonly approvalTimeoutMs?: number
  /** Replace plugins by row name (tests: a scripted `@nexgent/llm`). */
  readonly registry?: Readonly<Record<string, Plugin>>
  /** Extra profile patches (applied after the SDK's own). */
  readonly patches?: readonly AppProfilePatchEntry[]
  /** Clock for recent projects and exports. */
  readonly now?: () => Date
}

/** A raw kernel event with the project it belongs to. */
export type ProjectAgentEvent = AgentEvent & { readonly projectId: string }

/** In-process turn input: a user message or a feedback turn. */
export type StartTurnInput =
  | (SendMessageInput & { readonly source?: 'user' })
  | { readonly source: 'feedback'; readonly projectId: string; readonly sessionId: string; readonly feedback: FeedbackEntry; readonly materialIds?: readonly string[] }

/** A started turn. */
export interface StartedTurn extends TurnHandle {
  /**
   * Settles after `turn.end` was written and the turn's `task.outcome`
   * appended; rejects only when the agent could not run the turn at all
   * (the SDK has then emitted a `turn.end { error }` itself).
   */
  readonly done: Promise<TurnResult>
}

interface TurnTally {
  readonly turn: number
  readonly source: Exclude<UserMessageSource, 'inject'>
  readonly steps: LLMUsage[]
  toolCalls: number
  readonly tools: Set<string>
  reason?: TurnEndReason
  error?: ErrorInfo
  ended: boolean
}

interface SessionEntry {
  readonly agent: Agent
  readonly unsubscribe: () => void
  running?: { readonly tally: TurnTally; readonly done: Promise<TurnResult> } | undefined
  /** Source of the turn about to start (read by the `turn.start` mapping). */
  pending?: TurnTally | undefined
}

interface ProjectEntry {
  readonly projectId: string
  readonly root: string
  readonly app: NexgentApp
  readonly tasking: LocalTaskingService
  readonly sessions: Map<string, SessionEntry>
  readonly opening: Map<string, Promise<SessionEntry>>
  readonly pendingApprovals: Map<string, { readonly sessionId: string; readonly resolve: (decision: ApprovalDecision) => void }>
}

function tallyStatus(tally: TurnTally): TaskOutcomeStatus {
  switch (tally.reason?.kind) {
    case 'completed':
      return 'completed'
    case 'cancelled':
      return 'cancelled'
    default:
      return 'failed'
  }
}

/** A step-3 method whose contract is frozen but whose implementation has not landed yet. */
function notImplemented(method: string): NexgentError {
  return new NexgentError('internal', `${method} is not implemented yet (step 3)`)
}

function invalid(message: string): NexgentError {
  return new NexgentError('tool/invalid-input', message)
}

/** The in-process SDK. */
export class LocalNexgentSdk implements NexgentSdk {
  readonly apiVersion = SDK_API_VERSION
  readonly home: string
  private readonly env: Readonly<Record<string, string | undefined>>
  private readonly recent: RecentProjects
  private readonly projects = new Map<string, ProjectEntry>()
  private readonly projectOpening = new Map<string, Promise<ProjectEntry>>()
  /** Stable ids for roots (open or recent) during this instance's life. */
  private readonly rootIds = new Map<string, string>()
  private readonly listeners = new Set<(event: SdkEvent) => void>()
  private readonly rawListeners = new Set<(event: ProjectAgentEvent) => void>()
  private readonly eventSeq = new Map<string, number>()
  private disposed = false
  private readonly methods: SdkMethods

  constructor(private readonly options: LocalSdkOptions) {
    this.env = options.env ?? process.env
    this.home = options.home ?? nexgentHome(this.env as NodeJS.ProcessEnv)
    this.recent = new RecentProjects(this.home)
    this.methods = this.buildMethods()
  }

  private get credentialEnv(): CredentialEnv {
    return { env: this.env, home: this.home }
  }

  private now(): Date {
    return this.options.now?.() ?? new Date()
  }

  // -------------------------------------------------------------------------
  // NexgentSdk
  // -------------------------------------------------------------------------

  call<M extends SdkMethodName>(method: M, input: SdkInput<M>): Promise<SdkResult<M>> {
    if (!(SDK_METHOD_NAMES as readonly string[]).includes(method)) {
      return Promise.reject(new NexgentError('internal', `unknown SDK method ${String(method)}`))
    }
    if (this.disposed) return Promise.reject(new NexgentError('internal', 'the SDK was disposed'))
    const fn = this.methods[method] as (input: SdkInput<M>) => Promise<SdkResult<M>>
    try {
      return fn(input ?? ({} as SdkInput<M>))
    } catch (error) {
      return Promise.reject(error)
    }
  }

  subscribe(listener: (event: SdkEvent) => void): Unsubscribe {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    await Promise.allSettled([...this.projects.keys()].map(projectId => this.closeProject(projectId)))
  }

  // -------------------------------------------------------------------------
  // in-process extras
  // -------------------------------------------------------------------------

  /** Raw kernel events of every open session (in-process only; the CLI renders them). */
  onAgentEvent(listener: (event: ProjectAgentEvent) => void): Unsubscribe {
    this.rawListeners.add(listener)
    return () => {
      this.rawListeners.delete(listener)
    }
  }

  /** `sessions.create` with a model override. */
  async createSession(input: CreateSessionInput & { readonly model?: string }): Promise<SessionSummary> {
    const project = this.project(input.projectId)
    const agent = await project.app.agents.create({
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.sandboxMode === undefined ? {} : { sandboxMode: input.sandboxMode }),
      ...(input.model === undefined ? {} : { model: input.model }),
    })
    this.track(project, agent)
    return this.summary(project, agent.sessionId)
  }

  /** `sessions.open` with a sandbox override (CLI `resume --sandbox`). */
  async openSession(input: { readonly projectId: string; readonly sessionId: string; readonly sandboxMode?: SandboxMode }): Promise<SessionView> {
    const project = this.project(input.projectId)
    await this.ensureSession(project, input.sessionId, input.sandboxMode)
    return this.view(project, input.sessionId)
  }

  /** Cancel with an explicit cause; resolves after the turn's `turn.end` (and its outcome). */
  async cancelTurn(input: { readonly projectId: string; readonly sessionId: string; readonly cause?: Extract<TurnCancelCause, 'user' | 'shutdown'> }): Promise<void> {
    const project = this.project(input.projectId)
    const entry = project.sessions.get(input.sessionId)
    const running = entry?.running
    if (entry === undefined || running === undefined) return
    entry.agent.cancel(input.cause ?? 'user')
    await running.done.catch(() => undefined)
  }

  /** Start a user or feedback turn; see {@link StartedTurn}. */
  async startTurn(input: StartTurnInput): Promise<StartedTurn> {
    const project = this.project(input.projectId)
    const entry = await this.ensureSession(project, input.sessionId)
    // A turn whose `turn.end` was already emitted is only finishing its
    // bookkeeping (checkpoint, task.outcome): wait for it instead of refusing.
    while (entry.running?.tally.ended === true) await entry.running.done.catch(() => undefined)
    if (entry.running !== undefined || entry.agent.busy) {
      throw new NexgentError('session/locked', `a turn is already running in session ${input.sessionId}`)
    }
    const source = input.source === 'feedback' ? 'feedback' : 'user'
    if (source === 'user' && typeof (input as SendMessageInput).text !== 'string') throw invalid('text must be a string')
    const turn = entry.agent.turn + 1
    const tally: TurnTally = { turn, source, steps: [], toolCalls: 0, tools: new Set(), ended: false }
    entry.pending = tally
    const materialIds = input.materialIds === undefined ? {} : { materialIds: [...input.materialIds] }
    const run = input.source === 'feedback'
      ? entry.agent.run({ source: 'feedback', feedback: input.feedback, ...materialIds })
      : entry.agent.run({ text: (input as SendMessageInput).text, ...materialIds })
    const done = run.then(
      async result => {
        await this.writeOutcome(project, entry.agent.sessionId, tally)
        return result
      },
      (error: unknown) => {
        // The agent could not run the turn (closed, store failure): close the stream ourselves.
        if (!tally.ended) {
          tally.ended = true
          const info = toErrorInfo(error)
          this.emit(project.projectId, entry.agent.sessionId, { type: 'turn.end', turn, reason: { kind: 'error', error: info }, usage: addUsage(...tally.steps) })
        }
        throw error
      },
    ).finally(() => {
      if (entry.running?.tally === tally) entry.running = undefined
      if (entry.pending === tally) entry.pending = undefined
    })
    entry.running = { tally, done }
    done.catch(() => undefined)
    return { sessionId: entry.agent.sessionId, turn, done }
  }

  /** Whether the session has a running turn in this instance. */
  isRunning(projectId: string, sessionId: string): boolean {
    return this.projects.get(projectId)?.sessions.get(sessionId)?.running !== undefined
  }

  // -------------------------------------------------------------------------
  // projects
  // -------------------------------------------------------------------------

  private idFor(root: string): string {
    let id = this.rootIds.get(root)
    if (id === undefined) {
      id = randomUUID()
      this.rootIds.set(root, id)
    }
    return id
  }

  private project(projectId: string): ProjectEntry {
    if (typeof projectId !== 'string') throw invalid('projectId must be a string')
    const project = this.projects.get(projectId)
    if (project === undefined) throw new NexgentError('workspace/not-found', `project ${projectId} is not open`)
    return project
  }

  private info(root: string, lastOpenedAt: string, exists: boolean): ProjectInfo {
    return { projectId: this.idFor(root), root, name: basename(root), lastOpenedAt, exists }
  }

  private async openProject(input: { readonly root: string; readonly create?: boolean }): Promise<ProjectInfo> {
    if (typeof input?.root !== 'string' || input.root.trim() === '') throw invalid('root must be a non-empty path')
    let root = resolve(input.root)
    let isDir: boolean
    try {
      isDir = (await stat(root)).isDirectory()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      if (input.create !== true) throw new NexgentError('workspace/not-found', `project directory not found: ${root}`)
      await mkdir(root, { recursive: true })
      isDir = true
    }
    if (!isDir) throw new NexgentError('workspace/not-found', `project path is not a directory: ${root}`)

    const existing = [...this.projects.values()].find(project => project.root === root || project.app.ctx.workspace.root === root)
    let project: ProjectEntry
    if (existing !== undefined) {
      project = existing
    } else {
      let opening = this.projectOpening.get(root)
      if (opening === undefined) {
        opening = this.bootProject(root).finally(() => this.projectOpening.delete(root))
        this.projectOpening.set(root, opening)
      }
      project = await opening
    }
    root = project.root
    const at = this.now().toISOString()
    await this.recent.touch(root, at).catch(() => undefined)
    return this.info(root, at, true)
  }

  private async bootProject(inputRoot: string): Promise<ProjectEntry> {
    const app = await bootProjectApp({
      root: inputRoot,
      home: this.home,
      env: this.env,
      ...(this.options.approvalTimeoutMs === undefined ? {} : { approvalTimeoutMs: this.options.approvalTimeoutMs }),
      ...(this.options.patches === undefined ? {} : { patches: this.options.patches }),
      ...(this.options.registry === undefined ? {} : { registry: this.options.registry }),
    })
    try {
      const { ctx } = app
      await ctx.workspace.ensureLayout()
      await writeDefaultConfig(ctx.workspace.layout.configFile)
      const root = ctx.workspace.root
      const projectId = this.idFor(root)
      this.rootIds.set(inputRoot, projectId)
      const tasking = ctx.get('tasking') as LocalTaskingService | undefined
      if (tasking === undefined) throw new NexgentError('config/invalid', '@nexgent/tasking did not start')
      const project: ProjectEntry = {
        projectId,
        root,
        app,
        tasking,
        sessions: new Map(),
        opening: new Map(),
        pendingApprovals: new Map(),
      }
      ctx.approvals.setResponder(this.options.approvalResponder ?? ((request, signal) => this.awaitApproval(project, request, signal)))
      app.agents.setProjectGrantWriter(grant => appendProjectGrant(ctx.workspace.layout.configFile, grant))
      this.projects.set(projectId, project)
      return project
    } catch (error) {
      await app.dispose().catch(() => undefined)
      throw error
    }
  }

  private async closeProject(projectId: string): Promise<void> {
    const project = this.projects.get(projectId)
    if (project === undefined) return
    await Promise.allSettled([...project.opening.values()])
    await Promise.allSettled([...project.sessions.keys()].map(sessionId => this.closeSession(project, sessionId)))
    this.projects.delete(projectId)
    await project.app.dispose()
  }

  private async recentProjects(): Promise<ProjectInfo[]> {
    const entries = await this.recent.list()
    return Promise.all(entries.map(async entry => {
      const exists = await stat(entry.root).then(s => s.isDirectory(), () => false)
      return this.info(entry.root, entry.lastOpenedAt, exists)
    }))
  }

  // -------------------------------------------------------------------------
  // sessions
  // -------------------------------------------------------------------------

  private track(project: ProjectEntry, agent: Agent): SessionEntry {
    const entry: SessionEntry = {
      agent,
      unsubscribe: agent.subscribe(event => this.onEvent(project, entry, event)),
    }
    project.sessions.set(agent.sessionId, entry)
    return entry
  }

  private ensureSession(project: ProjectEntry, sessionId: string, sandboxMode?: SandboxMode): Promise<SessionEntry> {
    if (typeof sessionId !== 'string' || sessionId === '') return Promise.reject(invalid('sessionId must be a string'))
    const live = project.sessions.get(sessionId)
    if (live !== undefined) return Promise.resolve(live)
    let opening = project.opening.get(sessionId)
    if (opening === undefined) {
      opening = this.resumeSession(project, sessionId, sandboxMode).finally(() => project.opening.delete(sessionId))
      project.opening.set(sessionId, opening)
    }
    return opening
  }

  private async resumeSession(project: ProjectEntry, sessionId: string, sandboxMode?: SandboxMode): Promise<SessionEntry> {
    const store = project.app.ctx.session
    // The previous process may have died inside a turn: `agents.resume`
    // closes it with `turn.end { interrupted }`; that turn's stream gets its
    // `turn.end` event here.
    const before = await store.readAll(sessionId)
    const openTurn = before.records.length === 0 ? undefined : projectSession(before.records).metadata.openTurn
    const agent = await project.app.agents.resume(sessionId, sandboxMode === undefined ? {} : { sandboxMode })
    const entry = this.track(project, agent)
    if (openTurn !== undefined) {
      this.emit(project.projectId, sessionId, { type: 'turn.end', turn: openTurn, reason: { kind: 'interrupted' }, usage: turnUsage(before.records, openTurn) })
    }
    return entry
  }

  private async closeSession(project: ProjectEntry, sessionId: string): Promise<void> {
    const entry = project.sessions.get(sessionId)
    if (entry === undefined) return
    const running = entry.running
    if (running !== undefined) {
      entry.agent.cancel('shutdown')
      await running.done.catch(() => undefined)
    }
    try {
      await entry.agent.close({ skipOutcome: true })
    } finally {
      entry.unsubscribe()
      project.sessions.delete(sessionId)
      for (const [id, pending] of project.pendingApprovals) {
        if (pending.sessionId === sessionId) project.pendingApprovals.delete(id)
      }
    }
  }

  private async sessionIds(project: ProjectEntry): Promise<string[]> {
    const dir = project.app.ctx.workspace.layout.sessions
    const names = await readdir(dir, { withFileTypes: true }).catch(() => [])
    const ids: string[] = []
    for (const dirent of names) {
      if (!dirent.isDirectory()) continue
      const exists = await stat(join(dir, dirent.name, SESSION_FILE_NAME)).then(() => true, () => false)
      if (exists) ids.push(dirent.name)
    }
    return ids
  }

  private async records(project: ProjectEntry, sessionId: string): Promise<readonly SessionRecord[]> {
    const { records } = await project.app.ctx.session.readAll(sessionId)
    if (records.length === 0) throw new NexgentError('session/not-found', `session ${sessionId} has no records`)
    return records
  }

  private async summary(project: ProjectEntry, sessionId: string): Promise<SessionSummary> {
    const records = await this.records(project, sessionId)
    return sessionSummary(records, projectSession(records), this.isRunning(project.projectId, sessionId))
  }

  private async view(project: ProjectEntry, sessionId: string): Promise<SessionView> {
    const records = await this.records(project, sessionId)
    const state = projectSession(records)
    const entry = project.sessions.get(sessionId)
    return {
      summary: sessionSummary(records, state, entry?.running !== undefined),
      sandboxMode: entry?.agent.sandboxMode ?? state.metadata.sandboxMode,
      model: entry?.agent.model ?? state.metadata.model,
      items: historyItems(records),
      totalUsage: state.metadata.totalUsage,
    }
  }

  private async listSessions(project: ProjectEntry): Promise<SessionSummary[]> {
    const summaries: SessionSummary[] = []
    for (const sessionId of await this.sessionIds(project)) {
      try {
        summaries.push(await this.summary(project, sessionId))
      } catch (error) {
        if (!isNexgentError(error)) throw error
        // an unreadable session is skipped in the list; opening it reports why
      }
    }
    return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  // -------------------------------------------------------------------------
  // approvals
  // -------------------------------------------------------------------------

  private awaitApproval(project: ProjectEntry, request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision> {
    return new Promise<ApprovalDecision>(resolveDecision => {
      const finish = (decision: ApprovalDecision) => {
        project.pendingApprovals.delete(request.id)
        resolveDecision(decision)
      }
      project.pendingApprovals.set(request.id, { sessionId: request.sessionId, resolve: finish })
      signal.addEventListener('abort', () => finish({ id: request.id, decision: 'deny', scope: 'once', decidedBy: 'cancel' }), { once: true })
    })
  }

  private respond(input: SdkInput<'approvals.respond'>): boolean {
    const project = this.project(input.projectId)
    const decision = input.decision
    if (decision === null || typeof decision !== 'object' || typeof decision.id !== 'string') throw invalid('decision.id must be a string')
    if (decision.decision !== 'allow' && decision.decision !== 'deny') throw invalid('decision.decision must be allow or deny')
    const pending = project.pendingApprovals.get(decision.id)
    if (pending === undefined || pending.sessionId !== input.sessionId) return false
    pending.resolve({
      id: decision.id,
      decision: decision.decision,
      scope: decision.decision === 'deny' ? 'once' : decision.scope,
      decidedBy: 'user',
      ...(decision.reason === undefined ? {} : { reason: decision.reason }),
    })
    return true
  }

  // -------------------------------------------------------------------------
  // events and accounting
  // -------------------------------------------------------------------------

  private emit(projectId: string, sessionId: string, event: DistributiveOmitBase<SdkEvent>): void {
    const key = `${projectId}\u0000${sessionId}`
    const eventSeq = (this.eventSeq.get(key) ?? 0) + 1
    this.eventSeq.set(key, eventSeq)
    const full = { ...event, projectId, sessionId, eventSeq } as SdkEvent
    for (const listener of [...this.listeners]) {
      try {
        listener(full)
      } catch {
        // a subscriber failure must not affect the turn
      }
    }
  }

  private onEvent(project: ProjectEntry, entry: SessionEntry, event: AgentEvent): void {
    const raw = { ...event, projectId: project.projectId } as ProjectAgentEvent
    for (const listener of [...this.rawListeners]) {
      try {
        listener(raw)
      } catch {
        // as above
      }
    }
    const tally = entry.running?.tally ?? entry.pending
    const { projectId } = project
    const sessionId = event.sessionId
    switch (event.type) {
      case 'turn.start':
        this.emit(projectId, sessionId, { type: 'turn.start', turn: event.turn, source: tally?.turn === event.turn ? tally.source : 'user' })
        return
      case 'request.start':
        tally?.steps.push(UNKNOWN_USAGE)
        return
      case 'text.delta':
        this.emit(projectId, sessionId, { type: 'text.delta', turn: event.turn, step: event.step, text: event.text })
        return
      case 'reasoning.delta':
        this.emit(projectId, sessionId, { type: 'reasoning.delta', turn: event.turn, step: event.step, text: event.text })
        return
      case 'tool.start':
        this.emit(projectId, sessionId, { type: 'tool.start', turn: event.turn, step: event.step, call: event.call })
        return
      case 'tool.result':
        if (tally !== undefined) {
          tally.toolCalls += 1
          tally.tools.add(event.result.name)
        }
        this.emit(projectId, sessionId, {
          type: 'tool.result',
          turn: event.turn,
          step: event.step,
          callId: event.result.toolCallId,
          name: event.result.name,
          content: event.result.content,
          isError: event.result.isError,
          durationMs: event.durationMs,
        })
        return
      case 'approval.request':
        this.emit(projectId, sessionId, { type: 'approval.request', turn: event.turn, request: event.request })
        return
      case 'approval.decision':
        this.emit(projectId, sessionId, { type: 'approval.decision', turn: event.turn, decision: event.decision })
        return
      case 'assistant.message':
        if (tally !== undefined) {
          if (tally.steps.length === 0) tally.steps.push(event.usage)
          else tally.steps[tally.steps.length - 1] = event.usage
        }
        this.emit(projectId, sessionId, {
          type: 'assistant.message',
          turn: event.turn,
          step: event.step,
          text: event.content,
          finishReason: event.finishReason,
          interrupted: event.interrupted === true,
          usage: event.usage,
        })
        return
      case 'error':
        if (tally !== undefined && event.fatal) tally.error = event.error
        this.emit(projectId, sessionId, { type: 'error', ...(event.turn === undefined ? {} : { turn: event.turn }), error: event.error, fatal: event.fatal })
        return
      case 'turn.end':
        if (tally !== undefined && tally.turn === event.turn) {
          tally.reason = event.reason
          if (event.reason.kind === 'error') tally.error = event.reason.error
          tally.ended = true
        }
        this.emit(projectId, sessionId, {
          type: 'turn.end',
          turn: event.turn,
          reason: event.reason,
          usage: tally !== undefined && tally.turn === event.turn ? addUsage(...tally.steps) : UNKNOWN_USAGE,
        })
        return
      case 'record':
        this.onRecord(project, sessionId, event.record)
        return
      case 'tool-call.start':
      case 'closed':
        return
    }
  }

  private onRecord(project: ProjectEntry, sessionId: string, record: SessionRecord): void {
    switch (record.type) {
      case 'deliverable.presented':
        this.emit(project.projectId, sessionId, { type: 'deliverable.presented', turn: record.turn, deliverable: record.deliverable })
        return
      case 'turn.files':
        this.emit(project.projectId, sessionId, { type: 'turn.files', turn: record.turn, changes: record.changes })
        return
      case 'compaction':
        this.emit(project.projectId, sessionId, { type: 'compaction', turn: record.turn, compactedMessages: record.compactedMessages })
        return
      default:
        // material.added and goal records are reported by the SDK methods that write them (with the full metadata / goal)
        return
    }
  }

  private async writeOutcome(project: ProjectEntry, sessionId: string, tally: TurnTally): Promise<void> {
    // The kernel writes its own record when a cost cap stops the turn.
    if (tally.reason?.kind === 'cancelled' && tally.reason.cause === 'cost-cap') return
    const status = tallyStatus(tally)
    try {
      await project.app.ctx.ledger.append({
        type: 'task.outcome',
        sessionId,
        status,
        ...(status !== 'completed' && tally.error !== undefined ? { error: tally.error } : {}),
        totalUsage: addUsage(...tally.steps),
        requestCount: tally.steps.length,
        toolCallCount: tally.toolCalls,
        turns: 1,
        toolsUsed: [...tally.tools].sort(),
      })
    } catch (error) {
      this.emit(project.projectId, sessionId, { type: 'error', turn: tally.turn, error: toErrorInfo(error), fatal: false })
    }
  }

  // -------------------------------------------------------------------------
  // method table
  // -------------------------------------------------------------------------

  private buildMethods(): SdkMethods {
    return {
      'app.info': async () => ({ sdkVersion: SDK_API_VERSION, appVersion: this.options.appVersion, platform: process.platform }),

      'projects.recent': () => this.recentProjects(),
      'projects.open': input => this.openProject(input),
      'projects.close': async input => {
        this.project(input.projectId)
        await this.closeProject(input.projectId)
      },
      'projects.forget': async input => {
        if (typeof input?.root !== 'string') throw invalid('root must be a string')
        await this.recent.forget(resolve(input.root))
      },

      'sessions.list': input => this.listSessions(this.project(input.projectId)),
      // Step 3 contract (api.ts); implemented by the SDK and desktop work package.
      'sessions.children': async () => { throw notImplemented('sessions.children') },
      'sessions.view': async () => { throw notImplemented('sessions.view') },
      'sessions.collaboration': async () => { throw notImplemented('sessions.collaboration') },
      'sessions.create': input => this.createSession(input),
      'sessions.open': input => this.openSession(input),
      'sessions.close': async input => this.closeSession(this.project(input.projectId), input.sessionId),
      'sessions.export': async input => {
        const project = this.project(input.projectId)
        if (typeof input.outDir !== 'string' || input.outDir === '') throw invalid('outDir must be a path')
        const records = await this.records(project, input.sessionId)
        const { ctx } = project.app
        return writeExportBundle({
          sessionId: input.sessionId,
          projectRoot: project.root,
          sessionFile: join(ctx.workspace.sessionDir(input.sessionId), SESSION_FILE_NAME),
          ledgersDir: ctx.workspace.layout.ledgers,
          records,
          materials: await project.tasking.materials.list({ includeRemoved: true }),
          deliverables: await project.tasking.deliverables.list(),
          secrets: await secretValues(this.credentialEnv),
          outDir: input.outDir,
          appVersion: this.options.appVersion,
          sdkVersion: SDK_API_VERSION,
          now: () => this.now(),
        })
      },

      'sessions.rename': async input => {
        const project = this.project(input.projectId)
        const title = typeof input.title === 'string' ? input.title.trim() : ''
        if (title === '') throw invalid('title must be a non-empty string')
        const entry = await this.ensureSession(project, input.sessionId)
        await entry.agent.appendHostRecord({ type: 'session.title', title })
        return this.summary(project, input.sessionId)
      },

      'files.list': input => listProjectFiles(this.project(input.projectId).root),

      'dialogs.pickDirectory': async () => {
        const pick = this.options.pickDirectory
        if (pick === undefined) throw new NexgentError('internal', 'file dialogs are only available in the desktop app')
        return pick()
      },
      'dialogs.pickFiles': async () => {
        const pick = this.options.pickFiles
        if (pick === undefined) throw new NexgentError('internal', 'file dialogs are only available in the desktop app')
        return pick()
      },

      'turns.send': async input => {
        const { sessionId, turn } = await this.startTurn(input)
        return { sessionId, turn }
      },
      'turns.cancel': input => this.cancelTurn({ projectId: input.projectId, sessionId: input.sessionId, cause: 'user' }),
      'approvals.respond': async input => this.respond(input),

      'materials.add': async input => {
        const project = this.project(input.projectId)
        if (typeof input.sourcePath !== 'string' || input.sourcePath === '') throw invalid('sourcePath must be a path')
        const entry = input.sessionId === undefined ? undefined : await this.ensureSession(project, input.sessionId)
        const material = await project.tasking.materials.add({ sourcePath: input.sourcePath, ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }) })
        if (entry !== undefined) {
          await entry.agent.appendHostRecord(materialAddedRecord(material))
          this.emit(project.projectId, entry.agent.sessionId, { type: 'material.added', material })
        }
        return material
      },
      'materials.list': input => this.project(input.projectId).tasking.materials.list(input.includeRemoved === true ? { includeRemoved: true } : {}),
      'materials.remove': input => this.project(input.projectId).tasking.materials.remove(input.materialId),

      'deliverables.list': input => this.project(input.projectId).tasking.deliverables.list(),
      'deliverables.get': async input => {
        const version = await this.project(input.projectId).tasking.deliverables.get(input.deliverableId, input.version)
        if (version === undefined) throw new NexgentError('workspace/not-found', `deliverable ${input.deliverableId} v${input.version} not found`)
        return version
      },
      'deliverables.diff': input => this.project(input.projectId).tasking.deliverables.diff(input.deliverableId, input.from, input.to),
      'deliverables.readText': async input => readSnapshotText(this.project(input.projectId), input),
      'deliverables.reveal': async input => {
        const reveal = this.options.reveal
        if (reveal === undefined) throw new NexgentError('internal', 'revealing files is only available in the desktop app')
        const project = this.project(input.projectId)
        await reveal(await snapshotFile(project, input))
      },

      'feedback.submit': async input => {
        const project = this.project(input.projectId)
        const feedback = await createFeedbackEntry({
          deliverableId: input.deliverableId,
          version: input.version,
          ...(input.rating === undefined ? {} : { rating: input.rating }),
          comment: input.comment,
        }, project.tasking.deliverables)
        const { sessionId, turn } = await this.startTurn({ source: 'feedback', projectId: input.projectId, sessionId: input.sessionId, feedback })
        return { sessionId, turn }
      },
      'feedback.list': input => this.project(input.projectId).tasking.feedback.list({
        ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
        ...(input.deliverableId === undefined ? {} : { deliverableId: input.deliverableId }),
      }),

      'goals.get': async input => (await this.project(input.projectId).tasking.goals.get(input.sessionId)) ?? null,
      'goals.set': async input => {
        const project = this.project(input.projectId)
        if (typeof input.text !== 'string' || input.text.trim() === '') throw invalid('goal text must be a non-empty string')
        const entry = await this.ensureSession(project, input.sessionId)
        const goal = await project.tasking.goals.set(entry.agent.appendHostRecord, input.text)
        this.emit(project.projectId, input.sessionId, { type: 'goal', goal })
        return goal
      },
      'goals.update': async input => {
        const project = this.project(input.projectId)
        const entry = await this.ensureSession(project, input.sessionId)
        const goal = await project.tasking.goals.update(entry.agent.appendHostRecord, input.sessionId, {
          status: input.status,
          ...(input.text === undefined ? {} : { text: input.text }),
          ...(input.note === undefined ? {} : { note: input.note }),
        })
        this.emit(project.projectId, input.sessionId, { type: 'goal', goal })
        return goal
      },

      'settings.get': input => readSettings(this.project(input.projectId).app.ctx.workspace.layout.configFile, this.credentialEnv),
      'settings.update': input => updateSettings(this.project(input.projectId).app.ctx.workspace.layout.configFile, input.patch, this.credentialEnv),
      'settings.setApiKey': input => setApiKey(this.credentialEnv, input?.value),
    }
  }

  /** `{ configured, source }` of the model key (for hosts that check before opening a project). */
  apiKeyInfo() {
    return describeApiKey(this.credentialEnv)
  }
}

/** Event fields the SDK stamps itself. */
type DistributiveOmitBase<T> = T extends unknown ? Omit<T, 'projectId' | 'sessionId' | 'eventSeq'> : never

async function snapshotFile(project: ProjectEntry, input: { readonly deliverableId: string; readonly version: number; readonly path: string }): Promise<string> {
  const version = await project.tasking.deliverables.get(input.deliverableId, input.version)
  if (version === undefined) throw new NexgentError('workspace/not-found', `deliverable ${input.deliverableId} v${input.version} not found`)
  if (!version.files.some(file => file.path === input.path)) {
    throw new NexgentError('workspace/not-found', `${input.path} is not a file of deliverable ${input.deliverableId} v${input.version}`)
  }
  return project.tasking.deliverables.snapshotPath(input.deliverableId, input.version, input.path)
}

async function readSnapshotText(project: ProjectEntry, input: { readonly deliverableId: string; readonly version: number; readonly path: string }): Promise<string> {
  const file = await snapshotFile(project, input)
  const size = (await stat(file)).size
  if (size > READ_TEXT_MAX_BYTES) throw invalid(`${input.path} is ${size} bytes; readText is limited to ${READ_TEXT_MAX_BYTES}`)
  const bytes = await readFile(file)
  if (bytes.includes(0)) throw invalid(`${input.path} is a binary file`)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw invalid(`${input.path} is not UTF-8 text`)
  }
}

/** Write `config.json` with the defaults when missing (`data-formats.md` §目录布局); never touches an existing file. */
export async function writeDefaultConfig(file: string): Promise<boolean> {
  let handle
  try {
    handle = await open(file, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o644)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
  try {
    await handle.writeFile(`${JSON.stringify(resolveProjectConfig(), null, 2)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  return true
}

/** Create the in-process SDK. */
export function createSdk(options: LocalSdkOptions): LocalNexgentSdk {
  return new LocalNexgentSdk(options)
}
