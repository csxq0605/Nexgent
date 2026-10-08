/**
 * `OpenAICompatibleProvider`: the single OpenAI-compatible route (MiMo by
 * default) behind the {@link LLMProvider} contract. One `complete` call is one
 * HTTP request (`maxRetries: 0`) and exactly one `llm.request.start` /
 * `llm.request.end` ledger pair, whatever the outcome.
 */
import {
  DEFAULT_PROJECT_CONFIG,
  NEXGENT_API_KEY,
  NexgentError,
  toErrorInfo,
  UNKNOWN_USAGE,
  type Credentials,
  type FinishReason,
  type JsonObject,
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
  type StreamErrorEvent,
  type ThinkingMode,
} from '@nexgent/kernel'
import { ChunkAssembler } from './assembler.js'
import { resolveProxyPolicy, type ProxyEnv, type ProxyPolicy } from './proxy/policy.js'
import { createTransport, ProxyTunnelError, type Transport, type TunnelTlsOptions } from './proxy/transport.js'
import { redactSecrets, sanitizeUrl } from './redact.js'
import { readSseData } from './sse.js'
import { buildRequestBody, DEFAULT_WIRE_OPTIONS, type WireOptions } from './wire.js'

/** Environment variable that overrides the endpoint base URL. */
export const NEXGENT_API_BASE_URL = 'NEXGENT_API_BASE_URL'

/** Default whole-request deadline (ms), as in the PR #4 MiMo route. */
export const DEFAULT_TIMEOUT_MS = 180_000
/** Default max silence between stream chunks (ms). */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 180_000

/** Max bytes of an HTTP error body kept for the error message. */
const ERROR_BODY_LIMIT = 4096

/** Construction options for {@link OpenAICompatibleProvider}. */
export interface OpenAICompatibleProviderOptions {
  /** Where the API key comes from (`ctx.credentials`). */
  readonly credentials: Credentials
  /** Where request records go (`ctx.ledger`). */
  readonly ledger: Ledger
  /** Route key stamped on ledger records; default `mimo`. */
  readonly id?: string
  /**
   * Base URL; default {@link DEFAULT_PROJECT_CONFIG}`.endpoint`. The
   * `NEXGENT_API_BASE_URL` environment variable overrides it.
   */
  readonly endpoint?: string
  /** Model used when a request names none; default {@link DEFAULT_PROJECT_CONFIG}`.model`. */
  readonly defaultModel?: string
  /** Credential name of the API key; default {@link NEXGENT_API_KEY}. */
  readonly apiKeyName?: string
  /** Default whole-request deadline (ms); per-call `timeoutMs` wins. */
  readonly timeoutMs?: number
  /** Default stream idle deadline (ms); per-call `streamIdleTimeoutMs` wins. */
  readonly streamIdleTimeoutMs?: number
  /** Retries are fixed at 0 by decision; any other value is rejected. */
  readonly maxRetries?: 0
  /** Output cap sent when a request sets no `maxTokens`; default none (the route's own default). */
  readonly defaultMaxTokens?: number
  /** Body fields sent per thinking mode; default disables MiMo reasoning with `thinking: { type: 'disabled' }`. */
  readonly thinkingParams?: Readonly<Record<ThinkingMode, JsonObject>>
  /** Output cap field name; default `max_tokens`. */
  readonly maxTokensField?: WireOptions['maxTokensField']
  /** Repeat the tool name on `tool` messages; default false. */
  readonly toolMessageName?: boolean
  /** Extra request headers (never the key; that goes in `Authorization`). */
  readonly headers?: Readonly<Record<string, string>>
  /** Proxy handling: `'env'` (default) reads `HTTP(S)_PROXY` / `NO_PROXY`; `'none'` always connects directly; or an explicit policy. */
  readonly proxy?: 'env' | 'none' | ProxyPolicy
  /** TLS trust for proxied requests. */
  readonly proxyTls?: TunnelTlsOptions
  /** Environment for `NEXGENT_API_BASE_URL` and proxy variables; default `process.env`. */
  readonly env?: ProxyEnv
  /** Ledger attribution stamped on every record (step 4; absent in step 1). */
  readonly attribution?: LedgerAttribution
  /** Replace the HTTP transport (tests, custom dispatch). */
  readonly transport?: Transport
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

function positive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback
}

/** Iterate a web body stream without relying on `ReadableStream` async iteration typings. */
async function* bodyChunks(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return
      if (value !== undefined) yield value
    }
  } finally {
    reader.releaseLock()
  }
}

