/**
 * `AnthropicProvider`: the Claude Platform (Anthropic Messages API) route
 * behind the {@link LLMProvider} contract, via `@anthropic-ai/sdk`. One
 * `complete` call is one streaming request (`maxRetries: 0`) and exactly one
 * `llm.request.start` / `llm.request.end` ledger pair, whatever the outcome.
 */
import Anthropic, { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } from '@anthropic-ai/sdk'
import {
  DEFAULT_PROJECT_CONFIG,
  EFFORT_LEVELS,
  NEXGENT_API_KEY,
  NexgentError,
  toErrorInfo,
  UNKNOWN_USAGE,
  type Credentials,
  type Effort,
  type FinishReason,
  type Ledger,
  type LedgerAttribution,
  type LedgerRecordInput,
  type LLMCompleteOptions,
  type LLMProvider,
  type LLMProviderInfo,
  type LLMRequest,
  type LLMRequestStatus,
  type LLMStreamEvent,
  type LLMUsage,
  type NexgentErrorCode,
  type RefusalInfo,
  type StreamErrorEvent,
  type ToolCall,
} from '@nexgent/kernel'
import { redactSecrets, sanitizeUrl } from './redact.js'
import { normalizeUsage, type WireUsage } from './usage.js'
import { buildMessageParams, DEFAULT_WIRE_OPTIONS, FALLBACK_BETA, toJson, type WireOptions } from './wire.js'

/** Environment variable that overrides the endpoint base URL. */
export const NEXGENT_API_BASE_URL = 'NEXGENT_API_BASE_URL'
/** Environment variable the API key falls back to when the credential is unset. */
export const ANTHROPIC_API_KEY = 'ANTHROPIC_API_KEY'
/** Host of the Claude API; server-side fallbacks are only sent to it. */
export const CLAUDE_API_HOST = 'api.anthropic.com'

/** Default whole-request deadline (ms). */
export const DEFAULT_TIMEOUT_MS = 180_000
/** Default max silence between stream events (ms). */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 180_000

/** Server-side refusal fallback setting. */
export type FallbacksMode = 'default' | 'off'

/** Construction options for {@link AnthropicProvider}. */
export interface AnthropicProviderOptions {
  /** Where the API key comes from (`ctx.credentials`). */
  readonly credentials: Credentials
  /** Where request records go (`ctx.ledger`). */
  readonly ledger: Ledger
  /** Route key stamped on ledger records; default `anthropic`. */
  readonly id?: string
  /**
   * Base URL (SDK `baseURL`); default {@link DEFAULT_PROJECT_CONFIG}`.endpoint`.
   * The `NEXGENT_API_BASE_URL` environment variable overrides it.
   */
  readonly endpoint?: string
  /** Model used when a request names none; default {@link DEFAULT_PROJECT_CONFIG}`.model`. */
  readonly defaultModel?: string
  /** Credential name of the API key; default {@link NEXGENT_API_KEY}. `ANTHROPIC_API_KEY` in `env` is the fallback. */
  readonly apiKeyName?: string
  /** `output_config.effort` when a request names none; default `medium`. */
  readonly effort?: Effort
  /** `max_tokens` when a request names none; default 16000. */
  readonly maxTokens?: number
  /** Default whole-request deadline (ms); per-call `timeoutMs` wins. */
  readonly timeoutMs?: number
  /** Default stream idle deadline (ms); per-call `streamIdleTimeoutMs` wins. */
  readonly streamIdleTimeoutMs?: number
  /** Retries are fixed at 0 by decision; any other value is rejected. */
  readonly maxRetries?: 0
  /**
   * Server-side refusal fallbacks (`fallbacks: 'default'` + beta
   * `server-side-fallback-2026-07-01`); default `'default'`. Only sent when
   * the endpoint host is the Claude API (never to the fake server or a proxy).
   */
  readonly fallbacks?: FallbacksMode
  /** Environment for `NEXGENT_API_BASE_URL` and `ANTHROPIC_API_KEY`; default `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Ledger attribution stamped on every record (step 4; absent in step 1). */
  readonly attribution?: LedgerAttribution
  /** Replace the SDK's `fetch` (custom proxy dispatch, tests). */
  readonly fetch?: typeof fetch
}

