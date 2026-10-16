/**
 * An in-memory stand-in for `window.nexgent`, for component tests: canned
 * answers for every method the UI calls, a log of calls, overridable
 * handlers, and `emit` to push `SdkEvent`s as the main process would.
 * Never bundled into the app (only tests import it).
 */
import type { ApprovalRequest, ComparisonArmResult, DeliverableDiff, DeliverableSummary, DeliverableVersion, ImproverBundle, ImproverChangeRecord, ImproverComparison, MaterialMetadata, MetaDiagnosis, PluginApprovalInfo } from '@nexgent/kernel'
import type { CandidateDetail, CandidateView, CapabilityListing, ImprovementDetail, ImprovementJobView, ImprovementListing, ImproverDetail, ImproverListing, MemberRunView, ProjectFileEntry, ProjectInfo, ProjectSettings, SdkEvent, SessionSummary, SessionView, UserSettings, WorkflowView } from '@nexgent/sdk'
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
  learning: { enabled: true, budget: { maxUsd: 3, windowDays: 30 }, selfEvalMaxUsd: 0.05, useShared: true, contribute: true },
  apiKey: { configured: false },
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

/** An improvement job as `improvements.list` shows it (step 5). */
export function improvementJob(overrides: Partial<ImprovementJobView> = {}): ImprovementJobView {
  return { id: 'j-1', trigger: 'feedback-count', status: 'diagnosing', createdAt: '2026-10-12T08:00:00.000Z', updatedAt: '2026-10-12T08:05:00.000Z', itemCount: 3, feedbackIds: [], phaseTimes: {}, tokens: {}, estimatedUsd: 0, ...overrides }
}

/** `improvements.show` of {@link improvementJob}: no diagnosis or candidate unless given. */
export function improvementDetail(view: ImprovementJobView, extra: Partial<Omit<ImprovementDetail, 'view' | 'job'>> & { readonly job?: Partial<ImprovementDetail['job']> } = {}): ImprovementDetail {
  const { job, ...rest } = extra
  return {
    view,
    job: { formatVersion: 1, id: view.id, createdAt: view.createdAt, updatedAt: view.updatedAt, trigger: view.trigger, status: view.status, items: [], history: [], phases: {}, ...job } as ImprovementDetail['job'],
    ...rest,
  }
}

/** A stand-in for the built-in improver `v0` (the kernel's value is not importable in jsdom). */
export const V0_BUNDLE: ImproverBundle = {
  formatVersion: 1,
  diagnosis: { paragraphs: ['You are the diagnosis step of Nexgent\'s improvement job.', 'Find out why, using only the read-only tools: read the sessions, the ledger and the feedback.'] },
  proposal: { kinds: ['skill', 'function-module'], briefs: { skill: '# Improvement job {{jobId}}', 'function-module': '# Improvement job {{jobId}}' } },
  comparison: { selectionCases: 2, repeats: 2, selection: 'similarity' },
}

export const CHILD_VERSION = 'c'.repeat(64)

/** A meta job as `improvements.list` shows it (step 6). */
export function metaJob(overrides: Partial<ImprovementJobView> = {}): ImprovementJobView {
  return improvementJob({ id: 'm-1', kind: 'meta', trigger: 'job-count' as never, status: 'comparing', improverVersion: 'v0', itemCount: 3, ...overrides })
}

export function metaDiagnosis(overrides: Partial<MetaDiagnosis> = {}): MetaDiagnosis {
  return {
    formatVersion: 1, jobId: 'm-1', createdAt: '2026-10-12T08:00:00.000Z', sessionId: 'i1', attempts: 1, improverVersion: 'v0', basis: ['j-1', 'j-2', 'j-3'], statusCounts: { rejected: 2, adopted: 1 },
    hypothesis: '诊断没有要求引用反馈原文',
    proposal: 'change',
    findings: [
      { stage: 'diagnose', label: '诊断笼统', jobIds: ['j-1', 'j-2'] },
      { stage: 'trial', label: '试验次数少', jobIds: ['j-3'] },
    ],
    ...overrides,
  }
}

