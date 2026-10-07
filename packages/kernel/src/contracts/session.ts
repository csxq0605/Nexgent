/**
 * The session contract: the JSONL v1 record set written under
 * `.nexgent/sessions/<id>/session.jsonl`, the state a session projects to,
 * and the store that appends, recovers and locks it.
 *
 * The normative description (field tables, append/truncation rule, recovery
 * algorithm, lock file) is `docs/spec/data-formats.md` §会话 JSONL v1; this
 * file is its type-level mirror. Only v1 exists; there is no migration.
 */
import type { ErrorInfo } from './errors.js'
import type { JsonValue } from './json.js'
import type { FinishReason, LLMMessage, LLMUsage, ToolCall } from './llm.js'

/** The only session format version. */
export const SESSION_FORMAT_VERSION = 1

/** Fields every record carries. `seq` starts at 1 and increases by exactly 1 per record. */
export interface SessionRecordBase {
  /** Record kind. */
  readonly type: string
  /** 1-based position in the file; the recovery cursor. */
  readonly seq: number
  /** ISO-8601 UTC instant the record was appended. */
  readonly ts: string
  /** The session the record belongs to; repeated so a line is self-describing. */
  readonly sessionId: string
}

/** First record of every file (seq 1). Identifies the session and the format. */
export interface SessionStartRecord extends SessionRecordBase {
  readonly type: 'session.start'
  /** Always {@link SESSION_FORMAT_VERSION}. */
  readonly version: 1
  /** Absolute workspace root the session was created in. */
  readonly projectRoot: string
  /** Model id the session was started with. */
  readonly model: string
  /** Session this one continues from (step 3 fork); absent for a root session. */
  readonly parentSessionId?: string
  /** Human-readable title when one was given. */
  readonly title?: string
}

/** A user-role message entering the conversation. */
export interface UserMessageRecord extends SessionRecordBase {
  readonly type: 'user.message'
  /** Turn the message opened or was injected into. */
  readonly turn: number
  /** Plain text. */
  readonly content: string
  /** `'user'` for a human prompt; `'inject'` for synthetic context presented as the user. */
  readonly source: 'user' | 'inject'
}

/** The assistant's reply for one step: text plus tool calls plus the request's accounting. */
export interface AssistantMessageRecord extends SessionRecordBase {
  readonly type: 'assistant.message'
  readonly turn: number
  /** 1-based model call within the turn. */
  readonly step: number
  /** The {@link LLMRequest.requestId} that produced it; joins to the ledger. */
  readonly requestId: string
  /** Visible text streamed so far (complete, or the delivered prefix when `interrupted`). */
  readonly content: string
  /** Tool calls the model completed; absent when none. */
  readonly toolCalls?: readonly ToolCall[]
  /** Reported usage, or all-`'unknown'` when the provider sent none. */
  readonly usage: LLMUsage
  /** How the stream ended. */
  readonly finishReason: FinishReason
  /** Set when the turn was cancelled mid-stream; `content` is then a prefix and `toolCalls` is absent. */
  readonly interrupted?: true
}

/** The outcome of one tool call, as returned to the model. */
export interface ToolResultRecord extends SessionRecordBase {
  readonly type: 'tool.result'
  readonly turn: number
  readonly step: number
  /** The {@link ToolCall.id} answered. */
  readonly toolCallId: string
  /** Tool name. */
  readonly name: string
  /** Model-facing content. */
  readonly content: string
  /** Whether the call failed. */
  readonly isError: boolean
  /** Structured failure identity; only when `isError`. */
  readonly error?: ErrorInfo
  /** Tool-private presentation payload. */
  readonly meta?: JsonValue
  /** Wall-clock duration of the handler in ms. */
  readonly durationMs: number
}

/** Opens turn `turn`. A turn is one user message plus every model call and tool call it triggers. */
export interface TurnStartRecord extends SessionRecordBase {
  readonly type: 'turn.start'
  readonly turn: number
}

/** Who or what cancelled a turn. */
export type TurnCancelCause = 'user' | 'timeout' | 'shutdown' | 'cost-cap'

/** Why a turn ended. */
export type TurnEndReason =
  | { readonly kind: 'completed' }
  | { readonly kind: 'cancelled'; readonly cause: TurnCancelCause }
  | { readonly kind: 'error'; readonly error: ErrorInfo }
  | { readonly kind: 'max-tokens' }
  /** Written by resume for a turn the previous process never closed (crash). */
  | { readonly kind: 'interrupted' }

/** Closes turn `turn`. */
export interface TurnEndRecord extends SessionRecordBase {
  readonly type: 'turn.end'
  readonly turn: number
  readonly reason: TurnEndReason
}

/** A full state snapshot; resume starts from the latest one and replays records with `seq > coversSeq`. */
export interface CheckpointRecord extends SessionRecordBase {
  readonly type: 'checkpoint'
  /** The last `seq` folded into `state`. */
  readonly coversSeq: number
  /** Complete projected state as of `coversSeq`. */
  readonly state: SessionState
}

