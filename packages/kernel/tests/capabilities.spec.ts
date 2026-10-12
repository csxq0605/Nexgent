/**
 * Step 4 kernel duties (`agent-hooks.md` §步骤 4): the session's capability
 * version (`session.start`, every ledger record, resume rules, load
 * failure), session-scoped components (`ctx.capabilityHost.attach`, tried
 * drafts), `componentsUsed`, `memberCosts`, and the root task's snapshot and
 * checks (`ctx.taskRecorder`).
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  BASELINE_VERSION,
  type AttachedComponent,
  type CapabilityAttachInput,
  type CapabilityHost,
  type CapabilityVersion,
  type Context,
  type KernelToolContext,
  type NexgentApp,
  type TaskBeginInput,
  type TaskEndInput,
  type TaskRecorder,
  type Tool,
} from '../src/index.js'
import { MemoryLedger, MemorySessionStore, textReply, toolCallReply, usage } from './helpers/fakes.js'
import { bootHarness, type Harness } from './helpers/harness.js'

const V1 = 'a'.repeat(64)
const V2 = 'b'.repeat(64)

let harness: Harness | undefined
afterEach(async () => {
  await harness?.dispose()
  harness = undefined
})

function plainTool(name: string, content = `${name} ran`, meta?: Record<string, unknown>): Tool {
  return {
    definition: { name, description: `${name}.`, inputSchema: { type: 'object', properties: {} }, effects: ['read'], approval: 'never' },
    handler: async () => ({ content, ...(meta === undefined ? {} : { meta: meta as never }) }),
  }
}

/** A capability host whose bundles hold one function module (`sums`) and one skill (`report`). */
class FakeHost implements CapabilityHost {
  version: CapabilityVersion = V1
  readonly broken = new Set<CapabilityVersion>()
  readonly failAttach = new Set<CapabilityVersion>()
  /** Make the module's tool report errors. */
  failCalls = false
  readonly attaches: Omit<CapabilityAttachInput, 'ctx'>[] = []

  async current(): Promise<CapabilityVersion> {
    return this.version
  }

  async verify(version: CapabilityVersion) {
    return this.broken.has(version) ? { ok: false as const, detail: 'manifest hash mismatch' } : { ok: true as const }
  }

  async attach({ ctx, ...input }: CapabilityAttachInput) {
    this.attaches.push(input)
    if (this.failAttach.has(input.version)) throw new Error('bundle failed to load')
    if (input.version === BASELINE_VERSION) return { components: [] }
    const add = plainTool('cap_sums_add')
    ctx.tools.register({ ...add, handler: async () => this.failCalls ? { content: 'boom', isError: true } : { content: `added (${input.version.slice(0, 1)})` } })
    const components: AttachedComponent[] = [
      { kind: 'function-module', name: 'sums', tools: ['cap_sums_add'] },
      { kind: 'skill', name: 'report' },
    ]
    return { components }
  }
}

async function provide(app: NexgentApp, name: 'capabilityHost' | 'taskRecorder', value: CapabilityHost | TaskRecorder): Promise<void> {
  await app.ctx.plugin({ name: `fake-${name}`, apply: (ctx: Context) => { ctx.provide(name, value) } })
}

async function bootWithHost(options: Parameters<typeof bootHarness>[0] = {}): Promise<{ harness: Harness; host: FakeHost }> {
  const booted = await bootHarness(options)
  const host = new FakeHost()
  await provide(booted.app, 'capabilityHost', host)
  return { harness: booted, host }
}

/** `capability_try` as the capabilities package will do it: load a draft into the caller's scope and record it. */
function tryTool(app: NexgentApp): Tool {
  return {
    definition: { name: 'capability_try', description: 'Try a draft.', inputSchema: { type: 'object', properties: {} }, effects: ['read'], approval: 'never' },
    handler: async (_input, context) => {
      const ctx = context as KernelToolContext
      app.agents.get(context.sessionId)!.ctx.tools.register(plainTool('cap_draft_mul', 'multiplied'))
      await ctx.appendRecord({
        type: 'capability.try', turn: ctx.turn, step: ctx.step, toolCallId: ctx.callId,
        component: { kind: 'function-module', name: 'draft' }, revision: 1, tools: ['cap_draft_mul'],
      })
      return { content: 'loaded draft' }
    },
  }
}

