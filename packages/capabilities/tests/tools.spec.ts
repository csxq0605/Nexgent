import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, resolveWorkspaceLayout, type Context, type NexgentApp, type Plugin, type SessionRecord, type ToolContext, type ToolRecordInput } from '@nexgent/kernel'
import { JsonlSessionStore, SessionPlugin } from '@nexgent/session'
import { scriptedProvider } from '@nexgent/test-support'
import { WorkspacePlugin } from '@nexgent/workspace'
import { CapabilitiesPlugin, capabilitiesOf, capabilityTools, findUseProof, listCandidates, readCandidate, type CapabilityService } from '../src/index.js'
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
    patches: [{ id: 'workspace', config: { root } }, { insert: [{ id: 'capabilities', name: '@nexgent/capabilities' }] }],
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

  /** Record an assistant call and its result, the way the kernel does. */
  call(name: string, args: unknown, isError = false): void {
    const id = `call-${++this.#calls}`
    this.push({ type: 'assistant.message', turn: this.turn, step: 1, content: '', toolCalls: [{ id, name, arguments: JSON.stringify(args) }] })
    this.push({ type: 'tool.result', turn: this.turn, step: 1, toolCallId: id, name, content: 'ok', isError })
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

describe('capability_draft / try / propose', () => {
  it('drafts, tries and proposes used components; refuses an unused one and members', async () => {
    const root = await tempDir()
    const service = await boot(root)
    const session = new FakeSession()
    const [draft, tryTool, propose] = capabilityTools(service, session.read)

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

    session.turn = 2
    session.call('cap_order-summary_summarizeOrders', { csvText: 'x' })
    session.call('load_skill', { name: 'unused-notes' }, true)
    session.call('load_skill', { name: 'monthly-order-summary' })

    await expect(propose!.handler({ components: [{ kind: 'skill', name: 'unused-notes' }] }, session.context())).rejects.toMatchObject({ code: 'tool/failed' })
    await expect(propose!.handler({ components: [fm] }, session.context({ member: { name: 'helper', executionForm: 'delegated' } as never }))).rejects.toMatchObject({ code: 'tool/denied' })
    expect(await listCandidates(service.store.directory)).toEqual([])

    const proposed = await propose!.handler({ components: [fm, skill], summary: 'Monthly summary.' }, session.context())
    const id = (proposed.meta as { candidateId: string }).candidateId
    const candidate = await readCandidate(service.store.directory, id)
    expect(candidate).toMatchObject({ sessionId: session.sessionId, taskId: 'task-1', base: 'baseline', requiresApproval: false, summary: 'Monthly summary.' })
    expect(candidate.components.map(component => component.name)).toEqual(['order-summary', 'monthly-order-summary'])
    expect(candidate.proofs.map(proof => proof.kind)).toEqual(['function-module', 'skill'])
    const bundle = await service.store.load(candidate.version)
    expect(bundle.manifest.components.map(component => `${component.kind}/${component.name}`).sort()).toEqual(['function-module/order-summary', 'skill/monthly-order-summary'])
    expect((await readdir(join(service.store.directory, 'candidates', id))).sort()).toEqual(['candidate.json', 'functions', 'skills'])
    expect(await readFile(join(service.store.directory, 'candidates', id, 'skills', 'monthly-order-summary', 'SKILL.md'), 'utf8')).toBe(skillFile.content)
    expect(session.records.at(-1)).toMatchObject({ type: 'capability.propose', candidateId: id })
  })

  it('a draft is checked before anything is written, and a use before the latest try does not count', async () => {
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
    await tryTool!.handler(skill, session.context())
    session.turn = 2
    session.call('load_skill', { name: skill.name })
    expect(findUseProof(session.records, skill)).toMatchObject({ kind: 'skill', turn: 2 })
    await draft!.handler({ ...skill, files: [{ ...skillFile, content: skillFile.content.replace('Steps.', 'More steps.') }] }, session.context())
    await tryTool!.handler(skill, session.context())
    expect(findUseProof(session.records, skill)).toBe('it has no successful use since it was last tried')
  })
})

/** A past root task with one deliverable and the feedback on it; and the improvement job that answers it. */
async function feedbackJob(root: string, deliverableText: string, comment: string): Promise<string> {
  const layout = resolveWorkspaceLayout(root)
  const store = new JsonlSessionStore({ sessionsDir: layout.sessions })
  const sessionId = randomUUID()
  const deliverableId = randomUUID()
  const feedbackId = randomUUID()
  const lock = await store.create({ sessionId, projectRoot: root, model: 'claude-sonnet-5-5', sandboxMode: 'workspace-write' })
  await store.append(sessionId, { type: 'turn.start', turn: 1 })
  await store.append(sessionId, { type: 'user.message', turn: 1, content: 'Summarise the orders of the month.', source: 'user' })
  await store.append(sessionId, { type: 'deliverable.presented', turn: 1, step: 1, toolCallId: 'call-1', deliverable: { deliverableId, version: 1, title: 'Summary', summary: 'The month.', files: [{ path: 'out/summary.md', size: deliverableText.length, sha256: 'a'.repeat(64), mediaType: 'text/markdown' }] } })
  await store.append(sessionId, { type: 'turn.end', turn: 1, reason: { kind: 'completed' } })
  await store.append(sessionId, { type: 'turn.start', turn: 2 })
  await store.append(sessionId, { type: 'feedback', turn: 2, feedback: { id: feedbackId, deliverableId, version: 1, comment } })
  await store.append(sessionId, { type: 'user.message', turn: 2, content: comment, source: 'feedback' })
  await store.append(sessionId, { type: 'turn.end', turn: 2, reason: { kind: 'completed' } })
  await store.release(lock)
  await mkdir(join(layout.outputs, deliverableId, 'v1', 'files', 'out'), { recursive: true })
  await writeFile(join(layout.outputs, deliverableId, 'v1', 'files', 'out', 'summary.md'), deliverableText)
  const jobId = randomUUID()
  await mkdir(join(layout.dataDir, 'improvements', jobId), { recursive: true })
  await writeFile(join(layout.dataDir, 'improvements', jobId, 'job.json'), JSON.stringify({ formatVersion: 1, id: jobId, items: [{ kind: 'feedback', feedbackId, sessionId, deliverableId, at: '2026-10-14T08:00:00.000Z' }] }))
  return jobId
}

/** Another root task whose user message carries `text`. */
async function pastMessage(root: string, text: string): Promise<void> {
  const store = new JsonlSessionStore({ sessionsDir: resolveWorkspaceLayout(root).sessions })
  const sessionId = randomUUID()
  const lock = await store.create({ sessionId, projectRoot: root, model: 'claude-sonnet-5-5', sandboxMode: 'workspace-write' })
  await store.append(sessionId, { type: 'turn.start', turn: 1 })
  await store.append(sessionId, { type: 'user.message', turn: 1, content: text, source: 'user' })
  await store.append(sessionId, { type: 'turn.end', turn: 1, reason: { kind: 'completed' } })
  await store.release(lock)
}

describe('capability_propose in an improvement job: the instance-literal check (ADR 0013 decision 2)', () => {
  const policy = (instructions: string) => ({
    kind: 'context-policy',
    name: 'house-rules',
    files: [{ path: 'policy.json', content: JSON.stringify({ formatVersion: 1, name: 'house-rules', description: 'How this project wants summaries.', instructions }) }],
  })
  const ref = { kind: 'context-policy', name: 'house-rules' } as const

  /** Draft, try and use the policy in a propose session of `jobId`, then propose it. */
  async function propose(service: CapabilityService, jobId: string | undefined, instructions: string) {
    const session = new FakeSession()
    if (jobId !== undefined) session.push({ type: 'session.start', purpose: 'improvement', improvement: { jobId, phase: 'propose' } })
    const [draft, tryTool, proposeTool] = capabilityTools(service, session.read)
    await draft!.handler(policy(instructions), session.context())
    await tryTool!.handler(ref, session.context())
    session.turn = 2
    session.push({ type: 'turn.end', turn: 2, reason: { kind: 'completed' } })
    return proposeTool!.handler({ components: [ref] }, session.context())
  }

  it('refuses a policy carrying a value of the feedback task, lists the hit only, and accepts it once the value is gone', async () => {
    const root = await tempDir()
    const service = await boot(root)
    const jobId = await feedbackJob(root, '# Summary\n\nTotal: 2,384.13 USD over 41 orders (2026-09).\n', 'The total should use avg_order_value per region, not one figure.')
    const refused = await propose(service, jobId, 'Report the total as 2384.13 and use the avg_order_value column.').catch((error: unknown) => error)
    expect(refused).toMatchObject({ code: 'capability/instance-literal', message: expect.stringContaining('2384.13') })
    const hits = (refused as { details: { hits: { value: string; path: string; source: string }[] } }).details.hits
    expect(hits).toEqual([{ value: '2384.13', kind: 'decimal', path: 'context/house-rules/policy.json', source: expect.stringMatching(/^deliverable:[0-9a-f-]+\/v1\/out\/summary\.md$/) }])
    expect((refused as Error).message).not.toContain('avg_order_value')
    expect(await listCandidates(service.store.directory)).toEqual([])

    // A column name from the feedback is a convention, not a value: it passes.
    const accepted = await propose(service, jobId, 'Report the total with the avg_order_value column, per region.')
    expect(accepted.meta).toMatchObject({ candidateId: expect.any(String) })
  })

  it('a value given in two or more tasks of the project is a project constant; a user task is not checked', async () => {
    const root = await tempDir()
    const service = await boot(root)
    const jobId = await feedbackJob(root, 'Orders above 500 are large.\n', 'Flag the large orders.')
    await pastMessage(root, 'List the orders above 500.')
    await pastMessage(root, 'Count the orders above 500 per region.')
    expect((await propose(service, jobId, 'Orders above 500 are large; flag them.')).meta).toMatchObject({ candidateId: expect.any(String) })

    const other = await tempDir()
    const plain = await boot(other)
    expect((await propose(plain, undefined, 'Report the total as 2384.13.')).meta).toMatchObject({ candidateId: expect.any(String) })
  })
})
