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
 *
 * Members (step 3): a child session started by a tool (`delegate`, a
 * workflow's `agent()`, a thread) is tracked from its parent's
 * `subagent.start` record on, so its events reach subscribers with
 * `parentSessionId`, its approvals go through `approvals.respond`, and it
 * is cancelled with its parent (the kernel's `parent` cause). The parent's
 * collaboration records become `member.start` / `member.end` /
 * `workflow.phase` events. Members are run and closed by
 * their parent's tools, never by the SDK: they get no SDK `task.outcome`
 * (the kernel writes theirs), cannot be sent turns, and `sessions.open` on
 * one returns the read-only view. Reopening a root session runs
 * {@link ROOT_SESSION_RECOVERIES} before anything else.
 */
import { randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { mkdir, open, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'
import {
  addUsage,
  appendGrant,
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
  type OrganizationMemory,
  type Plugin,
  SANDBOX_MODES,
  type SandboxMode,
  type SessionRecord,
  type SubagentStartRecord,
  type TaskOutcomeStatus,
  type ThinkingMode,
  type Tool,
  type TurnCancelCause,
  type TurnEndReason,
  type TurnResult,
  type UserMessageSource,
  type WorkdirMerge,
} from '@nexgent/kernel'
import { capabilitiesOf, type CapabilityService } from '@nexgent/capabilities'
import type { LearningHost } from '@nexgent/evolve'
import { projectSession, readSessionSummary, SESSION_FILE_NAME } from '@nexgent/session'
import { extractDocx, extractPdf, extractXlsx } from '@nexgent/skill'
import { applyRewind, createFeedbackEntry, materialAddedRecord, planRewind, type LocalTaskingService } from '@nexgent/tasking'
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
import { checkCommandShell, type CommandShellStatus } from '@nexgent/workspace'
import { bootProjectApp, ROOT_SESSION_RECOVERIES, type BootOptions } from './boot.js'
import * as capabilities from './capabilities.js'
import * as learning from './learning.js'
import { writeExportBundle } from './export.js'
import { listProjectFiles } from './files.js'
import { checkRetryOf, collaborationView, historyItems, memberRunView, organizationView, withTurnCosts, runKey, sessionSummary, summaryOfEntry, turnUsage } from './history.js'
import { RecentProjects } from './recent.js'
import { COORDINATOR_NOTES_FILE, SdkThreadHost, type ThreadRuntime } from './threads.js'
import { nameConversation } from './title.js'
import { acknowledgeLearning, describeApiKey, readSettings, readUserSettings, secretValues, setApiKey, updateSettings, updateUserSettings, type CredentialEnv } from './settings.js'

/** `deliverables.readText` limit. */
export const READ_TEXT_MAX_BYTES = 1024 * 1024
/** Coordinator: `<dataDir>/coordinator.json` names the project's resident conversation. */
export const COORDINATOR_FILE = 'coordinator.json'

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
  /** Start background learning (default true); see {@link BootOptions.background}. */
  readonly background?: boolean
  /**
   * Add opened projects to the user's recent list (default true). The gate's
   * replays open throwaway copies and pass false.
   */
  readonly recordRecent?: boolean
  /** Clock for recent projects and exports. */
  readonly now?: () => Date
  /** Start-up check of the command shell (tests); default {@link checkCommandShell} over {@link env}. */
  readonly checkShell?: () => CommandShellStatus
}

/** A raw kernel event with the project it belongs to. */
export type ProjectAgentEvent = AgentEvent & { readonly projectId: string }

/** In-process turn input: a user message, a feedback turn, or (coordinator step two) a message between a coordinator and its thread. */
export type StartTurnInput =
  | (SendMessageInput & { readonly source?: 'user' })
  | { readonly source: 'feedback'; readonly projectId: string; readonly sessionId: string; readonly feedback: FeedbackEntry; readonly materialIds?: readonly string[] }
  | { readonly source: 'thread'; readonly projectId: string; readonly sessionId: string; readonly text: string; readonly materialIds?: readonly string[] }

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
  /** Step 3, a member: the turn its parent's tool is running (for the `turn.end` usage). */
  memberTally?: TurnTally | undefined
  /** Step 3, a parent: its `subagent.start` records by {@link runKey}, to describe a run when it ends. */
  readonly runStarts: Map<string, SubagentStartRecord>
  /** Coordinator step two, a thread: what merging its copy did at the end of its last turn. */
  lastMerge?: WorkdirMerge | undefined
}

interface ProjectEntry {
  readonly projectId: string
  readonly root: string
  readonly app: NexgentApp
  readonly tasking: LocalTaskingService
  readonly sessions: Map<string, SessionEntry>
  readonly opening: Map<string, Promise<SessionEntry>>
  /** By request id; a member's request may be answered under its own or its parent's session id. */
  readonly pendingApprovals: Map<string, PendingApproval>
  /** Coordinator step two: the project's threads (`ctx.threads`). */
  readonly threads: SdkThreadHost
  /** Set when the project starts closing: threads no longer wake or measure. */
  closing?: boolean
}

/**
 * A request waiting for `approvals.respond`. Registered when the
 * `approval.request` event arrives, before any listener sees it, so a host
 * may answer synchronously from its event callback; the responder then
 * waits on `decision`.
 */
interface PendingApproval {
  readonly sessionId: string
  readonly parentSessionId?: string
  readonly decision: Promise<ApprovalDecision>
  /** Answer it; `false` when it was already answered. */
  readonly resolve: (decision: ApprovalDecision) => boolean
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

function invalid(message: string): NexgentError {
  return new NexgentError('tool/invalid-input', message)
}

function memberReadOnly(sessionId: string, parentSessionId: string): NexgentError {
  return new NexgentError('tool/denied', `session ${sessionId} is a member of ${parentSessionId}; members are run by their parent and are read-only here (sessions.view)`, {
    details: { parentSessionId },
  })
}

/** The `subagent.start` records of a session by run key. */
function runStartsOf(records: readonly SessionRecord[]): Map<string, SubagentStartRecord> {
  const starts = new Map<string, SubagentStartRecord>()
  for (const record of records) if (record.type === 'subagent.start') starts.set(runKey(record.childSessionId, record.childTurn), record)
  return starts
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
  /** Rework D2: title requests in flight (aborted on dispose). */
  private readonly titling = new Set<{ readonly controller: AbortController; readonly done: Promise<void> }>()

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

  private shellStatus: CommandShellStatus | undefined

  /** Checked on first ask and kept: installing PowerShell needs a restart anyway. */
  private commandShell(): { shell: 'pwsh' | 'bash'; required: boolean; available: boolean } {
    this.shellStatus ??= this.options.checkShell?.() ?? checkCommandShell({ env: this.env })
    const { shell, required, available } = this.shellStatus
    return { shell, required, available }
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
    for (const job of this.titling) job.controller.abort()
    await Promise.allSettled([...this.titling].map(job => job.done))
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
      ...(input.plan === true ? { plan: true } : {}),
      ...(input.model === undefined ? {} : { model: input.model }),
    })
    this.track(project, agent)
    return this.summary(project, agent.sessionId)
  }

  /**
   * Coordinator: the project's resident conversation. The user's default
   * entry: it breaks tasks down, organizes members and keeps the project's
   * notes. Created on first call; a missing or unreadable session is
   * replaced by a new one.
   */
  async coordinatorSession(input: { readonly projectId: string }): Promise<SessionSummary> {
    const project = this.project(input.projectId)
    const known = await this.coordinatorId(project)
    if (known !== undefined) {
      try {
        return { ...(await this.summary(project, known)), coordinator: true }
      } catch (error) {
        if (!isNexgentError(error)) throw error
      }
    }
    const agent = await project.app.agents.create({ coordinator: true })
    this.track(project, agent)
    const file = join(project.app.ctx.workspace.layout.dataDir, COORDINATOR_FILE)
    await mkdir(project.app.ctx.workspace.layout.dataDir, { recursive: true })
    await writeFile(file, `${JSON.stringify({ sessionId: agent.sessionId })}\n`, 'utf8')
    return { ...(await this.summary(project, agent.sessionId)), coordinator: true }
  }

  private async coordinatorId(project: ProjectEntry): Promise<string | undefined> {
    try {
      const value = JSON.parse(await readFile(join(project.app.ctx.workspace.layout.dataDir, COORDINATOR_FILE), 'utf8')) as { sessionId?: unknown }
      return typeof value.sessionId === 'string' && value.sessionId !== '' ? value.sessionId : undefined
    } catch {
      return undefined
    }
  }

  /** `sessions.open` with a sandbox override (CLI `resume --sandbox`). */
  async openSession(input: { readonly projectId: string; readonly sessionId: string; readonly sandboxMode?: SandboxMode }): Promise<SessionView> {
    const project = this.project(input.projectId)
    await this.rootSession(project, input.sessionId, input.sandboxMode)
    return this.view(project, input.sessionId)
  }

  /** Cancel with an explicit cause; resolves after the turn's `turn.end` (and its outcome). */
  async cancelTurn(input: { readonly projectId: string; readonly sessionId: string; readonly cause?: Extract<TurnCancelCause, 'user' | 'shutdown'> }): Promise<void> {
    const project = this.project(input.projectId)
    const entry = project.sessions.get(input.sessionId)
    if (entry !== undefined && entry.agent.parentSessionId !== undefined) {
      // A member's turn belongs to its parent's tool, which reports the run as cancelled.
      if (!entry.agent.busy) return
      entry.agent.cancel(input.cause ?? 'user')
      await entry.agent.idle().catch(() => undefined)
      return
    }
    const running = entry?.running
    if (entry === undefined || running === undefined) return
    entry.agent.cancel(input.cause ?? 'user')
    await running.done.catch(() => undefined)
  }

  /** Start a user or feedback turn; see {@link StartedTurn}. */
  async startTurn(input: StartTurnInput): Promise<StartedTurn> {
    const project = this.project(input.projectId)
    const entry = await this.rootSession(project, input.sessionId)
    // A turn whose `turn.end` was already emitted is only finishing its
    // bookkeeping (checkpoint, task.outcome): wait for it instead of refusing.
    while (entry.running?.tally.ended === true) await entry.running.done.catch(() => undefined)
    if (entry.running !== undefined || entry.agent.busy) {
      throw new NexgentError('session/locked', `a turn is already running in session ${input.sessionId}`)
    }
    const source = input.source === 'feedback' ? 'feedback' : input.source === 'thread' ? 'thread' : 'user'
    if (source !== 'feedback' && typeof (input as SendMessageInput).text !== 'string') throw invalid('text must be a string')
    const turn = entry.agent.turn + 1
    const tally: TurnTally = { turn, source, steps: [], toolCalls: 0, tools: new Set(), ended: false }
    entry.pending = tally
    const materialIds = input.materialIds === undefined ? {} : { materialIds: [...input.materialIds] }
    const run = input.source === 'feedback'
      ? entry.agent.run({ source: 'feedback', feedback: input.feedback, ...materialIds })
      : input.source === 'thread'
        ? entry.agent.run({ source: 'thread', text: input.text, ...materialIds })
        : entry.agent.run({ text: (input as SendMessageInput).text, ...materialIds })
    const done = run.then(
      async result => {
        if (entry.agent.thread !== undefined) entry.lastMerge = result.merge
        await this.writeOutcome(project, entry.agent.sessionId, tally)
        if (this.options.autoTitle === true && turn === 1 && source === 'user' && tally.reason?.kind === 'completed') {
          this.nameAfterFirstTurn(project, entry, (input as SendMessageInput).text)
        }
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

  /**
   * `turns.send`: a message sent while a turn runs joins that turn (its next
   * model request carries it; {@link Agent.steer}); one sent while the turn
   * is finishing waits for it and starts the next turn.
   */
  async send(input: SendMessageInput): Promise<TurnHandle> {
    const project = this.project(input.projectId)
    const entry = await this.rootSession(project, input.sessionId)
    if (typeof input.text !== 'string') throw invalid('text must be a string')
    for (;;) {
      const running = entry.running
      if (running === undefined) break
      if (!running.tally.ended && entry.agent.steer(input.text, input.materialIds === undefined ? {} : { materialIds: input.materialIds })) return { sessionId: entry.agent.sessionId, turn: running.tally.turn, steered: true }
      await running.done.catch(() => undefined)
    }
    const { sessionId, turn } = await this.startTurn(input)
    return { sessionId, turn }
  }

  /**
   * Rework D2 (`autoTitle`): name a conversation that has no title yet from
   * its first message, in the background; a title the user gave meanwhile
   * wins, and a failed request leaves the list showing the first message.
   */
  private nameAfterFirstTurn(project: ProjectEntry, entry: SessionEntry, message: string): void {
    const controller = new AbortController()
    const sessionId = entry.agent.sessionId
    const done = (async () => {
      if ((await this.summary(project, sessionId)).title !== undefined) return
      const title = await nameConversation({ llm: project.app.ctx.llm, model: entry.agent.model, sessionId, message, signal: controller.signal })
      if (title === undefined || controller.signal.aborted || this.disposed) return
      if ((await this.summary(project, sessionId)).title !== undefined) return
      await entry.agent.appendHostRecord({ type: 'session.title', title })
    })().catch(() => undefined)
    const job = { controller, done }
    this.titling.add(job)
    void done.finally(() => this.titling.delete(job))
  }

  /** Whether the session has a running turn in this instance (a member: its parent's tool is running one). */
  isRunning(projectId: string, sessionId: string): boolean {
    const entry = this.projects.get(projectId)?.sessions.get(sessionId)
    if (entry === undefined) return false
    return entry.running !== undefined || (entry.agent.parentSessionId !== undefined && entry.agent.busy)
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
    if (this.options.recordRecent !== false) await this.recent.touch(root, at).catch(() => undefined)
    return this.info(root, at, true)
  }

  private async bootProject(inputRoot: string): Promise<ProjectEntry> {
    let booted: ProjectEntry | undefined
    const threads = new SdkThreadHost(this.threadRuntime(() => booted))
    const app = await bootProjectApp({
      threads,
      root: inputRoot,
      home: this.home,
      env: this.env,
      ...(this.options.approvalTimeoutMs === undefined ? {} : { approvalTimeoutMs: this.options.approvalTimeoutMs }),
      ...(this.options.patches === undefined ? {} : { patches: this.options.patches }),
      ...(this.options.registry === undefined ? {} : { registry: this.options.registry }),
      ...(this.options.background === undefined ? {} : { background: this.options.background }),
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
      const sessions = new Map<string, SessionEntry>()
      const project: ProjectEntry = {
        projectId,
        root,
        app,
        tasking,
        sessions,
        opening: new Map(),
        pendingApprovals: new Map(),
        threads,
      }
      booted = project
      ctx.approvals.setResponder(this.options.approvalResponder ?? ((request, signal) => this.awaitApproval(project, request, signal)))
      app.agents.setProjectGrantWriter(grant => appendGrant(ctx.workspace.layout, grant))
      this.projects.set(projectId, project)
      return project
    } catch (error) {
      await app.dispose().catch(() => undefined)
      throw error
    }
  }

  /** Coordinator step two: what the project's thread host needs from the SDK. */
  private threadRuntime(ref: () => ProjectEntry | undefined): ThreadRuntime {
    const project = (): ProjectEntry => {
      const entry = ref()
      if (entry === undefined) throw new NexgentError('internal', 'the project is still opening')
      return entry
    }
    return {
      create: async ({ title, thread }) => {
        const entry = project()
        const sandboxMode = entry.sessions.get(thread.coordinatorSessionId)?.agent.executionMode
        const agent = await entry.app.agents.create({ title, thread, ...(sandboxMode === undefined ? {} : { sandboxMode }) })
        this.track(entry, agent)
        return agent.sessionId
      },
      ensureOpen: async sessionId => {
        await this.rootSession(project(), sessionId)
      },
      records: sessionId => this.records(project(), sessionId),
      append: async (sessionId, record) => {
        const entry = await this.rootSession(project(), sessionId)
        await entry.agent.appendHostRecord(record)
      },
      startTurn: async (sessionId, text, materialIds) => {
        const started = await this.startTurn({ source: 'thread', projectId: project().projectId, sessionId, text, ...(materialIds === undefined ? {} : { materialIds }) })
        return { turn: started.turn, done: started.done }
      },
      steer: async (sessionId, text) => {
        const entry = await this.rootSession(project(), sessionId)
        const running = entry.running
        return running !== undefined && !running.tally.ended && entry.agent.steer(text, { source: 'thread' })
      },
      running: sessionId => this.isRunning(project().projectId, sessionId),
      turnDone: async (sessionId, turn) => {
        const running = project().sessions.get(sessionId)?.running
        if (running?.tally.turn === turn) await running.done.catch(() => undefined)
      },
      wake: async (sessionId, text) => {
        const entry = await this.rootSession(project(), sessionId)
        for (let attempt = 0; attempt < 5; attempt += 1) {
          const running = entry.running
          if (running !== undefined) {
            if (!running.tally.ended && entry.agent.steer(text, { source: 'thread' })) return
            await running.done.catch(() => undefined)
            continue
          }
          try {
            await this.startTurn({ source: 'thread', projectId: project().projectId, sessionId, text })
            return
          } catch (error) {
            // Another turn started meanwhile: join it on the next pass.
            if (!isNexgentError(error) || error.code !== 'session/locked') throw error
          }
        }
      },
      threadIds: async coordinatorSessionId => (await this.allSessions(project()))
        .filter(summary => summary.thread?.coordinatorSessionId === coordinatorSessionId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map(summary => summary.sessionId),
      lastMerge: sessionId => project().sessions.get(sessionId)?.lastMerge,
      costOf: (usage, model) => {
        const llm = project().app.ctx.get('llm') as { estimateUsd?(model: string, usage: LLMUsage): number | 'unknown' } | undefined
        const usd = model === undefined ? undefined : llm?.estimateUsd?.(model, usage)
        return typeof usd === 'number' && Number.isFinite(usd) ? usd : undefined
      },
      organizations: () => project().app.ctx.get('organizations') as OrganizationMemory | undefined,
      closed: () => {
        const entry = ref()
        return this.disposed || entry === undefined || entry.closing === true || this.projects.get(entry.projectId) !== entry
      },
      report: (sessionId, error) => {
        const entry = ref()
        if (entry !== undefined) this.emit(entry.projectId, sessionId, { type: 'error', error: toErrorInfo(error), fatal: false })
      },
      needsApproval: sessionId => {
        for (const pending of project().pendingApprovals.values()) if (pending.sessionId === sessionId || pending.parentSessionId === sessionId) return true
        return false
      },
      isCoordinator: async sessionId => (await this.coordinatorId(project())) === sessionId,
      notesFile: () => join(project().app.ctx.workspace.layout.dataDir, COORDINATOR_NOTES_FILE),
    }
  }

  private async closeProject(projectId: string): Promise<void> {
    const project = this.projects.get(projectId)
    if (project === undefined) return
    project.closing = true
    await Promise.allSettled([...project.opening.values()])
    // Root sessions close their members (cause `parent`); the members untrack themselves on `closed`.
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

  private track(project: ProjectEntry, agent: Agent, runStarts: Map<string, SubagentStartRecord> = new Map()): SessionEntry {
    const entry: SessionEntry = {
      agent,
      runStarts,
      unsubscribe: agent.subscribe(event => this.onEvent(project, entry, event)),
    }
    project.sessions.set(agent.sessionId, entry)
    return entry
  }

  /** Start tracking a member its parent just announced (`subagent.start`): it is open in the kernel by then. */
  private trackMember(project: ProjectEntry, childSessionId: string): void {
    const agent = project.app.agents.get(childSessionId)
    if (agent === undefined || agent.isClosed) return
    const existing = project.sessions.get(childSessionId)
    if (existing?.agent === agent) return
    existing?.unsubscribe()
    this.track(project, agent)
  }

  /** {@link ensureSession} for work that only a root session takes (turns, renames, goals, materials). */
  private async rootSession(project: ProjectEntry, sessionId: string, sandboxMode?: SandboxMode): Promise<SessionEntry> {
    const entry = await this.ensureSession(project, sessionId, sandboxMode)
    const parent = entry.agent.parentSessionId
    if (parent !== undefined) throw memberReadOnly(sessionId, parent)
    return entry
  }

  /** Whether a session is a member (live, or by its header). */
  private async isMember(project: ProjectEntry, sessionId: string): Promise<boolean> {
    if (typeof sessionId !== 'string' || sessionId === '') throw invalid('sessionId must be a string')
    const live = project.sessions.get(sessionId)
    if (live !== undefined) return live.agent.parentSessionId !== undefined
    const records = await this.records(project, sessionId)
    const start = records[0]
    return start?.type === 'session.start' && start.parentSessionId !== undefined
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
    const coordinator = (await this.coordinatorId(project)) === sessionId
    const agent = await project.app.agents.resume(sessionId, { ...(sandboxMode === undefined ? {} : { sandboxMode }), ...(coordinator ? { coordinator: true } : {}) })
    const entry = this.track(project, agent, runStartsOf(before.records))
    if (openTurn !== undefined) {
      this.emit(project.projectId, sessionId, { type: 'turn.end', turn: openTurn, reason: { kind: 'interrupted' }, usage: turnUsage(before.records, openTurn) })
    }
    if (agent.parentSessionId === undefined) {
      for (const recover of ROOT_SESSION_RECOVERIES) {
        try {
          await recover(agent, store)
        } catch (error) {
          // The session stays usable; what could not be closed is reported, not hidden.
          this.emit(project.projectId, sessionId, { type: 'error', error: toErrorInfo(error), fatal: false })
        }
      }
    }
    return entry
  }

  private async closeSession(project: ProjectEntry, sessionId: string): Promise<void> {
    const entry = project.sessions.get(sessionId)
    if (entry === undefined) return
    // A member is closed by its parent's tool or with its parent.
    if (entry.agent.parentSessionId !== undefined) return
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
    return this.marked(project, sessionSummary(records, projectSession(records), this.isRunning(project.projectId, sessionId)))
  }

  /** Every summary of the coordinator conversation carries `coordinator` (the list, open, view and refreshes alike). */
  private async marked(project: ProjectEntry, summary: SessionSummary): Promise<SessionSummary> {
    return summary.parentSessionId === undefined && summary.sessionId === await this.coordinatorId(project) ? { ...summary, coordinator: true } : summary
  }

  private async collaboration(project: ProjectEntry, sessionId: string) {
    if (typeof sessionId !== 'string' || sessionId === '') throw invalid('sessionId must be a string')
    return collaborationView(sessionId, await this.records(project, sessionId))
  }

  private async view(project: ProjectEntry, sessionId: string): Promise<SessionView> {
    if (typeof sessionId !== 'string' || sessionId === '') throw invalid('sessionId must be a string')
    const records = await this.records(project, sessionId)
    const state = projectSession(records)
    const entry = project.sessions.get(sessionId)
    const start = records.find(record => record.type === 'session.start')
    const commandSandbox = start?.type === 'session.start' ? start.commandSandbox : undefined
    const model = entry?.agent.model ?? state.metadata.model
    return {
      summary: await this.marked(project, sessionSummary(records, state, this.isRunning(project.projectId, sessionId))),
      sandboxMode: entry?.agent.executionMode ?? state.metadata.sandboxMode,
      plan: entry?.agent.plan ?? state.metadata.plan === true,
      ...(commandSandbox === undefined ? {} : { commandSandbox }),
      model,
      items: state.metadata.parentSessionId === undefined ? withTurnCosts(historyItems(records), records, model) : historyItems(records),
      totalUsage: state.metadata.totalUsage,
    }
  }

  /** Conversations and their members. */
  private async allSessions(project: ProjectEntry): Promise<SessionSummary[]> {
    const summaries: SessionSummary[] = []
    for (const sessionId of await this.sessionIds(project)) {
      try {
        // `summary.json` answers while it matches the file; otherwise this reads the file and refreshes it.
        const entry = await readSessionSummary(project.app.ctx.workspace.layout.sessions, sessionId)
        if (entry === undefined) continue
        summaries.push(summaryOfEntry(entry, this.isRunning(project.projectId, sessionId)))
      } catch (error) {
        if (!isNexgentError(error)) throw error
        // an unreadable session is skipped in the list; opening it reports why
      }
    }
    return summaries
  }

  /** Newest first; root sessions only (with their member count) unless `includeChildren`. */
  private async listSessions(project: ProjectEntry, includeChildren: boolean): Promise<SessionSummary[]> {
    const all = await this.allSessions(project)
    const coordinator = await this.coordinatorId(project)
    const counts = new Map<string, number>()
    for (const summary of all) {
      if (summary.parentSessionId !== undefined) counts.set(summary.parentSessionId, (counts.get(summary.parentSessionId) ?? 0) + 1)
    }
    return all
      .filter(summary => includeChildren || summary.parentSessionId === undefined)
      .map(summary => summary.parentSessionId === undefined ? { ...summary, childCount: counts.get(summary.sessionId) ?? 0, ...(summary.sessionId === coordinator ? { coordinator: true as const } : {}) } : summary)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  /** A session's members, in creation order. */
  private async childSessions(project: ProjectEntry, sessionId: string): Promise<SessionSummary[]> {
    if (typeof sessionId !== 'string' || sessionId === '') throw invalid('sessionId must be a string')
    return (await this.allSessions(project))
      .filter(summary => summary.parentSessionId === sessionId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  // -------------------------------------------------------------------------
  // approvals
  // -------------------------------------------------------------------------

  /**
   * The pending entry of `request`, registered on first sight (its event, or
   * the responder). The first answer wins; the entry stays until the
   * responder has taken the answer.
   */
  private registerApproval(project: ProjectEntry, request: ApprovalRequest): PendingApproval {
    const known = project.pendingApprovals.get(request.id)
    if (known !== undefined) return known
    let resolveDecision!: (decision: ApprovalDecision) => void
    const decision = new Promise<ApprovalDecision>(resolve => (resolveDecision = resolve))
    let settled = false
    const pending: PendingApproval = {
      sessionId: request.sessionId,
      ...(request.member === undefined ? {} : { parentSessionId: request.member.parentSessionId }),
      decision,
      resolve: answer => {
        if (settled) return false
        settled = true
        resolveDecision(answer)
        return true
      },
    }
    project.pendingApprovals.set(request.id, pending)
    return pending
  }

  private awaitApproval(project: ProjectEntry, request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision> {
    const pending = this.registerApproval(project, request)
    const cancel = () => pending.resolve({ id: request.id, decision: 'deny', scope: 'once', decidedBy: 'cancel' })
    if (signal.aborted) cancel()
    else signal.addEventListener('abort', cancel, { once: true })
    return pending.decision.finally(() => {
      signal.removeEventListener('abort', cancel)
      if (project.pendingApprovals.get(request.id) === pending) project.pendingApprovals.delete(request.id)
    })
  }

  private respond(input: SdkInput<'approvals.respond'>): boolean {
    const project = this.project(input.projectId)
    const decision = input.decision
    if (decision === null || typeof decision !== 'object' || typeof decision.id !== 'string') throw invalid('decision.id must be a string')
    if (decision.decision !== 'allow' && decision.decision !== 'deny') throw invalid('decision.decision must be allow or deny')
    const pending = project.pendingApprovals.get(decision.id)
    if (pending === undefined || (pending.sessionId !== input.sessionId && pending.parentSessionId !== input.sessionId)) return false
    return pending.resolve({
      id: decision.id,
      decision: decision.decision,
      scope: decision.decision === 'deny' ? 'once' : decision.scope,
      decidedBy: 'user',
      ...(decision.reason === undefined ? {} : { reason: decision.reason }),
    })
  }

  // -------------------------------------------------------------------------
  // events and accounting
  // -------------------------------------------------------------------------

  private emit(projectId: string, sessionId: string, event: DistributiveOmitBase<SdkEvent>, parentSessionId?: string): void {
    const key = `${projectId}\u0000${sessionId}`
    const eventSeq = (this.eventSeq.get(key) ?? 0) + 1
    this.eventSeq.set(key, eventSeq)
    const full = { ...event, projectId, sessionId, eventSeq, ...(parentSessionId === undefined ? {} : { parentSessionId }) } as SdkEvent
    for (const listener of [...this.listeners]) {
      try {
        listener(full)
      } catch {
        // a subscriber failure must not affect the turn
      }
    }
  }

  /** A project-level (step 4 capability) event: its own per-project counter, no session. */
  private emitProject(projectId: string, event: DistributiveOmitBase<SdkEvent>): void {
    const key = `${projectId}\u0000`
    const eventSeq = (this.eventSeq.get(key) ?? 0) + 1
    this.eventSeq.set(key, eventSeq)
    const full = { ...event, projectId, eventSeq } as SdkEvent
    for (const listener of [...this.listeners]) {
      try {
        listener(full)
      } catch {
        // a subscriber failure must not affect the caller
      }
    }
  }

  /** The project's capability service (`@nexgent/capabilities` is a default row). */
  /**
   * Rework D3: resolve once the project's background learning has nothing it
   * can do now (or `signal` aborts). In-process hosts only (the CLI waits
   * before it exits, so a run's learning is not cut short); resolves at once
   * when the project runs without learning.
   */
  async waitForLearning(projectId: string, signal?: AbortSignal): Promise<'idle' | 'aborted'> {
    const learning = this.project(projectId).app.ctx.get('learning') as LearningHost | undefined
    if (learning === undefined || !learning.busy) return 'idle'
    if (signal?.aborted === true) return 'aborted'
    let onAbort: (() => void) | undefined
    const aborted = new Promise<'aborted'>(resolve => {
      onAbort = () => resolve('aborted')
      signal?.addEventListener('abort', onAbort, { once: true })
    })
    try {
      return await Promise.race([learning.idle().then(() => 'idle' as const), aborted])
    } finally {
      if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort)
    }
  }

  /** Whether the project's background learning is working now (rework D3). */
  learningBusy(projectId: string): boolean {
    return (this.project(projectId).app.ctx.get('learning') as LearningHost | undefined)?.busy === true
  }

  private learner(project: ProjectEntry): LearningHost {
    const host = project.app.ctx.get('learning') as LearningHost | undefined
    if (host === undefined) throw new NexgentError('internal', `project ${project.projectId} runs without @nexgent/evolve`)
    return host
  }

  private capabilities(project: ProjectEntry): CapabilityService {
    const service = capabilitiesOf(project.app.ctx)
    if (service === undefined) throw new NexgentError('internal', `project ${project.projectId} runs without @nexgent/capabilities`)
    return service
  }

  private onEvent(project: ProjectEntry, entry: SessionEntry, event: AgentEvent): void {
    // Register before any listener runs, so `approvals.respond` from the callback finds the request.
    if (event.type === 'approval.request' && this.options.approvalResponder === undefined) this.registerApproval(project, event.request)
    const raw = { ...event, projectId: project.projectId } as ProjectAgentEvent
    for (const listener of [...this.rawListeners]) {
      try {
        listener(raw)
      } catch {
        // as above
      }
    }
    const { projectId } = project
    const sessionId = event.sessionId
    const parentSessionId = entry.agent.parentSessionId
    const send = (mapped: DistributiveOmitBase<SdkEvent>) => this.emit(projectId, sessionId, mapped, parentSessionId)
    if (event.type === 'turn.start' && parentSessionId !== undefined) {
      entry.memberTally = { turn: event.turn, source: 'user', steps: [], toolCalls: 0, tools: new Set(), ended: false }
    }
    const tally = entry.running?.tally ?? entry.pending ?? entry.memberTally
    switch (event.type) {
      case 'turn.start':
        send({ type: 'turn.start', turn: event.turn, source: tally?.turn === event.turn ? tally.source : 'user', ...(event.change === undefined ? {} : { change: event.change }) })
        return
      case 'request.start':
        tally?.steps.push(UNKNOWN_USAGE)
        return
      case 'text.delta':
        send({ type: 'text.delta', turn: event.turn, step: event.step, text: event.text })
        return
      case 'reasoning.delta':
        send({ type: 'reasoning.delta', turn: event.turn, step: event.step, text: event.text })
        return
      case 'request.retry':
        send({ type: 'step.retry', turn: event.turn, step: event.step })
        return
      case 'tool.start':
        send({ type: 'tool.start', turn: event.turn, step: event.step, call: event.call })
        return
      case 'tool.result':
        if (tally !== undefined) {
          tally.toolCalls += 1
          tally.tools.add(event.result.name)
        }
        send({
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
        send({ type: 'approval.request', turn: event.turn, request: event.request })
        return
      case 'approval.decision':
        send({ type: 'approval.decision', turn: event.turn, decision: event.decision })
        return
      case 'assistant.message':
        if (tally !== undefined) {
          if (tally.steps.length === 0) tally.steps.push(event.usage)
          else tally.steps[tally.steps.length - 1] = event.usage
        }
        send({
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
        send({ type: 'error', ...(event.turn === undefined ? {} : { turn: event.turn }), error: event.error, fatal: event.fatal })
        return
      case 'turn.end':
        if (tally !== undefined && tally.turn === event.turn) {
          tally.reason = event.reason
          if (event.reason.kind === 'error') tally.error = event.reason.error
          tally.ended = true
        }
        send({
          type: 'turn.end',
          turn: event.turn,
          reason: event.reason,
          usage: tally !== undefined && tally.turn === event.turn ? addUsage(...tally.steps) : UNKNOWN_USAGE,
          ...(event.cost === undefined ? {} : { cost: event.cost }),
        })
        return
      case 'record':
        this.onRecord(project, entry, event.record, send)
        return
      case 'cost.warning':
        this.emitProject(projectId, { type: 'cost.warning', warning: { ...event.warning, triggerSessionId: sessionId, ts: new Date().toISOString() } })
        return
      case 'closed':
        if (parentSessionId !== undefined && project.sessions.get(sessionId) === entry) {
          entry.unsubscribe()
          project.sessions.delete(sessionId)
        }
        return
      case 'tool-call.start':
        return
    }
  }

  private onRecord(project: ProjectEntry, entry: SessionEntry, record: SessionRecord, send: (mapped: DistributiveOmitBase<SdkEvent>) => void): void {
    switch (record.type) {
      case 'deliverable.presented':
        send({ type: 'deliverable.presented', turn: record.turn, deliverable: record.deliverable })
        return
      case 'turn.files':
        send({ type: 'turn.files', turn: record.turn, changes: record.changes })
        return
      case 'compaction':
        send({ type: 'compaction', turn: record.turn, compactedMessages: record.compactedMessages })
        return
      case 'user.message': {
        if (record.source === 'thread') {
          send({ type: 'thread.message', turn: record.turn, text: record.content })
          return
        }
        const retry = record.source === 'inject' ? checkRetryOf(record.content) : undefined
        if (retry !== undefined) send({ type: 'check.retry', turn: record.turn, retry })
        return
      }
      case 'turn.rewind':
        send({ type: 'turn.rewind', rewind: { toTurn: record.toTurn, restored: [...record.restored], deleted: [...record.deleted] } })
        return
      case 'session.title':
        send({ type: 'session.title', title: record.title })
        return
      case 'subagent.start':
        entry.runStarts.set(runKey(record.childSessionId, record.childTurn), record)
        this.trackMember(project, record.childSessionId)
        send({ type: 'member.start', turn: record.turn, run: memberRunView(record) })
        return
      case 'subagent.end': {
        const start = entry.runStarts.get(runKey(record.childSessionId, record.childTurn))
        if (start !== undefined) send({ type: 'member.end', turn: record.turn, run: memberRunView(start, record) })
        return
      }
      case 'workflow.phase':
        send({ type: 'workflow.phase', turn: record.turn, workflowId: record.workflowId, phase: record.phase })
        return
      case 'organization':
        send({ type: 'organization', turn: record.turn, organization: organizationView(record) })
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
    const use = project.sessions.get(sessionId)?.agent.organizationUse()
    // The ledger keeps the counts only; the coordinator's change note is on the session's records.
    const organization = use === undefined ? undefined : (({ change: _change, ...rest }) => rest)(use)
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
        ...(organization === undefined ? {} : { organization }),
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
      'app.info': async () => ({ sdkVersion: SDK_API_VERSION, appVersion: this.options.appVersion, platform: process.platform, commandShell: this.commandShell() }),

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

      'sessions.list': input => this.listSessions(this.project(input.projectId), input.includeChildren === true),
      'sessions.children': input => this.childSessions(this.project(input.projectId), input.sessionId),
      'sessions.view': input => this.view(this.project(input.projectId), input.sessionId),
      'sessions.collaboration': input => this.collaboration(this.project(input.projectId), input.sessionId),
      'sessions.create': input => this.createSession(input),
      'sessions.coordinator': input => this.coordinatorSession(input),
      'threads.list': async input => {
        if (typeof input.sessionId !== 'string' || input.sessionId === '') throw invalid('sessionId must be a string')
        return this.project(input.projectId).threads.list({ coordinatorSessionId: input.sessionId })
      },
      'sessions.open': async input => {
        const project = this.project(input.projectId)
        // A member is never locked by the SDK: opening one shows it read-only.
        if (await this.isMember(project, input.sessionId)) return this.view(project, input.sessionId)
        return this.openSession(input)
      },
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
        const entry = await this.rootSession(project, input.sessionId)
        await entry.agent.appendHostRecord({ type: 'session.title', title })
        return this.summary(project, input.sessionId)
      },

      'sessions.setMode': async input => {
        const project = this.project(input.projectId)
        if (input.sandboxMode !== undefined && !SANDBOX_MODES.includes(input.sandboxMode)) throw invalid('sandboxMode must be a sandbox mode')
        if (input.plan !== undefined && typeof input.plan !== 'boolean') throw invalid('plan must be a boolean')
        const entry = await this.rootSession(project, input.sessionId)
        await entry.agent.setMode({
          ...(input.sandboxMode === undefined ? {} : { sandboxMode: input.sandboxMode }),
          ...(input.plan === undefined ? {} : { plan: input.plan }),
        })
        return this.view(project, input.sessionId)
      },

      'sessions.rewind': async input => {
        const project = this.project(input.projectId)
        if (typeof input.turn !== 'number' || !Number.isSafeInteger(input.turn) || input.turn < 1) throw invalid('turn must be a positive integer')
        if (input.apply !== undefined && typeof input.apply !== 'boolean') throw invalid('apply must be a boolean')
        const entry = await this.rootSession(project, input.sessionId)
        if (entry.running !== undefined || entry.agent.busy) throw new NexgentError('session/locked', `a turn is running in session ${input.sessionId}`)
        const { records } = await project.app.ctx.session.readAll(input.sessionId)
        const paths = records.flatMap(record => (record.type === 'turn.files' && record.turn >= input.turn ? record.changes.map(change => change.path) : []))
        const { layout } = project.app.ctx.workspace
        const plan = await planRewind({ layout, sessionId: input.sessionId, turn: input.turn, paths })
        const applied = input.apply === true && plan.changes.length > 0
        if (applied) {
          await applyRewind(layout, plan)
          await entry.agent.appendHostRecord({
            type: 'turn.rewind',
            toTurn: input.turn,
            restored: plan.changes.filter(change => change.action === 'restore').map(change => change.path),
            deleted: plan.changes.filter(change => change.action === 'delete').map(change => change.path),
          })
        }
        return { turn: plan.turn, takenAt: plan.takenAt, changes: plan.changes, unchanged: plan.unchanged, applied }
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

      'turns.send': async input => this.send(input),
      'turns.cancel': input => this.cancelTurn({ projectId: input.projectId, sessionId: input.sessionId, cause: 'user' }),
      'approvals.respond': async input => this.respond(input),

      'materials.add': async input => {
        const project = this.project(input.projectId)
        if (typeof input.sourcePath !== 'string' || input.sourcePath === '') throw invalid('sourcePath must be a path')
        const entry = input.sessionId === undefined ? undefined : await this.rootSession(project, input.sessionId)
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
      'projects.revealData': async input => {
        const reveal = this.options.reveal
        if (reveal === undefined) throw new NexgentError('internal', 'revealing files is only available in the desktop app')
        await reveal(this.project(input.projectId).app.ctx.workspace.layout.dataDir)
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
        const entry = await this.rootSession(project, input.sessionId)
        const goal = await project.tasking.goals.set(entry.agent.appendHostRecord, input.text)
        this.emit(project.projectId, input.sessionId, { type: 'goal', goal })
        return goal
      },
      'goals.update': async input => {
        const project = this.project(input.projectId)
        const entry = await this.rootSession(project, input.sessionId)
        const goal = await project.tasking.goals.update(entry.agent.appendHostRecord, input.sessionId, {
          status: input.status,
          ...(input.text === undefined ? {} : { text: input.text }),
          ...(input.note === undefined ? {} : { note: input.note }),
        })
        this.emit(project.projectId, input.sessionId, { type: 'goal', goal })
        return goal
      },

      'settings.get': async input => {
        const { layout } = this.project(input.projectId).app.ctx.workspace
        return { ...(await readSettings(layout.configFile, this.credentialEnv)), dataDir: layout.dataDir }
      },
      'settings.update': async input => {
        const { layout } = this.project(input.projectId).app.ctx.workspace
        return { ...(await updateSettings(layout.configFile, input.patch, this.credentialEnv)), dataDir: layout.dataDir }
      },
      'settings.setApiKey': input => setApiKey(this.credentialEnv, input?.value),

      // Step 4: project-level, over `@nexgent/capabilities` (events carry no session).
      'capabilities.current': async input => {
        const project = this.project(input.projectId)
        const before = await this.capabilities(project).store.activation()
        const current = await capabilities.currentView(this.capabilities(project))
        if (current.revision !== before.revision) this.emitProject(project.projectId, { type: 'capability.version', current })
        return current
      },
      'capabilities.list': input => capabilities.listing(this.capabilities(this.project(input.projectId))),
      'capabilities.rollback': async input => {
        const project = this.project(input.projectId)
        const current = await capabilities.rollback(this.capabilities(project), input.toVersion, input.reason)
        this.emitProject(project.projectId, { type: 'capability.version', current })
        return current
      },
      // API 7: user-level settings (`<NEXGENT_HOME>/config.json`), shared by every project.
      'userSettings.get': () => readUserSettings(this.home),
      'userSettings.update': input => updateUserSettings(this.home, input?.patch),
      // API 8 (rework C1): the handbook and the learning view come from @nexgent/evolve's layer-1 learner.
      'handbook.list': input => learning.handbookList(this.learner(this.project(input.projectId)), input),
      'handbook.show': input => learning.handbookShow(this.learner(this.project(input.projectId)), input.entryId),
      'handbook.setStatus': input => learning.handbookSetStatus(this.learner(this.project(input.projectId)), input),
      'learning.status': input => {
        const project = this.project(input.projectId)
        return learning.learningStatus(this.learner(project), this.home, project.app.ctx.get('ledger'), this.now(), project.app.ctx.get('organizations'))
      },
      'learning.acknowledge': () => acknowledgeLearning(this.home),
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

/** `deliverables.readText` limit for a spreadsheet, Word document or PDF (read as its extracted text). */
export const READ_DOCUMENT_MAX_BYTES = 20 * 1024 * 1024

async function readSnapshotText(project: ProjectEntry, input: { readonly deliverableId: string; readonly version: number; readonly path: string }): Promise<string> {
  const file = await snapshotFile(project, input)
  const size = (await stat(file)).size
  const extension = extname(input.path).toLowerCase()
  if (extension === '.xlsx' || extension === '.docx' || extension === '.pdf') {
    if (size > READ_DOCUMENT_MAX_BYTES) throw invalid(`${input.path} is ${size} bytes; readText is limited to ${READ_DOCUMENT_MAX_BYTES} for documents`)
    const bytes = await readFile(file)
    try {
      return extension === '.xlsx' ? extractXlsx(bytes) : extension === '.docx' ? extractDocx(bytes) : await extractPdf(bytes)
    } catch (error) {
      throw invalid(`${input.path} could not be read: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
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
