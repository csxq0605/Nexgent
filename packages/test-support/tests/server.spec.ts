import { afterEach, describe, expect, it } from 'vitest'
import { closedPortUrl, scriptedModelServer, type ScriptedModelServer } from '../src/index.js'

let server: ScriptedModelServer | undefined
afterEach(async () => {
  await server?.close()
  server = undefined
})

async function post(body: unknown, headers: Record<string, string> = {}, signal?: AbortSignal): Promise<Response> {
  return fetch(`${server!.baseUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'sk-ant-secret-123', 'anthropic-version': '2023-06-01', ...headers },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  })
}

interface SseEvent {
  event: string
  data: string
}

/** Split an SSE body into (event, data) pairs. */
function sseEvents(text: string): SseEvent[] {
  return text.split('\n\n').filter((b) => b.trim() !== '').map((block) => {
    const lines = block.split('\n')
    return {
      event: lines.find((l) => l.startsWith('event: '))?.slice('event: '.length) ?? '',
      data: lines.find((l) => l.startsWith('data: '))?.slice('data: '.length) ?? '',
    }
  })
}

type Parsed = Record<string, unknown> & {
  index?: number
  content_block?: { type: string; id?: string; name?: string }
  delta?: Record<string, unknown>
  usage?: Record<string, unknown>
  message?: { usage?: Record<string, unknown> }
}

async function streamed(body: unknown): Promise<Parsed[]> {
  const res = await post(body)
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toBe('text/event-stream')
  const events = sseEvents(await res.text())
  return events.map((e) => {
    const parsed = JSON.parse(e.data) as Parsed
    expect(parsed['type']).toBe(e.event)
    return parsed
  })
}

describe('scriptedModelServer', () => {
  it('streams text as Messages API SSE and records the request without the key', async () => {
    server = await scriptedModelServer({ script: [{ content: ['Hel', 'lo'] }] })
    expect(server.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    const events = await streamed({ model: 'm', max_tokens: 10, stream: true, messages: [{ role: 'user', content: 'hi' }] })
    expect(events.map((e) => e['type'])).toEqual([
      'message_start', 'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop',
    ])
    expect(events[1]!.content_block).toEqual({ type: 'text', text: '' })
    expect(events.filter((e) => e['type'] === 'content_block_delta').map((e) => e.delta!['text']).join('')).toBe('Hello')
    expect(events[5]!.delta).toEqual({ stop_reason: 'end_turn', stop_sequence: null })
    expect(events[0]!.message!.usage).toEqual({})
    expect(events[5]!.usage).toEqual({})

    const [record] = server.requests
    expect(record!.path).toBe('/v1/messages')
    expect(record!.body?.messages?.[0]).toEqual({ role: 'user', content: 'hi' })
    expect(record!.headers['x-api-key']).toBe('[redacted]')
    expect(record!.headers['anthropic-version']).toBe('2023-06-01')
    expect(JSON.stringify(record)).not.toContain('sk-ant-secret-123')
    expect(record!.hasApiKey).toBe(true)
    expect(record!.outcome).toBe('completed')
  })

  it('streams thinking, then parallel tool calls with interleaved input_json_delta, plus usage', async () => {
    server = await scriptedModelServer({
      script: [{
        reasoning: 'think',
        toolCalls: [
          { name: 'read_file', arguments: { path: 'a.txt' }, argumentChunks: 3 },
          { name: 'read_file', arguments: { path: 'b.txt' }, argumentChunks: 2 },
        ],
        interleaveToolCalls: true,
        usage: { inputTokens: 100, cacheReadTokens: 20, outputTokens: 7, totalTokens: 127 },
      }],
    })
    const events = await streamed({ model: 'm', stream: true, messages: [] })
    expect(events[0]!.message!.usage).toEqual({ input_tokens: 100, cache_read_input_tokens: 20 })
    const thinking = events.filter((e) => e.index === 0)
    expect(thinking[0]!.content_block).toEqual({ type: 'thinking', thinking: '', signature: '' })
    expect(thinking.map((e) => e.delta?.['type'])).toEqual([undefined, 'thinking_delta', 'signature_delta', undefined])
    // Reassemble the way a client does: by content block index.
    const calls = new Map<number, { id: string | undefined; name: string | undefined; args: string }>()
    const order: number[] = []
    for (const e of events) {
      if (e['type'] === 'content_block_start' && e.content_block?.type === 'tool_use') {
        calls.set(e.index!, { id: e.content_block.id, name: e.content_block.name, args: '' })
      }
      if (e['type'] === 'content_block_delta' && e.delta?.['type'] === 'input_json_delta') {
        calls.get(e.index!)!.args += e.delta['partial_json'] as string
        order.push(e.index!)
      }
    }
    expect([...calls.values()]).toEqual([
      { id: 'call_1_0', name: 'read_file', args: '{"path":"a.txt"}' },
      { id: 'call_1_1', name: 'read_file', args: '{"path":"b.txt"}' },
    ])
    expect(order).toEqual([1, 2, 1, 2, 1])
    const delta = events.find((e) => e['type'] === 'message_delta')!
    expect(delta.delta).toEqual({ stop_reason: 'tool_use', stop_sequence: null })
    expect(delta.usage).toEqual({ output_tokens: 7 })
    expect(events.at(-1)!['type']).toBe('message_stop')
  })

  it('streams a scripted refusal with stop_details', async () => {
    server = await scriptedModelServer({
      script: [{ content: 'no', finishReason: 'refusal', stopDetails: { category: 'cyber', explanation: 'nope' } }],
    })
    const events = await streamed({ stream: true })
    expect(events.find((e) => e['type'] === 'message_delta')!.delta).toEqual({
      stop_reason: 'refusal', stop_sequence: null, stop_details: { type: 'refusal', category: 'cyber', explanation: 'nope' },
    })
  })

  it('answers non-streaming requests with a message body', async () => {
    server = await scriptedModelServer({ script: [{ content: 'ok', toolCalls: [{ id: 'c1', name: 't', arguments: '{}' }], usage: { inputTokens: 3, outputTokens: 4 } }] })
    const json = await (await post({ model: 'm', messages: [] })).json() as {
      type: string; role: string; content: unknown[]; stop_reason: string; usage: Record<string, unknown>
    }
    expect(json.type).toBe('message')
    expect(json.role).toBe('assistant')
    expect(json.content).toEqual([{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 'c1', name: 't', input: {} }])
    expect(json.stop_reason).toBe('tool_use')
    expect(json.usage).toEqual({ input_tokens: 3, output_tokens: 4 })
  })

  it('returns arbitrary HTTP error statuses with headers and an Anthropic error body', async () => {
    server = await scriptedModelServer({
      script: [{ fault: 'http-500' }, { fault: { kind: 'http-error', status: 429, headers: { 'request-id': 'r-9' } } }],
    })
    const r1 = await post({ stream: true })
    expect(r1.status).toBe(500)
    expect(await r1.json()).toEqual({ type: 'error', error: { type: 'scripted_error', message: 'scripted HTTP 500' } })
    const r2 = await post({ stream: true })
    expect(r2.status).toBe(429)
    expect(r2.headers.get('request-id')).toBe('r-9')
    expect(server.requests.map((r) => r.outcome)).toEqual(['http-error', 'http-error'])
  })

  it('timeout fault never responds; the client times out', async () => {
    server = await scriptedModelServer({ script: [{ fault: 'timeout' }] })
    await expect(post({ stream: true }, {}, AbortSignal.timeout(100))).rejects.toThrow()
    await server.waitForRequests(1)
    expect(server.requests[0]!.outcome).toMatch(/stalled|client-closed/)
  })

  it('timeout fault after chunks stalls an open stream', async () => {
    server = await scriptedModelServer({ script: [{ content: ['a', 'b'], fault: { kind: 'timeout', afterChunks: 3 } }] })
    const controller = new AbortController()
    const res = await post({ stream: true }, {}, controller.signal)
    const reader = res.body!.getReader()
    let first = ''
    while (!first.includes('"text":"a"')) first += new TextDecoder().decode((await reader.read()).value)
    const next = reader.read()
    const raced = await Promise.race([next.then(() => 'data'), new Promise((r) => setTimeout(() => r('idle'), 80))])
    expect(raced).toBe('idle')
    controller.abort()
    await next.catch(() => {})
  })

  it('disconnect fault destroys the socket mid-stream', async () => {
    server = await scriptedModelServer({ script: [{ content: ['a', 'b', 'c'], fault: { kind: 'disconnect', afterChunks: 2 } }] })
    const res = await post({ stream: true })
    await expect(res.text()).rejects.toThrow()
    expect(server.requests[0]!.chunksSent).toBe(2)
    expect(server.requests[0]!.outcome).toBe('disconnected')
  })

  it('disconnect with afterChunks 0 resets before any response', async () => {
    server = await scriptedModelServer({ script: [{ fault: { kind: 'disconnect', afterChunks: 0 } }] })
    await expect(post({ stream: true })).rejects.toThrow()
  })

  it('malformed-json fault sends an unparseable event', async () => {
    server = await scriptedModelServer({ script: [{ content: 'a', fault: { kind: 'malformed-json', afterChunks: 2 } }] })
    const events = sseEvents(await (await post({ stream: true })).text())
    expect(events).toHaveLength(3)
    expect(events.map((e) => e.event)).toEqual(['message_start', 'content_block_start', 'content_block_delta'])
    expect(() => JSON.parse(events[1]!.data)).not.toThrow()
    expect(() => JSON.parse(events[2]!.data)).toThrow()
  })

  it('404s other paths without consuming the script; 500s when exhausted', async () => {
    server = await scriptedModelServer({ script: [] })
    const other = await fetch(`${server.baseUrl}/v1/models`)
    expect(other.status).toBe(404)
    expect(server.requests).toHaveLength(0)
    const res = await post({ stream: true })
    expect(res.status).toBe(500)
    expect(((await res.json()) as { error: { type: string } }).error.type).toBe('script_exhausted')
    expect(server.requests[0]!.outcome).toBe('exhausted')
  })

  it('accepts a query string on the path and passes the parsed body to function entries', async () => {
    server = await scriptedModelServer({ script: [(body) => ({ content: `model=${body.model}` })] })
    const res = await fetch(`${server.baseUrl}/v1/messages?beta=true`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-sonnet-5-5', stream: true }),
    })
    const events = sseEvents(await res.text())
    expect(events[2]!.data).toContain('model=claude-sonnet-5-5')
    expect(server.requests[0]!.path).toBe('/v1/messages')
    expect(server.requests[0]!.rawBody).toContain('"claude-sonnet-5-5"')
    expect(server.requests[0]!.hasApiKey).toBe(false)
    server.assertConsumed()
  })

  it('closedPortUrl refuses connections (network down)', async () => {
    const url = await closedPortUrl('')
    await expect(fetch(`${url}/v1/messages`, { method: 'POST', body: '{}' })).rejects.toThrow()
  })
})
