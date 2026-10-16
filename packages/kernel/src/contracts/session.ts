/**
 * The session contract: the JSONL v1 record set written under
 * `.nexgent/sessions/<id>/session.jsonl`, the state a session projects to,
 * and the store that appends, recovers and locks it.
 *
 * The normative description (field tables, append/truncation rule, recovery
 * algorithm, lock file) is `docs/spec/data-formats.md` §会话 JSONL v1; this
 * file is its type-level mirror. Only v1 exists; there is no migration.
 */
import { NexgentError, type ErrorInfo } from './errors.js'
import type { JsonValue } from './json.js'
import type { ApprovalDecision, ApprovalGrant, ApprovalRequest } from './approvals.js'
import type { CapabilityComponentRef, CapabilityFile, CapabilityVersion, CapabilityVersionSwitchReason, ComponentUseProof } from './capabilities.js'
import type { FinishReason, LLMMessage, LLMUsage, RefusalInfo, ToolCall } from './llm.js'
import type { MemberExecutionForm, MemberIdentity, MemberResult, DelegationMode, TeamMember, TeamMessage, TeamTask, WorkflowStatus } from './collaboration.js'
import type { ComparisonArm, ImprovementPhase } from './improvement.js'
import type { ImproverScope, ImproverVersion } from './improver.js'
import type { DeliverableVersionRef, FeedbackEntry, FileChange, Goal, GoalStatus, MaterialRef } from './tasking.js'
import type { SandboxMode } from './workspace.js'

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
  /** Sandbox mode in effect; `resume` keeps it unless the host passes `--sandbox` again. */
  readonly sandboxMode: SandboxMode
  /** The session that started this one as a member (step 3 child session); absent for a root session. */
  readonly parentSessionId?: string
  /** Human-readable title when one was given. */
  readonly title?: string
  /** Who this child session is (step 3); present exactly when `parentSessionId` is. */
  readonly member?: MemberIdentity
  /** Step 4: capability bundle the session runs on (`baseline` or a content hash); absent in sessions written before step 4. */
  readonly capabilityVersion?: CapabilityVersion
  /** Step 5: `improvement` for an improvement job's session (hidden from the conversation list); absent means `task`. */
  readonly purpose?: SessionPurpose
  /** Step 5: which job and phase; present exactly when `purpose` is `improvement`. */
  readonly improvement?: SessionImprovement
}

/** What a session is for (step 5). */
export type SessionPurpose = 'task' | 'improvement'

/** Every purpose. */
export const SESSION_PURPOSES: readonly SessionPurpose[] = ['task', 'improvement']

/** The job an improvement session belongs to. The trial phase opens no improvement session (replays are ordinary trial runs). */
export interface SessionImprovement {
  readonly jobId: string
  /** Step 6 adds `meta-diagnose` and `meta-propose`. */
  readonly phase: Exclude<ImprovementPhase, 'trial'>
  /** Step 6: the improver version the job pinned (absent: `v0`). */
  readonly improverVersion?: ImproverVersion
  /** ADR 0012: where `improverVersion` lives: `user` from the rework on; absent (= `project`) before. */
  readonly improverScope?: ImproverScope
  /** Step 6: the meta job, when the session belongs to a comparison arm's job (in the arm's copy). */
  readonly metaJobId?: string
  /** Step 6: which arm; present exactly when `metaJobId` is. */
  readonly comparisonArm?: ComparisonArm
}

/** A user-role message entering the conversation. */
export interface UserMessageRecord extends SessionRecordBase {
  readonly type: 'user.message'
  /** Turn the message opened or was injected into. */
  readonly turn: number
  /** Plain text. */
  readonly content: string
  /**
   * `'user'` for a human prompt; `'inject'` for synthetic context presented as
   * the user (hidden in the UI); `'feedback'` for the prompt a feedback turn
   * opens with (step 2: it follows that turn's `feedback` record).
   */
  readonly source: UserMessageSource
  /** Ids of the materials the user attached to this message (step 2, optional); the reference text itself is an `inject` message. */
  readonly materials?: readonly string[]
}

/** Who produced a {@link UserMessageRecord}. */
export type UserMessageSource = 'user' | 'inject' | 'feedback'

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
  /** Verbatim provider blocks replayed on resume; see `AssistantMessage.providerContent`. */
  readonly providerContent?: JsonValue
  /** Present when `finishReason` is `'refusal'`. */
  readonly refusal?: RefusalInfo
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
export type TurnCancelCause = 'user' | 'timeout' | 'shutdown' | 'cost-cap' | 'parent' | 'step-limit'