describe('capability version', () => {
  it('writes the adopted version into session.start and every ledger record', async () => {
    const booted = await bootWithHost({ script: [toolCallReply('c1', 'cap_sums_add', {}), textReply('done')] })
    harness = booted.harness
    const { app, store, ledger, llm } = harness
    const agent = await app.agents.create()
    expect(agent.capabilityVersion).toBe(V1)
    expect(store.of(agent.sessionId, 'session.start')[0]).toMatchObject({ capabilityVersion: V1 })
    await agent.run('add')
    await agent.close()
    // The provider gets the version with the attribution and stamps its own records with it.
    expect(llm.options.map(options => (options as { capabilityVersion?: string }).capabilityVersion)).toEqual([V1, V1])
    expect(ledger.records.map(record => record.capabilityVersion)).toEqual(ledger.records.map(() => V1))
    expect(ledger.of('task.outcome')[0]).toMatchObject({
      componentsUsed: [{ kind: 'function-module', name: 'sums', version: V1, calls: 1, errors: 0 }],
    })
    expect(booted.host.attaches).toEqual([{ sessionId: agent.sessionId, version: V1, resumed: false }])
  })

  it('gives a session created after an adoption the new version and keeps open sessions on theirs', async () => {
    const booted = await bootWithHost({ script: [toolCallReply('c1', 'cap_sums_add', {}), textReply('old'), toolCallReply('c2', 'cap_sums_add', {}), textReply('new')] })
    harness = booted.harness
    const { app, store, ledger } = harness
    const before = await app.agents.create()
    booted.host.version = V2
    const after = await app.agents.create()
    expect(store.of(after.sessionId, 'session.start')[0]).toMatchObject({ capabilityVersion: V2 })
    await before.run('one')
    await after.run('two')
    const results = [...store.of(before.sessionId, 'tool.result'), ...store.of(after.sessionId, 'tool.result')]
    expect(results.map(result => result.content)).toEqual(['added (a)', 'added (b)'])
    await before.close()
    await after.close()
    const calls = ledger.of('tool.call')
    expect(calls.map(call => [call.sessionId, call.capabilityVersion])).toEqual([[before.sessionId, V1], [after.sessionId, V2]])
  })

  it('keeps the recorded version on resume, also after a crash, and switches when it no longer verifies', async () => {
    const store = new MemorySessionStore()
    const ledger = new MemoryLedger()
    const booted = await bootWithHost({ store, ledger, script: [textReply('one'), textReply('two'), textReply('three')] })
    harness = booted.harness
    const { app } = harness
    const host = booted.host
    const first = await app.agents.create()
    const sessionId = first.sessionId
    await first.run('one')
    // A crash mid-turn: records written, the lock gone, no outcome.
    await store.append(sessionId, { type: 'turn.start', turn: 2 })
    await store.append(sessionId, { type: 'user.message', turn: 2, content: 'lost', source: 'user' })
    await first.close({ skipOutcome: true })

    host.version = V2
    const resumed = await app.agents.resume(sessionId)
    expect(resumed.capabilityVersion).toBe(V1)
    expect(store.of(sessionId, 'capability.version')).toEqual([])
    await resumed.run('two')
    await resumed.close()
    expect(ledger.of('task.outcome').at(-1)).toMatchObject({ capabilityVersion: V1 })

    host.broken.add(V1)
    const switched = await app.agents.resume(sessionId)
    expect(switched.capabilityVersion).toBe(V2)
    expect(store.of(sessionId, 'capability.version')).toEqual([
      expect.objectContaining({ version: V2, previous: V1, reason: 'unavailable', detail: 'manifest hash mismatch' }),
    ])
    expect((await store.resume(sessionId)).metadata.capabilityVersion).toBe(V2)
    await switched.run('three')
    await switched.close()
    expect(ledger.of('task.outcome').at(-1)).toMatchObject({ capabilityVersion: V2 })
    expect(host.attaches.map(attach => [attach.version, attach.resumed])).toEqual([[V1, false], [V1, true], [V2, true]])
  })

  it('runs on baseline with a load-failure record when the bundle fails to load', async () => {
    const booted = await bootWithHost({ script: [textReply('ok')] })
    harness = booted.harness
    const { app, store, ledger } = harness
    booted.host.failAttach.add(V1)
    const agent = await app.agents.create()
    expect(agent.capabilityVersion).toBe(BASELINE_VERSION)
    expect(store.of(agent.sessionId, 'session.start')[0]).toMatchObject({ capabilityVersion: V1 })
    expect(store.of(agent.sessionId, 'capability.version')).toEqual([
      expect.objectContaining({ version: BASELINE_VERSION, previous: V1, reason: 'load-failure', detail: 'bundle failed to load' }),
    ])
    expect(app.ctx.tools.list().map(tool => tool.name)).not.toContain('cap_sums_add')
    await agent.run('go')
    await agent.close()
    expect(ledger.of('task.outcome')[0]).toMatchObject({ capabilityVersion: BASELINE_VERSION, componentsUsed: [] })
  })

  it('leaves the version out entirely without a capability host', async () => {
    harness = await bootHarness({ script: [textReply('ok')] })
    const { app, store, ledger } = harness
    const agent = await app.agents.create()
    await agent.run('go')
    await agent.close()
    expect(store.of(agent.sessionId, 'session.start')[0]).not.toHaveProperty('capabilityVersion')
    expect(ledger.records.every(record => record.capabilityVersion === undefined)).toBe(true)
    expect(ledger.of('task.outcome')[0]).not.toHaveProperty('componentsUsed')
  })
})

