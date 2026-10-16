/**
 * Renderer state: one observable store that owns the SDK client, keeps what
 * the three columns show, and turns user intents into SDK calls. React reads
 * it with `useSyncExternalStore` (see `useStore`); tests drive it directly.
 *
 * Failures never throw out of an action: they become a notice (banner) so a
 * broken backend shows an error instead of a blank window.
 */
import type { ApprovalRequest, DeliverableSummary, ErrorInfo, FeedbackRating, Goal, GoalStatus, LLMUsage, MaterialMetadata, SandboxMode } from '@nexgent/kernel'
import type { ImproverBundle } from '@nexgent/kernel'
import type { LearningConfig } from '@nexgent/kernel'
import type { CandidateDetail, CapabilityListing, HandbookEntryDetail, HandbookListing, ImprovementDetail, ImprovementListing, ImproverListing, LearningStatus, ProjectFileListing, ProjectInfo, ProjectSettings, SdkEvent, SessionSummary, SettingsPatch, UserSettings, UserSettingsPatch } from '@nexgent/sdk'
import { SdkClient, errorInfoOf, type NexgentBridge } from './bridge.js'
import { applyEvent, feedbackEntry, fromHistory, userEntry, withWorkflows, workflowKey, type TimelineEntry } from './timeline.js'

export interface Notice {
  readonly id: number
  readonly error: ErrorInfo
}

export interface SessionMeta {
  readonly model: string
  readonly sandboxMode: SandboxMode
  readonly totalUsage: LLMUsage
}

/** Step 3: a member's session shown read-only in the middle column. */
export interface MemberView {
  readonly sessionId: string
  readonly parentSessionId: string
  readonly name: string
  readonly loading: boolean
  readonly summary?: SessionSummary | undefined
  readonly timeline: readonly TimelineEntry[]
}

export interface AppState {
  /** `unavailable`: no preload bridge at all. */
  readonly backend: 'connecting' | 'ready' | 'unavailable'
  readonly appVersion?: string | undefined
  readonly platform: string
  /** Windows without PowerShell 7: no command can run; shown until dismissed. */
  readonly shellMissing?: boolean | undefined
  readonly recent: readonly ProjectInfo[]
  readonly project?: ProjectInfo | undefined
  readonly sessions: readonly SessionSummary[]
  readonly sessionId?: string | undefined
  readonly sessionMeta?: SessionMeta | undefined
  readonly sessionLoading: boolean
  readonly timeline: readonly TimelineEntry[]
  /** A turn runs in the selected session. */
  readonly running: boolean
  readonly stopping: boolean
  readonly pendingApprovals: readonly ApprovalRequest[]
  readonly materials: readonly MaterialMetadata[]
  readonly deliverables: readonly DeliverableSummary[]
  /** The project folder's files (`files.list`); loaded when the 文件 tab first shows. */
  readonly projectFiles?: ProjectFileListing | undefined
  readonly goal: Goal | null
  readonly settings?: ProjectSettings | undefined
  readonly notices: readonly Notice[]
  /** Materials added in the selected session since its last message; sent with the next one. */
  readonly freshMaterialIds: readonly string[]
  /** Step 3: the member session opened from a member block (read-only); absent shows the conversation. */
  readonly memberView?: MemberView | undefined
  /** Step 4: the project's adopted capability version, history and candidates. */
  readonly capabilities?: CapabilityListing | undefined
  /** Step 4: the candidate opened in the 能力 tab. */
  readonly candidateDetail?: CandidateDetail | undefined
  /** Step 4: a plugin candidate awaiting the user's approval, shown in its dialog. */
  readonly pluginApproval?: CandidateDetail | undefined
  /** Step 5: improvement jobs, the pending count and the budget window. */
  readonly improvements?: ImprovementListing | undefined
  /** Step 5: the job opened in the 改进 tab. */
  readonly improvementDetail?: ImprovementDetail | undefined
  /** Step 6: the improver in force and its activation history. */
  readonly improver?: ImproverListing | undefined
  /** API 7: user-level settings (the shared improver's meta switch and budget). */
  readonly userSettings?: UserSettings | undefined
  /** Step 6: the parent improver of the open meta job's change (for the before / after view). */
  readonly improvementParent?: ImproverBundle | undefined
  /** Rework D2: the handbook entries this project sees, retired ones included (能力 → 经验). */
  readonly handbook?: HandbookListing | undefined
  /** Rework D2: the entry opened on the 能力 page, with its history. */
  readonly handbookDetail?: HandbookEntryDetail | undefined
  /** Rework D2: learning switch, spend against the budget, self-evaluations. */
  readonly learning?: LearningStatus | undefined
}

const INITIAL: AppState = {
  backend: 'connecting',
  platform: 'unknown',
  recent: [],
  sessions: [],
  sessionLoading: false,
  timeline: [],
  running: false,
  stopping: false,
  pendingApprovals: [],
  materials: [],
  deliverables: [],
  goal: null,
  notices: [],
  freshMaterialIds: [],
}

/** How often the capability list is re-read while a gate trial runs. */
export const TRIAL_POLL_MS = 5_000

