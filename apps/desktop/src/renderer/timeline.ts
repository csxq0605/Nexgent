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
  OrganizationChangeNote,
} from '@nexgent/kernel'
import type { CheckRetryView, HistoryItem, MemberRunView, OrganizationView, RewindRecordView, SdkEvent, TurnCost, WorkflowView } from '@nexgent/sdk'

export type TimelineEntry =
  | { readonly kind: 'user'; readonly key: string; readonly turn: number; readonly text: string; readonly feedback: boolean; readonly materials: readonly string[]; readonly thread?: true }
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
  /** `cost`: rework D3, the turn's estimated dollars (shown under the turn). */
  | { readonly kind: 'turn.end'; readonly key: string; readonly turn: number; readonly reason: TurnEndReason; readonly cost?: TurnCost }
  | { readonly kind: 'error'; readonly key: string; readonly turn?: number; readonly error: ErrorInfo }
  /** Step 3: one member run (delegate, workflow member, thread), updated in place until it ends. */
  | { readonly kind: 'member'; readonly key: string; readonly turn: number; readonly run: MemberRunView }
  /** Step 3: a workflow; live events only bring its phases, `sessions.collaboration` the rest. */
  | { readonly kind: 'workflow'; readonly key: string; readonly turn: number; readonly workflow: WorkflowView }
  /** New direction step 2: an organization the turn ran (shown on the turn's team card). */
  | { readonly kind: 'organization'; readonly key: string; readonly turn: number; readonly organization: OrganizationView }
  /** The one change to how the work is organized the turn tried, and why. */
  | { readonly kind: 'change'; readonly key: string; readonly turn: number; readonly change: OrganizationChangeNote }
  /** Redesign 3.2: the turn's checks failed and the model went back to fix them. */
  | { readonly kind: 'check.retry'; readonly key: string; readonly turn: number; readonly retry: CheckRetryView }
  /** Redesign 3.1: the user put files back to how they were before a turn. */
  | { readonly kind: 'rewind'; readonly key: string; readonly turn?: undefined; readonly rewind: RewindRecordView }

/**
 * The entries to show: a turn's line on the change to the organization it
 * tries shows only once the turn did organize the work (an organization
 * ran, or threads were started); a turn that did its work alone did not
 * try the change. A verdict on an earlier change alone always shows.
 */
export function shownEntries(entries: readonly TimelineEntry[]): readonly TimelineEntry[] {
  const organized = new Set<number>()
  for (const entry of entries) {
    if (entry.kind === 'organization' || (entry.kind === 'member' && entry.run.executionForm === 'thread')) organized.add(entry.turn)
  }
  return entries.filter(entry => entry.kind !== 'change' || organized.has(entry.turn) || (entry.change.status !== 'trying' && entry.change.next === undefined))
}

const assistantKey = (turn: number, step: number): string => `a:${turn}:${step}`
const reasoningKey = (turn: number, step: number): string => `r:${turn}:${step}`
const toolKey = (callId: string): string => `t:${callId}`
/** Key of a member run's entry. */
export const memberKey = (run: Pick<MemberRunView, 'childSessionId' | 'childTurn'>): string => `m:${run.childSessionId}:${run.childTurn}`
/** Key of a workflow's entry. */
export const workflowKey = (workflowId: string): string => `w:${workflowId}`

/**
 * Convert a session's display history into timeline entries.
 *
 * The session records a `present` call's deliverable before the call's tool
 * result, so in history the card would sit above its own tool block. Cards
 * wait until the next successful `present` block of their turn and follow it
 * (in order, one per block); any still waiting when the turn moves on are
 * placed there.
 */
