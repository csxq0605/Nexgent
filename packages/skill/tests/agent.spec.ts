import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, type Context, type NexgentApp, type Plugin, type SessionRecord, type SkillGatedTools, type Tool } from '@nexgent/kernel'
import { ContextPlugin } from '@nexgent/context'
import { SessionPlugin } from '@nexgent/session'
import { scriptedProvider, type ScriptedProvider } from '@nexgent/test-support'
import { WorkspacePlugin } from '@nexgent/workspace'
import { SkillPlugin } from '../src/index.js'
import { addMaterial, fixtureBytes, skillText, tempDir, writeProjectSkill } from './helpers.js'

let app: NexgentApp | undefined
afterEach(async () => {
  await app?.dispose()
  app = undefined
})

async function boot(root: string, llm: ScriptedProvider): Promise<NexgentApp> {
  const registry: Record<string, Plugin> = {
    '@nexgent/workspace': WorkspacePlugin as Plugin,
    '@nexgent/session': SessionPlugin as Plugin,
    '@nexgent/llm': { name: 'scripted-llm', apply: (ctx: Context) => { ctx.provide('llm', llm) } },
    '@nexgent/context': ContextPlugin as Plugin,
    '@nexgent/skill': SkillPlugin as Plugin,
  }
  app = await createApp({
    registry,
    patches: [
      { id: 'workspace', config: { root } },
      { insert: [{ id: 'context', name: '@nexgent/context' }, { id: 'skill', name: '@nexgent/skill' }] },
    ],
  })
  return app
}

async function records(dataDir: string, sessionId: string): Promise<SessionRecord[]> {
  const text = await readFile(join(dataDir, 'sessions', sessionId, 'session.jsonl'), 'utf8')
  return text.split('\n').filter(Boolean).map(line => JSON.parse(line) as SessionRecord)
}