/**
 * Per-call options: the contract's {@link LLMCompleteOptions} plus optional
 * ledger attribution that overrides the provider-level attribution.
 */
export interface CompleteOptions extends LLMCompleteOptions, LedgerAttribution {}

const ATTRIBUTION_KEYS = ['capabilityVersion', 'memberId', 'executionForm', 'taskId'] as const

function pickAttribution(...sources: (LedgerAttribution | undefined)[]): LedgerAttribution {
  const result: Record<string, string> = {}
  for (const source of sources) {
    if (source === undefined) continue
    for (const key of ATTRIBUTION_KEYS) {
      const value = source[key]
      if (value !== undefined) result[key] = value
    }
  }
  return result as LedgerAttribution
}

/** How the request settled, accumulated while streaming and written to `llm.request.end`. */
interface Outcome {
  status: LLMRequestStatus
  usage: LLMUsage
  httpStatus?: number
  finishReason?: FinishReason
  errorCode?: NexgentErrorCode
}

type AbortCause = 'caller' | 'timeout' | 'idle' | 'consumer'

class AbortReason extends Error {
  readonly kind: AbortCause
  constructor(kind: AbortCause) {
    super(`request ${kind}`)
    this.kind = kind
  }
}

type StreamFinishReason = Exclude<FinishReason, 'error' | 'aborted'>

/**
 * Map a wire `stop_reason` to the contract vocabulary. `stop_sequence` and
 * `pause_turn` map to `stop` (the turn ended; there is no contract value for
 * "paused"), `model_context_window_exceeded` to `max-tokens`, unknown values
 * to `stop`.
 * @param reason - the wire value.
 */
export function mapStopReason(reason: string): StreamFinishReason {
  switch (reason) {
    case 'tool_use':
      return 'tool-calls'
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'max-tokens'
    case 'refusal':
      return 'refusal'
    default:
      return 'stop'
  }
}

function positive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback
}

function causeCode(error: unknown): string | undefined {
  let current: unknown = error
  for (let depth = 0; depth < 6 && typeof current === 'object' && current !== null; depth++) {
    const code = (current as { code?: unknown }).code
    if (typeof code === 'string' && code !== '') return code
    current = (current as { cause?: unknown }).cause
  }
  return undefined
}

/** A connection that died mid-stream surfaces as a non-API error wrapping a socket failure. */
function looksLikeTransport(error: unknown): boolean {
  if (causeCode(error) !== undefined) return true
  const message = error instanceof Error ? error.message : ''
  return /terminated|fetch failed|socket|ECONN|network/i.test(message)
}

/** The stream events the provider reads, structurally (shared by the plain and the beta route). */
interface ContentBlockStart {
  readonly type: 'content_block_start'
  readonly index: number
  readonly content_block: { readonly type: string; readonly id?: string; readonly name?: string }
}
interface ContentBlockDelta {
  readonly type: 'content_block_delta'
  readonly index: number
  readonly delta: { readonly type: string; readonly text?: string; readonly thinking?: string; readonly partial_json?: string }
}
interface MessageDelta {
  readonly type: 'message_delta'
  readonly delta: { readonly stop_reason: string | null; readonly stop_details?: { readonly category?: string | null; readonly explanation?: string | null } | null }
  readonly usage: WireUsage
}
type WireEvent =
  | { readonly type: 'message_start'; readonly message: { readonly usage: WireUsage } }
  | ContentBlockStart
  | ContentBlockDelta
  | { readonly type: 'content_block_stop'; readonly index: number }
  | MessageDelta
  | { readonly type: 'message_stop' }

interface WireStream extends AsyncIterable<WireEvent> {
  readonly response: Response | null | undefined
  readonly request_id: string | null | undefined
  finalMessage(): Promise<{ readonly content: unknown; readonly model: string }>
}

