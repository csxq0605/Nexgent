/**
 * ADR 0021: a long turn does not break part way. The step limit stops the
 * turn without an error and the next message continues; a reply cut by the
 * output cap is continued; a prompt that no longer fits the context window
 * is compacted and sent again; provider retries reach subscribers.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  OUTPUT_CUT_NOTE,
  OUTPUT_CUT_TOOL_RESULT,
  OUTPUT_CUT_TOOLS_NOTE,
  parseProjectConfig,
  renderCompactionSummary,
  stepLimitNote,
  type AgentEvent,
  type CompactionCheckInput,
  type CompactionResult,
  type Compactor,
  type ContextService,
  type LLMStreamEvent,
  type Tool,
} from '../src/index.js'
import { conversation, servicePlugin, textReply, toolCallReply, usage } from './helpers/fakes.js'
import { bootHarness, type Harness } from './helpers/harness.js'

const echo: Tool = {
  definition: {
    name: 'echo',
    description: 'Echo the text back.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
    effects: ['read'],
    approval: 'never',
  },
  handler: async input => ({ content: `echo: ${(input as { text: string }).text}` }),
}

let harness: Harness | undefined
afterEach(async () => {
  await harness?.dispose()
  harness = undefined
})

/** A reply cut by the output cap after `text`, optionally inside a tool call. */
function cutReply(text: string, call?: { id: string; complete: boolean }): LLMStreamEvent[] {
  const events: LLMStreamEvent[] = [{ type: 'text.delta', text }]
  const content: unknown[] = [{ type: 'text', text }]
  if (call !== undefined) {
    events.push({ type: 'tool-call.start', index: 0, id: call.id, name: 'echo' })
    if (call.complete) events.push({ type: 'tool-call.end', index: 0, call: { id: call.id, name: 'echo', arguments: '{"text":"x"}' } })
    content.push({ type: 'tool_use', id: call.id, name: 'echo', input: { text: 'par' } })
  }
  events.push({ type: 'usage', usage: usage(10, 5) }, { type: 'done', finishReason: 'max-tokens', providerContent: content as never })
  return events
}

describe('step limit', () => {
  it('ends the turn as cancelled/step-limit (not an error) after a wrap-up note, and the next message continues', async () => {
    harness = await bootHarness({
      patches: [{ id: 'agents', config: { maxSteps: 4 } }],
      script: [
        toolCallReply('c1', 'echo', { text: '1' }),
        toolCallReply('c2', 'echo', { text: '2' }),
        toolCallReply('c3', 'echo', { text: '3' }),
        toolCallReply('c4', 'echo', { text: '4' }),
        textReply('all done'),
      ],
    })
    const { app, llm, store, ledger } = harness
    app.ctx.tools.register(echo)
    const agent = await app.agents.create()
    const result = await agent.run('do four things')
    expect(result.reason).toEqual({ kind: 'cancelled', cause: 'step-limit' })
    expect(llm.requests).toHaveLength(4)
    expect(store.of(agent.sessionId, 'tool.result')).toHaveLength(4)
    expect(store.of(agent.sessionId, 'error')).toEqual([])
    // the last allowed call carries the wrap-up note; earlier ones do not
    expect(conversation(llm.requests[3]!).at(-1)).toEqual({ role: 'user', content: stepLimitNote(4) })
    expect(conversation(llm.requests[2]!).some(message => message.content === stepLimitNote(4))).toBe(false)
    expect(store.of(agent.sessionId, 'user.message').filter(record => record.source === 'inject').map(record => record.content)).toEqual([stepLimitNote(4)])

    const next = await agent.run('continue')
    expect(next.reason).toEqual({ kind: 'completed' })
    expect(next.text).toBe('all done')
    expect(conversation(llm.requests[4]!).slice(-2)).toEqual([
      { role: 'tool', toolCallId: 'c4', name: 'echo', content: 'echo: 4', isError: false },
      { role: 'user', content: 'continue' },
    ])
    await agent.close()
    // the task ends with the continued turn, so it completed
    expect(ledger.of('task.outcome')[0]).toMatchObject({ status: 'completed' })
  })

  it('takes maxStepsPerTurn from the project config over the agents row', async () => {
    harness = await bootHarness({
      script: [toolCallReply('c1', 'echo', { text: '1' }), toolCallReply('c2', 'echo', { text: '2' }), textReply('late')],
    })
    const { app, llm } = harness
    app.ctx.tools.register(echo)
    const agent = await app.agents.create({ projectConfig: parseProjectConfig({ maxStepsPerTurn: 2 }) })
    const result = await agent.run('go')
    expect(result.reason).toEqual({ kind: 'cancelled', cause: 'step-limit' })
    expect(llm.requests).toHaveLength(2)
    await agent.close()
  })

  it('rejects a maxStepsPerTurn that is not a positive integer', () => {
    expect(() => parseProjectConfig({ maxStepsPerTurn: 0 })).toThrow(expect.objectContaining({ code: 'config/invalid' }))
    expect(() => parseProjectConfig({ maxStepsPerTurn: 2.5 })).toThrow(expect.objectContaining({ code: 'config/invalid' }))
    expect(parseProjectConfig({ maxStepsPerTurn: 50 }).config.maxStepsPerTurn).toBe(50)
    expect(parseProjectConfig({}).config).not.toHaveProperty('maxStepsPerTurn')
  })
})