/** A failure worth keeping that is not already a `turn.end`/`tool.result` error (e.g. ledger write failure). */
export interface ErrorRecord extends SessionRecordBase {
  readonly type: 'error'
  /** Turn the error occurred in, when inside one. */
  readonly turn?: number
  readonly error: ErrorInfo
  /** Whether the session can continue after it. */
  readonly fatal: boolean
}

/** Every v1 record kind. */
export type SessionRecord =
  | SessionStartRecord
  | UserMessageRecord
  | AssistantMessageRecord
  | ToolResultRecord
  | TurnStartRecord
  | TurnEndRecord
  | CheckpointRecord
  | ErrorRecord

/** The `type` tag vocabulary. */
export type SessionRecordType = SessionRecord['type']

/** All record types, for schema and exhaustiveness tests. */
export const SESSION_RECORD_TYPES: readonly SessionRecordType[] = [
  'session.start',
  'user.message',
  'assistant.message',
  'tool.result',
  'turn.start',
  'turn.end',
  'checkpoint',
  'error',
]

/** Distributive omit over a union. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** What a caller passes to `append`: a record minus the fields the store assigns. */
export type SessionRecordInput = DistributiveOmit<SessionRecord, 'seq' | 'ts' | 'sessionId'>

/** Session facts that are not conversation messages. */
export interface SessionMetadata {
  /** From `session.start`. */
  readonly createdAt: string
  /** From `session.start`. */
  readonly projectRoot: string
  /** From `session.start`. */
  readonly model: string
  /** Title when set. */
  readonly title?: string
  /** Number of the last turn opened; 0 before the first. */
  readonly lastTurn: number
  /** Turn currently open (a `turn.start` without `turn.end`), if any. */
  readonly openTurn?: number
  /** Usage summed over every `assistant.message` folded in (`'unknown'` fields propagate). */
  readonly totalUsage: LLMUsage
  /** Last record `seq` folded into this state. */
  readonly lastSeq: number
}

/** What a session projects to: the LLM-visible history plus metadata. The system prompt is not stored. */
export interface SessionState {
  readonly sessionId: string
  readonly version: 1
  /** Conversation in request form (user / assistant / tool). */
  readonly messages: readonly Exclude<LLMMessage, { role: 'system' }>[]
  readonly metadata: SessionMetadata
}

/** Arguments for creating a session. */
export interface SessionInit {
  /** Caller-chosen id (uuid); must not exist yet. */
  readonly sessionId: string
  readonly projectRoot: string
  readonly model: string
  readonly parentSessionId?: string
  readonly title?: string
}

/** Where recovery stopped, when the file had a bad tail. */
export interface SessionTruncation {
  /** 1-based line number of the first invalid line. */
  readonly line: number
  /** Byte offset of that line's start; the store truncates here before the next append. */
  readonly byteOffset: number
  /** Why the line was rejected. */
  readonly reason: string
}

/** The result of reading a whole file. */
export interface SessionReadResult {
  /** Every valid record, in `seq` order. */
  readonly records: readonly SessionRecord[]
  /** Present when the file had an invalid tail; records after it are discarded. */
  readonly truncation?: SessionTruncation
}

/** Contents of `sessions/<id>/.lock`; a single-writer lease. */
export interface SessionLockFile {
  /** Owning process id. */
  readonly pid: number
  /** ISO-8601 instant the lock was taken. */
  readonly ts: string
  /** Host name, so a stale lock from another machine is recognizable on shared disks. */
  readonly host: string
}

/** A held lock; release through the store. */
export interface SessionLock {
  readonly sessionId: string
  /** Absolute path of the lock file. */
  readonly path: string
  readonly info: SessionLockFile
}

/** The `ctx.session` persistence service. All methods reject with `session/*` codes. */
export interface SessionStore {
  /** Create the directory, take the lock and write `session.start`. Rejects `session/exists`. */
  create(init: SessionInit): Promise<SessionLock>
  /** Append one record, assigning `seq`, `ts` and `sessionId`. Requires the lock; rejects `session/locked` otherwise. */
  append(sessionId: string, record: SessionRecordInput): Promise<SessionRecord>
  /** Read every valid record, stopping at the first invalid line. */
  readAll(sessionId: string): Promise<SessionReadResult>
  /** The latest checkpoint record, or `undefined` when none was written. */
  latestCheckpoint(sessionId: string): Promise<CheckpointRecord | undefined>
  /** Project the session to a resumable state: latest checkpoint plus replay of the records after it. */
  resume(sessionId: string): Promise<SessionState>
  /** Take the single-writer lock. Rejects `session/locked` when another live process holds it. */
  lock(sessionId: string): Promise<SessionLock>
  /** Release a lock taken by `create` or `lock`. */
  release(lock: SessionLock): Promise<void>
}
