/**
 * The script format shared by {@link scriptedProvider} (in-process) and
 * {@link scriptedModelServer} (OpenAI-compatible HTTP). One script entry
 * answers exactly one model request, in order. The README section
 * "仿真规范" is the normative description of this format.
 */
import type { LLMUsage } from '@nexgent/kernel'

/** One tool call the scripted model emits. */
export interface ScriptedToolCall {
  /** Call id; defaults to `call_<request#>_<index>` (1-based request number, 0-based index). */
  readonly id?: string
  /** Tool name. */
  readonly name: string
  /**
   * Arguments: a string is sent verbatim as the raw JSON text (so it may be
   * invalid JSON on purpose); any other value is `JSON.stringify`-ed.
   */
  readonly arguments?: unknown
  /** Number of chunks the argument text is split into (default 2; at least 1). */
  readonly argumentChunks?: number
}

/**
 * Token usage in contract terms ({@link LLMUsage}). Fields left out are
 * reported as `'unknown'` by the provider and omitted on the wire by the
 * server. Leave `usage` off the turn entirely to send no usage at all.
 */
export type ScriptedUsage = Partial<Record<keyof LLMUsage, number>>

/** A fault replacing (or cutting short) a normal reply. */
export type ScriptedFault =
  /** Hang: send `afterChunks` chunks (default 0), then stall until the client gives up. */
  | { readonly kind: 'timeout'; readonly afterChunks?: number }
  /** Drop the connection after `afterChunks` chunks (default 1; 0 = before any response). */
  | { readonly kind: 'disconnect'; readonly afterChunks?: number }
  /** Answer with an HTTP error status and an OpenAI-style error body. */
  | {
    readonly kind: 'http-error'
    readonly status: number
    readonly message?: string
    readonly headers?: Readonly<Record<string, string>>
  }
  /** Send `afterChunks` good chunks (default 0), then a chunk whose JSON does not parse. */
  | { readonly kind: 'malformed-json'; readonly afterChunks?: number }

/** String shorthands accepted wherever a {@link ScriptedFault} is. */
export type ScriptedFaultShorthand = 'timeout' | 'disconnect' | 'http-500' | 'malformed-json'

/** One scripted model reply. */
export interface ScriptedTurn {
  /** Visible text. A string is one chunk; an array gives the exact chunks. */
  readonly content?: string | readonly string[]
  /** Reasoning text (one chunk), streamed before `content`. */
  readonly reasoning?: string
  /** Tool calls, emitted after the text in this order. */
  readonly toolCalls?: readonly ScriptedToolCall[]
  /** Round-robin the argument chunks of several tool calls (server only; provider events stay sequential). */
  readonly interleaveToolCalls?: boolean
  /** Usage to report; absent means "no usage reported" (→ `'unknown'`). */
  readonly usage?: ScriptedUsage
  /** Finish reason; defaults to `tool-calls` when there are tool calls, else `stop`. */
  readonly finishReason?: 'stop' | 'tool-calls' | 'max-tokens'
  /** Delay before each chunk in ms (overrides the factory option). */
  readonly chunkDelayMs?: number
  /** Inject a fault instead of (or part-way through) the reply. */
  readonly fault?: ScriptedFault | ScriptedFaultShorthand
}

/**
 * A script entry: a fixed turn, or a function computing it from the
 * incoming request (`request` is the {@link LLMRequest} for the provider and
 * the parsed JSON body for the server; `index` is 0-based).
 */
export type ScriptEntry<Req> = ScriptedTurn | ((request: Req, index: number) => ScriptedTurn)

/** Normalize a fault shorthand. */
export function normalizeFault(fault: ScriptedTurn['fault']): ScriptedFault | undefined {
  if (fault === undefined) return undefined
  if (typeof fault !== 'string') return fault
  switch (fault) {
    case 'timeout': return { kind: 'timeout' }
    case 'disconnect': return { kind: 'disconnect' }
    case 'http-500': return { kind: 'http-error', status: 500 }
    case 'malformed-json': return { kind: 'malformed-json' }
  }
}

/** Split `text` into `parts` contiguous, non-empty-where-possible pieces. */
export function splitText(text: string, parts: number): string[] {
  const n = Math.max(1, Math.floor(parts))
  if (n === 1 || text.length <= 1) return [text]
  const size = Math.ceil(text.length / n)
  const out: string[] = []
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size))
  return out
}

/** A tool call after defaults are applied. */
export interface ResolvedToolCall {
  readonly id: string
  readonly name: string
  readonly arguments: string
  readonly chunks: string[]
}

/** Apply defaults to a turn's tool calls. */
export function resolveToolCalls(turn: ScriptedTurn, requestNumber: number): ResolvedToolCall[] {
  return (turn.toolCalls ?? []).map((call, index) => {
    const args = call.arguments === undefined
      ? '{}'
      : typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments)
    return {
      id: call.id ?? `call_${requestNumber}_${index}`,
      name: call.name,
      arguments: args,
      chunks: splitText(args, call.argumentChunks ?? 2),
    }
  })
}

/** The text chunks of a turn. */
export function contentChunks(turn: ScriptedTurn): string[] {
  if (turn.content === undefined) return []
  return typeof turn.content === 'string' ? (turn.content === '' ? [] : [turn.content]) : [...turn.content]
}

/** The finish reason a turn ends with. */
export function finishReasonOf(turn: ScriptedTurn): 'stop' | 'tool-calls' | 'max-tokens' {
  return turn.finishReason ?? ((turn.toolCalls?.length ?? 0) > 0 ? 'tool-calls' : 'stop')
}

/** Resolve a script entry. */
export function resolveEntry<Req>(entry: ScriptEntry<Req>, request: Req, index: number): ScriptedTurn {
  return typeof entry === 'function' ? entry(request, index) : entry
}

/** Abort-aware sleep; resolves early (without throwing) when the signal fires. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })
}
