/**
 * An in-memory stand-in for `window.nexgent`, for component tests: canned
 * answers for every method the UI calls, a log of calls, overridable
 * handlers, and `emit` to push `SdkEvent`s as the main process would.
 * Never bundled into the app (only tests import it).
 */
import type { ApprovalRequest, DeliverableDiff, DeliverableSummary, DeliverableVersion, HandbookOp, MaterialMetadata, PluginApprovalInfo } from '@nexgent/kernel'
import type { CandidateDetail, CandidateView, CapabilityListing, HandbookEntryView, LearningStatus, MemberRunView, ProjectFileEntry, ProjectInfo, ProjectSettings, RetryState, RetryView, RewindView, SdkEvent, SessionSummary, SessionView, UserSettings, WorkflowView } from '@nexgent/sdk'
import type { NexgentBridge } from '../bridge.js'

type Handler = (input: any) => unknown

export interface FakeCall {
  readonly method: string
  readonly input: any
}

export const PROJECT: ProjectInfo = { projectId: 'p1', root: '/work/sales', name: 'sales', lastOpenedAt: '2026-10-11T08:00:00.000Z', exists: true }
export const SESSION: SessionSummary = { sessionId: 's1', title: '销售汇总', createdAt: '2026-10-11T08:00:00.000Z', updatedAt: '2026-10-11T08:05:00.000Z', lastTurn: 0, running: false, interrupted: false }
export const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } as const

export const MATERIAL: MaterialMetadata = {
  formatVersion: 1,
  id: 'm1',
  originalName: 'orders.csv',
  path: '.nexgent/materials/m1/orders.csv',
  size: 2048,
  sha256: 'a'.repeat(64),
  mediaType: 'text/csv',
  text: true,
  addedAt: '2026-10-11T08:01:00.000Z',
  status: 'active',
}

export function version(n: number, deliverableId = 'd1'): DeliverableVersion {
  return {
    formatVersion: 1,
    deliverableId,
    version: n,
    title: 'summary.csv',
    summary: `第 ${n} 版汇总`,
    files: [{ path: 'report/summary.csv', size: 40, sha256: 'b'.repeat(64), mediaType: 'text/csv' }],
    presentedAt: '2026-10-11T08:10:00.000Z',
    sessionId: 's1',
    turn: n,
    toolCallId: `call-${n}`,
  }
}

export const DIFF: DeliverableDiff = {
  deliverableId: 'd1',
  from: 1,
  to: 2,
  files: [
    {
      path: 'report/summary.csv',
      change: 'modified',
      binary: false,
      hunks: [{ fromStart: 1, fromLines: 2, toStart: 1, toLines: 2, lines: [{ op: 'context', text: 'region,total' }, { op: 'remove', text: 'north,1200' }, { op: 'add', text: '华北,1200' }] }],
    },
  ],
}

export const SETTINGS: ProjectSettings = {
  model: 'claude-sonnet-5-5',
  thinking: 'on',
  effort: 'medium',
  sandboxMode: 'workspace-write',
  costCaps: {},
  autoImprove: true,
  improvement: { feedbackThreshold: 3, budget: { maxTokens: 3_000_000, windowDays: 30 }, model: 'claude-sonnet-5-5', thinking: 'on', shareImproverEvidence: true, meta: { enabled: false, everyJobs: 3, budget: { maxTokens: 6_000_000, windowDays: 30 }, model: 'claude-sonnet-5-5' } },
  learning: { enabled: true, budget: { maxUsd: 3, windowDays: 30 }, selfEvalMaxUsd: 0.05, useShared: true, contribute: true, skills: false },
  apiKey: { configured: false },
  dataDir: '/home/me/.nexgent/projects/p1',
  checkRetries: 2,
  checkCommands: [],
}

export function approvalRequest(options: ApprovalRequest['options'], id = 'ap1'): ApprovalRequest {
  return { id, sessionId: 's1', callId: 'c9', tool: 'write_file', summary: 'write .env', detail: 'cwd: /work/sales', risk: 'medium', options, ...(options.length > 1 ? { pattern: '.env' } : {}) }
}

