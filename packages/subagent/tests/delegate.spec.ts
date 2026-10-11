/**
 * `delegate` in the real loop (scripted model; real session store,
 * workspace, tasking and context services): fresh and fork members, materials
 * by id, deliverables handed back to the parent, the failed / cancelled /
 * budget outcomes, presets and sandbox narrowing, input checks, and recovery
 * of runs left open.
 */
import { realpathSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as nodePath from 'node:path'
import { ContextPlugin } from '@nexgent/context'
import {
  createApp,
  MEMBER_DENIED_TOOLS,
  parseProjectConfig,
  renderMemberPromptLine,
  type Context,
  type LLMRequest,
  type MemberResult,
  type NexgentApp,
  type SessionRecord,
  type TaskingService,
  type Tool,
} from '@nexgent/kernel'
import { SessionPlugin } from '@nexgent/session'
import { TaskingPlugin } from '@nexgent/tasking'
import { scriptedProvider, type ScriptedProvider, type ScriptEntry } from '@nexgent/test-support'
import { WorkspacePlugin } from '@nexgent/workspace'
import { afterEach, describe, expect, it } from 'vitest'
import { closeInterruptedRuns, openRuns, runMemberTurn, startMember, SubagentPlugin } from '../src/index.js'

const apps: NexgentApp[] = []
const dirs: string[] = []
afterEach(async () => {
  while (apps.length > 0) await apps.pop()!.dispose()
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true, maxRetries: 5 })
})

async function tempRoot(): Promise<string> {
  const base = realpathSync.native(await mkdtemp(nodePath.join(tmpdir(), 'nxsub-')))
  dirs.push(base)
  return base
}

