/**
 * ADR 0017 decision 5 in the loop: consecutive calls of `concurrent` tools run
 * together, other calls run alone in call order, approval questions come one
 * at a time, and results and records stay in call order.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { MAX_CONCURRENT_CALLS, type ApprovalRequest, type LLMStreamEvent, type Tool } from '../src/index.js'
import { sleep, textReply, usage } from './helpers/fakes.js'
import { bootHarness, type Harness } from './helpers/harness.js'

/** A reply calling several tools at once. */
function callsReply(calls: ReadonlyArray<{ id: string; name: string; args: unknown }>): LLMStreamEvent[] {
  return [
    ...calls.flatMap((call, index) => {
      const json = JSON.stringify(call.args)
      return [
        { type: 'tool-call.start' as const, index, id: call.id, name: call.name },
        { type: 'tool-call.end' as const, index, call: { id: call.id, name: call.name, arguments: json } },
      ]
    }),
    { type: 'usage', usage: usage(10, 5) },
    { type: 'done', finishReason: 'tool-calls' },
  ]
}

const schema = { type: 'object', properties: { ms: { type: 'number' }, ask: { type: 'string' } } } as const

/** A tool that records how many of its calls run at the same time. */
function probe(name: string, options: { concurrent?: boolean; effects?: Tool['definition']['effects']; approval?: Tool['definition']['approval'] } = {}) {
  const state = { running: 0, peak: 0, order: [] as string[] }
  const tool: Tool = {
    definition: {
      name,
      description: name,
      inputSchema: schema,
      effects: options.effects ?? ['read'],
      approval: options.approval ?? 'never',
      ...(options.concurrent === undefined ? {} : { concurrent: options.concurrent }),
    },
    handler: async (input, context) => {
      const args = input as { ms?: number; ask?: string }
      state.running += 1
      state.peak = Math.max(state.peak, state.running)
      state.order.push(`start ${context.callId}`)
      try {
        if (args.ask !== undefined) {
          const allowed = await context.requestApproval?.({ summary: args.ask, subject: { kind: 'path', value: args.ask }, grantTool: 'fs.read', pattern: '/outside/**' })
          if (allowed !== true) return { content: 'not allowed', isError: true }
        }
        await sleep(args.ms ?? 0, context.signal)
        return { content: `${name} ${context.callId}` }
      } finally {
        state.running -= 1
        state.order.push(`end ${context.callId}`)
      }
    },
  }
  return { tool, state }
}

let harness: Harness | undefined
afterEach(async () => {
  await harness?.dispose()
  harness = undefined
})

