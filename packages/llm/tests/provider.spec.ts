import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_PROJECT_CONFIG,
  isNexgentError,
  UNKNOWN_USAGE,
  type DoneEvent,
  type LLMRequestEndRecord,
  type LLMRequestStartRecord,
  type LLMStreamEvent,
  type StreamErrorEvent,
  type ToolCallEndEvent,
} from '@nexgent/kernel'
import { AnthropicProvider, createProvider, DEFAULT_MAX_RETRIES, FALLBACK_BETA, isContextOverflow, isRetryable, NEXGENT_API_BASE_URL, THINKING_BINDING_BETA } from '../src/index.js'
import { closedPort, loadSseFixture, sseEvent, startFakeAnthropic, type FakeAnthropic } from './helpers/fake-anthropic.js'
import { memoryCredentials, MemoryLedger } from './helpers/fakes.js'
import { collect, expectStreamInvariants, makeProvider, makeRequest, TEST_KEY, textOf } from './helpers/stream.js'

/** `thinking: 'on'` on the wire: adaptive, and failing replayed blocks dropped instead of rejected. */
const ADAPTIVE = { type: 'adaptive', display: 'summarized', block_binding: { prefix_mismatch_behavior: 'drop_block' } }

let fake: FakeAnthropic | undefined
afterEach(async () => {
  await fake?.close()
  fake = undefined
})

function pair(ledger: MemoryLedger): { start: LLMRequestStartRecord; end: LLMRequestEndRecord } {
  expect(ledger.records).toHaveLength(2)
  const [start, end] = ledger.records
  expect(start?.type).toBe('llm.request.start')
  expect(end?.type).toBe('llm.request.end')
  return { start: start as LLMRequestStartRecord, end: end as LLMRequestEndRecord }
}

function errorOf(events: readonly LLMStreamEvent[]): StreamErrorEvent {
  const last = events[events.length - 1]
  expect(last?.type).toBe('error')
  return last as StreamErrorEvent
}

function doneOf(events: readonly LLMStreamEvent[]): DoneEvent {
  const last = events[events.length - 1]
  expect(last?.type).toBe('done')
  return last as DoneEvent
}

const TOOL = { name: 'write_file', description: 'Write a file.', parameters: { type: 'object', properties: { path: { type: 'string' } } } }