/** Route a request to its member's queue by the member line of its system prompt. */
function memberOf(request: LLMRequest): string | undefined {
  const system = request.messages.find(message => message.role === 'system')
  const text = typeof system?.content === 'string' ? system.content : ''
  return /^Member: ([a-z][a-z0-9-]*) \(/m.exec(text)?.[1]
}

interface Booted {
  readonly app: NexgentApp
  readonly llm: ScriptedProvider
  readonly root: string
  readonly tasking: TaskingService
  records(sessionId: string): Promise<readonly SessionRecord[]>
}

async function boot(root: string, script: ScriptEntry<LLMRequest>[], routes: Record<string, ScriptEntry<LLMRequest>[]> = {}): Promise<Booted> {
  const llm = scriptedProvider(script, { routes, routeKey: memberOf })
  const app = await createApp({
    patches: [{ id: 'workspace', config: { root } }],
    registry: {
      '@nexgent/llm': { name: 'scripted-llm', apply: (ctx: Context) => void ctx.provide('llm', llm) },
      '@nexgent/session': SessionPlugin,
      '@nexgent/workspace': WorkspacePlugin,
    },
  })
  apps.push(app)
  await app.ctx.plugin(TaskingPlugin)
  await app.ctx.plugin(ContextPlugin)
  await app.ctx.plugin(SubagentPlugin)
  return {
    app,
    llm,
    root,
    tasking: app.ctx.get('tasking') as TaskingService,
    records: async sessionId => (await app.ctx.session.readAll(sessionId)).records,
  }
}

async function writeProjectFile(root: string, path: string, content: string): Promise<void> {
  const target = nodePath.join(root, ...path.split('/'))
  await mkdir(nodePath.dirname(target), { recursive: true })
  await writeFile(target, content)
}

const delegate = (args: Record<string, unknown>, id = 'd1') => ({ toolCalls: [{ id, name: 'delegate', arguments: args }] })
const of = <T extends SessionRecord['type']>(records: readonly SessionRecord[], type: T) =>
  records.filter((r): r is Extract<SessionRecord, { type: T }> => r.type === type)
const conversationText = (request: LLMRequest) => JSON.stringify(request.messages.filter(message => message.role !== 'system'))

/** The parent's `tool.result` record of one call. */
function resultOf(records: readonly SessionRecord[], callId: string) {
  const record = of(records, 'tool.result').find(r => r.toolCallId === callId)
  if (record === undefined) throw new Error(`no tool.result for ${callId}`)
  return record
}

function requestsOf(llm: ScriptedProvider, route: string | undefined): LLMRequest[] {
  return llm.calls.filter(call => call.route === route).map(call => call.request)
}

describe('delegate: fresh', () => {
  it('runs a member with materials and files, hands its deliverable back, and the parent reads and presents its file', async () => {
    const root = await tempRoot()
    await writeProjectFile(root, 'data/orders.csv', 'id,qty\n1,3\n2,4\n')
    await writeProjectFile(root, 'incoming/regions.txt', 'north\nsouth\n')
    let materialId = ''
    const booted = await boot(root, [
      () => delegate({
        name: 'counter',
        task: 'Count the order quantities and write out/count.md.',
        files: ['data\\orders.csv'.replace(/\\/g, nodePath.sep), 'data/orders.csv'],
        expectedOutput: 'out/count.md with the total',
        materialIds: [materialId],
      }),
      { toolCalls: [{ id: 'r1', name: 'read_file', arguments: { path: 'out/count.md' } }] },
      { toolCalls: [{ id: 'p1', name: 'present', arguments: { paths: ['out/count.md'], summary: 'Total from the member.' } }] },
      { content: 'The total is 7.' },
    ], {
      counter: [
        { toolCalls: [{ id: 'w1', name: 'write_file', arguments: { path: 'out/count.md', content: 'total: 7\n' } }] },
        { toolCalls: [{ id: 'mp1', name: 'present', arguments: { paths: ['out/count.md'], summary: 'Order total.' } }] },
        { content: 'Wrote out/count.md: total 7.' },
      ],
    })
    const { app, llm, records, tasking } = booted
    materialId = (await tasking.materials.add({ sourcePath: nodePath.join(root, 'incoming', 'regions.txt') })).id
    const parent = await app.agents.create()
    const ended = await parent.run('How many items were ordered?')
    expect(ended.reason).toEqual({ kind: 'completed' })
    llm.assertConsumed()

    const parentRecords = await records(parent.sessionId)
    const [start] = of(parentRecords, 'subagent.start')
    const [end] = of(parentRecords, 'subagent.end')
    expect(start).toMatchObject({
      turn: 1, toolCallId: 'd1', childTurn: 1, name: 'counter', executionForm: 'delegated', mode: 'fresh', preset: 'general-executor',
      task: 'Count the order quantities and write out/count.md.', materialIds: [materialId],
    })
    const childId = start!.childSessionId
    const childRecords = await records(childId)
    expect(of(childRecords, 'session.start')[0]).toMatchObject({ parentSessionId: parent.sessionId, member: { name: 'counter', executionForm: 'delegated', preset: 'general-executor' } })

    // H02: the member's first request has the task, the files, the material reference, no parent history.
    const [first] = requestsOf(llm, 'counter')
    const firstText = conversationText(first!)
    expect(firstText).toContain('Count the order quantities')
    expect(firstText).toContain('Read these project files first:\\n- data/orders.csv')
    expect(firstText.match(/- data\/orders\.csv/g)).toHaveLength(1)
    expect(firstText).toContain('Expected output: out/count.md with the total')
    expect(firstText).toContain(materialId)
    expect(firstText).toContain('north')
    expect(firstText).not.toContain('How many items were ordered?')
    expect(first!.messages[0]!.content as string).toContain(renderMemberPromptLine({ name: 'counter', executionForm: 'delegated' }))
    // H15: members cannot start members.
    for (const name of MEMBER_DENIED_TOOLS) expect(first!.tools?.map(tool => tool.name)).not.toContain(name)
    expect(requestsOf(llm, undefined)[0]!.tools?.map(tool => tool.name)).toContain('delegate')

    // H04: the member's deliverable is in subagent.end and in the tool result; the parent read its file and presented it.
    expect(end).toMatchObject({ turn: 1, childSessionId: childId, childTurn: 1 })
    const result = end!.result
    expect(result).toMatchObject({ status: 'completed', text: 'Wrote out/count.md: total 7.', requestCount: 3 })
    expect(result.error).toBeUndefined()
    expect(result.deliverables).toHaveLength(1)
    expect(result.deliverables[0]).toMatchObject({ version: 1, summary: 'Order total.', memberName: 'counter', files: [{ path: 'out/count.md' }] })
    const delegated = resultOf(parentRecords, 'd1')
    expect(delegated.isError ?? false).toBe(false)
    expect(delegated.content).toContain('Member counter finished: completed')
    expect(delegated.content).toContain(`deliverable ${result.deliverables[0]!.deliverableId}, version 1): out/count.md`)
    expect(delegated.content).toContain('Final reply:\nWrote out/count.md: total 7.')
    expect(delegated.content).toContain('3 model request(s)')
    expect(delegated.meta).toMatchObject({ childSessionId: childId, name: 'counter', result: { status: 'completed' } })
    expect(resultOf(parentRecords, 'r1').content).toContain('total: 7')
    const presented = of(parentRecords, 'deliverable.presented')
    expect(presented).toHaveLength(1)
    expect(presented[0]!.deliverable.files.map(file => file.path)).toEqual(['out/count.md'])
    expect(presented[0]!.deliverable.deliverableId).not.toBe(result.deliverables[0]!.deliverableId)

    // The member session is closed (its own task.outcome written) and attributed to the same task.
    expect(app.agents.get(childId)).toBeUndefined()
    await parent.close()
  })
})

describe('delegate: fork', () => {
  it('starts the member from the parent history up to the previous turn, and it survives a resume', async () => {
    const root = await tempRoot()
    const { app, llm, records } = await boot(root, [
      { content: 'The budget is 40 units.' },
      delegate({ name: 'planner', task: 'Split the budget into two halves.', mode: 'fork', preset: 'read-only-analyst' }),
      { content: 'Done.' },
    ], {
      planner: [{ content: '20 and 20.' }],
    })
    const parent = await app.agents.create()
    await parent.run('What is the budget?')
    await parent.run('Plan the split.')

    const [request] = requestsOf(llm, 'planner')
    const seen = conversationText(request!)
    expect(seen).toContain('What is the budget?')
    expect(seen).toContain('The budget is 40 units.')
    expect(seen).not.toContain('Plan the split.')
    expect(seen).toContain('Split the budget into two halves.')

    const parentRecords = await records(parent.sessionId)
    const start = of(parentRecords, 'subagent.start')[0]!
    expect(start).toMatchObject({ turn: 2, mode: 'fork', preset: 'read-only-analyst' })
    expect(of(parentRecords, 'subagent.end')[0]!.result).toMatchObject({ status: 'completed', text: '20 and 20.' })
    const childRecords = await records(start.childSessionId)
    expect(of(childRecords, 'session.start')[0]).toMatchObject({ sandboxMode: 'read-only' })
    expect(of(childRecords, 'fork.seed')[0]).toMatchObject({ seq: 2, fromSessionId: parent.sessionId })
    expect(request!.messages[0]!.content as string).toContain('You are an analyst')

    // H03: the forked history is in the member's file; resuming the member under its parent keeps it.
    const member = await app.agents.resume(start.childSessionId, { child: { parentSessionId: parent.sessionId } })
    expect(JSON.stringify(member.history())).toContain('The budget is 40 units.')
    await member.close()
    await parent.close()
  })
})

describe('delegate: outcomes', () => {
  it('failed: a member whose model request fails returns a readable failed result', async () => {
    const root = await tempRoot()
    const { app, records } = await boot(root, [
      delegate({ name: 'broken', task: 'Try something.' }),
      { content: 'The member failed; stopping.' },
    ], { broken: [{ content: 'Starting', fault: 'http-500' }] })
    const parent = await app.agents.create()
    expect((await parent.run('go')).reason).toEqual({ kind: 'completed' })
    const parentRecords = await records(parent.sessionId)
    const result = of(parentRecords, 'subagent.end')[0]!.result
    expect(result.status).toBe('failed')
    expect(result.error?.code).toMatch(/^llm\//)
    const call = resultOf(parentRecords, 'd1')
    expect(call.isError).toBe(true)
    expect(call.content).toContain('Member broken finished: failed')
    expect(call.content).toContain(`Error: ${result.error!.code}`)
    await parent.close()
  })

  it('cancelled: cancelling the parent ends the member with cause parent and records a cancelled result', async () => {
    const root = await tempRoot()
    const { app, llm, records } = await boot(root, [delegate({ name: 'slow', task: 'Wait for a long time.' })], { slow: [{ fault: 'timeout' }] })
    const parent = await app.agents.create()
    const controller = new AbortController()
    const running = parent.run('go', { signal: controller.signal })
    while (!llm.calls.some(call => call.route === 'slow')) await new Promise(resolve => setTimeout(resolve, 10))
    controller.abort()
    expect((await running).reason).toEqual({ kind: 'cancelled', cause: 'user' })
    const parentRecords = await records(parent.sessionId)
    const end = of(parentRecords, 'subagent.end')[0]!
    expect(end.result).toMatchObject({ status: 'cancelled', error: { code: 'tool/aborted', details: { cause: 'parent' } } })
    const childEnd = of(await records(end.childSessionId), 'turn.end')[0]!
    expect(childEnd.reason).toEqual({ kind: 'cancelled', cause: 'parent' })
    await parent.close()
  })

  it('budget: a task-tree cap reached inside the member ends it with budget, and the parent is stopped too', async () => {
    const root = await tempRoot()
    await writeProjectFile(root, 'notes.md', 'hello\n')
    const { app, records } = await boot(root, [delegate({ name: 'spender', task: 'Read notes.md twice.' })], {
      spender: [
        { toolCalls: [{ id: 'm1', name: 'read_file', arguments: { path: 'notes.md' } }] },
        { content: 'never reached' },
      ],
    })
    const parent = await app.agents.create({ projectConfig: parseProjectConfig({ costCaps: { perTask: { maxRequests: 2 } } }) })
    const ended = await parent.run('go')
    expect(ended.reason).toEqual({ kind: 'cancelled', cause: 'cost-cap' })
    const parentRecords = await records(parent.sessionId)
    const result: MemberResult = of(parentRecords, 'subagent.end')[0]!.result
    expect(result).toMatchObject({ status: 'budget', requestCount: 1, error: { code: 'budget/exhausted', details: { scope: 'task', metric: 'requests', used: 2, limit: 2 } } })
    const call = resultOf(parentRecords, 'd1')
    expect(call.isError).toBe(true)
    expect(call.content).toContain('Member spender finished: budget')
    expect(call.content).toContain('budget/exhausted')
    await parent.close()
  })
})

describe('delegate: presets, sandbox and input checks', () => {
  it('a project preset wider than the parent is refused with sandbox/denied and nothing is recorded', async () => {
    const root = await tempRoot()
    await writeProjectFile(root, '.nexgent/presets/wide.json', JSON.stringify({ formatVersion: 1, name: 'wide', description: 'Too wide.', sandboxMode: 'full-access' }))
    const { app, records } = await boot(root, [delegate({ name: 'wide', task: 'x', preset: 'wide' }), { content: 'ok' }])
    const parent = await app.agents.create({ sandboxMode: 'workspace-write' })
    await parent.run('go')
    const parentRecords = await records(parent.sessionId)
    expect(of(parentRecords, 'subagent.start')).toEqual([])
    const call = resultOf(parentRecords, 'd1')
    expect(call.isError).toBe(true)
    expect(call.error?.code).toBe('sandbox/denied')
    expect(app.agents.membersOf(parent.sessionId)).toEqual([])
    await parent.close()
  })

  it('a preset deny list hides tools from the member; persona replaces the preset persona', async () => {
    const root = await tempRoot()
    await writeProjectFile(root, '.nexgent/presets/no-shell.json', JSON.stringify({ formatVersion: 1, name: 'no-shell', description: 'No shell.', tools: { deny: ['bash', 'pwsh'] } }))
    const { app, llm } = await boot(root, [delegate({ name: 'quiet', task: 'x', preset: 'no-shell', persona: 'You are a careful proofreader.' }), { content: 'ok' }], {
      quiet: [{ content: 'fine' }],
    })
    const parent = await app.agents.create()
    await parent.run('go')
    const [request] = requestsOf(llm, 'quiet')
    expect(request!.tools?.map(tool => tool.name)).not.toContain('bash')
    expect(request!.tools?.map(tool => tool.name)).toContain('read_file')
    expect((request!.messages[0]!.content as string).startsWith('You are a careful proofreader.')).toBe(true)
    await parent.close()
  })

  it.each([
    [{ name: 'Bad Name', task: 'x' }, 'tool/invalid-input', /name/],
    [{ name: 'ok', task: 'x', preset: 'missing' }, 'tool/invalid-input', /unknown preset "missing"; available: read-only-analyst/],
    [{ name: 'ok', task: 'x', materialIds: ['no-such-material'] }, 'tool/invalid-input', /unknown or removed material ids: no-such-material/],
    [{ name: 'ok', task: 'x', files: ['../outside.txt'] }, 'tool/invalid-input', /not a path inside the project/],
    [{ name: 'ok', task: 'x', files: ['missing.txt'] }, 'tool/invalid-input', /files not found in the project: missing.txt/],
  ])('refuses %j before starting a member', async (args, code, message) => {
    const root = await tempRoot()
    const { app, records } = await boot(root, [delegate(args), { content: 'ok' }])
    const parent = await app.agents.create()
    await parent.run('go')
    const parentRecords = await records(parent.sessionId)
    const call = resultOf(parentRecords, 'd1')
    expect(call.isError).toBe(true)
    expect(call.error?.code).toBe(code)
    expect(call.content).toMatch(message)
    expect(of(parentRecords, 'subagent.start')).toEqual([])
    await parent.close()
  })

  it('the handler refuses a call from a member even if the tool were visible', async () => {
    const root = await tempRoot()
    const { app } = await boot(root, [])
    const tool = app.ctx.tools.get('delegate') as Tool
    await expect(tool.handler({ name: 'x', task: 'y' }, {
      sessionId: 's', callId: 'c', turn: 1, workspace: app.ctx.workspace, sandboxMode: 'workspace-write', signal: new AbortController().signal,
      approved: false, requestApproval: async () => false, member: { name: 'm', executionForm: 'delegated' },
    })).rejects.toMatchObject({ code: 'tool/denied' })
  })
})

describe('recovery and the runner', () => {
  it('closeInterruptedRuns writes subagent.end interrupted for a run without one, from the member session', async () => {
    const root = await tempRoot()
    const { app, records } = await boot(root, [{ toolCalls: [{ id: 'h1', name: 'half' }] }, { content: 'parent done' }], {
      half: [{ content: 'partial answer' }],
    })
    // A tool that records the start and runs the member, then "dies" before recording the end.
    app.ctx.tools.register({
      definition: { name: 'half', description: 'Half a delegation.', inputSchema: { type: 'object', properties: {} }, effects: ['read'], approval: 'never' },
      handler: async (_input, context) => {
        const member = await startMember({ agents: app.agents, parentSessionId: context.sessionId, name: 'half', executionForm: 'delegated' })
        await (context as { appendRecord: (r: unknown) => Promise<void> }).appendRecord({
          type: 'subagent.start', turn: context.turn, toolCallId: context.callId, childSessionId: member.sessionId, childTurn: 1, name: 'half', executionForm: 'delegated', task: 'half',
        })
        const { result } = await runMemberTurn(member, { text: 'answer partly' })
        expect(result.status).toBe('completed')
        await member.close()
        return { content: 'lost' }
      },
    })
    const parent = await app.agents.create()
    await parent.run('go')
    expect(openRuns(await records(parent.sessionId))).toHaveLength(1)
    const written = await closeInterruptedRuns(parent, app.ctx.session)
    expect(written).toHaveLength(1)
    expect(written[0]).toMatchObject({ type: 'subagent.end', turn: 1, childTurn: 1, result: { status: 'interrupted', text: 'partial answer', requestCount: 1, error: { code: 'internal' } } })
    expect(openRuns(await records(parent.sessionId))).toEqual([])
    expect(await closeInterruptedRuns(parent, app.ctx.session)).toEqual([])
    await parent.close()
  })
})
