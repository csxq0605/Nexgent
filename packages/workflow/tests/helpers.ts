import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ZERO_USAGE, type DeliverableVersionRef, type MemberResult, type SessionRecord, type ToolContext, type ToolRecordInput } from '@nexgent/kernel'
import { createWorkspaceServices } from '@nexgent/workspace'
import { afterEach } from 'vitest'
import type { WorkflowMemberRequest, WorkflowMemberRunner } from '../src/index.js'

const dirs: string[] = []

/** A fresh temporary directory, removed after the test. */
export async function tempDir(prefix = 'nexgent-workflow-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true, maxRetries: 5 })))
})

/** What a fake member does when run. */
export interface FakeBehavior {
  readonly text?: string
  readonly delayMs?: number
  readonly status?: MemberResult['status']
  readonly files?: readonly string[]
  /** Never settle until cancelled. */
  readonly hang?: boolean
  /** `start` rejects with this message. */
  readonly startError?: string
}

/** A member runner that records what it was asked, writes the records `runMember` writes, and replays per-name behaviors. */
export class FakeRunner {
  readonly requests: WorkflowMemberRequest[] = []
  readonly cancelled: string[] = []
  active = 0
  peak = 0
  /** When each member's work started and ended (ms since epoch), in start order. */
  readonly spans: { start: number, end: number }[] = []
  private next = 1

  constructor(private readonly behaviors: (request: WorkflowMemberRequest) => FakeBehavior = () => ({})) {}

  readonly run: WorkflowMemberRunner = async request => {
    this.requests.push(request)
    const behavior = this.behaviors(request)
    if (behavior.startError !== undefined) throw new Error(behavior.startError)
    const childSessionId = `child-${this.next++}-${request.name}`
    await request.record({
      type: 'subagent.start', turn: request.turn, toolCallId: request.toolCallId, childSessionId, childTurn: 1, name: request.name,
      executionForm: 'workflow', ...(request.preset === undefined ? {} : { preset: request.preset }), workflowId: request.workflowId, task: request.task.slice(0, 500),
    })
    const result = await this.result(request, behavior)
    await request.record({ type: 'subagent.end', turn: request.turn, childSessionId, childTurn: 1, result })
    return { childSessionId, childTurn: 1, name: request.name, result }
  }

  private async result(request: WorkflowMemberRequest, behavior: FakeBehavior): Promise<MemberResult> {
    this.active += 1
    this.peak = Math.max(this.peak, this.active)
    const span = { start: Date.now(), end: Number.NaN }
    this.spans.push(span)
    try {
      const outcome = await new Promise<'done' | 'cancelled'>(resolve => {
        if (request.signal.aborted) return resolve('cancelled')
        const timer = behavior.hang === true ? undefined : setTimeout(() => resolve('done'), behavior.delayMs ?? 20)
        request.signal.addEventListener('abort', () => {
          if (timer !== undefined) clearTimeout(timer)
          resolve('cancelled')
        }, { once: true })
      })
      if (outcome === 'cancelled') {
        this.cancelled.push(request.name)
        return { status: 'cancelled', text: '', deliverables: [], usage: ZERO_USAGE, requestCount: 1, error: { name: 'NexgentError', code: 'tool/aborted', message: 'the member was cancelled (parent)' } }
      }
      const status = behavior.status ?? 'completed'
      const deliverables: DeliverableVersionRef[] = behavior.files === undefined ? [] : [{
        deliverableId: `d-${request.name}`,
        version: 1,
        title: request.name,
        summary: 'presented',
        files: behavior.files.map(path => ({ path, size: 1, sha256: '0'.repeat(64), mediaType: 'text/plain' })),
        memberName: request.name,
      }]
      return {
        status,
        text: behavior.text ?? `${request.name} done`,
        deliverables,
        usage: { ...ZERO_USAGE, inputTokens: 10, outputTokens: 5 },
        requestCount: 1,
        ...(status === 'completed' ? {} : { error: { name: 'NexgentError', code: 'tool/failed' as const, message: `${request.name} could not finish` } }),
      }
    } finally {
      this.active -= 1
      span.end = Date.now()
    }
  }
}

/** A tool context over a temporary project whose `appendRecord` collects records (stamped with a seq). */
export async function workflowContext(options: { signal?: AbortSignal; member?: boolean } = {}) {
  const root = await tempDir()
  const services = await createWorkspaceServices({ root, sandboxMode: 'workspace-write' })
  const records: SessionRecord[] = []
  let seq = 1
  const context: ToolContext = {
    sessionId: 'parent-session',
    callId: 'call-1',
    turn: 3,
    workspace: services.workspace,
    sandboxMode: 'workspace-write',
    signal: options.signal ?? new AbortController().signal,
    approved: false,
    requestApproval: async () => false,
    appendRecord: async (record: ToolRecordInput) => {
      records.push({ ...record, seq: ++seq, ts: new Date().toISOString() } as SessionRecord)
    },
    ...(options.member === true ? { member: { name: 'm', executionForm: 'delegated' as const } } : {}),
  }
  return { root: services.workspace.root, context, records }
}

/** The records of one type. */
export function ofType<T extends SessionRecord['type']>(records: readonly SessionRecord[], type: T): Extract<SessionRecord, { type: T }>[] {
  return records.filter((record): record is Extract<SessionRecord, { type: T }> => record.type === type)
}