describe('session-scoped components', () => {
  it('shows a tried draft only to its own session and counts its use as draft', async () => {
    const booted = await bootWithHost({
      script: [
        toolCallReply('a1', 'capability_try', {}),
        toolCallReply('a2', 'cap_draft_mul', {}),
        toolCallReply('a3', 'load_skill', { name: 'report' }),
        toolCallReply('a4', 'load_skill', { name: 'unknown-skill' }),
        textReply('a done'),
        toolCallReply('b1', 'cap_draft_mul', {}),
        textReply('b done'),
      ],
    })
    harness = booted.harness
    const { app, store, ledger, llm } = harness
    app.ctx.tools.register(tryTool(app))
    app.ctx.tools.register(plainTool('load_skill', 'skill text'))
    const a = await app.agents.create()
    const b = await app.agents.create()
    await a.run('try it')
    expect(llm.requests.at(-1)!.tools!.map(tool => tool.name)).toContain('cap_draft_mul')
    await b.run('use it')
    // b's requests never offer the draft, and calling it fails.
    const bRequests = llm.requests.slice(5)
    expect(bRequests.every(request => !request.tools!.some(tool => tool.name === 'cap_draft_mul'))).toBe(true)
    expect(store.of(b.sessionId, 'tool.result')[0]).toMatchObject({ name: 'cap_draft_mul', isError: true, error: { code: 'tool/not-found' } })
    expect(a.componentsUsed()).toEqual([
      { kind: 'function-module', name: 'draft', version: 'draft', calls: 1, errors: 0 },
      { kind: 'skill', name: 'report', version: V1, calls: 1, errors: 0 },
    ])
    await a.close()
    await b.close()
    const outcomes = ledger.of('task.outcome')
    expect(outcomes.find(outcome => outcome.sessionId === b.sessionId)).toMatchObject({ componentsUsed: [] })
    // The draft went with its session.
    const c = await app.agents.create()
    expect(c.ctx.tools.list().map(tool => tool.name)).toEqual(expect.arrayContaining(['cap_sums_add']))
    expect(c.ctx.tools.list().map(tool => tool.name)).not.toContain('cap_draft_mul')
    await c.close()
  })

  it('counts errors and gives the turn view to a host that writes a task.outcome per turn', async () => {
    const booted = await bootWithHost({ script: [toolCallReply('c1', 'cap_sums_add', {}), textReply('one'), toolCallReply('c2', 'cap_sums_add', {}), toolCallReply('c3', 'cap_sums_add', {}), textReply('two')] })
    harness = booted.harness
    const { app } = harness
    const agent = await app.agents.create()
    await agent.run('one')
    expect(agent.turnOutcome().componentsUsed).toEqual([{ kind: 'function-module', name: 'sums', version: V1, calls: 1, errors: 0 }])
    booted.host.failCalls = true
    await agent.run('two')
    expect(agent.turnOutcome().componentsUsed).toEqual([{ kind: 'function-module', name: 'sums', version: V1, calls: 2, errors: 2 }])
    expect(agent.componentsUsed()).toEqual([{ kind: 'function-module', name: 'sums', version: V1, calls: 3, errors: 2 }])
    await agent.close()
  })
})