/** A candidate proposed this recently may have its gate started on its own when the task ends (in another process, with no event): keep re-reading. */
export const PROPOSED_POLL_WINDOW_MS = 10 * 60_000

export class AppStore {
  private state: AppState = INITIAL
  private readonly listeners = new Set<() => void>()
  private noticeCounter = 0
  private unsubscribe: (() => void) | undefined
  readonly client: SdkClient | undefined

  constructor(bridge: NexgentBridge | undefined) {
    this.client = bridge === undefined ? undefined : new SdkClient(bridge)
    if (bridge === undefined) this.state = { ...INITIAL, backend: 'unavailable' }
    else this.state = { ...INITIAL, platform: bridge.platform }
  }

  // --- store plumbing -------------------------------------------------------

  getState = (): AppState => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private set(patch: Partial<AppState> | ((state: AppState) => Partial<AppState>)): void {
    const delta = typeof patch === 'function' ? patch(this.state) : patch
    this.state = { ...this.state, ...delta }
    for (const listener of this.listeners) listener()
  }

  notify(error: unknown): void {
    this.noticeCounter += 1
    const notice = { id: this.noticeCounter, error: errorInfoOf(error) }
    this.set(state => ({ notices: [...state.notices, notice] }))
  }

  dismissShellMissing(): void {
    this.set({ shellMissing: false })
  }

  dismissNotice(id: number): void {
    this.set(state => ({ notices: state.notices.filter(notice => notice.id !== id) }))
  }

  /**
   * Per list (or open detail), the number of the latest read started. Reads
   * can answer out of order (a refresh started by an event before a user
   * action may answer after the refresh started by that action), so only the
   * latest read's answer is kept; a direct write from a user action starts a
   * new number too, dropping reads still in flight.
   */
  private readonly reads = new Map<string, number>()

  /** Start a read of `key`; the returned check says whether it is still the latest. */
  private startRead(key: string): () => boolean {
    const ticket = (this.reads.get(key) ?? 0) + 1
    this.reads.set(key, ticket)
    return () => this.reads.get(key) === ticket
  }

  private async guard<T>(work: (client: SdkClient) => Promise<T>): Promise<T | undefined> {
    if (this.client === undefined) return undefined
    try {
      return await work(this.client)
    } catch (error) {
      this.notify(error)
      return undefined
    }
  }

  // --- lifecycle ------------------------------------------------------------

  async init(): Promise<void> {
    const client = this.client
    if (client === undefined) return
    this.unsubscribe?.()
    try {
      this.unsubscribe = client.onEvent(event => this.onEvent(event))
    } catch (error) {
      this.notify(error)
    }
    await this.guard(async c => {
      const info = await c.call('app.info', {})
      const recent = await c.call('projects.recent', {})
      this.set({ backend: 'ready', appVersion: info.appVersion, platform: info.platform, shellMissing: info.commandShell?.available === false, recent })
    })
    if (this.state.backend !== 'ready') this.set({ backend: 'ready' })
  }

  /** At start-up: reopen the newest recent project (the `--project` one heads the list). */
  async openLastProject(): Promise<void> {
    const last = this.state.recent.find(project => project.exists)
    if (last !== undefined && this.state.project === undefined) await this.openProject(last.root)
  }

  dispose(): void {
    this.unsubscribe?.()
    this.unsubscribe = undefined
    if (this.trialPoll !== undefined) clearTimeout(this.trialPoll)
    this.trialPoll = undefined
  }

  // --- projects -------------------------------------------------------------

  async refreshRecent(): Promise<void> {
    const latest = this.startRead('recent')
    await this.guard(async c => {
      const recent = await c.call('projects.recent', {})
      if (latest()) this.set({ recent })
    })
  }

  async openProject(root: string, create = false): Promise<boolean> {
    const project = await this.guard(c => c.call('projects.open', create ? { root, create: true } : { root }))
    if (project === undefined) return false
    this.set({
      project,
      sessions: [],
      sessionMeta: undefined,
      sessionId: undefined,
      timeline: [],
      running: false,
      stopping: false,
      pendingApprovals: [],
      materials: [],
      deliverables: [],
      projectFiles: undefined,
      goal: null,
      settings: undefined,
      freshMaterialIds: [],
      memberView: undefined,
      capabilities: undefined,
      candidateDetail: undefined,
      pluginApproval: undefined,
      improvements: undefined,
      improvementDetail: undefined,
      improver: undefined,
      improvementParent: undefined,
      handbook: undefined,
      handbookDetail: undefined,
      learning: undefined,
    })
    await Promise.all([this.refreshSessions(), this.refreshMaterials(), this.refreshDeliverables(), this.refreshSettings(), this.refreshRecent(), this.refreshCapabilities(), this.refreshImprovements(), this.refreshImprover(), this.refreshUserSettings(), this.refreshLearning()])
    const first = this.state.sessions[0]
    if (first !== undefined) await this.openSession(first.sessionId)
    return true
  }