interface PendingCall {
  readonly index: number
  readonly id: string
  readonly name: string
  args: string
}

/** The Claude Platform route. */
export class AnthropicProvider implements LLMProvider {
  readonly info: LLMProviderInfo
  private readonly baseURL: string
  private readonly fetch: typeof fetch | undefined
  private readonly credentials: Credentials
  private readonly ledger: Ledger
  private readonly apiKeyName: string
  private readonly env: Readonly<Record<string, string | undefined>>
  private readonly timeoutMs: number
  private readonly streamIdleTimeoutMs: number
  private readonly wire: WireOptions
  private readonly fallbacks: boolean
  private readonly attribution: LedgerAttribution

  constructor(options: AnthropicProviderOptions) {
    if (options.maxRetries !== undefined && options.maxRetries !== 0) {
      throw new NexgentError('config/invalid', 'maxRetries is fixed at 0 for this provider')
    }
    if (options.effort !== undefined && !EFFORT_LEVELS.includes(options.effort)) {
      throw new NexgentError('config/invalid', `effort must be one of ${EFFORT_LEVELS.join(', ')}`)
    }
    const env = options.env ?? process.env
    const override = env[NEXGENT_API_BASE_URL]?.trim()
    const endpoint = override !== undefined && override !== '' ? override : options.endpoint ?? DEFAULT_PROJECT_CONFIG.endpoint
    const parsed = URL.parse(endpoint)
    if (parsed === null || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
      throw new NexgentError('config/invalid', `endpoint is not an http(s) URL: ${sanitizeUrl(endpoint)}`)
    }
    this.info = Object.freeze({
      id: options.id ?? 'anthropic',
      endpoint: sanitizeUrl(endpoint),
      defaultModel: options.defaultModel ?? DEFAULT_PROJECT_CONFIG.model,
    })
    this.env = env
    this.credentials = options.credentials
    this.ledger = options.ledger
    this.apiKeyName = options.apiKeyName ?? NEXGENT_API_KEY
    this.timeoutMs = positive(options.timeoutMs, DEFAULT_TIMEOUT_MS)
    this.streamIdleTimeoutMs = positive(options.streamIdleTimeoutMs, DEFAULT_STREAM_IDLE_TIMEOUT_MS)
    this.wire = {
      effort: options.effort ?? DEFAULT_WIRE_OPTIONS.effort,
      maxTokens: positive(options.maxTokens, DEFAULT_WIRE_OPTIONS.maxTokens),
    }
    this.fallbacks = (options.fallbacks ?? 'default') === 'default' && parsed.hostname === CLAUDE_API_HOST
    this.attribution = pickAttribution(options.attribution)
    this.baseURL = endpoint.replace(/\/+$/, '')
    this.fetch = options.fetch
  }

  /**
   * One SDK client per request: the key is read from `Credentials` each time
   * and never kept in provider state. `maxRetries: 0` by decision.
   */
  private makeClient(apiKey: string, timeout: number): Anthropic {
    return new Anthropic({
      apiKey,
      baseURL: this.baseURL,
      maxRetries: 0,
      timeout,
      logLevel: 'off',
      ...this.fetch === undefined ? {} : { fetch: this.fetch },
    })
  }