describe('AnthropicProvider — streaming', () => {
  it('streams text, reports usage (with cache reads) and finishes with stop', async () => {
    fake = await startFakeAnthropic([{ sse: loadSseFixture('text'), headers: { 'request-id': 'req_123' } }])
    const { provider, ledger } = makeProvider(fake.baseUrl)
    const request = makeRequest()
    const events = await collect(provider.complete(request, { sessionId: 'sess-1' }))

    expectStreamInvariants(events)
    expect(textOf(events)).toBe('Hello, world.')
    expect(events.filter(event => event.type === 'usage')).toEqual([{
      type: 'usage',
      usage: { inputTokens: 300, outputTokens: 37, totalTokens: 849, cacheReadTokens: 512, cacheWriteTokens: 0, reasoningTokens: 'unknown' },
    }])
    const done = doneOf(events)
    expect(done.finishReason).toBe('stop')
    expect(done.providerContent).toEqual([{ type: 'text', text: 'Hello, world.' }])
    expect(done).not.toHaveProperty('refusal')

    const sent = fake.requests[0]
    expect(fake.requests).toHaveLength(1)
    expect(sent?.url).toBe('/v1/messages?beta=true')
    expect(sent?.headers['x-api-key']).toBe(TEST_KEY)
    expect(sent?.headers['anthropic-version']).toBeDefined()
    expect(sent?.headers).not.toHaveProperty('authorization')
    expect(sent?.body).toEqual({
      model: 'claude-sonnet-5-5',
      max_tokens: 64000,
      stream: true,
      system: 'You are a test.',
      messages: [{ role: 'user', content: 'Say hello.' }],
      thinking: ADAPTIVE,
      output_config: { effort: 'medium' },
      cache_control: { type: 'ephemeral' },
    })

    const { start, end } = pair(ledger)
    expect(start).toMatchObject({
      requestId: request.requestId, sessionId: 'sess-1', provider: 'anthropic', model: 'claude-sonnet-5-5', purpose: 'task', thinking: 'on',
    })
    expect(end).toMatchObject({
      requestId: request.requestId, status: 'ok', httpStatus: 200, finishReason: 'stop',
      usage: { inputTokens: 300, outputTokens: 37, totalTokens: 849, cacheReadTokens: 512, cacheWriteTokens: 0, reasoningTokens: 'unknown' },
    })
    expect(end).not.toHaveProperty('errorCode')
  })

  it('emits thinking as reasoning.delta and replays the reply verbatim through providerContent', async () => {
    fake = await startFakeAnthropic([{ sse: loadSseFixture('thinking') }, { sse: loadSseFixture('text') }])
    const { provider } = makeProvider(fake.baseUrl)
    const events = await collect(provider.complete(makeRequest({ thinking: 'on' })))
    expectStreamInvariants(events)
    expect(events.filter(event => event.type === 'reasoning.delta')).toEqual([
      { type: 'reasoning.delta', text: 'Checking the file ' },
      { type: 'reasoning.delta', text: 'first.' },
    ])
    expect(textOf(events)).toBe('Done.')
    const done = doneOf(events)
    expect(done.providerContent).toEqual([
      { type: 'thinking', thinking: 'Checking the file first.', signature: 'sig_abc123==' },
      { type: 'text', text: 'Done.' },
    ])
    expect(fake.requests[0]?.body['thinking']).toEqual(ADAPTIVE)

    // Round trip: the assistant turn is sent exactly as received, signature included.
    await collect(provider.complete(makeRequest({
      thinking: 'on',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'go' },
        { role: 'assistant', content: 'Done.', providerContent: done.providerContent as never },
        { role: 'user', content: 'thanks' },
      ],
    })))
    expect(fake.requests[1]?.body['messages']).toEqual([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: [
        { type: 'thinking', thinking: 'Checking the file first.', signature: 'sig_abc123==' },
        { type: 'text', text: 'Done.' },
      ] },
      { role: 'user', content: 'thanks' },
    ])
  })

  it('assembles a single streamed tool call and sends tool history in wire form', async () => {
    fake = await startFakeAnthropic([{ sse: loadSseFixture('tool-call') }])
    const { provider, ledger } = makeProvider(fake.baseUrl)
    const request = makeRequest({
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'list' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'toolu_0', name: 'list_dir', arguments: '{"path":"."}' }] },
        { role: 'tool', toolCallId: 'toolu_0', name: 'list_dir', content: 'a.txt', isError: false },
      ],
      tools: [TOOL],
      maxTokens: 512,
      temperature: 0.2,
    })
    const events = await collect(provider.complete(request))
    expectStreamInvariants(events)

    expect(events.map(event => event.type)).toEqual([
      'text.delta', 'tool-call.start', 'tool-call.delta', 'tool-call.delta', 'tool-call.delta', 'tool-call.end', 'usage', 'done',
    ])
    expect(events[1]).toEqual({ type: 'tool-call.start', index: 0, id: 'toolu_abc', name: 'write_file' })
    const end = events.find((event): event is ToolCallEndEvent => event.type === 'tool-call.end')
    expect(end?.call).toEqual({ id: 'toolu_abc', name: 'write_file', arguments: '{"path": "notes.md", "content": "hi"}' })
    expect(JSON.parse(end?.call.arguments ?? '')).toEqual({ path: 'notes.md', content: 'hi' })
    const done = doneOf(events)
    expect(done.finishReason).toBe('tool-calls')
    expect(done.providerContent).toEqual([
      { type: 'text', text: 'Writing the file.' },
      { type: 'tool_use', id: 'toolu_abc', name: 'write_file', input: { path: 'notes.md', content: 'hi' } },
    ])

    const body = fake.requests[0]?.body
    expect(body).toMatchObject({
      max_tokens: 512,
      tools: [{ name: 'write_file', description: 'Write a file.', input_schema: TOOL.parameters, eager_input_streaming: true }],
      messages: [
        { role: 'user', content: 'list' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_0', name: 'list_dir', input: { path: '.' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_0', content: 'a.txt' }] },
      ],
    })
    expect(body).not.toHaveProperty('temperature')
    expect(body).not.toHaveProperty('tool_choice')
    expect(pair(ledger).end).toMatchObject({ status: 'ok', finishReason: 'tool-calls', usage: { inputTokens: 120, cacheReadTokens: 0 } })
  })

  it('assembles parallel tool calls with their own 0-based index', async () => {
    fake = await startFakeAnthropic([{ sse: loadSseFixture('parallel-tool-calls') }])
    const { provider, ledger } = makeProvider(fake.baseUrl)
    const events = await collect(provider.complete(makeRequest()))
    expectStreamInvariants(events)
    expect(events.filter(event => event.type === 'tool-call.start')).toEqual([
      { type: 'tool-call.start', index: 0, id: 'toolu_read', name: 'read_file' },
      { type: 'tool-call.start', index: 1, id: 'toolu_list', name: 'list_dir' },
    ])
    expect(events.flatMap(event => event.type === 'tool-call.end' ? [event.call] : [])).toEqual([
      { id: 'toolu_read', name: 'read_file', arguments: '{"path":"a.txt"}' },
      { id: 'toolu_list', name: 'list_dir', arguments: '{"path":"."}' },
    ])
    expect(textOf(events)).toBe('')
    expect(doneOf(events).finishReason).toBe('tool-calls')
    expect(pair(ledger).end.usage).toEqual({ inputTokens: 200, outputTokens: 42, totalTokens: 342, cacheReadTokens: 100, cacheWriteTokens: 0, reasoningTokens: 'unknown' })
  })

  it('merges consecutive tool results into one user message, in order, with is_error', async () => {
    fake = await startFakeAnthropic([{ sse: loadSseFixture('text') }])
    const { provider } = makeProvider(fake.baseUrl)
    await collect(provider.complete(makeRequest({
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'do both' },
        { role: 'assistant', content: 'ok', toolCalls: [
          { id: 'toolu_a', name: 'read_file', arguments: '{"path":"a"}' },
          { id: 'toolu_b', name: 'read_file', arguments: 'not json' },
        ] },
        { role: 'tool', toolCallId: 'toolu_a', name: 'read_file', content: 'A', isError: false },
        { role: 'tool', toolCallId: 'toolu_b', name: 'read_file', content: 'boom', isError: true },
        { role: 'assistant', content: '' },
        { role: 'user', content: 'next' },
      ],
    })))
    expect(fake.requests[0]?.body['messages']).toEqual([
      { role: 'user', content: 'do both' },
      { role: 'assistant', content: [
        { type: 'text', text: 'ok' },
        { type: 'tool_use', id: 'toolu_a', name: 'read_file', input: { path: 'a' } },
        { type: 'tool_use', id: 'toolu_b', name: 'read_file', input: {} },
      ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'toolu_a', content: 'A' },
        { type: 'tool_result', tool_use_id: 'toolu_b', content: 'boom', is_error: true },
      ] },
      { role: 'assistant', content: [{ type: 'text', text: '' }] },
      { role: 'user', content: 'next' },
    ])
  })

  it('records unknown usage (never 0) when the stream reports none', async () => {
    fake = await startFakeAnthropic([{ sse: loadSseFixture('text-no-usage') }])
    const { provider, ledger } = makeProvider(fake.baseUrl)
    const events = await collect(provider.complete(makeRequest()))
    expectStreamInvariants(events)
    expect(events.some(event => event.type === 'usage')).toBe(false)
    expect(doneOf(events).finishReason).toBe('max-tokens')
    expect(pair(ledger).end).toMatchObject({ status: 'ok', finishReason: 'max-tokens', usage: UNKNOWN_USAGE })
  })

  it('maps a refusal stop to done/refusal with the stop details', async () => {
    fake = await startFakeAnthropic([{ sse: loadSseFixture('refusal') }])
    const { provider, ledger } = makeProvider(fake.baseUrl)
    const events = await collect(provider.complete(makeRequest()))
    expectStreamInvariants(events)
    expect(doneOf(events)).toMatchObject({
      type: 'done',
      finishReason: 'refusal',
      refusal: { category: 'cyber', explanation: 'The request could enable cyber harm.' },
    })
    expect(pair(ledger).end).toMatchObject({ status: 'ok', finishReason: 'refusal' })
  })

  it('maps pause_turn to done/pause and sends the paused reply back verbatim to continue', async () => {
    fake = await startFakeAnthropic([{ sse: loadSseFixture('pause-turn') }, { sse: loadSseFixture('text') }])
    const { provider, ledger } = makeProvider(fake.baseUrl)
    const first = makeRequest()
    const events = await collect(provider.complete(first))
    expectStreamInvariants(events)
    const done = doneOf(events)
    expect(done.finishReason).toBe('pause')
    expect(done.providerContent).toEqual([{ type: 'text', text: 'Searching the web.' }])
    expect(pair(ledger).end).toMatchObject({ status: 'ok', finishReason: 'pause' })
    await collect(provider.complete(makeRequest({
      messages: [...first.messages, { role: 'assistant', content: textOf(events), providerContent: done.providerContent! }],
    })))
    expect(fake.requests[1]?.body['messages']).toEqual([
      { role: 'user', content: 'Say hello.' },
      { role: 'assistant', content: [{ type: 'text', text: 'Searching the web.' }] },
    ])
  })

  it('is lazy: nothing is sent or recorded until iteration starts', async () => {
    fake = await startFakeAnthropic([{ sse: loadSseFixture('text') }])
    const { provider, ledger } = makeProvider(fake.baseUrl)
    const stream = provider.complete(makeRequest())
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(fake.requests).toHaveLength(0)
    expect(ledger.records).toHaveLength(0)
    await collect(stream)
    expect(fake.requests).toHaveLength(1)
  })

  it('maps thinking and effort: between_tools up to high, omitted at xhigh/max, adaptive when on', async () => {
    fake = await startFakeAnthropic([{ sse: loadSseFixture('text') }])
    const { provider } = makeProvider(fake.baseUrl, { effort: 'high' })
    await collect(provider.complete(makeRequest({ thinking: 'off' })))
    await collect(provider.complete(makeRequest({ effort: 'xhigh', thinking: 'off' })))
    await collect(provider.complete(makeRequest({ effort: 'max', thinking: 'on' })))
    await collect(provider.complete(makeRequest({ effort: 'low', thinking: 'on' })))
    const bodies = fake.requests.map(request => request.body)
    expect(bodies.map(body => body['thinking'])).toEqual([
      { type: 'between_tools' },
      undefined,
      ADAPTIVE,
      ADAPTIVE,
    ])
    expect(bodies.map(body => body['output_config'])).toEqual([
      { effort: 'high' }, { effort: 'xhigh' }, { effort: 'max' }, { effort: 'low' },
    ])
    for (const body of bodies) {
      expect(JSON.stringify(body)).not.toContain('budget_tokens')
      expect(JSON.stringify(body)).not.toContain('"disabled"')
    }
  })
})

