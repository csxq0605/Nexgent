/**
 * One agent = one open session plus the loop that runs its turns.
 *
 * A turn writes `turn.start` and `user.message`, then alternates model
 * requests (`assistant.message`) and tool calls (`tool.result`, preceded by
 * `approval.*` records when policy asks) until the model stops, then writes
 * `turn.end` and, per the checkpoint policy, a `checkpoint`. Ledger
 * `tool.call` records are written per call and one `task.outcome` per task
 * (an agent's lifetime: one `run` or one `resume` in CLI terms).
 *
 * The control flow follows DSH `core/agent-loop` (stream → assemble tool
 * calls → dispatch → loop) rewritten against the Nexgent contracts.
 */
import { randomUUID } from 'node:crypto'
import * as nodePath from 'node:path'
import { performance } from 'node:perf_hooks'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import type {
  ApprovalBroker,
  ApprovalDecision,
  ApprovalGrant,
  ApprovalRequest,
  ApprovalRisk,
  ApprovalScope,
  ToolApprovalAsk,
  ToolCallApproval,
} from './contracts/approvals.js'
import { BASELINE_VERSION, CAPABILITY_COMPONENT_KINDS, type CapabilityComponentKind, type CapabilityVersion, type ComponentUsage, type TaskCheckSpec } from './contracts/capabilities.js'
import { COLLABORATION_LIMITS, type AgentAttribution, type BudgetShare, type ExecutionForm, type MemberIdentity, type WorkdirMerge } from './contracts/collaboration.js'
import { DEFAULT_CHECK_RETRIES, type CostCap, type CostCapScope, type ProjectConfig } from './contracts/config.js'
import type { CompactionCheckInput, ContextService, SystemPromptSection } from './contracts/context.js'
import { NexgentError, toErrorInfo, type ErrorInfo, type NexgentErrorCode } from './contracts/errors.js'
import { isJsonValue, type JsonValue } from './contracts/json.js'
import type { Ledger, LedgerAttribution, LedgerRecordInput, TaskCheck, TaskOutcomeStatus } from './contracts/ledger.js'
import {
  addUsage,
  UNKNOWN_USAGE,
  ZERO_USAGE,
  type Effort,
  type FinishReason,
  type LLMCompleteOptions,
  type LLMMessage,
  type LLMProvider,
  type LLMRequest,
  type LLMStreamEvent,
  type LLMUsage,
  type RefusalInfo,
  type ToolCall,
  type ToolResult,
} from './contracts/llm.js'
import {
  compactionTail,
  renderCompactionSummary,
  TURN_FILES_LIMIT,
  type HostRecordInput,
  type HostRecordType,
  type SessionLock,
  type SessionRecord,
  type SessionRecordInput,
  type SessionState,
  type SessionStore,
  type ToolRecordInput,
  type ToolRecordType,
  type TurnCancelCause,
  type TurnEndReason,
} from './contracts/session.js'
import { renderFeedbackPrompt, type FeedbackEntry, type TaskingService, type TurnFileTracker } from './contracts/tasking.js'
import { isConcurrentTool, scheduleToolCalls, type Tool, type ToolContext, type ToolDefinition, type ToolOutput, type ToolRegistry } from './contracts/tools.js'
import { normalizeWorkspacePath, type SandboxMode, type Workspace } from './contracts/workspace.js'
import { AgentEventHub, type AgentEvent, type AgentEventListener } from './agent-events.js'
import { CHECK_COMMAND_ID_PREFIX, type AttachedComponent, type CapabilityHost, type CheckCommandRun, type ComponentUseRef, type HandbookTurnSelection, type ImprovementRun, type ImprovementSignals, type MemberWorkdir, type TaskRecorder, type TurnOrganizer } from './capability-hooks.js'
import type { OrganizationDecision, OrganizationShape, OrganizationUse } from './contracts/organization.js'
import {
  approvalSubject,
  decideToolPolicy,
  derivePattern,
  grantMatches,
  type ApprovalSubject,
} from './approval-policy.js'
import { validateJsonSchema } from './json-schema.js'
import { exitPlanTool } from './plan-mode.js'
import { renderSystemPrompt, type SystemPromptTemplate } from './system-prompt.js'
import type { TaskTree } from './task-tree.js'
import { addSpend, capStatus, errorMetric, errorScope, subtractSpend, usageUsd, warningKey, zeroSpend, type CapStatus, type CostWarning, type Spend } from './cost-caps.js'
import { abortPromise, deadline, timeoutOf, TimeoutReason } from './util/timeout.js'

/** Timeout code of the kernel's whole-request model deadline. */
export const MODEL_TIMEOUT = 'MODEL_TIMEOUT'
/** Timeout code of the kernel's stream-idle watchdog. */
export const MODEL_IDLE_TIMEOUT = 'MODEL_IDLE_TIMEOUT'
/** Timeout code of a tool's declared `timeoutMs`. */
export const TOOL_TIMEOUT = 'TOOL_TIMEOUT'

/** ADR 0017 decision 5: at most this many calls of one step run at once. */
export const MAX_CONCURRENT_CALLS = 8

const DELEGATE_TOOL_NAME = 'delegate'

/** One executed call, before its records are written. */
interface ToolRun {
  readonly tool: Tool | undefined
  readonly output: { content: string; isError: boolean; error?: ErrorInfo; meta?: JsonValue }
  readonly approval: ToolCallApproval
  readonly durationMs: number
}

/** A small FIFO concurrency limit. */
class Limit {
  private active = 0
  private readonly waiting: Array<() => void> = []
  constructor(private readonly max: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>(resolve => this.waiting.push(resolve))
    this.active += 1
    try {
      return await task()
    } finally {
      this.active -= 1
      this.waiting.shift()?.()
    }
  }
}
/** Upper bound on `TurnFileTracker.endTurn` after a cancelled turn (`agent-hooks.md` §失败语义). */
export const FILES_END_CANCEL_MS = 5_000
/** Record types {@link Agent.appendHostRecord} accepts (the contract's `HostRecordType`). */
export const HOST_RECORD_TYPES: readonly HostRecordType[] = [
  'material.added',
  'goal.set',
  'goal.update',
  'session.title',
  'subagent.end',
  'team.member',
  'team.task',
  'team.message',
  'workflow.phase',
  'workflow.end',
  'capability.version',
  'turn.rewind',
]
/** Record types a tool may append through {@link KernelToolContext.appendRecord} (the contract's `ToolRecordType`). */
export const TOOL_RECORD_TYPES: readonly ToolRecordType[] = [
  'deliverable.presented',
  'subagent.start',
  'subagent.end',
  'team.member',
  'team.task',
  'team.message',
  'workflow.start',
  'workflow.phase',
  'workflow.end',
  'organization',
  'capability.draft',
  'capability.try',
  'capability.propose',
]
/** Host record types that may carry an earlier turn between turns (closing a run a dead process left open, `data-formats.md` §子会话与成员). */
const RECOVERY_RECORD_TYPES: readonly HostRecordType[] = ['subagent.end', 'workflow.end']
/** Upper bound on the task checks run at the end of a root turn (step 4). */
export const CHECKS_TIMEOUT_MS = 300_000
/** `costCaps.perProject.windowDays` when the config leaves it out (`data-formats.md` §项目配置). */
export const DEFAULT_PROJECT_WINDOW_DAYS = 30

/** Loop settings, from the `agents` profile row. */
export interface AgentSettings {
  readonly thinking: 'off' | 'on'
  /** Effort level sent on every request (ADR 0002). */
  readonly effort: Effort
  readonly maxTokens?: number
  readonly systemPrompt: SystemPromptTemplate
  /** Whole-request model deadline in ms; 0 disables. */
  readonly modelTimeoutMs: number
  /** Max silence between stream events in ms; 0 disables. */
  readonly streamIdleTimeoutMs: number
  /** Max model calls in one turn; past it the turn ends with cancel cause `step-limit` (ADR 0021). */
  readonly maxSteps: number
  /** Max consecutive `pause` replies the loop continues before ending the turn with an error. */
  readonly maxPauseContinuations: number
  /** Max consecutive replies cut by the output cap the loop continues before ending the turn with `max-tokens`; default {@link DEFAULT_MAX_OUTPUT_CONTINUATIONS}. */
  readonly maxOutputContinuations?: number
  /** Write a checkpoint at `turn.end` once this many records accumulated since the last one; 0 disables. */
  readonly checkpointEvery: number
  /** How long to wait for a cancelled tool handler to settle before moving on, in ms. */
  readonly toolAbortGraceMs: number
}

/** Persists a `project`-scope grant (to `.nexgent/config.json.approvals`); supplied by the host. */
export type ProjectGrantWriter = (grant: ApprovalGrant, context: { readonly sessionId: string; readonly projectRoot: string }) => Promise<void>

/** A per-call approval request a tool may raise through its context (see {@link KernelToolContext}). */
export type { ToolApprovalAsk } from './contracts/approvals.js'

/**
 * The context the kernel passes to tool handlers: the contract's
 * {@link ToolContext} plus `requestApproval`, which a tool calls when its
 * own policy escalates one call (blacklisted command, sensitive file). It
 * resolves `true` when the call may proceed; the decision is recorded in
 * the session and in the ledger's `tool.call.approval`.
 */
export interface KernelToolContext extends ToolContext {
  /** `true` when the loop already obtained approval for this call (an `ask` / `always` tool). */
  readonly approved: boolean
  /** Step (model call) of the turn whose reply made this call; records appended through `appendRecord` carry it. */
  readonly step: number
  requestApproval(ask: ToolApprovalAsk): Promise<boolean>
  /**
   * Append a tool record ({@link TOOL_RECORD_TYPES}) before this call's
   * `tool.result`. A record carries this call's `turn` (stamped when an
   * optional `turn` is left out) and, where its type has them, this call's
   * `step` and `toolCallId`. Rejects with `session/invalid-record` when the
   * type is not a tool record type, when `turn` / `step` / `toolCallId` are
   * not this call's, or after the call settled; a rejected or failed append
   * ends the call as `tool/failed` even if the handler catches it.
   */
  appendRecord(record: ToolRecordInput): Promise<void>
  /** Step 3: the calling session's task-tree attribution (always set by the kernel). */
  readonly attribution: AgentAttribution
}

/**
 * The input of one turn (`agent-hooks.md` §宿主接口). A plain string is a
 * user turn without materials.
 */
export type TurnInput =
  | {
    readonly source?: 'user'
    readonly text: string
    /** Material ids attached to the message (`user.message.materials`). */
    readonly materialIds?: readonly string[]
  }
  | {
    /** A feedback turn: `feedback` is recorded after `turn.start`; the message text is `renderFeedbackPrompt(feedback)`. */
    readonly source: 'feedback'
    readonly feedback: FeedbackEntry
    readonly materialIds?: readonly string[]
  }

/** What one `run` returns. */
export interface TurnResult {
  readonly sessionId: string
  readonly turn: number
  readonly reason: TurnEndReason
  /** Text of the last assistant message of the turn (the prefix when interrupted). */
  readonly text: string
  /** Usage summed over the turn's requests. */
  readonly usage: LLMUsage
  /** Rework K4 D4: a member with its own copy of the project: what merging it back did. */
  readonly merge?: WorkdirMerge
}

/** Options of {@link Agent.run}. */
export interface RunOptions {
  /** External cancellation; aborting it cancels the turn with cause `user`. */
  readonly signal?: AbortSignal
}

/** Options of {@link Agent.close}. */
export interface CloseOptions {
  /** Override the derived task status. */
  readonly status?: TaskOutcomeStatus
  /** Deterministic checks the host ran. */
  readonly checks?: readonly TaskCheck[]
  /** Skip the `task.outcome` record (e.g. the host writes its own). */
  readonly skipOutcome?: boolean
}

/** Running totals of the current task. */
export interface TaskStats {
  readonly requestCount: number
  readonly toolCallCount: number
  readonly turns: number
  readonly totalUsage: LLMUsage
  /** `inputTokens + outputTokens` over requests that reported them. */
  readonly tokens: number
  readonly toolsUsed: readonly string[]
}

/** Everything an agent needs, resolved by `ctx.agents`. */
export interface AgentInit {
  readonly sessionId: string
  /**
   * Optional step-2 services, read at each turn start (so a service that
   * appears or goes away between turns is picked up). Absent: the turn runs
   * exactly as in step 1.
   */
  readonly services?: () => {
    readonly context?: ContextService | undefined
    readonly tasking?: TaskingService | undefined
    /** Step 4: component lookup for `componentsUsed` (`componentOf`). */
    readonly capabilityHost?: CapabilityHost | undefined
    /** Step 4: root-task snapshot and checks. */
    readonly taskRecorder?: TaskRecorder | undefined
    /** Step 5: the improvement queue failed checks are signalled to. */
    readonly improve?: ImprovementSignals | undefined
    /** Rework K4 D4: members' own copies of the project (only whether it is there is read per turn). */
    readonly workdirs?: unknown
    /** New direction step 2: whether members help with a root turn. */
    readonly organizer?: TurnOrganizer | undefined
  }
  readonly lock: SessionLock
  /** The agent's scoped context (tools registered through it are agent-private). */
  readonly ctx: Context
  readonly fiber: Fiber
  readonly llm: LLMProvider
  readonly session: SessionStore
  readonly ledger: Ledger
  readonly workspace: Workspace
  readonly approvals: ApprovalBroker & { readonly timeoutMs?: number | undefined }
  readonly tools: ToolRegistry
  readonly model: string
  readonly thinking: 'off' | 'on'
  readonly effort: Effort
  readonly sandboxMode: SandboxMode
  /** ADR 0022: start (or resume) in plan mode. */
  readonly plan?: boolean
  readonly settings: AgentSettings
  readonly projectConfig: ProjectConfig
  readonly history: readonly Exclude<LLMMessage, { role: 'system' }>[]
  readonly lastTurn: number
  readonly lastSeq: number
  readonly lastCheckpointSeq: number
  /** Usage of the history's latest reply (`SessionMetadata.lastUsage`), for the compaction trigger. */
  readonly lastUsage?: LLMUsage
  readonly sessionGrants: readonly ApprovalGrant[]
  readonly projectGrantWriter: () => ProjectGrantWriter | undefined
  readonly onClose: (agent: Agent) => void
  /**
   * Step 3: the task tree this agent belongs to (a root agent mints one when
   * it opens; members share their parent's). Its `projectGrants` are the
   * grants in force for the whole tree.
   */
  readonly tree: TaskTree
  /** Step 3: what the agent stamps on its ledger records and tool contexts. */
  readonly attribution: AgentAttribution
  /** Step 3: set for a child session; its parent is {@link AgentInit.parentSessionId}. */
  readonly member?: MemberIdentity
  readonly parentSessionId?: string
  /** Step 3: a member's own share of the tree's cost cap. */
  readonly budget?: BudgetShare
  /** Step 3: the open members this agent started (cancelled with `parent` when its turn ends). */
  readonly children?: () => readonly Agent[]
  /**
   * Step 4: the capability version the session runs on (stamped on every
   * ledger record); absent when no capability host is installed.
   */
  readonly capabilityVersion?: CapabilityVersion
  /** Step 4: components the capability host loaded into this session's scope. */
  readonly attached?: readonly AttachedComponent[]
  /** Step 5: the improvement job this session works for (stamped on every ledger record). */
  readonly improvement?: ImprovementRun
  /** Rework K4 D4: a member's own copy of the project; its tools work there. */
  readonly workdir?: MemberWorkdir
}