/**
 * Every {@link TurnCancelCause}; `parent` (step 3): the parent session's turn
 * was cancelled or ended; `step-limit` (ADR 0021): the turn made its
 * `maxSteps` model calls; the history is intact and the next user message
 * continues the task.
 */
export const TURN_CANCEL_CAUSES: readonly TurnCancelCause[] = ['user', 'timeout', 'shutdown', 'cost-cap', 'parent', 'step-limit']

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

/** An approval question was raised for a tool call (mirrors the ledger's `tool.call.approval`). */
export interface ApprovalRequestRecord extends SessionRecordBase {
  readonly type: 'approval.request'
  readonly turn: number
  readonly request: ApprovalRequest
}

/** The answer to an {@link ApprovalRequestRecord}. */
export interface ApprovalDecisionRecord extends SessionRecordBase {
  readonly type: 'approval.decision'
  readonly turn: number
  readonly decision: ApprovalDecision
}

/** A `session`-scope grant; survives `resume`. Written right after the deciding `approval.decision`. */
export interface ApprovalGrantRecord extends SessionRecordBase {
  readonly type: 'approval.grant'
  readonly grant: ApprovalGrant
}

// ---------------------------------------------------------------------------
// Step 2 records (appended within v1; files written by step 1 stay readable)
// ---------------------------------------------------------------------------

/**
 * A material was copied into `.nexgent/materials/<id>/` on behalf of this
 * session. Written by the host (SDK) when it adds the material, outside a
 * turn or inside one; `materials/<id>/material.json` stays the source of
 * truth for the material's state (removal changes only that file).
 */
export interface MaterialAddedRecord extends SessionRecordBase {
  readonly type: 'material.added'
  /** Turn in progress when it was added; absent between turns. */
  readonly turn?: number
  readonly material: MaterialRef
}

/**
 * A `present` tool call produced a deliverable version. Appended by the tool
 * through {@link ToolContext.appendRecord} before that call's `tool.result`.
 */
export interface DeliverablePresentedRecord extends SessionRecordBase {
  readonly type: 'deliverable.presented'
  readonly turn: number
  readonly step: number
  /** The `present` call that produced it. */
  readonly toolCallId: string
  readonly deliverable: DeliverableVersionRef
}

/**
 * Files the turn added, modified or deleted (tool `meta` plus a before/after
 * scan of the project, `.nexgent/` and `node_modules/` excluded). Written
 * right before `turn.end` whenever a file tracker is installed, also when the
 * list is empty; never written for a turn the process died in.
 */
export interface TurnFilesRecord extends SessionRecordBase {
  readonly type: 'turn.files'
  readonly turn: number
  /** Sorted by `path`; at most {@link TURN_FILES_LIMIT} entries. */
  readonly changes: readonly FileChange[]
  /** How many further changes were dropped beyond the limit. */
  readonly omitted?: number
}

/** Max entries one `turn.files` record lists. */
export const TURN_FILES_LIMIT = 1000

/**
 * The user rated / commented on a deliverable version. Opens a feedback turn:
 * the order is `turn.start` → `feedback` → `user.message { source: 'feedback' }`.
 */
export interface FeedbackRecord extends SessionRecordBase {
  readonly type: 'feedback'
  readonly turn: number
  readonly feedback: FeedbackEntry
}

/** A persistent goal was set for the session; it replaces any previous goal. */
export interface GoalSetRecord extends SessionRecordBase {
  readonly type: 'goal.set'
  /** Turn in progress, if any. */
  readonly turn?: number
  readonly goal: Goal
}

/** The current goal changed status (or its text was edited). */
export interface GoalUpdateRecord extends SessionRecordBase {
  readonly type: 'goal.update'
  readonly turn?: number
  /** Must equal the current goal's id; otherwise the record is invalid for projection. */
  readonly goalId: string
  readonly status: GoalStatus
  /** New text, when edited. */
  readonly text?: string
  /** Why (e.g. the model's or user's note on completion). */
  readonly note?: string
}

/** The session was renamed by the user (step 2); the latest one wins over `session.start.title`. */
export interface SessionTitleRecord extends SessionRecordBase {
  readonly type: 'session.title'
  /** Turn in progress, if any. */
  readonly turn?: number
  /** New title; non-empty, already trimmed by the host. */
  readonly title: string
}

