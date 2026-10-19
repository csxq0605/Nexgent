/**
 * Step 3 child sessions (ADR 0004, `permissions.md` §子会话继承): members
 * started with `ctx.agents.create({ child })`, their attribution, the task
 * tree's cost cap, cancel propagation, member approvals and the widened
 * tool / host record types.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  MEMBER_DENIED_TOOLS,
  parseProjectConfig,
  renderMemberPromptLine,
  type Agent,
  type ApprovalRequest,
  type ChildAgentOptions,
  type KernelToolContext,
  type LLMRequest,
  type LLMStreamEvent,
  type Tool,
  type ToolContext,
} from '../src/index.js'
import { conversation, sleep, textReply, toolCallReply, usage } from './helpers/fakes.js'
import { bootHarness, type Harness } from './helpers/harness.js'

let harness: Harness | undefined
afterEach(async () => {
  await harness?.dispose()
  harness = undefined
})

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function plainTool(name: string, approval: 'never' | 'ask' = 'never', effects: ('read' | 'write')[] = ['read']): Tool {
  return {
    definition: { name, description: `${name} tool.`, inputSchema: { type: 'object', properties: {} }, effects, approval },
    handler: async () => ({ content: `${name} ran` }),
  }
}

/**
 * A minimal `delegate`: runs one member turn in the foreground, recording
 * `subagent.start` / `subagent.end` through the tool context.
 */
function delegateTool(app: Harness['app'], options: Partial<ChildAgentOptions> = {}, seen: { child?: Agent; context?: ToolContext } = {}): Tool {
  return {
    definition: {
      name: 'delegate',
      description: 'Delegate a sub-task.',
      inputSchema: { type: 'object', properties: { task: { type: 'string' } } },
      effects: ['read'],
      approval: 'never',
    },
    handler: async (input, context) => {
      const ctx = context as KernelToolContext
      seen.context = context
      const child = await app.agents.create({
        child: { parentSessionId: context.sessionId, member: { name: 'helper', executionForm: 'delegated' }, ...options },
      })
      seen.child = child
      const task = (input as { task?: string }).task ?? 'do it'
      await ctx.appendRecord({ type: 'subagent.start', turn: ctx.turn, toolCallId: ctx.callId, childSessionId: child.sessionId, childTurn: 1, name: 'helper', executionForm: 'delegated', task })
      const result = await child.run(task, { signal: context.signal })
      await ctx.appendRecord({
        type: 'subagent.end',
        turn: ctx.turn,
        childSessionId: child.sessionId,
        childTurn: result.turn,
        result: { status: result.reason.kind === 'completed' ? 'completed' : 'cancelled', text: result.text, deliverables: [], usage: result.usage, requestCount: 1 },
      })
      await child.close()
      return { content: `member said: ${result.text}` }
    },
  }
}