async function readLimited(response: Response): Promise<string> {
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  try {
    while (text.length < ERROR_BODY_LIMIT) {
      const { done, value } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
    }
  } catch {
    // A truncated error body still yields what arrived.
  } finally {
    void reader.cancel().catch(() => undefined)
  }
  return text.slice(0, ERROR_BODY_LIMIT)
}

function errorBodyMessage(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed === 'object' && parsed !== null) {
      const error = (parsed as Record<string, unknown>)['error']
      if (typeof error === 'object' && error !== null && typeof (error as Record<string, unknown>)['message'] === 'string') {
        return (error as Record<string, unknown>)['message'] as string
      }
      if (typeof error === 'string') return error
      const message = (parsed as Record<string, unknown>)['message']
      if (typeof message === 'string') return message
    }
  } catch {
    // not JSON
  }
  return text.trim().slice(0, 500)
}

function causeCode(error: unknown): string | undefined {
  let current: unknown = error
  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth++) {
    const code = (current as { code?: unknown }).code
    if (typeof code === 'string' && code !== '') return code
    current = (current as { cause?: unknown }).cause
  }
  return undefined
}

/** The single OpenAI-compatible route. */
export class OpenAICompatibleProvider implements LLMProvider {
  readonly info: LLMProviderInfo
  private readonly baseUrl: string
  private readonly credentials: Credentials
  private readonly ledger: Ledger
  private readonly apiKeyName: string
  private readonly timeoutMs: number
  private readonly streamIdleTimeoutMs: number
  private readonly wire: WireOptions
  private readonly defaultMaxTokens: number | undefined
  private readonly headers: Readonly<Record<string, string>>
  private readonly attribution: LedgerAttribution
  private readonly transport: Transport