/** A member run as the SDK reports it (step 3). */
export function memberRun(overrides: Partial<MemberRunView> = {}): MemberRunView {
  return { childSessionId: 'c1', childTurn: 1, name: 'analyst', executionForm: 'delegated', status: 'running', deliverables: [], ...overrides }
}

export const BUNDLE = 'b'.repeat(64)

/** A candidate as `capabilities.list` shows it (step 4). */
export function candidate(overrides: Partial<CandidateView> = {}): CandidateView {
  return { id: 'c-1', status: 'proposed', proposedAt: '2026-10-12T08:00:00.000Z', sessionId: 's1', components: [{ kind: 'skill', name: 'order-summary' }], requiresApproval: false, summary: '按地区汇总订单', ...overrides }
}

/** What `capabilities.show` reads from a plugin's `plugin.json`. */
export const pluginInfo = (name: string): PluginApprovalInfo => ({ name, description: `${name} 插件`, permissions: '读取项目文件；联网查询天气', tools: [`${name}_hello`] })

/**
 * `capabilities.show` of {@link candidate}; `plugins` defaults to one entry
 * per plugin component (a candidate with none has no `plugins`).
 */
export function candidateDetail(view: CandidateView, version = BUNDLE, plugins?: readonly PluginApprovalInfo[]): CandidateDetail {
  const named = view.components.filter(c => c.kind === 'plugin')
  const info = plugins ?? (named.length === 0 ? undefined : named.map(c => pluginInfo(c.name)))
  return {
    view,
    record: {
      formatVersion: 1,
      id: view.id,
      proposedAt: view.proposedAt,
      sessionId: view.sessionId,
      taskId: 't1',
      turn: 1,
      base: 'baseline',
      version,
      components: view.components.map(c => ({ ...c, files: [{ path: c.kind === 'plugin' ? 'plugin.json' : 'SKILL.md', sha256: 'e'.repeat(64), bytes: 120 }] })),
      proofs: view.components.map(c => ({ ...c, turn: 1, toolCallId: 'call-1' })),
      requiresApproval: view.requiresApproval,
      ...(view.summary === undefined ? {} : { summary: view.summary }),
    },
    receipts: [],
    decisions: [],
    ...(info === undefined ? {} : { plugins: info }),
  }
}

