import { rmSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentEvent, Tool, ToolContext } from '../src/index.js'
import { conversation, sleep, textReply, toolCallReply, usage, type ScriptStep } from './helpers/fakes.js'
import { bootHarness, type Harness } from './helpers/harness.js'

const echo: Tool = {
  definition: {
    name: 'echo',
    description: 'Echo the text back.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
    effects: ['read'],
    approval: 'never',
  },
  handler: async input => ({ content: `echo: ${(input as { text: string }).text}`, meta: { length: 1 } }),
}

let harness: Harness | undefined
afterEach(async () => {
  await harness?.dispose()
  harness = undefined
})

describe('agent loop', () => {
  it('runs message -> tool call -> tool result -> final reply and writes every record', async () => {
    harness = await bootHarness({
      script: [toolCallReply('call_1', 'echo', { text: 'hi' }, 'Let me check.'), textReply('Done: hi')],
    })
    const { app, llm, store, ledger } = harness
    app.ctx.tools.register(echo)
    const agent = await app.agents.create({ title: 'demo' })
    const events: AgentEvent[] = []
    agent.subscribe(event => events.push(event))

    const result = await agent.run('please echo hi')
    expect(result.reason).toEqual({ kind: 'completed' })
    expect(result.text).toBe('Done: hi')

    expect(store.types(agent.sessionId)).toEqual([
      'session.start',
      'turn.start',
      'user.message',
      'assistant.message',
      'tool.result',
      'assistant.message',
      'turn.end',
    ])
    const [first, second] = store.of(agent.sessionId, 'assistant.message')
    expect(first).toMatchObject({ turn: 1, step: 1, content: 'Let me check.', finishReason: 'tool-calls', usage: usage(10, 5) })
    expect(first!.toolCalls).toEqual([{ id: 'call_1', name: 'echo', arguments: '{"text":"hi"}' }])
    expect(first!.requestId).toBe(llm.requests[0]!.requestId)
    expect(second).toMatchObject({ step: 2, content: 'Done: hi', finishReason: 'stop' })
    expect(store.of(agent.sessionId, 'tool.result')[0]).toMatchObject({
      toolCallId: 'call_1', name: 'echo', content: 'echo: hi', isError: false, meta: { length: 1 }, step: 1,
    })

    // request shape: system prompt first, tools, thinking off, model from the profile
    const request = llm.requests[1]!
    expect(request.messages[0]!.role).toBe('system')
    expect(request.messages[0]!.content).toContain('mimo-v2.6-pro')
    expect(request.messages[0]!.content).toContain(harness.workspace.root)
    expect(request.messages[0]!.content).toContain('- echo: Echo the text back.')
    expect(request.thinking).toBe('off')
    expect(request.model).toBe('mimo-v2.6-pro')
    expect(request.tools?.map(tool => tool.name)).toEqual(['echo'])
    expect(conversation(request)).toEqual([
      { role: 'user', content: 'please echo hi' },
      { role: 'assistant', content: 'Let me check.', toolCalls: [{ id: 'call_1', name: 'echo', arguments: '{"text":"hi"}' }] },
      { role: 'tool', toolCallId: 'call_1', name: 'echo', content: 'echo: hi', isError: false },
    ])
    expect(llm.options[0]).toMatchObject({ sessionId: agent.sessionId, purpose: 'task', timeoutMs: 180000, streamIdleTimeoutMs: 180000 })

    expect(ledger.of('tool.call')).toEqual([expect.objectContaining({
      sessionId: agent.sessionId, turn: 1, callId: 'call_1', name: 'echo', effects: ['read'],
      approval: { required: false, decision: 'auto' }, isError: false,
    })])

    // streamed events reached the subscriber
    expect(events.filter(event => event.type === 'text.delta').map(event => (event as { text: string }).text)).toEqual(['Let me check.', 'Done: hi'])
    expect(events.map(event => event.type)).toContain('tool.result')
    expect(events.filter(event => event.type === 'turn.end')).toHaveLength(1)

    await agent.close()
    expect(ledger.of('task.outcome')).toEqual([expect.objectContaining({
      sessionId: agent.sessionId, status: 'completed', requestCount: 2, toolCallCount: 1, turns: 1, toolsUsed: ['echo'],
      totalUsage: usage(20, 10),
    })])
    expect(store.locks.has(agent.sessionId)).toBe(false)
  })

  it('exposes an async iterator of events that ends on close', async () => {
    harness = await bootHarness({ script: [textReply('hello')] })
    const agent = await harness.app.agents.create()
    const seen: string[] = []
    const reader = (async () => {
      for await (const event of agent.events()) seen.push(event.type)
    })()
    await agent.run('hi')
    await agent.close()
    await reader
    expect(seen).toContain('text.delta')
    expect(seen.at(-1)).toBe('closed')
  })

  it('keeps streamed text when the turn is cancelled mid-stream', async () => {
    const slow: ScriptStep = async function* (request) {
      yield { type: 'text.delta', text: 'Nexgent is' }
      await sleep(10_000, request.signal)
      yield { type: 'done', finishReason: 'aborted' }
    }
    harness = await bootHarness({ script: [slow] })
    const { app, store, ledger } = harness
    const agent = await app.agents.create()
    agent.subscribe(event => {
      if (event.type === 'text.delta') agent.cancel()
    })
    const result = await agent.run('write an intro')
    expect(result.reason).toEqual({ kind: 'cancelled', cause: 'user' })
    expect(result.text).toBe('Nexgent is')
    const [message] = store.of(agent.sessionId, 'assistant.message')
    expect(message).toMatchObject({ content: 'Nexgent is', finishReason: 'aborted', interrupted: true })
    expect(message!.toolCalls).toBeUndefined()
    expect(store.of(agent.sessionId, 'turn.end')[0]!.reason).toEqual({ kind: 'cancelled', cause: 'user' })
    expect(agent.history().at(-1)).toEqual({ role: 'assistant', content: 'Nexgent is' })
    await agent.close()
    expect(ledger.of('task.outcome')[0]).toMatchObject({ status: 'cancelled' })
  })

  it('cancels through an external AbortSignal, even when the provider ignores it', async () => {
    const hung: ScriptStep = async function* () {
      yield { type: 'text.delta', text: 'partial' }
      await new Promise(() => {})
    }
    harness = await bootHarness({ script: [hung] })
    const agent = await harness.app.agents.create()
    const controller = new AbortController()
    agent.subscribe(event => {
      if (event.type === 'text.delta') controller.abort()
    })
    const result = await agent.run('go', { signal: controller.signal })
    expect(result.reason).toEqual({ kind: 'cancelled', cause: 'user' })
    expect(harness.store.of(agent.sessionId, 'assistant.message')[0]).toMatchObject({ content: 'partial', interrupted: true })
  })

  it('aborts a running tool on cancel and records tool/aborted', async () => {
    let toolSignal: AbortSignal | undefined
    const slowTool: Tool = {
      definition: { ...echo.definition, name: 'slow', inputSchema: { type: 'object' } },
      handler: async (_input, context: ToolContext) => {
        toolSignal = context.signal
        await sleep(10_000, context.signal)
        return { content: 'finished' }
      },
    }
    harness = await bootHarness({ script: [toolCallReply('c1', 'slow', {})] })
    const { app, store } = harness
    app.ctx.tools.register(slowTool)
    const agent = await app.agents.create()
    agent.subscribe(event => {
      if (event.type === 'tool.start') setTimeout(() => agent.cancel(), 20)
    })
    const result = await agent.run('go')
    expect(toolSignal?.aborted).toBe(true)
    expect(result.reason).toEqual({ kind: 'cancelled', cause: 'user' })
    expect(store.of(agent.sessionId, 'tool.result')[0]).toMatchObject({ isError: true, error: { code: 'tool/aborted' } })
    expect(store.types(agent.sessionId).slice(-2)).toEqual(['tool.result', 'turn.end'])
  })

  it('fails the turn with llm/timeout when the model stops streaming', async () => {
    const stall: ScriptStep = async function* (request) {
      yield { type: 'text.delta', text: 'thinking' }
      await sleep(10_000, request.signal)
      yield { type: 'done', finishReason: 'aborted' }
    }
    harness = await bootHarness({
      script: [stall],
      patches: [{ id: 'agents', config: { streamIdleTimeoutMs: 50 } }],
    })
    const agent = await harness.app.agents.create()
    const result = await agent.run('go')
    expect(result.reason).toMatchObject({ kind: 'error', error: { code: 'llm/timeout' } })
    expect(harness.llm.requests[0]!.signal?.aborted).toBe(true)
    expect(harness.store.of(agent.sessionId, 'assistant.message')[0]).toMatchObject({ content: 'thinking', finishReason: 'error' })
    await agent.close()
    expect(harness.ledger.of('task.outcome')[0]).toMatchObject({ status: 'failed', error: { code: 'llm/timeout' } })
  })

  it('fails the turn with llm/timeout on the whole-request deadline', async () => {
    const stall: ScriptStep = async function* (request) {
      await sleep(10_000, request.signal)
      yield { type: 'done', finishReason: 'aborted' }
    }
    harness = await bootHarness({ script: [stall], patches: [{ id: 'agents', config: { modelTimeoutMs: 50 } }] })
    const agent = await harness.app.agents.create()
    const result = await agent.run('go')
    expect(result.reason).toMatchObject({ kind: 'error', error: { code: 'llm/timeout', details: { idle: false } } })
    // nothing streamed: no assistant.message, turn closed
    expect(harness.store.types(agent.sessionId)).toEqual(['session.start', 'turn.start', 'user.message', 'turn.end'])
  })

  it('passes a provider error event through as a turn error', async () => {
    harness = await bootHarness({
      script: [[{ type: 'error', error: { name: 'NexgentError', code: 'llm/request-failed', message: 'HTTP 503' }, httpStatus: 503 }]],
    })
    const agent = await harness.app.agents.create()
    const result = await agent.run('go')
    expect(result.reason).toEqual({ kind: 'error', error: { name: 'NexgentError', code: 'llm/request-failed', message: 'HTTP 503' } })
  })

  it('turns a throwing tool into an isError tool.result and continues', async () => {
    harness = await bootHarness({ script: [toolCallReply('c1', 'boom', {}), textReply('sorry')] })
    const { app, store, ledger } = harness
    app.ctx.tools.register({
      definition: { ...echo.definition, name: 'boom', inputSchema: { type: 'object' } },
      handler: async () => {
        throw new Error('disk on fire')
      },
    })
    const agent = await app.agents.create()
    const result = await agent.run('go')
    expect(result.reason).toEqual({ kind: 'completed' })
    expect(store.of(agent.sessionId, 'tool.result')[0]).toMatchObject({
      isError: true, content: 'Error: disk on fire', error: { code: 'tool/failed', message: 'disk on fire' },
    })
    expect(ledger.of('tool.call')[0]).toMatchObject({ isError: true })
    expect(conversation(harness.llm.requests[1]!).at(-1)).toMatchObject({ role: 'tool', isError: true })
  })

  it('enforces a tool timeout', async () => {
    harness = await bootHarness({ script: [toolCallReply('c1', 'slow', {}), textReply('ok')] })
    harness.app.ctx.tools.register({
      definition: { ...echo.definition, name: 'slow', inputSchema: { type: 'object' }, timeoutMs: 30 },
      handler: async (_input, context) => {
        await sleep(10_000, context.signal)
        return { content: 'late' }
      },
    })
    const agent = await harness.app.agents.create()
    await agent.run('go')
    expect(harness.store.of(agent.sessionId, 'tool.result')[0]).toMatchObject({ isError: true, error: { code: 'tool/timeout' } })
  })

  it('reports unknown tools and invalid arguments to the model', async () => {
    harness = await bootHarness({
      script: [toolCallReply('c1', 'nope', {}), toolCallReply('c2', 'echo', { text: 3 }), textReply('ok')],
    })
    harness.app.ctx.tools.register(echo)
    const agent = await harness.app.agents.create()
    await agent.run('go')
    const results = harness.store.of(agent.sessionId, 'tool.result')
    expect(results[0]).toMatchObject({ isError: true, error: { code: 'tool/not-found' } })
    expect(results[1]).toMatchObject({ isError: true, error: { code: 'tool/invalid-input' } })
  })

  it('records usage as unknown when the provider reports none', async () => {
    harness = await bootHarness({ script: [[{ type: 'text.delta', text: 'x' }, { type: 'done', finishReason: 'stop' }]] })
    const agent = await harness.app.agents.create()
    await agent.run('go')
    expect(harness.store.of(agent.sessionId, 'assistant.message')[0]!.usage.inputTokens).toBe('unknown')
  })

  it('writes a checkpoint at turn.end once enough records accumulated', async () => {
    harness = await bootHarness({
      script: [textReply('a'), textReply('b')],
      patches: [{ id: 'agents', config: { checkpointEvery: 6 } }],
    })
    const agent = await harness.app.agents.create()
    await agent.run('one')
    expect(harness.store.types(agent.sessionId)).not.toContain('checkpoint')
    await agent.run('two')
    const types = harness.store.types(agent.sessionId)
    expect(types.slice(-2)).toEqual(['turn.end', 'checkpoint'])
    const [checkpoint] = harness.store.of(agent.sessionId, 'checkpoint')
    expect(checkpoint!.coversSeq).toBe(checkpoint!.seq - 1)
    expect(checkpoint!.state.messages).toHaveLength(4)
  })

  it('closes agents with cause shutdown when the app is disposed mid-turn', async () => {
    const slow: ScriptStep = async function* (request) {
      yield { type: 'text.delta', text: 'working' }
      await sleep(10_000, request.signal)
      yield { type: 'done', finishReason: 'aborted' }
    }
    harness = await bootHarness({ script: [slow] })
    const { app, store } = harness
    const agent = await app.agents.create()
    const running = agent.run('go')
    await new Promise<void>(resolve => agent.subscribe(event => { if (event.type === 'text.delta') resolve() }))
    await app.dispose()
    const result = await running
    expect(result.reason).toEqual({ kind: 'cancelled', cause: 'shutdown' })
    expect(store.locks.size).toBe(0)
    rmSync(harness.root, { recursive: true, force: true })
    harness = undefined
  })
})