export function fromHistory(items: readonly HistoryItem[]): TimelineEntry[] {
  const out: TimelineEntry[] = []
  let waiting: TimelineEntry[] = []
  const flush = (): void => {
    out.push(...waiting)
    waiting = []
  }
  items.forEach((item, index) => {
    if (waiting.length > 0 && item.turn !== waiting[0]!.turn) flush()
    if (item.kind === 'deliverable') {
      waiting.push({ kind: 'deliverable', key: `d:${item.deliverable.deliverableId}:${item.deliverable.version}`, turn: item.turn, deliverable: item.deliverable })
      return
    }
    if (item.kind === 'turn.end') flush()
    switch (item.kind) {
      case 'user':
        out.push({ kind: 'user', key: `u:${item.turn}:${index}`, turn: item.turn, text: item.text, feedback: item.source === 'feedback', materials: item.materials, ...(item.source === 'thread' ? { thread: true as const } : {}) })
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
        if (item.call.name === 'present' && !item.isError && waiting.length > 0) out.push(waiting.shift()!)
        break
      case 'approval':
        out.push({ kind: 'approval', key: `ap:${item.request.id}`, turn: item.turn, request: item.request, ...(item.decision === undefined ? {} : { decision: item.decision }) })
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
      case 'change':
        out.push({ kind: 'change', key: `ch:${item.turn}`, turn: item.turn, change: item.change })
        break
      case 'turn.end':
        out.push({ kind: 'turn.end', key: `e:${item.turn}`, turn: item.turn, reason: item.reason, ...(item.cost === undefined ? {} : { cost: item.cost }) })
        break
      case 'error':
        out.push({ kind: 'error', key: `x:${index}`, ...(item.turn === undefined ? {} : { turn: item.turn }), error: item.error })
        break
      case 'member':
        out.push({ kind: 'member', key: memberKey(item.run), turn: item.turn, run: item.run })
        break
      case 'workflow':
        out.push({ kind: 'workflow', key: workflowKey(item.workflow.workflowId), turn: item.turn, workflow: item.workflow })
        break
      case 'organization':
        out.push({ kind: 'organization', key: `o:${item.organization.organizationId}`, turn: item.turn, organization: item.organization })
        break
        break
      case 'check.retry':
        out.push({ kind: 'check.retry', key: `cr:${item.turn}:${index}`, turn: item.turn, retry: item.retry })
        break
      case 'rewind':
        out.push({ kind: 'rewind', key: `rw:${index}`, rewind: item.rewind })
        break
    }
  })
  flush()
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
    case 'step.retry':
      return list.filter(entry => entry.key !== assistantKey(event.turn, event.step) && entry.key !== reasoningKey(event.turn, event.step))
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
      return upsert(settle(list, event.turn), `e:${event.turn}`, () => ({ kind: 'turn.end', key: `e:${event.turn}`, turn: event.turn, reason: event.reason, ...(event.cost === undefined ? {} : { cost: event.cost }) }))
    case 'member.start':
    case 'member.end':
      return upsert(list, memberKey(event.run), () => ({ kind: 'member', key: memberKey(event.run), turn: event.turn, run: event.run }))
    case 'workflow.phase':
      return upsert(list, workflowKey(event.workflowId), prev =>
        prev?.kind === 'workflow'
          ? { ...prev, workflow: { ...prev.workflow, phases: [...prev.workflow.phases, event.phase] } }
          : {
              kind: 'workflow',
              key: workflowKey(event.workflowId),
              turn: event.turn,
              workflow: { workflowId: event.workflowId, kind: 'script', phases: [event.phase], status: 'running', members: 0 },
            },
      )
    case 'organization':
      return upsert(list, `o:${event.organization.organizationId}`, () => ({ kind: 'organization', key: `o:${event.organization.organizationId}`, turn: event.turn, organization: event.organization }))
    case 'check.retry':
      return [...list, { kind: 'check.retry', key: `cr:${event.turn}:${event.eventSeq}`, turn: event.turn, retry: event.retry }]
    case 'turn.rewind':
      return [...list, { kind: 'rewind', key: `rw:${event.eventSeq}`, rewind: event.rewind }]
    case 'thread.message':
      return [...list, { kind: 'user', key: `u:${event.turn}:t${event.eventSeq}`, turn: event.turn, text: event.text, feedback: false, materials: [], thread: true }]
    case 'turn.start':
      return event.change === undefined ? [...list] : upsert(list, `ch:${event.turn}`, () => ({ kind: 'change', key: `ch:${event.turn}`, turn: event.turn, change: event.change! }))
    case 'goal':
    case 'material.added':
    // Step 4: project-level capability events have no place in a session timeline.
    case 'capability.version':
    // API 8: cost warnings are project-level (the shell shows them, not the timeline).
    case 'cost.warning':
    // Rework D2: the sidebar and the title bar show the title.
    case 'session.title':
      return [...list]
  }
}