describe('child sessions', () => {
  it('starts a fresh member under an open root: header, attribution, prompt line, narrowed tools and preset', async () => {
    harness = await bootHarness({ script: [toolCallReply('c1', 'delegate', { task: 'count rows' }), textReply('42 rows'), textReply('done')] })
    const { app, llm, store, ledger } = harness
    for (const name of ['read_file', 'bash', 'present', ...MEMBER_DENIED_TOOLS.filter(name => name !== 'delegate')]) app.ctx.tools.register(plainTool(name))
    const seen: { child?: Agent; context?: ToolContext } = {}
    app.ctx.tools.register(delegateTool(app, {
      preset: { name: 'counter', description: 'Counts.', persona: 'You count rows carefully.', tools: { deny: ['bash'] }, effort: 'low', thinking: 'off', model: 'member-model' },
    }, seen))
    const root = await app.agents.create()
    const result = await root.run('how many rows?')
    expect(result.reason).toEqual({ kind: 'completed' })
    const child = seen.child!

    const start = store.of(child.sessionId, 'session.start')[0]!
    expect(start).toMatchObject({ parentSessionId: root.sessionId, member: { name: 'helper', executionForm: 'delegated', preset: 'counter' }, model: 'member-model' })
    expect(child.parentSessionId).toBe(root.sessionId)
    expect(root.attribution).toEqual({ taskId: expect.stringMatching(UUID_V4), memberId: 'main', executionForm: 'direct' })
    expect(child.attribution).toEqual({ taskId: root.attribution.taskId, memberId: child.sessionId, executionForm: 'delegated' })
    expect(seen.context?.attribution).toEqual(root.attribution)
    expect(seen.context?.member).toBeUndefined()

    // Request 2 is the member's: its own prompt, no parent history, narrowed tools, preset parameters.
    const member = llm.requests[1]!
    const system = member.messages[0]!.content as string
    expect(system.startsWith('You count rows carefully.')).toBe(true)
    expect(system.split('\n')).toContain(renderMemberPromptLine({ name: 'helper', executionForm: 'delegated' }))
    expect(system).not.toContain('# Working with others')
    expect(conversation(member)).toEqual([{ role: 'user', content: 'count rows' }])
    expect(member.tools?.map(tool => tool.name).sort()).toEqual(['present', 'read_file'])
    expect(member).toMatchObject({ model: 'member-model', effort: 'low', thinking: 'off' })
    expect(llm.options[1]).toMatchObject({ sessionId: child.sessionId, ...child.attribution })
    // The root sees delegate and the form-choice principles; it has no member line.
    const rootSystem = llm.requests[0]!.messages[0]!.content as string
    expect(rootSystem).toContain('# Working with others')
    expect(rootSystem).not.toContain('Member: ')

    // Parent records of the run, in the delegate call's turn.
    expect(store.of(root.sessionId, 'subagent.start')[0]).toMatchObject({ turn: 1, toolCallId: 'c1', childSessionId: child.sessionId })
    expect(store.of(root.sessionId, 'subagent.end')[0]).toMatchObject({ turn: 1, childSessionId: child.sessionId, result: { status: 'completed', text: '42 rows' } })

    await root.close()
    // Ledger: every request, tool call and outcome attributed; the member's outcome is its own; the root's lists the forms.
    for (const record of ledger.records) expect(record).toMatchObject({ taskId: root.attribution.taskId })
    const outcomes = ledger.of('task.outcome')
    expect(outcomes.map(outcome => [outcome.sessionId, outcome.memberId, outcome.executionForm, outcome.formsUsed])).toEqual([
      [child.sessionId, child.sessionId, 'delegated', undefined],
      [root.sessionId, 'main', 'direct', ['direct', 'delegated']],
    ])
    expect(ledger.of('tool.call')[0]).toMatchObject({ name: 'delegate', memberId: 'main', executionForm: 'direct' })
  })

  it('forks the parent history, the current turn so far included, into fork.seed (seq 2; rework K4)', async () => {
    harness = await bootHarness({
      script: [textReply('first answer'), toolCallReply('c1', 'delegate', { task: 'go on' }), textReply('member done'), textReply('all done')],
    })
    const { app, llm, store } = harness
    const seen: { child?: Agent } = {}
    app.ctx.tools.register(delegateTool(app, { mode: 'fork' }, seen))
    const root = await app.agents.create()
    await root.run('turn one')
    await root.run('turn two')
    const child = seen.child!
    const seed = store.of(child.sessionId, 'fork.seed')[0]!
    const rootEnd = store.of(root.sessionId, 'turn.end')[0]!
    expect(seed).toMatchObject({ seq: 2, fromSessionId: root.sessionId })
    expect(seed.throughSeq).toBeGreaterThan(rootEnd.seq)
    // The reply whose delegate call is still running keeps no calls; with no text it gets a placeholder.
    expect(seed.messages).toEqual([
      { role: 'user', content: 'turn one' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'turn two' },
      { role: 'assistant', content: '(Handing a sub-task to a member.)' },
    ])
    expect(conversation(llm.requests[2]!)).toEqual([...seed.messages, { role: 'user', content: 'go on' }])
    await root.close()
  })

  it('refuses a member as parent, a parent that is not open, and a sandbox wider than the parent', async () => {
    harness = await bootHarness()
    const { app } = harness
    const root = await app.agents.create({ sandboxMode: 'workspace-write' })
    const member = { name: 'helper', executionForm: 'delegated' } as const
    const child = await app.agents.create({ child: { parentSessionId: root.sessionId, member, sandboxMode: 'read-only' } })
    expect(child.sandboxMode).toBe('read-only')
    await expect(app.agents.create({ child: { parentSessionId: child.sessionId, member } })).rejects.toMatchObject({ code: 'tool/denied' })
    await expect(app.agents.create({ child: { parentSessionId: '00000000-0000-4000-8000-000000000000', member } })).rejects.toMatchObject({ code: 'session/not-found' })
    await expect(app.agents.create({ child: { parentSessionId: root.sessionId, member, sandboxMode: 'full-access' } })).rejects.toMatchObject({ code: 'sandbox/denied' })
    await expect(app.agents.create({
      child: { parentSessionId: root.sessionId, member, preset: { name: 'wide', description: 'Too wide.', sandboxMode: 'full-access' } },
    })).rejects.toMatchObject({ code: 'sandbox/denied' })
    await expect(app.agents.create({ child: { parentSessionId: root.sessionId, member: { name: 'Bad Name', executionForm: 'delegated' } } })).rejects.toMatchObject({ code: 'tool/invalid-input' })
    // Closing the parent closes its members.
    await root.close()
    expect(child.isClosed).toBe(true)
  })

  it('keeps the parent restrictions on a member, also ones added later', async () => {
    harness = await bootHarness()
    const { app } = harness
    for (const name of ['read_file', 'bash', 'grep']) app.ctx.tools.register(plainTool(name))
    const root = await app.agents.create()
    root.ctx.tools.restrict({ deny: ['bash'] })
    const child = await app.agents.create({ child: { parentSessionId: root.sessionId, member: { name: 'helper', executionForm: 'delegated' } } })
    const names = () => child.ctx.tools.list().map(tool => tool.name)
    expect(names()).toEqual(['read_file', 'grep'])
    root.ctx.tools.restrict({ allow: ['read_file', 'bash'] })
    expect(names()).toEqual(['read_file'])
    await root.close()
  })

  it('resumes a member only under its open parent, in the parent task tree', async () => {
    harness = await bootHarness({ script: [textReply('hi'), textReply('again')] })
    const { app } = harness
    const root = await app.agents.create()
    const child = await app.agents.create({ child: { parentSessionId: root.sessionId, member: { name: 'mate', executionForm: 'team' } } })
    await child.run('first')
    await child.close()
    await expect(app.agents.resume(child.sessionId)).rejects.toMatchObject({ code: 'tool/denied' })
    const other = await app.agents.create()
    await expect(app.agents.resume(child.sessionId, { child: { parentSessionId: other.sessionId } })).rejects.toMatchObject({ code: 'tool/denied' })
    await expect(app.agents.resume(root.sessionId, { child: { parentSessionId: other.sessionId } })).rejects.toMatchObject({ code: 'session/locked' })
    const again = await app.agents.resume(child.sessionId, { child: { parentSessionId: root.sessionId } })
    expect(again.attribution).toEqual({ taskId: root.attribution.taskId, memberId: child.sessionId, executionForm: 'team' })
    expect(again.history().map(message => message.content)).toEqual(['first', 'hi'])
    await again.run('second')
    expect(again.turn).toBe(2)
    await root.close()
    await other.close()
    expect(again.isClosed).toBe(true)
  })

  it('counts a member reopened under a reopened root in that tree\'s formsUsed', async () => {
    harness = await bootHarness({ script: [textReply('hi'), textReply('again'), textReply('lead done')] })
    const { app, ledger } = harness
    const root = await app.agents.create()
    const child = await app.agents.create({ child: { parentSessionId: root.sessionId, member: { name: 'mate', executionForm: 'team' } } })
    await child.run('first')
    await root.close({ skipOutcome: true })
    // After a restart: a new tree for the root; the teammate is resumed, not created.
    const reopened = await app.agents.resume(root.sessionId)
    expect(reopened.formsUsed()).toEqual(['direct'])
    const again = await app.agents.resume(child.sessionId, { child: { parentSessionId: root.sessionId } })
    expect(reopened.formsUsed()).toEqual(['direct', 'team'])
    await again.run('second')
    await reopened.run('wrap up')
    await reopened.close()
    const outcomes = ledger.of('task.outcome').filter(outcome => outcome.memberId === 'main')
    expect(outcomes.map(outcome => [outcome.taskId, outcome.formsUsed])).toEqual([[reopened.attribution.taskId, ['direct', 'team']]])
    expect(reopened.attribution.taskId).not.toBe(root.attribution.taskId)
  })

  it('counts members against the root perTask cap and a member against its share', async () => {
    harness = await bootHarness({
      script: [
        toolCallReply('c1', 'delegate', { task: 'work' }, '', usage(10, 5)),
        toolCallReply('m1', 'probe', {}, '', usage(10, 5)),
        textReply('member done', usage(10, 5)),
      ],
    })
    const { app, llm, store, ledger } = harness
    app.ctx.tools.register(plainTool('probe'))
    const seen: { child?: Agent } = {}
    app.ctx.tools.register(delegateTool(app, {}, seen))
    const root = await app.agents.create({ projectConfig: parseProjectConfig({ costCaps: { perTask: { maxRequests: 3 } } }) })
    const result = await root.run('go')
    // Root 1 request + member 2 requests = 3: the root's next request is not sent.
    expect(llm.requests).toHaveLength(3)
    expect(result.reason).toEqual({ kind: 'cancelled', cause: 'cost-cap' })
    expect(store.of(root.sessionId, 'error')[0]!.error).toMatchObject({ code: 'budget/exhausted', details: { scope: 'task', metric: 'requests', used: 3, limit: 3 } })
    const outcome = ledger.of('task.outcome').find(record => record.sessionId === root.sessionId)!
    expect(outcome).toMatchObject({ status: 'cancelled', memberId: 'main', formsUsed: ['direct', 'delegated'], error: { code: 'budget/exhausted' } })
    await root.close()

    // A share stops the member itself after its first request.
    llm.push(toolCallReply('c2', 'delegate', { task: 'work' }), toolCallReply('m2', 'probe', {}), textReply('root done'))
    const second = await app.agents.create()
    app.ctx.tools.unregister('delegate')
    app.ctx.tools.register(delegateTool(app, { budget: { maxRequests: 1 } }, seen))
    const ended = await second.run('go')
    expect(ended.reason).toEqual({ kind: 'completed' })
    const memberEnd = store.of(seen.child!.sessionId, 'turn.end')[0]!
    expect(memberEnd.reason).toEqual({ kind: 'cancelled', cause: 'cost-cap' })
    await second.close()
  })

  it('cancels running members with cause parent when the parent turn is cancelled', async () => {
    const hang = (request: LLMRequest): AsyncIterable<LLMStreamEvent> => (async function* () {
      await sleep(10_000, request.signal)
      yield { type: 'done', finishReason: 'aborted' } as LLMStreamEvent
    })()
    harness = await bootHarness({ script: [toolCallReply('c1', 'delegate', { task: 'slow' }), hang] })
    const { app, store } = harness
    const seen: { child?: Agent } = {}
    app.ctx.tools.register(delegateTool(app, {}, seen))
    const root = await app.agents.create()
    const controller = new AbortController()
    const running = root.run('go', { signal: controller.signal })
    while (seen.child === undefined || !seen.child.busy) await sleep(5)
    const started = Date.now()
    controller.abort()
    const result = await running
    expect(result.reason).toEqual({ kind: 'cancelled', cause: 'user' })
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(store.of(seen.child.sessionId, 'turn.end')[0]!.reason).toEqual({ kind: 'cancelled', cause: 'parent' })
    await root.close()
  })

  it('at turn end cancels background members with cause parent and waits for held work before turn.end', async () => {
    const hang = (request: LLMRequest): AsyncIterable<LLMStreamEvent> => (async function* () {
      await sleep(10_000, request.signal)
      yield { type: 'done', finishReason: 'aborted' } as LLMStreamEvent
    })()
    // Lead and teammate requests interleave: route by the member line.
    const route = (request: LLMRequest): AsyncIterable<LLMStreamEvent> => (request.messages[0]!.content as string).includes('Member: mate')
      ? hang(request)
      : (async function* () { yield* textReply('lead done') })()
    harness = await bootHarness({ script: [toolCallReply('c1', 'spawn', {}), route, route] })
    const { app, store } = harness
    let mate: Agent | undefined
    app.ctx.tools.register({
      definition: { name: 'spawn', description: 'Spawn a teammate.', inputSchema: { type: 'object', properties: {} }, effects: ['read'], approval: 'never' },
      handler: async (_input, context) => {
        const lead = app.agents.get(context.sessionId)!
        mate = await app.agents.create({ child: { parentSessionId: lead.sessionId, member: { name: 'mate', executionForm: 'team' } } })
        const ctx = context as KernelToolContext
        await ctx.appendRecord({ type: 'team.member', member: { name: 'mate', sessionId: mate.sessionId, status: 'active' } })
        const child = mate
        lead.holdTurn(child.run('background work').then(async result => {
          await lead.appendHostRecord({
            type: 'subagent.end',
            turn: lead.turn,
            childSessionId: child.sessionId,
            childTurn: result.turn,
            result: { status: 'cancelled', text: result.text, deliverables: [], usage: result.usage, requestCount: 1 },
          })
        }))
        return { content: 'spawned' }
      },
    })
    const lead = await app.agents.create()
    const result = await lead.run('lead')
    expect(result.reason).toEqual({ kind: 'completed' })
    expect(store.of(mate!.sessionId, 'turn.end')[0]!.reason).toEqual({ kind: 'cancelled', cause: 'parent' })
    const types = store.types(lead.sessionId)
    expect(types.indexOf('subagent.end')).toBeLessThan(types.indexOf('turn.end'))
    expect(store.of(lead.sessionId, 'team.member')[0]).toMatchObject({ turn: 1, member: { name: 'mate' } })
    expect(() => lead.holdTurn(Promise.resolve())).toThrow(/no running turn/)
    await lead.close()
  })

  it('asks member approvals under the main rules, naming the member and its root', async () => {
    harness = await bootHarness({ script: [toolCallReply('w1', 'write_file', {}), textReply('written')] })
    const { app, store } = harness
    app.ctx.tools.register(plainTool('write_file', 'ask', ['write']))
    const seen: ApprovalRequest[] = []
    app.ctx.approvals.setResponder(async request => {
      seen.push(request)
      return { id: request.id, decision: 'allow', scope: 'project', decidedBy: 'user' }
    })
    app.agents.setProjectGrantWriter(async () => undefined)
    const root = await app.agents.create()
    const child = await app.agents.create({ child: { parentSessionId: root.sessionId, member: { name: 'writer', executionForm: 'workflow' } } })
    await child.run('write it')
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ sessionId: child.sessionId, tool: 'write_file', member: { name: 'writer', executionForm: 'workflow', parentSessionId: root.sessionId } })
    expect(store.of(child.sessionId, 'approval.request')[0]!.request.member).toEqual(seen[0]!.member)
    // A project grant a member obtained applies to the root of the same tree.
    harness.llm.push(toolCallReply('w2', 'write_file', {}), textReply('ok'))
    await root.run('write too')
    expect(seen).toHaveLength(1)
    await root.close()
  })

  it('accepts the step-3 tool records from a call and checks turn and toolCallId', async () => {
    harness = await bootHarness({ script: [toolCallReply('c1', 'recorder', {}), textReply('done')] })
    const { app, store } = harness
    const outcomes: string[] = []
    app.ctx.tools.register({
      definition: { name: 'recorder', description: 'Records.', inputSchema: { type: 'object', properties: {} }, effects: ['read'], approval: 'never' },
      handler: async (_input, context) => {
        const ctx = context as KernelToolContext
        const id = '11111111-1111-4111-8111-111111111111'
        await ctx.appendRecord({ type: 'workflow.start', turn: ctx.turn, toolCallId: ctx.callId, workflowId: id, kind: 'script' })
        await ctx.appendRecord({ type: 'workflow.phase', turn: ctx.turn, workflowId: id, phase: 'one' })
        await ctx.appendRecord({ type: 'team.task', task: { id: 't1', title: 'T', status: 'pending', dependsOn: [] } })
        try {
          await ctx.appendRecord({ type: 'workflow.start', turn: ctx.turn, toolCallId: 'other', workflowId: id, kind: 'graph' })
        } catch (error) {
          outcomes.push((error as { code: string }).code)
        }
        return { content: 'ok' }
      },
    })
    const agent = await app.agents.create()
    await agent.run('record')
    expect(outcomes).toEqual(['session/invalid-record'])
    expect(store.of(agent.sessionId, 'workflow.start')).toHaveLength(1)
    expect(store.of(agent.sessionId, 'workflow.phase')[0]).toMatchObject({ turn: 1, phase: 'one' })
    expect(store.of(agent.sessionId, 'team.task')[0]).toMatchObject({ turn: 1, task: { id: 't1' } })
    // The refused record fails the call even though the tool caught it.
    expect(store.of(agent.sessionId, 'tool.result')[0]).toMatchObject({ isError: true, error: { code: 'tool/failed' } })
    // Host records: the collaboration types are accepted between turns too.
    const written = await agent.appendHostRecord({ type: 'team.message', message: { id: '22222222-2222-4222-8222-222222222222', from: 'lead', to: 'mate', text: 'hi', state: 'queued' } })
    expect(written).toMatchObject({ type: 'team.message' })
    // Recovery closes a run of an earlier turn between turns; a future turn or a step-2 type with a past turn is refused.
    const end = { type: 'subagent.end' as const, childSessionId: 'c', childTurn: 1, result: { status: 'interrupted' as const, text: '', deliverables: [], usage: usage(0, 0), requestCount: 0, error: { name: 'NexgentError', code: 'internal' as const, message: 'interrupted' } } }
    expect(await agent.appendHostRecord({ ...end, turn: 1 })).toMatchObject({ type: 'subagent.end', turn: 1 })
    await expect(agent.appendHostRecord({ ...end, turn: 2 })).rejects.toMatchObject({ code: 'session/invalid-record' })
    await expect(agent.appendHostRecord({ type: 'goal.update', turn: 1, goalId: 'g', status: 'completed' })).rejects.toMatchObject({ code: 'session/invalid-record' })
    await agent.close()
  })
})
