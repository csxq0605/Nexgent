/**
 * ADR 0018 (rework E1): the optional `ctx.improve.noteTurnEnd` signal after
 * every root task turn, with the turn's checks; never for an improvement
 * session; hosts without it keep working; a failing host is non-fatal.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { Context, ImprovementSignals, NexgentApp, TaskCheck, TaskRecorder, TurnEndSignal } from '../src/index.js'
import { textReply } from './helpers/fakes.js'
import { bootHarness, type Harness } from './helpers/harness.js'

let harness: Harness | undefined
afterEach(async () => {
  await harness?.dispose()
  harness = undefined
})

const PASS: TaskCheck = { name: 'file-exists', passed: true, target: 'file-1' }

async function provide(app: NexgentApp, name: 'taskRecorder' | 'improve', value: TaskRecorder | ImprovementSignals): Promise<void> {
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
    await provide(app, 'improve', {
      noteCheckFailure: async () => undefined,
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

  it('is optional, skips improvement sessions, and a failing host is non-fatal', async () => {
    harness = await bootHarness({ script: [textReply('one'), textReply('two')] })
    const { app, store } = harness
    const signals: TurnEndSignal[] = []
    await provide(app, 'improve', {
      noteCheckFailure: async () => undefined,
      noteTurnEnd: async input => {
        signals.push(input)
        throw new Error('queue locked')
      },
    })
    const job = await app.agents.create({ improvement: { jobId: '0f0f0f0f-0000-4000-8000-000000000001', phase: 'diagnose' } })
    await job.run('diagnose')
    expect(signals).toEqual([])
    await job.close()
    const agent = await app.agents.create()
    const result = await agent.run('make it')
    expect(result.reason).toEqual({ kind: 'completed' })
    expect(signals).toHaveLength(1)
    expect(store.of(agent.sessionId, 'error')).toEqual([expect.objectContaining({ fatal: false, error: expect.objectContaining({ message: expect.stringContaining('turn-end signal failed: queue locked') }) })])
    await agent.close()
  })
})