  async pickAndOpenProject(create = false): Promise<void> {
    const root = await this.guard(c => c.pickDirectory())
    if (root) await this.openProject(root, create)
  }

  async forgetProject(root: string): Promise<void> {
    await this.guard(async c => {
      await c.call('projects.forget', { root })
      const latest = this.startRead('recent')
      const recent = await c.call('projects.recent', {})
      if (latest()) this.set({ recent })
    })
  }

  /** Back to the start screen; the project stays open in the backend (running turns go on). */
  leaveProject(): void {
    this.set({ project: undefined, sessionId: undefined, sessionMeta: undefined, timeline: [], running: false, pendingApprovals: [], memberView: undefined, capabilities: undefined, candidateDetail: undefined, pluginApproval: undefined, improvements: undefined, improvementDetail: undefined, improver: undefined, improvementParent: undefined, handbook: undefined, handbookDetail: undefined, learning: undefined })
    void this.refreshRecent()
  }

  // --- project data ---------------------------------------------------------

  private get projectId(): string | undefined {
    return this.state.project?.projectId
  }

  async refreshSessions(): Promise<void> {
    const projectId = this.projectId
    if (projectId === undefined) return
    const latest = this.startRead('sessions')
    await this.guard(async c => {
      const sessions = [...(await c.call('sessions.list', { projectId }))].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      if (this.projectId === projectId && latest()) this.set({ sessions })
    })
  }

  async refreshMaterials(): Promise<void> {
    const projectId = this.projectId
    if (projectId === undefined) return
    const latest = this.startRead('materials')
    await this.guard(async c => {
      const materials = await c.call('materials.list', { projectId })
      if (this.projectId === projectId && latest()) this.set({ materials })
    })
  }

  async refreshDeliverables(): Promise<void> {
    const projectId = this.projectId
    if (projectId === undefined) return
    const latest = this.startRead('deliverables')
    await this.guard(async c => {
      const deliverables = await c.call('deliverables.list', { projectId })
      if (this.projectId === projectId && latest()) this.set({ deliverables })
    })
  }

  async refreshFiles(): Promise<void> {
    const projectId = this.projectId
    if (projectId === undefined) return
    const latest = this.startRead('projectFiles')
    await this.guard(async c => {
      const projectFiles = await c.call('files.list', { projectId })
      if (this.projectId === projectId && latest()) this.set({ projectFiles })
    })
  }

  // --- capability versions (step 4) ------------------------------------------

  async refreshCapabilities(): Promise<void> {
    const projectId = this.projectId
    if (projectId === undefined) return
    const latest = this.startRead('capabilities')
    await this.guard(async c => {
      const capabilities = await c.call('capabilities.list', { projectId })
      if (this.projectId !== projectId || !latest()) return
      this.set({ capabilities })
      const now = Date.now()
      this.pollWhileTrialing(capabilities.candidates.some(candidate => candidate.status === 'trialing'
        || (candidate.status === 'proposed' && now - Date.parse(candidate.proposedAt) < PROPOSED_POLL_WINDOW_MS)))
      // A plugin that passed its gate waits for the user: ask once per candidate.
      const waiting = capabilities.candidates.find(candidate => candidate.status === 'awaiting-approval' && !this.askedApproval.has(candidate.id))
      if (waiting !== undefined && this.state.pluginApproval === undefined) await this.askPluginApproval(waiting.id)
      const open = this.state.candidateDetail
      if (open !== undefined) {
        const now = capabilities.candidates.find(candidate => candidate.id === open.view.id)
        if (now !== undefined && now.status !== open.view.status) await this.showCandidate(open.view.id)
      }
    })
  }

  /**
   * A gate trial runs and decides in its own process, which sends no event to
   * this window; while a candidate is trialing, re-read the list every few
   * seconds so its result shows without a restart.
   */
  private trialPoll: ReturnType<typeof setTimeout> | undefined

  private pollWhileTrialing(trialing: boolean): void {
    if (this.trialPoll !== undefined) clearTimeout(this.trialPoll)
    this.trialPoll = trialing ? setTimeout(() => {
      this.trialPoll = undefined
      void this.refreshCapabilities()
    }, TRIAL_POLL_MS) : undefined
  }

  /** Candidates whose approval dialog was already shown (closing it without answering does not reopen it). */
  private readonly askedApproval = new Set<string>()

  /** Open (or close, when it is open) a candidate's details. */
  async toggleCandidate(candidateId: string): Promise<void> {
    if (this.state.candidateDetail?.view.id === candidateId) {
      this.startRead('candidateDetail')
      this.set({ candidateDetail: undefined })
      return
    }
    await this.showCandidate(candidateId)
  }

  private async showCandidate(candidateId: string): Promise<void> {
    const projectId = this.projectId
    if (projectId === undefined) return
    const latest = this.startRead('candidateDetail')
    const candidateDetail = await this.guard(c => c.call('capabilities.show', { projectId, candidateId }))
    if (candidateDetail !== undefined && this.projectId === projectId && latest()) this.set({ candidateDetail })
  }