/** Rework K4 D4: the project as a member with its own copy sees it: paths resolve against the copy, data stays the project's. */
function workdirView(project: Workspace, root: string): Workspace {
  return {
    root,
    layout: project.layout,
    resolve: input => normalizeWorkspacePath(root, input),
    relative: absolute => {
      const rel = nodePath.relative(root, absolute)
      return rel === '' ? '.' : rel
    },
    sessionDir: sessionId => project.sessionDir(sessionId),
    ensureLayout: () => project.ensureLayout(),
  }
}

/** `componentsUsed` order: manifest kind order, then name, then version. */
function sortUsage(usage: Iterable<ComponentUsage>): ComponentUsage[] {
  const rank = (kind: CapabilityComponentKind) => CAPABILITY_COMPONENT_KINDS.indexOf(kind)
  return [...usage].sort((a, b) =>
    rank(a.kind) - rank(b.kind) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || (a.version < b.version ? -1 : a.version > b.version ? 1 : 0))
}

/** Abort reason carrying who cancelled the turn. */
export class TurnAbort extends Error {
  override name = 'TurnAbort'

  constructor(readonly turnCause: TurnCancelCause) {
    super(`turn cancelled (${turnCause})`)
  }
}

function causeOf(signal: AbortSignal): TurnCancelCause {
  const reason: unknown = signal.reason
  return reason instanceof TurnAbort ? reason.turnCause : 'user'
}

function errorInfo(code: NexgentErrorCode, message: string, details?: Record<string, unknown>): ErrorInfo {
  return toErrorInfo(new NexgentError(code, message, details === undefined ? {} : { details }))
}

/** The `llm/refused` error of a reply the provider's classifier declined. */
function refusalError(refusal: RefusalInfo | undefined): ErrorInfo {
  const category = refusal?.category
  const explanation = refusal?.explanation
  const message = `the model refused the request${category === undefined ? '' : ` (${category})`}${explanation === undefined ? '' : `: ${explanation}`}`
  return errorInfo('llm/refused', message, {
    ...(category === undefined ? {} : { category }),
    ...(explanation === undefined ? {} : { explanation }),
  })
}

function knownTokens(usage: LLMUsage): number {
  return (typeof usage.inputTokens === 'number' ? usage.inputTokens : 0)
    + (typeof usage.outputTokens === 'number' ? usage.outputTokens : 0)
}

/**
 * Make history safe to send: every assistant tool call gets a tool message
 * (a crash between `assistant.message` and its `tool.result`s leaves calls
 * unanswered, which endpoints reject). Request-only; the session is not
 * changed, and assistant entries (including their `providerContent`) are
 * passed through untouched.
 */
export function repairHistory(messages: readonly Exclude<LLMMessage, { role: 'system' }>[]): Exclude<LLMMessage, { role: 'system' }>[] {
  const out: Exclude<LLMMessage, { role: 'system' }>[] = []
  let pending: ToolCall[] = []
  const flush = () => {
    for (const call of pending) {
      out.push({ role: 'tool', toolCallId: call.id, name: call.name, content: 'Error: the call was interrupted before it returned a result.', isError: true })
    }
    pending = []
  }
  for (const message of messages) {
    if (message.role === 'tool') {
      pending = pending.filter(call => call.id !== message.toolCallId)
      out.push(message)
      continue
    }
    flush()
    out.push(message)
    if (message.role === 'assistant' && message.toolCalls !== undefined) pending = [...message.toolCalls]
  }
  flush()
  return out
}

/**
 * The `tool_use` blocks of a reply's provider content (Claude wire shape),
 * as tool calls. Used for a reply cut by the output cap, whose last call may
 * be in the content without a completed stream event. Pure.
 */
export function providerToolUses(providerContent: JsonValue | undefined): ToolCall[] {
  if (!Array.isArray(providerContent)) return []
  const calls: ToolCall[] = []
  for (const block of providerContent) {
    if (block === null || typeof block !== 'object' || Array.isArray(block)) continue
    if (block['type'] !== 'tool_use' || typeof block['id'] !== 'string' || typeof block['name'] !== 'string') continue
    calls.push({ id: block['id'], name: block['name'], arguments: JSON.stringify(block['input'] ?? {}) })
  }
  return calls
}

interface StreamOutcome {
  readonly requestId: string
  readonly content: string
  readonly toolCalls: readonly ToolCall[]
  readonly usage: LLMUsage
  readonly finish: Exclude<FinishReason, 'error'> | 'error'
  readonly error?: ErrorInfo
  /** Verbatim provider blocks from `done`, replayed on later requests. */
  readonly providerContent?: JsonValue
  /** Set with `finish: 'refusal'`. */
  readonly refusal?: RefusalInfo
}

/** What a {@link StepInjector} is told about the request about to be made. */
export interface StepInjectionInput {
  readonly sessionId: string
  readonly turn: number
  /** The step whose model request follows (1 = the turn's first request). */
  readonly step: number
  readonly signal: AbortSignal
}

/**
 * Called before each model request of a running turn (see
 * {@link Agent.beforeRequest}); each returned text is written as
 * `user.message { source: 'inject' }` and sent with that request.
 */
export type StepInjector = (input: StepInjectionInput) => readonly string[] | Promise<readonly string[]>

interface Authorization {
  readonly allowed: boolean
  readonly approval: ToolCallApproval
  readonly cancelled: boolean
}

/** How much longer than the provider's stream idle deadline the loop waits before giving up on the stream itself. */
const IDLE_GRACE_MS = 15_000

/** Default model calls per turn (`agents.maxSteps`; ADR 0021). */
export const DEFAULT_MAX_STEPS = 400

/** Default consecutive replies cut by the output cap that the loop continues on its own (ADR 0021). */
export const DEFAULT_MAX_OUTPUT_CONTINUATIONS = 3

/** Sent with the last model call a turn may make (`maxSteps` ≥ 4), so the model wraps up instead of being cut off. */
export function stepLimitNote(limit: number): string {
  return `[Nexgent] This is the last model call this turn may make (limit ${limit}). Do not start new work. `
    + 'Reply to the user now: what is done, what remains, and that sending another message continues the task.'
}

/** One message of the user, for {@link renderUserWords}. */
export interface UserWords {
  readonly turn: number
  readonly text: string
}

/** At most this many characters of the user's own words are kept through a compaction (newest first). */
export const USER_WORDS_MAX_CHARS = 60_000

/** Heads the section of the user's own words a compaction appends to its summary. */
export const USER_WORDS_HEADING = "## The user's own words (verbatim, oldest first)"

/**
 * The section a compaction appends to its summary: the user's messages word
 * for word, oldest first. When they exceed {@link USER_WORDS_MAX_CHARS} the
 * newest are kept (the oldest kept one may be cut at its start). Empty when
 * there are none.
 */
export function renderUserWords(words: readonly UserWords[], maxChars = USER_WORDS_MAX_CHARS): string {
  const picked: UserWords[] = []
  let left = maxChars
  let dropped = 0
  for (let index = words.length - 1; index >= 0; index -= 1) {
    const entry = words[index]!
    if (left <= 0) {
      dropped += 1
      continue
    }
    picked.unshift(entry.text.length <= left ? entry : { turn: entry.turn, text: `…${entry.text.slice(entry.text.length - left)}` })
    left -= entry.text.length
  }
  if (picked.length === 0) return ''
  const lines = [
    '',
    '',
    USER_WORDS_HEADING,
    ...(dropped > 0 ? [`(${dropped} older message${dropped === 1 ? '' : 's'} left out for length.)`] : []),
    ...picked.map(entry => `\n[turn ${entry.turn}]\n${entry.text}`),
  ]
  return lines.join('\n')
}

/** Added to a failed-checks retry note when the turn's work was done by an organization of members (new direction step 2). */
export const REORGANIZE_AFTER_CHECKS_NOTE = 'Members did part of this work. If the failure comes from how the work was split or handed over, '
  + 'call `organize` again with a reason and a changed organization (for example add a `test` or `review` role, give one member the other\'s findings, or merge parts that depend on each other); otherwise fix it yourself.'

/** Opens a message the user sent to the main conversation while a member was working ({@link Agent.steer}). */
export const RELAYED_USER_NOTE_PREFIX = '[Nexgent] The user said this in the main conversation while you were working; follow it where it concerns your work:'

/** The note a working member gets for a message the user sent meanwhile. */
export function relayedUserNote(text: string): string {
  return `${RELAYED_USER_NOTE_PREFIX}\n\n${text}`
}

/** Redesign 3.2: a project check command may run this long (the shell tool's own cap still applies). */
export const CHECK_COMMAND_TIMEOUT_MS = 300_000

/** Redesign 3.2: this much of a failing project check command's output goes into the retry note. */
export const CHECK_OUTPUT_TAIL_CHARS = 600

/** Redesign 3.2: the note a check retry sends is at most this long. */
export const CHECK_RETRY_NOTE_MAX_CHARS = 2_000

/** First words of a check-retry note (hosts and learning can tell it from other injected notes). */
export const CHECK_RETRY_NOTE_PREFIX = '[Nexgent] Automatic check'

/**
 * Redesign 3.2: the note that sends the model back after a deterministic
 * check of its turn failed (cut to {@link CHECK_RETRY_NOTE_MAX_CHARS}).
 */
export function renderCheckRetryNote(failed: readonly { readonly spec: TaskCheckSpec; readonly result: TaskCheck; readonly output?: string }[], attempt: number, max: number): string {
  const lines = failed.map(({ spec, result, output }) => {
    const what = spec.name === 'test-command'
      ? `${spec.id.startsWith(CHECK_COMMAND_ID_PREFIX) ? 'project check command' : 'test command'} \`${spec.command}\``
      : spec.name === 'parses' ? `${spec.path} parses as ${spec.format}` : `${spec.path} exists`
    const tail = output === undefined || output.trim() === '' ? '' : `\n  last output:\n${output.trimEnd().split('\n').map(line => `    ${line}`).join('\n')}`
    return `- ${what}: failed${result.detail === undefined ? '' : ` (${result.detail})`}${tail}`
  })
  const text = `${CHECK_RETRY_NOTE_PREFIX} (retry ${attempt} of ${max}): these checks of your work in this turn failed:\n${lines.join('\n')}\n`
    + 'Find the cause and fix it, run the failing test command again (or present the file again), then reply. '
    + 'If a check cannot pass, say why in your reply instead of trying again.'
  return text.length <= CHECK_RETRY_NOTE_MAX_CHARS ? text : `${text.slice(0, CHECK_RETRY_NOTE_MAX_CHARS - 1)}…`
}

/** Sent after a text-only reply was cut by the output cap. */
export const OUTPUT_CUT_NOTE = '[Nexgent] Your previous reply was cut off by the output length limit. '
  + 'Continue exactly where it stopped, without repeating what was already written.'

/** Sent after a reply with tool calls was cut by the output cap; its calls were not run. */
export const OUTPUT_CUT_TOOLS_NOTE = '[Nexgent] Your previous reply was cut off by the output length limit, so its tool calls were not run. '
  + 'Continue the task with smaller tool inputs: split large file contents into several smaller writes or edits.'

/** The tool result of a call whose reply was cut by the output cap. */
export const OUTPUT_CUT_TOOL_RESULT = 'Error: not run. The reply hit the output length limit while writing this call, so its input may be incomplete. '
  + 'Issue it again with smaller input (split large file contents into several smaller writes or edits).'

/** A live agent bound to one locked session. Created by `ctx.agents.create` / `resume`. */
export class Agent {
  /** The session id; also the agent id. */
  readonly sessionId: string
  /** The agent's scoped Cordis context: `agent.ctx.tools.register()` adds agent-private tools. */
  readonly ctx: Context
  /** Model id requests use. */
  readonly model: string
  /** Step 3: task-tree attribution stamped on every ledger record this agent writes. */
  readonly attribution: AgentAttribution
  /** Step 3: who this child session is; absent for a root session. */
  readonly member: MemberIdentity | undefined
  /** Step 3: the root session that started this member; absent for a root session. */
  readonly parentSessionId: string | undefined
  /** Step 4: the capability version this session runs on; absent without a capability host. */
  readonly capabilityVersion: CapabilityVersion | undefined
  /** Step 5: the improvement job this session works for; absent for an ordinary task session. */
  readonly improvement: ImprovementRun | undefined

  private readonly init: AgentInit
  private readonly hub = new AgentEventHub()
  /** The mode the session executes in once plan mode is off (ADR 0022). */
  private mode: SandboxMode
  /** Plan mode (ADR 0022 decision 4): tools act as in `read-only` until a plan is approved. */
  private planning: boolean
  /** Unregisters `exit_plan` from this agent's scope while plan mode is on. */
  private planTool: (() => void) | undefined
  private readonly messages: Exclude<LLMMessage, { role: 'system' }>[]
  private readonly sessionGrants: ApprovalGrant[]
  private lastTurn: number
  private lastSeq: number
  private lastCheckpointSeq: number
  private running: { controller: AbortController; done: Promise<unknown> } | undefined
  private closed = false
  private outcomeWritten = false
  private lastReason: TurnEndReason | undefined
  private budgetError: ErrorInfo | undefined
  /** `perProject` usage read from the ledger at turn start, and this task's totals at that moment. */
  private projectUsage: { requests: number; tokens: number; usd: number; estimated: boolean; ownRequests: number; ownTokens: number; ownUsd: number } | undefined
  private turnDenials = new Set<string>()
  /** Approval questions run one at a time, also when calls of one step run concurrently (ADR 0017 decision 5). */
  private approvalQueue: Promise<unknown> = Promise.resolve()
  /** Provider sections of the running turn, in render order; empty between turns. */
  private turnSections: readonly SystemPromptSection[] = []
  /** Whether the project had materials at the running turn's start (the "Working with files" materials line). */
  private turnMaterials = false
  /** Usage of the latest model request of this agent (the compaction trigger reads it). */
  private lastUsage: LLMUsage | undefined
  /** Turn in progress, for host records. */
  private openTurn: number | undefined
  /** The running turn's file tracker, once `beginTurn` succeeded. */
  private turnFiles: TurnFileTracker | undefined
  /** The running turn's snapshot, until the first tool call waits for it (see {@link beginTaskRecord}). */
  private snapshotPending: Promise<unknown> | undefined
  /** The turn's snapshot, not started yet: it starts once the first request is out ({@link startSnapshot}). */
  private snapshotStart: (() => Promise<unknown>) | undefined
  /** Per-request injectors (see {@link beforeRequest}). */
  private readonly injectors = new Set<StepInjector>()
  /** Messages sent while the turn runs ({@link steer}), waiting for the next model request. */
  private pendingSteers: { readonly content: string; readonly source: 'user' | 'inject' }[] = []
  /** Whether {@link steer} still reaches the running turn (false once it is finishing). */
  private acceptingSteers = false
  /** New direction step 2: how the current (or last) root turn is organized, for `task.outcome.organization`. */
  private turnOrganization: { decision?: OrganizationDecision; section?: SystemPromptSection; name?: OrganizationUse['name']; roles?: number; shape?: OrganizationShape; organizations: number; corrections: number } = { organizations: 0, corrections: 0 }
  /** Rework K4 D4: where this agent's tools work (a member's own copy, else the project). */
  private readonly workspace: Workspace
  /** Work that keeps the running turn open (see {@link holdTurn}). */
  private readonly holds = new Set<Promise<unknown>>()
  /** The history as of the end of the last completed turn, for a fork (see {@link forkSeed}). */
  private settledHistory: { readonly messages: readonly Exclude<LLMMessage, { role: 'system' }>[]; readonly throughSeq: number }
  /** Step 4: components loaded into this session (adopted, then tried drafts), by how their use is recognised. */
  private readonly components = {
    tools: new Map<string, ComponentUseRef>(),
    skills: new Map<string, ComponentUseRef>(),
    presets: new Map<string, ComponentUseRef>(),
  }
  /** Step 4: `componentsUsed` tallies keyed by kind, name and version, since the agent opened and in the current turn. */
  private readonly componentUse = { task: new Map<string, ComponentUsage>(), turn: new Map<string, ComponentUsage>() }
  /** Step 4: results of the root task's checks, run at the end of each root turn. */
  private lastChecks: readonly TaskCheck[] | undefined
  /**
   * Redesign 3.2: the checks {@link checkRetryNote} ran after the model's
   * last reply, with what the tree had done by then; the turn-end checks
   * reuse them when the model made no request since (one recorder call per turn without a retry).
   */
  private retryChecks: { readonly results: readonly TaskCheck[]; readonly step: number } | undefined
  /** Redesign 3.2: the retry note just sent (its checks are the `before` of the next `check.retry` ledger pair). */
  private pendingRetry: { readonly retry: number; readonly max: number; readonly before: readonly TaskCheck[] } | undefined
  /** Redesign 3.2: a call that may change the project succeeded in the running root turn (the project's check commands run only then). */
  private turnActed = false
  /** The last model step of the running turn ({@link loop} goes on from it after a check retry). */
  private turnStep = 0
  private stats = {
    requestCount: 0,
    toolCallCount: 0,
    turns: 0,
    totalUsage: ZERO_USAGE as LLMUsage,
    tokens: 0,
    /** Rework D3: estimated USD of this agent's requests (the dollar caps). */
    usd: 0,
    toolsUsed: new Set<string>(),
  }

