import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { ToolCallId } from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { WorkflowEngine, WorkflowRunId } from '@deepseek-ai/dsh-workflow'
import type { WorkflowResult, WorkflowRun, WorkflowStartRequest } from '@deepseek-ai/dsh-workflow'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ExecutionLedger from '../src/execution-ledger.ts'
import * as Trials from '../src/architecture-trials.ts'
import { prepareArchitecture, saveArchitecture } from '@deepseek-ai/dsh-tool-workflow'

vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>()
  return { ...actual, fsyncSync: vi.fn(actual.fsyncSync) }
})
afterEach(() => vi.restoreAllMocks())

function graph(prompt: string) { return { nodes: [{ id: 'answer', role: 'solver', prompt, dependencies: [] }] } }
const baseline = graph('BASELINE')
function plan() { return { id: 'frozen', description: 'Compare structured results', baseline,
  cases: [{ id: 'number', input: { value: 8 }, outputNode: 'answer', expected: { value: 8 } },
    { id: 'null', input: null, outputNode: 'answer', expected: null }] } }

class Engine extends WorkflowEngine {
  requests: WorkflowStartRequest[] = []
  disposed = 0
  barrier: Promise<void> | undefined
  waitForAbort = false
  cleanupFailure = false
  startFailure = false
  mismatch = false
  exoticFailure = false