// Connection refused takes ~2 s on Windows (SYN retries), hence the longer timeout.
describe('AnthropicProvider — failures (one ledger pair each, usage unknown, no retry)', { timeout: 15_000 }, () => {
  it.each([
    [400, '{"type":"error","error":{"type":"invalid_request_error","message":"messages: at least one message is required"}}', 'at least one message is required'],
    [429, '{"type":"error","error":{"type":"rate_limit_error","message":"rate limited"}}', 'rate limited'],
    [529, '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', 'Overloaded'],
  ])('HTTP %i → error event with httpStatus', async (status, body, message) => {
    fake = await startFakeAnthropic([{ status, body, headers: { 'request-id': 'req_42' } }])
    const { provider, ledger } = makeProvider(fake.baseUrl)
    const events = await collect(provider.complete(makeRequest()))
    expectStreamInvariants(events)
    expect(events).toHaveLength(1)
    const error = errorOf(events)
    expect(error.httpStatus).toBe(status)
    expect(error.providerRequestId).toBe('req_42')
    expect(error.error.code).toBe('llm/request-failed')
    expect(error.error.message).toContain(String(status))
    expect(error.error.message).toContain(message)
    expect(fake.requests).toHaveLength(1)

    const { end } = pair(ledger)
    expect(end).toMatchObject({ status: 'error', httpStatus: status, errorCode: 'llm/request-failed', usage: UNKNOWN_USAGE })
    expect(end).not.toHaveProperty('finishReason')
    expect(JSON.stringify(end)).not.toContain(message)
  })

  it('connection refused (network down) → llm/request-failed without httpStatus', async () => {
    const port = await closedPort()
    const { provider, ledger } = makeProvider(`http://127.0.0.1:${port}`)
    const events = await collect(provider.complete(makeRequest()))
    expectStreamInvariants(events)
    const error = errorOf(events)
    expect(error.error.code).toBe('llm/request-failed')
    expect(error.error.details).toMatchObject({ cause: 'ECONNREFUSED' })
    expect(error).not.toHaveProperty('httpStatus')
    const { end } = pair(ledger)
    expect(end).toMatchObject({ status: 'error', errorCode: 'llm/request-failed', usage: UNKNOWN_USAGE })
    expect(end).not.toHaveProperty('httpStatus')
  })

  it('request timeout before headers → llm/timeout', async () => {
    fake = await startFakeAnthropic([{ hangBeforeHeaders: true }])
    const { provider, ledger } = makeProvider(fake.baseUrl, { timeoutMs: 150 })
    const events = await collect(provider.complete(makeRequest()))
    expectStreamInvariants(events)
    const error = errorOf(events)
    expect(error.error.code).toBe('llm/timeout')
    expect(error.error.details).toMatchObject({ timeout: 'request', timeoutMs: 150 })
    const { end } = pair(ledger)
    expect(end).toMatchObject({ status: 'error', errorCode: 'llm/timeout', usage: UNKNOWN_USAGE })
    expect(end).not.toHaveProperty('httpStatus')
    expect(end.latencyMs).toBeGreaterThanOrEqual(100)
  })

  it('stream idle timeout mid-stream → llm/timeout after the text already yielded', async () => {
    fake = await startFakeAnthropic([{ sse: loadSseFixture('text'), hangAfter: 3 }])
    const { provider, ledger } = makeProvider(fake.baseUrl)
    const events = await collect(provider.complete(makeRequest(), { streamIdleTimeoutMs: 150 }))
    expectStreamInvariants(events)
    expect(textOf(events)).toBe('Hello')
    const error = errorOf(events)
    expect(error.error.code).toBe('llm/timeout')
    expect(error.error.details).toMatchObject({ timeout: 'idle' })
    expect(pair(ledger).end).toMatchObject({ status: 'error', errorCode: 'llm/timeout', httpStatus: 200, usage: UNKNOWN_USAGE })
  })

  it('caller abort mid-stream → done/aborted, connection closed, ledger aborted', async () => {
    fake = await startFakeAnthropic([{ sse: loadSseFixture('text'), hangAfter: 3 }])
    const { provider, ledger } = makeProvider(fake.baseUrl)
    const controller = new AbortController()
    const events: LLMStreamEvent[] = []
    for await (const event of provider.complete(makeRequest({ signal: controller.signal }))) {
      events.push(event)
      if (event.type === 'text.delta') controller.abort()
    }
    expectStreamInvariants(events)
    expect(textOf(events)).toBe('Hello')
    expect(events[events.length - 1]).toEqual({ type: 'done', finishReason: 'aborted' })
    await fake.closed(0)
    expect(pair(ledger).end).toMatchObject({ status: 'aborted', finishReason: 'aborted', httpStatus: 200, usage: UNKNOWN_USAGE })
  })

  it('an already-aborted signal sends nothing but still records the pair', async () => {
    fake = await startFakeAnthropic([{ sse: loadSseFixture('text') }])
    const { provider, ledger } = makeProvider(fake.baseUrl)
    const controller = new AbortController()
    controller.abort()
    const events = await collect(provider.complete(makeRequest({ signal: controller.signal })))
    expect(events).toEqual([{ type: 'done', finishReason: 'aborted' }])
    expect(fake.requests).toHaveLength(0)
    expect(pair(ledger).end).toMatchObject({ status: 'aborted', finishReason: 'aborted', usage: UNKNOWN_USAGE })
  })

  it('breaking out of the loop aborts the request and records it as aborted', async () => {
    fake = await startFakeAnthropic([{ sse: loadSseFixture('text'), hangAfter: 4 }])
    const { provider, ledger } = makeProvider(fake.baseUrl)
    for await (const event of provider.complete(makeRequest())) {
      if (event.type === 'text.delta') break
    }
    await fake.closed(0)
    expect(pair(ledger).end).toMatchObject({ status: 'aborted', finishReason: 'aborted', usage: UNKNOWN_USAGE })
  })

  it('malformed event → llm/invalid-response', async () => {
    fake = await startFakeAnthropic([{ sse: loadSseFixture('malformed') }])
    const { provider, ledger } = makeProvider(fake.baseUrl)
    const events = await collect(provider.complete(makeRequest()))
    expectStreamInvariants(events)
    expect(textOf(events)).toBe('partial')
    expect(errorOf(events).error.code).toBe('llm/invalid-response')
    expect(pair(ledger).end).toMatchObject({ status: 'error', errorCode: 'llm/invalid-response', httpStatus: 200, usage: UNKNOWN_USAGE })
  })

  it('an in-band error event → llm/request-failed', async () => {
    fake = await startFakeAnthropic([{ sse: [sseEvent({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })] }])
    const { provider } = makeProvider(fake.baseUrl)
    const error = errorOf(await collect(provider.complete(makeRequest())))
    expect(error.error).toMatchObject({ code: 'llm/request-failed', message: 'Overloaded' })
  })

  it('a stream that ends without a stop reason → llm/request-failed', async () => {
    fake = await startFakeAnthropic([{ sse: loadSseFixture('text').slice(0, 5) }])
    const { provider } = makeProvider(fake.baseUrl)
    const events = await collect(provider.complete(makeRequest()))
    expect(textOf(events)).toBe('Hello, world.')
    expect(errorOf(events).error.code).toBe('llm/request-failed')
  })

  it('connection dropped mid tool call → error, and the unfinished call is dropped', async () => {
    fake = await startFakeAnthropic([{ sse: loadSseFixture('partial-tool-call'), destroyAfter: 3 }])
    const { provider, ledger } = makeProvider(fake.baseUrl)
    const events = await collect(provider.complete(makeRequest()))
    expectStreamInvariants(events)
    expect(events.some(event => event.type === 'tool-call.start')).toBe(true)
    expect(events.some(event => event.type === 'tool-call.end')).toBe(false)
    expect(errorOf(events).error.code).toBe('llm/request-failed')
    expect(pair(ledger).end).toMatchObject({ status: 'error', usage: UNKNOWN_USAGE })
  })

  it('a missing API key fails before any request, still with a ledger pair', async () => {
    fake = await startFakeAnthropic([{ sse: loadSseFixture('text') }])
    const ledger = new MemoryLedger()
    const provider = createProvider({ credentials: memoryCredentials({}), ledger, endpoint: fake.baseUrl, env: {} })
    const events = await collect(provider.complete(makeRequest()))
    expect(errorOf(events).error.code).toBe('credentials/missing')
    expect(fake.requests).toHaveLength(0)
    expect(pair(ledger).end).toMatchObject({ status: 'error', errorCode: 'credentials/missing', usage: UNKNOWN_USAGE })
  })

  it('a failing ledger never changes the request outcome', async () => {
    fake = await startFakeAnthropic([{ sse: loadSseFixture('text') }])
    const ledger = new MemoryLedger(true)
    const { provider } = makeProvider(fake.baseUrl, { ledger })
    const events = await collect(provider.complete(makeRequest()))
    expect(doneOf(events).finishReason).toBe('stop')
    expect(ledger.writeFailures).toBe(2)
  })
})

