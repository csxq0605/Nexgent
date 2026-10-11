/**
 * An in-memory stand-in for `window.nexgent`, for component tests: canned
 * answers for every method the UI calls, a log of calls, overridable
 * handlers, and `emit` to push `SdkEvent`s as the main process would.
 * Never bundled into the app (only tests import it).
 */
import type { ApprovalRequest, DeliverableDiff, DeliverableSummary, DeliverableVersion, MaterialMetadata } from '@nexgent/kernel'
import type { MemberRunView, ProjectFileEntry, ProjectInfo, ProjectSettings, SdkEvent, SessionSummary, SessionView, WorkflowView } from '@nexgent/sdk'
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
  apiKey: { configured: false },
}

export function approvalRequest(options: ApprovalRequest['options'], id = 'ap1'): ApprovalRequest {
  return { id, sessionId: 's1', callId: 'c9', tool: 'write_file', summary: 'write .env', detail: 'cwd: /work/sales', risk: 'medium', options, ...(options.length > 1 ? { pattern: '.env' } : {}) }
}

/** A member run as the SDK reports it (step 3). */
export function memberRun(overrides: Partial<MemberRunView> = {}): MemberRunView {
  return { childSessionId: 'c1', childTurn: 1, name: 'analyst', executionForm: 'delegated', status: 'running', deliverables: [], ...overrides }
}

export class FakeBridge implements NexgentBridge {
  readonly platform = 'linux'
  readonly calls: FakeCall[] = []
  private readonly listeners = new Set<(event: SdkEvent) => void>()
  private seq = 0
  deliverables: DeliverableSummary[] = []
  materials: MaterialMetadata[] = []
  view: SessionView = { summary: SESSION, sandboxMode: 'workspace-write', model: 'claude-sonnet-5-5', items: [], totalUsage: ZERO_USAGE }
  recent: ProjectInfo[] = [PROJECT]
  sessions: SessionSummary[] = [SESSION]
  settings: ProjectSettings = SETTINGS
  files: ProjectFileEntry[] = [{ path: 'orders.csv', size: 2048, modifiedAt: '2026-10-11T08:00:00.000Z' }]
  filesTruncated = false
  turn = 0
  /** Step 3: `sessions.view` answers per member session. */
  memberViews: Record<string, SessionView> = {}
  /** Step 3: workflows `sessions.collaboration` reports. */
  workflows: WorkflowView[] = []
  readonly handlers: Record<string, Handler> = {
    'app.info': () => ({ sdkVersion: 3, appVersion: '0.0.0-test', platform: 'linux' }),
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
      this.settings = { ...this.settings, ...input.patch }
      return this.settings
    },
    'settings.setApiKey': input => (input.value === '' ? { configured: false } : { configured: true, source: 'file' }),
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
