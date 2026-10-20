/**
 * Step 5 kernel duties (legacy; `data-formats.md` §旧格式（只为读旧项目）): per-turn snapshots and
 * checks, the check-failure signal to `ctx.improve`, improvement sessions
 * (`session.start.purpose`, tool scope, ledger attribution, resume), and
 * the read-only slices behind the diagnose session's tools.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  BASELINE_VERSION,
  IMPROVEMENT_DIAGNOSIS_TOOLS,
  IMPROVEMENT_LIMITS,
  readLedgerSlice,
  readSessionSlice,
  sliceBytes,
  type CapabilityAttachInput,
  type CapabilityHost,
  type CheckFailureSignal,
  type Context,
  type ImprovementSignals,
  type NexgentApp,
  type TaskBeginInput,
  type TaskCheck,
  type TaskRecorder,
  type Tool,
} from '../src/index.js'
import { textReply, toolCallReply, type ScriptStep } from './helpers/fakes.js'
import { bootHarness, type Harness } from './helpers/harness.js'

let harness: Harness | undefined
afterEach(async () => {
  await harness?.dispose()
  harness = undefined
})

const JOB = '0f0f0f0f-0000-4000-8000-000000000001'
const DIAGNOSIS_NAMES = IMPROVEMENT_DIAGNOSIS_TOOLS.map(tool => tool.name)

function plainTool(name: string): Tool {
  return {
    definition: { name, description: `${name}.`, inputSchema: { type: 'object', properties: {} }, effects: ['read'], approval: 'never' },
    handler: async () => ({ content: `${name} ran` }),
  }
}

async function provide(app: NexgentApp, name: 'capabilityHost' | 'taskRecorder' | 'improve', value: CapabilityHost | TaskRecorder | ImprovementSignals): Promise<void> {
  await app.ctx.plugin({ name: `fake-${name}`, apply: (ctx: Context) => { ctx.provide(name, value) } })
}

/** A recorder whose checks pass or fail as told, and a queue that records signals. */
function services(results: () => TaskCheck[]) {
  const begun: TaskBeginInput[] = []
  const ended: number[] = []
  const signals: CheckFailureSignal[] = []
  const recorder: TaskRecorder = {
    begin: async input => { begun.push(input) },
    end: async input => {
      ended.push(input.turn ?? 0)
      const checks = results()
      return { specs: checks.map((_, i) => ({ id: `file-${i + 1}`, name: 'file-exists' as const, path: 'out.csv' })), results: checks }
    },
  }
  const improve: ImprovementSignals = { noteCheckFailure: async input => { signals.push(input) } }
  return { begun, ended, signals, recorder, improve }
}

const PASS: TaskCheck = { name: 'file-exists', passed: true, target: 'file-1' }
const FAIL: TaskCheck = { name: 'file-exists', passed: false, target: 'file-1', detail: 'out.csv is missing' }

/** Tool names of the n-th model request. */
function toolsOf(h: Harness, n: number): string[] {
  return (h.llm.requests[n]?.tools ?? []).map(tool => tool.name).sort()
}

