/**
 * The event stream the CLI renders. It is the LLM contract's stream events
 * (re-used verbatim) plus the agent-level facts the loop adds: session open,
 * turn and step boundaries, tool execution, approvals and errors.
 *
 * SEAM: the kernel's agent loop has its own event shape; the integrator maps
 * it onto {@link CliEvent} in `runtime.ts`. Nothing else in the CLI depends on
 * the kernel's loop types.
 */
import type {
  ApprovalDecision,
  CommandSandboxStatus,
  ApprovalRequest,
  ErrorInfo,
  LLMUsage,
  MemberExecutionForm,
  ReasoningDeltaEvent,
  SandboxMode,
  TextDeltaEvent,
  ToolCallDeltaEvent,
  ToolCallEndEvent,
  ToolCallStartEvent,
  TurnEndReason,
  UsageEvent,
} from '@nexgent/kernel'

/** The session the run is attached to; the first event of every run. */
export interface SessionOpenEvent {
  readonly type: 'session'
  readonly sessionId: string
  readonly projectRoot: string
  readonly model: string
  readonly sandboxMode: SandboxMode
  /** ADR 0022: the session started in plan mode and no plan was approved yet. */
  readonly plan?: boolean
  /** ADR 0022: whether commands run in an OS sandbox (from the session header). */
  readonly commandSandbox?: CommandSandboxStatus
  /** `true` for `nexgent resume`. */
  readonly resumed: boolean
}

/** A turn began (mirrors the `turn.start` session record). */
export interface TurnStartEvent {
  readonly type: 'turn.start'
  readonly turn: number
}

/** A model request began: one step = one request (mirrors `assistant.message.step`). */
export interface StepStartEvent {
  readonly type: 'step.start'
  readonly turn: number
  readonly step: number
  readonly requestId: string
}

/** The step's model request failed retryably and is sent again after `delayMs` (ADR 0021). */
export interface StepRetryEvent {
  readonly type: 'step.retry'
  readonly turn: number
  readonly step: number
  /** The attempt about to be sent (2 for the first retry). */
  readonly attempt: number
  readonly delayMs: number
  readonly error: ErrorInfo
}

/** A tool handler is about to run (after approval). */
export interface ToolStartEvent {
  readonly type: 'tool.start'
  readonly callId: string
  readonly name: string
  /** Raw JSON arguments as the model produced them. */
  readonly arguments: string
}

/** A tool call settled (mirrors the `tool.result` session record). */
export interface ToolEndEvent {
  readonly type: 'tool.end'
  readonly callId: string
  readonly name: string
  readonly isError: boolean
  /** Model-facing content. */
  readonly content: string
  readonly durationMs: number
}

/** An approval question was raised (the TTY prompt shows it separately). */
export interface ApprovalRequestEvent {
  readonly type: 'approval.request'
  readonly request: ApprovalRequest
}

/** An approval question was answered. */
export interface ApprovalDecisionEvent {
  readonly type: 'approval.decision'
  readonly decision: ApprovalDecision
}

/** A turn ended (mirrors the `turn.end` session record). The last event of a turn. */
export interface TurnEndEvent {
  readonly type: 'turn.end'
  readonly turn: number
  readonly reason: TurnEndReason
}

/** A failure outside a turn's own `turn.end` (e.g. a ledger write failure). */
export interface RunErrorEvent {
  readonly type: 'run.error'
  readonly error: ErrorInfo
  readonly fatal: boolean
}

/** One deliverable version a member presented (the parts the terminal shows). */
export interface MemberDeliverable {
  readonly deliverableId: string
  readonly version: number
  readonly title: string
  readonly files: readonly string[]
}

/** Step 3: a member (delegate, workflow member, thread) began a run in this session's turn. */
export interface MemberStartEvent {
  readonly type: 'member.start'
  readonly childSessionId: string
  readonly name: string
  readonly executionForm: MemberExecutionForm
  readonly preset?: string
}

/** Step 3: a member run settled, with what it presented. */
export interface MemberEndEvent {
  readonly type: 'member.end'
  readonly childSessionId: string
  readonly name: string
  readonly executionForm: MemberExecutionForm
  /** `completed`, `failed`, `cancelled`, `budget` or `interrupted`. */
  readonly status: string
  readonly deliverables: readonly MemberDeliverable[]
  readonly usage?: LLMUsage
  readonly error?: ErrorInfo
}

/** LLM stream events forwarded as-is; terminal `done` / `error` are folded into `turn.end` / `run.error` by the mapper. */
export type ForwardedLLMEvent =
  | TextDeltaEvent
  | ReasoningDeltaEvent
  | ToolCallStartEvent
  | ToolCallDeltaEvent
  | ToolCallEndEvent
  | UsageEvent

/** Rework D3: spending crossed 80% of a cost cap (`warning`) or met it (`reached`). */
export interface CostWarningEvent {
  readonly type: 'cost.warning'
  readonly turn: number
  readonly scope: 'perTask' | 'perConversation' | 'perProject'
  readonly level: 'warning' | 'reached'
  readonly limit: 'maxUsd' | 'maxTokens' | 'maxRequests'
  readonly used: number
  readonly cap: number
  readonly estimated: boolean
}

/** Everything the renderer and the task tally consume. */
export type CliEvent =
  | SessionOpenEvent
  | TurnStartEvent
  | StepStartEvent
  | StepRetryEvent
  | CostWarningEvent
  | ForwardedLLMEvent
  | ToolStartEvent
  | ToolEndEvent
  | ApprovalRequestEvent
  | ApprovalDecisionEvent
  | MemberStartEvent
  | MemberEndEvent
  | TurnEndEvent
  | RunErrorEvent

/** The `type` tags of {@link CliEvent}. */
export type CliEventType = CliEvent['type']

/** Usage helper re-exported for mappers. */
export type { LLMUsage }
