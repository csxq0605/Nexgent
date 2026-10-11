/**
 * The conversation timeline: one flat list of entries the middle column
 * renders. It is built from a session's display history (`sessions.open`)
 * and then advanced by live `SdkEvent`s. Pure functions only, so the
 * streaming rules (append deltas, finalize on `assistant.message`, keep
 * interrupted text) are tested without React.
 */
import type {
  ApprovalDecision,
  ApprovalRequest,
  DeliverableVersionRef,
  ErrorInfo,
  FileChange,
  TurnEndReason,
} from '@nexgent/kernel'
import type { HistoryItem, SdkEvent } from '@nexgent/sdk'

export type TimelineEntry =
  | { readonly kind: 'user'; readonly key: string; readonly turn: number; readonly text: string; readonly feedback: boolean; readonly materials: readonly string[] }
  | { readonly kind: 'assistant'; readonly key: string; readonly turn: number; readonly step: number; readonly text: string; readonly streaming: boolean; readonly interrupted: boolean }
  | { readonly kind: 'reasoning'; readonly key: string; readonly turn: number; readonly step: number; readonly text: string; readonly streaming: boolean }
  | {
      readonly kind: 'tool'
      readonly key: string
      readonly turn: number
      readonly step: number
      readonly callId: string
      readonly name: string
      readonly args: string
      readonly running: boolean
      readonly content?: string
      readonly isError?: boolean
      readonly durationMs?: number
    }
  | { readonly kind: 'approval'; readonly key: string; readonly turn: number; readonly request: ApprovalRequest; readonly decision?: ApprovalDecision }
  | { readonly kind: 'deliverable'; readonly key: string; readonly turn: number; readonly deliverable: DeliverableVersionRef }
  | { readonly kind: 'files'; readonly key: string; readonly turn: number; readonly changes: readonly FileChange[] }
  | { readonly kind: 'feedback'; readonly key: string; readonly turn: number; readonly deliverableId: string; readonly version: number; readonly rating?: number; readonly comment: string }
  | { readonly kind: 'compaction'; readonly key: string; readonly turn: number }
  | { readonly kind: 'turn.end'; readonly key: string; readonly turn: number; readonly reason: TurnEndReason }
  | { readonly kind: 'error'; readonly key: string; readonly turn?: number; readonly error: ErrorInfo }

const assistantKey = (turn: number, step: number): string => `a:${turn}:${step}`
const reasoningKey = (turn: number, step: number): string => `r:${turn}:${step}`
const toolKey = (callId: string): string => `t:${callId}`

/** Convert a session's display history into timeline entries. */
export function fromHistory(items: readonly HistoryItem[]): TimelineEntry[] {
  const out: TimelineEntry[] = []
  items.forEach((item, index) => {
    switch (item.kind) {
      case 'user':
        out.push({ kind: 'user', key: `u:${item.turn}:${index}`, turn: item.turn, text: item.text, feedback: item.source === 'feedback', materials: item.materials })
        break
      case 'assistant':
        if (item.text.length === 0 && !item.interrupted) break
        out.push({ kind: 'assistant', key: assistantKey(item.turn, item.step), turn: item.turn, step: item.step, text: item.text, streaming: false, interrupted: item.interrupted })
        break
      case 'tool':
        out.push({
          kind: 'tool',
          key: toolKey(item.call.id),
          turn: item.turn,
          step: item.step,
          callId: item.call.id,
          name: item.call.name,
          args: item.call.arguments,
          running: false,
          content: item.content,
          isError: item.isError,
          durationMs: item.durationMs,
        })
        break
      case 'approval':
        out.push({ kind: 'approval', key: `ap:${item.request.id}`, turn: item.turn, request: item.request, ...(item.decision === undefined ? {} : { decision: item.decision }) })
        break
      case 'deliverable':
        out.push({ kind: 'deliverable', key: `d:${item.deliverable.deliverableId}:${item.deliverable.version}`, turn: item.turn, deliverable: item.deliverable })
        break
      case 'files':
        if (item.changes.length === 0) break
        out.push({ kind: 'files', key: `f:${item.turn}:${index}`, turn: item.turn, changes: item.changes })
        break
      case 'feedback':
        out.push({
          kind: 'feedback',
          key: `fb:${item.turn}:${index}`,
          turn: item.turn,
          deliverableId: item.deliverableId,
          version: item.version,
          ...(item.rating === undefined ? {} : { rating: item.rating }),
          comment: item.comment,
        })
        break
      case 'compaction':
        out.push({ kind: 'compaction', key: `c:${item.turn}:${index}`, turn: item.turn })
        break
      case 'turn.end':
        out.push({ kind: 'turn.end', key: `e:${item.turn}`, turn: item.turn, reason: item.reason })
        break
      case 'error':
        out.push({ kind: 'error', key: `x:${index}`, ...(item.turn === undefined ? {} : { turn: item.turn }), error: item.error })
        break
    }
  })
  return out
}

function upsert(list: readonly TimelineEntry[], key: string, make: (prev: TimelineEntry | undefined) => TimelineEntry | undefined): TimelineEntry[] {
  const index = list.findIndex(entry => entry.key === key)
  const next = make(index === -1 ? undefined : list[index])
  if (next === undefined) return [...list]
  if (index === -1) return [...list, next]
  const copy = [...list]
  copy[index] = next
  return copy
}

