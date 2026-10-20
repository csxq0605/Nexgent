/**
 * Step 4 ledger stamp against the real JSONL store and ledger: records
 * written outside an agent's loop carry the session's capability version,
 * and a host's per-turn `task.outcome` (as the SDK writes it) gets the
 * turn's `componentsUsed`.
 */
import { mkdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  createApp,
  resolveWorkspaceLayout,
  ZERO_USAGE,
  type CapabilityHost,
  type Context,
  type LedgerRecord,
  type LLMProvider,
  type LLMRequest,
  type LLMStreamEvent,
  type Plugin,
  type Workspace,
} from '@nexgent/kernel'
import { JsonlLedger, JsonlSessionStore, SessionPlugin } from '../src/index.js'
import { KNOWN_USAGE, tempDir } from './helpers.js'

const V1 = 'c'.repeat(64)

function workspace(root: string): Workspace {
  const layout = resolveWorkspaceLayout(root)
  return {
    root,
    layout,
    resolve: input => (input.startsWith('/') ? input : `${root}/${input}`),
    relative: absolute => absolute.slice(root.length + 1),
    sessionDir: id => `${layout.sessions}/${id}`,
    ensureLayout: async () => {
      mkdirSync(layout.sessions, { recursive: true })
    },
  }
}

/** Calls `cap_sums_add` once, then answers. */
const llm: LLMProvider = {
  info: { id: 'anthropic', endpoint: 'https://example.invalid', defaultModel: 'scripted-model' },
  complete: (request: LLMRequest) => (async function* (): AsyncGenerator<LLMStreamEvent> {
    if (request.messages.at(-1)?.role === 'user') {
      const id = `c${request.messages.length}`
      yield { type: 'tool-call.start', index: 0, id, name: 'cap_sums_add' }
      yield { type: 'tool-call.delta', index: 0, argumentsDelta: '{}' }
      yield { type: 'tool-call.end', index: 0, call: { id, name: 'cap_sums_add', arguments: '{}' } }
      yield { type: 'usage', usage: KNOWN_USAGE }
      yield { type: 'done', finishReason: 'tool-calls' }
      return
    }
    yield { type: 'text.delta', text: 'ok' }
    yield { type: 'usage', usage: KNOWN_USAGE }
    yield { type: 'done', finishReason: 'stop' }
  })(),
}

const host: CapabilityHost = {
  current: async () => V1,
  verify: async () => ({ ok: true }),
  attach: async ({ ctx }) => {
    ctx.tools.register({
      definition: { name: 'cap_sums_add', description: 'Add.', inputSchema: { type: 'object', properties: {} }, effects: ['read'], approval: 'never' },
      handler: async () => ({ content: '3' }),
    })
    return { components: [{ kind: 'function-module', name: 'sums', tools: ['cap_sums_add'] }] }
  },
}

describe('step 4 ledger stamp', () => {
  it('stamps the capability version and the turn view on records written outside the loop', async () => {
    const root = await tempDir()
    const registry: Record<string, Plugin> = {
      '@nexgent/llm': { name: 'test-llm', apply: (ctx: Context) => { ctx.provide('llm', llm) } },
      '@nexgent/session': SessionPlugin as unknown as Plugin,
      '@nexgent/workspace': { name: 'test-workspace', apply: (ctx: Context) => { ctx.provide('workspace', workspace(root)) } },
    }
    const app = await createApp({ registry })
    let sessionId = ''
    try {
      await app.ctx.plugin({ name: 'test-capabilities', apply: (ctx: Context) => { ctx.provide('capabilityHost', host) } })
      const agent = await app.agents.create()
      sessionId = agent.sessionId
      await agent.run('one')
      await agent.run('two')
      // The SDK's per-turn outcome, and a compactor's auxiliary request.
      await app.ctx.ledger.append({ type: 'task.outcome', sessionId, status: 'completed', totalUsage: ZERO_USAGE, requestCount: 2, toolCallCount: 1, turns: 1, toolsUsed: ['cap_sums_add'] })
      await app.ctx.ledger.append({ type: 'llm.request.start', sessionId, requestId: 'r1', provider: 'anthropic', endpoint: 'x', model: 'm', purpose: 'auxiliary', thinking: 'on' })
      await agent.close({ skipOutcome: true })
    } finally {
      await app.dispose()
    }
    const { records: session } = await new JsonlSessionStore({ layout: resolveWorkspaceLayout(root) }).readAll(sessionId)
    expect(session[0]).toMatchObject({ type: 'session.start', capabilityVersion: V1 })
    const records: LedgerRecord[] = []
    for await (const record of new JsonlLedger({ layout: resolveWorkspaceLayout(root) }).read()) records.push(record)
    expect(records.map(record => record.capabilityVersion)).toEqual(records.map(() => V1))
    const outcome = records.find(record => record.type === 'task.outcome')
    // Only the second turn's call: the SDK counts a turn as a task.
    expect(outcome).toMatchObject({ componentsUsed: [{ kind: 'function-module', name: 'sums', version: V1, calls: 1, errors: 0 }] })
    expect(outcome).not.toHaveProperty('memberCosts')
  })
})
