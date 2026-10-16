/**
 * Step-2 agent loop hooks (docs/spec/agent-hooks.md): context providers,
 * compaction, the turn file tracker, tool records and host records.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  renderCompactionSummary,
  renderFeedbackPrompt,
  renderSystemPrompt,
  type CompactionCheckInput,
  type CompactionResult,
  type Compactor,
  type ContextProvider,
  type ContextService,
  type FileChange,
  type KernelToolContext,
  type TaskingService,
  type Tool,
  type ToolCallObservation,
  type TurnContextInput,
  type TurnFileTracker,
} from '../src/index.js'
import { conversation, servicePlugin, sleep, textReply, toolCallReply, usage } from './helpers/fakes.js'
import { bootHarness, type Harness } from './helpers/harness.js'

let harness: Harness | undefined
afterEach(async () => {
  await harness?.dispose()
  harness = undefined
})

function contextService(providers: ContextProvider[], compactor?: Compactor): ContextService {
  return {
    providers,
    register: provider => {
      providers.push(provider)
      return () => undefined
    },
    ...(compactor === undefined ? {} : { compactor }),
  }
}

class FakeTracker implements TurnFileTracker {
  readonly calls: string[] = []
  readonly observed: ToolCallObservation[] = []
  endSignal: AbortSignal | undefined
  changes: FileChange[] = []
  failEnd = false
  failObserve = false
  endDelayMs = 0

  async beginTurn(sessionId: string, turn: number): Promise<void> {
    this.calls.push(`begin:${turn}`)
  }

  observe(observation: ToolCallObservation): void {
    this.observed.push(observation)
    if (this.failObserve) throw new Error('observe broke')
  }

  async endTurn(sessionId: string, turn: number, signal?: AbortSignal): Promise<readonly FileChange[]> {
    this.calls.push(`end:${turn}`)
    this.endSignal = signal
    if (this.endDelayMs > 0) await sleep(this.endDelayMs, signal)
    if (this.failEnd) throw new Error('scan failed')
    return this.changes
  }
}

function tasking(files: TurnFileTracker, materials: unknown[] = []): TaskingService {
  return { files, materials: { list: async () => materials } } as unknown as TaskingService
}

const echo: Tool = {
  definition: {
    name: 'echo',
    description: 'Echo the text back.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
    effects: ['read'],
    approval: 'never',
  },
  handler: async input => ({ content: `echo: ${(input as { text: string }).text}`, meta: { paths: ['a.txt'] } }),
}

const deliverable = { deliverableId: 'd1', version: 1, title: 'report', summary: 'the report', files: [] }

describe('context providers', () => {
  it('render sections in provider then id order, write injections before the user message, and keep the prompt stable within a turn', async () => {
    harness = await bootHarness({ script: [toolCallReply('c1', 'echo', { text: 'x' }), textReply('done')] })
    const { app, llm, store } = harness
    app.ctx.tools.register(echo)
    const seen: TurnContextInput[] = []
    const providers: ContextProvider[] = [
      {
        id: 'first',
        beginTurn: async input => {
          seen.push(input)
          return { systemSections: [{ id: 'b', title: 'Second', body: 'two' }, { id: 'a', title: 'First', body: 'one' }], inject: ['note A'] }
        },
      },
      { id: 'second', beginTurn: async () => ({ systemSections: [{ id: 'a', title: 'Third', body: 'three' }], inject: ['note B'] }) },
    ]
    await app.ctx.plugin(servicePlugin('context', contextService(providers)))
    const agent = await app.agents.create()
    const result = await agent.run({ text: 'hello', materialIds: ['m1'] })
    expect(result.reason).toEqual({ kind: 'completed' })

    expect(store.types(agent.sessionId)).toEqual([
      'session.start', 'turn.start', 'user.message', 'user.message', 'user.message',
      'assistant.message', 'tool.result', 'assistant.message', 'turn.end',
    ])
    const messages = store.of(agent.sessionId, 'user.message')
    expect(messages.map(record => [record.source, record.content])).toEqual([['inject', 'note A'], ['inject', 'note B'], ['user', 'hello']])
    expect(messages[2]!.materials).toEqual(['m1'])
    expect(seen[0]).toMatchObject({ sessionId: agent.sessionId, turn: 1, text: 'hello', source: 'user', materialIds: ['m1'], projectRoot: harness.workspace.root })
    // state as of before the turn: read while no turn was open, so no turn was closed as interrupted
    expect(seen[0]!.state.metadata.openTurn).toBeUndefined()
    expect(seen[0]!.state.metadata.lastTurn).toBe(0)
    expect(store.of(agent.sessionId, 'turn.end').map(record => record.reason.kind)).toEqual(['completed'])

    const prompt = llm.requests[0]!.messages[0]!.content as string
    expect(llm.requests[1]!.messages[0]!.content).toBe(prompt)
    const order = ['# Environment', '# Tools', '# First\none', '# Second\ntwo', '# Third\nthree', 'Your project working directory is']
    const positions = order.map(text => prompt.indexOf(text))
    expect(positions.every(position => position >= 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
    expect(conversation(llm.requests[0]!)).toEqual([
      { role: 'user', content: 'note A' },
      { role: 'user', content: 'note B' },
      { role: 'user', content: 'hello' },
    ])
    // sections live only for the turn
    expect(agent.systemPrompt()).not.toContain('# First')
    await agent.close()
  })

  it('skips a provider that throws, with a non-fatal error record, and completes the turn', async () => {
    harness = await bootHarness({ script: [textReply('ok')] })
    const { app, llm, store } = harness
    const providers: ContextProvider[] = [
      { id: 'broken', beginTurn: async () => { throw new Error('boom') } },
      { id: 'fine', beginTurn: async () => ({ systemSections: [{ id: 'x', title: 'Fine', body: 'yes' }] }) },
    ]
    await app.ctx.plugin(servicePlugin('context', contextService(providers)))
    const agent = await app.agents.create()
    const result = await agent.run('hi')
    expect(result.reason).toEqual({ kind: 'completed' })
    const errors = store.of(agent.sessionId, 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ turn: 1, fatal: false, error: { code: 'internal' } })
    expect(errors[0]!.error.message).toContain('"broken"')
    expect(llm.requests[0]!.messages[0]!.content).toContain('# Fine\nyes')
    await agent.close()
  })
})

describe('compaction', () => {
  function compactor(threshold: number, behaviour: { fail?: boolean } = {}): Compactor & { checks: CompactionCheckInput[]; compacts: number } {
    const self = {
      checks: [] as CompactionCheckInput[],
      compacts: 0,
      shouldCompact(input: CompactionCheckInput): boolean {
        self.checks.push(input)
        const used = input.lastUsage?.inputTokens
        return typeof used === 'number' && used >= threshold
      },
      async compact(input: CompactionCheckInput): Promise<CompactionResult> {
        self.compacts += 1
        if (behaviour.fail === true) throw new Error('summary request failed')
        // keep from the last user message on
        const last = input.messages.map(message => message.role).lastIndexOf('user')
        return {
          summary: 'earlier work',
          keepMessages: input.messages.length - last,
          compactedMessages: last,
          requestId: 'aux-1',
          usage: usage(50, 10),
          trigger: { inputTokens: 1000, threshold },
        }
      },
    }
    return self
  }

  it('replaces the history with the summary and the kept tail before the next request, and resume rebuilds the same history', async () => {
    harness = await bootHarness({
      script: [textReply('first', usage(1000, 5)), toolCallReply('c1', 'echo', { text: 'x' }, '', usage(10, 5)), textReply('second')],
    })
    const { app, llm, store } = harness
    app.ctx.tools.register(echo)
    const fake = compactor(500)
    await app.ctx.plugin(servicePlugin('context', contextService([], fake)))
    const agent = await app.agents.create()
    await agent.run('turn one')
    expect(fake.checks[0]!.lastUsage).toBeUndefined()
    await agent.run('turn two')

    expect(fake.compacts).toBe(1)
    const record = store.of(agent.sessionId, 'compaction')[0]!
    expect(record).toMatchObject({ turn: 2, step: 1, summary: 'earlier work', keepMessages: 1, compactedMessages: 2, requestId: 'aux-1' })
    const types = store.types(agent.sessionId)
    expect(types.indexOf('compaction')).toBe(types.lastIndexOf('user.message') + 1)
    expect(conversation(llm.requests[1]!)).toEqual([
      { role: 'user', content: renderCompactionSummary('earlier work') },
      { role: 'user', content: 'turn two' },
    ])
    expect(agent.taskStats().requestCount).toBe(4)
    const before = agent.history()
    await agent.close()
    const resumed = await app.agents.resume(agent.sessionId)
    expect(resumed.history()).toEqual(before)
    await resumed.close()
  })

  it('keeps the history and stops trying for the turn when compaction fails', async () => {
    harness = await bootHarness({
      script: [textReply('first', usage(1000, 5)), toolCallReply('c1', 'echo', { text: 'x' }, '', usage(1000, 5)), textReply('second', usage(1000, 5)), textReply('third')],
    })
    const { app, llm, store } = harness
    app.ctx.tools.register(echo)
    const fake = compactor(500, { fail: true })
    await app.ctx.plugin(servicePlugin('context', contextService([], fake)))
    const agent = await app.agents.create()
    await agent.run('turn one')
    const result = await agent.run('turn two')
    expect(result.reason).toEqual({ kind: 'completed' })
    expect(fake.compacts).toBe(1)
    expect(store.of(agent.sessionId, 'compaction')).toHaveLength(0)
    const errors = store.of(agent.sessionId, 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ turn: 2, fatal: false })
    expect(errors[0]!.error.message).toContain('compaction failed')
    expect(conversation(llm.requests[1]!).map(message => message.content)).toEqual(['turn one', 'first', 'turn two'])
    // a new turn tries again
    await agent.run('turn three')
    expect(fake.compacts).toBe(2)
    await agent.close()
  })

  it('treats a result that keeps a tail starting with a tool result as a failure', async () => {
    harness = await bootHarness({ script: [toolCallReply('c1', 'echo', { text: 'x' }), textReply('first', usage(1000, 5)), textReply('second')] })
    const { app, llm, store } = harness
    app.ctx.tools.register(echo)
    const bad: Compactor = {
      shouldCompact: input => input.lastUsage !== undefined,
      compact: async () => ({ summary: 's', keepMessages: 1, compactedMessages: 1, requestId: 'r', usage: usage(1, 1), trigger: { inputTokens: 1000, threshold: 1 } }),
    }
    await app.ctx.plugin(servicePlugin('context', contextService([], {
      shouldCompact: bad.shouldCompact,
      // keep from the tool result on: invalid (its call would be summarized away)
      compact: async input => ({ ...(await bad.compact(input, new AbortController().signal)), keepMessages: input.messages.length - 2 }),
    })))
    const agent = await app.agents.create()
    await agent.run('one')
    await agent.run('two')
    expect(store.of(agent.sessionId, 'compaction')).toHaveLength(0)
    expect(store.of(agent.sessionId, 'error')[0]!.error.code).toBe('session/invalid-record')
    expect(conversation(llm.requests[2]!)).toHaveLength(5)
    await agent.close()
  })
})

describe('turn file tracker', () => {
  it('begins after turn.start, observes each tool result, and writes sorted turn.files before turn.end', async () => {
    harness = await bootHarness({ script: [toolCallReply('c1', 'echo', { text: 'x' }), textReply('done')] })
    const { app, store } = harness
    app.ctx.tools.register(echo)
    const tracker = new FakeTracker()
    tracker.changes = [{ path: 'b.txt', change: 'added' }, { path: 'a.txt', change: 'modified' }]
    tracker.failObserve = true
    await app.ctx.plugin(servicePlugin('tasking', tasking(tracker)))
    const agent = await app.agents.create()
    const result = await agent.run('go')
    expect(result.reason).toEqual({ kind: 'completed' })
    expect(tracker.calls).toEqual(['begin:1', 'end:1'])
    expect(tracker.observed).toEqual([{ sessionId: agent.sessionId, turn: 1, callId: 'c1', name: 'echo', isError: false, effects: ['read'], meta: { paths: ['a.txt'] } }])
    expect(store.of(agent.sessionId, 'tool.result')[0]!.isError).toBe(false)
    const types = store.types(agent.sessionId)
    expect(types.slice(-2)).toEqual(['turn.files', 'turn.end'])
    expect(store.of(agent.sessionId, 'turn.files')[0]).toMatchObject({ turn: 1, changes: [{ path: 'a.txt', change: 'modified' }, { path: 'b.txt', change: 'added' }] })
    expect(store.of(agent.sessionId, 'turn.files')[0]!.omitted).toBeUndefined()
    expect(harness.llm.requests[0]!.messages[0]!.content).not.toContain('.nexgent/materials/')
    await agent.close()
  })

  it('writes an empty turn.files, and an error instead of turn.files when endTurn fails', async () => {
    harness = await bootHarness({ script: [textReply('one'), textReply('two')] })
    const { app, store } = harness
    const tracker = new FakeTracker()
    await app.ctx.plugin(servicePlugin('tasking', tasking(tracker)))
    const agent = await app.agents.create()
    await agent.run('first')
    expect(store.of(agent.sessionId, 'turn.files')[0]!.changes).toEqual([])
    tracker.failEnd = true
    const result = await agent.run('second')
    expect(result.reason).toEqual({ kind: 'completed' })
    expect(store.of(agent.sessionId, 'turn.files')).toHaveLength(1)
    expect(store.types(agent.sessionId).slice(-2)).toEqual(['error', 'turn.end'])
    await agent.close()
  })

  it('still writes turn.files for a cancelled turn and bounds endTurn by the cancel deadline signal', async () => {
    harness = await bootHarness({
      script: [async function* (request) {
        await sleep(10_000, request.signal ?? undefined)
        yield { type: 'done', finishReason: 'aborted' } as const
      }],
    })
    const { app, store } = harness
    const tracker = new FakeTracker()
    tracker.changes = [{ path: 'x.txt', change: 'deleted' }]
    await app.ctx.plugin(servicePlugin('tasking', tasking(tracker)))
    const agent = await app.agents.create()
    const running = agent.run('long')
    await sleep(50)
    agent.cancel()
    const result = await running
    expect(result.reason).toEqual({ kind: 'cancelled', cause: 'user' })
    expect(store.of(agent.sessionId, 'turn.files')[0]!.changes).toEqual([{ path: 'x.txt', change: 'deleted' }])
    expect(tracker.endSignal).toBeDefined()
    expect(tracker.endSignal!.aborted).toBe(false)
    await agent.close()
  })
})

describe('tool records', () => {
  function presenting(record: (context: KernelToolContext) => unknown, swallow = false): Tool {
    return {
      definition: {
        name: 'present',
        description: 'Present a deliverable.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        effects: ['read'],
        approval: 'never',
      },
      handler: async (_input, context) => {
        const kernel = context as KernelToolContext
        try {
          await kernel.appendRecord(record(kernel) as never)
        } catch (error) {
          if (!swallow) throw error
        }
        return { content: 'presented' }
      },
    }
  }

  it('appends deliverable.presented before the call\'s tool.result, with the step on the context', async () => {
    harness = await bootHarness({ script: [toolCallReply('c1', 'present', {}), textReply('done')] })
    const { app, store } = harness
    let step: number | undefined
    app.ctx.tools.register(presenting(context => {
      step = context.step
      return { type: 'deliverable.presented', turn: context.turn, step: context.step, toolCallId: context.callId, deliverable }
    }))
    const agent = await app.agents.create()
    await agent.run('present it')
    expect(step).toBe(1)
    const types = store.types(agent.sessionId)
    expect(types.indexOf('deliverable.presented')).toBe(types.indexOf('tool.result') - 1)
    expect(store.of(agent.sessionId, 'deliverable.presented')[0]).toMatchObject({ turn: 1, step: 1, toolCallId: 'c1', deliverable })
    expect(store.of(agent.sessionId, 'tool.result')[0]!.isError).toBe(false)
    await agent.close()
  })

  it('rejects a record for another call or of another type and fails the call even when the tool catches it', async () => {
    harness = await bootHarness({ script: [toolCallReply('c1', 'present', {}), toolCallReply('c2', 'present', {}), textReply('done')] })
    const { app, store } = harness
    let calls = 0
    app.ctx.tools.register(presenting(context => {
      calls += 1
      return calls === 1
        ? { type: 'deliverable.presented', turn: context.turn, step: context.step + 1, toolCallId: context.callId, deliverable }
        : { type: 'goal.set', goal: { id: 'g', text: 't', status: 'active', setAt: '', updatedAt: '' } }
    }, true))
    const agent = await app.agents.create()
    await agent.run('present it')
    expect(store.of(agent.sessionId, 'deliverable.presented')).toHaveLength(0)
    expect(store.of(agent.sessionId, 'goal.set')).toHaveLength(0)
    const results = store.of(agent.sessionId, 'tool.result')
    expect(results.map(result => [result.isError, result.error?.code])).toEqual([[true, 'tool/failed'], [true, 'tool/failed']])
    expect(results[0]!.content).toContain('step 1')
    expect(results[1]!.content).toContain('only deliverable.presented')
    await agent.close()
  })

  it('fails the call when the store refuses the record', async () => {
    harness = await bootHarness({ script: [toolCallReply('c1', 'present', {}), textReply('done')] })
    const { app, store } = harness
    app.ctx.tools.register(presenting(context => ({ type: 'deliverable.presented', turn: context.turn, step: context.step, toolCallId: context.callId, deliverable })))
    store.failNext = 'deliverable.presented'
    const agent = await app.agents.create()
    await agent.run('present it')
    const result = store.of(agent.sessionId, 'tool.result')[0]!
    expect(result).toMatchObject({ isError: true, error: { code: 'tool/failed' } })
    await agent.close()
  })
})

describe('host records and turn input', () => {
  it('writes host records between turns without a turn and during a turn with it, and refuses other types', async () => {
    harness = await bootHarness()
    const { app, llm, store } = harness
    const agent = await app.agents.create()
    const goal = { id: 'g1', text: 'ship it', status: 'active' as const, setAt: '2026-10-11T00:00:00.000Z', updatedAt: '2026-10-11T00:00:00.000Z' }
    const written = await agent.appendHostRecord({ type: 'goal.set', goal })
    expect(written).toMatchObject({ type: 'goal.set', goal })
    expect('turn' in written).toBe(false)

    const material = { id: 'm1', originalName: 'a.csv', path: '.nexgent/materials/m1/a.csv', size: 1, sha256: '0'.repeat(64), mediaType: 'text/csv' }
    llm.push(async function* () {
      await agent.appendHostRecord({ type: 'material.added', material })
      yield* textReply('ok')
    })
    await agent.run('hi')
    expect(store.of(agent.sessionId, 'material.added')[0]).toMatchObject({ turn: 1, material })

    await expect(agent.appendHostRecord({ type: 'turn.start', turn: 9 } as never)).rejects.toMatchObject({ code: 'session/invalid-record' })
    await expect(agent.appendHostRecord({ type: 'goal.update', turn: 3, goalId: 'g1', status: 'completed' })).rejects.toMatchObject({ code: 'session/invalid-record' })
    await agent.close()
    await expect(agent.appendHostRecord({ type: 'goal.set', goal })).rejects.toThrow(/closed/)
  })

  it('runs a feedback turn: feedback after turn.start, then the rendered prompt as a feedback message', async () => {
    harness = await bootHarness({ script: [textReply('revised')] })
    const { app, llm, store } = harness
    const providers: ContextProvider[] = [{ id: 'p', beginTurn: async () => ({ inject: ['context'] }) }]
    await app.ctx.plugin(servicePlugin('context', contextService(providers)))
    const tracker = new FakeTracker()
    await app.ctx.plugin(servicePlugin('tasking', tasking(tracker, [{ id: 'm1' }])))
    const agent = await app.agents.create()
    const feedback = { id: 'f1', deliverableId: 'd1', version: 2, rating: 3 as const, comment: 'Use two decimals.' }
    await agent.run({ source: 'feedback', feedback })
    expect(store.types(agent.sessionId)).toEqual([
      'session.start', 'turn.start', 'feedback', 'user.message', 'user.message', 'assistant.message', 'turn.files', 'turn.end',
    ])
    expect(store.of(agent.sessionId, 'feedback')[0]).toMatchObject({ turn: 1, feedback })
    const message = store.of(agent.sessionId, 'user.message')[1]!
    expect(message).toMatchObject({ source: 'feedback', content: renderFeedbackPrompt(feedback) })
    expect(conversation(llm.requests[0]!).at(-1)).toEqual({ role: 'user', content: renderFeedbackPrompt(feedback) })
    // the project has a material: the read-only line is in the prompt
    expect(llm.requests[0]!.messages[0]!.content).toContain('read-only copies at the paths given with them')
    await agent.close()
  })
})

describe('system prompt sections', () => {
  it('render after # Working with files and before the suffix', () => {
    const tool = (name: string) => ({ name, description: name, inputSchema: { type: 'object' as const }, effects: [], approval: 'never' as const })
    const prompt = renderSystemPrompt({
      template: { persona: 'P', suffix: 'S' },
      model: 'm',
      cwd: '/p',
      sandboxMode: 'workspace-write',
      platform: 'linux',
      tools: [tool('write_file')],
      sections: [{ id: 'a', title: 'Project instructions', body: 'Be brief.' }],
    })
    expect(prompt.endsWith('# Working with files\n- To create a new file, use `write_file`; it refuses a file that already exists.\n\n# Project instructions\nBe brief.\n\nS')).toBe(true)
  })
})
