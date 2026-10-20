import { afterEach, describe, expect, it } from 'vitest'
import { createApp, type Context, type NexgentApp, type Plugin, type SessionRecord, type ToolContext, type ToolRecordInput } from '@nexgent/kernel'
import { SessionPlugin } from '@nexgent/session'
import { scriptedProvider } from '@nexgent/test-support'
import { WorkspacePlugin } from '@nexgent/workspace'
import { CapabilitiesPlugin, capabilitiesOf, capabilityTools, type CapabilityService } from '../src/index.js'
import { tempDir } from './helpers.js'

let app: NexgentApp | undefined
afterEach(async () => {
  await app?.dispose()
  app = undefined
})

async function boot(root: string): Promise<CapabilityService> {
  const llm = scriptedProvider([])
  app = await createApp({
    registry: {
      '@nexgent/workspace': WorkspacePlugin as Plugin,
      '@nexgent/session': SessionPlugin as Plugin,
      '@nexgent/llm': { name: 'scripted-llm', apply: (ctx: Context) => { ctx.provide('llm', llm) } },
      '@nexgent/capabilities': CapabilitiesPlugin as Plugin,
    },
    patches: [
      { id: 'workspace', config: { root } },
      { insert: [{ id: 'capabilities', name: '@nexgent/capabilities' }] },
    ],
  })
  return capabilitiesOf(app.ctx)!
}

/** A session log in memory and tool contexts that append to it. */
class FakeSession {
  readonly records: SessionRecord[] = []
  readonly sessionId = '0b6c2f62-1f4a-4f43-9c39-8a3d2d1a0001'
  #calls = 0
  turn = 1

  read = async (): Promise<readonly SessionRecord[]> => this.records

  push(record: Record<string, unknown>): void {
    this.records.push({ seq: this.records.length + 1, ts: new Date().toISOString(), sessionId: this.sessionId, ...record } as unknown as SessionRecord)
  }

  context(extra: Partial<ToolContext> = {}): ToolContext & { step: number } {
    const id = `call-${++this.#calls}`
    return {
      sessionId: this.sessionId,
      callId: id,
      turn: this.turn,
      step: 1,
      workspace: app!.ctx.workspace,
      sandboxMode: 'workspace-write',
      signal: new AbortController().signal,
      approved: false,
      requestApproval: async () => true,
      appendRecord: async (record: ToolRecordInput) => { this.push(record as unknown as Record<string, unknown>) },
      attribution: { taskId: 'task-1', rootSessionId: this.sessionId, memberId: 'main', executionForm: 'direct' } as never,
      ...extra,
    }
  }
}

const FUNCTIONS = {
  formatVersion: 1,
  name: 'order-summary',
  description: 'Monthly summary.',
  functions: [{ name: 'summarizeOrders', description: 'Summarise.', inputSchema: { type: 'object' }, effects: [] }],
}
const fm = { kind: 'function-module', name: 'order-summary' } as const
const skill = { kind: 'skill', name: 'monthly-order-summary' } as const
const skillFile = { path: 'SKILL.md', content: '---\nname: monthly-order-summary\ndescription: Summarise a month.\n---\n\nSteps.\n' }

describe('capability_draft / try', () => {
  it('drafts and tries components for this session only; refuses members', async () => {
    const root = await tempDir()
    const service = await boot(root)
    const session = new FakeSession()
    const tools = capabilityTools(service, session.read)
    expect(tools.map(tool => tool.definition.name)).toEqual(['capability_draft', 'capability_try'])
    const [draft, tryTool] = tools

    const drafted = await draft!.handler({ ...fm, files: [{ path: 'functions.json', content: JSON.stringify(FUNCTIONS) }, { path: 'index.mjs', content: 'export function summarizeOrders() { return 1 }\n' }] }, session.context())
    expect(drafted.meta).toMatchObject({ revision: 1 })
    await draft!.handler({ ...skill, files: [skillFile] }, session.context())
    await draft!.handler({ kind: 'skill', name: 'unused-notes', files: [{ path: 'SKILL.md', content: '---\nname: unused-notes\ndescription: Unused.\n---\n\nx\n' }] }, session.context())
    expect(session.records.filter(record => record.type === 'capability.draft')).toHaveLength(3)

    const tried = await tryTool!.handler(fm, session.context())
    expect(tried.meta).toMatchObject({ tools: ['cap_order-summary_summarizeOrders'] })
    await tryTool!.handler(skill, session.context())
    await tryTool!.handler({ kind: 'skill', name: 'unused-notes' }, session.context())
    expect(session.records.filter(record => record.type === 'capability.try').map(record => (record as { tools?: unknown }).tools)).toEqual([['cap_order-summary_summarizeOrders'], undefined, undefined])

    await expect(draft!.handler({ ...skill, files: [skillFile] }, session.context({ member: { name: 'helper', executionForm: 'delegated' } as never }))).rejects.toMatchObject({ code: 'tool/denied' })
    await expect(tryTool!.handler(fm, session.context({ member: { name: 'helper', executionForm: 'delegated' } as never }))).rejects.toMatchObject({ code: 'tool/denied' })
    expect((await service.components(session.sessionId)).map(component => `${component.kind}/${component.name}@${component.version}`).sort())
      .toEqual(['function-module/order-summary@draft', 'skill/monthly-order-summary@draft', 'skill/unused-notes@draft'])
  })

  it('a draft is checked before anything is written', async () => {
    const root = await tempDir()
    const service = await boot(root)
    const session = new FakeSession()
    const [draft, tryTool] = capabilityTools(service, session.read)

    await expect(draft!.handler({ ...skill, files: [{ path: '../escape.md', content: 'x' }] }, session.context())).rejects.toMatchObject({ code: 'tool/invalid-input' })
    await expect(draft!.handler({ kind: 'nonsense', name: 'x' }, session.context())).rejects.toMatchObject({ code: 'tool/invalid-input' })
    await expect(tryTool!.handler(skill, session.context())).rejects.toMatchObject({ code: 'tool/invalid-input' })

    await draft!.handler({ ...skill, files: [{ path: 'SKILL.md', content: '---\nname: other-name\ndescription: Wrong.\n---\n\nx\n' }] }, session.context())
    // Without the skill plugin, the name check of SKILL.md is not registered; register it the way @nexgent/skill does.
    const { validateCapabilitySkill } = await import('@nexgent/skill')
    const unregister = service.registerValidator('skill', validateCapabilitySkill as never)
    await expect(tryTool!.handler(skill, session.context())).rejects.toMatchObject({ code: 'tool/invalid-input', message: expect.stringContaining('other-name') })
    unregister()

    await draft!.handler({ ...skill, files: [skillFile] }, session.context())
    expect((await tryTool!.handler(skill, session.context())).content).toContain('Loaded draft')
  })
})