  async askPluginApproval(candidateId: string): Promise<void> {
    const projectId = this.projectId
    if (projectId === undefined) return
    this.askedApproval.add(candidateId)
    const pluginApproval = await this.guard(c => c.call('capabilities.show', { projectId, candidateId }))
    if (pluginApproval !== undefined && this.projectId === projectId && pluginApproval.view.status === 'awaiting-approval') this.set({ pluginApproval })
  }

  closePluginApproval(): void {
    this.set({ pluginApproval: undefined })
  }

  async answerPluginApproval(decision: 'allow' | 'deny'): Promise<void> {
    const projectId = this.projectId
    const candidate = this.state.pluginApproval
    if (projectId === undefined || candidate === undefined) return
    // Allow only when every plugin's plugin.json could be shown.
    const plugins = candidate.record.components.filter(component => component.kind === 'plugin')
    if (decision === 'allow' && !plugins.every(component => candidate.plugins?.some(info => info.name === component.name))) return
    this.set({ pluginApproval: undefined })
    await this.guard(c => c.call('capabilities.approve', { projectId, candidateId: candidate.view.id, decision }))
    await this.refreshCapabilities()
  }

  // --- learning (rework D2) -----------------------------------------------------

  /** The handbook (retired entries included) and the learning status; the open entry is re-read when it changed. */
  async refreshLearning(): Promise<void> {
    const projectId = this.projectId
    if (projectId === undefined) return
    const latest = this.startRead('learning')
    await this.guard(async c => {
      const [handbook, learning] = await Promise.all([c.call('handbook.list', { projectId, includeRetired: true }), c.call('learning.status', { projectId })])
      if (this.projectId !== projectId || !latest()) return
      this.set({ handbook, learning })
      const open = this.state.handbookDetail
      const now = open === undefined ? undefined : handbook.entries.find(entry => entry.id === open.entry.id)
      if (open !== undefined && now !== undefined && now.updatedAt !== open.entry.updatedAt) await this.showHandbookEntry(open.entry.id)
    })
  }

  /** Open (or close, when it is open) an entry's history. */
  async toggleHandbookEntry(entryId: string): Promise<void> {
    if (this.state.handbookDetail?.entry.id === entryId) {
      this.startRead('handbookDetail')
      this.set({ handbookDetail: undefined })
      return
    }
    await this.showHandbookEntry(entryId)
  }

  private async showHandbookEntry(entryId: string): Promise<void> {
    const projectId = this.projectId
    if (projectId === undefined) return
    const latest = this.startRead('handbookDetail')
    const handbookDetail = await this.guard(c => c.call('handbook.show', { projectId, entryId }))
    if (handbookDetail !== undefined && this.projectId === projectId && latest()) this.set({ handbookDetail })
  }

  /** The user stops an entry or takes it back. */
  async setHandbookStatus(entryId: string, status: 'active' | 'retired'): Promise<boolean> {
    const projectId = this.projectId
    if (projectId === undefined) return false
    const detail = await this.guard(c => c.call('handbook.setStatus', { projectId, entryId, status }))
    if (detail === undefined) return false
    this.startRead('handbookDetail')
    this.set(state => ({ handbookDetail: state.handbookDetail?.entry.id === entryId ? detail : state.handbookDetail }))
    await this.refreshLearning()
    return true
  }

  /** Change the project's learning settings (a user action; the SDK keeps the retired `autoImprove` equal to `enabled`). */
  async saveLearning(change: Partial<Omit<LearningConfig, 'budget'>> & { readonly budget?: Partial<LearningConfig['budget']> }): Promise<boolean> {
    const current = this.state.settings?.learning
    if (current === undefined) return false
    const ok = await this.saveSettings({ learning: { ...current, ...change, budget: { ...current.budget, ...change.budget } } })
    if (ok) void this.refreshLearning()
    return ok
  }

  /** The one-time notice about background learning was read (ADR 0017 decision 3). */
  async acknowledgeLearning(): Promise<boolean> {
    const userSettings = await this.guard(c => c.call('learning.acknowledge', {}))
    if (userSettings === undefined) return false
    this.startRead('userSettings')
    this.set({ userSettings })
    void this.refreshLearning()
    return true
  }

  // --- improvement jobs (step 5) ---------------------------------------------

  async refreshImprovements(): Promise<void> {
    const projectId = this.projectId
    if (projectId === undefined) return
    const latest = this.startRead('improvements')
    await this.guard(async c => {
      const improvements = await c.call('improvements.list', { projectId })
      if (this.projectId !== projectId || !latest()) return
      this.set({ improvements })
      // Keep the open job fresh (its status, candidate and gate move on).
      const open = this.state.improvementDetail
      if (open !== undefined) {
        const now = improvements.jobs.find(job => job.id === open.view.id)
        if (now !== undefined && (now.updatedAt !== open.view.updatedAt || now.status !== open.view.status)) await this.showImprovement(open.view.id)
      }
    })
  }

  /** Open (or close, when it is open) a job's details. */
  async toggleImprovement(jobId: string): Promise<void> {
    if (this.state.improvementDetail?.view.id === jobId) {
      this.startRead('improvementDetail')
      this.set({ improvementDetail: undefined, improvementParent: undefined })
      return
    }
    await this.showImprovement(jobId)
  }

