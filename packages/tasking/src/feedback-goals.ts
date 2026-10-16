/**
 * Feedback and the persistent goal. Both live only in session records
 * (`feedback`, `goal.set`, `goal.update`); these stores read them back and
 * build the records the host writes. Normative text:
 * `docs/spec/data-formats.md` §反馈 and §持久目标.
 */
import { readdir } from 'node:fs/promises'
import {
  NexgentError,
  type ContextContribution,
  type ContextProvider,
  type DeliverableStore,
  type FeedbackEntry,
  type FeedbackListing,
  type FeedbackRating,
  type FeedbackStore,
  type Goal,
  type GoalStatus,
  type GoalStore,
  type HostRecordSink,
  type SessionStore,
  type SubmitFeedbackInput,
  type TurnContextInput,
  type WorkspaceLayout,
} from '@nexgent/kernel'
import { projectSession } from '@nexgent/session'
import { isNotFound, isTaskingId, newId } from './files-util.js'

const GOAL_STATUSES: readonly GoalStatus[] = ['active', 'completed', 'abandoned']

/** Feedback across the project's sessions, read from their `feedback` records. */
export class SessionFeedbackStore implements FeedbackStore {
  constructor(private readonly layout: WorkspaceLayout, private readonly sessions: SessionStore) {}

  async list(filter: { readonly sessionId?: string; readonly deliverableId?: string } = {}): Promise<readonly FeedbackListing[]> {
    const ids = filter.sessionId !== undefined ? [filter.sessionId] : await this.sessionIds()
    const found: Array<FeedbackListing & { readonly seq: number }> = []
    for (const sessionId of ids) {
      let records
      try {
        records = (await this.sessions.readAll(sessionId)).records
      } catch (error) {
        if (error instanceof NexgentError && error.code === 'session/not-found') continue
        throw error
      }
      for (const record of records) {
        if (record.type !== 'feedback') continue
        if (filter.deliverableId !== undefined && record.feedback.deliverableId !== filter.deliverableId) continue
        found.push({ ...record.feedback, sessionId, turn: record.turn, submittedAt: record.ts, seq: record.seq })
      }
    }
    found.sort((a, b) => (a.submittedAt === b.submittedAt ? (a.sessionId === b.sessionId ? a.seq - b.seq : a.sessionId.localeCompare(b.sessionId)) : a.submittedAt < b.submittedAt ? -1 : 1))
    return found.map(({ seq: _seq, ...listing }) => listing)
  }

  private async sessionIds(): Promise<string[]> {
    try {
      const entries = await readdir(this.layout.sessions, { withFileTypes: true })
      return entries.filter(entry => entry.isDirectory() && isTaskingId(entry.name)).map(entry => entry.name).sort()
    } catch (error) {
      if (isNotFound(error)) return []
      throw error
    }
  }
}

/**
 * Validate a feedback submission against the deliverable it names and build
 * the entry (new id). The kernel writes it as the `feedback` record that opens
 * the feedback turn; the turn's user message is `renderFeedbackPrompt(entry)`.
 * @throws `tool/invalid-input` for a bad rating or comment; `workspace/not-found`
 *   when the deliverable version does not exist.
 */
export async function createFeedbackEntry(input: SubmitFeedbackInput, deliverables: DeliverableStore): Promise<FeedbackEntry> {
  if (input.rating !== undefined && !(Number.isInteger(input.rating) && input.rating >= 1 && input.rating <= 5)) {
    throw new NexgentError('tool/invalid-input', `rating must be an integer from 1 to 5, got ${String(input.rating)}`, { details: { field: 'rating' } })
  }
  if (typeof input.comment !== 'string') throw new NexgentError('tool/invalid-input', 'comment must be a string', { details: { field: 'comment' } })
  if (input.rating === undefined && input.comment.trim() === '') {
    throw new NexgentError('tool/invalid-input', 'feedback needs a rating or a comment', { details: { field: 'comment' } })
  }
  const version = await deliverables.get(input.deliverableId, input.version)
  if (version === undefined) {
    throw new NexgentError('workspace/not-found', `deliverable ${input.deliverableId} has no version ${input.version}`, { details: { deliverableId: input.deliverableId, version: input.version } })
  }
  return {
    id: newId(),
    deliverableId: input.deliverableId,
    version: input.version,
    ...(input.rating === undefined ? {} : { rating: input.rating as FeedbackRating }),
    comment: input.comment,
  }
}