  start(request: WorkflowStartRequest): WorkflowRun {
    if (this.startFailure) {
      if (this.exoticFailure) throw 'non-error provider failure'
      throw new Error('admission failed')
    }
    this.requests.push(request)
    const id = WorkflowRunId(`trial-run-${this.requests.length}`)
    const done = Promise.withResolvers<WorkflowResult>()
    const abort = (): void => { done.resolve({ stopReason: 'cancelled', value: null, agentsStarted: 1 }) }
    request.signal?.addEventListener('abort', abort, { once: true })
    queueMicrotask(() => {
      this.emitWorkflowEvent('workflow/agent-start', { id, meta: request.meta }, { seq: 1, label: 'answer', childId: SessionId(`child-${id}`) })
      if (this.waitForAbort) return
      const architectureVersion = this.mismatch ? '0'.repeat(64) : request.script.match(/return \{ architectureVersion: "([a-f0-9]{64})"/)?.[1]
      const outputs = request.script.includes('MISSING') ? {} : { answer: request.script.includes('BAD') ? { value: 0 } : request.args }
      done.resolve({ stopReason: request.script.includes('ERROR') ? 'error' : 'completed',
        value: { architectureVersion, outputs }, agentsStarted: 1 })
    })
    return { id, meta: request.meta, result: done.promise, cancel: abort,
      dispose: async () => {
        this.disposed++
        request.signal?.removeEventListener('abort', abort)
        await this.barrier
        if (this.cleanupFailure) {
          if (this.exoticFailure) throw 'non-error cleanup failure'
          throw new Error('cleanup failed')
        }
      } }
  }
}

async function fixture(config: Partial<Trials.Config> = {}) {
  const root = fs.mkdtempSync(join(tmpdir(), 'nexgent-output-trial-test-'))
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(ExecutionLedger, { directory: join(root, 'ledgers') })
  await ctx.plugin(Engine)
  const resolved = { architectureDirectory: join(root, 'architectures'), receiptDirectory: join(root, 'trials'), plans: [plan()], ...config }
  const fiber = await ctx.plugin(Trials, resolved)
  const session = Session.create(SessionId('caller'))
  const parent: Agent = { id: session.id, options: {}, session, inbox: unsupportedInbox(), status: 'idle', ctx,
    send: () => {}, followup: () => {}, steer: () => {}, inject: () => {}, cancel: () => {},
    runMaintenance: task => task(new AbortController().signal), whenIdle: () => Promise.resolve() }
  const execute = (arguments_: unknown, signal = new AbortController().signal, agent: Agent | undefined = parent) => ctx.tools.execute({
    name: 'architecture_trial', arguments: arguments_, callId: ToolCallId('trial-call'), signal, ...agent === undefined ? {} : { agent } })
  const receipts = (): Record<string, unknown>[][] => fs.existsSync(resolved.receiptDirectory)
    ? fs.readdirSync(resolved.receiptDirectory).map(file => fs.readFileSync(join(resolved.receiptDirectory, file), 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)) : []
  return { ctx, root, config: resolved, fiber, engine: ctx.workflowEngine as Engine, execute, receipts }
}

describe('native application output trials', () => {
  it('executes both frozen arms, records actual outputs and child identities, and does not adopt a pass', async () => {
    const f = await fixture()
    const result = await f.execute({ planId: 'frozen', architecture: graph('GOOD') })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('trial failed')
    expect(result.value).toMatchObject({ status: 'pass', baselinePassed: 2, candidatePassed: 2, casesPerArm: 2, adopted: false })
    expect(f.engine.requests.map(request => request.args)).toEqual([{ value: 8 }, { value: 8 }, null, null])
    expect(f.engine.disposed).toBe(4)
    expect(f.engine.requests.every(request => request.script.includes('options.toolFilter = { allow: [] };'))).toBe(true)
    const events = f.receipts()[0]!
    expect(events[0]).toMatchObject({ type: 'trial-start', mode: 'output-only', parentSession: 'caller', baselineVersion: prepareArchitecture(baseline).version })
    expect(events.filter(event => event.type === 'member-start')).toHaveLength(4)
    expect(events.filter(event => event.type === 'case-output').map(event => event.actual)).toEqual([{ value: 8 }, { value: 8 }, null, null])
    expect(events.at(-1)).toMatchObject({ type: 'trial-end', status: 'pass', adopted: false })
    expect(JSON.stringify(events)).not.toContain('"expected"')
    expect(f.ctx.tools.get('architecture_trial')?.description).not.toContain('outputNode')
    expect(f.ctx.tools.get('architecture_trial')?.presentCall?.({ planId: 'frozen' })).toMatchObject({ title: 'architecture trial: frozen' })
    expect(f.ctx.tools.get('architecture_trial')?.presentResult?.({ planId: 'frozen' }, result)).toEqual({ card: 'generic' })
  })

  it('detaches criteria before the candidate or mutable deployment object can change them', async () => {
    const frozen = plan()
    const f = await fixture({ plans: [frozen] })
    frozen.cases[0]!.expected = { value: 0 }
    frozen.cases[0]!.input = { value: 0 }
    const result = await f.execute({ planId: 'frozen', architecture: graph('BAD') })
    expect(result).toMatchObject({ isError: false, value: { status: 'fail', baselinePassed: 2, candidatePassed: 0 } })
    expect(f.engine.requests[0]?.args).toEqual({ value: 8 })
  })

  it.each(['ERROR', 'MISSING'])('keeps %s as unknown instead of manufacturing a comparison failure', async (prompt) => {
    const f = await fixture()
    const result = await f.execute({ planId: 'frozen', architecture: graph(prompt) })
    expect(result).toMatchObject({ isError: false, value: { status: 'unknown', baselinePassed: 2, candidatePassed: 0 } })
    expect(f.receipts()[0]!.filter(event => event.type === 'case-end' && event.arm === 'candidate').every(event => event.status === 'unknown')).toBe(true)
  })

  it('waits for disposal before recording outcomes and downgrades cleanup failures', async () => {
    const f = await fixture()
    const barrier = Promise.withResolvers<undefined>()
    f.engine.barrier = barrier.promise
    f.engine.cleanupFailure = true
    const task = f.execute({ planId: 'frozen', architecture: graph('GOOD') })
    try {
      await vi.waitFor(() => { expect(f.engine.disposed).toBe(1) })
      expect(f.receipts()[0]!.some(event => event.type === 'case-end')).toBe(false)
    } finally { barrier.resolve(undefined) }
    expect(await task).toMatchObject({ isError: false, value: { status: 'unknown' } })
    expect(f.receipts()[0]!.filter(event => event.type === 'case-end').every(event => event.reason === 'cleanup-error')).toBe(true)
  })

  it('cancels an active case, drains it and records unstarted cases without replay', async () => {
    const f = await fixture()
    f.engine.waitForAbort = true
    const abort = new AbortController()
    const task = f.execute({ planId: 'frozen', architecture: graph('GOOD') }, abort.signal)
    await vi.waitFor(() => { expect(f.engine.requests).toHaveLength(1) })
    abort.abort()
    await task
    expect(f.engine.disposed).toBe(1)
    expect(f.receipts()[0]!.filter(event => event.type === 'case-end').map(event => event.reason)).toEqual(['cancelled', 'not-run', 'not-run', 'not-run'])
    expect(f.receipts()[0]!.at(-1)).toMatchObject({ type: 'trial-end', status: 'unknown' })
  })

  it('unloads by cancelling and draining the active operation before removing its owner', async () => {
    const f = await fixture()
    f.engine.waitForAbort = true
    const barrier = Promise.withResolvers<undefined>()
    f.engine.barrier = barrier.promise
    const task = f.execute({ planId: 'frozen', architecture: graph('GOOD') })
    await vi.waitFor(() => { expect(f.engine.requests).toHaveLength(1) })
    const disposing = f.fiber.dispose()
    try {
      await vi.waitFor(() => { expect(f.engine.disposed).toBe(1) })
      expect(f.receipts()[0]!.some(event => event.type === 'trial-end')).toBe(false)
    } finally { barrier.resolve(undefined) }
    await disposing
    await task
    expect(f.receipts()[0]!.at(-1)).toMatchObject({ status: 'unknown' })
  })

  it('keeps admission errors unknown and fails closed when receipt synchronization fails', async () => {
    const f = await fixture()
    f.engine.startFailure = true
    expect(await f.execute({ planId: 'frozen', architecture: graph('GOOD') })).toMatchObject({ isError: false, value: { status: 'unknown' } })
    vi.spyOn(fs, 'fsyncSync').mockImplementationOnce(() => { throw new Error('storage failed') })
    expect((await f.execute({ planId: 'frozen', architecture: graph('GOOD') })).isError).toBe(true)
    expect(f.receipts().filter(events => !events.some(event => event.type === 'trial-end'))).toHaveLength(1)
  })

  it('loads a saved candidate in a fresh evaluation and rejects mixed or unknown inputs before starting', async () => {
    const f = await fixture()
    const saved = await saveArchitecture(f.config.architectureDirectory, graph('GOOD'))
    expect(await f.execute({ planId: 'frozen', architectureVersion: saved.version })).toMatchObject({ isError: false, value: { candidateVersion: saved.version, status: 'pass' } })
    for (const args of [{ planId: 'missing', architecture: graph('GOOD') }, { planId: 'frozen' },
      { planId: 'frozen', architecture: graph('GOOD'), architectureVersion: saved.version },
      { planId: 'frozen', architectureVersion: '0'.repeat(64) },
      { planId: 'frozen', architecture: { nodes: [{ id: 'other', role: 'solver', prompt: 'anything', dependencies: [] }, { id: 'yet-another', role: 'solver', prompt: 'anything', dependencies: [] }] } }]) {
      expect((await f.execute(args)).isError).toBe(true)
    }
    expect(f.engine.requests).toHaveLength(4)
    expect(await f.execute({ planId: 'frozen', architecture: graph('BAD'), expected: { value: 0 } })).toMatchObject({ isError: false, value: { status: 'fail' } })
  })

  it('registers no tool for empty plans and rejects invalid criteria during composition', async () => {
    const f = await fixture({ plans: [] })
    expect(f.ctx.tools.get('architecture_trial')).toBeUndefined()
    for (const plans of [[{ ...plan(), extra: true }], [plan(), plan()], [{ ...plan(), cases: [] }],
      [{ ...plan(), cases: [{ id: 'x', input: {}, outputNode: 'missing', expected: {} }] }],
      [{ ...plan(), cases: [plan().cases[0], plan().cases[0]] }], [{ ...plan(), description: '' }],
      [{ ...plan(), cases: [{ id: 'x', input: undefined, outputNode: 'answer', expected: {} }] }]]) {
      await expect(f.ctx.plugin(Trials, { ...f.config, plans })).rejects.toThrow()
    }
    await expect(f.ctx.plugin(Trials, { ...f.config, receiptDirectory: 'relative' })).rejects.toThrow('absolute')
  })

  it('rejects an agentless call and preserves unknown for a mismatched engine identity', async () => {
    const f = await fixture()
    expect((await f.ctx.tools.execute({ name: 'architecture_trial', arguments: { planId: 'frozen', architecture: graph('GOOD') },
      callId: ToolCallId('agentless'), signal: new AbortController().signal })).isError).toBe(true)
    f.engine.mismatch = true
    expect(await f.execute({ planId: 'frozen', architecture: graph('GOOD') })).toMatchObject({ isError: false, value: { status: 'unknown' } })
    f.engine.mismatch = false
    f.engine.exoticFailure = true
    f.engine.startFailure = true
    expect(await f.execute({ planId: 'frozen', architecture: graph('GOOD') })).toMatchObject({ isError: false, value: { status: 'unknown' } })
    f.engine.startFailure = false
    f.engine.cleanupFailure = true
    expect(await f.execute({ planId: 'frozen', architecture: graph('GOOD') })).toMatchObject({ isError: false, value: { status: 'unknown' } })
  })

  it('contains unrelated member events and cancels on its configured deadline', async () => {
    const f = await fixture({ maxCaseMs: 12_345 })
    f.engine.waitForAbort = true
    const timers = vi.spyOn(globalThis, 'setTimeout')
    const task = f.execute({ planId: 'frozen', architecture: graph('GOOD') })
    await vi.waitFor(() => { expect(f.engine.requests).toHaveLength(1) })
    f.ctx.emit('workflow/agent-start', { id: WorkflowRunId('unrelated'), meta: { name: 'other', description: 'Other live run' } },
      { seq: 1, label: 'unrelated', childId: SessionId('unrelated') })
    for (let index = 0; index < 4; index++) {
      await vi.waitFor(() => { expect(f.engine.requests).toHaveLength(index + 1) })
      const callback = timers.mock.calls.filter(([, ms]) => ms === 12_345)[index]?.[0]
      expect(callback).toBeTypeOf('function')
      if (typeof callback !== 'function') throw new Error('Missing deadline callback')
      callback()
    }
    expect(await task).toMatchObject({ isError: false, value: { status: 'unknown' } })
    expect(f.receipts()[0]!.filter(event => event.type === 'member-start')).toHaveLength(4)
    expect(f.engine.disposed).toBe(4)
  })

  it.each([2, 3])('fails closed on synchronized case/member recording failure %s and drains the native run', async (failureAt) => {
    const f = await fixture()
    const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs')
    let writes = 0
    vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
      if (++writes === failureAt) throw new Error('controlled receipt failure')
      actualFs.fsyncSync(fd)
    })
    expect((await f.execute({ planId: 'frozen', architecture: graph('GOOD') })).isError).toBe(true)
    expect(f.receipts()[0]!.some(event => event.type === 'trial-end')).toBe(false)
    expect(f.engine.disposed).toBe(failureAt === 2 ? 0 : 1)
  })
})
