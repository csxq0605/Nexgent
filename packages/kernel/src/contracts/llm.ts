/**
 * The model-provider contract: one stream-first request API, the message
 * vocabulary the loop and the session log share, and token accounting that
 * can say "unknown" instead of inventing zeros.
 *
 * Step 1 wires exactly one OpenAI-compatible route (MiMo) behind this
 * interface; there is no provider registry and no retry layer (`maxRetries`
 * is 0 by decision — every attempt, including a failed one, is one request
 * and one ledger record).
 */
import type { ErrorInfo } from './errors.js'
import type { JsonSchema } from './json.js'

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** The four roles a request message may carry. */
export type LLMRole = 'system' | 'user' | 'assistant' | 'tool'

/** The system prompt. The loop puts exactly one at index 0 of a request. */
export interface SystemMessage {
  readonly role: 'system'
  /** Rendered prompt text. */
  readonly content: string
}

/** A user turn, or a synthetic context injection presented as the user. */
export interface UserMessage {
  readonly role: 'user'
  /** Plain text; step 1 has no image or file blocks. */
  readonly content: string
}

/** A tool invocation requested by the model. */
export interface ToolCall {
  /** Provider-issued call id; pairs the call with its {@link ToolResult}. */
  readonly id: string
  /** Registered tool name. */
  readonly name: string
  /** Raw JSON text exactly as the model produced it; parsed by the registry, not the provider. */
  readonly arguments: string
}

/** The model's reply for one step: visible text plus any tool calls. */
export interface AssistantMessage {
  readonly role: 'assistant'
  /** Visible text (may be empty when the step only calls tools). */
  readonly content: string
  /** Tool calls in the order the model emitted them; absent when there are none. */
  readonly toolCalls?: readonly ToolCall[]
}

/** The outcome of one tool call, returned to the model as a `tool` message. */
export interface ToolResult {
  /** The {@link ToolCall.id} this result answers. */
  readonly toolCallId: string
  /** Tool name, repeated for providers that require it on the tool message. */
  readonly name: string
  /** Model-facing text (or the rendered error text on failure). */
  readonly content: string
  /** Whether the call failed; the content then explains why. */
  readonly isError: boolean
}

/** A tool result on the conversation surface. */
export interface ToolMessage extends ToolResult {
  readonly role: 'tool'
}

/** Any message a request may carry. */
export type LLMMessage = SystemMessage | UserMessage | AssistantMessage | ToolMessage

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

/** A tool definition as the model sees it (name, description, input schema only). */
export interface LLMToolDefinition {
  /** Registered tool name; must be unique within one request. */
  readonly name: string
  /** What the tool does, for the model. */
  readonly description: string
  /** JSON Schema for the arguments object. */
  readonly parameters: JsonSchema
}

/** Whether the provider should produce reasoning tokens. Execution uses `'off'` (ADR 0001 decision 5). */
export type ThinkingMode = 'off' | 'on'

/** One fully assembled model request. */
export interface LLMRequest {
  /** Caller-generated id (uuid) that correlates stream, session and ledger records. */
  readonly requestId: string
  /** Model id passed to the endpoint, e.g. `mimo-v2.6-pro`. */
  readonly model: string
  /** Ordered conversation exactly as the provider should see it. */
  readonly messages: readonly LLMMessage[]
  /** Tools the model may call; absent or empty disables tool calling. */
  readonly tools?: readonly LLMToolDefinition[]
  /** Output token cap; the provider's default applies when absent. */
  readonly maxTokens?: number
  /** Sampling temperature; the provider's default applies when absent. */
  readonly temperature?: number
  /** Reasoning on or off. */
  readonly thinking: ThinkingMode
  /** Caller cancellation; the stream ends with `done`/`aborted` promptly after it fires. */
  readonly signal?: AbortSignal
}

/** Why a request was made; the ledger keeps it so auxiliary calls are separable from task work. */
export type LLMRequestPurpose = 'task' | 'auxiliary'

