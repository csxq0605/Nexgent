import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_PROJECT_CONFIG,
  isNexgentError,
  UNKNOWN_USAGE,
  type LLMRequestEndRecord,
  type LLMRequestStartRecord,
  type LLMStreamEvent,
  type StreamErrorEvent,
  type ToolCallEndEvent,
} from '@nexgent/kernel'
import { createProvider, NEXGENT_API_BASE_URL, OpenAICompatibleProvider } from '../src/index.js'
import { closedPort, loadSseFixture, startFakeOpenAI, type FakeOpenAI } from './helpers/fake-openai.js'
import { memoryCredentials, MemoryLedger } from './helpers/fakes.js'
import { collect, expectStreamInvariants, makeProvider, makeRequest, TEST_KEY } from './helpers/stream.js'

let fake: FakeOpenAI | undefined
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

function text(events: readonly LLMStreamEvent[]): string {
  return events.flatMap(event => event.type === 'text.delta' ? [event.text] : []).join('')
}

describe('OpenAICompatibleProvider — streaming', () => {
  it('streams text, reports usage and finishes with stop', async () => {
    fake = await startFakeOpenAI([{ sse: loadSseFixture('text'), headers: { 'x-request-id': 'req-123' } }])
    const { provider, ledger } = makeProvider(fake.baseUrl)
    const request = makeRequest()
    const events = await collect(provider.complete(request, { sessionId: 'sess-1' }))

    expectStreamInvariants(events)
    expect(text(events)).toBe('Hello, world.')
    expect(events.filter(event => event.type === 'usage')).toEqual([{
      type: 'usage',
      usage: { inputTokens: 300, outputTokens: 37, totalTokens: 849, cacheReadTokens: 512, reasoningTokens: 0 },
    }])
    expect(events[events.length - 1]).toEqual({ type: 'done', finishReason: 'stop' })

    const sent = fake.requests[0]
    expect(fake.requests).toHaveLength(1)
    expect(sent?.url).toBe('/v1/chat/completions')
    expect(sent?.headers.authorization).toBe(`Bearer ${TEST_KEY}`)
    expect(sent?.body).toMatchObject({
      model: 'mimo-v2.6-pro',
      stream: true,
      stream_options: { include_usage: true },
      thinking: { type: 'disabled' },
      messages: [
        { role: 'system', content: 'You are a test.' },
        { role: 'user', content: 'Say hello.' },
      ],
    })
    expect(sent?.body).not.toHaveProperty('tools')

    const { start, end } = pair(ledger)
    expect(start).toMatchObject({
      requestId: request.requestId, sessionId: 'sess-1', provider: 'mimo', model: 'mimo-v2.6-pro', purpose: 'task', thinking: 'off',
    })
    expect(end).toMatchObject({
      requestId: request.requestId, status: 'ok', httpStatus: 200, finishReason: 'stop',
      usage: { inputTokens: 300, outputTokens: 37, totalTokens: 849, cacheReadTokens: 512, reasoningTokens: 0 },
    })
    expect(end).not.toHaveProperty('errorCode')
  })

  it('assembles a single streamed tool call and sends tool history in wire form', async () => {
    fake = await startFakeOpenAI([{ sse: loadSseFixture('tool-call') }])
    const { provider, ledger } = makeProvider(fake.baseUrl)
    const request = makeRequest({
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'list' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'call_0', name: 'list_dir', arguments: '{"path":"."}' }] },
        { role: 'tool', toolCallId: 'call_0', name: 'list_dir', content: 'a.txt', isError: false },
      ],
      tools: [{ name: 'write_file', description: 'Write a file.', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
      maxTokens: 512,
      temperature: 0.2,
    })
    const events = await collect(provider.complete(request))
    expectStreamInvariants(events)

    expect(events.map(event => event.type)).toEqual([
      'text.delta', 'tool-call.start', 'tool-call.delta', 'tool-call.delta', 'tool-call.delta', 'tool-call.end', 'usage', 'done',
    ])
    expect(events[1]).toEqual({ type: 'tool-call.start', index: 0, id: 'call_abc', name: 'write_file' })
    const end = events.find((event): event is ToolCallEndEvent => event.type === 'tool-call.end')
    expect(end?.call).toEqual({ id: 'call_abc', name: 'write_file', arguments: '{"path": "notes.md", "content": "hi"}' })
    expect(JSON.parse(end?.call.arguments ?? '')).toEqual({ path: 'notes.md', content: 'hi' })
    expect(events[events.length - 1]).toEqual({ type: 'done', finishReason: 'tool-calls' })

    expect(fake.requests[0]?.body).toMatchObject({
      max_tokens: 512,
      temperature: 0.2,
      tools: [{ type: 'function', function: { name: 'write_file', description: 'Write a file.', parameters: { type: 'object' } } }],
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'list' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'call_0', type: 'function', function: { name: 'list_dir', arguments: '{"path":"."}' } }] },
        { role: 'tool', tool_call_id: 'call_0', content: 'a.txt' },
      ],
    })
    expect(pair(ledger).end).toMatchObject({ status: 'ok', finishReason: 'tool-calls', usage: { inputTokens: 120, cacheReadTokens: 0 } })
  })

  it('assembles multiple parallel tool calls keyed by index', async () => {
    fake = await startFakeOpenAI([{ sse: loadSseFixture('parallel-tool-calls') }])
    const { provider, ledger } = makeProvider(fake.baseUrl)
    const events = await collect(provider.complete(makeRequest()))
    expectStreamInvariants(events)

    const starts = events.filter(event => event.type === 'tool-call.start')
    expect(starts).toEqual([
      { type: 'tool-call.start', index: 0, id: 'call_read', name: 'read_file' },
      { type: 'tool-call.start', index: 1, id: 'call_list', name: 'list_dir' },
    ])
    const calls = events.flatMap(event => event.type === 'tool-call.end' ? [event.call] : [])
    expect(calls).toEqual([
      { id: 'call_read', name: 'read_file', arguments: '{"path":"a.txt"}' },
      { id: 'call_list', name: 'list_dir', arguments: '{"path":"."}' },
    ])
    expect(text(events)).toBe('')
    expect(events[events.length - 1]).toEqual({ type: 'done', finishReason: 'tool-calls' })
    // DeepSeek-style cache field and separate reasoning tokens.
    expect(pair(ledger).end.usage).toEqual({ inputTokens: 200, outputTokens: 42, totalTokens: 342, cacheReadTokens: 100, reasoningTokens: 5 })
  })

  it('records unknown usage (never 0) when the stream reports none', async () => {
    fake = await startFakeOpenAI([{ sse: loadSseFixture('text-no-usage') }])
    const { provider, ledger } = makeProvider(fake.baseUrl)
    const events = await collect(provider.complete(makeRequest()))
    expectStreamInvariants(events)
    expect(events.some(event => event.type === 'usage')).toBe(false)
    expect(events[events.length - 1]).toEqual({ type: 'done', finishReason: 'max-tokens' })
    expect(pair(ledger).end).toMatchObject({ status: 'ok', finishReason: 'max-tokens', usage: UNKNOWN_USAGE })
  })

  it('is lazy: nothing is sent or recorded until iteration starts', async () => {
    fake = await startFakeOpenAI([{ sse: loadSseFixture('text') }])
    const { provider, ledger } = makeProvider(fake.baseUrl)
    const stream = provider.complete(makeRequest())
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(fake.requests).toHaveLength(0)
    expect(ledger.records).toHaveLength(0)
    await collect(stream)
    expect(fake.requests).toHaveLength(1)
  })

  it('sends the configured thinking parameters', async () => {
    fake = await startFakeOpenAI([{ sse: loadSseFixture('text') }])
    const { provider } = makeProvider(fake.baseUrl)
    await collect(provider.complete(makeRequest({ thinking: 'on' })))
    expect(fake.requests[0]?.body['thinking']).toEqual({ type: 'enabled' })

    const custom = makeProvider(fake.baseUrl, {
      thinkingParams: { off: { enable_thinking: false }, on: { enable_thinking: true } },
      maxTokensField: 'max_completion_tokens',
    }).provider
    await collect(custom.complete(makeRequest({ maxTokens: 10 })))
    expect(fake.requests[1]?.body).toMatchObject({ enable_thinking: false, max_completion_tokens: 10 })
    expect(fake.requests[1]?.body).not.toHaveProperty('thinking')
  })
})

