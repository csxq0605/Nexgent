/**
 * ADR 0018 (rework E1): the optional `ctx.learning.noteTurnEnd` signal after
 * every root task turn, with the turn's checks; hosts without it keep
 * working; a failing host is non-fatal.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { Context, LearningSignals, NexgentApp, TaskCheck, TaskRecorder, TurnEndSignal } from '../src/index.js'
import { textReply } from './helpers/fakes.js'
import { bootHarness, type Harness } from './helpers/harness.js'

let harness: Harness | undefined
afterEach(async () => {
  await harness?.dispose()
  harness = undefined
})

const PASS: TaskCheck = { name: 'file-exists', passed: true, target: 'file-1' }

async function provide(app: NexgentApp, name: 'taskRecorder' | 'learning', value: TaskRecorder | LearningSignals): Promise<void> {
  await app.ctx.plugin({ name: `fake-${name}`, apply: (ctx: Context) => { ctx.provide(name, value) } })
}

const recorder: TaskRecorder = {
  begin: async () => undefined,
  end: async () => ({ specs: [{ id: 'file-1', name: 'file-exists' as const, path: 'out.csv' }], results: [PASS] }),
}

describe('turn-end signal', () => {
  it('signals every root turn after turn.end, with its checks', async () => {
    harness = await bootHarness({ script: [textReply('one'), textReply('two')] })
    const { app, store } = harness
    const signals: TurnEndSignal[] = []
    await provide(app, 'taskRecorder', recorder)
    await provide(app, 'learning', {
      noteTurnEnd: async input => {
        // turn.end is already written when the host hears of it.
        expect(store.of(input.sessionId, 'turn.end').map(record => record.turn)).toContain(input.turn)
        signals.push(input)
      },
    })
    const agent = await app.agents.create()
    await agent.run('make it')
    await agent.run('again')
    expect(signals).toEqual([
      { taskId: agent.attribution.taskId, sessionId: agent.sessionId, turn: 1, reason: { kind: 'completed' }, checks: [PASS] },
      { taskId: agent.attribution.taskId, sessionId: agent.sessionId, turn: 2, reason: { kind: 'completed' }, checks: [PASS] },
    ])
    await agent.close()
    expect(store.of(agent.sessionId, 'error')).toEqual([])
  })

  it('is optional, and a failing host is non-fatal', async () => {
    harness = await bootHarness({ script: [textReply('one'), textReply('two')] })
    const { app, store } = harness
    const signals: TurnEndSignal[] = []
    await provide(app, 'learning', {
      noteTurnEnd: async input => {
        signals.push(input)
        throw new Error('queue locked')
      },
    })
    const agent = await app.agents.create()
    const result = await agent.run('make it')
    expect(result.reason).toEqual({ kind: 'completed' })
    expect(signals).toHaveLength(1)
    expect(store.of(agent.sessionId, 'error')).toEqual([expect.objectContaining({ fatal: false, error: expect.objectContaining({ message: expect.stringContaining('turn-end signal failed: queue locked') }) })])
    await agent.close()
  })
})