/** Per-call options that are not part of the request the model sees. */
export interface LLMCompleteOptions {
  /** Session the request belongs to; stamped on ledger records. */
  readonly sessionId?: string
  /** Classification for the ledger; defaults to `'task'`. */
  readonly purpose?: LLMRequestPurpose
  /** Whole-request deadline in ms (connect + stream). */
  readonly timeoutMs?: number
  /** Max silence between stream chunks in ms before the request is failed with `llm/timeout`. */
  readonly streamIdleTimeoutMs?: number
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

/** A token count the provider reported, or `'unknown'` when it did not. Never a made-up 0. */
export type UsageCount = number | 'unknown'

/**
 * Token accounting for one request. Every field is required so that a
 * missing provider value must be written down as `'unknown'` explicitly.
 * `inputTokens` excludes cached input; billed input = input + cacheRead.
 */
export interface LLMUsage {
  /** Uncached prompt tokens. */
  readonly inputTokens: UsageCount
  /** Completion tokens, including reasoning tokens when the provider folds them in. */
  readonly outputTokens: UsageCount
  /** Provider-reported total; `'unknown'` unless the provider gave one. */
  readonly totalTokens: UsageCount
  /** Prompt tokens served from the provider's cache. */
  readonly cacheReadTokens: UsageCount
  /** Reasoning tokens when reported separately. */
  readonly reasoningTokens: UsageCount
}

/** A usage record in which nothing is known. */
export const UNKNOWN_USAGE: LLMUsage = Object.freeze({
  inputTokens: 'unknown',
  outputTokens: 'unknown',
  totalTokens: 'unknown',
  cacheReadTokens: 'unknown',
  reasoningTokens: 'unknown',
}) as LLMUsage

/** A usage record of all zeros: the identity element of {@link addUsage}. */
export const ZERO_USAGE: LLMUsage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  cacheReadTokens: 0,
  reasoningTokens: 0,
}) as LLMUsage

/**
 * Add two counts; `'unknown'` is absorbing (unknown + anything = unknown),
 * so a sum is only a number when every addend was reported.
 */
export function addUsageCount(a: UsageCount, b: UsageCount): UsageCount {
  if (a === 'unknown' || b === 'unknown') return 'unknown'
  return a + b
}

/**
 * Sum usage records field by field with {@link addUsageCount} semantics.
 * Summing zero records yields {@link ZERO_USAGE}.
 * @param usages - the records to total.
 */
export function addUsage(...usages: readonly LLMUsage[]): LLMUsage {
  let total: LLMUsage = ZERO_USAGE
  for (const usage of usages) {
    total = {
      inputTokens: addUsageCount(total.inputTokens, usage.inputTokens),
      outputTokens: addUsageCount(total.outputTokens, usage.outputTokens),
      totalTokens: addUsageCount(total.totalTokens, usage.totalTokens),
      cacheReadTokens: addUsageCount(total.cacheReadTokens, usage.cacheReadTokens),
      reasoningTokens: addUsageCount(total.reasoningTokens, usage.reasoningTokens),
    }
  }
  return total
}

/** Whether every field of a usage record is a reported number. */
export function isUsageKnown(usage: LLMUsage): usage is LLMUsage & Record<keyof LLMUsage, number> {
  return (
    usage.inputTokens !== 'unknown'
    && usage.outputTokens !== 'unknown'
    && usage.totalTokens !== 'unknown'
    && usage.cacheReadTokens !== 'unknown'
    && usage.reasoningTokens !== 'unknown'
  )
}

/**
 * Normalize a raw provider count: a non-negative safe integer passes through,
 * anything else (missing, negative, fractional, NaN) becomes `'unknown'`.
 */
export function toUsageCount(value: unknown): UsageCount {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 'unknown'
}

// ---------------------------------------------------------------------------
// Stream
// ---------------------------------------------------------------------------

/** Why generation stopped. `'error'` only appears on ledger records; the stream signals it with an `error` event. */
export type FinishReason = 'stop' | 'tool-calls' | 'max-tokens' | 'aborted' | 'error'

/** A chunk of visible text. */
export interface TextDeltaEvent {
  readonly type: 'text.delta'
  readonly text: string
}