/**
 * Older history was replaced by a summary. Projection: `messages` becomes
 * `[{ role: 'user', content: renderCompactionSummary(summary) }]` followed by
 * the last `keepMessages` messages ({@link compactionTail}). The kept tail
 * starts with a `user` message (a turn or injection boundary) or, when the
 * compaction split the current turn (ADR 0021), with an `assistant` reply of
 * that turn, never with a tool result, so no tool call is separated from its
 * result. Every assistant reply, summarized or kept, loses its
 * `providerContent` (thinking blocks are not replayed across a compaction).
 */
export interface CompactionRecord extends SessionRecordBase {
  readonly type: 'compaction'
  /** Turn in progress when the compaction ran (it runs before a model call). */
  readonly turn: number
  /** The step whose request will be the first to use the compacted history. */
  readonly step: number
  /** Summary text produced by the compaction request. */
  readonly summary: string
  /** Messages kept verbatim after the summary (≥ 1). */
  readonly keepMessages: number
  /** Messages folded into the summary (the previous summary counts as one). */
  readonly compactedMessages: number
  /** The auxiliary model request that produced the summary; joins to the ledger. */
  readonly requestId: string
  /** Usage of that request. */
  readonly usage: LLMUsage
  /** What triggered it: the last reported input size and the threshold it crossed. */
  readonly trigger: { readonly inputTokens: number; readonly threshold: number }
}

/** Wrapper the projection puts around a compaction summary. Pure; the exact text is part of the contract. */
export function renderCompactionSummary(summary: string): string {
  return `<conversation-summary>\nThe earlier part of this conversation was compacted. Summary:\n\n${summary}\n</conversation-summary>`
}

/**
 * The messages a compaction keeps, as the projection and the loop both build
 * them: the last `keepMessages`, which start at a turn boundary (`user`) or,
 * when the compaction split the current turn, at one of its replies
 * (`assistant`, ADR 0021), never at a tool result. Kept replies lose their
 * `providerContent`: their thinking blocks were bound to the history before
 * the summary and would no longer verify, so they are sent as text and tool
 * calls only. Pure.
 * @throws `session/invalid-record` when the count is out of range or the tail starts with a tool result.
 */
export function compactionTail<M extends Exclude<LLMMessage, { role: 'system' }>>(messages: readonly M[], keepMessages: number): M[] {
  if (!Number.isInteger(keepMessages) || keepMessages < 1 || keepMessages > messages.length) {
    throw new NexgentError('session/invalid-record', `compaction keeps ${String(keepMessages)} of ${messages.length} messages`)
  }
  const tail = messages.slice(messages.length - keepMessages)
  if (tail[0]!.role === 'tool') throw new NexgentError('session/invalid-record', 'compaction tail must not start with a tool result')
  return tail.map(message => {
    if (message.role !== 'assistant' || message.providerContent === undefined) return message
    const { providerContent: _dropped, ...rest } = message
    return rest as M
  })
}

// ---------------------------------------------------------------------------
// Step 3 records (appended within v1): child sessions, team, workflow
// ---------------------------------------------------------------------------

/**
 * A forked child's starting history: the parent's projected messages up to
 * the end of its last completed turn (from its latest compaction on). Written
 * by the kernel as seq 2 of the child file, right after `session.start`;
 * projection replaces the (empty) message list with `messages`.
 */
export interface ForkSeedRecord extends SessionRecordBase {
  readonly type: 'fork.seed'
  readonly fromSessionId: string
  /** Last parent `seq` the copied history covers. */
  readonly throughSeq: number
  readonly messages: readonly Exclude<LLMMessage, { role: 'system' }>[]
}

/**
 * In the parent: a member run began (a delegate call, a teammate activation,
 * a workflow `agent()`). A run is one turn of the child session; a teammate
 * has one run per Lead turn it works in.
 */
export interface SubagentStartRecord extends SessionRecordBase {
  readonly type: 'subagent.start'
  /** Parent turn. */
  readonly turn: number
  /** The parent tool call that started it (delegate / spawn_teammate / workflow). */
  readonly toolCallId?: string
  readonly childSessionId: string
  /** The child turn this run is. */
  readonly childTurn: number
  readonly name: string
  readonly executionForm: MemberExecutionForm
  /** Delegation only. */
  readonly mode?: DelegationMode
  readonly preset?: string
  /** Workflow member: the workflow it belongs to. */
  readonly workflowId?: string
  /** First 500 characters of the task text the member was given. */
  readonly task: string
  readonly materialIds?: readonly string[]
}

