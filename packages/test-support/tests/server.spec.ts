import { afterEach, describe, expect, it } from 'vitest'
import { closedPortUrl, scriptedModelServer, type ScriptedModelServer } from '../src/index.js'

let server: ScriptedModelServer | undefined
afterEach(async () => {
  await server?.close()
  server = undefined
})

async function post(body: unknown, headers: Record<string, string> = {}, signal?: AbortSignal): Promise<Response> {
  return fetch(`${server!.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer sk-secret-123', ...headers },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  })
}

/** Split an SSE body into `data:` payloads. */
function sseData(text: string): string[] {
  return text.split('\n\n').filter((b) => b.startsWith('data: ')).map((b) => b.slice('data: '.length))
}

interface Chunk {
  choices: Array<{ delta: Record<string, unknown> & { tool_calls?: Array<{ index: number; id?: string; function: { name?: string; arguments?: string } }> }; finish_reason: string | null }>
  usage?: Record<string, unknown>
}

describe('scriptedModelServer', () => {
  it('streams text as SSE with [DONE] and records the request without the key', async () => {
    server = await scriptedModelServer({ script: [{ content: ['Hel', 'lo'] }] })
    expect(server.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/)
    const res = await post({ model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }] })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    const data = sseData(await res.text())
    expect(data.at(-1)).toBe('[DONE]')
    const chunks = data.slice(0, -1).map((d) => JSON.parse(d) as Chunk)
    expect(chunks.map((c) => c.choices[0]?.delta.content ?? '').join('')).toBe('Hello')
    expect(chunks[0]!.choices[0]!.delta.role).toBe('assistant')
    expect(chunks.at(-1)!.choices[0]!.finish_reason).toBe('stop')
    expect(chunks.some((c) => c.usage !== undefined)).toBe(false)

    const [record] = server.requests
    expect(record!.body?.messages?.[0]).toEqual({ role: 'user', content: 'hi' })
    expect(record!.headers['authorization']).toBe('Bearer [redacted]')
    expect(JSON.stringify(record)).not.toContain('sk-secret-123')
    expect(record!.hasAuthorization).toBe(true)
    expect(record!.outcome).toBe('completed')
  })

  it('streams parallel tool calls with arguments split across chunks, plus usage', async () => {
    server = await scriptedModelServer({
      script: [{
        toolCalls: [
          { name: 'read_file', arguments: { path: 'a.txt' }, argumentChunks: 3 },
          { name: 'read_file', arguments: { path: 'b.txt' }, argumentChunks: 2 },
        ],
        interleaveToolCalls: true,
        usage: { inputTokens: 100, cacheReadTokens: 20, outputTokens: 7, totalTokens: 127 },
      }],
    })
    const data = sseData(await (await post({ model: 'm', stream: true, messages: [] })).text())
    const chunks = data.slice(0, -1).map((d) => JSON.parse(d) as Chunk)
    // Reassemble the way an OpenAI client does: by tool_calls[].index.
    const calls = new Map<number, { id?: string; name?: string; args: string }>()
    let argChunks = 0
    for (const chunk of chunks) {
      for (const tc of chunk.choices[0]?.delta.tool_calls ?? []) {
        const entry = calls.get(tc.index) ?? { args: '' }
        if (tc.id) entry.id = tc.id
        if (tc.function.name) entry.name = tc.function.name
        if (tc.function.arguments) {
          entry.args += tc.function.arguments
          argChunks++
        }
        calls.set(tc.index, entry)
      }
    }
    expect([...calls.values()]).toEqual([
      { id: 'call_1_0', name: 'read_file', args: '{"path":"a.txt"}' },
      { id: 'call_1_1', name: 'read_file', args: '{"path":"b.txt"}' },
    ])
    expect(argChunks).toBe(5)
    // Interleaved: argument chunks alternate between index 0 and 1.
    const order = chunks.flatMap((c) => (c.choices[0]?.delta.tool_calls ?? []).filter((t) => t.function.arguments).map((t) => t.index))
    expect(order.slice(0, 4)).toEqual([0, 1, 0, 1])
    const finish = chunks.find((c) => c.choices[0]?.finish_reason)
    expect(finish!.choices[0]!.finish_reason).toBe('tool_calls')
    const usage = chunks.at(-1)!
    expect(usage.choices).toEqual([])
    expect(usage.usage).toEqual({
      prompt_tokens: 120, completion_tokens: 7, total_tokens: 127, prompt_tokens_details: { cached_tokens: 20 },
    })
  })

  it('answers non-streaming requests with a chat.completion body', async () => {
    server = await scriptedModelServer({ script: [{ content: 'ok', toolCalls: [{ id: 'c1', name: 't', arguments: '{}' }] }] })
    const json = await (await post({ model: 'm', messages: [] })).json() as {
      choices: Array<{ message: { content: string; tool_calls: unknown[] }; finish_reason: string }>
    }
    expect(json.choices[0]!.message.content).toBe('ok')
    expect(json.choices[0]!.message.tool_calls).toEqual([{ id: 'c1', type: 'function', function: { name: 't', arguments: '{}' } }])
    expect(json.choices[0]!.finish_reason).toBe('tool_calls')
  })

  it('returns arbitrary HTTP error statuses with headers', async () => {
    server = await scriptedModelServer({
      script: [{ fault: 'http-500' }, { fault: { kind: 'http-error', status: 429, headers: { 'x-request-id': 'r-9' } } }],
    })
    const r1 = await post({ stream: true })
    expect(r1.status).toBe(500)
    expect(((await r1.json()) as { error: { message: string } }).error.message).toMatch(/500/)
    const r2 = await post({ stream: true })
    expect(r2.status).toBe(429)
    expect(r2.headers.get('x-request-id')).toBe('r-9')
    expect(server.requests.map((r) => r.outcome)).toEqual(['http-error', 'http-error'])
  })

  it('timeout fault never responds; the client times out', async () => {
    server = await scriptedModelServer({ script: [{ fault: 'timeout' }] })
    await expect(post({ stream: true }, {}, AbortSignal.timeout(100))).rejects.toThrow()
    await server.waitForRequests(1)
    expect(server.requests[0]!.outcome).toMatch(/stalled|client-closed/)
  })

  it('timeout fault after chunks stalls an open stream', async () => {
    server = await scriptedModelServer({ script: [{ content: ['a', 'b'], fault: { kind: 'timeout', afterChunks: 1 } }] })
    const controller = new AbortController()
    const res = await post({ stream: true }, {}, controller.signal)
    const reader = res.body!.getReader()
    const first = new TextDecoder().decode((await reader.read()).value)
    expect(first).toContain('"content":"a"')
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

  it('malformed-json fault sends an unparseable chunk', async () => {
    server = await scriptedModelServer({ script: [{ content: 'a', fault: { kind: 'malformed-json', afterChunks: 1 } }] })
    const data = sseData(await (await post({ stream: true })).text())
    expect(data).toHaveLength(2)
    expect(() => JSON.parse(data[0]!)).not.toThrow()
    expect(() => JSON.parse(data[1]!)).toThrow()
    expect(data).not.toContain('[DONE]')
  })

  it('404s other paths without consuming the script; 500s when exhausted', async () => {
    server = await scriptedModelServer({ script: [] })
    const other = await fetch(`${server.baseUrl}/models`)
    expect(other.status).toBe(404)
    expect(server.requests).toHaveLength(0)
    const res = await post({ stream: true })
    expect(res.status).toBe(500)
    expect(server.requests[0]!.outcome).toBe('exhausted')
  })

  it('passes the parsed body to function entries and records raw bodies', async () => {
    server = await scriptedModelServer({ script: [(body) => ({ content: `model=${body.model}` })] })
    const data = sseData(await (await post({ model: 'mimo', stream: true })).text())
    expect(data[0]).toContain('model=mimo')
    expect(server.requests[0]!.rawBody).toContain('"mimo"')
    server.assertConsumed()
  })

  it('closedPortUrl refuses connections (network down)', async () => {
    const url = await closedPortUrl()
    await expect(fetch(`${url}/chat/completions`, { method: 'POST', body: '{}' })).rejects.toThrow()
  })
})
