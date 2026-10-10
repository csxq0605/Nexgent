import { describe, expect, it } from 'vitest'
import type { LLMProvider, LLMRequest, LLMStreamEvent } from '@nexgent/kernel'
import { isTerminalEvent, UNKNOWN_USAGE } from '@nexgent/kernel'
import { scriptedProvider } from '../src/index.js'

function request(extra: Partial<LLMRequest> = {}): LLMRequest {
  return {
    requestId: 'req-1',
    model: 'scripted-model',
    messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }],
    thinking: 'off',
    ...extra,
  }
}

async function collect(provider: LLMProvider, req: LLMRequest = request(), options?: Parameters<LLMProvider['complete']>[1]): Promise<LLMStreamEvent[]> {
  const events: LLMStreamEvent[] = []
  for await (const event of provider.complete(req, options)) events.push(event)
  return events
}

/** Contract invariants 1-3 from contracts/llm.ts. */
function assertInvariants(events: LLMStreamEvent[]): void {
  const terminals = events.filter(isTerminalEvent)
  expect(terminals).toHaveLength(1)
  expect(isTerminalEvent(events[events.length - 1]!)).toBe(true)
  expect(events.filter((e) => e.type === 'usage').length).toBeLessThanOrEqual(1)
  const started = new Set<number>()
  for (const e of events) {
    if (e.type === 'tool-call.start') started.add(e.index)
    if (e.type === 'tool-call.delta' || e.type === 'tool-call.end') expect(started.has(e.index)).toBe(true)
  }
}