/** In the parent: the member run settled (also written on recovery with status `interrupted`). */
export interface SubagentEndRecord extends SessionRecordBase {
  readonly type: 'subagent.end'
  readonly turn: number
  readonly childSessionId: string
  readonly childTurn: number
  readonly result: MemberResult
}

/** In the Lead: a roster change (spawned, idle, stopped); the latest per `member.name` wins. */
export interface TeamMemberRecord extends SessionRecordBase {
  readonly type: 'team.member'
  readonly turn?: number
  readonly member: TeamMember
}

/** In the Lead: a task board entry was created or changed; the latest per `task.id` wins. */
export interface TeamTaskRecord extends SessionRecordBase {
  readonly type: 'team.task'
  readonly turn?: number
  readonly task: TeamTask
}

/** In the Lead: a mailbox message was queued or delivered. */
export interface TeamMessageRecord extends SessionRecordBase {
  readonly type: 'team.message'
  readonly turn?: number
  readonly message: TeamMessage
}

/** In the parent: a `workflow` tool call started a script or a graph. */
export interface WorkflowStartRecord extends SessionRecordBase {
  readonly type: 'workflow.start'
  readonly turn: number
  readonly toolCallId: string
  /** Lowercase uuid v4. */
  readonly workflowId: string
  readonly kind: 'script' | 'graph'
  /** Graph runs: the saved graph's SHA-256 (`.nexgent/architectures/<hash>.json`). */
  readonly architecture?: string
  readonly title?: string
}

/** In the parent: the script called `phase(name)`. */
export interface WorkflowPhaseRecord extends SessionRecordBase {
  readonly type: 'workflow.phase'
  readonly turn: number
  readonly workflowId: string
  readonly phase: string
}

/** In the parent: the workflow settled (also written on recovery with status `interrupted`). */
export interface WorkflowEndRecord extends SessionRecordBase {
  readonly type: 'workflow.end'
  readonly turn: number
  readonly workflowId: string
  readonly status: WorkflowStatus
  /** Child sessions it started. */
  readonly members: number
  readonly error?: ErrorInfo
}

/**
 * Step 4, host-written: the session switched capability version (on resume
 * the recorded version was unavailable, or loading failed at open). The
 * session runs on `version` from here on.
 */
export interface CapabilityVersionRecord extends SessionRecordBase {
  readonly type: 'capability.version'
  readonly turn?: number
  readonly version: CapabilityVersion
  readonly previous: CapabilityVersion
  readonly reason: CapabilityVersionSwitchReason
  /** Short diagnostic (e.g. which file failed verification); never file contents. */
  readonly detail?: string
}

/** Step 4, written by `capability_draft`: a draft component was created or changed in the session's draft area. */
export interface CapabilityDraftRecord extends SessionRecordBase {
  readonly type: 'capability.draft'
  readonly turn: number
  readonly step: number
  readonly toolCallId: string
  readonly component: CapabilityComponentRef
  /** The draft component's files after the change, sorted by path. */
  readonly files: readonly CapabilityFile[]
  /** 1 for the first draft of this component in the session, then +1 per change. */
  readonly revision: number
}

/** Step 4, written by `capability_try`: a draft component was loaded into this session's scope. */
export interface CapabilityTryRecord extends SessionRecordBase {
  readonly type: 'capability.try'
  readonly turn: number
  readonly step: number
  readonly toolCallId: string
  readonly component: CapabilityComponentRef
  /** Draft revision that was loaded. */
  readonly revision: number
  /** Model tools the component added to the session (function modules, plugins). */
  readonly tools?: readonly string[]
}