// Connection refused takes ~2 s on Windows (SYN retries), hence the longer timeout.
describe('OpenAICompatibleProvider — failures (one ledger pair each, usage unknown, no retry)', { timeout: 15_000 }, () => {
  it.each([
    [400, '{"error":{"message":"bad request: messages must not be empty"}}', 'bad request: messages must not be empty'],
    [429, '{"error":{"message":"rate limited"}}', 'rate limited'],
    [503, 'upstream unavailable', 'upstream unavailable'],
  ])('HTTP %i → error event with httpStatus', async (status, body, message) => {
    fake = await startFakeOpenAI([{ status, body, headers: { 'x-request-id': 'prov-42' } }])
    const { provider, ledger } = makeProvider(fake.baseUrl)
    const events = await collect(provider.complete(makeRequest()))
    expectStreamInvariants(events)
    expect(events).toHaveLength(1)
    const error = errorOf(events)
    expect(error.httpStatus).toBe(status)
    expect(error.providerRequestId).toBe('prov-42')
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
    const { provider, ledger } = makeProvider(`http://127.0.0.1:${port}/v1`)
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
    fake = await startFakeOpenAI([{ hangBeforeHeaders: true }])
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
    fake = await startFakeOpenAI([{ sse: loadSseFixture('text'), hangAfter: 2 }])
    const { provider, ledger } = makeProvider(fake.baseUrl)
    const events = await collect(provider.complete(makeRequest(), { streamIdleTimeoutMs: 150 }))
    expectStreamInvariants(events)
    expect(text(events)).toBe('Hello')
    const error = errorOf(events)
    expect(error.error.code).toBe('llm/timeout')
    expect(error.error.details).toMatchObject({ timeout: 'idle' })
    expect(pair(ledger).end).toMatchObject({ status: 'error', errorCode: 'llm/timeout', httpStatus: 200, usage: UNKNOWN_USAGE })
  })

  it('caller abort mid-stream → done/aborted, connection closed, ledger aborted', async () => {
    fake = await startFakeOpenAI([{ sse: loadSseFixture('text'), hangAfter: 2 }])
    const { provider, ledger } = makeProvider(fake.baseUrl)
    const controller = new AbortController()
    const events: LLMStreamEvent[] = []
    for await (const event of provider.complete(makeRequest({ signal: controller.signal }))) {
      events.push(event)
      if (event.type === 'text.delta') controller.abort()
    }
    expectStreamInvariants(events)
    expect(text(events)).toBe('Hello')
    expect(events[events.length - 1]).toEqual({ type: 'done', finishReason: 'aborted' })
    await fake.closed(0)
    expect(pair(ledger).end).toMatchObject({ status: 'aborted', finishReason: 'aborted', httpStatus: 200, usage: UNKNOWN_USAGE })
  })

  it('an already-aborted signal sends nothing but still records the pair', async () => {
    fake = await startFakeOpenAI([{ sse: loadSseFixture('text') }])
    const { provider, ledger } = makeProvider(fake.baseUrl)
    const controller = new AbortController()
    controller.abort()
    const events = await collect(provider.complete(makeRequest({ signal: controller.signal })))
    expect(events).toEqual([{ type: 'done', finishReason: 'aborted' }])
    expect(fake.requests).toHaveLength(0)
    expect(pair(ledger).end).toMatchObject({ status: 'aborted', finishReason: 'aborted', usage: UNKNOWN_USAGE })
  })

  it('breaking out of the loop aborts the request and records it as aborted', async () => {
    fake = await startFakeOpenAI([{ sse: loadSseFixture('text'), hangAfter: 3 }])
    const { provider, ledger } = makeProvider(fake.baseUrl)
    for await (const event of provider.complete(makeRequest())) {
      if (event.type === 'text.delta') break
    }
    await fake.closed(0)
    expect(pair(ledger).end).toMatchObject({ status: 'aborted', finishReason: 'aborted', usage: UNKNOWN_USAGE })
  })

  it('malformed chunk → llm/invalid-response', async () => {
    fake = await startFakeOpenAI([{ sse: loadSseFixture('malformed') }])
    const { provider, ledger } = makeProvider(fake.baseUrl)
    const events = await collect(provider.complete(makeRequest()))
    expectStreamInvariants(events)
    expect(text(events)).toBe('partial')
    expect(errorOf(events).error.code).toBe('llm/invalid-response')
    expect(pair(ledger).end).toMatchObject({ status: 'error', errorCode: 'llm/invalid-response', httpStatus: 200, usage: UNKNOWN_USAGE })
  })

  it('a chunk of the wrong shape → llm/invalid-response', async () => {
    fake = await startFakeOpenAI([{ sse: ['data: {"choices":"nope"}\n\n', 'data: [DONE]\n\n'] }])
    const { provider } = makeProvider(fake.baseUrl)
    const events = await collect(provider.complete(makeRequest()))
    expect(errorOf(events).error.code).toBe('llm/invalid-response')
  })

  it('an in-band error object → llm/request-failed', async () => {
    fake = await startFakeOpenAI([{ sse: ['data: {"error":{"message":"overloaded","code":"server_busy"}}\n\n'] }])
    const { provider } = makeProvider(fake.baseUrl)
    const error = errorOf(await collect(provider.complete(makeRequest())))
    expect(error.error).toMatchObject({ code: 'llm/request-failed', message: 'overloaded', details: { providerCode: 'server_busy' } })
  })

  it('connection dropped mid tool call → error, and the unfinished call is dropped', async () => {
    fake = await startFakeOpenAI([{ sse: loadSseFixture('partial-tool-call'), destroyAfter: 2 }])
    const { provider, ledger } = makeProvider(fake.baseUrl)
    const events = await collect(provider.complete(makeRequest()))
    expectStreamInvariants(events)
    expect(events.some(event => event.type === 'tool-call.start')).toBe(true)
    expect(events.some(event => event.type === 'tool-call.end')).toBe(false)
    expect(errorOf(events).error.code).toBe('llm/request-failed')
    expect(pair(ledger).end).toMatchObject({ status: 'error', usage: UNKNOWN_USAGE })
  })

  it('a missing API key fails before any request, still with a ledger pair', async () => {
    fake = await startFakeOpenAI([{ sse: loadSseFixture('text') }])
    const ledger = new MemoryLedger()
    const provider = createProvider({ credentials: memoryCredentials({}), ledger, endpoint: fake.baseUrl, env: {}, proxy: 'none' })
    const events = await collect(provider.complete(makeRequest()))
    expect(errorOf(events).error.code).toBe('credentials/missing')
    expect(fake.requests).toHaveLength(0)
    expect(pair(ledger).end).toMatchObject({ status: 'error', errorCode: 'credentials/missing', usage: UNKNOWN_USAGE })
  })

  it('a failing ledger never changes the request outcome', async () => {
    fake = await startFakeOpenAI([{ sse: loadSseFixture('text') }])
    const ledger = new MemoryLedger(true)
    const { provider } = makeProvider(fake.baseUrl, { ledger })
    const events = await collect(provider.complete(makeRequest()))
    expect(events[events.length - 1]).toEqual({ type: 'done', finishReason: 'stop' })
    expect(ledger.writeFailures).toBe(2)
  })
})