  constructor(init: AgentInit) {
    this.init = init
    this.sessionId = init.sessionId
    this.ctx = init.ctx
    this.model = init.model
    this.mode = init.sandboxMode
    this.planning = init.plan === true
    if (this.planning) this.offerExitPlan()
    this.attribution = init.attribution
    this.member = init.member
    this.parentSessionId = init.parentSessionId
    this.capabilityVersion = init.capabilityVersion
    this.improvement = init.improvement
    if (init.capabilityVersion !== undefined) {
      for (const component of init.attached ?? []) this.loadComponent(component, init.capabilityVersion)
    }
    this.messages = [...init.history]
    this.sessionGrants = [...init.sessionGrants]
    this.settledHistory = { messages: [...init.history], throughSeq: init.lastSeq }
    this.lastTurn = init.lastTurn
    this.lastSeq = init.lastSeq
    this.lastCheckpointSeq = init.lastCheckpointSeq
    this.lastUsage = init.lastUsage
    this.workspace = init.workdir === undefined ? init.workspace : workdirView(init.workspace, init.workdir.root)
  }

  /** Rework K4 D4: the directory this agent's tools work in: a member's own copy of the project, else the project root. */
  get workingDirectory(): string {
    return this.workspace.root
  }

  /** The sandbox mode tools run under now: `read-only` while plan mode is on (ADR 0022), else the session's mode. */
  get sandboxMode(): SandboxMode {
    return this.planning ? 'read-only' : this.mode
  }

  /** The mode the session executes in once plan mode is off. */
  get executionMode(): SandboxMode {
    return this.mode
  }

  /** Whether plan mode is on. */
  get plan(): boolean {
    return this.planning
  }

  /**
   * Switch the session's mode (ADR 0022 decision 4): writes `session.mode`
   * and takes effect from the next tool call. For the host (the user's own
   * switch in the app or CLI); the model leaves plan mode only through
   * `exit_plan`'s approval.
   */
  async setMode(change: { readonly sandboxMode?: SandboxMode; readonly plan?: boolean }, reason: 'host' | 'plan-approved' = 'host'): Promise<void> {
    if (this.closed) throw new NexgentError('session/locked', `session ${this.sessionId} is closed`)
    const sandboxMode = change.sandboxMode ?? this.mode
    const plan = change.plan ?? this.planning
    await this.append({ type: 'session.mode', sandboxMode, plan, reason })
    this.mode = sandboxMode
    if (plan && !this.planning) this.offerExitPlan()
    if (!plan && this.planning) {
      this.planTool?.()
      this.planTool = undefined
    }
    this.planning = plan
  }

  private offerExitPlan(): void {
    if (this.planTool !== undefined) return
    this.planTool = this.init.tools.register(exitPlanTool(async () => {
      await this.setMode({ plan: false }, 'plan-approved')
      return this.mode
    }))
  }

  /** Whether a turn is in progress. */
  get busy(): boolean {
    return this.running !== undefined
  }

  /** Whether {@link close} ran. */
  get isClosed(): boolean {
    return this.closed
  }

  /** Number of the last turn opened. */
  get turn(): number {
    return this.lastTurn
  }

  /** The conversation as the next request will see it (without the system prompt). */
  history(): readonly Exclude<LLMMessage, { role: 'system' }>[] {
    return [...this.messages]
  }

  /** `session`-scope grants in force. */
  grants(): readonly ApprovalGrant[] {
    return [...this.sessionGrants]
  }

  /** Totals of the current task. */
  taskStats(): TaskStats {
    return {
      requestCount: this.stats.requestCount,
      toolCallCount: this.stats.toolCallCount,
      turns: this.stats.turns,
      totalUsage: this.stats.totalUsage,
      tokens: this.stats.tokens,
      toolsUsed: [...this.stats.toolsUsed],
    }
  }

  /**
   * Step 3: forms the task tree used so far, in `EXECUTION_FORMS` order; the
   * root's `task.outcome` carries it as `formsUsed`.
   */
  formsUsed(): readonly ExecutionForm[] {
    return this.init.tree.formsUsed()
  }

