// Rework D3 (ADR 0017 decision 6): dollar caps, the 80% warning and the turn's cost.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentEvent, LLMUsage } from '../src/index.js'
import { capStatus, usageUsd, warningKey } from '../src/cost-caps.js'
import { textReply, toolCallReply } from './helpers/fakes.js'
import { bootHarness, type Harness } from './helpers/harness.js'

let harness: Harness | undefined

afterEach(async () => {
  await harness?.dispose()
  harness = undefined
})

function writeConfig(root: string, value: unknown): void {
  mkdirSync(join(root, '.nexgent'), { recursive: true })
  writeFileSync(join(root, '.nexgent', 'config.json'), JSON.stringify(value))
}

/** One cent per known input + output token: each scripted reply (10 + 5 tokens) costs 0.15. */
const centPerToken = (_model: string, used: LLMUsage): number | 'unknown' =>
  used.inputTokens === 'unknown' || used.outputTokens === 'unknown' ? 'unknown' : (used.inputTokens + used.outputTokens) * 0.01

function echo(h: Harness): void {
  h.app.ctx.tools.register({
    definition: { name: 'echo', description: 'e', inputSchema: { type: 'object' }, effects: ['read'], approval: 'never' },
    handler: async () => ({ content: 'ok' }),
  })
}

describe('cost-caps helpers', () => {
  it('reports reached before warning and USD before tokens and requests', () => {
    expect(capStatus(undefined, { requests: 9, tokens: 9, usd: 9, estimated: false })).toBeUndefined()
    expect(capStatus({ maxUsd: 1, maxRequests: 2 }, { requests: 2, tokens: 0, usd: 0.9, estimated: false })).toEqual({ level: 'reached', limit: 'maxRequests', used: 2, cap: 2 })
    expect(capStatus({ maxUsd: 1, maxTokens: 100 }, { requests: 0, tokens: 90, usd: 0.85, estimated: false })).toEqual({ level: 'warning', limit: 'maxUsd', used: 0.85, cap: 1 })
    expect(capStatus({ maxUsd: 1 }, { requests: 0, tokens: 0, usd: 0.79, estimated: false })).toBeUndefined()
    expect(warningKey('perTask', { level: 'warning', limit: 'maxUsd', cap: 1 })).toBe('perTask:warning:maxUsd:1')
  })

  it('treats a provider without prices, or an unknown price, as estimated zero', () => {
    const used = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } as LLMUsage
    expect(usageUsd({}, 'm', used)).toEqual({ usd: 0, estimated: true })
    expect(usageUsd({ estimateUsd: () => 'unknown' }, 'm', used)).toEqual({ usd: 0, estimated: true })
    expect(usageUsd({ estimateUsd: () => 0.2 }, 'm', used, true)).toEqual({ usd: 0.2, estimated: true })
  })
})

