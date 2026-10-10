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
import type { ProjectConfig } from './contracts/config.js'
import { NexgentError, toErrorInfo, type ErrorInfo, type NexgentErrorCode } from './contracts/errors.js'
import { isJsonValue, type JsonValue } from './contracts/json.js'
import type { Ledger, LedgerRecordInput, TaskCheck, TaskOutcomeStatus } from './contracts/ledger.js'
import {
  addUsage,
  UNKNOWN_USAGE,
  ZERO_USAGE,
  type Effort,
  type FinishReason,
  type LLMMessage,
  type LLMProvider,
  type LLMRequest,
  type LLMStreamEvent,
  type LLMUsage,
  type RefusalInfo,
  type ToolCall,
  type ToolResult,
} from './contracts/llm.js'
import type {
  SessionLock,
  SessionRecord,
  SessionRecordInput,
  SessionStore,
  TurnCancelCause,
  TurnEndReason,
} from './contracts/session.js'
import type { Tool, ToolContext, ToolDefinition, ToolOutput, ToolRegistry } from './contracts/tools.js'
import type { SandboxMode, Workspace } from './contracts/workspace.js'
import { AgentEventHub, type AgentEvent, type AgentEventListener } from './agent-events.js'
import {
  approvalSubject,
  decideToolPolicy,
  derivePattern,
  grantMatches,
  type ApprovalSubject,
} from './approval-policy.js'
import { validateJsonSchema } from './json-schema.js'
import { renderSystemPrompt, type SystemPromptTemplate } from './system-prompt.js'
import { abortPromise, deadline, timeoutOf, TimeoutReason } from './util/timeout.js'

/** Timeout code of the kernel's whole-request model deadline. */
export const MODEL_TIMEOUT = 'MODEL_TIMEOUT'
/** Timeout code of the kernel's stream-idle watchdog. */
export const MODEL_IDLE_TIMEOUT = 'MODEL_IDLE_TIMEOUT'
/** Timeout code of a tool's declared `timeoutMs`. */
export const TOOL_TIMEOUT = 'TOOL_TIMEOUT'

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
  /** Max model calls in one turn. */
  readonly maxSteps: number
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
  requestApproval(ask: ToolApprovalAsk): Promise<boolean>
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
  readonly settings: AgentSettings
  readonly projectConfig: ProjectConfig
  readonly history: readonly Exclude<LLMMessage, { role: 'system' }>[]
  readonly lastTurn: number
  readonly lastSeq: number
  readonly lastCheckpointSeq: number
  readonly sessionGrants: readonly ApprovalGrant[]
  readonly projectGrantWriter: () => ProjectGrantWriter | undefined
  readonly onClose: (agent: Agent) => void
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

interface Authorization {
  readonly allowed: boolean
  readonly approval: ToolCallApproval
  readonly cancelled: boolean
}

/** A live agent bound to one locked session. Created by `ctx.agents.create` / `resume`. */
export class Agent {
  /** The session id; also the agent id. */
  readonly sessionId: string
  /** The agent's scoped Cordis context: `agent.ctx.tools.register()` adds agent-private tools. */
  readonly ctx: Context
  /** Model id requests use. */
  readonly model: string
  /** Sandbox mode in force. */
  readonly sandboxMode: SandboxMode

  private readonly init: AgentInit
  private readonly hub = new AgentEventHub()
  private readonly messages: Exclude<LLMMessage, { role: 'system' }>[]
  private readonly sessionGrants: ApprovalGrant[]
  private readonly projectGrants: ApprovalGrant[]
  private lastTurn: number
  private lastSeq: number
  private lastCheckpointSeq: number
  private running: { controller: AbortController; done: Promise<unknown> } | undefined
  private closed = false
  private outcomeWritten = false
  private lastReason: TurnEndReason | undefined
  private budgetError: ErrorInfo | undefined
  private turnDenials = new Set<string>()
  private stats = {
    requestCount: 0,
    toolCallCount: 0,
    turns: 0,
    totalUsage: ZERO_USAGE as LLMUsage,
    tokens: 0,
    toolsUsed: new Set<string>(),
  }