  private async showImprovement(jobId: string): Promise<void> {
    const projectId = this.projectId
    if (projectId === undefined) return
    const latest = this.startRead('improvementDetail')
    const improvementDetail = await this.guard(c => c.call('improvements.show', { projectId, jobId }))
    if (improvementDetail === undefined || this.projectId !== projectId || !latest()) return
    this.set({ improvementDetail, ...(improvementDetail.change === undefined ? { improvementParent: undefined } : {}) })
    // A meta job's change is shown against its parent improver.
    const parentVersion = improvementDetail.change?.parentVersion
    if (parentVersion === undefined) return
    const parent = await this.guard(c => c.call('improvers.show', { version: parentVersion }))
    if (parent !== undefined && this.projectId === projectId && latest()) this.set({ improvementParent: parent.bundle })
  }

  // --- improver versions and meta jobs (step 6) ------------------------------

  async refreshImprover(): Promise<void> {
    const latest = this.startRead('improver')
    await this.guard(async c => {
      const improver = await c.call('improvers.list', {})
      if (latest()) this.set({ improver })
    })
  }

  /** The explicit "meta-improve now"; busy / budget errors surface as notices like `runImprovement`. */
  async runMetaImprovement(): Promise<boolean> {
    const projectId = this.projectId
    if (projectId === undefined) return false
    const job = await this.guard(c => c.call('improvements.runMeta', { projectId }))
    await this.refreshImprovements()
    return job !== undefined
  }

  async rollbackImprover(reason?: string): Promise<boolean> {
    const text = reason?.trim()
    const current = await this.guard(c => c.call('improvers.rollback', { ...(text === undefined || text === '' ? {} : { reason: text }) }))
    await this.refreshImprover()
    return current !== undefined
  }

  /** The explicit "improve now"; `improvement/busy` and `improvement/budget-exhausted` surface as notices. */
  async runImprovement(input: { readonly sessionId?: string; readonly deliverableId?: string } = {}): Promise<boolean> {
    const projectId = this.projectId
    if (projectId === undefined) return false
    const job = await this.guard(c =>
      c.call('improvements.run', {
        projectId,
        ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
        ...(input.deliverableId === undefined ? {} : { deliverableId: input.deliverableId }),
      }),
    )
    await this.refreshImprovements()
    return job !== undefined
  }

  async cancelImprovement(jobId: string): Promise<void> {
    const projectId = this.projectId
    if (projectId === undefined) return
    await this.guard(c => c.call('improvements.cancel', { projectId, jobId }))
    await this.refreshImprovements()
  }

  async startTrial(candidateId: string): Promise<void> {
    const projectId = this.projectId
    if (projectId === undefined) return
    await this.guard(c => c.call('capabilities.trial', { projectId, candidateId }))
    await this.refreshCapabilities()
  }

  async rollbackCapability(reason?: string): Promise<boolean> {
    const projectId = this.projectId
    if (projectId === undefined) return false
    const text = reason?.trim()
    const current = await this.guard(c => c.call('capabilities.rollback', { projectId, ...(text === undefined || text === '' ? {} : { reason: text }) }))
    await this.refreshCapabilities()
    return current !== undefined
  }

  async refreshSettings(): Promise<void> {
    const projectId = this.projectId
    if (projectId === undefined) return
    const latest = this.startRead('settings')
    await this.guard(async c => {
      const settings = await c.call('settings.get', { projectId })
      if (this.projectId === projectId && latest()) this.set({ settings })
    })
  }

  // --- sessions -------------------------------------------------------------

  async newSession(): Promise<void> {
    const projectId = this.projectId
    if (projectId === undefined) return
    const summary = await this.guard(c => c.call('sessions.create', { projectId }))
    if (summary === undefined) return
    this.set(state => ({ sessions: [summary, ...state.sessions.filter(s => s.sessionId !== summary.sessionId)] }))
    // A new conversation runs on the version adopted now (the gate may have adopted one in its own process).
    await Promise.all([this.openSession(summary.sessionId), this.refreshCapabilities(), this.refreshImprovements()])
  }

  /** Rename a conversation; an empty title is ignored. */
  async renameSession(sessionId: string, title: string): Promise<boolean> {
    const projectId = this.projectId
    const trimmed = title.trim()
    if (projectId === undefined || trimmed.length === 0) return false
    const summary = await this.guard(c => c.call('sessions.rename', { projectId, sessionId, title: trimmed }))
    if (summary === undefined || this.projectId !== projectId) return false
    this.set(state => ({ sessions: state.sessions.map(s => (s.sessionId === sessionId ? keepChildCount(summary, s) : s)) }))
    return true
  }