describe('skills and context in the agent loop (scripted model)', () => {
  it('an .xlsx material is listed, the skill is loaded and the sheet read in read-only mode; instructions are in the system prompt and the skill list is an injected message', async () => {
    const root = await tempDir()
    const llm = scriptedProvider([])
    const { agents } = await boot(root, llm)
    const projectRoot = app!.ctx.workspace.root
    const dataDir = app!.ctx.workspace.layout.dataDir
    await writeFile(join(projectRoot, 'AGENTS.md'), 'Answer in one sentence.')
    const material = await addMaterial(projectRoot, 'orders.xlsx', await fixtureBytes('orders.xlsx'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', dataDir)
    // K1: the model is shown the absolute path in the user data directory.
    const shown = join(dataDir, 'materials', material.id, 'orders.xlsx')
    llm.push(
      { toolCalls: [{ name: 'load_skill', arguments: { name: 'office-documents' } }, { name: 'read_document', arguments: { path: shown, sheet: 'Summary' } }] },
      { content: 'The total is 139.75.' },
    )

    const agent = await agents.create({ sandboxMode: 'read-only' })
    const result = await agent.run({ text: 'What is the total?', materialIds: [material.id] })
    expect(result.reason).toEqual({ kind: 'completed' })
    llm.assertConsumed()

    const [first, second] = llm.requests
    const system = first!.messages[0]!.content
    expect(system).toContain('# Project instructions')
    expect(system).toContain('Answer in one sentence.')
    expect(system).not.toContain('# Skills')
    expect(second!.messages[0]!.content).toBe(system)
    expect(first!.tools?.map(tool => tool.name)).toEqual(expect.arrayContaining(['load_skill', 'read_document']))

    const userTexts = first!.messages.filter(message => message.role === 'user').map(message => message.content)
    expect(userTexts.some(text => text.includes(`- path: ${shown}`) && text.includes('read it with read_document'))).toBe(true)
    expect(userTexts.at(-1)).toContain('What is the total?')
    const list = userTexts.find(text => text.startsWith('# Skills'))
    expect(list).toContain('- office-documents: ')
    expect(userTexts.indexOf(list!)).toBeLessThan(userTexts.length - 1)

    const results = second!.messages.filter(message => message.role === 'tool')
    expect(results.map(message => [message.name, message.isError])).toEqual([['load_skill', false], ['read_document', false]])
    expect(results[0]!.content).toContain('# Skill: office-documents')
    expect(results[1]!.content).toBe('## Sheet: Summary (range B2:C2, 1 rows × 2 columns)\nTotal,139.75')

    const log = await records(dataDir, result.sessionId)
    expect(log.find(record => record.type === 'user.message' && record.source === 'inject' && record.content.includes(shown))).toBeDefined()
    expect(log.find(record => record.type === 'user.message' && record.source === 'inject' && record.content.includes('\n# Skills'))).toBeDefined()
    expect(log.find(record => record.type === 'user.message' && record.source === 'user')).toMatchObject({ materials: [material.id] })
  })

  it('a damaged document becomes an error tool result and the turn still completes', async () => {
    const root = await tempDir()
    const llm = scriptedProvider([])
    const { agents } = await boot(root, llm)
    const projectRoot = app!.ctx.workspace.root
    await writeFile(join(projectRoot, 'broken.docx'), Buffer.from('PK\u0003\u0004 not really a zip'))
    llm.push({ toolCalls: [{ name: 'read_document', arguments: { path: 'broken.docx' } }] }, { content: 'The file is damaged.' })
    const agent = await agents.create()
    const result = await agent.run('Read broken.docx')
    expect(result.reason).toEqual({ kind: 'completed' })
    const tool = llm.requests[1]!.messages.find(message => message.role === 'tool')
    expect(tool).toMatchObject({ name: 'read_document', isError: true, content: expect.stringContaining('broken.docx: not a valid .docx file') })
  })

  describe('skill-gated tools', () => {
    const ping: Tool = {
      definition: { name: 'ping_tool', description: 'Answers pong.', inputSchema: { type: 'object', properties: {} }, effects: ['read'], approval: 'never' },
      handler: async () => ({ content: 'pong' }),
    }
    const gated = (): SkillGatedTools => (app!.ctx as unknown as { get(name: string): SkillGatedTools }).get('skillTools')
    const toolNames = (llm: ScriptedProvider, index = -1) => llm.requests.at(index)!.tools?.map(tool => tool.name) ?? []

    it('are hidden before load_skill, visible after it, and an unknown tool name in the skill is harmless', async () => {
      const root = await tempDir()
      const llm = scriptedProvider([])
      const { agents } = await boot(root, llm)
      gated().offer(ping)
      await writeProjectSkill(app!.ctx.workspace.root, 'pinger', '---\nname: pinger\ndescription: Pings.\ntools: [ping_tool, no_such_tool]\n---\n\nCall ping_tool.\n')
      llm.push(
        { toolCalls: [{ name: 'load_skill', arguments: { name: 'pinger' } }] },
        { toolCalls: [{ name: 'ping_tool', arguments: {} }] },
        { content: 'Done.' },
      )
      const agent = await agents.create()
      const result = await agent.run('Ping please.')
      expect(result.reason).toEqual({ kind: 'completed' })
      llm.assertConsumed()
      expect(toolNames(llm, 0)).not.toContain('ping_tool')
      expect(toolNames(llm, 1)).toContain('ping_tool')
      expect(toolNames(llm, 1)).not.toContain('no_such_tool')
      const results = llm.requests[2]!.messages.filter(message => message.role === 'tool')
      expect(results.map(message => [message.name, message.isError])).toEqual([['load_skill', false], ['ping_tool', false]])
      expect(results[0]!.content).toContain('Tools now available: ping_tool.')
      // Another session does not see it.
      llm.push({ content: 'Hi.' })
      const other = await agents.create()
      await other.run('Hello.')
      expect(toolNames(llm)).not.toContain('ping_tool')
    })

    it('a resumed session that had loaded the skill gets the tool again; one that had not does not', async () => {
      const root = await tempDir()
      const llm = scriptedProvider([])
      const { agents } = await boot(root, llm)
      gated().offer(ping)
      await writeProjectSkill(app!.ctx.workspace.root, 'pinger', '---\nname: pinger\ndescription: Pings.\ntools: [ping_tool]\n---\n\nCall ping_tool.\n')
      llm.push({ toolCalls: [{ name: 'load_skill', arguments: { name: 'pinger' } }] }, { content: 'Loaded.' }, { content: 'Plain.' })
      const loaded = await agents.create()
      const loadedResult = await loaded.run('Load it.')
      await loaded.close()
      const plain = await agents.create()
      const plainResult = await plain.run('Do not load it.')
      await plain.close()

      llm.push({ content: 'Resumed.' })
      const resumed = await agents.resume(loadedResult.sessionId)
      await resumed.run('Continue.')
      expect(toolNames(llm)).toContain('ping_tool')
      await resumed.close()

      llm.push({ content: 'Resumed plain.' })
      const resumedPlain = await agents.resume(plainResult.sessionId)
      await resumedPlain.run('Continue.')
      expect(toolNames(llm)).not.toContain('ping_tool')
    })

    it('a withdrawn offer cannot be revealed', async () => {
      const root = await tempDir()
      const llm = scriptedProvider([])
      const { agents } = await boot(root, llm)
      const withdraw = gated().offer(ping)
      withdraw()
      await writeProjectSkill(app!.ctx.workspace.root, 'pinger', '---\nname: pinger\ndescription: Pings.\ntools: [ping_tool]\n---\n\nCall ping_tool.\n')
      llm.push({ toolCalls: [{ name: 'load_skill', arguments: { name: 'pinger' } }] }, { content: 'Loaded.' })
      const agent = await agents.create()
      await agent.run('Load it.')
      expect(toolNames(llm)).not.toContain('ping_tool')
    })
  })

  it('injects the skill list once per session until it changes', async () => {
    const root = await tempDir()
    const llm = scriptedProvider([{ content: 'One.' }, { content: 'Two.' }, { content: 'Three.' }])
    const { agents } = await boot(root, llm)
    const agent = await agents.create()
    await agent.run('First.')
    await agent.run('Second.')
    await writeProjectSkill(app!.ctx.workspace.root, 'fresh', skillText('fresh'))
    await agent.run('Third.')
    const lists = (index: number) => llm.requests[index]!.messages.filter(message => message.role === 'user' && message.content.startsWith('# Skills'))
    expect(lists(0)).toHaveLength(1)
    expect(lists(1)).toHaveLength(1)
    expect(lists(2)).toHaveLength(2)
    expect(lists(2)[1]!.content).toContain('- fresh: Does fresh.')
    for (const request of llm.requests) expect(request.messages[0]!.content).not.toContain('# Skills')
  })
})