/** Put the workflows of `sessions.collaboration` into the timeline (a live workflow starts without its own event). */
export function withWorkflows(list: readonly TimelineEntry[], workflows: readonly WorkflowView[], turn: number): TimelineEntry[] {
  let out = [...list]
  for (const workflow of workflows) {
    const key = workflowKey(workflow.workflowId)
    const at = out.findIndex(entry => entry.key === key)
    if (at !== -1) {
      const prev = out[at]!
      out[at] = { kind: 'workflow', key, turn: prev.turn ?? turn, workflow }
      continue
    }
    // Before its first member, else at the end.
    const first = out.findIndex(entry => entry.kind === 'member' && entry.run.workflowId === workflow.workflowId)
    const entry: TimelineEntry = { kind: 'workflow', key, turn: first === -1 ? turn : out[first]!.turn ?? turn, workflow }
    out = first === -1 ? [...out, entry] : [...out.slice(0, first), entry, ...out.slice(first)]
  }
  return out
}

/** Rework D3: one item of the plan the model keeps with `todo_write`. */
export interface PlanItem {
  readonly text: string
  readonly status: 'pending' | 'in_progress' | 'done'
}

const PLAN_STATUSES = new Set(['pending', 'in_progress', 'done'])

/** The items of one `todo_write` call's arguments, or `undefined` when they do not parse. */
export function planOf(args: string): PlanItem[] | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(args)
  } catch {
    return undefined
  }
  const todos = typeof parsed === 'object' && parsed !== null ? (parsed as { todos?: unknown }).todos : undefined
  if (!Array.isArray(todos)) return undefined
  const items: PlanItem[] = []
  for (const todo of todos) {
    if (typeof todo !== 'object' || todo === null) return undefined
    const { text, status } = todo as { text?: unknown; status?: unknown }
    if (typeof text !== 'string' || typeof status !== 'string' || !PLAN_STATUSES.has(status)) return undefined
    items.push({ text, status: status as PlanItem['status'] })
  }
  return items
}

/**
 * Rework D3: the conversation's current plan, from its latest successful
 * `todo_write` call (each call replaces the whole list), with the turn it
 * belongs to; `undefined` when none was written or it was emptied.
 */
export function latestPlan(entries: readonly TimelineEntry[]): { readonly turn: number; readonly items: readonly PlanItem[] } | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!
    if (entry.kind !== 'tool' || entry.name !== 'todo_write' || entry.isError === true) continue
    const items = planOf(entry.args)
    if (items === undefined) continue
    return items.length === 0 ? undefined : { turn: entry.turn, items }
  }
  return undefined
}

/** Redesign 3.1: the turns whose user message can take the files back (some turn from it on changed files). */
export function rewindableTurns(entries: readonly TimelineEntry[]): Set<number> {
  const changed = entries.flatMap(entry => (entry.kind === 'files' && entry.changes.length > 0 ? [entry.turn] : []))
  const last = changed.length === 0 ? 0 : Math.max(...changed)
  return new Set(entries.flatMap(entry => (entry.kind === 'user' && entry.turn <= last ? [entry.turn] : [])))
}
