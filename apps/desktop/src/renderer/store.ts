/**
 * Renderer state: one observable store that owns the SDK client, keeps what
 * the three columns show, and turns user intents into SDK calls. React reads
 * it with `useSyncExternalStore` (see `useStore`); tests drive it directly.
 *
 * Failures never throw out of an action: they become a notice (banner) so a
 * broken backend shows an error instead of a blank window.
 */
import type { ApprovalRequest, DeliverableSummary, ErrorInfo, FeedbackRating, Goal, GoalStatus, LLMUsage, MaterialMetadata, SandboxMode } from '@nexgent/kernel'
import type { CandidateDetail, CapabilityListing, ProjectFileListing, ProjectInfo, ProjectSettings, SdkEvent, SessionSummary, SettingsPatch } from '@nexgent/sdk'
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

  dismissNotice(id: number): void {
    this.set(state => ({ notices: state.notices.filter(notice => notice.id !== id) }))
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
      this.set({ backend: 'ready', appVersion: info.appVersion, platform: info.platform, recent })
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
  }

  // --- projects -------------------------------------------------------------

  async refreshRecent(): Promise<void> {
    await this.guard(async c => this.set({ recent: await c.call('projects.recent', {}) }))
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
    })
    await Promise.all([this.refreshSessions(), this.refreshMaterials(), this.refreshDeliverables(), this.refreshSettings(), this.refreshRecent(), this.refreshCapabilities()])
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
      this.set({ recent: await c.call('projects.recent', {}) })
    })
  }

  /** Back to the start screen; the project stays open in the backend (running turns go on). */
  leaveProject(): void {
    this.set({ project: undefined, sessionId: undefined, sessionMeta: undefined, timeline: [], running: false, pendingApprovals: [], memberView: undefined, capabilities: undefined, candidateDetail: undefined, pluginApproval: undefined })
    void this.refreshRecent()
  }

  // --- project data ---------------------------------------------------------

  private get projectId(): string | undefined {
    return this.state.project?.projectId
  }

  async refreshSessions(): Promise<void> {
    const projectId = this.projectId
    if (projectId === undefined) return
    await this.guard(async c => {
      const sessions = [...(await c.call('sessions.list', { projectId }))].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      if (this.projectId === projectId) this.set({ sessions })
    })
  }

  async refreshMaterials(): Promise<void> {
    const projectId = this.projectId
    if (projectId === undefined) return
    await this.guard(async c => {
      const materials = await c.call('materials.list', { projectId })
      if (this.projectId === projectId) this.set({ materials })
    })
  }

  async refreshDeliverables(): Promise<void> {
    const projectId = this.projectId
    if (projectId === undefined) return
    await this.guard(async c => {
      const deliverables = await c.call('deliverables.list', { projectId })
      if (this.projectId === projectId) this.set({ deliverables })
    })
  }

  async refreshFiles(): Promise<void> {
    const projectId = this.projectId
    if (projectId === undefined) return
    await this.guard(async c => {
      const projectFiles = await c.call('files.list', { projectId })
      if (this.projectId === projectId) this.set({ projectFiles })
    })
  }

  // --- capability versions (step 4) ------------------------------------------

  async refreshCapabilities(): Promise<void> {
    const projectId = this.projectId
    if (projectId === undefined) return
    await this.guard(async c => {
      const capabilities = await c.call('capabilities.list', { projectId })
      if (this.projectId !== projectId) return
      this.set({ capabilities })
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

  /** Candidates whose approval dialog was already shown (closing it without answering does not reopen it). */
  private readonly askedApproval = new Set<string>()

  /** Open (or close, when it is open) a candidate's details. */
  async toggleCandidate(candidateId: string): Promise<void> {
    if (this.state.candidateDetail?.view.id === candidateId) {
      this.set({ candidateDetail: undefined })
      return
    }
    await this.showCandidate(candidateId)
  }

  private async showCandidate(candidateId: string): Promise<void> {
    const projectId = this.projectId
    if (projectId === undefined) return
    const candidateDetail = await this.guard(c => c.call('capabilities.show', { projectId, candidateId }))
    if (candidateDetail !== undefined && this.projectId === projectId) this.set({ candidateDetail })
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
    await this.guard(async c => {
      const settings = await c.call('settings.get', { projectId })
      if (this.projectId === projectId) this.set({ settings })
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
    await Promise.all([this.openSession(summary.sessionId), this.refreshCapabilities()])
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
    this.set({ settings })
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
    if (event.projectId !== this.projectId) return
    // Step 4: project-level capability events (no session).
    if (event.type === 'capability.version' || event.type === 'capability.candidate' || event.type === 'capability.trial') {
      if (event.type === 'capability.version') this.set(state => (state.capabilities === undefined ? {} : { capabilities: { ...state.capabilities, current: event.current } }))
      void this.refreshCapabilities()
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