  constructor(options: OpenAICompatibleProviderOptions) {
    if (options.maxRetries !== undefined && options.maxRetries !== 0) {
      throw new NexgentError('config/invalid', 'maxRetries is fixed at 0 for the step-1 provider')
    }
    const env = options.env ?? process.env
    const override = env[NEXGENT_API_BASE_URL]?.trim()
    const endpoint = override !== undefined && override !== '' ? override : options.endpoint ?? DEFAULT_PROJECT_CONFIG.endpoint
    const parsed = URL.parse(endpoint)
    if (parsed === null || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
      throw new NexgentError('config/invalid', `endpoint is not an http(s) URL: ${sanitizeUrl(endpoint)}`)
    }
    this.baseUrl = endpoint.replace(/\/+$/, '')
    this.info = Object.freeze({
      id: options.id ?? 'mimo',
      endpoint: sanitizeUrl(endpoint),
      defaultModel: options.defaultModel ?? DEFAULT_PROJECT_CONFIG.model,
    })
    this.credentials = options.credentials
    this.ledger = options.ledger
    this.apiKeyName = options.apiKeyName ?? NEXGENT_API_KEY
    this.timeoutMs = positive(options.timeoutMs, DEFAULT_TIMEOUT_MS)
    this.streamIdleTimeoutMs = positive(options.streamIdleTimeoutMs, DEFAULT_STREAM_IDLE_TIMEOUT_MS)
    this.wire = {
      thinkingParams: options.thinkingParams ?? DEFAULT_WIRE_OPTIONS.thinkingParams,
      maxTokensField: options.maxTokensField ?? DEFAULT_WIRE_OPTIONS.maxTokensField,
      toolMessageName: options.toolMessageName ?? DEFAULT_WIRE_OPTIONS.toolMessageName,
    }
    this.headers = options.headers ?? {}
    this.defaultMaxTokens = options.defaultMaxTokens
    this.attribution = pickAttribution(options.attribution)
    if (options.transport !== undefined) {
      this.transport = options.transport
    } else {
      const proxy = options.proxy ?? 'env'
      const policy = proxy === 'none' ? { noProxy: '' } : proxy === 'env' ? resolveProxyPolicy(env).policy : proxy
      this.transport = createTransport({ policy, env, ...options.proxyTls === undefined ? {} : { tls: options.proxyTls } })
    }
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

  private async *stream(
    request: LLMRequest,
    model: string,
    options: CompleteOptions,
    outcome: Outcome,
    controller: AbortController,
  ): AsyncGenerator<LLMStreamEvent> {
    let apiKey: string | undefined
    let providerRequestId: string | undefined

    const done = (finishReason: Exclude<FinishReason, 'error'>): LLMStreamEvent => {
      outcome.status = finishReason === 'aborted' ? 'aborted' : 'ok'
      outcome.finishReason = finishReason
      if (finishReason === 'aborted') outcome.usage = UNKNOWN_USAGE
      return { type: 'done', finishReason }
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
    /** Classify a thrown transport / body error by why the controller aborted. */
    const classify = (error: unknown): LLMStreamEvent => {
      const reason: unknown = controller.signal.reason
      if (controller.signal.aborted && reason instanceof AbortReason) {
        if (reason.kind === 'caller' || reason.kind === 'consumer') return done('aborted')
        if (reason.kind === 'timeout') return fail('llm/timeout', `request exceeded the ${timeoutMs} ms deadline`, { timeout: 'request', timeoutMs })
        return fail('llm/timeout', `stream was idle for ${idleMs} ms`, { timeout: 'idle', timeoutMs: idleMs })
      }
      if (error instanceof ProxyTunnelError) {
        return fail('llm/request-failed', error.message, error.proxyStatus === undefined ? {} : { proxyStatus: error.proxyStatus })
      }
      if (error instanceof NexgentError) return fail(error.code, error.message, { ...error.details })
      const code = causeCode(error)
      const message = error instanceof Error ? error.message : String(error)
      return fail(
        'llm/request-failed',
        `network error contacting ${this.info.endpoint}: ${code ?? message}`,
        code === undefined ? {} : { cause: code },
      )
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
        apiKey = await this.credentials.get(this.apiKeyName)
      } catch (error) {
        yield fail('credentials/missing', `could not read credential ${this.apiKeyName}: ${error instanceof Error ? error.message : String(error)}`)
        return
      }
      if (apiKey === undefined || apiKey === '') {
        yield fail('credentials/missing', `credential ${this.apiKeyName} is not set (environment variable or ~/.nexgent/credentials.json)`)
        return
      }
      if (controller.signal.aborted) {
        yield classify(controller.signal.reason)
        return
      }

      const sized = request.maxTokens === undefined && this.defaultMaxTokens !== undefined
        ? { ...request, maxTokens: this.defaultMaxTokens }
        : request
      const body = JSON.stringify(buildRequestBody(sized, model, this.wire))
      let response: Response
      touch()
      try {
        response = await this.transport({
          url: new URL(`${this.baseUrl}/chat/completions`),
          method: 'POST',
          headers: {
            ...this.headers,
            'content-type': 'application/json',
            accept: 'text/event-stream',
            authorization: `Bearer ${apiKey}`,
          },
          body,
          signal: controller.signal,
        })
      } catch (error) {
        yield classify(error)
        return
      }
      outcome.httpStatus = response.status
      providerRequestId = response.headers.get('x-request-id') ?? response.headers.get('request-id') ?? undefined

      if (!response.ok) {
        const text = await readLimited(response)
        const detail = errorBodyMessage(text)
        yield fail('llm/request-failed', `HTTP ${response.status}${detail === '' ? '' : `: ${detail}`}`)
        return
      }
      if (response.body === null) {
        yield fail('llm/invalid-response', 'response has no body')
        return
      }

      const assembler = new ChunkAssembler()
      let sawDone = false
      try {
        touch()
        for await (const data of readSseData(bodyChunks(response.body))) {
          touch()
          if (data.trim() === '[DONE]') {
            sawDone = true
            break
          }
          let chunk: unknown
          try {
            chunk = JSON.parse(data)
          } catch {
            yield fail('llm/invalid-response', 'stream chunk is not valid JSON')
            return
          }
          for (const event of assembler.accept(chunk)) yield event
        }
      } catch (error) {
        yield classify(error)
        return
      }
      if (!sawDone && assembler.finish === undefined) {
        yield fail('llm/request-failed', 'stream ended before a finish reason or [DONE]')
        return
      }
      let tail: LLMStreamEvent[]
      try {
        tail = assembler.closeCalls()
      } catch (error) {
        yield classify(error)
        return
      }
      for (const event of tail) yield event
      const usage = assembler.reportedUsage
      if (usage !== undefined) {
        outcome.usage = usage
        yield { type: 'usage', usage }
      }
      yield done(assembler.finish ?? (assembler.hasToolCalls ? 'tool-calls' : 'stop'))
    } finally {
      clearTimeout(deadline)
      if (idle !== undefined) clearTimeout(idle)
      signal?.removeEventListener('abort', onCallerAbort)
    }
  }
}

/** Options for {@link createProvider}; identical to the class options. */
export type CreateProviderOptions = OpenAICompatibleProviderOptions

/**
 * Plain factory for callers outside Cordis (CLI wiring, tests).
 * @param options - credentials, ledger and route settings.
 */
export function createProvider(options: CreateProviderOptions): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider(options)
}