  async openSession(sessionId: string): Promise<void> {
    const projectId = this.projectId
    if (projectId === undefined) return
    this.set({ sessionId, sessionLoading: true, timeline: [], pendingApprovals: [], running: false, stopping: false, goal: null, freshMaterialIds: [], memberView: undefined })
    const view = await this.guard(c => c.call('sessions.open', { projectId, sessionId }))
    if (this.state.sessionId !== sessionId) return
    if (view === undefined) {
      this.set({ sessionLoading: false })
      return
    }
    const pending = view.items.flatMap(item => (item.kind === 'approval' && item.decision === undefined && view.summary.running ? [item.request] : []))
    this.set(state => ({
      sessionLoading: false,
      sessionMeta: { model: view.model, sandboxMode: view.sandboxMode, totalUsage: view.totalUsage },
      timeline: fromHistory(view.items),
      running: view.summary.running,
      pendingApprovals: pending,
      goal: view.summary.goal ?? null,
      sessions: state.sessions.map(s => (s.sessionId === sessionId ? keepChildCount(view.summary, s) : s)),
    }))
  }

  // --- members (step 3) -----------------------------------------------------

  /** Show a member's session read-only (`sessions.view`: no lock, no turns). */
  async openMember(childSessionId: string, name: string): Promise<void> {
    const projectId = this.projectId
    const parentSessionId = this.state.sessionId
    if (projectId === undefined || parentSessionId === undefined) return
    this.set({ memberView: { sessionId: childSessionId, parentSessionId, name, loading: true, timeline: [] } })
    const view = await this.guard(c => c.call('sessions.view', { projectId, sessionId: childSessionId }))
    if (this.state.memberView?.sessionId !== childSessionId) return
    if (view === undefined) {
      this.set({ memberView: undefined })
      return
    }
    this.set({ memberView: { sessionId: childSessionId, parentSessionId, name, loading: false, summary: view.summary, timeline: fromHistory(view.items) } })
  }

  /** Back from a member's session to its conversation. */
  closeMember(): void {
    this.set({ memberView: undefined })
  }

  /** Fill in workflows the timeline only knows from their phases or members. */
  private async refreshWorkflows(sessionId: string, turn: number): Promise<void> {
    const projectId = this.projectId
    if (projectId === undefined) return
    const collaboration = await this.guard(c => c.call('sessions.collaboration', { projectId, sessionId }))
    if (collaboration === undefined || this.state.sessionId !== sessionId) return
    this.set(state => ({ timeline: withWorkflows(state.timeline, collaboration.workflows, turn) }))
  }

  // --- turns ----------------------------------------------------------------

  async send(text: string, mentioned: readonly string[]): Promise<boolean> {
    const projectId = this.projectId
    const sessionId = this.state.sessionId
    const trimmed = text.trim()
    if (projectId === undefined || sessionId === undefined || trimmed.length === 0 || this.state.running) return false
    const materialIds = [...new Set([...mentioned, ...this.state.freshMaterialIds])]
    const names = materialIds.map(id => this.state.materials.find(m => m.id === id)?.originalName ?? id)
    this.set({ running: true })
    const handle = await this.guard(c => c.call('turns.send', { projectId, sessionId, text: trimmed, ...(materialIds.length > 0 ? { materialIds } : {}) }))
    if (handle === undefined) {
      this.set({ running: false })
      return false
    }
    if (this.state.sessionId === sessionId) {
      // Insert before any entry the turn already produced (events may arrive before the call resolves).
      this.set(state => {
        const at = state.timeline.findIndex(entry => (entry.turn ?? 0) >= handle.turn && entry.kind !== 'turn.end')
        const entry = userEntry(handle.turn, trimmed, names)
        const timeline = at === -1 ? [...state.timeline, entry] : [...state.timeline.slice(0, at), entry, ...state.timeline.slice(at)]
        return { timeline, freshMaterialIds: [] }
      })
    }
    return true
  }

  async cancel(): Promise<void> {
    const projectId = this.projectId
    const sessionId = this.state.sessionId
    if (projectId === undefined || sessionId === undefined || !this.state.running) return
    this.set({ stopping: true })
    await this.guard(c => c.call('turns.cancel', { projectId, sessionId }))
    if (this.state.sessionId === sessionId) this.set({ stopping: false })
  }

  async respondApproval(request: ApprovalRequest, decision: 'allow' | 'deny', scope: 'once' | 'session' | 'project'): Promise<void> {
    const projectId = this.projectId
    if (projectId === undefined) return
    this.set(state => ({ pendingApprovals: state.pendingApprovals.filter(r => r.id !== request.id) }))
    await this.guard(c =>
      c.call('approvals.respond', { projectId, sessionId: request.sessionId, decision: { id: request.id, decision, scope: decision === 'deny' ? 'once' : scope } }),
    )
  }

  // --- materials ------------------------------------------------------------

  async addMaterials(paths: readonly string[]): Promise<void> {
    const projectId = this.projectId
    if (projectId === undefined) return
    const sessionId = this.state.sessionId
    for (const sourcePath of paths) {
      const material = await this.guard(c => c.call('materials.add', { projectId, sourcePath, ...(sessionId === undefined ? {} : { sessionId }) }))
      if (material === undefined) continue
      this.set(state => ({
        materials: state.materials.some(m => m.id === material.id) ? state.materials : [...state.materials, material],
        freshMaterialIds: sessionId !== undefined && state.sessionId === sessionId ? [...new Set([...state.freshMaterialIds, material.id])] : state.freshMaterialIds,
      }))
    }
  }

