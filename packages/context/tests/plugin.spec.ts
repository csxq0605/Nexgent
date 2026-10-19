import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, ZERO_USAGE, type Context, type ContextProvider, type NexgentApp, type Plugin } from '@nexgent/kernel'
import { SessionPlugin } from '@nexgent/session'
import { scriptedProvider, type ScriptedProvider } from '@nexgent/test-support'
import { WorkspacePlugin } from '@nexgent/workspace'
import { BasicCompactor, ContextPlugin, ContextRegistry, orderProviders } from '../src/index.js'
import { SESSION_ID } from './helpers.js'
import { turn } from './history.js'

let app: NexgentApp | undefined
let root: string | undefined
afterEach(async () => {
  await app?.dispose()
  app = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true, maxRetries: 5 })
  root = undefined
})

async function boot(llm: ScriptedProvider, contextConfig: Record<string, unknown> = {}): Promise<NexgentApp> {
  root = await mkdtemp(join(tmpdir(), 'nexgent-context-plugin-'))
  const registry: Record<string, Plugin> = {
    '@nexgent/workspace': WorkspacePlugin as Plugin,
    '@nexgent/session': SessionPlugin as Plugin,
    '@nexgent/llm': { name: 'scripted-llm', apply: (ctx: Context) => { ctx.provide('llm', llm) } },
    '@nexgent/context': ContextPlugin as Plugin,
  }
  app = await createApp({
    registry,
    patches: [
      { id: 'workspace', config: { root } },
      { insert: [{ id: 'context', name: '@nexgent/context', config: contextConfig as never }] },
    ],
  })
  return app
}

const provider = (id: string): ContextProvider => ({ id, beginTurn: async () => ({}) })

describe('@nexgent/context plugin', () => {
  it('provides ctx.context with its two providers and a compactor; others register into the fixed order', async () => {
    const { ctx } = await boot(scriptedProvider([]))
    expect(ctx.context.providers.map(p => p.id)).toEqual(['workspace-instructions', 'materials'])
    expect(ctx.context.compactor).toBeInstanceOf(BasicCompactor)

    const disposeExtra = ctx.context.register(provider('extra'))
    const disposeSkills = ctx.context.register(provider('skills'))
    const disposeGoal = ctx.context.register(provider('goal'))
    expect(ctx.context.providers.map(p => p.id)).toEqual(['workspace-instructions', 'goal', 'skills', 'materials', 'extra'])
    expect(() => ctx.context.register(provider('goal'))).toThrow(expect.objectContaining({ code: 'config/invalid' }))
    disposeSkills()
    disposeSkills()
    expect(ctx.context.providers.map(p => p.id)).toEqual(['workspace-instructions', 'goal', 'materials', 'extra'])
    disposeGoal()
    disposeExtra()
    expect(ctx.context.providers.map(p => p.id)).toEqual(['workspace-instructions', 'materials'])
  })

  it('summarizes with the project thinking setting from .nexgent/config.json', async () => {
    const llm = scriptedProvider([{ content: 'S' }])
    const { ctx } = await boot(llm, { compaction: { thresholdTokens: 10 } })
    await writeFile(join(root!, '.nexgent', 'config.json'), JSON.stringify({ version: 1, thinking: 'off', effort: 'low' }))
    const messages = [...turn(1), ...turn(2).slice(0, 2)]
    const input = { sessionId: SESSION_ID, turn: 2, step: 1, model: 'claude-sonnet-5-5', messages, failedThisTurn: false, lastUsage: { ...ZERO_USAGE, inputTokens: 50 } }
    expect(ctx.context.compactor!.shouldCompact(input)).toBe(true)
    await ctx.context.compactor!.compact(input, new AbortController().signal)
    expect(llm.requests[0]).toMatchObject({ thinking: 'off', effort: 'low' })
  })

  it('can run without a compactor, and rejects unknown config fields', async () => {
    const { ctx } = await boot(scriptedProvider([]), { compaction: { enabled: false } })
    expect(ctx.context.compactor).toBeUndefined()
    await app!.dispose()
    app = undefined
    await expect(boot(scriptedProvider([]), { compacton: {} })).rejects.toThrow(/unknown field/)
  })

  it('orders providers without a registry too', () => {
    expect(orderProviders([provider('x'), provider('materials'), provider('workspace-instructions'), provider('y')]).map(p => p.id))
      .toEqual(['workspace-instructions', 'materials', 'x', 'y'])
    expect(new ContextRegistry().compactor).toBeUndefined()
  })
})