/** A chunk of reasoning text (only when `thinking: 'on'`); never persisted to the session. */
export interface ReasoningDeltaEvent {
  readonly type: 'reasoning.delta'
  readonly text: string
}

/** The model began tool call number `index` (0-based, per request). */
export interface ToolCallStartEvent {
  readonly type: 'tool-call.start'
  readonly index: number
  /** Provider-issued call id. */
  readonly id: string
  /** Tool name; known at start on every supported wire format. */
  readonly name: string
}

/** More raw argument JSON for tool call `index`. */
export interface ToolCallDeltaEvent {
  readonly type: 'tool-call.delta'
  readonly index: number
  readonly argumentsDelta: string
}

/** Tool call `index` is complete; `call.arguments` is the concatenated raw JSON. */
export interface ToolCallEndEvent {
  readonly type: 'tool-call.end'
  readonly index: number
  readonly call: ToolCall
}

/** Token accounting; emitted at most once, before the terminal event. */
export interface UsageEvent {
  readonly type: 'usage'
  readonly usage: LLMUsage
}

/** Terminal success event. Nothing follows it. */
export interface DoneEvent {
  readonly type: 'done'
  /** Why the model stopped; `'aborted'` when the caller's signal fired mid-stream. */
  readonly finishReason: Exclude<FinishReason, 'error'>
}

/** Terminal failure event. Nothing follows it; the provider does not also throw. */
export interface StreamErrorEvent {
  readonly type: 'error'
  readonly error: ErrorInfo
  /** HTTP status when the failure was an HTTP response. */
  readonly httpStatus?: number
  /** Provider-side request id for support tickets, when the response carried one. */
  readonly providerRequestId?: string
}

/**
 * The stream a provider yields for one request.
 *
 * Invariants an implementation must keep:
 * 1. exactly one terminal event (`done` or `error`), and it is the last event;
 * 2. `usage` appears at most once, before the terminal event; when it is
 *    absent the consumer records {@link UNKNOWN_USAGE};
 * 3. every `tool-call.delta` is preceded by the matching `tool-call.start`
 *    and followed by exactly one `tool-call.end`; a stream that ends before
 *    `tool-call.end` drops that call;
 * 4. abort is reported as `done` with `finishReason: 'aborted'`; text already
 *    yielded stays valid;
 * 5. the provider never throws out of the iterator for a request-level
 *    failure — it yields `error`. Throwing is reserved for programmer errors.
 */
export type LLMStreamEvent =
  | TextDeltaEvent
  | ReasoningDeltaEvent
  | ToolCallStartEvent
  | ToolCallDeltaEvent
  | ToolCallEndEvent
  | UsageEvent
  | DoneEvent
  | StreamErrorEvent

/** The `type` tag vocabulary of {@link LLMStreamEvent}. */
export type LLMStreamEventType = LLMStreamEvent['type']

/** Whether an event ends the stream. */
export function isTerminalEvent(event: LLMStreamEvent): event is DoneEvent | StreamErrorEvent {
  return event.type === 'done' || event.type === 'error'
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/** Static facts about the route a provider instance talks to; stamped on ledger records. */
export interface LLMProviderInfo {
  /** Route key, e.g. `mimo`. */
  readonly id: string
  /** Endpoint base URL without credentials, e.g. `https://token-plan-cn.xiaomimimo.com/v1`. */
  readonly endpoint: string
  /** Model id used when a request does not override it. */
  readonly defaultModel: string
}

/** The service the agent loop (and only the agent loop) calls to talk to a model. */
export interface LLMProvider {
  /** Route facts. */
  readonly info: LLMProviderInfo
  /**
   * Send one request and stream its events. The iterable is single-use and
   * lazy: nothing is sent until iteration starts. Returning early from the
   * loop (`break`) aborts the request. No retries happen inside.
   * @param request - the assembled request.
   * @param options - ledger and timeout options.
   */
  complete(request: LLMRequest, options?: LLMCompleteOptions): AsyncIterable<LLMStreamEvent>
}