describe('per-turn task records and the check-failure signal', () => {
  it('signals each root turn whose checks failed, once, with its turn', async () => {
    harness = await bootHarness({ script: [textReply('one'), textReply('two'), textReply('three')] })
    const { app, store } = harness
    let outcome = [FAIL]
    const s = services(() => outcome)
    await provide(app, 'taskRecorder', s.recorder)
    await provide(app, 'improve', s.improve)
    const agent = await app.agents.create()
    await agent.run('make it')
    outcome = [PASS]
    await agent.run('again')
    outcome = [PASS, FAIL]
    await agent.run('fix it')
    expect(s.begun.map(input => input.turn)).toEqual([1, 2, 3])
    expect(s.ended).toEqual([1, 2, 3])
    expect(s.signals).toEqual([
      { taskId: agent.attribution.taskId, sessionId: agent.sessionId, turn: 1, checks: [FAIL] },
      { taskId: agent.attribution.taskId, sessionId: agent.sessionId, turn: 3, checks: [PASS, FAIL] },
    ])
    await agent.close()
    expect(store.of(agent.sessionId, 'error')).toEqual([])
  })

  it('keeps the turn when the signal cannot be counted (non-fatal error)', async () => {
    harness = await bootHarness({ script: [textReply('one')] })
    const { app, store, ledger } = harness
    const s = services(() => [FAIL])
    await provide(app, 'taskRecorder', s.recorder)
    await provide(app, 'improve', { noteCheckFailure: async () => { throw new Error('queue locked') } })
    const agent = await app.agents.create()
    expect((await agent.run('go')).reason).toEqual({ kind: 'completed' })
    await agent.close()
    expect(store.of(agent.sessionId, 'error')).toEqual([expect.objectContaining({ fatal: false, error: expect.objectContaining({ message: 'check-failure signal failed: queue locked' }) })])
    expect(ledger.of('task.outcome')[0]).toMatchObject({ checks: [FAIL] })
  })

  it('hands the recorder failing root commands with their exit codes and signals a failing test-command check (ADR 0006 decision 10)', async () => {
    harness = await bootHarness({
      script: [
        toolCallReply('c1', 'bash', { command: 'npm test' }),
        toolCallReply('c2', 'bash', { command: 'ls missing/' }),
        toolCallReply('c3', 'bash', { command: 'pytest -q' }),
        toolCallReply('c4', 'bash', { command: 'npm test', cwd: 'sub' }),
        textReply('done'),
        // redesign 3.2: the failing test run of this turn sends the model back twice
        textReply('still failing'),
        textReply('cannot fix'),
      ],
    })
    const { app, store } = harness
    const codes: Record<string, number | 'timeout'> = { 'npm test': 1, 'ls missing/': 2, 'pytest -q': 'timeout' }
    app.ctx.tools.register({
      definition: plainTool('bash').definition,
      handler: async input => {
        const code = codes[(input as { command: string }).command] ?? 0
        return code === 'timeout' ? { content: 'timed out', isError: true } : { content: 'ran', meta: { exitCode: code } }
      },
    })
    const commands: unknown[] = []
    const failed: TaskCheck = { name: 'test-command', passed: false, target: 'test-1', detail: 'exit code 1' }
    const s = services(() => [failed])
    await provide(app, 'taskRecorder', {
      begin: s.recorder.begin,
      end: async input => {
        commands.splice(0, commands.length, ...input.commands)
        return { specs: [{ id: 'test-1', name: 'test-command', command: 'npm test', shell: 'bash' }], results: [failed] }
      },
    })
    await provide(app, 'improve', s.improve)
    const agent = await app.agents.create()
    await agent.run('test it')
    await agent.close()
    expect(commands).toEqual([
      { command: 'npm test', shell: 'bash', exitCode: 1 },
      { command: 'ls missing/', shell: 'bash', exitCode: 2 },
    ])
    expect(s.signals).toEqual([{ taskId: agent.attribution.taskId, sessionId: agent.sessionId, turn: 1, checks: [failed] }])
    expect(store.of(agent.sessionId, 'error')).toEqual([])
  })

  it('gives a gate trial session per-turn records but no signal, and stamps its job on every ledger record', async () => {
    harness = await bootHarness({ script: [textReply('replayed')] })
    const { app, ledger, llm } = harness
    const s = services(() => [FAIL])
    await provide(app, 'taskRecorder', s.recorder)
    await provide(app, 'improve', s.improve)
    const agent = await app.agents.create({ improvement: { jobId: JOB, phase: 'trial' } })
    await agent.run('replay')
    await agent.close()
    expect(s.begun).toHaveLength(1)
    expect(s.signals).toEqual([])
    expect(harness.store.of(agent.sessionId, 'session.start')[0]).not.toHaveProperty('purpose')
    expect(ledger.records.length).toBeGreaterThan(0)
    for (const record of ledger.records) expect(record).toMatchObject({ improvementId: JOB, improvementPhase: 'trial' })
    expect(llm.options[0]).toMatchObject({ improvementId: JOB, improvementPhase: 'trial' })
  })
})

