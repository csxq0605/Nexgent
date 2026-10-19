import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { asContext, createApp, resolveProjectLayout, type Context, type NexgentApp, type Plugin, type SessionRecord, type ToolContext } from '@nexgent/kernel'
import { ContextPlugin } from '@nexgent/context'
import { SessionPlugin } from '@nexgent/session'
import { SkillPlugin } from '@nexgent/skill'
import { scriptedProvider, type ScriptedProvider } from '@nexgent/test-support'
import { WorkspacePlugin } from '@nexgent/workspace'
import { applyDraft, CapabilitiesPlugin, capabilitiesOf, Handbook, HANDBOOK_INJECT_HEADER,
  HANDBOOK_TRIAL_HEADER, listCandidates, VERSION_PRACTICES_HEADER, type CapabilityService } from '../src/index.js'
import { tempDir } from './helpers.js'

let app: NexgentApp | undefined
afterEach(async () => {
  await app?.dispose()
  app = undefined
})

/** The Nexgent home of the current test (its user-level handbook). */
let home: string | undefined

async function boot(root: string, llm: ScriptedProvider): Promise<NexgentApp> {
  home = await tempDir()
  const registry: Record<string, Plugin> = {
    '@nexgent/workspace': WorkspacePlugin as Plugin,
    '@nexgent/session': SessionPlugin as Plugin,
    '@nexgent/llm': { name: 'scripted-llm', apply: (ctx: Context) => { ctx.provide('llm', llm) } },
    '@nexgent/context': ContextPlugin as Plugin,
    '@nexgent/skill': SkillPlugin as Plugin,
    '@nexgent/capabilities': CapabilitiesPlugin as Plugin,
  }
  app = await createApp({
    registry,
    patches: [
      { id: 'workspace', config: { root } },
      { insert: [{ id: 'context', name: '@nexgent/context' }, { id: 'skill', name: '@nexgent/skill' }, { id: 'capabilities', name: '@nexgent/capabilities', config: { home, handbookSeed: 7 } }] },
    ],
  })
  return app
}

function service(): CapabilityService {
  const found = capabilitiesOf(app!.ctx)
  if (found === undefined) throw new Error('ctx.capabilities is not loaded')
  return found
}

/** What `capability_try` passes to the service; the kernel's context is not needed for the loading itself. */
function tryContext(sessionId: string, root: string, answer = true): ToolContext & { asked: number } {
  const context = {
    sessionId,
    callId: 'call-try',
    turn: 1,
    workspace: app!.ctx.workspace,
    sandboxMode: 'workspace-write' as const,
    signal: new AbortController().signal,
    approved: false,
    asked: 0,
    async requestApproval() {
      context.asked++
      return answer
    },
  }
  void root
  return context
}

const SPEC = {
  formatVersion: 1,
  name: 'probe',
  description: 'Probes.',
  functions: [
    { name: 'total', description: 'Sum.', inputSchema: { type: 'object' }, effects: [] },
    { name: 'secrets', description: 'Try to escape.', inputSchema: { type: 'object' }, effects: [] },
    { name: 'peek', description: 'Read a project file through the host.', inputSchema: { type: 'object' }, effects: ['read'] },
  ],
}

const SOURCE = `
export function total(input) { return input.values.reduce((a, b) => a + b, 0) }
export async function secrets(input) {
  const out = { env: Object.keys(process.env).length }
  try {
    const fs = await import('node:fs')
    out.read = fs.readFileSync(input.path, 'utf8')
  } catch (error) {
    out.readError = String(error.code ?? error.message)
  }
  return out
}
export async function peek(input, host) { return host.readFile(input.path) }
`