describe('scriptedProvider', () => {
  it('streams text, usage and done; records the request', async () => {
    const provider = scriptedProvider([{ content: ['Hel', 'lo'], usage: { inputTokens: 10, outputTokens: 2 } }])
    const events = await collect(provider)
    assertInvariants(events)
    expect(events).toEqual([
      { type: 'text.delta', text: 'Hel' },
      { type: 'text.delta', text: 'lo' },
      {
        type: 'usage',
        usage: { inputTokens: 10, outputTokens: 2, totalTokens: 'unknown', cacheReadTokens: 'unknown', reasoningTokens: 'unknown' },
      },
      { type: 'done', finishReason: 'stop' },
    ])
    expect(provider.requests).toHaveLength(1)
    expect(provider.requests[0]!.messages[1]).toEqual({ role: 'user', content: 'hi' })
    expect(provider.calls[0]!.events).toEqual(events)
    provider.assertConsumed()
  })

  it('omits usage entirely when the turn has none (consumer records UNKNOWN_USAGE)', async () => {
    const events = await collect(scriptedProvider([{ content: 'x' }]))
    expect(events.some((e) => e.type === 'usage')).toBe(false)
    expect(UNKNOWN_USAGE.inputTokens).toBe('unknown')
  })

  it('streams tool calls with split arguments and finishReason tool-calls', async () => {
    const provider = scriptedProvider([{
      toolCalls: [
        { name: 'write_file', arguments: { path: 'a.txt', content: 'hi' }, argumentChunks: 3 },
        { id: 'fixed', name: 'read_file', arguments: '{"path":"b"}' },
      ],
    }])
    const events = await collect(provider)
    assertInvariants(events)
    const ends = events.filter((e) => e.type === 'tool-call.end')
    expect(ends).toEqual([
      { type: 'tool-call.end', index: 0, call: { id: 'call_1_0', name: 'write_file', arguments: '{"path":"a.txt","content":"hi"}' } },
      { type: 'tool-call.end', index: 1, call: { id: 'fixed', name: 'read_file', arguments: '{"path":"b"}' } },
    ])
    const deltas0 = events.filter((e) => e.type === 'tool-call.delta' && e.index === 0)
    expect(deltas0).toHaveLength(3)
    expect(deltas0.map((e) => (e.type === 'tool-call.delta' ? e.argumentsDelta : '')).join('')).toBe('{"path":"a.txt","content":"hi"}')
    expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'tool-calls' })
  })

  it('consumes entries in order, supports function entries and push()', async () => {
    const provider = scriptedProvider([{ content: 'one' }])
    provider.push((req, index) => ({ content: `echo:${(req.messages.at(-1) as { content: string }).content}:${index}` }))
    await collect(provider)
    const second = await collect(provider, request({ messages: [{ role: 'user', content: 'yo' }] }))
    expect(second[0]).toEqual({ type: 'text.delta', text: 'echo:yo:1' })
    expect(provider.remaining).toBe(0)
  })

  it('yields an internal error when the script is exhausted', async () => {
    const events = await collect(scriptedProvider([]))
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'error', error: { code: 'internal' } })
  })

  it('is lazy and single-use', async () => {
    const provider = scriptedProvider([{ content: 'a' }, { content: 'b' }])
    const stream = provider.complete(request())
    expect(provider.calls).toHaveLength(0)
    for await (const _ of stream) { /* drain */ }
    expect(provider.calls).toHaveLength(1)
    expect(() => stream[Symbol.asyncIterator]()).toThrow(/single-use/)
  })

  it('ends with done/aborted when the signal fires mid-stream, keeping earlier text', async () => {
    const controller = new AbortController()
    const provider = scriptedProvider([{ content: ['a', 'b', 'c'], chunkDelayMs: 20 }])
    const events: LLMStreamEvent[] = []
    for await (const event of provider.complete(request({ signal: controller.signal }))) {
      events.push(event)
      if (event.type === 'text.delta') controller.abort()
    }
    assertInvariants(events)
    expect(events).toEqual([{ type: 'text.delta', text: 'a' }, { type: 'done', finishReason: 'aborted' }])
  })

  it('answers an already-aborted request with done/aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const events = await collect(scriptedProvider([{ content: 'x' }]), request({ signal: controller.signal }))
    expect(events).toEqual([{ type: 'done', finishReason: 'aborted' }])
  })

  it('timeout fault hangs until abort', async () => {
    const controller = new AbortController()
    const provider = scriptedProvider([{ content: ['partial', 'rest'], fault: { kind: 'timeout', afterChunks: 1 } }])
    setTimeout(() => controller.abort(), 30)
    const events = await collect(provider, request({ signal: controller.signal }))
    expect(events).toEqual([{ type: 'text.delta', text: 'partial' }, { type: 'done', finishReason: 'aborted' }])
  })

  it('timeout fault honours options.timeoutMs with llm/timeout', async () => {
    const started = Date.now()
    const events = await collect(scriptedProvider([{ fault: 'timeout' }]), request(), { timeoutMs: 30 })
    expect(Date.now() - started).toBeGreaterThanOrEqual(25)
    expect(events).toEqual([{ type: 'error', error: expect.objectContaining({ code: 'llm/timeout' }) }])
  })

  it('disconnect fault cuts the stream with llm/request-failed', async () => {
    const events = await collect(scriptedProvider([{
      content: 'hi',
      toolCalls: [{ name: 't', arguments: { a: 1 } }],
      fault: { kind: 'disconnect', afterChunks: 3 },
    }]))
    assertInvariants(events)
    expect(events.map((e) => e.type)).toEqual(['text.delta', 'tool-call.start', 'tool-call.delta', 'error'])
    expect(events.at(-1)).toMatchObject({ error: { code: 'llm/request-failed' } })
  })

  it('http-error fault carries the status', async () => {
    const events = await collect(scriptedProvider([{ fault: { kind: 'http-error', status: 429, message: 'slow down' } }]))
    expect(events).toEqual([{ type: 'error', error: { name: 'NexgentError', code: 'llm/request-failed', message: 'slow down' }, httpStatus: 429 }])
    const events500 = await collect(scriptedProvider([{ fault: 'http-500' }]))
    expect(events500[0]).toMatchObject({ type: 'error', httpStatus: 500 })
  })

  it('malformed-json fault yields llm/invalid-response', async () => {
    const events = await collect(scriptedProvider([{ content: 'x', fault: 'malformed-json' }]))
    expect(events).toEqual([{ type: 'error', error: expect.objectContaining({ code: 'llm/invalid-response' }) }])
  })

  it('emits reasoning first and honours finishReason override', async () => {
    const events = await collect(scriptedProvider([{ reasoning: 'think', content: 'out', finishReason: 'max-tokens' }]))
    expect(events.map((e) => e.type)).toEqual(['reasoning.delta', 'text.delta', 'done'])
    expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'max-tokens' })
  })

  it('exposes info with defaults and overrides', () => {
    expect(scriptedProvider().info).toEqual({ id: 'scripted', endpoint: 'scripted://local', defaultModel: 'scripted-model' })
    expect(scriptedProvider([], { info: { id: 'mimo' } }).info.id).toBe('mimo')
    expect(() => scriptedProvider([{ content: 'x' }]).assertConsumed()).toThrow(/not consumed/)
  })
})