describe('improvement sessions', () => {
  async function boot(script: ScriptStep[]) {
    harness = await bootHarness({ script })
    const { app } = harness
    for (const name of ['read_file', 'delegate', 'capability_try', ...DIAGNOSIS_NAMES]) app.ctx.tools.register(plainTool(name))
    const s = services(() => [FAIL])
    await provide(app, 'taskRecorder', s.recorder)
    await provide(app, 'improve', s.improve)
    const attaches: Omit<CapabilityAttachInput, 'ctx'>[] = []
    await provide(app, 'capabilityHost', {
      current: async () => 'c'.repeat(64),
      verify: async () => ({ ok: true }),
      attach: async ({ ctx: _ctx, ...input }) => { attaches.push(input); return { components: [] } },
    })
    return { app, s, attaches }
  }

  it('opens a diagnose session: header purpose, only the diagnosis tools, no components, no task records', async () => {
    const { app, s, attaches } = await boot([toolCallReply('c1', 'improve_read_session', {}), textReply('diagnosed')])
    const agent = await app.agents.create({ improvement: { jobId: JOB, phase: 'diagnose' }, model: 'claude-opus-5-5', thinking: 'off' })
    expect(agent.isImprovementSession).toBe(true)
    expect(harness!.store.of(agent.sessionId, 'session.start')[0]).toMatchObject({ purpose: 'improvement', improvement: { jobId: JOB, phase: 'diagnose' } })
    expect(harness!.store.of(agent.sessionId, 'session.start')[0]).not.toHaveProperty('capabilityVersion')
    await agent.run('diagnose the feedback')
    await agent.close()
    expect(toolsOf(harness!, 0)).toEqual([...DIAGNOSIS_NAMES].sort())
    expect(harness!.llm.requests[0]).toMatchObject({ model: 'claude-opus-5-5', thinking: 'off' })
    expect(attaches).toEqual([])
    expect(s.begun).toEqual([])
    expect(s.signals).toEqual([])
    for (const record of harness!.ledger.records) expect(record).toMatchObject({ improvementId: JOB, improvementPhase: 'diagnose' })
    expect(harness!.ledger.of('task.outcome')[0]).not.toHaveProperty('checks')
  })

  it('opens a propose session: task and capability tools, no collaboration or improve_* tools, no task records', async () => {
    const { app, s, attaches } = await boot([textReply('proposed')])
    const agent = await app.agents.create({ improvement: { jobId: JOB, phase: 'propose' } })
    await agent.run('redo the task')
    await agent.close()
    expect(toolsOf(harness!, 0)).toEqual(['capability_try', 'read_file'])
    expect(attaches).toHaveLength(1)
    expect(s.begun).toEqual([])
    for (const record of harness!.ledger.records) expect(record).toMatchObject({ improvementId: JOB, improvementPhase: 'propose' })
  })

  it('hides the improve_* tools from an ordinary task session', async () => {
    const { app } = await boot([textReply('ok')])
    const agent = await app.agents.create()
    expect(agent.isImprovementSession).toBe(false)
    await agent.run('task')
    await agent.close()
    expect(toolsOf(harness!, 0)).toEqual(['capability_try', 'delegate', 'read_file'])
    for (const record of harness!.ledger.records) expect(record).not.toHaveProperty('improvementId')
  })

  it('resumes an improvement session with its job and scope from the header', async () => {
    const { app } = await boot([textReply('first'), textReply('second')])
    const created = await app.agents.create({ improvement: { jobId: JOB, phase: 'diagnose' } })
    await created.run('one')
    await created.close()
    await expect(app.agents.resume(created.sessionId, { improvement: { jobId: JOB, phase: 'trial' } })).rejects.toMatchObject({ code: 'tool/invalid-input' })
    const resumed = await app.agents.resume(created.sessionId)
    expect(resumed.improvement).toEqual({ jobId: JOB, phase: 'diagnose' })
    await resumed.run('two')
    await resumed.close()
    expect(toolsOf(harness!, 1)).toEqual([...DIAGNOSIS_NAMES].sort())
  })

  it('refuses a malformed job, a member job, and a non-trial job on resume of a task session', async () => {
    const { app } = await boot([textReply('ok')])
    await expect(app.agents.create({ improvement: { jobId: '', phase: 'diagnose' } })).rejects.toMatchObject({ code: 'tool/invalid-input' })
    await expect(app.agents.create({ improvement: { jobId: JOB, phase: 'review' as never } })).rejects.toMatchObject({ code: 'tool/invalid-input' })
    const root = await app.agents.create()
    await expect(app.agents.create({ improvement: { jobId: JOB, phase: 'trial' }, child: { parentSessionId: root.sessionId, member: { name: 'helper', executionForm: 'delegated' } } }))
      .rejects.toMatchObject({ code: 'tool/invalid-input' })
    await root.close()
    await expect(app.agents.resume(root.sessionId, { improvement: { jobId: JOB, phase: 'propose' } })).rejects.toMatchObject({ code: 'tool/invalid-input' })
  })
})

