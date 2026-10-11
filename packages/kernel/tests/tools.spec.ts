import { afterEach, describe, expect, it } from 'vitest'
import { Context, ToolRegistryService, type Tool } from '../src/index.js'
import { textReply, toolCallReply } from './helpers/fakes.js'
import { bootHarness, type Harness } from './helpers/harness.js'

const tool = (name: string): Tool => ({
  definition: { name, description: `${name} tool`, inputSchema: { type: 'object' }, effects: ['read'], approval: 'never' },
  handler: async () => ({ content: name }),
})

let harness: Harness | undefined
afterEach(async () => {
  await harness?.dispose()
  harness = undefined
})

describe('ctx.tools', () => {
  async function root() {
    const ctx = new Context()
    await ctx.plugin(ToolRegistryService)
    return ctx
  }

  it('registers globally, rejects duplicates and bad names, unregisters', async () => {
    const ctx = await root()
    const dispose = ctx.tools.register(tool('read_file'))
    ctx.tools.register(tool('grep'))
    expect(ctx.tools.list().map(definition => definition.name)).toEqual(['read_file', 'grep'])
    expect(() => ctx.tools.register(tool('grep'))).toThrow(/already registered/)
    expect(() => ctx.tools.register(tool('Bad-Name'))).toThrow(/invalid tool name/)
    expect(ctx.tools.get('grep')?.definition.name).toBe('grep')
    expect(ctx.tools.unregister('grep')).toBe(true)
    expect(ctx.tools.unregister('grep')).toBe(false)
    dispose()
    expect(ctx.tools.list()).toEqual([])
    expect(() => ctx.tools.restrict({ deny: ['x'] })).toThrow(/scoped/)
  })

  it('removes a plugin\'s tools when the plugin is disposed', async () => {
    const ctx = await root()
    const fiber = ctx.plugin({ name: 'fs-tools', inject: ['tools'], apply: (c: Context) => { c.tools.register(tool('read_file')) } })
    await fiber
    expect(ctx.tools.list().map(definition => definition.name)).toEqual(['read_file'])
    await fiber.dispose()
    expect(ctx.tools.list()).toEqual([])
  })

  it('keeps agent tools and restrictions private to the agent', async () => {
    harness = await bootHarness({ script: [toolCallReply('c1', 'grep', {}), textReply('done')] })
    const { app } = harness
    app.ctx.tools.register(tool('read_file'))
    app.ctx.tools.register(tool('grep'))
    const a = await app.agents.create()
    const b = await app.agents.create()
    a.ctx.tools.register(tool('private_note'))
    a.ctx.tools.restrict({ deny: ['grep'] })
    expect(a.ctx.tools.list().map(definition => definition.name)).toEqual(['read_file', 'private_note'])
    expect(b.ctx.tools.list().map(definition => definition.name)).toEqual(['read_file', 'grep'])
    expect(app.ctx.tools.list().map(definition => definition.name)).toEqual(['read_file', 'grep'])
    // a mask never hides tools of the same scope; allow lists intersect
    a.ctx.tools.restrict({ allow: ['read_file', 'grep'] })
    expect(a.ctx.tools.list().map(definition => definition.name)).toEqual(['read_file', 'private_note'])

    // the model of agent a never sees grep, and calling it fails
    await a.run('search')
    expect(harness.llm.requests[0]!.tools?.map(definition => definition.name)).toEqual(['read_file', 'private_note'])
    expect(harness.store.of(a.sessionId, 'tool.result')[0]!.error?.code).toBe('tool/not-found')

    await a.close()
    expect(app.ctx.tools.list().map(definition => definition.name)).toEqual(['read_file', 'grep'])
  })
})