  async pickAndAddMaterials(): Promise<void> {
    const paths = await this.guard(c => c.pickFiles())
    if (paths !== undefined && paths.length > 0) await this.addMaterials(paths)
  }

  async removeMaterial(materialId: string): Promise<void> {
    const projectId = this.projectId
    if (projectId === undefined) return
    const removed = await this.guard(c => c.call('materials.remove', { projectId, materialId }))
    if (removed === undefined) return
    this.set(state => ({ materials: state.materials.filter(m => m.id !== materialId), freshMaterialIds: state.freshMaterialIds.filter(id => id !== materialId) }))
  }

  // --- feedback and goals ---------------------------------------------------

  async submitFeedback(deliverableId: string, version: number, rating: FeedbackRating | undefined, comment: string): Promise<boolean> {
    const projectId = this.projectId
    const sessionId = this.state.sessionId
    if (projectId === undefined || sessionId === undefined || this.state.running || comment.trim().length === 0) return false
    this.set({ running: true })
    const handle = await this.guard(c =>
      c.call('feedback.submit', { projectId, sessionId, deliverableId, version, comment: comment.trim(), ...(rating === undefined ? {} : { rating }) }),
    )
    if (handle === undefined) {
      this.set({ running: false })
      return false
    }
    if (this.state.sessionId === sessionId) {
      this.set(state => {
        const at = state.timeline.findIndex(entry => (entry.turn ?? 0) >= handle.turn && entry.kind !== 'turn.end')
        const entry = feedbackEntry(handle.turn, deliverableId, version, rating, comment.trim())
        return { timeline: at === -1 ? [...state.timeline, entry] : [...state.timeline.slice(0, at), entry, ...state.timeline.slice(at)] }
      })
    }
    return true
  }

  async setGoal(text: string): Promise<void> {
    const projectId = this.projectId
    const sessionId = this.state.sessionId
    if (projectId === undefined || sessionId === undefined || text.trim().length === 0) return
    const goal = await this.guard(c => c.call('goals.set', { projectId, sessionId, text: text.trim() }))
    if (goal !== undefined && this.state.sessionId === sessionId) this.set({ goal })
  }

  async updateGoal(status: GoalStatus): Promise<void> {
    const projectId = this.projectId
    const sessionId = this.state.sessionId
    if (projectId === undefined || sessionId === undefined) return
    const goal = await this.guard(c => c.call('goals.update', { projectId, sessionId, status }))
    if (goal !== undefined && this.state.sessionId === sessionId) this.set({ goal })
  }

  // --- settings -------------------------------------------------------------

  async saveSettings(patch: SettingsPatch): Promise<boolean> {
    const projectId = this.projectId
    if (projectId === undefined) return false
    const settings = await this.guard(c => c.call('settings.update', { projectId, patch }))
    if (settings === undefined) return false
    this.startRead('settings')
    this.set({ settings })
    // The 改进 tab shows switches and budgets from the settings, the 经验 tab the learning ones.
    if (patch.autoImprove !== undefined || patch.improvement !== undefined || patch.learning !== undefined) void this.refreshImprovements()
    if (patch.autoImprove !== undefined || patch.learning !== undefined) void this.refreshLearning()
    return true
  }

  /** API 7: the user-level settings (shared by every project). */
  async refreshUserSettings(): Promise<void> {
    const latest = this.startRead('userSettings')
    await this.guard(async c => {
      const userSettings = await c.call('userSettings.get', {})
      if (latest()) this.set({ userSettings })
    })
  }

  /** A user action, no approval; the improvements listing shows the user-level meta state, so it is refreshed. */
  async saveUserSettings(patch: UserSettingsPatch): Promise<boolean> {
    const userSettings = await this.guard(c => c.call('userSettings.update', { patch }))
    if (userSettings === undefined) return false
    this.startRead('userSettings')
    this.set({ userSettings })
    void this.refreshImprovements()
    return true
  }

  /** Sends the key once; only `{ configured, source }` comes back. */
  async setApiKey(value: string): Promise<boolean> {
    const info = await this.guard(c => c.call('settings.setApiKey', { value }))
    if (info === undefined) return false
    this.set(state => (state.settings === undefined ? {} : { settings: { ...state.settings, apiKey: info } }))
    return true
  }

  // --- events ---------------------------------------------------------------

  onEvent(event: SdkEvent): void {
    try {
      this.applySdkEvent(event)
    } catch (error) {
      // A malformed event must not take the window down; show it and keep going.
      this.notify(error)
    }
  }

