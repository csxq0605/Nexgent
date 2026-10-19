/**
 * Display history: a session's records projected onto the SDK's
 * {@link HistoryItem}s and {@link SessionSummary}. Derived from the records
 * themselves, never from the (possibly compacted) model history, so the UI
 * always shows every turn.
 */
import {
  CHECK_RETRY_NOTE_PREFIX,
  addUsage,
  type ApprovalDecision,
  type ApprovalRequest,
  type LLMUsage,
  type SessionRecord,
  type SessionState,
  type SubagentEndRecord,
  type SubagentStartRecord,
  type TeamMember,
  type TeamMessage,
  type TeamTask,
  type ToolCall,
} from '@nexgent/kernel'
import { estimateUsd } from '@nexgent/llm'
import { summarizeSession, type SessionIndexEntry } from '@nexgent/session'
import type { CheckFailureView, CheckRetryView, CollaborationView, HistoryItem, MemberRunView, SessionSummary, WorkflowView } from './api.js'

type MutableApproval = { kind: 'approval'; turn: number; request: ApprovalRequest; decision?: ApprovalDecision }

/** Key of one member run: a child session and the child turn it ran. */
export function runKey(childSessionId: string, childTurn: number): string {
  return `${childSessionId}#${childTurn}`
}

/** A member run as the parent shows it: running until its `subagent.end`. Pure. */
export function memberRunView(start: SubagentStartRecord, end?: SubagentEndRecord): MemberRunView {
  const result = end?.result
  return {
    childSessionId: start.childSessionId,
    childTurn: start.childTurn,
    name: start.name,
    executionForm: start.executionForm,
    ...(start.mode === undefined ? {} : { mode: start.mode }),
    ...(start.preset === undefined ? {} : { preset: start.preset }),
    ...(start.workflowId === undefined ? {} : { workflowId: start.workflowId }),
    status: result?.status ?? 'running',
    deliverables: result?.deliverables ?? [],
    ...(result === undefined ? {} : { usage: result.usage }),
    ...(result?.error === undefined ? {} : { error: result.error }),
  }
}

/** Mutable workflow state while folding records. */
interface WorkflowState {
  workflowId: string
  kind: 'script' | 'graph'
  title?: string
  architecture?: string
  phases: string[]
  status: WorkflowView['status']
  members: number
  error?: WorkflowView['error']
}

function workflowView(state: WorkflowState): WorkflowView {
  return {
    workflowId: state.workflowId,
    kind: state.kind,
    ...(state.title === undefined ? {} : { title: state.title }),
    ...(state.architecture === undefined ? {} : { architecture: state.architecture }),
    phases: [...state.phases],
    status: state.status,
    members: state.members,
    ...(state.error === undefined ? {} : { error: state.error }),
  }
}

/**
 * Fold the collaboration records of a session: member runs (start order,
 * latest state), workflows and, once a teammate exists, the team (latest
 * roster entry per name, task per id, message per id). Pure.
 */
export function collaborationView(sessionId: string, records: readonly SessionRecord[]): CollaborationView {
  const starts: SubagentStartRecord[] = []
  const ends = new Map<string, SubagentEndRecord>()
  const workflows = new Map<string, WorkflowState>()
  const members = new Map<string, TeamMember>()
  const tasks = new Map<string, TeamTask>()
  const messages = new Map<string, TeamMessage>()
  for (const record of records) {
    switch (record.type) {
      case 'subagent.start':
        starts.push(record)
        if (record.workflowId !== undefined) {
          const workflow = workflows.get(record.workflowId)
          if (workflow !== undefined && workflow.status === 'running') workflow.members += 1
        }
        break
      case 'subagent.end':
        ends.set(runKey(record.childSessionId, record.childTurn), record)
        break
      case 'workflow.start':
        workflows.set(record.workflowId, {
          workflowId: record.workflowId,
          kind: record.kind,
          ...(record.title === undefined ? {} : { title: record.title }),
          ...(record.architecture === undefined ? {} : { architecture: record.architecture }),
          phases: [],
          status: 'running',
          members: 0,
        })
        break
      case 'workflow.phase':
        workflows.get(record.workflowId)?.phases.push(record.phase)
        break
      case 'workflow.end': {
        const workflow = workflows.get(record.workflowId)
        if (workflow === undefined) break
        workflow.status = record.status
        workflow.members = record.members
        if (record.error !== undefined) workflow.error = record.error
        break
      }
      case 'team.member':
        members.set(record.member.name, record.member)
        break
      case 'team.task':
        tasks.set(record.task.id, record.task)
        break
      case 'team.message':
        messages.set(record.message.id, record.message)
        break
      default:
        break
    }
  }
  return {
    sessionId,
    runs: starts.map(start => memberRunView(start, ends.get(runKey(start.childSessionId, start.childTurn)))),
    workflows: [...workflows.values()].map(workflowView),
    ...(members.size === 0 ? {} : { team: { members: [...members.values()], tasks: [...tasks.values()], messages: [...messages.values()] } }),
  }
}

