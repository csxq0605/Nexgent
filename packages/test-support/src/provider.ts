/**
 * `scriptedProvider` — an in-process {@link LLMProvider} that replays a
 * script as contract stream events and records every request it receives.
 *
 * Design follows deepseek-harness `test-support/agent-loop-testkit` and
 * `test-support/llm-replay` (scripted turns consumed in order, recorded
 * requests); the code is a rewrite against the Nexgent contract.
 */
import type {
  ErrorInfo,
  LLMCompleteOptions,
  LLMProvider,
  LLMProviderInfo,
  LLMRequest,
  LLMStreamEvent,
  LLMUsage,
  NexgentErrorCode,
} from '@nexgent/kernel'
import {
  contentChunks,
  finishReasonOf,
  normalizeFault,
  resolveEntry,
  resolveToolCalls,
  sleep,
  type ScriptEntry,
  type ScriptedTurn,
  type ScriptedUsage,
} from './script.js'

/** Options for {@link scriptedProvider}. */
export interface ScriptedProviderOptions {
  /** Route facts; defaults to `{ id: 'scripted', endpoint: 'scripted://local', defaultModel: 'scripted-model' }`. */
  readonly info?: Partial<LLMProviderInfo>
  /** Delay before each emitted chunk in ms (default 0); a turn's `chunkDelayMs` wins. */
  readonly chunkDelayMs?: number
}

/** One recorded `complete` call. */
export interface ScriptedProviderCall {
  /** 0-based call number. */
  readonly index: number
  /** The request as received (`messages` copied so later mutation does not leak in). */
  readonly request: LLMRequest
  /** The options as received. */
  readonly options: LLMCompleteOptions | undefined
  /** Events yielded so far, in order. */
  readonly events: LLMStreamEvent[]
}

/** The provider plus its recording and script controls. */
export interface ScriptedProvider extends LLMProvider {
  /** Every call, in order (recorded when iteration starts, per the lazy contract). */
  readonly calls: readonly ScriptedProviderCall[]
  /** Shorthand for `calls.map((c) => c.request)`. */
  readonly requests: readonly LLMRequest[]
  /** Script entries not yet consumed. */
  readonly remaining: number
  /** Append entries to the script. */
  push(...entries: ScriptEntry<LLMRequest>[]): void
  /** Throw if any script entry is still unconsumed. */
  assertConsumed(): void
}

function errorInfo(code: NexgentErrorCode, message: string): ErrorInfo {
  return { name: 'NexgentError', code, message }
}

/** Convert scripted usage to a contract record; missing fields become `'unknown'`. */
export function toContractUsage(usage: ScriptedUsage): LLMUsage {
  const pick = (v: number | undefined): number | 'unknown' => (v === undefined ? 'unknown' : v)
  return {
    inputTokens: pick(usage.inputTokens),
    outputTokens: pick(usage.outputTokens),
    totalTokens: pick(usage.totalTokens),
    cacheReadTokens: pick(usage.cacheReadTokens),
    reasoningTokens: pick(usage.reasoningTokens),
  }
}

/** The non-terminal body events of a turn, in emission order. */
function bodyEvents(turn: ScriptedTurn, requestNumber: number): LLMStreamEvent[] {
  const events: LLMStreamEvent[] = []
  if (turn.reasoning !== undefined && turn.reasoning !== '') events.push({ type: 'reasoning.delta', text: turn.reasoning })
  for (const text of contentChunks(turn)) events.push({ type: 'text.delta', text })
  resolveToolCalls(turn, requestNumber).forEach((call, index) => {
    events.push({ type: 'tool-call.start', index, id: call.id, name: call.name })
    for (const argumentsDelta of call.chunks) events.push({ type: 'tool-call.delta', index, argumentsDelta })
    events.push({ type: 'tool-call.end', index, call: { id: call.id, name: call.name, arguments: call.arguments } })
  })
  return events
}

/**
 * Create a scripted provider. Each `complete` call consumes the next script
 * entry and streams it as contract events:
 * `reasoning.delta` → `text.delta`* → (`tool-call.start` → `tool-call.delta`* → `tool-call.end`)* → `usage`? → `done`.
 *
 * Abort (`request.signal`) is checked before every event and during delays
 * and hangs; it ends the stream with `done { finishReason: 'aborted' }`.
 * A `timeout` fault hangs until abort, or until `options.timeoutMs` /
 * `options.streamIdleTimeoutMs` elapse (then `error` with `llm/timeout`).
 * An exhausted script yields `error` with code `internal`.
 * @param script - entries consumed in order, one per request.
 * @param options - route facts and pacing.
 */