  private applySdkEvent(event: SdkEvent): void {
    // API 7: the improver is application-level; its events carry no projectId.
    if (event.type === 'improver.version') {
      this.set(state => (state.improver === undefined ? {} : { improver: { ...state.improver, current: event.current } }))
      void this.refreshImprover()
      return
    }
    if (event.projectId !== this.projectId) return
    // Step 4: project-level capability events (no session).
    if (event.type === 'capability.version' || event.type === 'capability.candidate' || event.type === 'capability.trial') {
      if (event.type === 'capability.version') this.set(state => (state.capabilities === undefined ? {} : { capabilities: { ...state.capabilities, current: event.current } }))
      void this.refreshCapabilities()
      return
    }
    // Step 5: improvement jobs are project-level too.
    if (event.type === 'improvement.job') {
      void this.refreshImprovements()
      return
    }
    const current = event.sessionId === this.state.sessionId
    // A member of the open conversation: its approvals are asked here, its stream feeds an open member view.
    const ofCurrent = event.parentSessionId !== undefined && event.parentSessionId === this.state.sessionId
    if (event.parentSessionId !== undefined) {
      if (this.state.memberView?.sessionId === event.sessionId) {
        this.set(state => (state.memberView === undefined ? {} : { memberView: { ...state.memberView, timeline: applyEvent(state.memberView.timeline, event) } }))
      }
      if (!ofCurrent) return
      switch (event.type) {
        case 'approval.request':
          this.set(state => ({
            pendingApprovals: state.pendingApprovals.some(r => r.id === event.request.id) ? state.pendingApprovals : [...state.pendingApprovals, event.request],
            timeline: applyEvent(state.timeline, event),
          }))
          break
        case 'approval.decision':
          this.set(state => ({ pendingApprovals: state.pendingApprovals.filter(r => r.id !== event.decision.id), timeline: applyEvent(state.timeline, event) }))
          break
        case 'turn.end':
          this.set(state => ({ pendingApprovals: state.pendingApprovals.filter(r => r.sessionId !== event.sessionId) }))
          break
        case 'deliverable.presented':
          void this.refreshDeliverables()
          break
        default:
          break
      }
      return
    }
    switch (event.type) {
      case 'turn.start':
        this.set(state => ({
          sessions: state.sessions.map(s => (s.sessionId === event.sessionId ? { ...s, running: true, interrupted: false, lastTurn: event.turn } : s)),
          ...(current ? { running: true } : {}),
        }))
        break
      case 'turn.end':
        this.set(state => ({
          sessions: state.sessions.map(s => (s.sessionId === event.sessionId ? { ...s, running: false } : s)),
          ...(current ? { running: false, stopping: false, pendingApprovals: [] } : {}),
        }))
        void this.refreshSessions()
        void this.refreshDeliverables()
        // A proposal, the gate or a load-failure rollback may have changed the project's capabilities.
        void this.refreshCapabilities()
        void this.refreshImprovements()
        void this.refreshLearning()
        if (this.state.projectFiles !== undefined) void this.refreshFiles()
        // A workflow's end has no event of its own.
        if (current && this.state.timeline.some(entry => entry.kind === 'workflow')) void this.refreshWorkflows(event.sessionId, event.turn)
        break
      case 'approval.request':
        if (current) this.set(state => ({ pendingApprovals: state.pendingApprovals.some(r => r.id === event.request.id) ? state.pendingApprovals : [...state.pendingApprovals, event.request] }))
        break
      case 'approval.decision':
        if (current) this.set(state => ({ pendingApprovals: state.pendingApprovals.filter(r => r.id !== event.decision.id) }))
        break
      case 'deliverable.presented':
      case 'member.end':
        void this.refreshDeliverables()
        break
      case 'member.start':
      case 'workflow.phase': {
        // A member's first turn is a new member session of this conversation.
        if (event.type === 'member.start' && event.run.childTurn === 1) {
          this.set(state => ({ sessions: state.sessions.map(s => (s.sessionId === event.sessionId ? { ...s, childCount: (s.childCount ?? 0) + 1 } : s)) }))
        }
        const workflowId = event.type === 'workflow.phase' ? event.workflowId : event.run.workflowId
        if (current && workflowId !== undefined && !this.state.timeline.some(entry => entry.key === workflowKey(workflowId))) void this.refreshWorkflows(event.sessionId, event.turn)
        break
      }
      case 'material.added':
        this.set(state => ({ materials: state.materials.some(m => m.id === event.material.id) ? state.materials : [...state.materials, event.material] }))
        break
      case 'session.title':
        this.set(state => ({ sessions: state.sessions.map(s => (s.sessionId === event.sessionId ? { ...s, title: event.title } : s)) }))
        break
      case 'goal':
        this.set(state => ({
          sessions: state.sessions.map(s => (s.sessionId === event.sessionId ? { ...s, goal: event.goal } : s)),
          ...(current ? { goal: event.goal } : {}),
        }))
        break
      default:
        break
    }
    if (current) this.set(state => ({ timeline: applyEvent(state.timeline, event) }))
  }
}

/** `sessions.open` / `sessions.rename` answer without the member count `sessions.list` gave; keep it. */
function keepChildCount(summary: SessionSummary, previous: SessionSummary): SessionSummary {
  return summary.childCount === undefined && previous.childCount !== undefined ? { ...summary, childCount: previous.childCount } : summary
}