/**
 * Redesign 3.2: read a check-retry note (it starts with
 * `CHECK_RETRY_NOTE_PREFIX`); `undefined` for any other injected text.
 */
export function checkRetryOf(text: string): CheckRetryView | undefined {
  if (!text.startsWith(CHECK_RETRY_NOTE_PREFIX)) return undefined
  const head = /^\S+ Automatic check \(retry (\d+) of (\d+)\)/.exec(text)
  const failed = text.split('\n').filter(line => line.startsWith('- ')).map(line => checkFailureOf(line.slice(2)))
  return { attempt: Number(head?.[1] ?? 1), max: Number(head?.[2] ?? 1), failed }
}

function checkFailureOf(line: string): CheckFailureView {
  const parts = /^(.*): failed(?: \((.*)\))?$/.exec(line)
  if (parts === null) return { check: 'other', target: line }
  const [, what = '', detail] = parts
  const extra = detail === undefined ? {} : { detail }
  const own = /^project check command `(.*)`$/.exec(what)
  if (own !== null) return { check: 'check-command', target: own[1]!, ...extra }
  const command = /^test command `(.*)`$/.exec(what)
  if (command !== null) return { check: 'test-command', target: command[1]!, ...extra }
  const parses = /^(.*) parses as (\S+)$/.exec(what)
  if (parses !== null) return { check: 'parses', target: parses[1]!, format: parses[2]!, ...extra }
  const exists = /^(.*) exists$/.exec(what)
  if (exists !== null) return { check: 'exists', target: exists[1]!, ...extra }
  return { check: 'other', target: line }
}

/** Project records onto history items, in record order. */
export function historyItems(records: readonly SessionRecord[]): HistoryItem[] {
  const items: HistoryItem[] = []
  const calls = new Map<string, ToolCall>()
  const approvals = new Map<string, MutableApproval>()
  // Collaboration items show their latest state at the place they started.
  const runs = new Map<string, { index: number; start: SubagentStartRecord }>()
  const workflows = new Map<string, { index: number; state: WorkflowState }>()
  const messages = new Map<string, number>()
  for (const record of records) {
    switch (record.type) {
      case 'user.message':
        if (record.source === 'inject') {
          const retry = checkRetryOf(record.content)
          if (retry !== undefined) items.push({ kind: 'check.retry', turn: record.turn, retry })
          break
        }
        items.push({ kind: 'user', turn: record.turn, text: record.content, source: record.source, materials: [...(record.materials ?? [])] })
        break
      case 'assistant.message':
        for (const call of record.toolCalls ?? []) calls.set(call.id, call)
        items.push({
          kind: 'assistant',
          turn: record.turn,
          step: record.step,
          text: record.content,
          finishReason: record.finishReason,
          interrupted: record.interrupted === true,
        })
        break
      case 'tool.result':
        items.push({
          kind: 'tool',
          turn: record.turn,
          step: record.step,
          call: calls.get(record.toolCallId) ?? { id: record.toolCallId, name: record.name, arguments: '' },
          content: record.content,
          isError: record.isError,
          durationMs: record.durationMs,
        })
        break
      case 'approval.request': {
        const item: MutableApproval = { kind: 'approval', turn: record.turn, request: record.request }
        approvals.set(record.request.id, item)
        items.push(item)
        break
      }
      case 'approval.decision': {
        const item = approvals.get(record.decision.id)
        if (item !== undefined) item.decision = record.decision
        break
      }
      case 'deliverable.presented':
        items.push({ kind: 'deliverable', turn: record.turn, deliverable: record.deliverable })
        break
      case 'turn.files':
        items.push({ kind: 'files', turn: record.turn, changes: record.changes })
        break
      case 'feedback':
        items.push({
          kind: 'feedback',
          turn: record.turn,
          deliverableId: record.feedback.deliverableId,
          version: record.feedback.version,
          ...(record.feedback.rating === undefined ? {} : { rating: record.feedback.rating }),
          comment: record.feedback.comment,
        })
        break
      case 'compaction':
        items.push({ kind: 'compaction', turn: record.turn })
        break
      case 'turn.rewind':
        items.push({ kind: 'rewind', rewind: { toTurn: record.toTurn, restored: [...record.restored], deleted: [...record.deleted] } })
        break
      case 'subagent.start':
        runs.set(runKey(record.childSessionId, record.childTurn), { index: items.length, start: record })
        items.push({ kind: 'member', turn: record.turn, run: memberRunView(record) })
        if (record.workflowId !== undefined) {
          const workflow = workflows.get(record.workflowId)
          if (workflow !== undefined && workflow.state.status === 'running') {
            workflow.state.members += 1
            items[workflow.index] = { kind: 'workflow', turn: (items[workflow.index] as { turn: number }).turn, workflow: workflowView(workflow.state) }
          }
        }
        break
      case 'subagent.end': {
        const run = runs.get(runKey(record.childSessionId, record.childTurn))
        if (run !== undefined) items[run.index] = { kind: 'member', turn: run.start.turn, run: memberRunView(run.start, record) }
        break
      }
      case 'workflow.start': {
        const state: WorkflowState = {
          workflowId: record.workflowId,
          kind: record.kind,
          ...(record.title === undefined ? {} : { title: record.title }),
          ...(record.architecture === undefined ? {} : { architecture: record.architecture }),
          phases: [],
          status: 'running',
          members: 0,
        }
        workflows.set(record.workflowId, { index: items.length, state })
        items.push({ kind: 'workflow', turn: record.turn, workflow: workflowView(state) })
        break
      }
      case 'workflow.phase':
      case 'workflow.end': {
        const workflow = workflows.get(record.workflowId)
        if (workflow === undefined) break
        if (record.type === 'workflow.phase') {
          workflow.state.phases.push(record.phase)
        } else {
          workflow.state.status = record.status
          workflow.state.members = record.members
          if (record.error !== undefined) workflow.state.error = record.error
        }
        items[workflow.index] = { kind: 'workflow', turn: (items[workflow.index] as { turn: number }).turn, workflow: workflowView(workflow.state) }
        break
      }
      case 'team.message': {
        const item: HistoryItem = { kind: 'team.message', ...(record.turn === undefined ? {} : { turn: record.turn }), message: record.message }
        const index = messages.get(record.message.id)
        if (index === undefined) {
          messages.set(record.message.id, items.length)
          items.push(item)
        } else {
          items[index] = { ...item, ...(items[index]!.turn === undefined ? {} : { turn: items[index]!.turn }) } as HistoryItem
        }
        break
      }
      case 'turn.end':
        items.push({ kind: 'turn.end', turn: record.turn, reason: record.reason })
        break
      case 'error':
        items.push({ kind: 'error', ...(record.turn === undefined ? {} : { turn: record.turn }), error: record.error })
        break
      default:
        break
    }
  }
  return items
}