export function changeRecord(overrides: Partial<ImproverChangeRecord> = {}): ImproverChangeRecord {
  return {
    formatVersion: 1, jobId: 'm-1', createdAt: '2026-10-12T08:10:00.000Z', sessionId: 'i2', attempts: 1, parentVersion: 'v0', childVersion: CHILD_VERSION,
    change: { op: 'set-diagnosis-paragraph', index: 1, text: '先读完反馈原文，再下结论。' },
    rationale: '让诊断更具体',
    ...overrides,
  }
}

const ORIGIN = { kind: 'unresolved' as const, sourceJobId: 'j-3', tree: 't'.repeat(64), feedbackIds: ['f1'], capabilityVersion: 'baseline', epoch: 'e1' }

export function armResult(arm: 'parent' | 'child', overrides: Partial<ComparisonArmResult> = {}): ComparisonArmResult {
  return {
    arm, improverVersion: arm === 'parent' ? 'v0' : CHILD_VERSION, origin: ORIGIN, jobId: `${arm}-job`, status: 'adopted', candidateId: `${arm === 'parent' ? 'a' : 'b'}1234567890`,
    verdict: { outcome: 'adopt', reason: 'quality-up', passRate: { candidate: arm === 'parent' ? 0.5 : 1, baseline: 0 }, costRatio: 1, decidedByReview: false },
    cost: { usage: { ...ZERO_USAGE, totalTokens: 1000 } as never, requestCount: 3, estimatedUsd: 0.2 },
    ...overrides,
  }
}