const OVERLOADED = { status: 529, body: '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}' }
const FAST_RETRY = { maxRetries: 3, retryBaseDelayMs: 5, retryMaxDelayMs: 50 }

describe('AnthropicProvider — retries (ADR 0021)', { timeout: 15_000 }, () => {
  it('retries a 529 and a 429 before the reply, then streams the reply; one ledger pair per attempt', async () => {
    fake = await startFakeAnthropic([OVERLOADED, { status: 429, body: '{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}' }, { sse: loadSseFixture('text') }])
    const { provider, ledger } = makeProvider(fake.baseUrl, FAST_RETRY)
    const request = makeRequest()
    const events = await collect(provider.complete(request, { sessionId: 'sess-1' }))

    expectStreamInvariants(events)
    expect(textOf(events)).toBe('Hello, world.')
    expect(doneOf(events).finishReason).toBe('stop')
    const retries = events.filter(event => event.type === 'retry')
    expect(retries).toEqual([
      expect.objectContaining({ type: 'retry', attempt: 2, error: expect.objectContaining({ code: 'llm/request-failed' }) }),
      expect.objectContaining({ type: 'retry', attempt: 3 }),
    ])
    for (const retry of retries) expect(retry.type === 'retry' && retry.delayMs).toBeLessThanOrEqual(50)
    expect(fake.requests).toHaveLength(3)

    expect(ledger.records.map(record => [record.type, (record as { attempt?: number }).attempt, (record as { status?: string }).status])).toEqual([
      ['llm.request.start', undefined, undefined],
      ['llm.request.end', undefined, 'error'],
      ['llm.request.start', 2, undefined],
      ['llm.request.end', 2, 'error'],
      ['llm.request.start', 3, undefined],
      ['llm.request.end', 3, 'ok'],
    ])
    expect(new Set(ledger.records.map(record => (record as { requestId: string }).requestId))).toEqual(new Set([request.requestId]))
  })

  it('honours retry-after from the server (capped at retryMaxDelayMs)', async () => {
    fake = await startFakeAnthropic([{ ...OVERLOADED, headers: { 'retry-after': '0.02' } }, { sse: loadSseFixture('text') }])
    const { provider } = makeProvider(fake.baseUrl, FAST_RETRY)
    const events = await collect(provider.complete(makeRequest()))
    expect(events.find(event => event.type === 'retry')).toMatchObject({ delayMs: 20 })
    expect(doneOf(events).finishReason).toBe('stop')
  })

  it('retries an in-band overloaded error and a refused connection', async () => {
    fake = await startFakeAnthropic([{ sse: [sseEvent({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })] }, { sse: loadSseFixture('text') }])
    const { provider } = makeProvider(fake.baseUrl, FAST_RETRY)
    expect(textOf(await collect(provider.complete(makeRequest())))).toBe('Hello, world.')

    const port = await closedPort()
    const refused = makeProvider(`http://127.0.0.1:${port}`, { ...FAST_RETRY, maxRetries: 2 })
    const events = await collect(refused.provider.complete(makeRequest()))
    expect(events.filter(event => event.type === 'retry')).toHaveLength(2)
    const error = errorOf(events)
    expect(error.error.message).toContain('after 3 attempts')
    expect(error.error.details).toMatchObject({ attempts: 3, retryable: true, cause: 'ECONNREFUSED' })
    expect(refused.ledger.records).toHaveLength(6)
  })

  it('gives up after maxRetries and reports the last error as retryable', async () => {
    fake = await startFakeAnthropic([OVERLOADED])
    const { provider, ledger } = makeProvider(fake.baseUrl, { ...FAST_RETRY, maxRetries: 2 })
    const events = await collect(provider.complete(makeRequest()))
    expectStreamInvariants(events)
    expect(fake.requests).toHaveLength(3)
    expect(errorOf(events).error.details).toMatchObject({ attempts: 3, retryable: true, providerType: 'overloaded_error' })
    expect(ledger.records.filter(record => record.type === 'llm.request.end')).toHaveLength(3)
  })

  it('does not retry a request error, a timeout, or a failure after text was streamed', async () => {
    fake = await startFakeAnthropic([{ status: 400, body: '{"type":"error","error":{"type":"invalid_request_error","message":"bad"}}' }])
    const bad = makeProvider(fake.baseUrl, FAST_RETRY)
    const badError = errorOf(await collect(bad.provider.complete(makeRequest())))
    expect(fake.requests).toHaveLength(1)
    expect(badError.error.details).toMatchObject({ attempts: 1, retryable: false })
    await fake.close()

    fake = await startFakeAnthropic([{ sse: loadSseFixture('text').slice(0, 5) }, { sse: loadSseFixture('text') }])
    const cut = makeProvider(fake.baseUrl, FAST_RETRY)
    const events = await collect(cut.provider.complete(makeRequest()))
    expect(textOf(events)).toBe('Hello, world.')
    expect(errorOf(events).error.details).toMatchObject({ retryable: false })
    expect(fake.requests).toHaveLength(1)
    await fake.close()

    fake = await startFakeAnthropic([{ hangBeforeHeaders: true }])
    const slow = makeProvider(fake.baseUrl, { ...FAST_RETRY, timeoutMs: 100 })
    expect(errorOf(await collect(slow.provider.complete(makeRequest()))).error.code).toBe('llm/timeout')
    expect(fake.requests).toHaveLength(1)
  })

  it('retries a stream that stalled before any text, but not one that stalled after', async () => {
    fake = await startFakeAnthropic([{ sse: loadSseFixture('text'), hangAfter: 1 }, { sse: loadSseFixture('text') }])
    const { provider } = makeProvider(fake.baseUrl, FAST_RETRY)
    const events = await collect(provider.complete(makeRequest(), { streamIdleTimeoutMs: 150 }))
    expect(events.find(event => event.type === 'retry')).toMatchObject({ error: { code: 'llm/timeout' } })
    expect(textOf(events)).toBe('Hello, world.')
    await fake.close()

    fake = await startFakeAnthropic([{ sse: loadSseFixture('text'), hangAfter: 3 }, { sse: loadSseFixture('text') }])
    const late = makeProvider(fake.baseUrl, FAST_RETRY)
    const stalled = await collect(late.provider.complete(makeRequest(), { streamIdleTimeoutMs: 150 }))
    expect(textOf(stalled)).toBe('Hello')
    expect(errorOf(stalled).error.code).toBe('llm/timeout')
    expect(fake.requests).toHaveLength(1)
  })

  it('an abort during the wait ends the stream as aborted without another attempt', async () => {
    fake = await startFakeAnthropic([OVERLOADED, { sse: loadSseFixture('text') }])
    const { provider } = makeProvider(fake.baseUrl, { maxRetries: 3, retryBaseDelayMs: 5_000, retryMaxDelayMs: 5_000 })
    const controller = new AbortController()
    const events: LLMStreamEvent[] = []
    for await (const event of provider.complete(makeRequest({ signal: controller.signal }))) {
      events.push(event)
      if (event.type === 'retry') controller.abort()
    }
    expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'aborted' })
    expect(fake.requests).toHaveLength(1)
  })

  it('flags a prompt that exceeds the context window', async () => {
    fake = await startFakeAnthropic([{ status: 400, body: '{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 1012345 tokens > 1000000 maximum"}}' }])
    const { provider } = makeProvider(fake.baseUrl, FAST_RETRY)
    const error = errorOf(await collect(provider.complete(makeRequest())))
    expect(error.error.details).toMatchObject({ contextOverflow: true, retryable: false })
    expect(isContextOverflow(400, 'messages: at least one message is required')).toBe(false)
    expect(isContextOverflow(413, 'Request exceeds the maximum context length')).toBe(true)
  })

  it('classifies retryable failures', () => {
    const failure = (details: Record<string, unknown>, httpStatus?: number): StreamErrorEvent => ({
      type: 'error',
      error: { name: 'NexgentError', code: 'llm/request-failed', message: 'x', details },
      ...(httpStatus === undefined ? {} : { httpStatus }),
    })
    expect(DEFAULT_MAX_RETRIES).toBe(6)
    expect(isRetryable(failure({}, 503))).toBe(true)
    expect(isRetryable(failure({}, 401))).toBe(false)
    expect(isRetryable(failure({ providerType: 'api_error' }, 200))).toBe(true)
    expect(isRetryable(failure({ providerType: 'invalid_request_error' }, 400))).toBe(false)
    expect(isRetryable(failure({ cause: 'ECONNRESET' }))).toBe(true)
    expect(isRetryable({ type: 'error', error: { name: 'NexgentError', code: 'llm/timeout', message: 'x', details: { timeout: 'request' } } })).toBe(false)
    expect(isRetryable({ type: 'error', error: { name: 'NexgentError', code: 'llm/timeout', message: 'x', details: { timeout: 'idle' } } })).toBe(true)
  })
})

