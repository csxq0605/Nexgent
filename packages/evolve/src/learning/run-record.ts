/**
 * What reflection reads of one task (ADR 0018 decision 4: "the run record
 * and the self-evaluation"): the root session's records of the turns being
 * learned from, reduced to a bounded text — the user's messages, the steps
 * the model took (tool calls with a short argument preview, failures), the
 * final answer, the files changed and the deliverables presented, the user's
 * feedback and the handbook entries the turns were given
 * (`turn.start.handbook`). Never the system prompt, never injected context.
 */
import type { FeedbackEntry, SessionRecord, SessionStore } from '@nexgent/kernel'

/** Bounds of the rendered record. */
export const RUN_RECORD_LIMITS = {
  /** Characters of the whole rendered record. */
  maxChars: 14_000,
  /** Characters of one user message. */
  maxMessageChars: 3_000,
  /** Characters of a tool call's argument preview. */
  maxArgumentChars: 160,
  /** Characters of a failed tool result's preview. */
  maxErrorChars: 300,
  /** Characters of the final answer. */
  maxAnswerChars: 2_000,
  /** Tool steps listed (the first ones and the last ones are kept). */
  maxSteps: 60,
} as const

/** One task's turns as reflection sees them. */
export interface TaskRun {
  readonly sessionId: string
  readonly fromTurn: number
  readonly toTurn: number
  /** First turn not seen by an earlier reflection (the record still shows the turns before it, for context). */
  readonly newFromTurn: number
  /** The first user message of the session (the task). */
  readonly task: string
  /** User messages of the turns read (feedback prompts included), in order. */
  readonly messages: readonly { readonly turn: number; readonly source: string; readonly text: string }[]
  /** One line per tool call. */
  readonly steps: readonly string[]
  readonly toolCalls: number
  readonly failedToolCalls: number
  readonly answer: string
  readonly filesChanged: readonly string[]
  readonly deliverables: readonly { readonly title: string; readonly files: readonly string[] }[]
  readonly feedback: readonly FeedbackEntry[]
  /** Latest rating in the session up to `toTurn`, if any. */
  readonly rating?: number
  /** Handbook entry ids given to the turns read, first-seen order. */
  readonly shownEntries: readonly string[]
  /** How the last turn ended. */
  readonly endReason?: string
  /** Whether this is a root task session (not a member). */
  readonly isRootTask: boolean
}

function clipText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Reduce a session's records (turns `fromTurn`–`toTurn`; `newFromTurn` marks where the unseen turns start) to a {@link TaskRun}. Pure. */
export function taskRunOf(records: readonly SessionRecord[], fromTurn: number, toTurn: number, newFromTurn = fromTurn): TaskRun {
  const start = records.find(record => record.type === 'session.start')
  const isRootTask = start !== undefined && start.type === 'session.start' && start.parentSessionId === undefined
  const firstUser = records.find(record => record.type === 'user.message' && record.source === 'user')
  const inRange = (turn: number) => turn >= fromTurn && turn <= toTurn
  const messages: { turn: number; source: string; text: string }[] = []
  const steps: string[] = []
  const filesChanged = new Set<string>()
  const deliverables: { title: string; files: string[] }[] = []
  const feedback: FeedbackEntry[] = []
  const shown: string[] = []
  let rating: number | undefined
  let toolCalls = 0
  let failed = 0
  let answer = ''
  let endReason: string | undefined
  const pending = new Map<string, string>()
  for (const record of records) {
    if (record.type === 'feedback' && record.turn <= toTurn && record.feedback.rating !== undefined) rating = record.feedback.rating
    if (!('turn' in record) || typeof record.turn !== 'number' || !inRange(record.turn)) continue
    switch (record.type) {
      case 'turn.start':
        for (const id of record.handbook ?? []) if (!shown.includes(id)) shown.push(id)
        break
      case 'user.message':
        if (record.source !== 'inject') messages.push({ turn: record.turn, source: record.source, text: clipText(record.content, RUN_RECORD_LIMITS.maxMessageChars) })
        break
      case 'assistant.message':
        if (record.content.trim() !== '') answer = record.content
        for (const call of record.toolCalls ?? []) {
          toolCalls += 1
          const line = `turn ${record.turn} · ${call.name} ${clipText(oneLine(call.arguments), RUN_RECORD_LIMITS.maxArgumentChars)}`
          pending.set(call.id, line)
          steps.push(line)
        }
        break
      case 'tool.result':
        if (record.isError) {
          failed += 1
          const line = pending.get(record.toolCallId)
          const index = line === undefined ? -1 : steps.lastIndexOf(line)
          const note = ` → error: ${clipText(oneLine(record.content), RUN_RECORD_LIMITS.maxErrorChars)}`
          if (index >= 0) steps[index] = `${steps[index]}${note}`
          else steps.push(`turn ${record.turn} · ${record.name}${note}`)
        }
        break
      case 'turn.files':
        for (const change of record.changes) filesChanged.add(`${change.change} ${change.path}`)
        break
      case 'deliverable.presented':
        deliverables.push({ title: record.deliverable.title, files: record.deliverable.files.map(file => file.path) })
        break
      case 'feedback':
        feedback.push(record.feedback)
        break
      case 'turn.end':
        endReason = record.reason.kind === 'cancelled' ? `cancelled (${record.reason.cause})` : record.reason.kind === 'error' ? `error (${record.reason.error.code})` : record.reason.kind
        break
      default:
        break
    }
  }
  const kept = steps.length <= RUN_RECORD_LIMITS.maxSteps
    ? steps
    : [...steps.slice(0, RUN_RECORD_LIMITS.maxSteps / 2), `… ${steps.length - RUN_RECORD_LIMITS.maxSteps} steps left out …`, ...steps.slice(-RUN_RECORD_LIMITS.maxSteps / 2)]
  return {
    sessionId: start?.sessionId ?? records[0]?.sessionId ?? '',
    fromTurn,
    toTurn,
    newFromTurn,
    task: firstUser !== undefined && firstUser.type === 'user.message' ? firstUser.content : '',
    messages,
    steps: kept,
    toolCalls,
    failedToolCalls: failed,
    answer: clipText(answer, RUN_RECORD_LIMITS.maxAnswerChars),
    filesChanged: [...filesChanged].sort(),
    deliverables,
    feedback,
    ...(rating === undefined ? {} : { rating }),
    shownEntries: shown,
    ...(endReason === undefined ? {} : { endReason }),
    isRootTask,
  }
}