describe('output cap', () => {
  it('continues a text reply cut by the output cap', async () => {
    harness = await bootHarness({ script: [cutReply('The first half'), textReply(' and the second half.')] })
    const { app, llm, store } = harness
    const agent = await app.agents.create()
    const result = await agent.run('write a long answer')
    expect(result.reason).toEqual({ kind: 'completed' })
    expect(llm.requests).toHaveLength(2)
    expect(conversation(llm.requests[1]!).slice(-2)).toEqual([
      expect.objectContaining({ role: 'assistant', content: 'The first half' }),
      { role: 'user', content: OUTPUT_CUT_NOTE },
    ])
    expect(store.of(agent.sessionId, 'assistant.message').map(record => record.finishReason)).toEqual(['max-tokens', 'stop'])
    await agent.close()
  })

  it('answers the cut tool calls (completed or not) with an error instead of running them, then continues', async () => {
    harness = await bootHarness({ script: [cutReply('Writing', { id: 'c1', complete: false }), textReply('split into parts')] })
    const { app, llm, store, ledger } = harness
    let ran = false
    app.ctx.tools.register({ ...echo, handler: async () => { ran = true; return { content: 'ran' } } })
    const agent = await app.agents.create()
    const result = await agent.run('write a big file')
    expect(result.reason).toEqual({ kind: 'completed' })
    expect(ran).toBe(false)
    expect(store.of(agent.sessionId, 'assistant.message')[0]!.toolCalls).toEqual([{ id: 'c1', name: 'echo', arguments: '{"text":"par"}' }])
    expect(store.of(agent.sessionId, 'tool.result')[0]).toMatchObject({ toolCallId: 'c1', isError: true, content: OUTPUT_CUT_TOOL_RESULT })
    expect(conversation(llm.requests[1]!).slice(-2)).toEqual([
      { role: 'tool', toolCallId: 'c1', name: 'echo', content: OUTPUT_CUT_TOOL_RESULT, isError: true },
      { role: 'user', content: OUTPUT_CUT_TOOLS_NOTE },
    ])
    expect(ledger.of('tool.call')).toEqual([])
    await agent.close()
  })

  it('ends the turn with max-tokens after maxOutputContinuations consecutive cuts', async () => {
    harness = await bootHarness({
      patches: [{ id: 'agents', config: { maxOutputContinuations: 2 } }],
      script: [cutReply('a'), cutReply('b'), cutReply('c'), textReply('never')],
    })
    const { app, llm } = harness
    const agent = await app.agents.create()
    const result = await agent.run('go')
    expect(result.reason).toEqual({ kind: 'max-tokens' })
    expect(llm.requests).toHaveLength(3)
    await agent.close()
  })
})