describe('OpenAICompatibleProvider — configuration and secrets', () => {
  it('defaults to the MiMo route from DEFAULT_PROJECT_CONFIG', () => {
    const provider = createProvider({ credentials: memoryCredentials({}), ledger: new MemoryLedger(), env: {} })
    expect(provider).toBeInstanceOf(OpenAICompatibleProvider)
    expect(provider.info).toEqual({ id: 'mimo', endpoint: DEFAULT_PROJECT_CONFIG.endpoint, defaultModel: 'mimo-v2.6-pro' })
  })

  it('rejects maxRetries other than 0 and non-http endpoints', () => {
    const base = { credentials: memoryCredentials({}), ledger: new MemoryLedger(), env: {} }
    expect(() => createProvider({ ...base, maxRetries: 2 as 0 })).toThrow(expect.objectContaining({ code: 'config/invalid' }))
    let thrown: unknown
    try {
      createProvider({ ...base, endpoint: 'ftp://example.com' })
    } catch (error) {
      thrown = error
    }
    expect(isNexgentError(thrown, 'config/invalid')).toBe(true)
  })

  it('NEXGENT_API_BASE_URL overrides the configured endpoint', async () => {
    fake = await startFakeOpenAI([{ sse: loadSseFixture('text') }])
    const { provider, ledger } = makeProvider('https://unused.invalid/v1', { env: { [NEXGENT_API_BASE_URL]: fake.baseUrl } })
    expect(provider.info.endpoint).toBe(fake.baseUrl)
    const events = await collect(provider.complete(makeRequest()))
    expect(events[events.length - 1]?.type).toBe('done')
    expect(pair(ledger).start.endpoint).toBe(fake.baseUrl)
  })

  it('stamps purpose and attribution (provider-level, overridden per call) on both records', async () => {
    fake = await startFakeOpenAI([{ sse: loadSseFixture('text') }])
    const { provider, ledger } = makeProvider(fake.baseUrl, { attribution: { memberId: 'm-1', executionForm: 'direct' } })
    await collect(provider.complete(makeRequest(), { purpose: 'auxiliary', taskId: 't-9', executionForm: 'delegated' }))
    const { start, end } = pair(ledger)
    for (const record of [start, end]) {
      expect(record).toMatchObject({ memberId: 'm-1', executionForm: 'delegated', taskId: 't-9' })
      expect(record).not.toHaveProperty('capabilityVersion')
    }
    expect(start.purpose).toBe('auxiliary')
  })

  it('never puts the API key in errors, events or ledger records', async () => {
    fake = await startFakeOpenAI([{ status: 401, echoAuthorization: true }])
    const { provider, ledger } = makeProvider(fake.baseUrl)
    const events = await collect(provider.complete(makeRequest()))
    const error = errorOf(events)
    expect(error.httpStatus).toBe(401)
    expect(error.error.message).toContain('[REDACTED]')
    expect(JSON.stringify(events)).not.toContain(TEST_KEY)
    expect(JSON.stringify(ledger.records)).not.toContain(TEST_KEY)
  })

  it('strips credentials from the endpoint before recording it', async () => {
    fake = await startFakeOpenAI([{ sse: loadSseFixture('text') }])
    const withUser = fake.baseUrl.replace('http://', 'http://user:hunter2@')
    const { provider, ledger } = makeProvider(withUser)
    expect(provider.info.endpoint).toBe(fake.baseUrl)
    await collect(provider.complete(makeRequest()))
    expect(JSON.stringify(ledger.records)).not.toContain('hunter2')
  })
})