export class FakeBridge implements NexgentBridge {
  readonly platform = 'linux'
  readonly calls: FakeCall[] = []
  private readonly listeners = new Set<(event: SdkEvent) => void>()
  private seq = 0
  deliverables: DeliverableSummary[] = []
  materials: MaterialMetadata[] = []
  view: SessionView = { summary: SESSION, sandboxMode: 'workspace-write', plan: false, model: 'claude-sonnet-5-5', items: [], totalUsage: ZERO_USAGE }
  recent: ProjectInfo[] = [PROJECT]
  sessions: SessionSummary[] = [SESSION]
  settings: ProjectSettings = SETTINGS
  /** API 7: what `userSettings.get` answers (`update` changes it like the SDK would). */
  userSettings: UserSettings = { learning: {} }
  files: ProjectFileEntry[] = [{ path: 'orders.csv', size: 2048, modifiedAt: '2026-10-11T08:00:00.000Z' }]
  filesTruncated = false
  turn = 0
  /** Step 3: `sessions.view` answers per member session. */
  memberViews: Record<string, SessionView> = {}
  /** Step 3: workflows `sessions.collaboration` reports. */
  workflows: WorkflowView[] = []
  /** Step 4: what `capabilities.list` answers (`approve` / `rollback` / `trial` change it like the SDK would). */
  /** `capabilities.show`'s `plugins` per candidate id, when a test needs other than the default. */
  pluginInfo: Record<string, readonly PluginApprovalInfo[]> = {}
  /** `capabilities.show`'s gate evidence (`receipts`, `decisions`) per candidate id. */
  evidence: Record<string, Pick<CandidateDetail, 'receipts' | 'decisions'>> = {}
  capabilities: CapabilityListing = { current: { version: 'baseline', revision: 0, components: [] }, history: [], candidates: [] }
  /** Rework D2: what `handbook.list` answers (`setStatus` changes it like the SDK would), and each entry's operations for `handbook.show`. */
  handbook: HandbookEntryView[] = []
  handbookOps: Record<string, HandbookOp[]> = {}
  /** Redesign 3.1: what `sessions.rewind` previews; `undefined` answers `session/not-found` (no snapshot). Applying emits `turn.rewind`. */
  rewind: Omit<RewindView, 'applied'> | undefined = { turn: 1, takenAt: '2026-10-16T10:00:00.000Z', changes: [], unchanged: [] }
  /** "换个做法再试": what `retries.get` answers; `start` / `choose` / `undo` change it like the SDK would and emit `retry.update`. */
  retry: RetryState = {}
  /** Rework D2: `learning.status`; config and notice follow the settings like the SDK's. */
  learningSpend: Pick<LearningStatus['budget'], 'spentUsd' | 'estimated' | 'phases'> = { spentUsd: 0, estimated: false, phases: [] }
  selfEvaluations = 0
  reliability: LearningStatus['reliability'] = { sampled: 0, agreed: 0, status: 'insufficient' }
  readonly handlers: Record<string, Handler> = {
    'app.info': () => ({ sdkVersion: 8, appVersion: '0.0.0-test', platform: 'linux', commandShell: { shell: 'bash', required: false, available: true } }),
    'projects.recent': () => this.recent,
    'projects.open': () => PROJECT,
    'projects.forget': () => undefined,
    'sessions.list': () => this.sessions,
    'sessions.create': () => ({ ...SESSION, sessionId: 's2', title: undefined }),
    'sessions.rename': input => {
      const summary = { ...(this.sessions.find(s => s.sessionId === input.sessionId) ?? SESSION), title: input.title }
      this.sessions = this.sessions.map(s => (s.sessionId === input.sessionId ? summary : s))
      return summary
    },
    'files.list': () => ({ files: this.files, truncated: this.filesTruncated }),
    'sessions.view': input => this.memberViews[input.sessionId] ?? { ...this.view, summary: this.sessions.find(s => s.sessionId === input.sessionId) ?? this.view.summary },
    'sessions.collaboration': input => ({ sessionId: input.sessionId, runs: [], workflows: this.workflows }),
    'sessions.rewind': input => {
      if (this.rewind === undefined) throw { name: 'NexgentError', code: 'session/not-found', message: 'no snapshot' }
      const applied = input.apply === true && this.rewind.changes.length > 0
      if (applied) {
        const of = (action: string) => this.rewind!.changes.filter(change => change.action === action).map(change => change.path)
        queueMicrotask(() => this.emit({ type: 'turn.rewind', rewind: { toTurn: input.turn, restored: of('restore'), deleted: of('delete') } }))
      }
      return { ...this.rewind, turn: input.turn, applied }
    },
    'sessions.setMode': input => {
      this.view = { ...this.view, ...(input.plan === undefined ? {} : { plan: input.plan }), ...(input.sandboxMode === undefined ? {} : { sandboxMode: input.sandboxMode }) }
      return this.view
    },
    'sessions.open': input => ({ ...this.view, summary: this.sessions.find(s => s.sessionId === input.sessionId) ?? this.view.summary }),
    'turns.send': input => {
      this.turn += 1
      return { sessionId: input.sessionId, turn: this.turn }
    },
    'turns.cancel': () => undefined,
    'approvals.respond': () => true,
    'materials.list': () => this.materials,
    'materials.add': input => {
      const material = { ...MATERIAL, id: `m${this.materials.length + 1}`, originalName: String(input.sourcePath).split('/').pop() ?? '' }
      this.materials = [...this.materials, material]
      return material
    },
    'materials.remove': input => ({ ...MATERIAL, id: input.materialId, status: 'removed' }),
    'deliverables.list': () => this.deliverables,
    'deliverables.get': input => version(input.version, input.deliverableId),
    'deliverables.diff': () => DIFF,
    'deliverables.readText': input => (input.version === 1 ? 'region,total\nnorth,1200\n' : 'region,total\n华北,1200\n'),
    'deliverables.reveal': () => undefined,
    'projects.revealData': () => undefined,
    'feedback.submit': input => {
      this.turn += 1
      return { sessionId: input.sessionId, turn: this.turn }
    },
    'goals.set': input => ({ id: 'g1', text: input.text, status: 'active', setAt: 'x', updatedAt: 'x' }),
    'goals.update': input => ({ id: 'g1', text: 'goal', status: input.status, setAt: 'x', updatedAt: 'x' }),
    'settings.get': () => this.settings,
    'settings.update': input => {
      const { improvement, learning, ...rest } = input.patch
      // Like the SDK: the retired autoImprove follows learning.enabled.
      if (learning?.enabled !== undefined && rest.autoImprove === undefined) rest.autoImprove = learning.enabled
      this.settings = { ...this.settings, ...rest, ...(learning === undefined ? {} : { learning: { ...this.settings.learning, ...learning, budget: { ...this.settings.learning.budget, ...learning.budget } } }), ...(improvement === undefined ? {} : { improvement: { ...this.settings.improvement, ...improvement, budget: { ...this.settings.improvement.budget, ...improvement.budget }, meta: { ...this.settings.improvement.meta, ...improvement.meta, budget: { ...this.settings.improvement.meta.budget, ...improvement.meta?.budget } } } }) }
      return this.settings
    },
    'userSettings.get': () => this.userSettings,
    'userSettings.update': input => {
      if (input.patch.language === null) {
        const { language: _old, ...rest } = this.userSettings
        this.userSettings = rest
      } else if (input.patch.language !== undefined) this.userSettings = { ...this.userSettings, language: input.patch.language }
      return this.userSettings
    },
    'capabilities.list': () => this.capabilities,
    'capabilities.current': () => this.capabilities.current,
    'capabilities.show': input => {
      const view = this.capabilities.candidates.find(c => c.id === input.candidateId)
      if (view === undefined) throw { name: 'NexgentError', code: 'tool/invalid-input', message: `no candidate ${input.candidateId}` }
      return { ...candidateDetail(view, BUNDLE, this.pluginInfo[view.id]), ...this.evidence[view.id] }
    },
    'capabilities.trial': input => this.setCandidate(input.candidateId, { status: 'trialing', trialId: 'trial-1' }),
    'capabilities.approve': input => {
      if (input.decision === 'deny') return this.setCandidate(input.candidateId, { status: 'rejected', decision: { id: 'dec-2', outcome: 'rejected', reason: 'approval-denied', detail: '用户拒绝了插件包。' } })
      const adopted = this.setCandidate(input.candidateId, { status: 'adopted', decision: { id: 'dec-2', outcome: 'adopted', reason: 'approved', detail: '用户批准。' } })
      const revision = this.capabilities.current.revision + 1
      this.capabilities = {
        ...this.capabilities,
        current: { version: BUNDLE, revision, since: '2026-10-12T09:00:00.000Z', trigger: 'approval', components: adopted.components },
        history: [...this.capabilities.history, { format: 1, revision, previous: null, from: this.capabilities.current.version, version: BUNDLE, type: 'adopt', trigger: 'approval', decisionId: 'dec-2', committedAt: '2026-10-12T09:00:00.000Z' }],
      }
      return adopted
    },
    'capabilities.rollback': () => {
      const { current, history } = this.capabilities
      const revision = current.revision + 1
      this.capabilities = {
        ...this.capabilities,
        current: { version: 'baseline', revision, since: '2026-10-12T10:00:00.000Z', trigger: 'manual', components: [] },
        history: [...history, { format: 1, revision, previous: null, from: current.version, version: 'baseline', type: 'rollback', trigger: 'manual', decisionId: 'dec-3', committedAt: '2026-10-12T10:00:00.000Z' }],
        candidates: this.capabilities.candidates.map(c => (c.status === 'adopted' ? { ...c, status: 'rolled-back' } : c)),
      }
      return this.capabilities.current
    },
    'handbook.list': input => ({ entries: this.handbook.filter(entry => input.includeRetired === true || entry.status !== 'retired'), sharedIncluded: this.settings.learning.useShared }),
    'handbook.show': input => {
      const entry = this.handbook.find(e => e.id === input.entryId)
      if (entry === undefined) throw { name: 'NexgentError', code: 'handbook/not-found', message: `no entry ${input.entryId}` }
      return { entry, ops: this.handbookOps[entry.id] ?? [] }
    },
    'handbook.setStatus': input => {
      const entry = this.handbook.find(e => e.id === input.entryId)
      if (entry === undefined) throw { name: 'NexgentError', code: 'handbook/not-found', message: `no entry ${input.entryId}` }
      const { pending: _pending, ...settled } = entry
      const updated: HandbookEntryView = { ...settled, status: input.status, retrievable: input.status === 'active', updatedAt: '2026-10-16T13:00:00.000Z' }
      this.handbook = this.handbook.map(e => (e.id === entry.id ? updated : e))
      const ops = this.handbookOps[entry.id] ?? []
      this.handbookOps[entry.id] = [...ops, { formatVersion: 1, seq: ops.length + 1, at: '2026-10-16T13:00:00.000Z', entryId: entry.id, actor: 'user', op: 'status', status: input.status }]
      return { entry: updated, ops: this.handbookOps[entry.id] }
    },
    'learning.status': () => {
      const config = this.settings.learning
      const noticeAcknowledged = this.userSettings.learning.noticeAcknowledgedAt !== undefined
      return {
        config,
        noticeAcknowledged,
        active: config.enabled && noticeAcknowledged,
        rules: 'adr-0019',
        budget: { ...config.budget, ...this.learningSpend, remainingUsd: Math.max(0, config.budget.maxUsd - this.learningSpend.spentUsd), windowStart: '2026-09-16T00:00:00.000Z' },
        selfEvaluations: this.selfEvaluations,
        reliability: this.reliability,
      } satisfies LearningStatus
    },
    'learning.acknowledge': () => {
      this.userSettings = { ...this.userSettings, learning: { noticeAcknowledgedAt: this.userSettings.learning.noticeAcknowledgedAt ?? '2026-10-16T12:00:00.000Z' } }
      return this.userSettings
    },
    'retries.get': () => this.retry,
    'retries.start': input => this.setRetry({
      retryId: 'r1',
      sessionId: input.sessionId,
      turn: this.retry.offer?.turn ?? 1,
      status: 'running',
      startedAt: '2026-10-19T12:00:00.000Z',
      original: { side: { decision: 'team', organization: 'lead-checker' }, usd: this.retry.offer?.estimateUsd ?? 0, files: [] },
      retry: { side: this.retry.offer?.side ?? { decision: 'solo' } },
    }),
    'retries.stop': () => this.setRetry({ ...this.retry.latest!, status: 'stopped' }),
    'retries.choose': input => this.setRetry({ ...this.retry.latest!, status: input.keep === 'retry' ? 'applied' : 'kept-original', ...(input.keep === 'retry' ? { undoable: true } : {}) }),
    'retries.undo': () => this.setRetry({ ...this.retry.latest!, status: 'undone', undoable: false }),
    'settings.setApiKey': input => (input.value === '' ? { configured: false } : { configured: true, source: 'file' }),
  }