/** Options of {@link SessionGoalStore}. */
export interface SessionGoalStoreOptions {
  readonly now?: () => Date
}

/** Goals through session records; the current goal comes from the projection (`SessionMetadata.goal`). */
export class SessionGoalStore implements GoalStore {
  private readonly now: () => Date

  constructor(private readonly sessions: SessionStore, options: SessionGoalStoreOptions = {}) {
    this.now = options.now ?? (() => new Date())
  }

  /**
   * Projects the records read with `readAll`. Deliberately not `resume`: a
   * store that holds the session's lock closes an open turn as interrupted
   * on `resume`, which must not happen while the agent is mid-turn.
   */
  async get(sessionId: string): Promise<Goal | undefined> {
    const { records } = await this.sessions.readAll(sessionId)
    if (records.length === 0) return undefined
    return projectSession(records).metadata.goal
  }

  async set(sink: HostRecordSink, text: string): Promise<Goal> {
    const trimmed = text.trim()
    if (trimmed === '') throw new NexgentError('tool/invalid-input', 'goal text must not be empty', { details: { field: 'text' } })
    const at = this.now().toISOString()
    const goal: Goal = { id: newId(), text: trimmed, status: 'active', setAt: at, updatedAt: at }
    await sink({ type: 'goal.set', goal })
    return goal
  }

  async update(
    sink: HostRecordSink,
    sessionId: string,
    change: { readonly status: GoalStatus; readonly text?: string; readonly note?: string },
  ): Promise<Goal> {
    if (!GOAL_STATUSES.includes(change.status)) {
      throw new NexgentError('tool/invalid-input', `goal status must be one of ${GOAL_STATUSES.join(', ')}`, { details: { field: 'status' } })
    }
    const text = change.text?.trim()
    if (text === '') throw new NexgentError('tool/invalid-input', 'goal text must not be empty', { details: { field: 'text' } })
    const current = await this.get(sessionId)
    if (current === undefined) throw new NexgentError('session/invalid-record', `session ${sessionId} has no goal to update`, { details: { sessionId } })
    const record = await sink({
      type: 'goal.update',
      goalId: current.id,
      status: change.status,
      ...(text === undefined ? {} : { text }),
      ...(change.note === undefined ? {} : { note: change.note }),
    })
    const { note: previousNote, ...rest } = current
    const note = change.note ?? previousNote
    return { ...rest, status: change.status, text: text ?? current.text, updatedAt: record.ts, ...(note === undefined ? {} : { note }) }
  }
}

/** Context provider id of the goal (agent-hooks.md: order workspace-instructions, goal, skills, materials). */
export const GOAL_PROVIDER_ID = 'goal'

/** Render the `# Current goal` section body. Pure. */
export function renderGoalSection(goal: Goal): string {
  return [
    goal.text,
    '',
    'This goal persists across turns and restarts. Work toward it; when it is reached, say so plainly in your reply.',
  ].join('\n')
}

/**
 * The goal provider: while the session's goal is `active`, the goal is
 * injected before the turn's user message whenever the history the model
 * sees does not already carry it (first turn after it is set or changed,
 * and again after a compaction). It is not a system-prompt section, so a
 * goal change does not invalidate the cached prompt prefix (K2). Reads the
 * goal from the turn's state (no I/O).
 */
export function goalContextProvider(): ContextProvider {
  return {
    id: GOAL_PROVIDER_ID,
    async beginTurn(input: TurnContextInput): Promise<ContextContribution> {
      const goal = input.state.metadata.goal
      if (goal === undefined || goal.status !== 'active') return {}
      const text = renderGoalInjection(goal)
      if (input.state.messages.some(message => message.role === 'user' && message.content === text)) return {}
      return { inject: [text] }
    },
  }
}

/** The injected goal message. Pure. */
export function renderGoalInjection(goal: Goal): string {
  return `# Current goal\n${renderGoalSection(goal)}`
}
