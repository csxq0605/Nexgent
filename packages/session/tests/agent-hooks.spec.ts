/**
 * The kernel's step-2 hooks against the real JSONL store: context providers
 * must not make a lock-holding `resume` close the running turn.
 */
import { mkdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  createApp,
  resolveWorkspaceLayout,
  type Context,
  type ContextService,
  type LLMProvider,
  type LLMStreamEvent,
  type Plugin,
  type SessionState,
  type Workspace,
} from '@nexgent/kernel'
import { JsonlSessionStore, SessionPlugin } from '../src/index.js'
import { KNOWN_USAGE, tempDir } from './helpers.js'

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

const llm: LLMProvider = {
  info: { id: 'anthropic', endpoint: 'https://example.invalid', defaultModel: 'scripted-model' },
  complete: () => (async function* (): AsyncGenerator<LLMStreamEvent> {
    yield { type: 'text.delta', text: 'ok' }
    yield { type: 'usage', usage: KNOWN_USAGE }
    yield { type: 'done', finishReason: 'stop' }
  })(),
}

describe('agent hooks with JsonlSessionStore', () => {
  it('reads provider state without closing the running turn as interrupted', async () => {
    const root = await tempDir()
    const registry: Record<string, Plugin> = {
      '@nexgent/llm': { name: 'test-llm', apply: (ctx: Context) => { ctx.provide('llm', llm) } },
      '@nexgent/session': SessionPlugin as unknown as Plugin,
      '@nexgent/workspace': { name: 'test-workspace', apply: (ctx: Context) => { ctx.provide('workspace', workspace(root)) } },
    }
    const app = await createApp({ registry })
    const states: SessionState[] = []
    const context: ContextService = {
      providers: [{ id: 'probe', beginTurn: async input => { states.push(input.state); return { inject: ['context'] } } }],
      register: () => () => undefined,
    }
    await app.ctx.plugin({ name: 'test-context', apply: (ctx: Context) => { ctx.provide('context', context) } })
    try {
      const agent = await app.agents.create()
      const first = await agent.run('one')
      const second = await agent.run('two')
      expect([first.reason, second.reason]).toEqual([{ kind: 'completed' }, { kind: 'completed' }])
      await agent.close()

      const { records } = await new JsonlSessionStore({ layout: resolveWorkspaceLayout(root) }).readAll(agent.sessionId)
      const ends = records.filter(record => record.type === 'turn.end').map(record => record.type === 'turn.end' ? record.reason.kind : '')
      expect(ends).toEqual(['completed', 'completed'])
      expect(records.filter(record => record.type !== 'checkpoint').map(record => record.type)).toEqual([
        'session.start',
        'turn.start', 'user.message', 'user.message', 'assistant.message', 'turn.end',
        'turn.start', 'user.message', 'user.message', 'assistant.message', 'turn.end',
      ])
      expect(states.map(state => [state.metadata.lastTurn, state.metadata.openTurn])).toEqual([[0, undefined], [1, undefined]])
    } finally {
      await app.dispose()
    }
  })
})