describe('capability components in the agent loop (scripted model)', () => {
  it('a tried function module and skill reach only the session that tried them; the function runs isolated', async () => {
    const root = await tempDir()
    const outside = await tempDir()
    await writeFile(join(outside, 'secret.txt'), 'top secret')
    const llm = scriptedProvider([])
    const { agents } = await boot(root, llm)
    const projectRoot = app!.ctx.workspace.root
    await writeFile(join(projectRoot, 'data.txt'), 'project data')
    const capDir = service().store.directory

    const a = await agents.create({ sandboxMode: 'workspace-write' })
    const b = await agents.create({ sandboxMode: 'workspace-write' })
    await applyDraft(capDir, a.sessionId, { kind: 'function-module', name: 'probe' }, {
      files: [{ path: 'functions.json', content: JSON.stringify(SPEC) }, { path: 'index.mjs', content: SOURCE }],
    })
    await applyDraft(capDir, a.sessionId, { kind: 'skill', name: 'order-notes' }, {
      files: [{ path: 'SKILL.md', content: '---\nname: order-notes\ndescription: How we sum orders.\n---\n\nAdd the discount first.\n' }],
    })
    await service().tryDraft(tryContext(a.sessionId, root), { kind: 'function-module', name: 'probe' }, 1)
    await service().tryDraft(tryContext(a.sessionId, root), { kind: 'skill', name: 'order-notes' }, 1)
    expect(await service().toolsOf(a.sessionId, { kind: 'function-module', name: 'probe' })).toEqual(['cap_probe_total', 'cap_probe_secrets', 'cap_probe_peek'])

    llm.push(
      {
        toolCalls: [
          { name: 'cap_probe_total', arguments: { values: [1, 2, 3.5] } },
          { name: 'cap_probe_secrets', arguments: { path: join(outside, 'secret.txt') } },
          { name: 'cap_probe_peek', arguments: { path: 'data.txt' } },
          { name: 'load_skill', arguments: { name: 'order-notes' } },
        ],
      },
      { content: 'done' },
    )
    const resultA = await a.run({ text: 'Use the tools.' })
    expect(resultA.reason).toEqual({ kind: 'completed' })
    const first = llm.requests[0]!
    expect(first.tools?.map(tool => tool.name)).toEqual(expect.arrayContaining(['cap_probe_total', 'capability_draft', 'capability_try', 'capability_propose']))
    expect(first.messages.some(message => message.role === 'user' && message.content.includes('- order-notes: How we sum orders.'))).toBe(true)
    const results = llm.requests[1]!.messages.filter(message => message.role === 'tool')
    expect(results.map(message => [message.name, message.isError])).toEqual([
      ['cap_probe_total', false], ['cap_probe_secrets', false], ['cap_probe_peek', false], ['load_skill', false],
    ])
    expect(results[0]!.content).toContain('6.5')
    const escaped = JSON.parse(results[1]!.content.slice(results[1]!.content.indexOf('{'))) as { env: number; read?: string; readError?: string }
    expect(escaped.read).toBeUndefined()
    expect(escaped.readError).toBeDefined()
    expect(escaped.env).toBeLessThanOrEqual(1)
    expect(results[2]!.content).toContain('project data')
    expect(results[3]!.content).toContain('Add the discount first.')

    llm.push(
      { toolCalls: [{ name: 'load_skill', arguments: { name: 'order-notes' } }, { name: 'cap_probe_total', arguments: { values: [1] } }] },
      { content: 'nothing here' },
    )
    const resultB = await b.run({ text: 'Try the same.' })
    expect(resultB.reason).toEqual({ kind: 'completed' })
    const peer = llm.requests[2]!
    expect(peer.tools?.map(tool => tool.name)).not.toContain('cap_probe_total')
    expect(peer.messages[0]!.content).not.toContain('order-notes')
    const peerResults = llm.requests[3]!.messages.filter(message => message.role === 'tool')
    expect(peerResults.map(message => message.isError)).toEqual([true, true])
    llm.assertConsumed()
  })

  it('a refused plugin is neither imported nor loaded; an approved one adds its tool to that session only', async () => {
    const root = await tempDir()
    const llm = scriptedProvider([])
    const { agents } = await boot(root, llm)
    const capDir = service().store.directory
    const marker = join(await tempDir(), 'imported.txt')
    const plugin = {
      formatVersion: 1, name: 'greeter', description: 'Says hello.', entry: 'index.mjs', permissions: 'none', tools: ['say_hello'],
    }
    const source = `import { writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(marker)}, 'imported')
export default {
  name: 'greeter',
  apply(ctx) {
    ctx.tools.register({
      definition: { name: 'say_hello', description: 'Hello.', inputSchema: { type: 'object' }, effects: [], approval: 'never' },
      handler: async () => ({ content: 'hello' }),
    })
  },
}
`
    const a = await agents.create({ sandboxMode: 'workspace-write' })
    const b = await agents.create({ sandboxMode: 'workspace-write' })
    await applyDraft(capDir, a.sessionId, { kind: 'plugin', name: 'greeter' }, {
      files: [{ path: 'plugin.json', content: JSON.stringify(plugin) }, { path: 'index.mjs', content: source }],
    })

    const refused = tryContext(a.sessionId, root, false)
    await expect(service().tryDraft(refused, { kind: 'plugin', name: 'greeter' }, 1)).rejects.toMatchObject({ code: 'approval/denied' })
    expect(refused.asked).toBe(1)
    await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await service().components(a.sessionId, 'plugin')).toEqual([])

    const approved = tryContext(a.sessionId, root, true)
    await service().tryDraft(approved, { kind: 'plugin', name: 'greeter' }, 1)
    expect(await readFile(marker, 'utf8')).toBe('imported')
    expect(app!.ctx.agents.get(a.sessionId)!.ctx.tools.list().map(tool => tool.name)).toContain('say_hello')
    expect(app!.ctx.agents.get(b.sessionId)!.ctx.tools.list().map(tool => tool.name)).not.toContain('say_hello')
    expect(await service().toolComponent(a.sessionId, 'say_hello')).toEqual({ kind: 'plugin', name: 'greeter', version: 'draft' })
  })

  it('a session opened on an adopted bundle gets its components; a tampered bundle falls back to the previous version', async () => {
    const root = await tempDir()
    const llm = scriptedProvider([])
    const { agents } = await boot(root, llm)
    const store = service().store
    const bundle = await store.write([
      { kind: 'function-module', name: 'probe', files: [{ path: 'functions.json', content: JSON.stringify(SPEC) }, { path: 'index.mjs', content: SOURCE }] },
      { kind: 'context-policy', name: 'house-rules', files: [{ path: 'policy.json', content: JSON.stringify({ formatVersion: 1, name: 'house-rules', description: 'Rules.', instructions: 'Always cite the file.' }) }] },
    ])
    await store.adopt(bundle.version, { trigger: 'manual' })
    const resolved = await service().resolveVersion()
    expect(resolved.version).toBe(bundle.version)

    const agent = await agents.create({ sandboxMode: 'workspace-write' })
    expect(agent.capabilityVersion).toBe(bundle.version)
    expect(await service().sessionVersion(agent.sessionId)).toBe(bundle.version)
    llm.push({ toolCalls: [{ name: 'cap_probe_total', arguments: { values: [2, 2] } }] }, { content: 'four' })
    expect((await agent.run({ text: 'Add the numbers and cite the file.' })).reason).toEqual({ kind: 'completed' })
    // ADR 0018: the adopted policy is a project handbook entry, given before the user message, not in the system prompt.
    const first = llm.requests[0]!.messages
    expect(first[0]!.content).not.toContain('Always cite the file.')
    expect(first.at(-2)).toMatchObject({ role: 'user', content: expect.stringContaining('Always cite the file.') })
    expect(first.at(-1)).toMatchObject({ role: 'user', content: 'Add the numbers and cite the file.' })
    expect(llm.requests[1]!.messages.find(message => message.role === 'tool')).toMatchObject({ isError: false, content: expect.stringContaining('4') })
    expect(await service().toolComponent(agent.sessionId, 'cap_probe_total')).toEqual({ kind: 'function-module', name: 'probe', version: bundle.version })

    const file = join(store.directory, bundle.version, 'functions', 'probe', 'index.mjs')
    await writeFile(file, `${await readFile(file, 'utf8')}// tampered\n`)
    const after = await service().resolveVersion(bundle.version)
    expect(after.version).toBe('baseline')
    expect(after.switched).toMatchObject({ previous: bundle.version, reason: 'unavailable' })
    expect(after.rollbacks).toHaveLength(1)
    const status = await service().status()
    expect(status.version).toBe('baseline')
    expect(status.trigger).toBe('load-failure')
  })

  it('the model drafts, tries, uses and proposes through the kernel; a resumed session gets its tried skill back', async () => {
    const root = await tempDir()
    const llm = scriptedProvider([])
    const { agents } = await boot(root, llm)
    const skill = { kind: 'skill', name: 'order-notes' }
    const fm = { kind: 'function-module', name: 'probe' }
    llm.push(
      { toolCalls: [
        { name: 'capability_draft', arguments: { ...skill, files: [{ path: 'SKILL.md', content: '---\nname: order-notes\ndescription: How we sum orders.\n---\n\nAdd the discount first.\n' }] } },
        { name: 'capability_draft', arguments: { ...fm, files: [{ path: 'functions.json', content: JSON.stringify(SPEC) }, { path: 'index.mjs', content: SOURCE }] } },
      ] },
      { toolCalls: [{ name: 'capability_try', arguments: skill }, { name: 'capability_try', arguments: fm }] },
      { toolCalls: [{ name: 'load_skill', arguments: { name: 'order-notes' } }, { name: 'cap_probe_total', arguments: { values: [1, 2] } }] },
      { toolCalls: [{ name: 'capability_propose', arguments: { components: [skill, fm], summary: 'Order notes and a sum.' } }] },
      { content: 'proposed' },
    )
    const agent = await agents.create({ sandboxMode: 'workspace-write' })
    expect((await agent.run({ text: 'Make it reusable.' })).reason).toEqual({ kind: 'completed' })
    const toolResults = llm.requests.slice(1).flatMap(request => request.messages.filter(message => message.role === 'tool').slice(-2))
    expect(toolResults.every(message => !message.isError)).toBe(true)
    const log = (await readFile(join(resolveProjectLayout(root).sessions, agent.sessionId, 'session.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as { type: string })
    expect(log.map(record => record.type).filter(type => type.startsWith('capability.'))).toEqual(['capability.draft', 'capability.draft', 'capability.try', 'capability.try', 'capability.propose'])
    const [candidate] = await (await import('../src/index.js')).listCandidates(service().store.directory)
    expect(candidate?.components.map(component => component.name)).toEqual(['order-notes', 'probe'])

    await agent.close()
    const resumed = await agents.resume(agent.sessionId)
    expect((await service().components(resumed.sessionId, 'skill')).map(component => [component.name, component.version])).toEqual([['order-notes', 'draft']])
    llm.push({ toolCalls: [{ name: 'load_skill', arguments: { name: 'order-notes' } }] }, { content: 'again' })
    expect((await resumed.run({ text: 'Load it again.' })).reason).toEqual({ kind: 'completed' })
    expect(llm.requests.at(-1)!.messages.filter(message => message.role === 'tool').at(-1)).toMatchObject({ isError: false })
    llm.assertConsumed()
  })

  it('names the workflow graph and team template a call used', async () => {
    const root = await tempDir()
    await boot(root, scriptedProvider([]))
    const store = service().store
    const graph = { nodes: [{ id: 'draft', prompt: 'Write it.', dependencies: [] }] }
    const bundle = await store.write([
      { kind: 'architecture', name: 'one-step', files: [{ path: 'architecture.json', content: JSON.stringify({ format: 1, architecture: graph }) }] },
      { kind: 'team-template', name: 'pair', files: [{ path: 'team.json', content: JSON.stringify({ formatVersion: 1, name: 'pair', description: 'Two.', members: [{ name: 'writer', task: 'Write.' }, { name: 'checker', task: 'Check.' }] }) }] },
    ])
    await store.adopt(bundle.version, { trigger: 'manual' })
    const agent = await app!.ctx.agents.create({})
    const host = app!.ctx.get('capabilityHost')!
    expect(host.componentOf!({ sessionId: agent.sessionId, name: 'workflow', input: { graph: { nodes: [{ dependencies: [], prompt: 'Write it.', id: 'draft' }] } }, isError: false }))
      .toEqual({ kind: 'architecture', name: 'one-step', version: bundle.version })
    expect(host.componentOf!({ sessionId: agent.sessionId, name: 'spawn_teammate', input: { name: 'checker', task: 'x' }, isError: false }))
      .toEqual({ kind: 'team-template', name: 'pair', version: bundle.version })
    expect(host.componentOf!({ sessionId: agent.sessionId, name: 'spawn_teammate', input: { name: 'stranger', task: 'x' }, isError: false })).toBeUndefined()
  })

  it('reports a damaged activation chain to the user instead of guessing', async () => {
    const root = await tempDir()
    const llm = scriptedProvider([])
    await boot(root, llm)
    const store = service().store
    const bundle = await store.write([{ kind: 'skill', name: 'notes', files: [{ path: 'SKILL.md', content: '---\nname: notes\ndescription: Notes.\n---\n\nBody.\n' }] }])
    await store.adopt(bundle.version, { trigger: 'manual' })
    await mkdir(store.activationDirectory, { recursive: true })
    await writeFile(join(store.activationDirectory, '2.json'), '{"not": "a revision"}\n')
    const status = await service().status()
    expect(status.version).toBe(bundle.version)
    expect(status.problem).toMatch(/2\.json/)
    const resolved = await service().resolveVersion()
    expect(resolved.version).toBe(bundle.version)
    expect(resolved.problem?.file).toMatch(/2\.json/)
  })
})

describe('a component the session\'s version already carries (the gate\'s candidate side)', () => {
  const fm = { kind: 'function-module', name: 'probe' } as const
  const fmFiles = [{ path: 'functions.json', content: JSON.stringify(SPEC) }, { path: 'index.mjs', content: SOURCE }]

  async function adopted(root: string, llm: ScriptedProvider) {
    const { agents } = await boot(root, llm)
    const store = service().store
    const bundle = await store.write([{ kind: 'function-module', name: 'probe', files: fmFiles }])
    await store.adopt(bundle.version, { trigger: 'manual' })
    return { agents, version: bundle.version }
  }

  function toolResults(llm: ScriptedProvider) {
    return llm.requests.slice(1).map(request => request.messages.filter(message => message.role === 'tool').at(-1)!)
  }

  it('replaying "draft, try, use, propose" with the same content succeeds at every step and writes no candidate', async () => {
    const root = await tempDir()
    const llm = scriptedProvider([])
    const { agents, version } = await adopted(root, llm)
    llm.push(
      { toolCalls: [{ name: 'capability_draft', arguments: { ...fm, files: fmFiles } }] },
      { toolCalls: [{ name: 'capability_try', arguments: fm }] },
      { toolCalls: [{ name: 'cap_probe_total', arguments: { values: [1, 2] } }] },
      { toolCalls: [{ name: 'capability_propose', arguments: { components: [fm], summary: 'Same as adopted.' } }] },
      { content: 'done' },
    )
    const agent = await agents.create({ sandboxMode: 'workspace-write' })
    expect((await agent.run({ text: 'Replay task A.' })).reason).toEqual({ kind: 'completed' })
    llm.assertConsumed()
    expect(llm.requests).toHaveLength(5)
    const results = toolResults(llm)
    expect(results.map(message => [message.name, message.isError])).toEqual([
      ['capability_draft', false], ['capability_try', false], ['cap_probe_total', false], ['capability_propose', false],
    ])
    expect(results[1]!.content).toContain(`already in the capability version this session runs on (${version})`)
    expect(results[3]!.content).toContain('already in the capability version')
    expect(await listCandidates(service().store.directory)).toEqual([])
    expect((await service().components(agent.sessionId, 'function-module')).map(item => item.version)).toEqual([version])
  })

  it('try and propose without a draft succeed too', async () => {
    const root = await tempDir()
    const llm = scriptedProvider([])
    const { agents } = await adopted(root, llm)
    llm.push(
      { toolCalls: [{ name: 'cap_probe_total', arguments: { values: [3] } }, { name: 'capability_propose', arguments: { components: [fm] } }] },
      { toolCalls: [{ name: 'capability_try', arguments: fm }] },
      { content: 'done' },
    )
    const agent = await agents.create({ sandboxMode: 'workspace-write' })
    expect((await agent.run({ text: 'Replay task A.' })).reason).toEqual({ kind: 'completed' })
    const second = llm.requests[1]!.messages.filter(message => message.role === 'tool')
    expect(second.map(message => [message.name, message.isError])).toEqual([['cap_probe_total', false], ['capability_propose', false]])
    expect(toolResults(llm).at(-1)).toMatchObject({ name: 'capability_try', isError: false })
    expect(await listCandidates(service().store.directory)).toEqual([])
  })

  it('a same-named component with different content goes through the normal flow', async () => {
    const root = await tempDir()
    const llm = scriptedProvider([])
    const { agents, version } = await adopted(root, llm)
    const changed = [fmFiles[0]!, { path: 'index.mjs', content: SOURCE.replace('a + b', 'a + b + 0') }]
    llm.push(
      { toolCalls: [{ name: 'capability_draft', arguments: { ...fm, files: changed } }] },
      { toolCalls: [{ name: 'capability_try', arguments: fm }] },
      { toolCalls: [{ name: 'capability_propose', arguments: { components: [fm] } }] },
      { toolCalls: [{ name: 'cap_probe_total', arguments: { values: [1] } }] },
      { toolCalls: [{ name: 'capability_propose', arguments: { components: [fm] } }] },
      { content: 'done' },
    )
    const agent = await agents.create({ sandboxMode: 'workspace-write' })
    expect((await agent.run({ text: 'Improve the module.' })).reason).toEqual({ kind: 'completed' })
    const results = toolResults(llm)
    expect(results.map(message => [message.name, message.isError])).toEqual([
      ['capability_draft', false], ['capability_try', false], ['capability_propose', true], ['cap_probe_total', false], ['capability_propose', false],
    ])
    expect(results[1]!.content).toContain('Loaded draft')
    expect(results[2]!.content).toContain('needs a successful use')
    const [candidate] = await listCandidates(service().store.directory)
    expect(candidate).toMatchObject({ base: version })
    expect(candidate!.version).not.toBe(version)
  })
})

describe('the handbook in the agent loop (ADR 0018 decision 4, scripted model)', () => {
  const records = async (sessionId: string): Promise<readonly SessionRecord[]> => (await app!.ctx.session.readAll(sessionId)).records

  it('gives a root turn its top entries before the user message, records them on turn.start, and takes one mark per entry', async () => {
    const root = await tempDir()
    const llm = scriptedProvider([])
    const { agents } = (await boot(root, llm)).ctx
    const handbook = await Handbook.open({ projectRoot: root, home: home!, learning: { useShared: true, contribute: true } })
    const [added] = await handbook.apply([{ op: 'add', text: 'Recompute every total from the input rows before reporting it.', keywords: ['totals', 'report'] }], { actor: 'reflection' })
    const [other] = await handbook.apply([{ op: 'add', text: 'Rename image files by date taken.', keywords: ['photos'] }], { actor: 'reflection' })
    const id = added!.entryId!

    const agent = await agents.create({ sandboxMode: 'workspace-write' })
    llm.push(
      { toolCalls: [{ name: 'handbook_mark', arguments: { entryId: id, verdict: 'helpful', reason: 'caught a wrong sum' } }, { name: 'handbook_mark', arguments: { entryId: other!.entryId!, verdict: 'harmful' } }] },
      { toolCalls: [{ name: 'handbook_mark', arguments: { entryId: id, verdict: 'helpful' } }] },
      { content: 'Done.' },
    )
    expect((await agent.run({ text: 'Report the totals of the sales sheet.' })).reason).toEqual({ kind: 'completed' })
    const messages = llm.requests[0]!.messages
    expect(messages[0]!.role).toBe('system')
    expect(messages[0]!.content).not.toContain('Recompute every total')
    expect(messages.at(-2)).toMatchObject({ role: 'user', content: expect.stringContaining(`[${id}] Recompute every total`) })
    expect(messages.at(-2)!.content).toContain(HANDBOOK_INJECT_HEADER)
    expect(messages.at(-2)!.content).not.toContain('Rename image files')
    expect(messages.at(-1)).toMatchObject({ role: 'user', content: 'Report the totals of the sales sheet.' })
    const first = await records(agent.sessionId)
    expect(first.find(record => record.type === 'turn.start')).toMatchObject({ turn: 1, handbook: [id] })
    const results = first.filter(record => record.type === 'tool.result' && record.name === 'handbook_mark')
    expect(results.map(record => record.type === 'tool.result' && [record.isError, record.content])).toEqual([
      [false, `Marked entry ${id} helpful.`],
      [true, expect.stringContaining('was not given to this task')],
      [false, expect.stringContaining('already marked')],
    ])
    expect((await handbook.find(id))?.entry).toMatchObject({ helpful: 1, harmful: 0 })
    expect((await handbook.ops(id)).ops.at(-1)).toMatchObject({ op: 'upvote', actor: 'execution', reason: 'caught a wrong sum', source: { sessionId: agent.sessionId } })
    // The trial entry was drawn (ADR 0023) and the draw recorded next to the log.
    expect(messages.at(-2)!.content).toContain(HANDBOOK_TRIAL_HEADER)
    expect((await handbook.projectUsage.read()).concat(await handbook.userUsage.read()).find(record => record.kind === 'hit' && record.entryId === id)).toMatchObject({ draw: 'shown', given: true, status: 'trial', showProbability: 0.5 })

    // A later turn is not given the same entry again.
    llm.push({ content: 'Again.' })
    await agent.run({ text: 'Report the totals again.' })
    const second = (await records(agent.sessionId)).filter(record => record.type === 'turn.start')
    expect(second[1]).toEqual(expect.not.objectContaining({ handbook: expect.anything() }))
    expect(llm.requests.at(-1)!.messages.filter(message => message.role === 'user' && message.content.includes(HANDBOOK_INJECT_HEADER))).toHaveLength(1)
  })

  it('in a trial copy, gives the version\'s policy practices but writes nothing to the handbook', async () => {
    const root = await tempDir()
    const llm = scriptedProvider([])
    const { agents } = (await boot(root, llm)).ctx
    const bundle = await service().store.write([
      { kind: 'context-policy', name: 'house-rules', files: [{ path: 'policy.json', content: JSON.stringify({ formatVersion: 1, name: 'house-rules', description: 'Rules.', instructions: 'Always cite the file.' }) }] },
    ])
    await service().store.adopt(bundle.version, { trigger: 'manual', detail: 'replay copy for a gate trial' })
    const agent = await agents.create({ sandboxMode: 'workspace-write' })
    llm.push({ content: 'ok' })
    await agent.run({ text: 'Add.' })
    const injected = llm.requests[0]!.messages.at(-2)!
    expect(injected).toMatchObject({ role: 'user', content: asContext(`${VERSION_PRACTICES_HEADER}\nAlways cite the file.`) })
    const handbook = await Handbook.open({ projectRoot: root, home: home!, learning: { useShared: true, contribute: true } })
    expect(await handbook.project.read()).toEqual([])
    expect((await records(agent.sessionId)).find(record => record.type === 'turn.start')).toEqual(expect.not.objectContaining({ handbook: expect.anything() }))
  })

  it('a context policy the session tries is given on its next turn, once', async () => {
    const root = await tempDir()
    const llm = scriptedProvider([])
    const { agents } = (await boot(root, llm)).ctx
    const agent = await agents.create({ sandboxMode: 'workspace-write' })
    const policy = { kind: 'context-policy', name: 'house-rules', files: [{ path: 'policy.json', content: JSON.stringify({ formatVersion: 1, name: 'house-rules', description: 'Rules.', instructions: 'Name the source of every figure.' }) }] }
    llm.push(
      { toolCalls: [{ name: 'capability_draft', arguments: policy }] },
      { toolCalls: [{ name: 'capability_try', arguments: { kind: 'context-policy', name: 'house-rules' } }] },
      { content: 'Tried.' },
      { content: 'Second.' },
      { content: 'Third.' },
    )
    await agent.run({ text: 'Write the house rules down.' })
    await agent.run({ text: 'Summarise the figures.' })
    expect(llm.requests[3]!.messages.at(-2)).toMatchObject({ role: 'user', content: asContext(`${VERSION_PRACTICES_HEADER}\nName the source of every figure.`) })
    await agent.run({ text: 'And again.' })
    expect(llm.requests[4]!.messages.filter(message => message.role === 'user' && message.content.includes('Name the source of every figure.'))).toHaveLength(1)
  })
})