describe('read-only slices', () => {
  it('slices a session by turn range and type, oldest first, within the byte cap', async () => {
    harness = await bootHarness({ script: [textReply('one'), textReply('two'), textReply('three')] })
    const { app, store } = harness
    const agent = await app.agents.create()
    for (const text of ['a', 'b', 'c']) await agent.run(text)
    await agent.close()
    const all = await readSessionSlice(store, { sessionId: agent.sessionId })
    expect(all.records[0]?.type).toBe('session.start')
    expect(all.truncated).toBe(false)
    const turns = await readSessionSlice(store, { sessionId: agent.sessionId, fromTurn: 2, toTurn: 3, types: ['user.message'] })
    expect(turns.records.map(record => (record as { content?: string }).content)).toEqual(['b', 'c'])
    expect(turns.matched).toBe(2)
    const first = JSON.stringify(turns.records[0]).length + 1
    const cut = await readSessionSlice(store, { sessionId: agent.sessionId, fromTurn: 2, types: ['user.message'], maxBytes: first })
    expect(cut).toMatchObject({ matched: 2, truncated: true, bytes: first, maxBytes: first })
    expect(cut.records).toHaveLength(1)
    await expect(readSessionSlice(store, { sessionId: '9f9f9f9f-0000-4000-8000-000000000000' })).rejects.toMatchObject({ code: 'session/not-found' })
  })

  it('slices the ledger by attribution and type', async () => {
    harness = await bootHarness({ script: [textReply('one'), textReply('two')] })
    const { app, ledger } = harness
    const a = await app.agents.create()
    await a.run('a')
    await a.close()
    const b = await app.agents.create({ improvement: { jobId: JOB, phase: 'trial' } })
    await b.run('b')
    await b.close()
    const byTask = await readLedgerSlice(ledger, { taskId: a.attribution.taskId })
    expect(byTask.records.length).toBeGreaterThan(0)
    expect(byTask.records.every(record => record.taskId === a.attribution.taskId)).toBe(true)
    const outcomes = await readLedgerSlice(ledger, { memberId: 'main', types: ['task.outcome'] })
    expect(outcomes.records.map(record => record.sessionId)).toEqual([a.sessionId, b.sessionId])
    expect((await readLedgerSlice(ledger, { sessionId: b.sessionId, types: ['task.outcome'] })).records).toHaveLength(1)
    expect((await readLedgerSlice(ledger, { capabilityVersion: BASELINE_VERSION })).matched).toBe(0)
  })

  it('clamps the byte cap to the contract bounds', () => {
    expect(sliceBytes(undefined)).toBe(IMPROVEMENT_LIMITS.defaultSliceBytes)
    expect(sliceBytes(0)).toBe(1)
    expect(sliceBytes(10 * IMPROVEMENT_LIMITS.maxSliceBytes)).toBe(IMPROVEMENT_LIMITS.maxSliceBytes)
    expect(sliceBytes(100.7)).toBe(100)
  })
})