describe('dollar caps', () => {
  it('warns once at 80% of perTask.maxUsd, records reaching it and stops before the next request', async () => {
    harness = await bootHarness({ script: [toolCallReply('c1', 'echo', {}), toolCallReply('c2', 'echo', {}), toolCallReply('c3', 'echo', {}), textReply('never sent')] })
    harness.llm.estimateUsd = centPerToken
    writeConfig(harness.root, { costCaps: { perTask: { maxUsd: 0.35 } } })
    echo(harness)
    const agent = await harness.app.agents.create()
    const events: AgentEvent[] = []
    agent.subscribe(event => events.push(event))
    const result = await agent.run('loop')
    expect(harness.llm.requests).toHaveLength(3)
    expect(result.reason).toEqual({ kind: 'cancelled', cause: 'cost-cap' })
    const warnings = harness.ledger.of('cost.warning')
    expect(warnings.map(w => [w.scope, w.level, w.limit, w.cap])).toEqual([['perTask', 'warning', 'maxUsd', 0.35], ['perTask', 'reached', 'maxUsd', 0.35]])
    expect(warnings[0]!.used).toBeCloseTo(0.3)
    expect(warnings[0]).toMatchObject({ sessionId: agent.sessionId, estimated: false })
    expect(events.filter(e => e.type === 'cost.warning').map(e => (e as Extract<AgentEvent, { type: 'cost.warning' }>).warning.level)).toEqual(['warning', 'reached'])
    const error = harness.store.of(agent.sessionId, 'error')[0]!
    expect(error.error).toMatchObject({ code: 'budget/exhausted', details: { scope: 'task', metric: 'usd', limit: 0.35 } })
    expect((error.error.details as { used: number }).used).toBeCloseTo(0.45)
    const end = events.find(e => e.type === 'turn.end') as Extract<AgentEvent, { type: 'turn.end' }>
    expect(end.cost?.usd).toBeCloseTo(0.45)
    expect(end.cost?.estimated).toBe(false)
  })

  it('counts perConversation across turns and warns about it only once', async () => {
    harness = await bootHarness({ script: [textReply('a'), textReply('b'), textReply('never sent')] })
    harness.llm.estimateUsd = centPerToken
    writeConfig(harness.root, { costCaps: { perConversation: { maxUsd: 0.25 } } })
    const agent = await harness.app.agents.create()
    const ends: Array<Extract<AgentEvent, { type: 'turn.end' }>> = []
    agent.subscribe(event => {
      if (event.type === 'turn.end') ends.push(event)
    })
    // The real provider writes each request to the ledger; the scripted one does not, so the test does.
    const logRequest = (): void => {
      const common = { ts: new Date().toISOString(), sessionId: agent.sessionId, requestId: `r-${harness!.ledger.records.length}`, provider: 'anthropic', endpoint: 'https://example.invalid', model: 'scripted-model' }
      harness!.ledger.records.push(
        { ...common, type: 'llm.request.start', purpose: 'task', thinking: 'on' },
        { ...common, type: 'llm.request.end', status: 'ok', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }, latencyMs: 1 },
      )
    }
    expect((await agent.run('one')).reason).toEqual({ kind: 'completed' })
    logRequest()
    expect(harness.ledger.of('cost.warning')).toEqual([])
    expect((await agent.run('two')).reason).toEqual({ kind: 'completed' })
    logRequest()
    expect(harness.ledger.of('cost.warning').map(w => [w.scope, w.level])).toEqual([['perConversation', 'reached']])
    expect((await agent.run('three')).reason).toEqual({ kind: 'cancelled', cause: 'cost-cap' })
    expect(harness.llm.requests).toHaveLength(2)
    expect(harness.store.of(agent.sessionId, 'error')[0]!.error.details).toMatchObject({ scope: 'conversation', metric: 'usd', limit: 0.25 })
    // Reached once is enough: no second record for the same cap.
    expect(harness.ledger.of('cost.warning')).toHaveLength(1)
    // Each turn reports its own cost.
    expect(ends.map(e => Number(e.cost?.usd.toFixed(2)))).toEqual([0.15, 0.15, 0])
  })

  it('leaves learning spent on the conversation\'s task out of perConversation', async () => {
    harness = await bootHarness({ script: [textReply('a'), textReply('b')] })
    harness.llm.estimateUsd = centPerToken
    writeConfig(harness.root, { costCaps: { perConversation: { maxUsd: 1 } } })
    const agent = await harness.app.agents.create()
    expect((await agent.run('one')).reason).toEqual({ kind: 'completed' })
    const big = { inputTokens: 1000, outputTokens: 0, totalTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
    const push = (sessionId: string, extra: Record<string, unknown>, used = big) => {
      const common = { ts: new Date().toISOString(), sessionId, requestId: `r-${harness!.ledger.records.length}`, provider: 'anthropic', endpoint: 'https://example.invalid', model: 'scripted-model', taskId: 'task-1', ...extra }
      harness!.ledger.records.push({ ...common, type: 'llm.request.end', status: 'ok', usage: used, latencyMs: 1 } as never)
    }
    // The root's own request ties the task to the conversation; the learning on that task (10 dollars) must not count.
    push(agent.sessionId, { memberId: 'main' }, { ...big, inputTokens: 1, totalTokens: 1 })
    push('learner', { memberId: 'self-eval', learningPhase: 'self-eval' })
    expect((await agent.run('two')).reason).toEqual({ kind: 'completed' })
    expect(harness.ledger.of('cost.warning')).toEqual([])
  })

  it('never stops on dollars when no price is known, and says the turn cost is an estimate', async () => {
    harness = await bootHarness({ script: [textReply('a')] })
    writeConfig(harness.root, { costCaps: { perTask: { maxUsd: 0.01 } } })
    const agent = await harness.app.agents.create()
    const ends: Array<Extract<AgentEvent, { type: 'turn.end' }>> = []
    agent.subscribe(event => {
      if (event.type === 'turn.end') ends.push(event)
    })
    expect((await agent.run('one')).reason).toEqual({ kind: 'completed' })
    expect(harness.ledger.of('cost.warning')).toEqual([])
    expect(ends[0]!.cost).toEqual({ usd: 0, estimated: true })
  })

  it('warns at 80% of a token cap too', async () => {
    harness = await bootHarness({ script: [textReply('a'), textReply('b')] })
    writeConfig(harness.root, { costCaps: { perTask: { maxTokens: 18 } } })
    const agent = await harness.app.agents.create()
    await agent.run('one')
    expect(harness.ledger.of('cost.warning').map(w => [w.level, w.limit, w.used, w.cap])).toEqual([['warning', 'maxTokens', 15, 18]])
  })
})
