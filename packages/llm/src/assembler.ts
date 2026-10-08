/**
 * Turns parsed `chat.completion.chunk` objects into contract stream events:
 * text and reasoning deltas, parallel tool calls keyed by the wire `index`
 * with arguments assembled across chunks, one usage report and the finish
 * reason. Holds no I/O; the provider feeds it and decides the terminal event.
 */
import {
  NexgentError,
  type FinishReason,
  type LLMStreamEvent,
  type LLMUsage,
  type ToolCall,
} from '@nexgent/kernel'
import { normalizeUsage } from './usage.js'

type StreamFinishReason = Exclude<FinishReason, 'error' | 'aborted'>

/**
 * Map a wire `finish_reason` to the contract vocabulary. `content_filter`
 * and unknown values map to `stop` (the model stopped; there is no contract
 * value for "filtered").
 * @param reason - the wire value.
 */
export function mapFinishReason(reason: string): StreamFinishReason {
  switch (reason) {
    case 'tool_calls':
    case 'function_call':
      return 'tool-calls'
    case 'length':
      return 'max-tokens'
    default:
      return 'stop'
  }
}

interface PendingCall {
  readonly index: number
  id: string | undefined
  name: string | undefined
  args: string
  /** Argument text received before `start` could be emitted. */
  buffered: string
  started: boolean
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function invalid(message: string): NexgentError {
  return new NexgentError('llm/invalid-response', message)
}

/** Stateful chunk-to-event converter for one request. */
export class ChunkAssembler {
  private readonly calls = new Map<number, PendingCall>()
  private readonly order: PendingCall[] = []
  private finishReason: StreamFinishReason | undefined
  private usage: LLMUsage | undefined
  private closedCalls = false

  /** The wire finish reason seen so far, mapped; `undefined` until one arrives. */
  get finish(): StreamFinishReason | undefined {
    return this.finishReason
  }

  /** The last usage the stream reported, if any. */
  get reportedUsage(): LLMUsage | undefined {
    return this.usage
  }

  /**
   * Consume one parsed chunk.
   * @param chunk - the JSON value of one SSE `data` payload.
   * @returns the events it produces, in order.
   * @throws `NexgentError` `llm/invalid-response` on a chunk of the wrong shape;
   *   `llm/request-failed` when the chunk is an in-band `error` object.
   */
  accept(chunk: unknown): LLMStreamEvent[] {
    const record = asRecord(chunk)
    if (record === undefined) throw invalid('stream chunk is not a JSON object')
    const error = asRecord(record['error'])
    if (error !== undefined) {
      const message = typeof error['message'] === 'string' ? error['message'] : 'provider reported an error mid-stream'
      throw new NexgentError('llm/request-failed', message, {
        details: typeof error['code'] === 'string' || typeof error['code'] === 'number' ? { providerCode: error['code'] } : {},
      })
    }
    if (record['usage'] !== undefined && record['usage'] !== null) this.usage = normalizeUsage(record['usage'])
    const choices = record['choices']
    if (choices === undefined || choices === null) return []
    if (!Array.isArray(choices)) throw invalid('stream chunk "choices" is not an array')
    const events: LLMStreamEvent[] = []
    for (const rawChoice of choices) {
      const choice = asRecord(rawChoice)
      if (choice === undefined) throw invalid('stream chunk choice is not an object')
      if (choice['index'] !== undefined && choice['index'] !== 0) continue
      const delta = choice['delta'] === undefined || choice['delta'] === null ? {} : asRecord(choice['delta'])
      if (delta === undefined) throw invalid('stream chunk "delta" is not an object')
      if (this.finishReason === undefined) this.acceptDelta(delta, events)
      const finish = choice['finish_reason']
      if (typeof finish === 'string' && this.finishReason === undefined) {
        this.finishReason = mapFinishReason(finish)
        events.push(...this.closeCalls())
        if (this.finishReason === 'stop' && this.order.length > 0) this.finishReason = 'tool-calls'
      } else if (finish !== undefined && finish !== null && typeof finish !== 'string') {
        throw invalid('stream chunk "finish_reason" is not a string')
      }
    }
    return events
  }

  private acceptDelta(delta: Record<string, unknown>, events: LLMStreamEvent[]): void {
    const reasoning = delta['reasoning_content'] ?? delta['reasoning']
    if (typeof reasoning === 'string' && reasoning !== '') events.push({ type: 'reasoning.delta', text: reasoning })
    const content = delta['content']
    if (typeof content === 'string' && content !== '') events.push({ type: 'text.delta', text: content })
    else if (content !== undefined && content !== null && typeof content !== 'string') throw invalid('stream delta "content" is not a string')
    const toolCalls = delta['tool_calls']
    if (toolCalls === undefined || toolCalls === null) return
    if (!Array.isArray(toolCalls)) throw invalid('stream delta "tool_calls" is not an array')
    for (const [position, rawCall] of toolCalls.entries()) {
      const call = asRecord(rawCall)
      if (call === undefined) throw invalid('stream tool call delta is not an object')
      const wireIndex = typeof call['index'] === 'number' ? call['index'] : position
      let pending = this.calls.get(wireIndex)
      if (pending === undefined) {
        pending = { index: this.order.length, id: undefined, name: undefined, args: '', buffered: '', started: false }
        this.calls.set(wireIndex, pending)
        this.order.push(pending)
      }
      if (typeof call['id'] === 'string' && call['id'] !== '' && pending.id === undefined) pending.id = call['id']
      const fn = call['function'] === undefined || call['function'] === null ? {} : asRecord(call['function'])
      if (fn === undefined) throw invalid('stream tool call "function" is not an object')
      if (typeof fn['name'] === 'string' && fn['name'] !== '' && pending.name === undefined) pending.name = fn['name']
      const args = fn['arguments']
      if (args !== undefined && args !== null && typeof args !== 'string') throw invalid('stream tool call "arguments" is not a string')
      const piece = typeof args === 'string' ? args : ''
      if (!pending.started) {
        pending.buffered += piece
        if (pending.id !== undefined && pending.name !== undefined) this.start(pending, events)
      } else if (piece !== '') {
        pending.args += piece
        events.push({ type: 'tool-call.delta', index: pending.index, argumentsDelta: piece })
      }
    }
  }

  private start(pending: PendingCall, events: LLMStreamEvent[]): void {
    pending.started = true
    events.push({ type: 'tool-call.start', index: pending.index, id: pending.id ?? '', name: pending.name ?? '' })
    if (pending.buffered !== '') {
      pending.args = pending.buffered
      events.push({ type: 'tool-call.delta', index: pending.index, argumentsDelta: pending.buffered })
      pending.buffered = ''
    }
  }

  /**
   * Emit `tool-call.end` for every open call, in index order. A call whose
   * name never arrived is a protocol violation; one without an id gets a
   * synthetic `call_<index>` id.
   * @throws `llm/invalid-response` for a tool call without a name.
   */
  closeCalls(): LLMStreamEvent[] {
    if (this.closedCalls) return []
    this.closedCalls = true
    const events: LLMStreamEvent[] = []
    for (const pending of this.order) {
      if (!pending.started) {
        if (pending.name === undefined) throw invalid(`tool call ${pending.index} has no function name`)
        pending.id ??= `call_${pending.index}`
        this.start(pending, events)
      }
      const call: ToolCall = { id: pending.id ?? `call_${pending.index}`, name: pending.name ?? '', arguments: pending.args }
      events.push({ type: 'tool-call.end', index: pending.index, call })
    }
    return events
  }

  /** Whether any tool call was seen. */
  get hasToolCalls(): boolean {
    return this.order.length > 0
  }
}
