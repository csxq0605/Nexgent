import { afterEach, describe, expect, it } from 'vitest'
import { conversation, MemoryLedger, MemorySessionStore, textReply } from './helpers/fakes.js'
import { bootHarness, type Harness } from './helpers/harness.js'

let harness: Harness | undefined
afterEach(async () => {
  await harness?.dispose()
  harness = undefined
})

describe('ctx.agents.resume', () => {
  it('continues a closed session with its history, model and sandbox mode', async () => {
    harness = await bootHarness({ script: [textReply('first answer'), textReply('second answer')] })
    const { app, llm, store, ledger } = harness
    const agent = await app.agents.create({ sandboxMode: 'read-only', model: 'custom-model' })
    await agent.run('first')
    await agent.close()

    const resumed = await app.agents.resume(agent.sessionId)
    expect(resumed.model).toBe('custom-model')
    expect(resumed.sandboxMode).toBe('read-only')
    expect(resumed.turn).toBe(1)
    await resumed.run('second')
    expect(conversation(llm.requests[1]!)).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'second' },
    ])
    expect(store.of(agent.sessionId, 'turn.start').map(record => record.turn)).toEqual([1, 2])
    await resumed.close()
    // one task.outcome per task (run, then resume)
    expect(ledger.of('task.outcome').map(record => record.turns)).toEqual([1, 1])
  })

  it('closes a turn the previous process left open with kind interrupted', async () => {
    const store = new MemorySessionStore()
    const ledger = new MemoryLedger()
    harness = await bootHarness({ store, ledger })
    const { app, llm } = harness
    const crashed = await app.agents.create()
    const sessionId = crashed.sessionId
    // simulate a crash after the model asked for a tool: records written, lock gone
    await store.append(sessionId, { type: 'turn.start', turn: 1 })
    await store.append(sessionId, { type: 'user.message', turn: 1, content: 'do it', source: 'user' })
    await store.append(sessionId, {
      type: 'assistant.message', turn: 1, step: 1, requestId: 'r1', content: '',
      toolCalls: [{ id: 'c0', name: 'echo', arguments: '{}' }],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadTokens: 0, reasoningTokens: 0 },
      finishReason: 'tool-calls',
    })
    await crashed.close({ skipOutcome: true })

    llm.push(textReply('after crash'))
    const resumed = await app.agents.resume(sessionId)
    expect(store.of(sessionId, 'turn.end')).toEqual([expect.objectContaining({ turn: 1, reason: { kind: 'interrupted' } })])
    expect(resumed.turn).toBe(1)
    await resumed.run('continue')
    expect(store.of(sessionId, 'turn.start').map(record => record.turn)).toEqual([1, 2])
    // the dangling call is answered in the request only, so the endpoint accepts it
    const sent = conversation(llm.requests.at(-1)!)
    expect(sent[2]).toMatchObject({ role: 'tool', toolCallId: 'c0', isError: true })
    expect(store.of(sessionId, 'tool.result')).toEqual([])
  })

  it('refuses a session that is already open', async () => {
    harness = await bootHarness()
    const agent = await harness.app.agents.create()
    await expect(harness.app.agents.resume(agent.sessionId)).rejects.toMatchObject({ code: 'session/locked' })
    await expect(harness.app.agents.resume('missing')).rejects.toMatchObject({ code: 'session/not-found' })
  })

  it('resumes from a checkpointed session', async () => {
    harness = await bootHarness({
      script: [textReply('a'), textReply('b'), textReply('c')],
      patches: [{ id: 'agents', config: { checkpointEvery: 1 } }],
    })
    const agent = await harness.app.agents.create()
    await agent.run('one')
    await agent.run('two')
    await agent.close()
    const resumed = await harness.app.agents.resume(agent.sessionId)
    expect(resumed.history()).toHaveLength(4)
    await resumed.run('three')
    expect(harness.store.types(agent.sessionId).filter(type => type === 'checkpoint')).toHaveLength(3)
  })
})