  /** Read the key: the configured credential first, then `ANTHROPIC_API_KEY` from the environment. */
  private async readApiKey(): Promise<string> {
    let key: string | undefined
    try {
      key = await this.credentials.get(this.apiKeyName)
    } catch (error) {
      throw new NexgentError('credentials/missing', `could not read credential ${this.apiKeyName}: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (key === undefined || key === '') key = this.env[ANTHROPIC_API_KEY]?.trim()
    if (key === undefined || key === '') {
      throw new NexgentError('credentials/missing', `credential ${this.apiKeyName} is not set (environment variable or ~/.nexgent/credentials.json), nor is ${ANTHROPIC_API_KEY}`)
    }
    return key
  }

  /**
   * Stream one request. Lazy and single-use: the request (and the ledger
   * start record) happens when iteration starts.
   */
  complete(request: LLMRequest, options: CompleteOptions = {}): AsyncIterable<LLMStreamEvent> {
    return this.run(request, options)
  }

  private async *run(request: LLMRequest, options: CompleteOptions): AsyncGenerator<LLMStreamEvent> {
    const model = request.model === '' ? this.info.defaultModel : request.model
    const common = {
      ...options.sessionId === undefined ? {} : { sessionId: options.sessionId },
      ...pickAttribution(this.attribution, options),
      requestId: request.requestId,
      provider: this.info.id,
      endpoint: this.info.endpoint,
      model,
    }
    await this.append({ type: 'llm.request.start', ...common, purpose: options.purpose ?? 'task', thinking: request.thinking })
    const started = performance.now()
    const outcome: Outcome = { status: 'unknown', usage: UNKNOWN_USAGE }
    const controller = new AbortController()
    try {
      for await (const event of this.stream(request, model, options, outcome, controller)) {
        yield event
      }
    } finally {
      if (outcome.status === 'unknown') {
        // The consumer stopped iterating before a terminal event.
        outcome.status = 'aborted'
        outcome.finishReason = 'aborted'
        outcome.usage = UNKNOWN_USAGE
      }
      if (!controller.signal.aborted) controller.abort(new AbortReason('consumer'))
      await this.append({
        type: 'llm.request.end',
        ...common,
        status: outcome.status,
        usage: outcome.usage,
        latencyMs: Math.max(0, Math.round(performance.now() - started)),
        ...outcome.httpStatus === undefined ? {} : { httpStatus: outcome.httpStatus },
        ...outcome.finishReason === undefined ? {} : { finishReason: outcome.finishReason },
        ...outcome.errorCode === undefined ? {} : { errorCode: outcome.errorCode },
      })
    }
  }

  /** Ledger writes never change the request outcome; the ledger counts its own failures. */
  private async append(record: LedgerRecordInput): Promise<void> {
    try {
      await this.ledger.append(record)
    } catch {
      // `Ledger.append` increments `writeFailures`; the request result stands.
    }
  }

  /** Open the stream on the plain or the beta route (the latter carries the fallback parameters). */
  private open(request: LLMRequest, model: string, apiKey: string, signal: AbortSignal, timeout: number): WireStream {
    const params = buildMessageParams(request, model, this.wire)
    const client = this.makeClient(apiKey, timeout)
    const options = { signal, timeout }
    if (this.fallbacks) {
      const { output_config, stream: _stream, ...rest } = params
      const beta: Anthropic.Beta.Messages.MessageCreateParams = {
        ...rest,
        ...output_config === undefined || output_config === null ? {} : { output_config },
        betas: [FALLBACK_BETA],
        fallbacks: 'default',
      }
      return client.beta.messages.stream(beta, options) as unknown as WireStream
    }
    return client.messages.stream(params, options) as unknown as WireStream
  }

  private async *stream(
    request: LLMRequest,
    model: string,
    options: CompleteOptions,
    outcome: Outcome,
    controller: AbortController,
  ): AsyncGenerator<LLMStreamEvent> {
    let apiKey: string | undefined
    let providerRequestId: string | undefined

    const done = (finishReason: Exclude<FinishReason, 'error'>, extra: { providerContent?: unknown; refusal?: RefusalInfo } = {}): LLMStreamEvent => {
      outcome.status = finishReason === 'aborted' ? 'aborted' : 'ok'
      outcome.finishReason = finishReason
      if (finishReason === 'aborted') outcome.usage = UNKNOWN_USAGE
      return {
        type: 'done',
        finishReason,
        ...extra.providerContent === undefined ? {} : { providerContent: toJson(extra.providerContent) },
        ...extra.refusal === undefined ? {} : { refusal: extra.refusal },
      }
    }
    const fail = (code: NexgentErrorCode, message: string, details: Record<string, unknown> = {}): StreamErrorEvent => {
      outcome.status = 'error'
      outcome.errorCode = code
      outcome.usage = UNKNOWN_USAGE
      const allDetails = {
        ...details,
        ...outcome.httpStatus === undefined ? {} : { httpStatus: outcome.httpStatus },
        ...providerRequestId === undefined ? {} : { providerRequestId },
      }
      const safeDetails = JSON.parse(redactSecrets(JSON.stringify(allDetails), [apiKey])) as Record<string, unknown>
      const error = new NexgentError(code, redactSecrets(message, [apiKey]), Object.keys(safeDetails).length === 0 ? {} : { details: safeDetails })
      return {
        type: 'error',
        error: toErrorInfo(error),
        ...outcome.httpStatus === undefined ? {} : { httpStatus: outcome.httpStatus },
        ...providerRequestId === undefined ? {} : { providerRequestId },
      }
    }
    /** Classify a thrown SDK error by why the controller aborted, then by error class. */
    const classify = (error: unknown): LLMStreamEvent => {
      const reason: unknown = controller.signal.reason
      if (controller.signal.aborted && reason instanceof AbortReason) {
        if (reason.kind === 'caller' || reason.kind === 'consumer') return done('aborted')
        if (reason.kind === 'timeout') return fail('llm/timeout', `request exceeded the ${timeoutMs} ms deadline`, { timeout: 'request', timeoutMs })
        return fail('llm/timeout', `stream was idle for ${idleMs} ms`, { timeout: 'idle', timeoutMs: idleMs })
      }
      if (error instanceof NexgentError) return fail(error.code, error.message, { ...error.details })
      if (error instanceof APIUserAbortError) return done('aborted')
      if (error instanceof APIConnectionTimeoutError) {
        return fail('llm/timeout', `request exceeded the ${timeoutMs} ms deadline`, { timeout: 'request', timeoutMs })
      }
      if (error instanceof APIConnectionError) {
        const code = causeCode(error.cause ?? error)
        return fail('llm/request-failed', `network error contacting ${this.info.endpoint}: ${code ?? error.message}`, code === undefined ? {} : { cause: code })
      }
      if (error instanceof APIError) {
        if (error.status !== undefined) outcome.httpStatus = error.status
        providerRequestId ??= error.requestID ?? error.headers?.get('request-id') ?? undefined
        const detail = apiErrorMessage(error)
        return fail('llm/request-failed', error.status === undefined ? detail : `HTTP ${error.status}: ${detail}`, error.type === null || error.type === undefined ? {} : { providerType: error.type })
      }
      if (looksLikeTransport(error)) {
        const code = causeCode(error)
        return fail('llm/request-failed', `connection lost: ${code ?? (error instanceof Error ? error.message : String(error))}`, code === undefined ? {} : { cause: code })
      }
      // Anything else came out of the SDK's stream parsing (malformed event, bad tool input JSON).
      return fail('llm/invalid-response', error instanceof Error ? error.message : String(error))
    }

    const timeoutMs = positive(options.timeoutMs, this.timeoutMs)
    const idleMs = positive(options.streamIdleTimeoutMs, this.streamIdleTimeoutMs)
    const signal = request.signal
    const onCallerAbort = (): void => controller.abort(new AbortReason('caller'))
    if (signal?.aborted === true) {
      yield done('aborted')
      return
    }
    signal?.addEventListener('abort', onCallerAbort, { once: true })
    const deadline = setTimeout(() => controller.abort(new AbortReason('timeout')), timeoutMs)
    let idle: ReturnType<typeof setTimeout> | undefined
    const touch = (): void => {
      if (idle !== undefined) clearTimeout(idle)
      idle = setTimeout(() => controller.abort(new AbortReason('idle')), idleMs)
    }

    try {
      try {
        apiKey = await this.readApiKey()
      } catch (error) {
        yield classify(error)
        return
      }
      if (controller.signal.aborted) {
        yield classify(controller.signal.reason)
        return
      }

      const calls = new Map<number, PendingCall>()
      let toolCount = 0
      let startUsage: WireUsage | undefined
      let deltaUsage: WireUsage | undefined
      let stopReason: string | undefined
      let refusal: RefusalInfo | undefined
      let content: unknown
      let stream: WireStream | undefined
      touch()
      try {
        stream = this.open(request, model, apiKey, controller.signal, timeoutMs)
        for await (const event of stream) {
          touch()
          switch (event.type) {
            case 'message_start':
              startUsage = event.message.usage
              outcome.httpStatus = stream.response?.status ?? 200
              providerRequestId = stream.request_id ?? stream.response?.headers.get('request-id') ?? undefined
              break
            case 'content_block_start':
              if (event.content_block.type === 'tool_use') {
                const call: PendingCall = { index: toolCount++, id: event.content_block.id ?? '', name: event.content_block.name ?? '', args: '' }
                calls.set(event.index, call)
                yield { type: 'tool-call.start', index: call.index, id: call.id, name: call.name }
              }
              break
            case 'content_block_delta': {
              const delta = event.delta
              if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text !== '') {
                yield { type: 'text.delta', text: delta.text }
              } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking !== '') {
                yield { type: 'reasoning.delta', text: delta.thinking }
              } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string' && delta.partial_json !== '') {
                const call = calls.get(event.index)
                if (call !== undefined) {
                  call.args += delta.partial_json
                  yield { type: 'tool-call.delta', index: call.index, argumentsDelta: delta.partial_json }
                }
              }
              break
            }
            case 'content_block_stop': {
              const call = calls.get(event.index)
              if (call !== undefined) {
                calls.delete(event.index)
                const toolCall: ToolCall = { id: call.id, name: call.name, arguments: call.args === '' ? '{}' : call.args }
                yield { type: 'tool-call.end', index: call.index, call: toolCall }
              }
              break
            }
            case 'message_delta':
              deltaUsage = event.usage
              if (typeof event.delta.stop_reason === 'string') stopReason = event.delta.stop_reason
              if (event.delta.stop_reason === 'refusal') {
                const details = event.delta.stop_details
                refusal = {
                  ...typeof details?.category === 'string' ? { category: details.category } : {},
                  ...typeof details?.explanation === 'string' ? { explanation: details.explanation } : {},
                }
              }
              break
            case 'message_stop':
              break
          }
        }
        if (stopReason === undefined) {
          yield fail('llm/request-failed', 'stream ended before a stop reason')
          return
        }
        content = (await stream.finalMessage()).content
      } catch (error) {
        if (outcome.httpStatus === undefined && stream?.response?.status !== undefined) outcome.httpStatus = stream.response.status
        yield classify(error)
        return
      }
      const usage = normalizeUsage(startUsage, deltaUsage)
      if (Object.values(usage).some(count => count !== 'unknown')) {
        outcome.usage = usage
        yield { type: 'usage', usage }
      }
      // `stopReason` is set here (the try above returned otherwise); the fallback only satisfies narrowing.
      const finishReason = mapStopReason(stopReason ?? 'end_turn')
      yield done(finishReason, { providerContent: content, ...finishReason === 'refusal' ? { refusal: refusal ?? {} } : {} })
    } finally {
      clearTimeout(deadline)
      if (idle !== undefined) clearTimeout(idle)
      signal?.removeEventListener('abort', onCallerAbort)
    }
  }
}

/** The API's own error message (`error.message` of the body) or the SDK message. */
function apiErrorMessage(error: APIError): string {
  const body = error.error as { error?: { message?: unknown } } | undefined
  const message = body?.error?.message
  return typeof message === 'string' && message !== '' ? message : error.message
}

/** Options for {@link createProvider}; identical to the class options. */
export type CreateProviderOptions = AnthropicProviderOptions

/**
 * Plain factory for callers outside Cordis (CLI wiring, tests).
 * @param options - credentials, ledger and route settings.
 */
export function createProvider(options: CreateProviderOptions): AnthropicProvider {
  return new AnthropicProvider(options)
}