describe('context overflow', () => {
  function overflowError(): LLMStreamEvent[] {
    return [{ type: 'error', error: { name: 'NexgentError', code: 'llm/request-failed', message: 'HTTP 400: prompt is too long', details: { contextOverflow: true } }, httpStatus: 400 }]
  }

  function forcedCompactor(): Compactor & { checks: number; compacts: CompactionCheckInput[] } {
    const self = {
      checks: 0,
      compacts: [] as CompactionCheckInput[],
      shouldCompact(): boolean {
        self.checks += 1
        return false
      },
      async compact(input: CompactionCheckInput): Promise<CompactionResult> {
        self.compacts.push(input)
        // split inside the turn: keep the last reply and its result
        const last = input.messages.map(message => message.role).lastIndexOf('assistant')
        return {
          summary: 'earlier steps',
          keepMessages: input.messages.length - last,
          compactedMessages: last,
          requestId: 'aux-1',
          usage: usage(50, 10),
          trigger: { inputTokens: 0, threshold: 1 },
        }
      },
    }
    return self
  }

  it('compacts once (even mid-turn) and sends the request again; kept replies lose their provider content', async () => {
    harness = await bootHarness({
      script: [
        [...toolCallReply('c1', 'echo', { text: '1' }).slice(0, -1), { type: 'done', finishReason: 'tool-calls', providerContent: [{ type: 'thinking', thinking: 't', signature: 's' }] as never }],
        [...toolCallReply('c2', 'echo', { text: '2' }).slice(0, -1), { type: 'done', finishReason: 'tool-calls', providerContent: [{ type: 'thinking', thinking: 't2', signature: 's2' }] as never }],
        overflowError(),
        textReply('finished'),
      ],
    })
    const { app, llm, store } = harness
    app.ctx.tools.register(echo)
    const fake = forcedCompactor()
    await app.ctx.plugin(servicePlugin('context', { providers: [], register: () => () => undefined, compactor: fake } satisfies ContextService))
    const agent = await app.agents.create()
    const result = await agent.run('long work')
    expect(result.reason).toEqual({ kind: 'completed' })
    expect(fake.compacts).toHaveLength(1)
    const record = store.of(agent.sessionId, 'compaction')[0]!
    expect(record).toMatchObject({ turn: 1, step: 3, keepMessages: 2 })
    const sent = conversation(llm.requests[3]!)
    expect(sent).toEqual([
      { role: 'user', content: renderCompactionSummary('earlier steps') },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c2', name: 'echo', arguments: '{"text":"2"}' }] },
      { role: 'tool', toolCallId: 'c2', name: 'echo', content: 'echo: 2', isError: false },
    ])
    expect(store.of(agent.sessionId, 'error')).toEqual([expect.objectContaining({ fatal: false })])
    const before = agent.history()
    await agent.close()
    const resumed = await app.agents.resume(agent.sessionId)
    expect(resumed.history()).toEqual(before)
    await resumed.close()
  })

  it('a second overflow in the same turn ends it with the error', async () => {
    harness = await bootHarness({
      script: [toolCallReply('c1', 'echo', { text: '1' }), overflowError(), overflowError()],
    })
    const { app } = harness
    app.ctx.tools.register(echo)
    await app.ctx.plugin(servicePlugin('context', { providers: [], register: () => () => undefined, compactor: forcedCompactor() } satisfies ContextService))
    const agent = await app.agents.create()
    const result = await agent.run('go')
    expect(result.reason).toMatchObject({ kind: 'error', error: { code: 'llm/request-failed' } })
    await agent.close()
  })
})

describe('compaction trigger after reopening', () => {
  it('starts from the usage of the latest reply recorded in the session, not a whole-history estimate', async () => {
    harness = await bootHarness({ script: [textReply('first', usage(321, 7)), textReply('second')] })
    const { app } = harness
    const checks: CompactionCheckInput[] = []
    const compactor: Compactor = {
      shouldCompact(input) {
        checks.push(input)
        return false
      },
      async compact() {
        throw new Error('not expected')
      },
    }
    await app.ctx.plugin(servicePlugin('context', { providers: [], register: () => () => undefined, compactor } satisfies ContextService))
    const agent = await app.agents.create()
    await agent.run('one')
    expect(checks[0]!.lastUsage).toBeUndefined()
    await agent.close()
    const resumed = await app.agents.resume(agent.sessionId)
    await resumed.run('two')
    expect(checks.at(-1)!.lastUsage).toEqual(usage(321, 7))
    await resumed.close()
  })
})

describe('provider retries', () => {
  it('forwards a retry event to subscribers and keeps only the final attempt', async () => {
    harness = await bootHarness({
      script: [[
        { type: 'reasoning.delta', text: 'hm' },
        { type: 'retry', attempt: 2, delayMs: 10, error: { name: 'NexgentError', code: 'llm/request-failed', message: 'HTTP 529: Overloaded' } },
        ...textReply('ok'),
      ]],
    })
    const { app, store } = harness
    const agent = await app.agents.create()
    const events: AgentEvent[] = []
    agent.subscribe(event => events.push(event))
    const result = await agent.run('hi')
    expect(result.reason).toEqual({ kind: 'completed' })
    expect(events.find(event => event.type === 'request.retry')).toMatchObject({ turn: 1, step: 1, attempt: 2, delayMs: 10 })
    expect(store.of(agent.sessionId, 'assistant.message')).toHaveLength(1)
    await agent.close()
  })
})
