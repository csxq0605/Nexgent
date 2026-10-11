/**
 * Display history: a session's records projected onto the SDK's
 * {@link HistoryItem}s and {@link SessionSummary}. Derived from the records
 * themselves, never from the (possibly compacted) model history, so the UI
 * always shows every turn.
 */
import { addUsage, type ApprovalDecision, type ApprovalRequest, type SessionRecord, type SessionState, type ToolCall } from '@nexgent/kernel'
import type { HistoryItem, SessionSummary } from './api.js'

type MutableApproval = { kind: 'approval'; turn: number; request: ApprovalRequest; decision?: ApprovalDecision }

/** Project records onto history items, in record order. */
export function historyItems(records: readonly SessionRecord[]): HistoryItem[] {
  const items: HistoryItem[] = []
  const calls = new Map<string, ToolCall>()
  const approvals = new Map<string, MutableApproval>()
  for (const record of records) {
    switch (record.type) {
      case 'user.message':
        if (record.source === 'inject') break
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

/** Usage summed over one turn's assistant messages (zero when it made no request). */
export function turnUsage(records: readonly SessionRecord[], turn: number) {
  return addUsage(...records.filter(record => record.type === 'assistant.message' && record.turn === turn).map(record => (record as Extract<SessionRecord, { type: 'assistant.message' }>).usage))
}

/**
 * A session's list entry.
 * @param running - a turn of it is running in this SDK instance.
 */
export function sessionSummary(records: readonly SessionRecord[], state: SessionState, running: boolean): SessionSummary {
  const start = records[0]
  const last = records.at(-1)
  const meta = state.metadata
  let lastEnd: Extract<SessionRecord, { type: 'turn.end' }> | undefined
  for (const record of records) if (record.type === 'turn.end') lastEnd = record
  const interrupted = !running && (meta.openTurn !== undefined
    || (lastEnd !== undefined && lastEnd.reason.kind === 'interrupted' && lastEnd.turn === meta.lastTurn))
  return {
    sessionId: state.sessionId,
    ...(meta.title === undefined ? {} : { title: meta.title }),
    createdAt: start?.ts ?? meta.createdAt,
    updatedAt: last?.ts ?? meta.createdAt,
    lastTurn: meta.lastTurn,
    running,
    interrupted,
    ...(meta.goal === undefined ? {} : { goal: meta.goal }),
  }
}