describe('concurrent tool calls (ADR 0017 decision 5)', () => {
  it('runs concurrent calls of one step together and returns results in call order', async () => {
    // Later calls finish first, so completion order differs from call order.
    const calls = [300, 200, 100, 50].map((ms, index) => ({ id: `r${index}`, name: 'read_probe', args: { ms } }))
    harness = await bootHarness({ script: [callsReply(calls), textReply('done')] })
    const read = probe('read_probe', { concurrent: true })
    harness.app.ctx.tools.register(read.tool)
    const agent = await harness.app.agents.create()
    const started = Date.now()
    await agent.run('read four')
    const elapsed = Date.now() - started
    expect(read.state.peak).toBe(4)
    // Close to the longest call, far from the sum (650 ms).
    expect(elapsed).toBeLessThan(600)
    const results = harness.store.of(agent.sessionId, 'tool.result')
    expect(results.map(result => result.toolCallId)).toEqual(['r0', 'r1', 'r2', 'r3'])
    expect(harness.ledger.of('tool.call').map(record => record.callId)).toEqual(['r0', 'r1', 'r2', 'r3'])
    expect(read.state.order.slice(0, 4).every(entry => entry.startsWith('start'))).toBe(true)
  })

  it('keeps tools that do not opt in serial, even when they only declare read effects', async () => {
    const calls = [0, 1, 2].map(index => ({ id: `s${index}`, name: 'stateful', args: { ms: 30 } }))
    harness = await bootHarness({ script: [callsReply(calls), textReply('done')] })
    const stateful = probe('stateful')
    harness.app.ctx.tools.register(stateful.tool)
    const agent = await harness.app.agents.create()
    await agent.run('go')
    expect(stateful.state.peak).toBe(1)
    expect(stateful.state.order).toEqual(['start s0', 'end s0', 'start s1', 'end s1', 'start s2', 'end s2'])
  })

  it('a non-concurrent call splits the step into batches run one after another', async () => {
    const calls = [
      { id: 'a', name: 'read_probe', args: { ms: 40 } },
      { id: 'b', name: 'read_probe', args: { ms: 40 } },
      { id: 'w', name: 'write_probe', args: { ms: 20 } },
      { id: 'c', name: 'read_probe', args: { ms: 10 } },
    ]
    harness = await bootHarness({ script: [callsReply(calls), textReply('done')] })
    const read = probe('read_probe', { concurrent: true })
    const write = probe('write_probe', { effects: ['write'] })
    harness.app.ctx.tools.register(read.tool)
    harness.app.ctx.tools.register(write.tool)
    const agent = await harness.app.agents.create()
    await agent.run('go')
    expect(read.state.peak).toBe(2)
    // c starts only after the write ended, and the write only after a and b ended.
    expect(read.state.order.indexOf('start c')).toBeGreaterThan(read.state.order.indexOf('end a'))
    expect(write.state.order).toEqual(['start w', 'end w'])
    expect(harness.store.of(agent.sessionId, 'tool.result').map(result => result.toolCallId)).toEqual(['a', 'b', 'w', 'c'])
  })

  it('a call that needs an up-front approval never joins a concurrent batch', async () => {
    const calls = [
      { id: 'a', name: 'read_probe', args: { ms: 30 } },
      { id: 'q', name: 'asking_read', args: { ms: 30 } },
      { id: 'b', name: 'read_probe', args: { ms: 30 } },
    ]
    harness = await bootHarness({ script: [callsReply(calls), textReply('done')] })
    const read = probe('read_probe', { concurrent: true })
    const asking = probe('asking_read', { concurrent: true, approval: 'always' })
    harness.app.ctx.tools.register(read.tool)
    harness.app.ctx.tools.register(asking.tool)
    harness.app.ctx.approvals.setResponder(async request => ({ id: request.id, decision: 'allow', scope: 'once', decidedBy: 'user' }))
    const agent = await harness.app.agents.create()
    await agent.run('go')
    expect(read.state.peak).toBe(1)
    expect(read.state.order).toEqual(['start a', 'end a', 'start b', 'end b'])
  })

  it('asks questions raised during concurrent calls one at a time; a session grant answers the rest', async () => {
    const calls = [0, 1, 2].map(index => ({ id: `o${index}`, name: 'read_probe', args: { ask: `/outside/f${index}.txt`, ms: 10 } }))
    harness = await bootHarness({ script: [callsReply(calls), textReply('done')] })
    const read = probe('read_probe', { concurrent: true })
    harness.app.ctx.tools.register(read.tool)
    let open = 0
    let peakOpen = 0
    const asked: ApprovalRequest[] = []
    harness.app.ctx.approvals.setResponder(async request => {
      open += 1
      peakOpen = Math.max(peakOpen, open)
      asked.push(request)
      await sleep(30)
      open -= 1
      return { id: request.id, decision: 'allow', scope: 'session', decidedBy: 'user' }
    })
    const agent = await harness.app.agents.create()
    await agent.run('go')
    expect(peakOpen).toBe(1)
    expect(asked).toHaveLength(1)
    expect(harness.store.of(agent.sessionId, 'tool.result').map(result => [result.toolCallId, result.isError])).toEqual([['o0', false], ['o1', false], ['o2', false]])
  })

  it('runs at most MAX_CONCURRENT_CALLS calls at once', async () => {
    const calls = Array.from({ length: MAX_CONCURRENT_CALLS + 3 }, (_, index) => ({ id: `m${index}`, name: 'read_probe', args: { ms: 20 } }))
    harness = await bootHarness({ script: [callsReply(calls), textReply('done')] })
    const read = probe('read_probe', { concurrent: true })
    harness.app.ctx.tools.register(read.tool)
    const agent = await harness.app.agents.create()
    await agent.run('go')
    expect(read.state.peak).toBe(MAX_CONCURRENT_CALLS)
    expect(harness.store.of(agent.sessionId, 'tool.result')).toHaveLength(MAX_CONCURRENT_CALLS + 3)
  })

  it('cancelling the turn ends every running call of the batch', async () => {
    const calls = [0, 1, 2].map(index => ({ id: `k${index}`, name: 'read_probe', args: { ms: 5_000 } }))
    harness = await bootHarness({ script: [callsReply(calls), textReply('done')] })
    const read = probe('read_probe', { concurrent: true })
    harness.app.ctx.tools.register(read.tool)
    const agent = await harness.app.agents.create()
    const run = agent.run('go')
    while (read.state.running < 3) await sleep(5)
    agent.cancel()
    await run
    const results = harness.store.of(agent.sessionId, 'tool.result')
    expect(results.map(result => result.toolCallId)).toEqual(['k0', 'k1', 'k2'])
    expect(results.every(result => result.isError && result.error?.code === 'tool/aborted')).toBe(true)
  })
})
