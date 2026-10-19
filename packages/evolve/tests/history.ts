/**
 * A project with one replayable feedback task (session, snapshot at start,
 * checks at end, and feedback in turn 2) and a scripted
 * {@link ImprovementSessionRunner} for the diagnose / propose sessions:
 * the three test-support playbooks (should improve, not a capability
 * problem, the proposal never runs) as scripts the test chooses.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ZERO_USAGE, type FeedbackEntry, type Tool, type ToolContext, type WorkspaceLayout } from '@nexgent/kernel'
import { JsonlSessionStore } from '@nexgent/session'
import { LocalTaskRecorder } from '@nexgent/tasking'
import { BASELINE_BUNDLE, writeCandidate } from '@nexgent/capabilities'
import type { ImprovementSessionRequest, ImprovementSessionRunner, ImprovementTurnResult } from '../src/index.js'
import { project } from './helpers.js'

/** The original ask of the feedback task. */
export const ASK = 'summarize the june orders by region into out/summary.csv'

/** A past root task whose turn 2 is the user's feedback. */
export interface FeedbackTaskFixture {
  readonly layout: WorkspaceLayout
  readonly taskId: string
  readonly sessionId: string
  readonly feedback: FeedbackEntry
  /** Seq of the assistant reply in turn 1 (evidence the diagnosis can cite). */
  readonly replySeq: number
}

export async function feedbackTask(autoImprove = true, improvement?: Record<string, unknown>, capabilityVersion = 'baseline', comment = 'the region column is missing again'): Promise<FeedbackTaskFixture> {
  const layout = await project(autoImprove, improvement)
  await writeFile(join(layout.root, 'orders.csv'), 'region,amount\nnorth,1\nsouth,2\n')
  const sessionId = randomUUID()
  const taskId = randomUUID()
  const store = new JsonlSessionStore({ sessionsDir: layout.sessions })
  const lock = await store.create({ sessionId, projectRoot: layout.root, model: 'claude-sonnet-5-5', sandboxMode: 'workspace-write', capabilityVersion })
  await store.append(sessionId, { type: 'turn.start', turn: 1 })
  await store.append(sessionId, { type: 'user.message', turn: 1, content: ASK, source: 'user' })
  const reply = await store.append(sessionId, { type: 'assistant.message', turn: 1, step: 1, requestId: randomUUID(), content: 'Done; wrote out/summary.csv without the region column.', usage: ZERO_USAGE, finishReason: 'stop' })
  await store.append(sessionId, { type: 'turn.end', turn: 1, reason: { kind: 'completed' } })
  const feedback: FeedbackEntry = { id: randomUUID(), deliverableId: randomUUID(), version: 1, rating: 2, comment }
  await store.append(sessionId, { type: 'turn.start', turn: 2 })
  await store.append(sessionId, { type: 'feedback', turn: 2, feedback })
  await store.append(sessionId, { type: 'user.message', turn: 2, content: feedback.comment, source: 'feedback' })
  await store.append(sessionId, { type: 'turn.end', turn: 2, reason: { kind: 'completed' } })
  await store.release(lock)
  await new LocalTaskRecorder(layout).begin({ taskId, sessionId, capabilityVersion })
  const specs = [{ id: 'file-1', name: 'file-exists', path: 'out/summary.csv' }]
  await mkdir(join(layout.dataDir, 'snapshots', 'checks'), { recursive: true })
  await writeFile(join(layout.dataDir, 'snapshots', 'checks', `${taskId}.json`), JSON.stringify({
    formatVersion: 1,
    taskId,
    sessionId,
    checkedAt: new Date().toISOString(),
    specs,
    results: specs.map(spec => ({ name: spec.name, passed: true, target: spec.id })),
  }))
  return { layout, taskId, sessionId, feedback, replySeq: (reply as { seq: number }).seq }
}

const MODULE = JSON.stringify({
  formatVersion: 1,
  name: 'region-summary',
  description: 'Order summaries that keep the region column.',
  functions: [{ name: 'summarize', description: 'Summarize orders by region.', inputSchema: { type: 'object' }, effects: ['read'] }],
})

/** Write a one-component candidate as the propose session would (in `capabilitiesDir`). */
export async function proposeIn(capabilitiesDir: string, sessionId: string, taskId: string, extra: { origin?: 'improvement'; jobId?: string } = {}) {
  const files = new Map<string, Uint8Array>([['functions.json', Buffer.from(MODULE)], ['index.mjs', Buffer.from('export function summarize() { return 1 }\n')]])
  return (await writeCandidate(capabilitiesDir, {
    sessionId,
    taskId,
    turn: 1,
    base: BASELINE_BUNDLE,
    components: [{ kind: 'function-module', name: 'region-summary', files }],
    proofs: [{ kind: 'function-module', name: 'region-summary', turn: 1, toolCallId: 'call-1' }],
    summary: 'keeps the region column',
    ...extra,
  })).record
}

/** A diagnosis report citing the turn-1 reply. */
export function report(fixture: FeedbackTaskFixture, proposalKind: string = 'function-module', overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    failureTypes: proposalKind === 'none' ? [] : [{ category: 'task-verification', label: 'never checked that the region column is present', evidence: [{ sessionId: fixture.sessionId, seq: fixture.replySeq, turn: 1 }] }],
    involved: { members: ['main'], tools: ['write_file'], skills: [], components: [] },
    hypothesis: proposalKind === 'none' ? 'The user changed the requirement after the task.' : 'No reusable summary that keeps the region column.',
    proposalKind,
    ...overrides,
  }
}

/** What one scripted turn does. */
export type TurnScript = (request: ImprovementSessionRequest, text: string, index: number) => Promise<void> | void

/** A session runner whose turns run the scripts of each phase, recording what it was asked. */
export function scriptedRunner(scripts: { diagnose?: TurnScript; propose?: TurnScript }, tokens = 50): ImprovementSessionRunner & { readonly opened: ImprovementSessionRequest[]; readonly texts: string[] } {
  const opened: ImprovementSessionRequest[] = []
  const texts: string[] = []
  return {
    opened,
    texts,
    async open(request) {
      opened.push(request)
      let index = 0
      return {
        sessionId: request.sessionId,
        async send(text): Promise<ImprovementTurnResult> {
          texts.push(text)
          await scripts[request.phase as 'diagnose' | 'propose']?.(request, text, index++)
          return { outcome: 'completed', usage: { ...ZERO_USAGE, inputTokens: tokens, totalTokens: tokens }, requestCount: 1 }
        },
        async close() {},
      }
    },
  }
}

/** Call a session tool's handler as the model would. */
export async function callTool(request: ImprovementSessionRequest, name: string, input: unknown) {
  const tool = (request.tools ?? []).find((item: Tool) => item.definition.name === name)
  if (tool === undefined) throw new Error(`no tool ${name}`)
  return tool.handler(input, {} as ToolContext)
}