/** Stop every entry that still claims to be streaming or running (turn ended). */
function settle(list: readonly TimelineEntry[], turn: number): TimelineEntry[] {
  return list.map(entry => {
    if (entry.turn !== turn) return entry
    if ((entry.kind === 'assistant' || entry.kind === 'reasoning') && entry.streaming) return { ...entry, streaming: false }
    if (entry.kind === 'tool' && entry.running) return { ...entry, running: false }
    return entry
  })
}

let localCounter = 0

/** The user's own message, added when it is sent (events do not carry the text). */
export function userEntry(turn: number, text: string, materials: readonly string[]): TimelineEntry {
  localCounter += 1
  return { kind: 'user', key: `u:${turn}:local${localCounter}`, turn, text, feedback: false, materials }
}

/** The feedback the user just submitted. */
export function feedbackEntry(turn: number, deliverableId: string, version: number, rating: number | undefined, comment: string): TimelineEntry {
  localCounter += 1
  return { kind: 'feedback', key: `fb:${turn}:local${localCounter}`, turn, deliverableId, version, ...(rating === undefined ? {} : { rating }), comment }
}

/** Advance the timeline by one live event of this session. */
export function applyEvent(list: readonly TimelineEntry[], event: SdkEvent): TimelineEntry[] {
  switch (event.type) {
    case 'text.delta':
      return upsert(list, assistantKey(event.turn, event.step), prev =>
        prev?.kind === 'assistant'
          ? { ...prev, text: prev.text + event.text, streaming: true }
          : { kind: 'assistant', key: assistantKey(event.turn, event.step), turn: event.turn, step: event.step, text: event.text, streaming: true, interrupted: false },
      )
    case 'reasoning.delta':
      return upsert(list, reasoningKey(event.turn, event.step), prev =>
        prev?.kind === 'reasoning'
          ? { ...prev, text: prev.text + event.text, streaming: true }
          : { kind: 'reasoning', key: reasoningKey(event.turn, event.step), turn: event.turn, step: event.step, text: event.text, streaming: true },
      )
    case 'assistant.message': {
      const key = assistantKey(event.turn, event.step)
      const stopped = list.map(entry => (entry.key === reasoningKey(event.turn, event.step) && entry.kind === 'reasoning' ? { ...entry, streaming: false } : entry))
      return upsert(stopped, key, prev => {
        // Prefer the recorded text; an interrupted message keeps whatever already streamed if the record is shorter.
        const streamed = prev?.kind === 'assistant' ? prev.text : ''
        const text = event.text.length >= streamed.length ? event.text : streamed
        if (text.length === 0 && !event.interrupted) return prev
        return { kind: 'assistant', key, turn: event.turn, step: event.step, text, streaming: false, interrupted: event.interrupted }
      })
    }
    case 'tool.start':
      return upsert(list, toolKey(event.call.id), prev =>
        prev ?? { kind: 'tool', key: toolKey(event.call.id), turn: event.turn, step: event.step, callId: event.call.id, name: event.call.name, args: event.call.arguments, running: true },
      )
    case 'tool.result':
      return upsert(list, toolKey(event.callId), prev =>
        prev?.kind === 'tool'
          ? { ...prev, running: false, content: event.content, isError: event.isError, durationMs: event.durationMs }
          : {
              kind: 'tool',
              key: toolKey(event.callId),
              turn: event.turn,
              step: event.step,
              callId: event.callId,
              name: event.name,
              args: '',
              running: false,
              content: event.content,
              isError: event.isError,
              durationMs: event.durationMs,
            },
      )
    case 'approval.request':
      return upsert(list, `ap:${event.request.id}`, prev => prev ?? { kind: 'approval', key: `ap:${event.request.id}`, turn: event.turn, request: event.request })
    case 'approval.decision':
      return upsert(list, `ap:${event.decision.id}`, prev => (prev?.kind === 'approval' ? { ...prev, decision: event.decision } : prev))
    case 'deliverable.presented':
      return upsert(list, `d:${event.deliverable.deliverableId}:${event.deliverable.version}`, () => ({
        kind: 'deliverable',
        key: `d:${event.deliverable.deliverableId}:${event.deliverable.version}`,
        turn: event.turn,
        deliverable: event.deliverable,
      }))
    case 'turn.files':
      if (event.changes.length === 0) return [...list]
      return [...list, { kind: 'files', key: `f:${event.turn}:${event.eventSeq}`, turn: event.turn, changes: event.changes }]
    case 'compaction':
      return [...list, { kind: 'compaction', key: `c:${event.turn}:${event.eventSeq}`, turn: event.turn }]
    case 'error':
      return [...list, { kind: 'error', key: `x:${event.eventSeq}`, ...(event.turn === undefined ? {} : { turn: event.turn }), error: event.error }]
    case 'turn.end':
      return upsert(settle(list, event.turn), `e:${event.turn}`, () => ({ kind: 'turn.end', key: `e:${event.turn}`, turn: event.turn, reason: event.reason }))
    case 'turn.start':
    case 'goal':
    case 'material.added':
      return [...list]
  }
}