  /**
   * Step 3: the history a forked member starts from (`fork.seed`): this
   * session's messages (from the latest compaction on) and the last `seq`
   * they cover. Rework K4 (audit D5): during a turn this includes the turn so
   * far, the user's message and every settled tool result, up to the reply
   * whose calls are running; that reply keeps its text and its answered
   * calls only (calls still running, such as the `delegate` that forks, are
   * left out, and so are its provider blocks).
   */
  forkSeed(): { readonly messages: readonly Exclude<LLMMessage, { role: 'system' }>[]; readonly throughSeq: number } {
    if (this.running === undefined) return { messages: [...this.settledHistory.messages], throughSeq: this.settledHistory.throughSeq }
    const messages = [...this.messages]
    let last = -1
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]!.role === 'assistant') {
        last = index
        break
      }
    }
    const reply = last === -1 ? undefined : messages[last] as Extract<LLMMessage, { role: 'assistant' }>
    if (reply?.toolCalls === undefined || reply.toolCalls.length === 0) return { messages, throughSeq: this.lastSeq }
    const answered = new Set(messages.slice(last + 1).flatMap(message => (message.role === 'tool' ? [message.toolCallId] : [])))
    if (reply.toolCalls.every(call => answered.has(call.id))) return { messages, throughSeq: this.lastSeq }
    const calls = reply.toolCalls.filter(call => answered.has(call.id))
    const trimmed: Extract<LLMMessage, { role: 'assistant' }> = {
      role: 'assistant',
      content: reply.content !== '' || calls.length > 0 ? reply.content : '(Handing a sub-task to a member.)',
      ...(calls.length === 0 ? {} : { toolCalls: calls }),
    }
    return { messages: [...messages.slice(0, last), trimmed, ...messages.slice(last + 1)], throughSeq: this.lastSeq }
  }

  /**
   * Step 3: keep the running turn open until `work` settles, so a
   * collaboration package can record a member run's end (`subagent.end`) in
   * the turn it belongs to. When the turn's loop is over, the agent cancels
   * its running members with cause `parent` and waits for held work at most
   * `toolAbortGraceMs` before it writes `turn.end`.
   * @throws `internal` when no turn is running.
   */
  holdTurn(work: Promise<unknown>): void {
    if (this.openTurn === undefined) throw new NexgentError('internal', `agent ${this.sessionId} has no running turn to hold`)
    const held = work.then(() => undefined, () => undefined)
    this.holds.add(held)
    void held.then(() => this.holds.delete(held))
  }

  /**
   * Register a per-request injector: before each model request of a turn
   * (after the compaction check), the agent calls it and writes each text it
   * returns as `user.message { source: 'inject' }`, so the request carries
   * it. This lets a package hand a running agent something before its next
   * step instead of at its next turn start (`@nexgent/team` delivers mail
   * this way). Not called before the request that continues a paused reply
   * (that request must send the paused reply back as is). An injector that
   * throws is skipped for that request with a non-fatal `error` record.
   * @returns a function that removes the injector.
   */
  beforeRequest(injector: StepInjector): () => void {
    this.injectors.add(injector)
    return () => {
      this.injectors.delete(injector)
    }
  }

  /** Settles when the running turn (if any) has ended. */
  async idle(): Promise<void> {
    await this.running?.done.catch(() => undefined)
  }

  /** The system prompt the next request would carry. */
  systemPrompt(): string {
    return renderSystemPrompt({
      template: this.init.settings.systemPrompt,
      model: this.model,
      cwd: this.workspace.root,
      sandboxMode: this.sandboxMode,
      platform: process.platform,
      tools: this.init.tools.list(),
      sections: this.turnSections,
      materials: this.turnMaterials,
      ...(this.member === undefined ? {} : { member: this.member }),
      ...(this.init.workdir === undefined ? {} : { workdir: true }),
      ...(this.member === undefined && this.init.services?.().workdirs !== undefined ? { memberWorkdirs: true } : {}),
    })
  }

  /** Listen to every event; returns the unsubscribe function. */
  subscribe(listener: AgentEventListener): () => void {
    return this.hub.subscribe(listener)
  }

  /** Async-iterate events from now until the agent closes (or the loop breaks). */
  events(): AsyncIterableIterator<AgentEvent> {
    return this.hub.iterate()
  }

  /**
   * Run one turn to its end. Resolves (never rejects) with how the turn ended
   * once `turn.end` is written; rejects only when the agent is closed or busy,
   * or the session store fails.
   */
  async run(input: string | TurnInput, options: RunOptions = {}): Promise<TurnResult> {
    if (this.closed) throw new NexgentError('internal', `agent ${this.sessionId} is closed`)
    if (this.running !== undefined) throw new NexgentError('internal', `agent ${this.sessionId} is already running a turn`)
    const controller = new AbortController()
    const onExternal = () => controller.abort(new TurnAbort('user'))
    if (options.signal?.aborted === true) onExternal()
    options.signal?.addEventListener('abort', onExternal, { once: true })
    // A cancelled turn cancels its running members at once (cause `parent`).
    controller.signal.addEventListener('abort', () => this.cancelMembers(), { once: true })
    const done = this.runTurn(typeof input === 'string' ? { text: input } : input, controller.signal)
    this.running = { controller, done }
    try {
      return await done
    } finally {
      this.running = undefined
      options.signal?.removeEventListener('abort', onExternal)
    }
  }

  /**
   * Append a host record ({@link HOST_RECORD_TYPES}; {@link HostRecordSink}).
   * While a turn runs the record gets that turn's number; between turns it
   * carries none, except that `subagent.end` / `workflow.end` may name an
   * earlier turn (recovery). Rejects with `session/invalid-record` for any
   * other type or a `turn` that is not allowed, and with `internal` once the
   * agent is closed.
   */
  readonly appendHostRecord = async (record: HostRecordInput): Promise<SessionRecord> => {
    if (this.closed) throw new NexgentError('internal', `agent ${this.sessionId} is closed`)
    const type = (record as { type?: unknown }).type
    if (!(HOST_RECORD_TYPES as readonly unknown[]).includes(type)) {
      throw new NexgentError('session/invalid-record', `host records are ${HOST_RECORD_TYPES.join(', ')}; got ${String(type)}`)
    }
    const turn = this.openTurn
    // Between turns, a collaboration record may close a run of an earlier turn (recovery writes `subagent.end` / `workflow.end` `interrupted`).
    const past = turn === undefined && record.turn !== undefined && RECOVERY_RECORD_TYPES.includes(record.type)
      && Number.isInteger(record.turn) && record.turn >= 1 && record.turn <= this.lastTurn
    if (record.turn !== undefined && record.turn !== turn && !past) {
      throw new NexgentError('session/invalid-record', turn === undefined
        ? `${record.type} carries turn ${record.turn} but no turn is running`
        : `${record.type} carries turn ${record.turn} but turn ${turn} is running`)
    }
    return this.append({ ...record, ...(turn === undefined ? {} : { turn }) } as HostRecordInput)
  }

  /**
   * A message the user sends while a turn runs. It goes out with the turn's
   * next model request as the user's own `user.message`, and the turn goes
   * on until the model has answered it. The members working now get it too
   * (relayed, as an `inject` note). Returns `false` when no turn is running
   * or the running one is already finishing: the caller starts a new turn.
   */
  steer(text: string, options: { readonly relayed?: boolean } = {}): boolean {
    if (this.closed || this.running === undefined || !this.acceptingSteers) return false
    const relayed = options.relayed === true
    this.pendingSteers.push(relayed ? { content: relayedUserNote(text), source: 'inject' } : { content: text, source: 'user' })
    for (const member of this.members()) {
      if (member.busy) member.steer(text, { relayed: true })
    }
    return true
  }

  /** Cancel the running turn, if any. Streamed text is kept; running tools are aborted. */
  cancel(cause: TurnCancelCause = 'user'): void {
    this.running?.controller.abort(new TurnAbort(cause))
  }

  /**
   * End the task: cancel a running turn (cause `shutdown`; a member's turn
   * closed with its parent ends with `parent`), close the members this agent
   * started, write the `task.outcome` ledger record (unless already written
   * or no turn ran), release the session lock and dispose the agent's scope.
   * Idempotent.
   */
  async close(options: CloseOptions = {}): Promise<void> {
    await this.closeAs('shutdown', options)
  }

  /** {@link close} with the cancel cause of a running turn. */
  async closeAs(cause: TurnCancelCause, options: CloseOptions = {}): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.running !== undefined) {
      this.running.controller.abort(new TurnAbort(cause))
      await this.running.done.catch(() => undefined)
    }
    await Promise.allSettled(this.members().map(member => member.closeAs('parent')))
    await this.init.workdir?.close().catch(() => undefined)
    try {
      if (options.skipOutcome !== true && !this.outcomeWritten && this.stats.turns > 0) {
        await this.writeOutcome(options.status ?? this.deriveStatus(), options.checks)
      }
    } finally {
      try {
        await this.init.session.release(this.init.lock)
      } finally {
        this.hub.emit({ type: 'closed', sessionId: this.sessionId })
        this.hub.close()
        this.init.onClose(this)
        await this.init.fiber.dispose()
      }
    }
  }

  // -------------------------------------------------------------------------
  // records
  // -------------------------------------------------------------------------

  private emit(event: AgentEvent): void {
    this.hub.emit(event)
  }

  // -------------------------------------------------------------------------
  // members (step 3)
  // -------------------------------------------------------------------------

  /** Open members this agent started. */
  private members(): readonly Agent[] {
    return this.init.children?.() ?? []
  }

  private cancelMembers(): void {
    for (const member of this.members()) member.cancel('parent')
  }

  /**
   * Before `turn.end`: cancel members still running (cause `parent`) and wait
   * for their turns and for held work ({@link holdTurn}), at most
   * `toolAbortGraceMs`.
   */
  private async settleMembers(): Promise<void> {
    const running = this.members().filter(member => member.busy)
    for (const member of running) member.cancel('parent')
    const pending = [...running.map(member => member.idle()), ...this.holds]
    if (pending.length === 0) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const grace = new Promise<void>(resolve => {
      timer = setTimeout(resolve, this.init.settings.toolAbortGraceMs)
    })
    try {
      await Promise.race([Promise.allSettled(pending), grace])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      // Work that outlives its turn is no longer held.
      this.holds.clear()
    }
  }

  /** Count model requests and their known tokens for this agent and its task tree. */
  private charge(requests: number, usage: LLMUsage | undefined): void {
    const tokens = usage === undefined ? 0 : knownTokens(usage)
    this.stats.requestCount += requests
    this.stats.tokens += tokens
    if (usage !== undefined) this.stats.totalUsage = addUsage(this.stats.totalUsage, usage)
    this.init.tree.requests += requests
    this.init.tree.tokens += tokens
    if (usage !== undefined) {
      // Rework D3 (ADR 0017 decision 6): dollars from the provider's price table.
      const { usd, estimated } = usageUsd(this.init.llm, this.model, usage)
      this.stats.usd += usd
      this.init.tree.usd += usd
      this.init.tree.turnUsd += usd
      if (estimated) {
        this.init.tree.usdEstimated = true
        this.init.tree.turnUsdEstimated = true
      }
    }
    if (this.member !== undefined) this.init.tree.chargeMember(this.sessionId, requests, usage)
  }

  private async append(record: SessionRecordInput): Promise<SessionRecord> {
    const written = await this.init.session.append(this.sessionId, record)
    this.lastSeq = Math.max(this.lastSeq, written.seq)
    if (written.type === 'checkpoint') this.lastCheckpointSeq = written.seq
    if (written.type === 'organization') {
      this.turnOrganization.organizations += 1
      this.turnOrganization.name = written.name
      this.turnOrganization.roles = written.roles.length
      this.turnOrganization.shape = { name: written.name, roles: written.roles }
    }
    this.emit({ type: 'record', sessionId: this.sessionId, record: written })
    return written
  }

  private async appendError(error: ErrorInfo, fatal: boolean, turn?: number): Promise<void> {
    await this.append({ type: 'error', ...(turn === undefined ? {} : { turn }), error, fatal })
    this.emit({ type: 'error', sessionId: this.sessionId, ...(turn === undefined ? {} : { turn }), error, fatal })
  }

  /** Append to the ledger; a failure is recorded in the session and never changes the outcome. */
  private async ledger(record: LedgerRecordInput, turn?: number): Promise<void> {
    try {
      await this.init.ledger.append(record)
    } catch (error) {
      const info = toErrorInfo(error)
      await this.appendError(info.code === 'internal' ? errorInfo('ledger/write-failed', info.message) : info, false, turn).catch(() => undefined)
    }
  }

  private deriveStatus(): TaskOutcomeStatus {
    switch (this.lastReason?.kind) {
      case 'cancelled':
      case 'interrupted':
        return 'cancelled'
      case 'error':
        return 'failed'
      default:
        return 'completed'
    }
  }

  private async writeOutcome(status: TaskOutcomeStatus, hostChecks?: readonly TaskCheck[]): Promise<void> {
    this.outcomeWritten = true
    const error = status === 'completed'
      ? undefined
      : this.budgetError ?? (this.lastReason?.kind === 'error' ? this.lastReason.error : undefined)
    const checks = hostChecks ?? (this.member === undefined ? this.lastChecks : undefined)
    const root = this.member === undefined
    await this.ledger({
      type: 'task.outcome',
      sessionId: this.sessionId,
      status,
      ...(error === undefined ? {} : { error }),
      totalUsage: this.stats.totalUsage,
      requestCount: this.stats.requestCount,
      toolCallCount: this.stats.toolCallCount,
      turns: this.stats.turns,
      ...(checks === undefined ? {} : { checks }),
      toolsUsed: [...this.stats.toolsUsed],
      ...this.ledgerAttribution(),
      ...(root ? { formsUsed: [...this.formsUsed()] } : {}),
      ...(this.capabilityVersion === undefined ? {} : { componentsUsed: this.componentsUsed() }),
      ...(root && this.init.tree.members > 0 ? { memberCosts: this.memberCosts() } : {}),
      ...(root && this.organizationUse() !== undefined ? { organization: this.organizationUse()! } : {}),
    })
  }

  // -------------------------------------------------------------------------
  // capabilities (step 4)
  // -------------------------------------------------------------------------

  /** Attribution plus the capability version (step 4) and improvement job (step 5), for every ledger record this agent writes. */
  ledgerAttribution(): LedgerAttribution {
    return {
      ...this.attribution,
      ...(this.capabilityVersion === undefined ? {} : { capabilityVersion: this.capabilityVersion }),
      ...(this.improvement === undefined ? {} : { improvementId: this.improvement.jobId, improvementPhase: this.improvement.phase }),
      // Step 6 (ADR 0008 decision 6): the pinned improver and, in a comparison arm, the meta job and arm.
      ...(this.improvement?.improverVersion === undefined ? {} : { improverVersion: this.improvement.improverVersion }),
      ...(this.improvement?.improverScope === undefined ? {} : { improverScope: this.improvement.improverScope }),
      ...(this.improvement?.metaJobId === undefined ? {} : { metaJobId: this.improvement.metaJobId }),
      ...(this.improvement?.comparisonArm === undefined ? {} : { comparisonArm: this.improvement.comparisonArm }),
    }
  }

  /** Step 5: whether this is an improvement job's own session (diagnose, propose, step 6 meta-diagnose or meta-propose), not a task. */
  get isImprovementSession(): boolean {
    return this.improvement !== undefined && this.improvement.phase !== 'trial'
  }

  /** Step 4: components this session used since it opened (`task.outcome.componentsUsed`), in manifest kind order, then name. */
  componentsUsed(): ComponentUsage[] {
    return sortUsage(this.componentUse.task.values())
  }

  /** Step 4: each member's usage in this agent's task tree (root only). */
  memberCosts(): ReturnType<TaskTree['memberCosts']> {
    return this.init.tree.memberCosts('task')
  }

  /**
   * Step 4: the `task.outcome` fields of the last (or running) turn, for a
   * host that counts a turn as a task (the SDK). The session package's
   * ledger stamp adds them to a root `task.outcome` that leaves them out.
   */
  turnOutcome(): { componentsUsed?: ComponentUsage[]; memberCosts?: ReturnType<TaskTree['memberCosts']>; checks?: TaskCheck[] } {
    const root = this.member === undefined
    return {
      ...(this.capabilityVersion === undefined ? {} : { componentsUsed: sortUsage(this.componentUse.turn.values()) }),
      ...(root && this.init.tree.members > 0 ? { memberCosts: this.init.tree.memberCosts('turn') } : {}),
      ...(root && this.lastChecks !== undefined ? { checks: [...this.lastChecks] } : {}),
    }
  }

  /** Make a loaded component's use recognisable (a tried draft replaces an adopted component of the same name). */
  private loadComponent(component: AttachedComponent, version: CapabilityVersion | 'draft'): void {
    const ref: ComponentUseRef = { kind: component.kind, name: component.name, version: component.draft === true ? 'draft' : version }
    for (const tool of component.tools ?? []) this.components.tools.set(tool, ref)
    if (component.kind === 'skill') this.components.skills.set(component.name, ref)
    if (component.kind === 'preset') this.components.presets.set(component.name, ref)
  }

  /** The component a finished call used, if any (`agent-hooks.md` §步骤 4). */
  private componentOfCall(name: string, input: unknown, isError: boolean, host: CapabilityHost | undefined): ComponentUseRef | undefined {
    const byTool = this.components.tools.get(name)
    if (byTool !== undefined) return byTool
    const field = (key: string): string | undefined => {
      const value = input !== null && typeof input === 'object' ? (input as Record<string, unknown>)[key] : undefined
      return typeof value === 'string' ? value : undefined
    }
    if (name === 'load_skill') {
      const skill = field('name')
      const ref = skill === undefined ? undefined : this.components.skills.get(skill)
      if (ref !== undefined) return ref
    }
    if (name === 'delegate' || name === 'spawn_teammate') {
      const preset = field('preset')
      const ref = preset === undefined ? undefined : this.components.presets.get(preset)
      if (ref !== undefined) return ref
    }
    if (host?.componentOf === undefined || !isJsonValue(input)) return undefined
    try {
      return host.componentOf({ sessionId: this.sessionId, name, input, isError })
    } catch {
      return undefined
    }
  }

  /** Count one finished call against the component it used, and note a successful shell command for the task checks. */
  private noteCall(call: ToolCall, isError: boolean, meta: JsonValue | undefined, host: CapabilityHost | undefined): void {
    let input: unknown
    try {
      input = call.arguments.trim() === '' ? {} : JSON.parse(call.arguments)
    } catch {
      return
    }
    if (this.capabilityVersion !== undefined) {
      const ref = this.componentOfCall(call.name, input, isError, host)
      if (ref !== undefined) {
        const key = `${ref.kind}\u0000${ref.name}\u0000${ref.version}`
        for (const tallies of [this.componentUse.task, this.componentUse.turn]) {
          const tally = tallies.get(key) ?? { kind: ref.kind, name: ref.name, version: ref.version, calls: 0, errors: 0 }
          tallies.set(key, { ...tally, calls: tally.calls + 1, errors: tally.errors + (isError ? 1 : 0) })
        }
      }
    }
    if ((call.name === 'bash' || call.name === 'pwsh') && !isError && input !== null && typeof input === 'object') {
      const { command, cwd } = input as { command?: unknown; cwd?: unknown }
      const exitCode = meta !== null && typeof meta === 'object' && !Array.isArray(meta) ? (meta as Record<string, JsonValue>).exitCode : undefined
      if (typeof command === 'string' && typeof exitCode === 'number' && (cwd === undefined || cwd === '.' || cwd === '')) {
        this.init.tree.commands.push({ command, shell: call.name, exitCode })
      }
    }
  }

  /**
   * Root turn start: snapshot the workspace (`snapshots/tasks/<taskId>.t<turn>.json`).
   * Redesign 3.1: every root turn, whether or not the project learns; the
   * snapshot is what a rewind restores, and the input of later
   * self-evaluation and practice cases (K1). The snapshot starts once
   * the first request's response begins ({@link startSnapshot}), so its file
   * system work never delays sending the request; tools wait for it
   * ({@link awaitSnapshot}). Members and
   * improvement sessions take none. Failures are non-fatal errors.
   */
  private beginTaskRecord(recorder: TaskRecorder | undefined, turn: number): void {
    const tree = this.init.tree
    if (recorder === undefined || this.member !== undefined || this.isImprovementSession) return
    tree.snapshotTaken = true
    const capabilityVersion = this.capabilityVersion ?? BASELINE_VERSION
    this.snapshotStart = () => recorder.begin({ taskId: tree.taskId, sessionId: this.sessionId, capabilityVersion, turn })
      .catch(error => this.appendError(errorInfo('internal', `task snapshot failed: ${toErrorInfo(error).message}`), false, turn))
  }

  /** Whether a call's tool declares only `read` / `network` effects (unknown tools are not read-only). */
  private readOnly(call: ToolCall): boolean {
    const effects = this.init.tools.get(call.name)?.definition.effects
    return effects !== undefined && effects.length > 0 && effects.every(effect => effect === 'read' || effect === 'network')
  }

  /** Start the turn's pending snapshot, if any. */
  private startSnapshot(): void {
    const start = this.snapshotStart
    if (start === undefined) return
    this.snapshotStart = undefined
    this.snapshotPending = start()
    this.init.tree.snapshot = this.snapshotPending
  }

  /**
   * Wait for the turn's snapshot before a tool can change the project. A
   * member waits for its root's (rework K4 D4: a member never changes the
   * project before the root turn's snapshot is complete).
   */
  private async awaitSnapshot(): Promise<void> {
    if (this.member !== undefined) {
      await this.init.tree.snapshot
      return
    }
    this.startSnapshot()
    const pending = this.snapshotPending
    if (pending === undefined) return
    this.snapshotPending = undefined
    await pending
  }

  /**
   * Root turn end, before `turn.end`: record the deterministic checks of the
   * task so far (presented files exist and parse; the test commands the
   * model itself ran, with their exit codes; nothing is re-run, K1) and keep
   * the results for `task.outcome.checks`. A failing check of a task session (not a gate
   * trial run) is signalled to `ctx.improve` as one `check-failure`.
   * Failures are non-fatal errors and leave `checks` out.
   */
  private async runTaskChecks(recorder: TaskRecorder | undefined, improve: ImprovementSignals | undefined, turn: number, signal: AbortSignal): Promise<void> {
    const tree = this.init.tree
    if (recorder === undefined || this.member !== undefined || this.isImprovementSession) return
    this.lastChecks = undefined
    let checks: readonly TaskCheck[]
    const reuse = this.retryChecks
    this.retryChecks = undefined
    if (reuse !== undefined && reuse.step === this.turnStep) {
      checks = reuse.results
      this.lastChecks = checks
    } else try {
      const checkRuns = await this.runCheckCommands(turn, signal)
      const { results } = await recorder.end({
        taskId: tree.taskId,
        sessionId: this.sessionId,
        turn,
        deliverableFiles: tree.deliverableFiles(),
        commands: [...tree.commands],
        ...(checkRuns.runs.length === 0 ? {} : { checkRuns: checkRuns.runs }),
        signal,
      })
      checks = results
      this.lastChecks = results
    } catch (error) {
      this.pendingRetry = undefined
      await this.appendError(errorInfo('internal', `task checks failed: ${toErrorInfo(error).message}`), false, turn)
      return
    }
    await this.recordRetryPair(turn, checks)
    if (improve === undefined || this.improvement !== undefined || checks.every(check => check.passed)) return
    try {
      await improve.noteCheckFailure({ taskId: tree.taskId, sessionId: this.sessionId, turn, checks })
    } catch (error) {
      await this.appendError(errorInfo('internal', `check-failure signal failed: ${toErrorInfo(error).message}`), false, turn)
    }
  }

  /** Redesign 3.2: automatic retries per root turn (project `checkRetries`, default {@link DEFAULT_CHECK_RETRIES}). */
  private maxCheckRetries(): number {
    return this.init.projectConfig.checkRetries ?? DEFAULT_CHECK_RETRIES
  }

  /**
   * Redesign 3.2: after the model ended a root turn, run the deterministic
   * checks (nothing is executed: a test command's result is the model's own
   * latest run) and, when one about this turn's work failed, return the note
   * that sends the model back to fix it. Only checks of this turn count: a
   * test command run in this turn, a file presented in this turn. `undefined`
   * when everything passed, retries are used up or off, or for members,
   * improvement sessions and hosts without a task recorder.
   */
  private async checkRetryNote(recorder: TaskRecorder | undefined, turn: number, attempt: number, signal: AbortSignal): Promise<string | undefined> {
    const max = this.maxCheckRetries()
    if (recorder === undefined || this.member !== undefined || this.isImprovementSession || attempt > max) return undefined
    await this.settleMembers()
    const tree = this.init.tree
    let checked: { readonly specs: readonly TaskCheckSpec[]; readonly results: readonly TaskCheck[] }
    let outputs: ReadonlyMap<string, string>
    try {
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(CHECKS_TIMEOUT_MS)])
      const checkRuns = await this.runCheckCommands(turn, bounded)
      outputs = checkRuns.outputs
      checked = await recorder.end({
        taskId: tree.taskId,
        sessionId: this.sessionId,
        turn,
        deliverableFiles: tree.deliverableFiles(),
        commands: [...tree.commands],
        ...(checkRuns.runs.length === 0 ? {} : { checkRuns: checkRuns.runs }),
        signal: bounded,
      })
    } catch {
      return undefined
    }
    this.retryChecks = { results: checked.results, step: this.turnStep }
    await this.recordRetryPair(turn, checked.results)
    const ranThisTurn = new Set(tree.commands.slice(tree.commandsAtTurnStart).map(command => `${command.shell}\u0000${command.command.trim()}`))
    const failed = checked.specs.flatMap((spec, index) => {
      const result = checked.results[index]
      if (result === undefined || result.passed) return []
      // The project's own check commands are about this turn's work by definition.
      const own = spec.id.startsWith(CHECK_COMMAND_ID_PREFIX)
      const ours = own || (spec.name === 'test-command' ? ranThisTurn.has(`${spec.shell}\u0000${spec.command}`) : tree.filesPresentedThisTurn.has(spec.path))
      const output = own ? outputs.get(spec.id) : undefined
      return ours ? [{ spec, result, ...(output === undefined ? {} : { output }) }] : []
    })
    if (failed.length === 0) return undefined
    this.pendingRetry = { retry: attempt, max, before: checked.results }
    const note = renderCheckRetryNote(failed, attempt, max)
    // Members did this turn's work: the organization may be what failed.
    return this.turnOrganization.organizations > 0 ? `${note}\n\n${REORGANIZE_AFTER_CHECKS_NOTE}` : note
  }

  /**
   * Redesign 3.2: run the project's `checkCommands` for the checks of a root
   * turn that changed something, through the registered shell tool (same
   * command sandbox and policy as the model's commands; a command that would
   * need approval is not run). Returns the runs for the task recorder and,
   * per failing check id, the tail of its output for the retry note.
   */
  private async runCheckCommands(turn: number, signal: AbortSignal): Promise<{ readonly runs: CheckCommandRun[]; readonly outputs: Map<string, string> }> {
    const commands = this.init.projectConfig.checkCommands ?? []
    const outputs = new Map<string, string>()
    if (commands.length === 0 || !this.turnActed || this.member !== undefined || this.isImprovementSession) return { runs: [], outputs }
    const shell: 'bash' | 'pwsh' = process.platform === 'win32' ? 'pwsh' : 'bash'
    const tool = this.init.tools.get(shell)
    const runs: CheckCommandRun[] = []
    for (const [index, command] of commands.entries()) {
      if (tool === undefined) {
        runs.push({ command, shell, detail: `no ${shell} tool to run the project check command` })
        continue
      }
      if (signal.aborted) {
        runs.push({ command, shell, detail: 'cancelled' })
        continue
      }
      const context: KernelToolContext = {
        sessionId: this.sessionId,
        callId: `check-command-${index + 1}`,
        turn,
        step: this.turnStep,
        workspace: this.init.workspace,
        sandboxMode: this.sandboxMode,
        signal,
        attribution: this.attribution,
        approved: false,
        grants: () => [...this.sessionGrants, ...this.init.tree.projectGrants],
        // Nobody is asked mid-check: a command that needs approval does not run.
        requestApproval: async () => false,
        appendRecord: async () => {
          throw new NexgentError('session/invalid-record', 'a project check command cannot append records')
        },
      }
      try {
        const output = await tool.handler({ command, timeoutMs: CHECK_COMMAND_TIMEOUT_MS }, context)
        const meta = output.meta
        const exitCode = meta !== null && typeof meta === 'object' && !Array.isArray(meta) ? (meta as Record<string, JsonValue>).exitCode : undefined
        if (typeof exitCode === 'number') {
          runs.push({ command, shell, exitCode })
          if (exitCode !== 0) outputs.set(`${CHECK_COMMAND_ID_PREFIX}${index + 1}`, output.content.slice(-CHECK_OUTPUT_TAIL_CHARS))
        } else {
          runs.push({ command, shell, detail: output.isError === true ? output.content.slice(0, 200) : 'the command reported no exit code' })
        }
      } catch (error) {
        runs.push({ command, shell, detail: `could not run: ${toErrorInfo(error).message}`.slice(0, 200) })
      }
    }
    return { runs, outputs }
  }

  /** Redesign 3.2: after a retry, write the before/after pair of checks to the ledger (`check.retry`), once. */
  private async recordRetryPair(turn: number, after: readonly TaskCheck[]): Promise<void> {
    const pending = this.pendingRetry
    if (pending === undefined) return
    this.pendingRetry = undefined
    await this.ledger({
      type: 'check.retry',
      sessionId: this.sessionId,
      ...this.ledgerAttribution(),
      taskId: this.init.tree.taskId,
      turn,
      retry: pending.retry,
      max: pending.max,
      before: [...pending.before],
      after: [...after],
    }, turn)
  }

  /**
   * ADR 0018: after `turn.end` of a root task turn (not a member, not an
   * improvement session), tell `ctx.improve` so it can queue the task for
   * background learning. Optional on the host; a failure is non-fatal.
   */
  private async signalTurnEnd(improve: ImprovementSignals | undefined, turn: number, reason: TurnEndReason): Promise<void> {
    if (improve?.noteTurnEnd === undefined || this.member !== undefined || this.improvement !== undefined) return
    try {
      await improve.noteTurnEnd({ taskId: this.init.tree.taskId, sessionId: this.sessionId, turn, reason, ...(this.lastChecks === undefined ? {} : { checks: this.lastChecks }) })
    } catch (error) {
      await this.appendError(errorInfo('internal', `turn-end signal failed: ${toErrorInfo(error).message}`), false, turn)
    }
  }

  // -------------------------------------------------------------------------
  // turn
  // -------------------------------------------------------------------------

  private async runTurn(input: TurnInput, signal: AbortSignal): Promise<TurnResult> {
    const source = input.source ?? 'user'
    if (source !== 'user' && source !== 'feedback') throw new NexgentError('internal', `invalid turn source "${String(source)}"`)
    const text = input.source === 'feedback' ? renderFeedbackPrompt(input.feedback) : input.text
    const materialIds = [...(input.materialIds ?? [])]
    // Messages sent from now on reach this turn (they follow its own message).
    this.pendingSteers = []
    this.acceptingSteers = true
    const services = this.init.services?.() ?? {}
    // Providers get the state before this turn. It is read before `turn.start`:
    // a lock-holding store's `resume` treats an open turn as interrupted
    // and closes it (data-formats.md §恢复), so it must never run mid-turn.
    const before = services.context !== undefined && services.context.providers.length > 0 ? await this.readState() : undefined
    const turn = ++this.lastTurn
    this.turnDenials = new Set()
    this.turnSections = []
    this.turnFiles = undefined
    this.turnMaterials = false
    this.stats.turns += 1
    this.openTurn = turn
    try {
      const handbook = await this.handbookForTurn(services.capabilityHost, turn, source, text)
      const organized = await this.organizeTurn(services.organizer, turn, source, text, materialIds, input.source === 'feedback' ? input.feedback.rating : undefined)
      this.turnOrganization = { ...(organized === undefined ? {} : { decision: organized.decision, section: organized.section }), organizations: 0, corrections: 0 }
      await this.append({
        type: 'turn.start',
        turn,
        ...(handbook === undefined || handbook.ids.length === 0 ? {} : { handbook: [...handbook.ids] }),
        ...(organized === undefined ? {} : { organization: organized.decision }),
      })
      this.emit({ type: 'turn.start', sessionId: this.sessionId, turn })
      this.componentUse.turn.clear()
      if (this.member === undefined) this.init.tree.beginRootTurn()
      this.beginTaskRecord(services.taskRecorder, turn)
      await this.refreshWorkdir(turn)
      if (input.source === 'feedback') await this.append({ type: 'feedback', turn, feedback: input.feedback })
      if (services.tasking !== undefined) {
        await this.beginFiles(services.tasking, turn)
        this.turnMaterials = await this.hasMaterials(services.tasking)
      }
      if (services.context !== undefined && before !== undefined) {
        await this.beginContext(services.context, before, { turn, text, source, materialIds, signal })
      }
      if (organized !== undefined) this.turnSections = [...this.turnSections, organized.section]
      if (handbook !== undefined) {
        await this.append({ type: 'user.message', turn, content: handbook.text, source: 'inject' })
        this.messages.push({ role: 'user', content: handbook.text })
      }
      await this.append({ type: 'user.message', turn, content: text, source, ...(materialIds.length > 0 ? { materials: materialIds } : {}) })
      this.messages.push({ role: 'user', content: text })

      const tracker = { text: '', usage: ZERO_USAGE as LLMUsage }
      let reason: TurnEndReason
      try {
        const unreadable = await this.readProjectUsage()
        this.turnStep = 0
        this.retryChecks = undefined
        this.pendingRetry = undefined
        this.turnActed = false
        reason = unreadable === undefined ? await this.loop(turn, signal, tracker, services.context) : { kind: 'error', error: unreadable }
        let retry = 1
        while (unreadable === undefined && reason.kind === 'completed' && !signal.aborted) {
          // A message sent while the turn was finishing is answered before the turn ends.
          if (this.pendingSteers.length > 0) {
            reason = await this.loop(turn, signal, tracker, services.context)
            continue
          }
          const note = await this.checkRetryNote(services.taskRecorder, turn, retry, signal)
          if (note === undefined) {
            if (this.pendingSteers.length > 0) continue
            break
          }
          retry += 1
          await this.injectNote(turn, note)
          reason = await this.loop(turn, signal, tracker, services.context)
        }
      } catch (error) {
        reason = { kind: 'error', error: toErrorInfo(error) }
      }
      this.acceptingSteers = false
      // Messages the turn could not answer (it was stopped or failed) stay in the history for the next turn.
      await this.drainSteers(turn).catch(() => undefined)
      await this.settleMembers()
      await this.awaitSnapshot()
      const merge = await this.mergeWorkdir(turn)
      await this.endFiles(turn, signal)
      // A cancelled turn still gets its checks, bounded like `endTurn`.
      await this.runTaskChecks(services.taskRecorder, services.improve, turn, signal.aborted
        ? AbortSignal.timeout(FILES_END_CANCEL_MS)
        : AbortSignal.any([signal, AbortSignal.timeout(CHECKS_TIMEOUT_MS)]))
      const end = await this.append({ type: 'turn.end', turn, reason })
      this.settledHistory = { messages: [...this.messages], throughSeq: end.seq }
      this.lastReason = reason
      this.emit({ type: 'turn.end', sessionId: this.sessionId, turn, reason, ...(this.member === undefined ? { cost: { usd: this.init.tree.turnUsd, estimated: this.init.tree.turnUsdEstimated } } : {}) })
      await this.signalTurnEnd(services.improve, turn, reason)
      await this.organizationTurnEnd(services.organizer, turn, reason)
      await this.maybeCheckpoint()
      if (reason.kind === 'cancelled' && reason.cause === 'cost-cap' && !this.outcomeWritten) {
        await this.writeOutcome('cancelled')
      }
      return { sessionId: this.sessionId, turn, reason, text: tracker.text, usage: tracker.usage, ...(merge === undefined ? {} : { merge }) }
    } finally {
      this.acceptingSteers = false
      this.pendingSteers = []
      this.openTurn = undefined
      this.turnSections = []
      this.turnFiles = undefined
      this.turnMaterials = false
    }
  }

  // -------------------------------------------------------------------------
  // step-2 hooks (docs/spec/agent-hooks.md)
  // -------------------------------------------------------------------------

  /**
   * `files.beginTurn`. On failure an `error` record is written and the turn
   * runs untracked: no `observe` calls and no `turn.files` (there is no
   * baseline to compare against).
   */
  /** Rework K4 D4: bring the project's newer files into the member's copy before its turn. A failure is a non-fatal error. */
  private async refreshWorkdir(turn: number): Promise<void> {
    const workdir = this.init.workdir
    if (workdir === undefined) return
    try {
      await workdir.refresh()
    } catch (error) {
      await this.appendError(errorInfo('internal', `could not update the member's copy of the project: ${toErrorInfo(error).message}`), false, turn)
    }
  }

  /**
   * Rework K4 D4: merge the member's copy into the project at the end of its
   * turn (after the root turn's snapshot, see {@link awaitSnapshot}). A
   * failure is a non-fatal error; the copy is kept, so the next turn's
   * merge tries again.
   */
  private async mergeWorkdir(turn: number): Promise<WorkdirMerge | undefined> {
    const workdir = this.init.workdir
    if (workdir === undefined) return undefined
    try {
      return await workdir.merge()
    } catch (error) {
      await this.appendError(errorInfo('internal', `could not merge the member's copy into the project: ${toErrorInfo(error).message}`), false, turn)
      return undefined
    }
  }

  private async beginFiles(tasking: TaskingService, turn: number): Promise<void> {
    const files = tasking.files
    try {
      await files.beginTurn(this.sessionId, turn)
      this.turnFiles = files
    } catch (error) {
      await this.appendError(toErrorInfo(error), false, turn)
    }
  }

  /**
   * The session state between turns, for context providers. Only called while
   * no turn is open (see `runTurn`); a failure is reported after `turn.start`.
   */
  private async readState(): Promise<{ readonly state: SessionState } | { readonly error: ErrorInfo }> {
    try {
      return { state: await this.init.session.resume(this.sessionId) }
    } catch (error) {
      return { error: toErrorInfo(error) }
    }
  }

  /** Whether the project lists any active material; a failed listing counts as none (it only drops one prompt line). */
  private async hasMaterials(tasking: TaskingService): Promise<boolean> {
    try {
      return (await tasking.materials.list()).length > 0
    } catch {
      return false
    }
  }

  /**
   * ADR 0018 decision 4: what the handbook gives a root session's user turn
   * (not members or feedback turns; the host decides per session). A failure
   * gives the turn nothing.
   */
  /** New direction step 2: ask `ctx.organizer` whether members help with a root user or feedback turn. */
  private async organizeTurn(organizer: TurnOrganizer | undefined, turn: number, source: 'user' | 'feedback', text: string, materialIds: readonly string[], rating: number | undefined) {
    if (organizer === undefined || this.member !== undefined || this.isImprovementSession) return undefined
    try {
      return await organizer.decide({ sessionId: this.sessionId, turn, text, source, materialIds, ...(rating === undefined ? {} : { rating }) })
    } catch {
      return undefined
    }
  }

  /** New direction step 3: tell the organizer how a turn it decided ended (its library records it). */
  private async organizationTurnEnd(organizer: TurnOrganizer | undefined, turn: number, reason: TurnEndReason): Promise<void> {
    const use = this.organizationUse()
    if (organizer?.noteTurnEnd === undefined || use === undefined || this.member !== undefined) return
    const shape = this.turnOrganization.shape
    await organizer.noteTurnEnd({
      sessionId: this.sessionId,
      turn,
      reason,
      ...(this.lastChecks === undefined ? {} : { checks: this.lastChecks }),
      use,
      ...(shape === undefined ? {} : { organization: shape }),
      usd: this.init.tree.turnUsd,
    }).catch(() => undefined)
  }

  /** New direction step 2: what the last root turn's organization came to (`task.outcome.organization`); `undefined` when no organizer decided it. */
  organizationUse(): OrganizationUse | undefined {
    const use = this.turnOrganization
    if (use.decision === undefined) return undefined
    return {
      decision: use.decision.decision,
      chosenBy: use.decision.chosenBy,
      ...(use.name === undefined ? {} : { name: use.name }),
      ...(use.roles === undefined ? {} : { roles: use.roles }),
      reorganizations: Math.max(0, use.organizations - 1),
      corrections: use.corrections,
    }
  }

  private async handbookForTurn(host: CapabilityHost | undefined, turn: number, source: 'user' | 'feedback', text: string): Promise<HandbookTurnSelection | undefined> {
    if (host?.handbookForTurn === undefined || this.member !== undefined || source !== 'user') return undefined
    try {
      const selection = await host.handbookForTurn({ sessionId: this.sessionId, turn, text })
      return selection === undefined || selection.text.trim() === '' ? undefined : selection
    } catch {
      return undefined
    }
  }

  /**
   * Call each provider's `beginTurn` in order: keep its system sections for
   * the turn's requests (sorted by id within the provider) and record its
   * injected texts as `user.message { source: 'inject' }`. A provider that
   * throws is skipped with a non-fatal `error` record.
   */
  private async beginContext(
    context: ContextService,
    before: { readonly state: SessionState } | { readonly error: ErrorInfo },
    args: { turn: number; text: string; source: 'user' | 'feedback'; materialIds: readonly string[]; signal: AbortSignal },
  ): Promise<void> {
    const providers = [...context.providers]
    if (providers.length === 0) return
    const { turn } = args
    if ('error' in before) {
      await this.appendError({ ...before.error, message: `context providers skipped: the session state could not be read (${before.error.message})` }, false, turn)
      return
    }
    const { state } = before
    const sections: SystemPromptSection[] = []
    for (const provider of providers) {
      if (args.signal.aborted) break
      let contribution
      try {
        contribution = await provider.beginTurn({
          sessionId: this.sessionId,
          turn,
          projectRoot: this.init.workspace.root,
          dataDir: this.init.workspace.layout.dataDir,
          text: args.text,
          source: args.source,
          materialIds: args.materialIds,
          state,
          signal: args.signal,
        })
      } catch (error) {
        const info = toErrorInfo(error)
        await this.appendError({ ...info, message: `context provider "${provider.id}" failed: ${info.message}` }, false, turn)
        continue
      }
      const own = [...(contribution?.systemSections ?? [])].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      sections.push(...own)
      for (const inject of contribution?.inject ?? []) {
        await this.append({ type: 'user.message', turn, content: inject, source: 'inject' })
        this.messages.push({ role: 'user', content: inject })
      }
    }
    this.turnSections = sections
  }

  /** Run the {@link beforeRequest} injectors in registration order and record their texts. */
  private async injectStep(turn: number, step: number, signal: AbortSignal): Promise<void> {
    for (const injector of [...this.injectors]) {
      if (signal.aborted) return
      let texts: readonly string[]
      try {
        texts = await injector({ sessionId: this.sessionId, turn, step, signal })
      } catch (error) {
        const info = toErrorInfo(error)
        await this.appendError({ ...info, message: `step injector failed: ${info.message}` }, false, turn)
        continue
      }
      for (const content of texts) {
        await this.append({ type: 'user.message', turn, content, source: 'inject' })
        this.messages.push({ role: 'user', content })
      }
    }
  }

  /**
   * Ask the compactor before a model call. Returns `false` when a compaction
   * failed (the caller stops trying for the rest of the turn); the history is
   * then unchanged and a non-fatal `error` record says why.
   */
  private async maybeCompact(context: ContextService, turn: number, step: number, signal: AbortSignal, force = false): Promise<boolean> {
    const compactor = context.compactor
    if (compactor === undefined) return !force
    const input: CompactionCheckInput = {
      sessionId: this.sessionId,
      turn,
      step,
      model: this.model,
      messages: [...this.messages],
      ...(this.lastUsage === undefined ? {} : { lastUsage: this.lastUsage }),
      failedThisTurn: false,
    }
    try {
      if (!force && !compactor.shouldCompact(input)) return true
      const result = await compactor.compact(input, signal)
      const kept = result.keepMessages
      const tail = compactionTail(this.messages, kept)
      // Everything the user said stays word for word, not only as the summary retells it.
      const summary = result.summary + renderUserWords(await this.userWordsOutside(tail))
      // The summary request is a model request of this task (`requestCount` counts every request).
      this.charge(1, result.usage)
      await this.append({
        type: 'compaction',
        turn,
        step,
        summary,
        keepMessages: kept,
        compactedMessages: result.compactedMessages,
        requestId: result.requestId,
        usage: result.usage,
        trigger: result.trigger,
      })
      this.messages.splice(0, this.messages.length, { role: 'user', content: renderCompactionSummary(summary) }, ...tail)
      this.lastUsage = undefined
      return true
    } catch (error) {
      const info = toErrorInfo(error)
      await this.appendError({ ...info, message: `compaction failed: ${info.message}` }, false, turn)
      return false
    }
  }

  /**
   * The user's own messages (`user.message` from the user or feedback) that a
   * compaction would drop: every one in the session except those still in the
   * kept tail. A failed read gives none (the summary still retells them).
   */
  private async userWordsOutside(tail: readonly LLMMessage[]): Promise<UserWords[]> {
    let records: readonly SessionRecord[]
    try {
      records = (await this.init.session.readAll(this.sessionId)).records
    } catch {
      return []
    }
    const kept = new Set(tail.flatMap(message => (message.role === 'user' ? [message.content] : [])))
    return records.flatMap(record => (record.type === 'user.message' && record.source !== 'inject' && !kept.has(record.content)
      ? [{ turn: record.turn, text: record.content }]
      : []))
  }

  /**
   * `files.endTurn` and the `turn.files` record. The tracker's signal fires
   * {@link FILES_END_CANCEL_MS} after the turn is cancelled (also when it
   * already was). A failure writes an `error` record instead of `turn.files`.
   */
  private async endFiles(turn: number, signal: AbortSignal): Promise<void> {
    const files = this.turnFiles
    if (files === undefined) return
    this.turnFiles = undefined
    const bound = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const arm = () => {
      timer = setTimeout(() => bound.abort(new TimeoutReason('FILES_END_TIMEOUT', FILES_END_CANCEL_MS)), FILES_END_CANCEL_MS)
    }
    if (signal.aborted) arm()
    else signal.addEventListener('abort', arm, { once: true })
    try {
      const changes = [...await files.endTurn(this.sessionId, turn, bound.signal)]
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      const listed = changes.slice(0, TURN_FILES_LIMIT)
      await this.append({
        type: 'turn.files',
        turn,
        changes: listed,
        ...(changes.length > listed.length ? { omitted: changes.length - listed.length } : {}),
      })
    } catch (error) {
      await this.appendError(toErrorInfo(error), false, turn).catch(() => undefined)
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      signal.removeEventListener('abort', arm)
    }
  }

  /** Runs after `turn.end` only: `resume` on a lock-holding store must not see an open turn. */
  private async maybeCheckpoint(): Promise<void> {
    const every = this.init.settings.checkpointEvery
    if (every <= 0 || this.lastSeq - this.lastCheckpointSeq < every) return
    try {
      const state = await this.init.session.resume(this.sessionId)
      await this.append({ type: 'checkpoint', coversSeq: state.metadata.lastSeq, state })
    } catch (error) {
      await this.appendError(toErrorInfo(error), false).catch(() => undefined)
    }
  }

  /**
   * Sum the project's usage inside `costCaps.perProject.windowDays` from the
   * ledger (`permissions.md` §费用上限): every `llm.request.start` counts as a
   * request, `llm.request.end` usage adds its known `inputTokens +
   * outputTokens` and its estimated dollars. Read once per turn; requests
   * this task sends later in the turn are added from its own totals. An
   * unknown total is not under the cap: a failed read returns the error that
   * ends the turn before any request is sent. A root turn also reads the
   * conversation's spending for `perConversation` (rework D3) and the
   * warnings already written for the project's and the conversation's caps.
   */
  private async readProjectUsage(): Promise<ErrorInfo | undefined> {
    this.projectUsage = undefined
    const caps = this.init.projectConfig.costCaps
    const project = caps.perProject
    const conversation = this.member === undefined ? caps.perConversation : undefined
    const tree = this.init.tree
    if (this.member === undefined) tree.conversation = undefined
    const needsProject = project !== undefined && (project.maxRequests !== undefined || project.maxTokens !== undefined || project.maxUsd !== undefined)
    if (!needsProject && conversation === undefined) return undefined
    const windowDays = project?.windowDays ?? DEFAULT_PROJECT_WINDOW_DAYS
    const from = Date.now() - windowDays * 86_400_000
    const projectSpend = zeroSpend()
    const root = tree.rootSessionId
    const rootSpend = zeroSpend()
    const rootTasks = new Set<string>()
    const memberSpend = new Map<string, Spend>()
    const add = (spend: Spend, record: { readonly type: string }, usage?: LLMUsage, model?: string, hostEstimated?: boolean): void => {
      if (record.type === 'llm.request.start') spend.requests += 1
      else if (usage !== undefined && model !== undefined) {
        spend.tokens += knownTokens(usage)
        const { usd, estimated } = usageUsd(this.init.llm, model, usage, hostEstimated)
        spend.usd += usd
        if (estimated) spend.estimated = true
      }
    }
    try {
      for await (const record of this.init.ledger.read({ ...(conversation === undefined ? { from: new Date(from).toISOString() } : {}), types: ['llm.request.start', 'llm.request.end', 'cost.warning'] })) {
        const inWindow = Date.parse(record.ts) >= from
        if (record.type === 'cost.warning') {
          // A warning already written for the same cap instance is not written again.
          if (record.scope === 'perProject' && inWindow && project !== undefined) tree.warned.add(warningKey('perProject', record))
          if (record.scope === 'perConversation' && record.sessionId === root) tree.warned.add(warningKey('perConversation', record))
          continue
        }
        const usage = record.type === 'llm.request.end' ? record.usage : undefined
        const model = record.type === 'llm.request.end' ? record.model : undefined
        const hostEstimated = record.type === 'llm.request.end' && record.usageEstimated === true
        if (needsProject && inWindow) add(projectSpend, record, usage, model, hostEstimated)
        // Learning and improvement jobs never count against a conversation (permissions.md §学习与学习预算).
        if (conversation === undefined || record.learningPhase !== undefined || record.improvementId !== undefined) continue
        if (record.sessionId === root) {
          add(rootSpend, record, usage, model, hostEstimated)
          if (record.taskId !== undefined) rootTasks.add(record.taskId)
        } else if (record.taskId !== undefined && record.memberId !== undefined && record.memberId !== 'main') {
          const spend = memberSpend.get(record.taskId) ?? zeroSpend()
          add(spend, record, usage, model, hostEstimated)
          memberSpend.set(record.taskId, spend)
        }
      }
    } catch (error) {
      const info = toErrorInfo(error)
      return { ...info, message: `the per-project cost cap cannot be checked because the ledger could not be read (${info.message}); no model request was sent` }
    }
    if (needsProject) {
      this.projectUsage = { ...projectSpend, ownRequests: this.stats.requestCount, ownTokens: this.stats.tokens, ownUsd: this.stats.usd }
    }
    if (conversation !== undefined) {
      let base = rootSpend
      for (const [taskId, spend] of memberSpend) if (rootTasks.has(taskId)) base = addSpend(base, spend)
      tree.conversation = { base, requests: tree.requests, tokens: tree.tokens, usd: tree.usd }
    }
    return undefined
  }

  /** Rework D3: what each scope has spent now (`undefined`: the scope has no cap, or its totals were not read). */
  private spendOf(scope: CostCapScope): Spend | undefined {
    const tree = this.init.tree
    switch (scope) {
      case 'perTask':
        // Requests and tokens count the open tree (step 1–3); dollars count the root's current task (ADR 0017 decision 6).
        return { requests: tree.requests, tokens: tree.tokens, usd: tree.turnUsd, estimated: tree.usdEstimated }
      case 'perConversation': {
        const read = tree.conversation
        if (read === undefined) return undefined
        return addSpend(read.base, subtractSpend({ requests: tree.requests, tokens: tree.tokens, usd: tree.usd, estimated: tree.usdEstimated }, { requests: read.requests, tokens: read.tokens, usd: read.usd, estimated: false }))
      }
      case 'perProject': {
        const base = this.projectUsage
        if (base === undefined) return undefined
        return {
          requests: base.requests + this.stats.requestCount - base.ownRequests,
          tokens: base.tokens + this.stats.tokens - base.ownTokens,
          usd: base.usd + this.stats.usd - base.ownUsd,
          estimated: base.estimated || tree.usdEstimated,
        }
      }
    }
  }

  /** Rework D3: the caps that apply to this agent, by scope. */
  private capsInForce(): readonly (readonly [CostCapScope, CostCap | undefined])[] {
    const caps = this.init.projectConfig.costCaps
    return [['perTask', this.init.tree.perTask], ['perConversation', caps.perConversation], ['perProject', caps.perProject]]
  }

  /**
   * Rework D3 (ADR 0017 decision 6): after a request, write one
   * `cost.warning` per cap instance that crossed 80% (`warning`) or was met
   * (`reached`, the loop then cancels the turn before the next request), to
   * the ledger and as an agent event.
   */
  private async warnCosts(turn: number): Promise<void> {
    const tree = this.init.tree
    for (const [scope, cap] of this.capsInForce()) {
      const spend = this.spendOf(scope)
      if (spend === undefined) continue
      const status = capStatus(cap, spend)
      if (status === undefined) continue
      const key = warningKey(scope, status)
      if (tree.warned.has(key)) continue
      tree.warned.add(key)
      // `estimated` speaks of dollars (unknown usage or price); tokens and requests are counted as known.
      const estimated = status.limit === 'maxUsd' && spend.estimated
      const warning: CostWarning = { scope, ...status, estimated }
      const sessionId = scope === 'perConversation' ? tree.rootSessionId : this.sessionId
      await this.ledger({ type: 'cost.warning', sessionId, ...this.ledgerAttribution(), scope, level: status.level, limit: status.limit, used: status.used, cap: status.cap, estimated }, turn)
      this.emit({ type: 'cost.warning', sessionId: this.sessionId, turn, warning })
    }
  }

  /** The cost-cap error when the next request would exceed `costCaps.perTask`, `perConversation` or `perProject`. */
  private budgetExhausted(): ErrorInfo | undefined {
    const hit = (scope: CostCapScope, status: CapStatus | undefined) => status?.level === 'reached'
      ? errorInfo('budget/exhausted', `per-${errorScope(scope)} ${errorMetric(status.limit)} cap reached (${status.limit === 'maxUsd' ? status.used.toFixed(4) : status.used} of ${status.cap})`, { scope: errorScope(scope), metric: errorMetric(status.limit), used: status.used, limit: status.cap })
      : undefined
    // `perTask` counts the whole task tree (step 3); a member's share only lowers what that member may spend.
    const task = this.init.tree.perTask
    const taskHit = hit('perTask', capStatus(task, this.spendOf('perTask')!))
    if (taskHit !== undefined) return taskHit
    const share = this.init.budget
    if (share !== undefined) {
      const own = hit('perTask', capStatus({ ...share }, { requests: this.stats.requestCount, tokens: this.stats.tokens, usd: 0, estimated: false }))
      if (own !== undefined) return own
    }
    for (const scope of ['perConversation', 'perProject'] as const) {
      const spend = this.spendOf(scope)
      if (spend === undefined) continue
      const found = hit(scope, capStatus(this.capsInForce().find(([s]) => s === scope)![1], spend))
      if (found !== undefined) return found
    }
    return undefined
  }

  private async loop(turn: number, signal: AbortSignal, tracker: { text: string; usage: LLMUsage }, context: ContextService | undefined): Promise<TurnEndReason> {
    let pauses = 0
    let outputCuts = 0
    let compactionFailed = false
    let overflowCompacted = false
    let paused = false
    const maxSteps = this.init.settings.maxSteps
    // A check retry goes on in the same turn: its steps count on from the turn's last one (redesign 3.2).
    for (let step = this.turnStep + 1; ; step += 1) {
      this.turnStep = step
      if (signal.aborted) return { kind: 'cancelled', cause: causeOf(signal) }
      const exhausted = this.budgetExhausted()
      if (exhausted !== undefined) {
        this.budgetError = exhausted
        await this.appendError(exhausted, false, turn)
        return { kind: 'cancelled', cause: 'cost-cap' }
      }
      // The limit stops the turn, not the task: the history is intact and the next message continues it (ADR 0021).
      if (step > maxSteps) return { kind: 'cancelled', cause: 'step-limit' }
      if (context !== undefined && !compactionFailed) {
        compactionFailed = !(await this.maybeCompact(context, turn, step, signal))
        if (signal.aborted) return { kind: 'cancelled', cause: causeOf(signal) }
      }
      // Messages the user sent meanwhile go out with this request (a paused reply's continuation goes out unchanged).
      if (!paused) await this.drainSteers(turn)
      paused = false
      // A paused reply ends the history; its continuation request goes out unchanged.
      if (this.injectors.size > 0 && this.messages.at(-1)?.role !== 'assistant') {
        await this.injectStep(turn, step, signal)
        if (signal.aborted) return { kind: 'cancelled', cause: causeOf(signal) }
      }
      if (step === maxSteps && maxSteps >= 4 && this.messages.at(-1)?.role !== 'assistant') await this.injectNote(turn, stepLimitNote(maxSteps))

      const outcome = await this.requestModel(turn, step, signal)
      tracker.usage = addUsage(tracker.usage, outcome.usage)
      tracker.text = outcome.content
      const interrupted = outcome.finish === 'aborted'
      const toolCalls = interrupted || outcome.finish === 'error' ? [] : outcome.toolCalls
      if (!(outcome.finish === 'error' && outcome.content === '')) {
        const extras = {
          ...(toolCalls.length > 0 ? { toolCalls } : {}),
          ...(outcome.providerContent === undefined ? {} : { providerContent: outcome.providerContent }),
        }
        await this.append({
          type: 'assistant.message',
          turn,
          step,
          requestId: outcome.requestId,
          content: outcome.content,
          ...extras,
          usage: outcome.usage,
          finishReason: outcome.finish,
          ...(interrupted ? { interrupted: true as const } : {}),
          ...(outcome.refusal === undefined ? {} : { refusal: outcome.refusal }),
        })
        if (!(interrupted && outcome.content === '')) {
          this.messages.push({ role: 'assistant', content: outcome.content, ...extras })
        }
        this.emit({
          type: 'assistant.message',
          sessionId: this.sessionId,
          turn,
          step,
          requestId: outcome.requestId,
          content: outcome.content,
          ...(toolCalls.length > 0 ? { toolCalls } : {}),
          usage: outcome.usage,
          finishReason: outcome.finish,
          ...(interrupted ? { interrupted: true as const } : {}),
          ...(outcome.refusal === undefined ? {} : { refusal: outcome.refusal }),
        })
      }

      if (interrupted) return { kind: 'cancelled', cause: signal.aborted ? causeOf(signal) : 'user' }
      // The prompt no longer fits the context window: compact now (older steps of this turn included) and send again, once per turn.
      if (outcome.finish === 'error' && outcome.error?.details?.['contextOverflow'] === true && context !== undefined && !overflowCompacted) {
        overflowCompacted = true
        await this.appendError({ ...outcome.error, message: `${outcome.error.message}; compacting the history and sending the request again` }, false, turn)
        if (await this.maybeCompact(context, turn, step, signal, true)) continue
        if (signal.aborted) return { kind: 'cancelled', cause: causeOf(signal) }
      }
      if (outcome.finish === 'error') return { kind: 'error', error: outcome.error ?? errorInfo('llm/request-failed', 'model request failed') }
      // A refused reply ends the turn; its tool calls are never run (ADR 0002).
      if (outcome.finish === 'refusal') return { kind: 'error', error: refusalError(outcome.refusal) }
      // A reply cut by the output cap may carry truncated tool input: its calls are answered with an
      // error instead of being run, and the loop asks the model to continue (ADR 0021).
      if (outcome.finish === 'max-tokens') {
        outputCuts += 1
        if (outputCuts > (this.init.settings.maxOutputContinuations ?? DEFAULT_MAX_OUTPUT_CONTINUATIONS)) return { kind: 'max-tokens' }
        for (const call of toolCalls) {
          await this.writeToolResult(turn, step, call, {
            content: OUTPUT_CUT_TOOL_RESULT,
            isError: true,
            error: errorInfo('tool/invalid-input', 'not run: the reply was cut by the output length limit'),
          }, 0)
        }
        await this.injectNote(turn, toolCalls.length > 0 ? OUTPUT_CUT_TOOLS_NOTE : OUTPUT_CUT_NOTE)
        continue
      }
      outputCuts = 0
      // A paused reply (Claude `pause_turn`) is already in history; the next request sends it back to continue.
      if (outcome.finish === 'pause') {
        pauses += 1
        paused = toolCalls.length === 0
        const limit = this.init.settings.maxPauseContinuations
        if (pauses > limit) {
          return {
            kind: 'error',
            error: errorInfo('llm/invalid-response', `the model paused the turn ${pauses} times in a row; stopped after ${limit} automatic continuations`, { pauses, limit }),
          }
        }
        if (toolCalls.length > 0) await this.runTools(turn, step, toolCalls, signal)
        continue
      }
      pauses = 0
      if (toolCalls.length > 0) {
        await this.runTools(turn, step, toolCalls, signal)
        continue
      }
      // A message sent while the model was answering: the turn goes on to answer it.
      if (this.pendingSteers.length > 0 && !signal.aborted) continue
      return { kind: 'completed' }
    }
  }

  // -------------------------------------------------------------------------
  // model request
  // -------------------------------------------------------------------------

  private async requestModel(turn: number, step: number, signal: AbortSignal): Promise<StreamOutcome> {
    const { settings, llm } = this.init
    const requestId = randomUUID()
    const tools = this.init.tools.list()
    const local = new AbortController()
    const whole = deadline(signal, settings.modelTimeoutMs, MODEL_TIMEOUT)
    const requestSignal = AbortSignal.any([whole.signal, local.signal])
    const request: LLMRequest = {
      requestId,
      model: this.model,
      messages: [{ role: 'system', content: this.systemPrompt() }, ...repairHistory(this.messages)],
      ...(tools.length > 0
        ? { tools: tools.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.inputSchema })) }
        : {}),
      ...(settings.maxTokens === undefined ? {} : { maxTokens: settings.maxTokens }),
      thinking: this.init.thinking,
      effort: this.init.effort,
      signal: requestSignal,
    }
    this.charge(1, undefined)
    this.emit({ type: 'request.start', sessionId: this.sessionId, turn, step, requestId, model: this.model })

    let content = ''
    const calls = new Map<number, ToolCall>()
    let usage: LLMUsage | undefined
    let finish: StreamOutcome['finish'] | undefined
    let error: ErrorInfo | undefined
    let providerContent: JsonValue | undefined
    let refusal: RefusalInfo | undefined
    let idleTimedOut = false
    let iterator: AsyncIterator<unknown> | undefined
    const stopped = abortPromise(requestSignal).then(() => ({ kind: 'stopped' as const }))

    try {
      // The attribution rides along for providers that stamp it on their ledger records (`@nexgent/llm` does).
      const completeOptions: LLMCompleteOptions & LedgerAttribution = {
        sessionId: this.sessionId,
        purpose: 'task',
        ...(settings.modelTimeoutMs > 0 ? { timeoutMs: settings.modelTimeoutMs } : {}),
        ...(settings.streamIdleTimeoutMs > 0 ? { streamIdleTimeoutMs: settings.streamIdleTimeoutMs } : {}),
        ...this.ledgerAttribution(),
      }
      iterator = llm.complete(request, completeOptions)[Symbol.asyncIterator]()
      for (;;) {
        let idleTimer: ReturnType<typeof setTimeout> | undefined
        const idle = settings.streamIdleTimeoutMs > 0
          ? new Promise<{ kind: 'idle' }>(resolve => {
            // A little later than the provider's own idle deadline, so a provider that retries a stalled attempt (ADR 0021) gets to.
            idleTimer = setTimeout(() => resolve({ kind: 'idle' }), settings.streamIdleTimeoutMs + Math.min(IDLE_GRACE_MS, Math.floor(settings.streamIdleTimeoutMs / 2)))
          })
          : new Promise<never>(() => {})
        const next = iterator.next().then(
          result => ({ kind: 'next' as const, result }),
          (thrown: unknown) => ({ kind: 'throw' as const, thrown }),
        )
        const raced = await Promise.race([next, stopped, idle])
        if (idleTimer !== undefined) clearTimeout(idleTimer)
        // The request is out and answering: the snapshot's file system work no longer delays it.
        this.startSnapshot()
        if (raced.kind === 'stopped') break
        if (raced.kind === 'idle') {
          idleTimedOut = true
          local.abort(new TimeoutReason(MODEL_IDLE_TIMEOUT, settings.streamIdleTimeoutMs))
          break
        }
        if (raced.kind === 'throw') {
          error = toErrorInfo(raced.thrown)
          if (error.code === 'internal') error = errorInfo('llm/request-failed', error.message)
          finish = 'error'
          break
        }
        if (raced.result.done === true) break
        const event = raced.result.value as LLMStreamEvent
        switch (event.type) {
          case 'text.delta':
            content += event.text
            this.emit({ type: 'text.delta', sessionId: this.sessionId, turn, step, text: event.text })
            break
          case 'reasoning.delta':
            this.emit({ type: 'reasoning.delta', sessionId: this.sessionId, turn, step, text: event.text })
            break
          case 'tool-call.start':
            this.emit({ type: 'tool-call.start', sessionId: this.sessionId, turn, step, index: event.index, id: event.id, name: event.name })
            break
          case 'tool-call.delta':
            break
          case 'tool-call.end':
            calls.set(event.index, event.call)
            break
          case 'usage':
            usage = event.usage
            break
          case 'retry':
            this.emit({ type: 'request.retry', sessionId: this.sessionId, turn, step, requestId, attempt: event.attempt, delayMs: event.delayMs, error: event.error })
            break
          case 'done':
            finish = event.finishReason
            providerContent = event.providerContent
            refusal = event.refusal
            break
          case 'error':
            finish = 'error'
            error = event.error
            break
        }
        if (finish !== undefined) break
      }
    } finally {
      whole.dispose()
      if (finish === undefined || finish === 'error') {
        // Stop a provider that is still streaming; never wait on a hung one.
        local.abort()
        void Promise.resolve(iterator?.return?.()).catch(() => undefined)
      } else {
        // Close the generator after its terminal event so the provider's own
        // cleanup (its `llm.request.end` record, the response stream) runs now.
        await Promise.resolve(iterator?.return?.()).catch(() => undefined)
      }
    }

    const reportedUsage = usage ?? UNKNOWN_USAGE
    if (usage !== undefined) this.lastUsage = usage
    this.charge(0, reportedUsage)
    await this.warnCosts(turn)
    const ordered = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, call]) => call)
    const base = { requestId, content, usage: reportedUsage }

    const modelTimeout = timeoutOf(whole.signal, MODEL_TIMEOUT)
    if (idleTimedOut || (modelTimeout !== undefined && !signal.aborted)) {
      const ms = idleTimedOut ? settings.streamIdleTimeoutMs : settings.modelTimeoutMs
      return { ...base, toolCalls: [], finish: 'error', error: errorInfo('llm/timeout', `model request timed out after ${ms}ms`, { timeoutMs: ms, idle: idleTimedOut }) }
    }
    if (signal.aborted) return { ...base, toolCalls: [], finish: 'aborted' }
    if (finish === undefined) {
      return { ...base, toolCalls: [], finish: 'error', error: errorInfo('llm/invalid-response', 'model stream ended without a terminal event') }
    }
    if (finish === 'error') return { ...base, toolCalls: [], finish, error: error ?? errorInfo('llm/request-failed', 'model request failed') }
    if (finish === 'aborted') return { ...base, toolCalls: [], finish: 'aborted' }
    // `stop`/`tool-calls` follow the assembled calls; `max-tokens` and `refusal` are kept as reported.
    const reported = finish === 'stop' || finish === 'tool-calls' ? (ordered.length > 0 ? 'tool-calls' : 'stop') : finish
    // A cut reply may hold a tool call the stream never completed; list it so it gets a result like the others.
    if (reported === 'max-tokens') {
      for (const call of providerToolUses(providerContent)) {
        if (!ordered.some(known => known.id === call.id)) ordered.push(call)
      }
    }
    return {
      ...base,
      toolCalls: ordered,
      finish: reported,
      ...(providerContent === undefined ? {} : { providerContent }),
      ...(refusal === undefined ? {} : { refusal }),
    }
  }

  // -------------------------------------------------------------------------
  // tools
  // -------------------------------------------------------------------------

  /**
   * Run one step's calls (ADR 0017 decision 5): consecutive concurrent calls
   * (`concurrent: true` tools, no up-front approval) run together, at most
   * {@link MAX_CONCURRENT_CALLS} at once and at most
   * `maxConcurrentMembers` of them `delegate`; every other call runs alone,
   * in call order. Results go back to the model, and `tool.result` and
   * ledger records are written, in call order.
   */
  private async runTools(turn: number, step: number, calls: readonly ToolCall[], signal: AbortSignal): Promise<void> {
    this.startSnapshot()
    for (const batch of scheduleToolCalls(calls.map(call => this.concurrentCall(call)))) {
      const group = batch.map(index => calls[index]!)
      // Only calls that may change the project wait for the snapshot; reads go ahead while it runs.
      if (group.some(call => !this.readOnly(call))) await this.awaitSnapshot()
      if (signal.aborted) {
        for (const call of group) {
          await this.writeToolResult(turn, step, call, {
            content: 'Error: the turn was cancelled before this call ran.',
            isError: true,
            error: errorInfo('tool/aborted', 'cancelled before the call ran'),
          }, 0)
        }
        continue
      }
      if (group.length === 1) {
        await this.finishTool(turn, step, group[0]!, await this.runTool(turn, step, group[0]!, signal))
        continue
      }
      const slots = new Limit(MAX_CONCURRENT_CALLS)
      const memberSlots = new Limit(COLLABORATION_LIMITS.maxConcurrentMembers)
      const runs = group.map(call => call.name === DELEGATE_TOOL_NAME
        ? memberSlots.run(() => slots.run(() => this.runTool(turn, step, call, signal)))
        : slots.run(() => this.runTool(turn, step, call, signal)))
      for (const [index, run] of runs.entries()) await this.finishTool(turn, step, group[index]!, await run)
    }
  }

  /** Whether a call may join a concurrent batch: a known `concurrent` tool, valid input and no up-front approval. */
  private concurrentCall(call: ToolCall): boolean {
    const definition = this.init.tools.get(call.name)?.definition
    if (definition?.concurrent !== true) return false
    let input: unknown
    try {
      input = call.arguments.trim() === '' ? {} : JSON.parse(call.arguments)
    } catch {
      return false
    }
    if (validateJsonSchema(input, definition.inputSchema) !== undefined) return false
    return isConcurrentTool(definition, decideToolPolicy(definition, this.sandboxMode, input).kind === 'ask')
  }

  private async writeToolResult(
    turn: number,
    step: number,
    call: ToolCall,
    output: { content: string; isError: boolean; error?: ErrorInfo; meta?: JsonValue },
    durationMs: number,
  ): Promise<void> {
    const result: ToolResult = { toolCallId: call.id, name: call.name, content: output.content, isError: output.isError }
    await this.append({
      type: 'tool.result',
      turn,
      step,
      toolCallId: call.id,
      name: call.name,
      content: output.content,
      isError: output.isError,
      ...(output.isError && output.error !== undefined ? { error: output.error } : {}),
      ...(output.meta === undefined ? {} : { meta: output.meta }),
      durationMs,
    })
    this.messages.push({ role: 'tool', ...result })
    const effects = this.init.tools.get(call.name)?.definition.effects
    try {
      this.turnFiles?.observe({
        sessionId: this.sessionId,
        turn,
        callId: call.id,
        name: call.name,
        isError: output.isError,
        ...(output.meta === undefined ? {} : { meta: output.meta }),
        ...(effects === undefined ? {} : { effects }),
      })
    } catch {
      // `observe` failures never change the tool result (agent-hooks.md §失败语义).
    }
    this.emit({
      type: 'tool.result',
      sessionId: this.sessionId,
      turn,
      step,
      result,
      durationMs,
      ...(output.isError && output.error !== undefined ? { error: output.error } : {}),
    })
  }

  /** Execute one call up to its result; {@link finishTool} records it. */
  private async runTool(turn: number, step: number, call: ToolCall, signal: AbortSignal): Promise<ToolRun> {
    this.emit({ type: 'tool.start', sessionId: this.sessionId, turn, step, call })
    const tool = this.init.tools.get(call.name)
    let approval: ToolCallApproval = { required: false, decision: 'auto' }
    let durationMs = 0
    let output: { content: string; isError: boolean; error?: ErrorInfo; meta?: JsonValue }

    const failure = (code: NexgentErrorCode, message: string, details?: Record<string, unknown>) => {
      const error = errorInfo(code, message, details)
      return { content: `Error: ${message}`, isError: true, error }
    }

    if (tool === undefined) {
      output = failure('tool/not-found', `unknown tool "${call.name}"`)
    } else {
      output = await this.executeTool(turn, step, call, tool, signal, failure, value => { approval = value }, ms => { durationMs = ms })
    }
    return { tool, output, approval, durationMs }
  }

  /** Write a call's result, count it and add its ledger record. */
  private async finishTool(turn: number, step: number, call: ToolCall, run: ToolRun): Promise<void> {
    const { tool, output, approval, durationMs } = run
    await this.writeToolResult(turn, step, call, output, durationMs)
    this.stats.toolCallCount += 1
    this.stats.toolsUsed.add(call.name)
    if (this.member !== undefined) this.init.tree.countMemberToolCall(this.sessionId)
    if (tool !== undefined) this.noteCall(call, output.isError, output.meta, this.init.services?.().capabilityHost)
    if (tool !== undefined && !output.isError && !this.readOnly(call)) this.turnActed = true
    await this.ledger({
      type: 'tool.call',
      sessionId: this.sessionId,
      turn,
      callId: call.id,
      name: call.name,
      effects: tool?.definition.effects ?? [],
      approval,
      isError: output.isError,
      durationMs,
      ...this.ledgerAttribution(),
    }, turn)
  }

  /** Append the messages sent while the turn runs ({@link steer}) and send them with the next request. */
  private async drainSteers(turn: number): Promise<void> {
    while (this.pendingSteers.length > 0) {
      const { content, source } = this.pendingSteers.shift()!
      if (source === 'user') this.turnOrganization.corrections += 1
      await this.append({ type: 'user.message', turn, content, source })
      this.messages.push({ role: 'user', content })
    }
  }

  /** Append one loop note as `user.message { source: 'inject' }` (hidden from the history view) and send it with the next request. */
  private async injectNote(turn: number, content: string): Promise<void> {
    await this.append({ type: 'user.message', turn, content, source: 'inject' })
    this.messages.push({ role: 'user', content })
  }

  private async executeTool(
    turn: number,
    step: number,
    call: ToolCall,
    tool: Tool,
    signal: AbortSignal,
    failure: (code: NexgentErrorCode, message: string, details?: Record<string, unknown>) => { content: string; isError: boolean; error: ErrorInfo },
    setApproval: (approval: ToolCallApproval) => void,
    setDuration: (ms: number) => void,
  ): Promise<{ content: string; isError: boolean; error?: ErrorInfo; meta?: JsonValue }> {
    const definition = tool.definition
    let input: unknown
    try {
      input = call.arguments.trim() === '' ? {} : JSON.parse(call.arguments)
    } catch {
      return failure('tool/invalid-input', `arguments for ${definition.name} are not valid JSON`)
    }
    const problem = validateJsonSchema(input, definition.inputSchema)
    if (problem !== undefined) return failure('tool/invalid-input', `invalid arguments for ${definition.name}: ${problem}`)

    const subject = approvalSubject(input)
    const verdict = decideToolPolicy(definition, this.sandboxMode, input)
    if (verdict.kind === 'deny') {
      setApproval({ required: false, decision: 'deny' })
      return failure('sandbox/denied', verdict.reason, { mode: this.sandboxMode, tool: definition.name })
    }
    let approved = false
    if (verdict.kind === 'ask') {
      const text = definition.approvalText?.(input)
      const auth = await this.authorize(turn, call, definition, {
        summary: text?.summary ?? subject.value,
        ...(text?.detail === undefined ? {} : { detail: text.detail }),
        subject,
        risk: verdict.risk,
        options: verdict.options,
      }, signal)
      setApproval(auth.approval)
      if (auth.cancelled) return failure('tool/aborted', 'the turn was cancelled while waiting for approval')
      if (!auth.allowed) return failure('approval/denied', `the user did not approve ${definition.name}`, { decision: auth.approval.decision })
      approved = true
    }

    const toolDeadline = deadline(signal, definition.timeoutMs, TOOL_TIMEOUT)
    let recordsOpen = true
    let recordFailure: ErrorInfo | undefined
    const context: KernelToolContext = {
      sessionId: this.sessionId,
      callId: call.id,
      turn,
      step,
      workspace: this.workspace,
      sandboxMode: this.sandboxMode,
      signal: toolDeadline.signal,
      attribution: this.attribution,
      ...(this.member === undefined ? {} : { member: this.member }),
      approved,
      grants: () => [...this.sessionGrants, ...this.init.tree.projectGrants],
      requestApproval: async ask => {
        const auth = await this.authorize(turn, call, definition, ask, signal)
        setApproval(auth.approval)
        return auth.allowed
      },
      appendRecord: async record => {
        try {
          const type = (record as { type?: unknown }).type
          if (!recordsOpen) throw new NexgentError('session/invalid-record', `${definition.name} appended ${String(type)} after its call settled`)
          if (!(TOOL_RECORD_TYPES as readonly unknown[]).includes(type)) {
            throw new NexgentError('session/invalid-record', `tools may append only ${TOOL_RECORD_TYPES.join(', ')} records; got ${String(type)}`)
          }
          const written = await this.append(this.toolRecord(record, { turn, step, toolCallId: call.id }))
          this.noteToolRecord(written)
        } catch (error) {
          recordFailure ??= toErrorInfo(error)
          throw error
        }
      },
    }
    const started = performance.now()
    let settled: { ok: true; value: ToolOutput } | { ok: false; error: unknown } | undefined
    try {
      const running = Promise.resolve()
        .then(() => tool.handler(input, context))
        .then(value => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }))
      const gave = abortPromise(toolDeadline.signal).then(() => new Promise<undefined>(resolve => {
        setTimeout(() => resolve(undefined), this.init.settings.toolAbortGraceMs)
      }))
      settled = await Promise.race([running, gave])
    } finally {
      recordsOpen = false
      toolDeadline.dispose()
      setDuration(Math.max(0, Math.round(performance.now() - started)))
    }

    const timeout = timeoutOf(toolDeadline.signal, TOOL_TIMEOUT)
    if (timeout !== undefined && !signal.aborted) {
      return failure('tool/timeout', `${definition.name} timed out after ${timeout.timeoutMs}ms`, { timeoutMs: timeout.timeoutMs })
    }
    if (signal.aborted) return failure('tool/aborted', `${definition.name} was cancelled`)
    if (settled === undefined) return failure('tool/aborted', `${definition.name} did not settle`)
    // A record the tool could not append ends the call as failed, even when the handler caught the rejection.
    const lostRecord = recordFailure as ErrorInfo | undefined
    if (lostRecord !== undefined) {
      return failure('tool/failed', `${definition.name} could not record its result: ${lostRecord.message}`, { cause: lostRecord.code })
    }
    if (!settled.ok) {
      const info = toErrorInfo(settled.error)
      const error = info.code === 'internal' ? { ...info, code: 'tool/failed' as const } : info
      return { content: `Error: ${info.message}`, isError: true, error }
    }
    const value = settled.value
    if (value === null || typeof value !== 'object' || typeof value.content !== 'string') {
      return failure('tool/failed', `${definition.name} returned an invalid result`)
    }
    const isError = value.isError === true
    return {
      content: value.content,
      isError,
      ...(isError ? { error: errorInfo('tool/failed', value.content.slice(0, 500)) } : {}),
      ...(value.meta !== undefined && isJsonValue(value.meta) ? { meta: value.meta } : {}),
    }
  }

  /**
   * Check a tool record against its call: `turn` must be the call's (an
   * optional `turn` left out is stamped); `step` and `toolCallId`, where the
   * type has them, must be the call's (`deliverable.presented` must carry
   * all three).
   */
  /** Step 4: what a tool record tells the task (a tried draft's use, a presented deliverable's files). */
  private noteToolRecord(record: SessionRecord): void {
    if (record.type === 'capability.try') this.loadComponent({ ...record.component, ...(record.tools === undefined ? {} : { tools: record.tools }) }, 'draft')
    if (record.type === 'deliverable.presented') this.init.tree.present(record.deliverable.deliverableId, record.deliverable.files.map(file => file.path))
  }

  private toolRecord(record: ToolRecordInput, call: { turn: number; step: number; toolCallId: string }): ToolRecordInput {
    const fields = record as { turn?: unknown; step?: unknown; toolCallId?: unknown }
    const strict = record.type === 'deliverable.presented'
    const turnOk = fields.turn === call.turn || (fields.turn === undefined && (record.type === 'team.member' || record.type === 'team.task' || record.type === 'team.message'))
    const stepOk = fields.step === call.step || (!strict && fields.step === undefined)
    const idOk = fields.toolCallId === call.toolCallId || (!strict && fields.toolCallId === undefined)
    if (!turnOk || !stepOk || !idOk) {
      throw new NexgentError('session/invalid-record', `${record.type} must carry this call's turn ${call.turn}${strict ? `, step ${call.step} and toolCallId ${call.toolCallId}` : ' (and its step and toolCallId where it has them)'}`)
    }
    return (fields.turn === undefined ? { ...record, turn: call.turn } : record) as ToolRecordInput
  }

  /** Grant check → approval request → records; see `permissions.md` §工具审批. */
  private authorize(turn: number, call: ToolCall, definition: ToolDefinition, ask: ToolApprovalAsk, signal: AbortSignal): Promise<Authorization> {
    // One question at a time; a grant given for an earlier question answers a later one without asking.
    const next = this.approvalQueue.then(() => this.authorizeNow(turn, call, definition, ask, signal))
    this.approvalQueue = next.catch(() => {})
    return next
  }

  private async authorizeNow(turn: number, call: ToolCall, definition: ToolDefinition, ask: ToolApprovalAsk, signal: AbortSignal): Promise<Authorization> {
    const risk = ask.risk ?? 'medium'
    const subject = ask.subject ?? { kind: 'other' as const, value: ask.summary }
    const grantTool = ask.grantTool ?? definition.name
    if (risk !== 'high') {
      const sessionGrant = this.sessionGrants.find(grant => grantMatches(grant, grantTool, subject))
      if (sessionGrant !== undefined) return { allowed: true, cancelled: false, approval: { required: true, decision: 'auto', scope: 'session' } }
      const projectGrant = this.init.tree.projectGrants.find(grant => grantMatches(grant, grantTool, subject))
      if (projectGrant !== undefined) return { allowed: true, cancelled: false, approval: { required: true, decision: 'auto', scope: 'project' } }
    }
    const key = `${definition.name}\u0000${subject.value}`
    if (this.turnDenials.has(key)) {
      return { allowed: false, cancelled: false, approval: { required: true, decision: 'deny' } }
    }

    const writer = this.init.projectGrantWriter()
    let options: readonly ApprovalScope[] = risk === 'high' ? ['once'] : (ask.options ?? ['once', 'session', 'project'])
    if (writer === undefined) options = options.filter(scope => scope !== 'project')
    if (options.length === 0) options = ['once']
    const pattern = ask.pattern ?? derivePattern(subject)
    const timeoutMs = this.init.approvals.timeoutMs
    const request: ApprovalRequest = {
      id: randomUUID(),
      sessionId: this.sessionId,
      callId: call.id,
      tool: definition.name,
      summary: ask.summary.split('\n')[0]!.slice(0, 500),
      detail: ask.detail ?? `cwd: ${this.init.workspace.root}\nsandbox: ${this.sandboxMode}\neffects: ${definition.effects.join(', ') || 'none'}`,
      risk,
      options,
      ...(pattern === undefined ? {} : { pattern }),
      ...(timeoutMs === undefined ? {} : { expiresAt: new Date(Date.now() + timeoutMs).toISOString() }),
      // A member asks under the main conversation's rules; the host names the member in the prompt.
      ...(this.member === undefined || this.parentSessionId === undefined
        ? {}
        : { member: { name: this.member.name, executionForm: this.member.executionForm, parentSessionId: this.parentSessionId } }),
    }
    await this.append({ type: 'approval.request', turn, request })
    this.emit({ type: 'approval.request', sessionId: this.sessionId, turn, request })
    const decision: ApprovalDecision = await this.init.approvals.request(request, signal)
    await this.append({ type: 'approval.decision', turn, decision })
    this.emit({ type: 'approval.decision', sessionId: this.sessionId, turn, decision })

    if (decision.decision === 'allow') {
      const grant: ApprovalGrant = { tool: grantTool, ...(pattern === undefined ? {} : { pattern }), grantedAt: new Date().toISOString() }
      if (decision.scope === 'session') {
        await this.append({ type: 'approval.grant', grant })
        this.sessionGrants.push(grant)
      } else if (decision.scope === 'project' && writer !== undefined) {
        try {
          await writer(grant, { sessionId: this.sessionId, projectRoot: this.init.workspace.root })
          this.init.tree.projectGrants.push(grant)
        } catch (error) {
          await this.appendError(toErrorInfo(error), false, turn)
        }
      }
      return { allowed: true, cancelled: false, approval: { required: true, decision: 'allow', scope: decision.scope, requestId: request.id } }
    }
    this.turnDenials.add(key)
    const mapped = decision.decidedBy === 'timeout' ? 'timeout' : decision.decidedBy === 'cancel' ? 'cancel' : 'deny'
    return {
      allowed: false,
      cancelled: decision.decidedBy === 'cancel' && signal.aborted,
      approval: { required: true, decision: mapped, requestId: request.id },
    }
  }
}