/**
 * Rework D3: `cost` on each `turn.end` item, the estimated dollars of the
 * turn's own requests plus its member runs, priced at `model` (the session's
 * model; a member that ran on another model is priced at it too, so the
 * figure is approximate). `estimated` when some usage or price is unknown.
 */
export function withTurnCosts(items: readonly HistoryItem[], records: readonly SessionRecord[], model: string): HistoryItem[] {
  return items.map(item => {
    if (item.kind !== 'turn.end') return item
    let usd = 0
    let estimated = false
    const add = (usage: LLMUsage | undefined): void => {
      if (usage === undefined) return
      const price = estimateUsd(model, usage)
      if (price === 'unknown') estimated = true
      else usd += price
    }
    for (const record of records) if (record.type === 'assistant.message' && record.turn === item.turn) add(record.usage)
    for (const other of items) if (other.kind === 'member' && other.turn === item.turn) add(other.run.usage)
    return { ...item, cost: { usd, estimated } }
  })
}

/** Usage summed over one turn's assistant messages (zero when it made no request). */
export function turnUsage(records: readonly SessionRecord[], turn: number) {
  return addUsage(...records.filter(record => record.type === 'assistant.message' && record.turn === turn).map(record => (record as Extract<SessionRecord, { type: 'assistant.message' }>).usage))
}

/**
 * A session's list entry.
 * @param running - a turn of it is running in this SDK instance.
 */
export function sessionSummary(records: readonly SessionRecord[], state: SessionState, running: boolean): SessionSummary {
  return summaryOfEntry(summarizeSession(records, state), running)
}

/** The list entry for an index entry (read from `summary.json` or built from the records). */
export function summaryOfEntry(entry: SessionIndexEntry, running: boolean): SessionSummary {
  return {
    sessionId: entry.sessionId,
    ...(entry.title === undefined ? {} : { title: entry.title }),
    ...(entry.firstMessage === undefined ? {} : { firstMessage: entry.firstMessage }),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    lastTurn: entry.lastTurn,
    running,
    interrupted: !running && entry.interrupted,
    ...(entry.goal === undefined ? {} : { goal: entry.goal }),
    ...(entry.parentSessionId === undefined ? {} : { parentSessionId: entry.parentSessionId }),
    ...(entry.member === undefined ? {} : { member: entry.member }),
  }
}