/** Step 4, written by `capability_propose` when the host accepts a candidate. */
export interface CapabilityProposeRecord extends SessionRecordBase {
  readonly type: 'capability.propose'
  readonly turn: number
  readonly step: number
  readonly toolCallId: string
  readonly candidateId: string
  readonly proofs: readonly ComponentUseProof[]
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
  | ApprovalRequestRecord
  | ApprovalDecisionRecord
  | ApprovalGrantRecord
  | MaterialAddedRecord
  | DeliverablePresentedRecord
  | TurnFilesRecord
  | FeedbackRecord
  | GoalSetRecord
  | GoalUpdateRecord
  | SessionTitleRecord
  | CompactionRecord
  | ForkSeedRecord
  | SubagentStartRecord
  | SubagentEndRecord
  | TeamMemberRecord
  | TeamTaskRecord
  | TeamMessageRecord
  | WorkflowStartRecord
  | WorkflowPhaseRecord
  | WorkflowEndRecord
  | CapabilityVersionRecord
  | CapabilityDraftRecord
  | CapabilityTryRecord
  | CapabilityProposeRecord

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
  'approval.request',
  'approval.decision',
  'approval.grant',
  'material.added',
  'deliverable.presented',
  'turn.files',
  'feedback',
  'goal.set',
  'goal.update',
  'session.title',
  'compaction',
  'fork.seed',
  'subagent.start',
  'subagent.end',
  'team.member',
  'team.task',
  'team.message',
  'workflow.start',
  'workflow.phase',
  'workflow.end',
  'capability.version',
  'capability.draft',
  'capability.try',
  'capability.propose',
]

/**
 * Record types a host (SDK, or a collaboration package acting for the
 * parent outside one of its tool calls, e.g. recovery or teammate mail) may
 * append through the agent that holds the lock.
 */
export type HostRecordType =
  | 'material.added'
  | 'goal.set'
  | 'goal.update'
  | 'session.title'
  | 'subagent.end'
  | 'team.member'
  | 'team.task'
  | 'team.message'
  | 'workflow.phase'
  | 'workflow.end'
  | 'capability.version'

/** Record types a tool may append through {@link ToolContext.appendRecord}. */
export type ToolRecordType =
  | 'deliverable.presented'
  | 'subagent.start'
  | 'subagent.end'
  | 'team.member'
  | 'team.task'
  | 'team.message'
  | 'workflow.start'
  | 'workflow.phase'
  | 'workflow.end'
  | 'capability.draft'
  | 'capability.try'
  | 'capability.propose'

/** Distributive omit over a union. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** What a caller passes to `append`: a record minus the fields the store assigns. */
export type SessionRecordInput = DistributiveOmit<SessionRecord, 'seq' | 'ts' | 'sessionId'>

/** A record a host may append between or during turns. */
export type HostRecordInput = Extract<SessionRecordInput, { readonly type: HostRecordType }>

/** A record a tool may append during its call. */
export type ToolRecordInput = Extract<SessionRecordInput, { readonly type: ToolRecordType }>

/** Session facts that are not conversation messages. */
export interface SessionMetadata {
  /** From `session.start`. */
  readonly createdAt: string
  /** From `session.start`. */
  readonly projectRoot: string
  /** From `session.start`. */
  readonly model: string
  /** From `session.start`. */
  readonly sandboxMode: SandboxMode
  /** `session`-scope approval grants from `approval.grant` records, in order. */
  readonly grants: readonly ApprovalGrant[]
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
  /** The session's current goal, from the latest `goal.set` and later `goal.update`s (step 2). */
  readonly goal?: Goal
  /** `seq` of the latest `compaction` folded in (step 2). */
  readonly lastCompactionSeq?: number
  /**
   * Usage of the latest `assistant.message` after the latest compaction whose
   * billed input is known (ADR 0021): the compaction trigger's starting point
   * when an agent is reopened. Absent before the first such reply.
   */
  readonly lastUsage?: LLMUsage
  /** From `session.start` (step 3 child session). */
  readonly parentSessionId?: string
  /** From `session.start` (step 3 child session). */
  readonly member?: MemberIdentity
  /** Step 4: from `session.start`, then the latest `capability.version`. */
  readonly capabilityVersion?: CapabilityVersion
  /** Step 5: from `session.start`. */
  readonly purpose?: SessionPurpose
  /** Step 5: from `session.start`. */
  readonly improvement?: SessionImprovement
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
  readonly sandboxMode: SandboxMode
  readonly parentSessionId?: string
  readonly title?: string
  /** Required with `parentSessionId` (step 3). */
  readonly member?: MemberIdentity
  /** Step 4: written into `session.start.capabilityVersion`. */
  readonly capabilityVersion?: CapabilityVersion
  /** Step 5: written into `session.start`; `improvement` is required when `purpose` is `improvement`, refused otherwise. */
  readonly purpose?: SessionPurpose
  readonly improvement?: SessionImprovement
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