export function comparison(overrides: Partial<ImproverComparison> = {}): ImproverComparison {
  return { formatVersion: 1, jobId: 'm-1', createdAt: '2026-10-12T08:30:00.000Z', origin: ORIGIN, parent: armResult('parent'), child: armResult('child'), verdict: { outcome: 'adopt', reason: 'quality-up', quality: { parent: 0.5, child: 1 } }, ...overrides } as ImproverComparison
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
  userSettings: UserSettings = { improvement: { meta: { enabled: false, everyJobs: 3, budget: { maxTokens: 6_000_000, windowDays: 30 }, model: 'claude-sonnet-5-5' } }, learning: {} }
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
  /** Step 5: what `improvements.list` answers (`run` / `cancel` change it like the SDK would). */
  improvements: ImprovementListing = { jobs: [], pending: 0, threshold: 3, budget: { usedTokens: 0, maxTokens: 3_000_000, windowDays: 30 }, autoImprove: true }
  /** `improvements.show` per job id; a job without an entry answers a bare detail. */
  improvementDetails: Record<string, ImprovementDetail> = {}
  /** Step 6: what `improvers.list` answers (`rollback` changes it like the SDK would). */
  improver: ImproverListing = { current: { version: 'v0', revision: 0 }, history: [] }
  /** `improvers.show` per version; `v0` is built in. */
  improverBundles: Record<string, ImproverBundle> = {}
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
    'feedback.submit': input => {
      this.turn += 1
      return { sessionId: input.sessionId, turn: this.turn }
    },
    'goals.set': input => ({ id: 'g1', text: input.text, status: 'active', setAt: 'x', updatedAt: 'x' }),
    'goals.update': input => ({ id: 'g1', text: 'goal', status: input.status, setAt: 'x', updatedAt: 'x' }),
    'settings.get': () => this.settings,
    'settings.update': input => {
      const { improvement, learning, ...rest } = input.patch
      this.settings = { ...this.settings, ...rest, ...(learning === undefined ? {} : { learning: { ...this.settings.learning, ...learning, budget: { ...this.settings.learning.budget, ...learning.budget } } }), ...(improvement === undefined ? {} : { improvement: { ...this.settings.improvement, ...improvement, budget: { ...this.settings.improvement.budget, ...improvement.budget }, meta: { ...this.settings.improvement.meta, ...improvement.meta, budget: { ...this.settings.improvement.meta.budget, ...improvement.meta?.budget } } } }) }
      return this.settings
    },
    'userSettings.get': () => this.userSettings,
    'userSettings.update': input => {
      const meta = input.patch.improvement?.meta
      if (meta !== undefined) this.userSettings = { ...this.userSettings, improvement: { meta: { ...this.userSettings.improvement.meta, ...meta, budget: { ...this.userSettings.improvement.meta.budget, ...meta.budget } } } }
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
    'improvements.list': () => this.improvements,
    'improvements.show': input => {
      const view = this.improvements.jobs.find(job => job.id === input.jobId)
      if (view === undefined) throw { name: 'NexgentError', code: 'improvement/not-found', message: `no job ${input.jobId}` }
      return { ...(this.improvementDetails[view.id] ?? improvementDetail(view)), view }
    },
    'improvements.run': () => {
      if (this.improvements.activeJobId !== undefined) throw { name: 'NexgentError', code: 'improvement/busy', message: 'an improvement job is already running' }
      const job = improvementJob({ id: `j-${this.improvements.jobs.length + 1}`, trigger: 'explicit', status: 'queued', itemCount: this.improvements.pending })
      this.improvements = { ...this.improvements, jobs: [job, ...this.improvements.jobs], activeJobId: job.id, pending: 0 }
      return job
    },
    'improvements.cancel': input => {
      const current = this.improvements.jobs.find(job => job.id === input.jobId)!
      const job = { ...current, status: 'cancelled' as const }
      const { activeJobId, ...rest } = this.improvements
      this.improvements = { ...rest, jobs: this.improvements.jobs.map(j => (j.id === job.id ? job : j)), ...(activeJobId === job.id || activeJobId === undefined ? {} : { activeJobId }) }
      return job
    },
    'improvements.runMeta': () => {
      if (this.improvements.activeJobId !== undefined) throw { name: 'NexgentError', code: 'improvement/busy', message: 'an improvement job is already running' }
      const job = metaJob({ id: `m-${this.improvements.jobs.length + 1}`, trigger: 'explicit', status: 'queued' })
      this.improvements = { ...this.improvements, jobs: [job, ...this.improvements.jobs], activeJobId: job.id }
      return job
    },
    'improvers.list': () => this.improver,
    'improvers.show': input => {
      const bundle = input.version === 'v0' ? V0_BUNDLE : this.improverBundles[input.version]
      if (bundle === undefined) throw { name: 'NexgentError', code: 'improver/not-found', message: `no improver ${input.version}` }
      return { version: input.version, bundle, current: this.improver.current.version === input.version } satisfies ImproverDetail
    },
    'improvers.rollback': input => {
      const { current, history } = this.improver
      const revision = current.revision + 1
      const target = input.toVersion ?? 'v0'
      this.improver = {
        current: { version: target, revision, since: '2026-10-12T11:00:00.000Z', trigger: 'manual' },
        history: [...history, { format: 1, revision, previous: null, from: current.version, version: target, type: 'rollback', trigger: 'manual', committedAt: '2026-10-12T11:00:00.000Z', ...(input.reason === undefined ? {} : { reason: input.reason }) }],
      }
      return this.improver.current
    },
    'learning.acknowledge': () => {
      this.userSettings = { ...this.userSettings, learning: { noticeAcknowledgedAt: this.userSettings.learning.noticeAcknowledgedAt ?? '2026-10-16T12:00:00.000Z' } }
      return this.userSettings
    },
    'settings.setApiKey': input => (input.value === '' ? { configured: false } : { configured: true, source: 'file' }),
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

  /** Push an application-level event (API 7 `improver.version`): no projectId, no sessionId. */
  emitApp(event: Record<string, unknown> & { type: SdkEvent['type'] }): void {
    this.seq += 1
    const full = { eventSeq: this.seq, ...event } as unknown as SdkEvent
    for (const listener of this.listeners) listener(full)
  }

  callsOf(method: string): any[] {
    return this.calls.filter(call => call.method === method).map(call => call.input)
  }
}