  constructor(init: AgentInit) {
    this.init = init
    this.sessionId = init.sessionId
    this.ctx = init.ctx
    this.model = init.model
    this.sandboxMode = init.sandboxMode
    this.messages = [...init.history]
    this.sessionGrants = [...init.sessionGrants]
    this.projectGrants = [...init.projectConfig.approvals]
    this.lastTurn = init.lastTurn
    this.lastSeq = init.lastSeq
    this.lastCheckpointSeq = init.lastCheckpointSeq
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

  /** The system prompt the next request would carry. */
  systemPrompt(): string {
    return renderSystemPrompt({
      template: this.init.settings.systemPrompt,
      model: this.model,
      cwd: this.init.workspace.root,
      sandboxMode: this.sandboxMode,
      platform: process.platform,
      tools: this.init.tools.list(),
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
  async run(input: string, options: RunOptions = {}): Promise<TurnResult> {
    if (this.closed) throw new NexgentError('internal', `agent ${this.sessionId} is closed`)
    if (this.running !== undefined) throw new NexgentError('internal', `agent ${this.sessionId} is already running a turn`)
    const controller = new AbortController()
    const onExternal = () => controller.abort(new TurnAbort('user'))
    if (options.signal?.aborted === true) onExternal()
    options.signal?.addEventListener('abort', onExternal, { once: true })
    const done = this.runTurn(input, controller.signal)
    this.running = { controller, done }
    try {
      return await done
    } finally {
      this.running = undefined
      options.signal?.removeEventListener('abort', onExternal)
    }
  }

  /** Cancel the running turn, if any. Streamed text is kept; running tools are aborted. */
  cancel(cause: TurnCancelCause = 'user'): void {
    this.running?.controller.abort(new TurnAbort(cause))
  }

  /**
   * End the task: cancel a running turn (cause `shutdown`), write the
   * `task.outcome` ledger record (unless already written or no turn ran),
   * release the session lock and dispose the agent's scope. Idempotent.
   */
  async close(options: CloseOptions = {}): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.running !== undefined) {
      this.running.controller.abort(new TurnAbort('shutdown'))
      await this.running.done.catch(() => undefined)
    }
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

  private async append(record: SessionRecordInput): Promise<SessionRecord> {
    const written = await this.init.session.append(this.sessionId, record)
    this.lastSeq = written.seq
    if (written.type === 'checkpoint') this.lastCheckpointSeq = written.seq
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

  private async writeOutcome(status: TaskOutcomeStatus, checks?: readonly TaskCheck[]): Promise<void> {
    this.outcomeWritten = true
    const error = status === 'completed'
      ? undefined
      : this.budgetError ?? (this.lastReason?.kind === 'error' ? this.lastReason.error : undefined)
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
    })
  }

  // -------------------------------------------------------------------------
  // turn
  // -------------------------------------------------------------------------

  private async runTurn(input: string, signal: AbortSignal): Promise<TurnResult> {
    const turn = ++this.lastTurn
    this.turnDenials = new Set()
    this.stats.turns += 1
    await this.append({ type: 'turn.start', turn })
    this.emit({ type: 'turn.start', sessionId: this.sessionId, turn })
    await this.append({ type: 'user.message', turn, content: input, source: 'user' })
    this.messages.push({ role: 'user', content: input })

    const tracker = { text: '', usage: ZERO_USAGE as LLMUsage }
    let reason: TurnEndReason
    try {
      reason = await this.loop(turn, signal, tracker)
    } catch (error) {
      reason = { kind: 'error', error: toErrorInfo(error) }
    }
    await this.append({ type: 'turn.end', turn, reason })
    this.lastReason = reason
    this.emit({ type: 'turn.end', sessionId: this.sessionId, turn, reason })
    await this.maybeCheckpoint()
    if (reason.kind === 'cancelled' && reason.cause === 'cost-cap' && !this.outcomeWritten) {
      await this.writeOutcome('cancelled')
    }
    return { sessionId: this.sessionId, turn, reason, text: tracker.text, usage: tracker.usage }
  }

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

  /** The cost-cap error when the next request would exceed `costCaps.perTask`. */
  private budgetExhausted(): ErrorInfo | undefined {
    const cap = this.init.projectConfig.costCaps.perTask
    if (cap === undefined) return undefined
    const check = (metric: 'requests' | 'tokens', used: number, limit: number | undefined) => limit !== undefined && used >= limit
      ? errorInfo('budget/exhausted', `per-task ${metric} cap reached (${used} of ${limit})`, { scope: 'task', metric, used, limit })
      : undefined
    return check('requests', this.stats.requestCount, cap.maxRequests) ?? check('tokens', this.stats.tokens, cap.maxTokens)
  }

  private async loop(turn: number, signal: AbortSignal, tracker: { text: string; usage: LLMUsage }): Promise<TurnEndReason> {
    for (let step = 1; ; step += 1) {
      if (signal.aborted) return { kind: 'cancelled', cause: causeOf(signal) }
      const exhausted = this.budgetExhausted()
      if (exhausted !== undefined) {
        this.budgetError = exhausted
        await this.appendError(exhausted, false, turn)
        return { kind: 'cancelled', cause: 'cost-cap' }
      }
      if (step > this.init.settings.maxSteps) {
        return { kind: 'error', error: errorInfo('internal', `turn exceeded ${this.init.settings.maxSteps} model calls`) }
      }

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
      if (outcome.finish === 'error') return { kind: 'error', error: outcome.error ?? errorInfo('llm/request-failed', 'model request failed') }
      // A refused reply ends the turn; its tool calls are never run (ADR 0002).
      if (outcome.finish === 'refusal') return { kind: 'error', error: refusalError(outcome.refusal) }
      // A reply cut by the output cap may carry truncated tool input; do not run it.
      if (outcome.finish === 'max-tokens') return { kind: 'max-tokens' }
      if (toolCalls.length > 0) {
        await this.runTools(turn, step, toolCalls, signal)
        continue
      }
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
    this.stats.requestCount += 1
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
      iterator = llm.complete(request, {
        sessionId: this.sessionId,
        purpose: 'task',
        ...(settings.modelTimeoutMs > 0 ? { timeoutMs: settings.modelTimeoutMs } : {}),
        ...(settings.streamIdleTimeoutMs > 0 ? { streamIdleTimeoutMs: settings.streamIdleTimeoutMs } : {}),
      })[Symbol.asyncIterator]()
      for (;;) {
        let idleTimer: ReturnType<typeof setTimeout> | undefined
        const idle = settings.streamIdleTimeoutMs > 0
          ? new Promise<{ kind: 'idle' }>(resolve => {
            idleTimer = setTimeout(() => resolve({ kind: 'idle' }), settings.streamIdleTimeoutMs)
          })
          : new Promise<never>(() => {})
        const next = iterator.next().then(
          result => ({ kind: 'next' as const, result }),
          (thrown: unknown) => ({ kind: 'throw' as const, thrown }),
        )
        const raced = await Promise.race([next, stopped, idle])
        if (idleTimer !== undefined) clearTimeout(idleTimer)
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
    this.stats.totalUsage = addUsage(this.stats.totalUsage, reportedUsage)
    this.stats.tokens += knownTokens(reportedUsage)
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

  private async runTools(turn: number, step: number, calls: readonly ToolCall[], signal: AbortSignal): Promise<void> {
    for (const call of calls) {
      if (signal.aborted) {
        await this.writeToolResult(turn, step, call, {
          content: 'Error: the turn was cancelled before this call ran.',
          isError: true,
          error: errorInfo('tool/aborted', 'cancelled before the call ran'),
        }, 0)
        continue
      }
      await this.runTool(turn, step, call, signal)
    }
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

  private async runTool(turn: number, step: number, call: ToolCall, signal: AbortSignal): Promise<void> {
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

    await this.writeToolResult(turn, step, call, output, durationMs)
    this.stats.toolCallCount += 1
    this.stats.toolsUsed.add(call.name)
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
    }, turn)
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
    const verdict = decideToolPolicy(definition, this.sandboxMode)
    if (verdict.kind === 'deny') {
      setApproval({ required: false, decision: 'deny' })
      return failure('sandbox/denied', verdict.reason, { mode: this.sandboxMode, tool: definition.name })
    }
    let approved = false
    if (verdict.kind === 'ask') {
      const auth = await this.authorize(turn, call, definition, {
        summary: subject.value,
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
    const context: KernelToolContext = {
      sessionId: this.sessionId,
      callId: call.id,
      turn,
      workspace: this.init.workspace,
      sandboxMode: this.sandboxMode,
      signal: toolDeadline.signal,
      approved,
      requestApproval: async ask => {
        const auth = await this.authorize(turn, call, definition, ask, signal)
        setApproval(auth.approval)
        return auth.allowed
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
      toolDeadline.dispose()
      setDuration(Math.max(0, Math.round(performance.now() - started)))
    }

    const timeout = timeoutOf(toolDeadline.signal, TOOL_TIMEOUT)
    if (timeout !== undefined && !signal.aborted) {
      return failure('tool/timeout', `${definition.name} timed out after ${timeout.timeoutMs}ms`, { timeoutMs: timeout.timeoutMs })
    }
    if (signal.aborted) return failure('tool/aborted', `${definition.name} was cancelled`)
    if (settled === undefined) return failure('tool/aborted', `${definition.name} did not settle`)
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

  /** Grant check → approval request → records; see `permissions.md` §工具审批. */
  private async authorize(turn: number, call: ToolCall, definition: ToolDefinition, ask: ToolApprovalAsk, signal: AbortSignal): Promise<Authorization> {
    const risk = ask.risk ?? 'medium'
    const subject = ask.subject ?? { kind: 'other' as const, value: ask.summary }
    if (risk !== 'high') {
      const sessionGrant = this.sessionGrants.find(grant => grantMatches(grant, definition.name, subject))
      if (sessionGrant !== undefined) return { allowed: true, cancelled: false, approval: { required: true, decision: 'auto', scope: 'session' } }
      const projectGrant = this.projectGrants.find(grant => grantMatches(grant, definition.name, subject))
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
    }
    await this.append({ type: 'approval.request', turn, request })
    this.emit({ type: 'approval.request', sessionId: this.sessionId, turn, request })
    const decision: ApprovalDecision = await this.init.approvals.request(request, signal)
    await this.append({ type: 'approval.decision', turn, decision })
    this.emit({ type: 'approval.decision', sessionId: this.sessionId, turn, decision })

    if (decision.decision === 'allow') {
      const grant: ApprovalGrant = { tool: definition.name, ...(pattern === undefined ? {} : { pattern }), grantedAt: new Date().toISOString() }
      if (decision.scope === 'session') {
        await this.append({ type: 'approval.grant', grant })
        this.sessionGrants.push(grant)
      } else if (decision.scope === 'project' && writer !== undefined) {
        try {
          await writer(grant, { sessionId: this.sessionId, projectRoot: this.init.workspace.root })
          this.projectGrants.push(grant)
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
