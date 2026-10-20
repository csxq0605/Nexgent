/**
 * Step 6 kernel duties (legacy; `data-formats.md` §旧格式（只为读旧项目）):
 * meta-diagnose / meta-propose sessions (read-only tool sets, no components,
 * no task records), the improver version and comparison arm on the session
 * header and every ledger record, and the ledger filters and cost sum that
 * let a meta job's whole spend be read by `metaJobId`.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  IMPROVEMENT_DIAGNOSIS_TOOLS,
  META_DIAGNOSIS_TOOLS,
  META_PROPOSE_TOOLS,
  readLedgerSlice,
  sumLedgerCost,
  ZERO_USAGE,
  type CapabilityAttachInput,
  type Context,
  type Ledger,
  type LedgerRecord,
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

const META = '0f0f0f0f-0000-4000-8000-0000000000aa'
const ARM = '0f0f0f0f-0000-4000-8000-0000000000bb'
const CHILD = 'd'.repeat(64)
const names = (tools: readonly { name: string }[]) => tools.map(tool => tool.name).sort()
const ALL_IMPROVE = [...new Set([...names(IMPROVEMENT_DIAGNOSIS_TOOLS), ...names(META_DIAGNOSIS_TOOLS), ...names(META_PROPOSE_TOOLS)])]

function plainTool(name: string): Tool {
  return {
    definition: { name, description: `${name}.`, inputSchema: { type: 'object', properties: {} }, effects: ['read'], approval: 'never' },
    handler: async () => ({ content: `${name} ran` }),
  }
}

async function boot(script: ScriptStep[]) {
  harness = await bootHarness({ script })
  const { app } = harness
  for (const name of ['read_file', 'write_file', 'bash', 'delegate', 'capability_try', ...ALL_IMPROVE]) app.ctx.tools.register(plainTool(name))
  const begun: unknown[] = []
  const recorder: TaskRecorder = { begin: async input => { begun.push(input) }, end: async () => ({ specs: [], results: [] }) }
  const attaches: Omit<CapabilityAttachInput, 'ctx'>[] = []
  const provide = async (name: string, value: unknown) => {
    await app.ctx.plugin({ name: `fake-${name}`, apply: (ctx: Context) => { ctx.provide(name as never, value as never) } })
  }
  await provide('taskRecorder', recorder)
  await provide('capabilityHost', {
    current: async () => 'c'.repeat(64),
    verify: async () => ({ ok: true }),
    attach: async ({ ctx: _ctx, ...input }: CapabilityAttachInput) => { attaches.push(input); return { components: [] } },
  })
  return { app, begun, attaches }
}

function toolsOf(h: Harness, n: number): string[] {
  return (h.llm.requests[n]?.tools ?? []).map(tool => tool.name).sort()
}

describe('meta improvement sessions', () => {
  for (const [phase, tools] of [['meta-diagnose', META_DIAGNOSIS_TOOLS], ['meta-propose', META_PROPOSE_TOOLS]] as const) {
    it(`opens a ${phase} session with only its read-only tools, no components and no task records`, async () => {
      const { app, begun, attaches } = await boot([toolCallReply('c1', 'write_file', {}), textReply('done')])
      const agent = await app.agents.create({ improvement: { jobId: META, phase, improverVersion: 'v0' } })
      expect(agent.isImprovementSession).toBe(true)
      const start = harness!.store.of(agent.sessionId, 'session.start')[0]
      expect(start).toMatchObject({ purpose: 'improvement', improvement: { jobId: META, phase, improverVersion: 'v0' } })
      expect(start).not.toHaveProperty('capabilityVersion')
      await agent.run('look at the past jobs')
      await agent.close()
      expect(toolsOf(harness!, 0)).toEqual(names(tools))
      // A write the model asks for anyway is refused: the tool is not in scope.
      expect(harness!.store.of(agent.sessionId, 'tool.result')[0]).toMatchObject({ isError: true })
      expect(attaches).toEqual([])
      expect(begun).toEqual([])
      expect(harness!.ledger.records.length).toBeGreaterThan(0)
      for (const record of harness!.ledger.records) expect(record).toMatchObject({ improvementId: META, improvementPhase: phase, improverVersion: 'v0' })
    })
  }

  it('resumes a meta session with its job, improver and scope from the header', async () => {
    const { app } = await boot([textReply('one'), textReply('two')])
    const created = await app.agents.create({ improvement: { jobId: META, phase: 'meta-propose', improverVersion: CHILD } })
    await created.run('one')
    await created.close()
    const resumed = await app.agents.resume(created.sessionId)
    expect(resumed.improvement).toEqual({ jobId: META, phase: 'meta-propose', improverVersion: CHILD })
    await resumed.run('two')
    await resumed.close()
    expect(toolsOf(harness!, 1)).toEqual(names(META_PROPOSE_TOOLS))
  })

  it('stamps a comparison arm on its sessions and records, and keeps it in the header', async () => {
    const { app, attaches } = await boot([textReply('diagnosed'), textReply('replayed')])
    const arm = { metaJobId: META, comparisonArm: 'child' as const, improverVersion: CHILD }
    const diagnose = await app.agents.create({ improvement: { jobId: ARM, phase: 'diagnose', ...arm } })
    expect(harness!.store.of(diagnose.sessionId, 'session.start')[0]).toMatchObject({ improvement: { jobId: ARM, phase: 'diagnose', ...arm } })
    await diagnose.run('diagnose')
    await diagnose.close()
    expect((await app.agents.resume(diagnose.sessionId)).improvement).toEqual({ jobId: ARM, phase: 'diagnose', ...arm })
    const trial = await app.agents.create({ improvement: { jobId: ARM, phase: 'trial', ...arm } })
    await trial.run('replay')
    await trial.close()
    expect(attaches).toHaveLength(1)
    for (const record of harness!.ledger.records) expect(record).toMatchObject({ improvementId: ARM, ...arm })
    expect(harness!.ledger.records.some(record => record.improvementPhase === 'trial')).toBe(true)
    expect(harness!.llm.options.at(-1)).toMatchObject({ improvementId: ARM, improvementPhase: 'trial', ...arm })
  })

  it('hides every improve_* tool from ordinary and propose sessions', async () => {
    const { app } = await boot([textReply('task'), textReply('proposed')])
    const task = await app.agents.create()
    await task.run('task')
    await task.close()
    expect(toolsOf(harness!, 0)).toEqual(['bash', 'capability_try', 'delegate', 'read_file', 'write_file'])
    const propose = await app.agents.create({ improvement: { jobId: ARM, phase: 'propose' } })
    await propose.run('redo')
    await propose.close()
    expect(toolsOf(harness!, 1)).toEqual(['bash', 'capability_try', 'read_file', 'write_file'])
  })

  it('refuses a bad improver version, a lone arm field, and an arm on a meta phase', async () => {
    const { app } = await boot([])
    const refuse = (improvement: object) => expect(app.agents.create({ improvement: improvement as never })).rejects.toMatchObject({ code: 'tool/invalid-input' })
    await refuse({ jobId: META, phase: 'meta-diagnose', improverVersion: 'v1' })
    await refuse({ jobId: ARM, phase: 'diagnose', metaJobId: META })
    await refuse({ jobId: ARM, phase: 'diagnose', comparisonArm: 'parent' })
    await refuse({ jobId: ARM, phase: 'diagnose', metaJobId: META, comparisonArm: 'sibling' })
    await refuse({ jobId: META, phase: 'meta-propose', metaJobId: META, comparisonArm: 'parent' })
  })
})

describe('meta job spend from the ledger', () => {
  const usage = (input: number) => ({ ...ZERO_USAGE, inputTokens: input, outputTokens: 10, totalTokens: input + 10 })
  const request = (tokens: number, attribution: Partial<LedgerRecord>): LedgerRecord => ({
    type: 'llm.request.end', ts: '2026-10-13T00:00:00.000Z', sessionId: 's', requestId: `r${tokens}`, provider: 'p', endpoint: 'e', model: 'm',
    status: 'ok', usage: usage(tokens), latencyMs: 1, ...attribution,
  } as LedgerRecord)
  const records: LedgerRecord[] = [
    request(100, { improvementId: META, improvementPhase: 'meta-diagnose', improverVersion: 'v0' }),
    request(200, { improvementId: META, improvementPhase: 'meta-propose', improverVersion: 'v0' }),
    request(300, { improvementId: 'parent-arm', improvementPhase: 'diagnose', improverVersion: 'v0', metaJobId: META, comparisonArm: 'parent' }),
    request(400, { improvementId: 'child-arm', improvementPhase: 'trial', improverVersion: CHILD, metaJobId: META, comparisonArm: 'child' }),
    request(1000, { improvementId: 'other', improvementPhase: 'diagnose' }),
    request(5000, {}),
  ]
  const ledger: Pick<Ledger, 'read'> = {
    read: async function* (range) {
      for (const record of records) if (range?.types === undefined || range.types.includes(record.type)) yield record
    },
  }

  it('sums a meta job as a whole, per phase, and per arm', async () => {
    const whole = await sumLedgerCost(ledger, { metaJobId: META })
    expect(whole.total).toMatchObject({ requestCount: 4, usage: { inputTokens: 1000, outputTokens: 40 } })
    expect(whole.phases).toEqual({
      'meta-diagnose': { requestCount: 1, usage: usage(100) },
      'meta-propose': { requestCount: 1, usage: usage(200) },
      diagnose: { requestCount: 1, usage: usage(300) },
      trial: { requestCount: 1, usage: usage(400) },
    })
    expect((await sumLedgerCost(ledger, { metaJobId: META, comparisonArm: 'child' })).total).toMatchObject({ requestCount: 1, usage: { inputTokens: 400 } })
    expect((await sumLedgerCost(ledger, { improvementId: 'nothing' })).total).toEqual({ requestCount: 0, usage: ZERO_USAGE })
  })

  it('reads v0 for improvement records without an improver version (step-5 data)', async () => {
    expect((await sumLedgerCost(ledger, { improverVersion: 'v0' })).total.requestCount).toBe(4)
    expect((await sumLedgerCost(ledger, { improverVersion: CHILD })).total.requestCount).toBe(1)
    const slice = await readLedgerSlice(ledger, { metaJobId: META, improvementPhase: 'diagnose' })
    expect(slice.records.map(record => record.improvementId)).toEqual(['parent-arm'])
  })

  it('carries unknown usage through', async () => {
    const unknown: Pick<Ledger, 'read'> = {
      read: async function* () { yield request(1, { improvementId: META, improvementPhase: 'meta-diagnose' }); yield { ...request(2, { improvementId: META, improvementPhase: 'meta-diagnose' }), usage: { ...ZERO_USAGE, inputTokens: 'unknown' } } as LedgerRecord },
    }
    expect((await sumLedgerCost(unknown, { metaJobId: META })).total.usage.inputTokens).toBe('unknown')
  })
})
