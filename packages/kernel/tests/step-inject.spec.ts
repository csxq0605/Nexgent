/**
 * The per-request injection hook (`Agent.beforeRequest`): texts handed to a
 * running agent before its next model request, recorded as
 * `user.message { source: 'inject' }` (`@nexgent/team` delivers mail this way).
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { StepInjectionInput, Tool } from '../src/index.js'
import { conversation, textReply, toolCallReply, type ScriptStep } from './helpers/fakes.js'
import { bootHarness, type Harness } from './helpers/harness.js'

const echo: Tool = {
  definition: { name: 'echo', description: 'Echo.', inputSchema: { type: 'object', properties: {} }, effects: ['read'], approval: 'never' },
  handler: async () => ({ content: 'echoed' }),
}

let harness: Harness | undefined
afterEach(async () => {
  await harness?.dispose()
  harness = undefined
})

describe('beforeRequest injectors', () => {
  it('writes injected texts before the next request of the running turn', async () => {
    harness = await bootHarness({ script: [toolCallReply('c1', 'echo', {}), textReply('done')] })
    const { app, llm, store } = harness
    app.ctx.tools.register(echo)
    const agent = await app.agents.create()
    const calls: Omit<StepInjectionInput, 'signal'>[] = []
    agent.beforeRequest(({ signal: _signal, ...input }) => {
      calls.push(input)
      return input.step === 2 ? ['mail from mate'] : []
    })
    const result = await agent.run('work')
    expect(result.reason).toEqual({ kind: 'completed' })
    expect(calls).toEqual([{ sessionId: agent.sessionId, turn: 1, step: 1 }, { sessionId: agent.sessionId, turn: 1, step: 2 }])
    expect(store.types(agent.sessionId).filter(type => type !== 'session.start' && type !== 'checkpoint')).toEqual([
      'turn.start', 'user.message', 'assistant.message', 'tool.result', 'user.message', 'assistant.message', 'turn.end',
    ])
    expect(store.of(agent.sessionId, 'user.message').at(-1)).toMatchObject({ turn: 1, content: 'mail from mate', source: 'inject' })
    expect(conversation(llm.requests[1]!).at(-1)).toEqual({ role: 'user', content: 'mail from mate' })
    // The history carries it on: a resume sees the same conversation.
    expect(agent.history().map(message => message.role)).toEqual(['user', 'assistant', 'tool', 'user', 'assistant'])
    await agent.close()
  })

  it('skips a failing injector with a non-fatal error and stops calling a removed one', async () => {
    harness = await bootHarness({ script: [textReply('one'), textReply('two')] })
    const { app, store } = harness
    const agent = await app.agents.create()
    let calls = 0
    const remove = agent.beforeRequest(() => {
      calls += 1
      throw new Error('mailbox down')
    })
    expect((await agent.run('first')).reason).toEqual({ kind: 'completed' })
    expect(store.of(agent.sessionId, 'error')).toMatchObject([{ fatal: false, error: { message: 'step injector failed: mailbox down' } }])
    remove()
    expect((await agent.run('second')).reason).toEqual({ kind: 'completed' })
    expect(calls).toBe(1)
    await agent.close()
  })

  it('does not inject before the request that continues a paused reply', async () => {
    const pause = [...textReply('Searching.').slice(0, -1), { type: 'done', finishReason: 'pause' }] as ScriptStep
    harness = await bootHarness({ script: [pause, textReply(' Found it.')] })
    const { app, llm } = harness
    const agent = await app.agents.create()
    const steps: number[] = []
    agent.beforeRequest(({ step }) => {
      steps.push(step)
      return ['note']
    })
    await agent.run('find it')
    expect(steps).toEqual([1])
    expect(conversation(llm.requests[1]!).map(message => message.role)).toEqual(['user', 'user', 'assistant'])
    await agent.close()
  })
})
