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
  ApprovalRequest,
  ErrorInfo,
  LLMUsage,
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

/** LLM stream events forwarded as-is; terminal `done` / `error` are folded into `turn.end` / `run.error` by the mapper. */
export type ForwardedLLMEvent =
  | TextDeltaEvent
  | ReasoningDeltaEvent
  | ToolCallStartEvent
  | ToolCallDeltaEvent
  | ToolCallEndEvent
  | UsageEvent

/** Everything the renderer and the task tally consume. */
export type CliEvent =
  | SessionOpenEvent
  | TurnStartEvent
  | StepStartEvent
  | ForwardedLLMEvent
  | ToolStartEvent
  | ToolEndEvent
  | ApprovalRequestEvent
  | ApprovalDecisionEvent
  | TurnEndEvent
  | RunErrorEvent

/** The `type` tags of {@link CliEvent}. */
export type CliEventType = CliEvent['type']

/** Usage helper re-exported for mappers. */
export type { LLMUsage }
