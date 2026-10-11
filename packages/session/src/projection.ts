/**
 * Session projection: fold records into the {@link SessionState} an agent
 * resumes from, and the checkpoint policy that decides when that state is
 * snapshotted into the file.
 *
 * Normative table: `docs/spec/data-formats.md` §恢复算法（`resume`）投影规则
 * and §checkpoint. The same fold drives `resume`, checkpoint creation and the
 * writer's in-memory state, so a checkpoint's `state` always equals the
 * projection from the start of the file.
 *
 * Design reference: deepseek-harness@46a7f68b `session/session-projection`
 * (pure synchronous fold over committed events) and
 * `session/session-checkpoint-policy` (checkpoint at semantic boundaries).
 */
import {
  addUsage,
  NexgentError,
  ZERO_USAGE,
  type AssistantMessage,
  type SessionMetadata,
  type SessionRecord,
  type SessionStartRecord,
  type SessionState,
} from '@nexgent/kernel'

/** Default number of records written between checkpoints. */
export const DEFAULT_CHECKPOINT_EVERY = 50

type ConversationMessage = SessionState['messages'][number]

/** Mutable working copy of a state, used while folding many records. */
interface Draft {
  sessionId: string
  messages: ConversationMessage[]
  metadata: { -readonly [K in keyof SessionMetadata]: SessionMetadata[K] }
}

/**
 * The state right after `session.start` (seq 1): metadata only, no messages.
 * @param start - the file's first record.
 */
export function initialState(start: SessionStartRecord): SessionState {
  const metadata: Draft['metadata'] = {
    createdAt: start.ts,
    projectRoot: start.projectRoot,
    model: start.model,
    sandboxMode: start.sandboxMode,
    grants: [],
    lastTurn: 0,
    totalUsage: ZERO_USAGE,
    lastSeq: start.seq,
  }
  if (start.title !== undefined) metadata.title = start.title
  return { sessionId: start.sessionId, version: 1, messages: [], metadata: { ...metadata } }
}

/**
 * Fold one record into a state, returning a new state (inputs are not mutated).
 * `session.start` must not be folded; start from {@link initialState} instead.
 * @throws {NexgentError} `session/invalid-record` for a `session.start` or a foreign session id.
 */
export function foldRecord(state: SessionState, record: SessionRecord): SessionState {
  const draft = toDraft(state)
  applyRecord(draft, record)
  return fromDraft(draft)
}

/**
 * Project a whole record list (starting with `session.start`, or with a
 * `checkpoint` as the first relevant record) into a state.
 * @param records - records in `seq` order; the first must be `session.start`.
 * @throws {NexgentError} `session/corrupt` when the list does not start with `session.start`.
 */
export function projectSession(records: readonly SessionRecord[]): SessionState {
  const first = records[0]
  if (first?.type !== 'session.start') {
    throw new NexgentError('session/corrupt', 'a session must start with a session.start record')
  }
  return replay(initialState(first), records, 1).state
}

/** The outcome of {@link replay}. */
export interface ReplayResult {
  readonly state: SessionState
  /** How many records were folded. */
  readonly folded: number
}

/**
 * Fold `records.slice(from)` into `state` with one mutable draft (linear time).
 * @param from - index of the first record to fold.
 */
export function replay(state: SessionState, records: readonly SessionRecord[], from = 0): ReplayResult {
  const draft = toDraft(state)
  let folded = 0
  for (let index = from; index < records.length; index += 1) {
    applyRecord(draft, records[index] as SessionRecord)
    folded += 1
  }
  return { state: fromDraft(draft), folded }
}

/**
 * An incremental projector: folds records one at a time in amortized O(1)
 * and snapshots on demand. The store keeps one per locked session.
 */
export class SessionProjector {
  private draft: Draft

  constructor(state: SessionState) {
    this.draft = toDraft(state)
  }

  /** Fold one record. */
  apply(record: SessionRecord): void {
    applyRecord(this.draft, record)
  }

  /** `lastSeq` of the state so far. */
  get lastSeq(): number {
    return this.draft.metadata.lastSeq
  }

  /** Turn currently open, if any. */
  get openTurn(): number | undefined {
    return this.draft.metadata.openTurn
  }

  /** An immutable copy of the current state. */
  snapshot(): SessionState {
    const state = fromDraft(this.draft)
    return { ...state, messages: [...state.messages] }
  }
}

function applyRecord(draft: Draft, record: SessionRecord): void {
  if (record.sessionId !== draft.sessionId) {
    throw new NexgentError('session/invalid-record', `record of session ${record.sessionId} folded into ${draft.sessionId}`)
  }
  const meta = draft.metadata
  switch (record.type) {
    case 'session.start':
      throw new NexgentError('session/invalid-record', 'session.start can only be the first record')
    case 'turn.start':
      meta.lastTurn = record.turn
      meta.openTurn = record.turn
      break
    case 'user.message':
      draft.messages.push({ role: 'user', content: record.content })
      break
    case 'assistant.message': {
      if (!(record.interrupted === true && record.content === '')) {
        const message: AssistantMessage = {
          role: 'assistant',
          content: record.content,
          ...(record.toolCalls === undefined ? {} : { toolCalls: record.toolCalls }),
          ...(record.providerContent === undefined ? {} : { providerContent: record.providerContent }),
        }
        draft.messages.push(message)
      }
      meta.totalUsage = addUsage(meta.totalUsage, record.usage)
      break
    }
    case 'tool.result':
      draft.messages.push({
        role: 'tool',
        toolCallId: record.toolCallId,
        name: record.name,
        content: record.content,
        isError: record.isError,
      })
      break
    case 'turn.end':
      delete meta.openTurn
      break
    case 'checkpoint': {
      const next = toDraft(record.state)
      draft.messages = next.messages
      draft.metadata = next.metadata
      break
    }
    case 'approval.grant':
      meta.grants = [...meta.grants, record.grant]
      break
    case 'error':
    case 'approval.request':
    case 'approval.decision':
      break
  }
  draft.metadata.lastSeq = record.seq
}

function toDraft(state: SessionState): Draft {
  return { sessionId: state.sessionId, messages: [...state.messages], metadata: { ...state.metadata } }
}

function fromDraft(draft: Draft): SessionState {
  return { sessionId: draft.sessionId, version: 1, messages: draft.messages, metadata: { ...draft.metadata } }
}

/**
 * Checkpoint policy (spec §checkpoint): after appending a `turn.end`, write a
 * checkpoint when at least `every` records were written since the previous
 * checkpoint (or the file head).
 * @param record - the record just appended.
 * @param lastCheckpointSeq - `seq` of the latest checkpoint record, or 0 when none.
 * @param every - threshold N (default 50).
 */
export function shouldCheckpoint(
  record: Pick<SessionRecord, 'type' | 'seq'>,
  lastCheckpointSeq: number,
  every: number = DEFAULT_CHECKPOINT_EVERY,
): boolean {
  return record.type === 'turn.end' && record.seq - lastCheckpointSeq >= every
}