  private setRetry(latest: RetryView): RetryView {
    this.retry = { ...(latest.status === 'running' || latest.status === 'ready' ? {} : this.retry.offer === undefined ? {} : { offer: this.retry.offer }), latest }
    queueMicrotask(() => this.emit({ type: 'retry.update', retry: latest }))
    return latest
  }

  private setCandidate(id: string, patch: Partial<CandidateView>): CandidateView {
    const updated = { ...this.capabilities.candidates.find(c => c.id === id)!, ...patch }
    this.capabilities = { ...this.capabilities, candidates: this.capabilities.candidates.map(c => (c.id === id ? updated : c)) }
    return updated
  }

  invoke = async (method: string, input: unknown): Promise<unknown> => {
    this.calls.push({ method, input })
    const handler = this.handlers[method]
    if (handler === undefined) throw { name: 'NexgentError', code: 'internal', message: `fake: no handler for ${method}` }
    return handler(input)
  }

  onEvent = (listener: (event: SdkEvent) => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Push an event (projectId / sessionId / eventSeq filled in). */
  emit(event: Record<string, unknown> & { type: SdkEvent['type'] }): void {
    this.seq += 1
    const full = { projectId: 'p1', sessionId: 's1', eventSeq: this.seq, ...event } as unknown as SdkEvent
    for (const listener of this.listeners) listener(full)
  }

  callsOf(method: string): any[] {
    return this.calls.filter(call => call.method === method).map(call => call.input)
  }
}