describe('AnthropicProvider — configuration and secrets', () => {
  it('defaults to the Claude API route from DEFAULT_PROJECT_CONFIG', () => {
    const provider = createProvider({ credentials: memoryCredentials({}), ledger: new MemoryLedger(), env: {} })
    expect(provider).toBeInstanceOf(AnthropicProvider)
    expect(provider.info).toEqual({ id: 'anthropic', endpoint: DEFAULT_PROJECT_CONFIG.endpoint, defaultModel: 'claude-sonnet-5-5' })
    expect(provider.info.endpoint).toBe('https://api.anthropic.com')
  })

  it('rejects a negative or fractional maxRetries, bad effort and non-http endpoints', () => {
    const base = { credentials: memoryCredentials({}), ledger: new MemoryLedger(), env: {} }
    expect(() => createProvider({ ...base, maxRetries: -1 })).toThrow(expect.objectContaining({ code: 'config/invalid' }))
    expect(() => createProvider({ ...base, maxRetries: 1.5 })).toThrow(expect.objectContaining({ code: 'config/invalid' }))
    expect(() => createProvider({ ...base, maxRetries: 3 })).not.toThrow()
    expect(() => createProvider({ ...base, effort: 'ultra' as never })).toThrow(expect.objectContaining({ code: 'config/invalid' }))
    let thrown: unknown
    try {
      createProvider({ ...base, endpoint: 'ftp://example.com' })
    } catch (error) {
      thrown = error
    }
    expect(isNexgentError(thrown, 'config/invalid')).toBe(true)
  })

  it('NEXGENT_API_BASE_URL overrides the configured endpoint', async () => {
    fake = await startFakeAnthropic([{ sse: loadSseFixture('text') }])
    const { provider, ledger } = makeProvider('https://unused.invalid', { env: { [NEXGENT_API_BASE_URL]: fake.baseUrl } })
    expect(provider.info.endpoint).toBe(fake.baseUrl)
    const events = await collect(provider.complete(makeRequest()))
    expect(events[events.length - 1]?.type).toBe('done')
    expect(pair(ledger).start.endpoint).toBe(fake.baseUrl)
  })

  it('falls back to ANTHROPIC_API_KEY when the credential is unset', async () => {
    fake = await startFakeAnthropic([{ sse: loadSseFixture('text') }])
    const provider = createProvider({
      credentials: memoryCredentials({}), ledger: new MemoryLedger(), endpoint: fake.baseUrl, env: { ANTHROPIC_API_KEY: 'sk-ant-env-key-0000' },
    })
    await collect(provider.complete(makeRequest()))
    expect(fake.requests[0]?.headers['x-api-key']).toBe('sk-ant-env-key-0000')
  })

  it('sends fallbacks only to the Claude API host, on the beta route', async () => {
    fake = await startFakeAnthropic([{ sse: loadSseFixture('text') }])
    const { provider } = makeProvider(fake.baseUrl)
    await collect(provider.complete(makeRequest()))
    expect(fake.requests[0]?.body).not.toHaveProperty('fallbacks')
    expect(fake.requests[0]?.headers['anthropic-beta']).toBe(THINKING_BINDING_BETA)

    // Real host: route the SDK's fetch to the fake while keeping the configured URL.
    const target = fake.baseUrl
    const routed = (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      return fetch(`${target}${url.pathname}${url.search}`, init)
    }
    for (const fallbacks of ['default', 'off'] as const) {
      const real = createProvider({
        credentials: memoryCredentials({ NEXGENT_API_KEY: TEST_KEY }), ledger: new MemoryLedger(), env: {}, fetch: routed, fallbacks,
      })
      expect(real.info.endpoint).toBe('https://api.anthropic.com')
      await collect(real.complete(makeRequest()))
    }
    const [, withFallback, without] = fake.requests
    expect(withFallback?.body['fallbacks']).toBe('default')
    expect(withFallback?.headers['anthropic-beta']).toContain(FALLBACK_BETA)
    expect(withFallback?.body).toMatchObject({ thinking: ADAPTIVE, output_config: { effort: 'medium' }, cache_control: { type: 'ephemeral' } })
    expect(without?.body).not.toHaveProperty('fallbacks')
    expect(without?.headers['anthropic-beta']).toBe(THINKING_BINDING_BETA)
  })

  it('stamps purpose and attribution (provider-level, overridden per call) on both records', async () => {
    fake = await startFakeAnthropic([{ sse: loadSseFixture('text') }])
    const { provider, ledger } = makeProvider(fake.baseUrl, { attribution: { memberId: 'm-1', executionForm: 'direct' } })
    await collect(provider.complete(makeRequest(), { purpose: 'auxiliary', taskId: 't-9', executionForm: 'delegated' }))
    const { start, end } = pair(ledger)
    for (const record of [start, end]) {
      expect(record).toMatchObject({ memberId: 'm-1', executionForm: 'delegated', taskId: 't-9' })
      expect(record).not.toHaveProperty('capabilityVersion')
    }
    expect(start.purpose).toBe('auxiliary')
  })

  it('stamps an improvement job and phase on both records (step 5)', async () => {
    fake = await startFakeAnthropic([{ sse: loadSseFixture('text') }])
    const { provider, ledger } = makeProvider(fake.baseUrl)
    await collect(provider.complete(makeRequest(), { taskId: 't-1', improvementId: 'job-1', improvementPhase: 'diagnose' }))
    const { start, end } = pair(ledger)
    for (const record of [start, end]) expect(record).toMatchObject({ taskId: 't-1', improvementId: 'job-1', improvementPhase: 'diagnose' })
  })

  it('stamps the improver version and comparison arm on both records (step 6)', async () => {
    fake = await startFakeAnthropic([{ sse: loadSseFixture('text') }])
    const { provider, ledger } = makeProvider(fake.baseUrl)
    const step6 = { improvementId: 'arm-1', improvementPhase: 'trial', improverVersion: 'v0', metaJobId: 'meta-1', comparisonArm: 'child' } as const
    await collect(provider.complete(makeRequest(), step6))
    const { start, end } = pair(ledger)
    for (const record of [start, end]) expect(record).toMatchObject(step6)
  })

  it('never puts the API key in errors, events or ledger records', async () => {
    fake = await startFakeAnthropic([{ status: 401, echoApiKey: true }])
    const { provider, ledger } = makeProvider(fake.baseUrl)
    const events = await collect(provider.complete(makeRequest()))
    const error = errorOf(events)
    expect(error.httpStatus).toBe(401)
    expect(error.error.message).toContain('[REDACTED]')
    expect(JSON.stringify(events)).not.toContain(TEST_KEY)
    expect(JSON.stringify(ledger.records)).not.toContain(TEST_KEY)
  })

  it('strips credentials from the endpoint before recording it', async () => {
    fake = await startFakeAnthropic([{ sse: loadSseFixture('text') }])
    const withUser = fake.baseUrl.replace('http://', 'http://user:hunter2@')
    const { provider, ledger } = makeProvider(withUser)
    expect(provider.info.endpoint).toBe(fake.baseUrl)
    await collect(provider.complete(makeRequest()))
    expect(JSON.stringify(ledger.records)).not.toContain('hunter2')
  })
})