export function scriptedProvider(
  script: readonly ScriptEntry<LLMRequest>[] = [],
  options: ScriptedProviderOptions = {},
): ScriptedProvider {
  const queue = [...script]
  const calls: ScriptedProviderCall[] = []
  const info: LLMProviderInfo = {
    id: options.info?.id ?? 'scripted',
    endpoint: options.info?.endpoint ?? 'scripted://local',
    defaultModel: options.info?.defaultModel ?? 'scripted-model',
  }

  async function* run(request: LLMRequest, completeOptions: LLMCompleteOptions | undefined): AsyncGenerator<LLMStreamEvent> {
    const index = calls.length
    const call: ScriptedProviderCall = {
      index,
      request: { ...request, messages: [...request.messages] },
      options: completeOptions,
      events: [],
    }
    calls.push(call)
    const emit = (event: LLMStreamEvent): LLMStreamEvent => {
      call.events.push(event)
      return event
    }
    const signal = request.signal
    const aborted = (): LLMStreamEvent => emit({ type: 'done', finishReason: 'aborted' })

    const entry = queue.shift()
    if (entry === undefined) {
      yield emit({ type: 'error', error: errorInfo('internal', `scriptedProvider: script exhausted at request #${index + 1}`) })
      return
    }
    const turn = resolveEntry(entry, request, index)
    const delay = turn.chunkDelayMs ?? options.chunkDelayMs ?? 0
    const fault = normalizeFault(turn.fault)
    const body = bodyEvents(turn, index + 1)

    if (signal?.aborted) {
      yield aborted()
      return
    }
    if (fault?.kind === 'http-error') {
      yield emit({
        type: 'error',
        error: errorInfo('llm/request-failed', fault.message ?? `HTTP ${fault.status}`),
        httpStatus: fault.status,
      })
      return
    }

    const cut = fault === undefined
      ? body.length
      : Math.min(body.length, fault.afterChunks ?? (fault.kind === 'disconnect' ? 1 : 0))
    for (const event of body.slice(0, cut)) {
      await sleep(delay, signal)
      if (signal?.aborted) {
        yield aborted()
        return
      }
      yield emit(event)
    }

    if (fault?.kind === 'disconnect') {
      yield emit({ type: 'error', error: errorInfo('llm/request-failed', 'scripted disconnect: connection reset mid-stream') })
      return
    }
    if (fault?.kind === 'malformed-json') {
      yield emit({ type: 'error', error: errorInfo('llm/invalid-response', 'scripted malformed chunk: invalid JSON') })
      return
    }
    if (fault?.kind === 'timeout') {
      const limits = [completeOptions?.timeoutMs, completeOptions?.streamIdleTimeoutMs]
        .filter((v): v is number => typeof v === 'number')
      const limit = limits.length > 0 ? Math.min(...limits) : undefined
      if (limit === undefined && signal === undefined) {
        // Nothing can end this hang; mirror a real dead connection.
        await new Promise<never>(() => {})
      }
      await sleep(limit ?? 2_147_483_647, signal)
      if (signal?.aborted) yield aborted()
      else yield emit({ type: 'error', error: errorInfo('llm/timeout', `scripted timeout after ${limit}ms`) })
      return
    }

    if (turn.usage !== undefined) yield emit({ type: 'usage', usage: toContractUsage(turn.usage) })
    if (signal?.aborted) {
      yield aborted()
      return
    }
    yield emit({ type: 'done', finishReason: finishReasonOf(turn) })
  }

  return {
    info,
    get calls() { return calls },
    get requests() { return calls.map((c) => c.request) },
    get remaining() { return queue.length },
    push(...entries) { queue.push(...entries) },
    assertConsumed() {
      if (queue.length > 0) throw new Error(`scriptedProvider: ${queue.length} script entr${queue.length === 1 ? 'y' : 'ies'} not consumed`)
    },
    complete(request, completeOptions) {
      let started = false
      return {
        [Symbol.asyncIterator]: () => {
          if (started) throw new Error('scriptedProvider: the stream of complete() is single-use')
          started = true
          return run(request, completeOptions)
        },
      }
    },
  }
}