describe('members', () => {
  it('runs members on the root version and totals their costs on the root outcome', async () => {
    const booted = await bootWithHost({
      script: [
        toolCallReply('r1', 'delegate', {}),
        toolCallReply('m1', 'cap_sums_add', {}, '', usage(7, 3)),
        textReply('member done', usage(5, 2)),
        textReply('root done'),
      ],
    })
    harness = booted.harness
    const { app, store, ledger } = harness
    let memberId = ''
    app.ctx.tools.register({
      definition: { name: 'delegate', description: 'Delegate.', inputSchema: { type: 'object', properties: {} }, effects: ['read'], approval: 'never' },
      handler: async (_input, context) => {
        const child = await app.agents.create({ child: { parentSessionId: context.sessionId, member: { name: 'helper', executionForm: 'delegated' } } })
        memberId = child.sessionId
        await child.run('help')
        await child.close()
        return { content: 'helped' }
      },
    })
    const root = await app.agents.create()
    await root.run('go')
    await root.close()
    expect(store.of(memberId, 'session.start')[0]).toMatchObject({ capabilityVersion: V1 })
    expect(booted.host.attaches.map(attach => attach.member?.name ?? 'root')).toEqual(['root', 'helper'])
    const memberOutcome = ledger.of('task.outcome').find(outcome => outcome.sessionId === memberId)
    expect(memberOutcome).toMatchObject({ capabilityVersion: V1, componentsUsed: [{ kind: 'function-module', name: 'sums', version: V1, calls: 1, errors: 0 }] })
    expect(memberOutcome).not.toHaveProperty('memberCosts')
    const rootOutcome = ledger.of('task.outcome').find(outcome => outcome.sessionId === root.sessionId)
    expect(rootOutcome?.memberCosts).toEqual([{
      memberId,
      name: 'helper',
      executionForm: 'delegated',
      usage: { ...usage(12, 5) },
      requestCount: 2,
      toolCallCount: 1,
    }])
    // The root's own totals stay its own.
    expect(rootOutcome).toMatchObject({ requestCount: 2, toolCallCount: 1 })
  })
})

describe('task snapshot and checks', () => {
  it('snapshots the root task at its first turn and checks it at each root turn end', async () => {
    const booted = await bootWithHost({
      script: [
        toolCallReply('c1', 'present', {}),
        toolCallReply('c2', 'bash', { command: 'pytest -q' }),
        toolCallReply('c3', 'bash', { command: 'pytest -q', cwd: 'sub' }),
        textReply('done'),
        textReply('again'),
      ],
    })
    harness = booted.harness
    const { app, ledger, store } = harness
    const begun: TaskBeginInput[] = []
    const ended: Omit<TaskEndInput, 'signal'>[] = []
    await provide(app, 'taskRecorder', {
      begin: async input => {
        begun.push(input)
      },
      end: async ({ signal: _signal, ...input }) => {
        ended.push(input)
        return {
          specs: [{ id: 'file-1', name: 'file-exists', path: 'out.csv' }],
          results: [{ name: 'file-exists', passed: true, target: 'file-1' }],
        }
      },
    })
    app.ctx.tools.register({
      definition: plainTool('present').definition,
      handler: async (_input, context) => {
        const ctx = context as KernelToolContext
        await ctx.appendRecord({
          type: 'deliverable.presented', turn: ctx.turn, step: ctx.step, toolCallId: ctx.callId,
          deliverable: { deliverableId: 'd1', version: 1, title: 'Out', summary: 's', files: [{ path: 'out.csv', size: 1, sha256: 'c'.repeat(64), mediaType: 'text/csv' }] },
        })
        return { content: 'presented' }
      },
    })
    app.ctx.tools.register(plainTool('bash', 'ok', { exitCode: 0 }))
    const agent = await app.agents.create()
    await agent.run('make it')
    expect(begun).toEqual([{ taskId: agent.attribution.taskId, sessionId: agent.sessionId, capabilityVersion: V1 }])
    expect(ended).toEqual([{
      taskId: agent.attribution.taskId,
      sessionId: agent.sessionId,
      deliverableFiles: ['out.csv'],
      commands: [{ command: 'pytest -q', shell: 'bash' }],
    }])
    // Checks ran before turn.end, so a per-turn host outcome can carry them.
    expect(agent.turnOutcome().checks).toEqual([{ name: 'file-exists', passed: true, target: 'file-1' }])
    await agent.run('again')
    expect(begun).toHaveLength(1)
    expect(ended).toHaveLength(2)
    await agent.close()
    expect(ledger.of('task.outcome')[0]).toMatchObject({ checks: [{ name: 'file-exists', passed: true, target: 'file-1' }] })
    expect(store.of(agent.sessionId, 'error')).toEqual([])
  })

  it('records recorder failures as non-fatal errors and leaves checks out', async () => {
    const booted = await bootWithHost({ script: [textReply('done')] })
    harness = booted.harness
    const { app, ledger, store } = harness
    await provide(app, 'taskRecorder', {
      begin: async () => undefined,
      end: async () => {
        throw new Error('disk full')
      },
    })
    const agent = await app.agents.create()
    expect((await agent.run('go')).reason).toEqual({ kind: 'completed' })
    await agent.close()
    expect(store.of(agent.sessionId, 'error')).toEqual([expect.objectContaining({ fatal: false, error: expect.objectContaining({ message: 'task checks failed: disk full' }) })])
    expect(ledger.of('task.outcome')[0]).not.toHaveProperty('checks')
  })
})