/** Read a session and reduce it. */
export async function readTaskRun(sessions: Pick<SessionStore, 'readAll'>, sessionId: string, fromTurn: number, toTurn: number, newFromTurn = fromTurn): Promise<TaskRun> {
  const { records } = await sessions.readAll(sessionId)
  return taskRunOf(records, fromTurn, toTurn, newFromTurn)
}

/** The run as reflection's prompt shows it, at most {@link RUN_RECORD_LIMITS.maxChars} characters. Pure. */
export function renderTaskRun(run: TaskRun): string {
  const parts: string[] = []
  parts.push(`## Task (first user message)\n${clipText(run.task, RUN_RECORD_LIMITS.maxMessageChars)}`)
  const later = run.messages.filter(message => !(message.turn === 1 && message.source === 'user' && message.text === clipText(run.task, RUN_RECORD_LIMITS.maxMessageChars)))
  if (run.newFromTurn > run.fromTurn) parts.push(`## Turns ${run.newFromTurn}–${run.toTurn} are new since the last reflection on this task; earlier turns are shown for context.`)
  if (later.length > 0) parts.push(`## Messages of turns ${run.fromTurn}–${run.toTurn}\n${later.map(message => `- turn ${message.turn} (${message.source}): ${message.text}`).join('\n')}`)
  if (run.feedback.length > 0) parts.push(`## User feedback\n${run.feedback.map(entry => `- ${entry.rating === undefined ? 'no rating' : `rating ${entry.rating}/5`}: ${clipText(oneLine(entry.comment), 600)}`).join('\n')}`)
  parts.push(`## Steps (${run.toolCalls} tool calls, ${run.failedToolCalls} failed)\n${run.steps.length === 0 ? '(none)' : run.steps.join('\n')}`)
  if (run.filesChanged.length > 0) parts.push(`## Files changed\n${run.filesChanged.slice(0, 40).join('\n')}${run.filesChanged.length > 40 ? `\n… ${run.filesChanged.length - 40} more` : ''}`)
  if (run.deliverables.length > 0) parts.push(`## Deliverables presented\n${run.deliverables.map(d => `- ${d.title}: ${d.files.join(', ')}`).join('\n')}`)
  parts.push(`## Final answer\n${run.answer === '' ? '(none)' : run.answer}`)
  if (run.endReason !== undefined) parts.push(`## How the last turn ended\n${run.endReason}`)
  const text = parts.join('\n\n')
  return clipText(text, RUN_RECORD_LIMITS.maxChars)
}
