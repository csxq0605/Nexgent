import { randomUUID } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  IMPROVER_V0,
  resolveWorkspaceLayout,
  ZERO_USAGE,
  type CapabilityDecision,
  type ImprovementSignal,
  type ImproverComparison,
  type LedgerRecord,
  type WorkspaceLayout,
} from '@nexgent/kernel'
import { CapabilityStore, improversDir, ImproverStore, projectEpoch } from '@nexgent/capabilities'
import { JsonlLedger, validateImprovementFile } from '@nexgent/session'
import {
  createImprovementStages,
  createJob,
  ImprovementHost,
  improvementsDir,
  jobPaths,
  listJobs,
  metaProposeTools,
  readJob,
  readQueue,
  runImprovementJob,
  startExplicitMetaJob,
  transitionJob,
  type GateOutcome,
  type ImprovementSession,
  type ImprovementSessionRequest,
  type ImprovementSessionRunner,
  type MetaChangeState,
  type TrialStarter,
} from '../src/index.js'
import { callTool, feedbackTask, proposeIn, report, type FeedbackTaskFixture } from './history.js'
import { stagesTo, tempDir } from './helpers.js'

/**
 * Step 6 W2 part 2 (ADR 0008 decisions 3–4): meta jobs with a scripted
 * session runner and gate. Each scripted turn writes one model request to
 * the ledger the runner was given (the real project's for comparison arms),
 * so the arms' costs are known and priced.
 */
const META = { meta: { enabled: true, everyJobs: 3 } }
const PRICE = (_model: string, usage: { inputTokens: number | 'unknown' }) => (usage.inputTokens === 'unknown' ? 'unknown' as const : usage.inputTokens * 1e-6)

type Script = (request: ImprovementSessionRequest, index: number) => Promise<void> | void

/** A runner whose turns run the script of their phase (an arm's phases are keyed `<arm>:<phase>`). */
function runner(scripts: Record<string, Script | undefined>, tokens = 100): ImprovementSessionRunner & { opened: ImprovementSessionRequest[] } {
  const opened: ImprovementSessionRequest[] = []
  return {
    opened,
    async open(request): Promise<ImprovementSession> {
      opened.push(request)
      let index = 0
      const ledger = new JsonlLedger({ ledgersDir: resolveWorkspaceLayout(request.ledgerRoot ?? request.projectRoot).ledgers })
      return {
        sessionId: request.sessionId,
        async send() {
          const key = request.comparisonArm === undefined ? request.phase : `${request.comparisonArm}:${request.phase}`
          await scripts[key]?.(request, index++)
          const usage = { ...ZERO_USAGE, inputTokens: tokens, totalTokens: tokens }
          await ledger.append({
            type: 'llm.request.end', sessionId: request.sessionId, requestId: randomUUID(), provider: 'scripted', endpoint: 'scripted', model: 'claude-sonnet-5-5',
            status: 'ok', usage, latencyMs: 1, finishReason: 'stop', improvementId: request.jobId, improvementPhase: request.phase, improverVersion: request.improverVersion,
            ...(request.metaJobId === undefined ? {} : { metaJobId: request.metaJobId, comparisonArm: request.comparisonArm }),
          } as never)
          return { outcome: 'completed', usage, requestCount: 1 }
        },
        async close() {},
      }
    },
  }
}

/** A gate that decides as told per arm (`real` for a job outside any comparison). */
function gate(outcomes: { real?: 'adopted' | 'rejected'; parent?: 'adopted' | 'rejected'; child?: 'adopted' | 'rejected' }): TrialStarter & { calls: { arm: string; root: string; epoch?: string }[] } {
  const starter = async ({ layout, candidateId, job, epoch }: Parameters<TrialStarter>[0]): Promise<GateOutcome> => {
    const arm = job.arm?.arm ?? 'real'
    starter.calls.push({ arm, root: layout.root, ...(epoch === undefined ? {} : { epoch }) })
    const outcome = outcomes[arm] ?? 'rejected'
    const trialId = randomUUID()
    const decision: CapabilityDecision = await new CapabilityStore(layout.capabilities).recordDecision({
      outcome, reason: outcome === 'adopted' ? 'quality-up' : 'quality-down', trigger: 'gate', candidateId, trialId, fromVersion: 'baseline',
      toVersion: outcome === 'adopted' ? 'a'.repeat(64) : 'baseline', detail: outcome,
    })
    return { status: 'decided', trialId, decision }
  }
  starter.calls = [] as { arm: string; root: string; epoch?: string }[]
  return starter
}

function signal(fixture: FeedbackTaskFixture): ImprovementSignal {
  return { kind: 'feedback', feedbackId: fixture.feedback.id, sessionId: fixture.sessionId, deliverableId: fixture.feedback.deliverableId, version: 1, rating: 2, at: new Date().toISOString() }
}

const diagnoseKind = (fixture: FeedbackTaskFixture, kind = 'function-module'): Script => async request => {
  await callTool(request, 'improve_report_diagnosis', report(fixture, kind))
}

const proposeInCopy = (fixture: FeedbackTaskFixture): Script => async request => {
  await proposeIn(join(request.workspaceRoot!, '.nexgent', 'capabilities'), request.sessionId, fixture.taskId)
}

const CHANGE = { op: 'set-comparison-param', param: 'repeats', value: 3 }

/** The source job (a finished feedback job), then the meta sessions' scripts. */
async function withSource(outcome: 'adopted' | 'rejected' = 'adopted') {
  const fixture = await feedbackTask(true, META)
  const directory = improvementsDir(fixture.layout)
  const source = await createJob(directory, { trigger: 'feedback-count', items: [signal(fixture)] })
  const sourceRunner = runner({ diagnose: diagnoseKind(fixture), propose: proposeInCopy(fixture) })
  await runImprovementJob(fixture.layout, source.id, { stages: createImprovementStages({ runner: sourceRunner, startTrial: gate({ real: outcome }) }), chain: false })
  expect((await readJob(directory, source.id)).status).toBe(outcome)
  const metaScripts = {
    'meta-diagnose': async (request: ImprovementSessionRequest) => {
      const listed = await callTool(request, 'improve_list_jobs', {})
      expect(listed.content).toContain(source.id)
      await callTool(request, 'improve_report_meta_diagnosis', { findings: [{ stage: 'trial', label: 'the gate compared too few runs to be sure', jobIds: [source.id] }], hypothesis: 'More runs per case would make the gate decide more reliably.', proposal: 'change' })
    },
    'meta-propose': async (request: ImprovementSessionRequest) => {
      const parent = JSON.parse((await callTool(request, 'improve_read_improver', {})).content as string) as { version: string }
      expect(parent.version).toBe('v0')
      await callTool(request, 'improve_propose_change', { change: CHANGE, rationale: 'Three runs per case.' })
    },
  }
  return { fixture, directory, source, metaScripts }
}

async function ledgerOf(layout: WorkspaceLayout, type: LedgerRecord['type']): Promise<LedgerRecord[]> {
  const records: LedgerRecord[] = []
  for await (const record of new JsonlLedger({ ledgersDir: layout.ledgers }).read({ types: [type] })) records.push(record)
  return records
}

describe('meta jobs: counting and the trigger (ADR 0008 decision 3)', () => {
  it('the K-th finished job starts a meta job, the (K-1)-th does not; cancelled and meta jobs are not counted', async () => {
    const fixture = await feedbackTask(true, META)
    const directory = improvementsDir(fixture.layout)
    const finished: string[] = []
    for (const end of ['rejected', 'none'] as const) {
      const job = await createJob(directory, { trigger: 'explicit', items: [] })
      await runImprovementJob(fixture.layout, job.id, { stages: stagesTo(end), chain: false })
      finished.push(job.id)
    }
    const cancelled = await createJob(directory, { trigger: 'explicit', items: [] })
    await transitionJob(directory, cancelled.id, 'cancelled')
    expect((await listJobs(directory)).filter(job => job.kind === 'meta')).toEqual([])
    expect((await readQueue(directory))?.metaPending).toEqual(finished)

    const third = await createJob(directory, { trigger: 'explicit', items: [] })
    const result = await runImprovementJob(fixture.layout, third.id, { stages: stagesTo('diagnose-failed'), chain: false })
    expect(result.jobs.map(job => job.id)).toEqual([third.id])
    const [meta] = (await listJobs(directory)).filter(job => job.kind === 'meta')
    expect(meta).toMatchObject({ kind: 'meta', trigger: 'job-count', status: 'queued', meta: { basis: [...finished, third.id], parentVersion: 'v0' } })
    expect(validateImprovementFile('job', meta)).toEqual([])
    const queue = await readQueue(directory)
    expect(queue).toMatchObject({ activeJobId: meta!.id, metaPending: [], metaCounted: [...finished, third.id] })
  })

  it('with the switch off finished jobs are still counted but no meta job starts', async () => {
    const fixture = await feedbackTask(true)
    const directory = improvementsDir(fixture.layout)
    for (let index = 0; index < 3; index += 1) {
      const job = await createJob(directory, { trigger: 'explicit', items: [] })
      await runImprovementJob(fixture.layout, job.id, { stages: stagesTo('rejected'), chain: false })
    }
    expect((await listJobs(directory)).some(job => job.kind === 'meta')).toBe(false)
    expect((await readQueue(directory))?.metaPending).toHaveLength(3)
  })
})

describe('a meta job end to end (scripted)', () => {
  it('diagnoses, proposes one change, runs both arms in copies, adopts the child whose offspring passed the gate, and the next real job runs on it', async () => {
    const { fixture, directory, source, metaScripts } = await withSource()
    const copies = await tempDir()
    const meta = await startExplicitMetaJob(directory, { parentVersion: 'v0' })
    const scripted = runner({
      ...metaScripts,
      'parent:diagnose': diagnoseKind(fixture),
      'parent:propose': proposeInCopy(fixture),
      'child:diagnose': diagnoseKind(fixture),
      'child:propose': proposeInCopy(fixture),
    })
    const startTrial = gate({ parent: 'rejected', child: 'adopted' })
    await runImprovementJob(fixture.layout, meta.id, { stages: createImprovementStages({ runner: scripted, startTrial, tempRoot: copies, priceUsd: PRICE }), chain: false })

    const done = await readJob(directory, meta.id)
    const store = new ImproverStore(improversDir(fixture.layout))
    const childVersion = done.meta?.childVersion
    expect(childVersion).toMatch(/^[a-f0-9]{64}$/)
    expect(done).toMatchObject({ status: 'adopted', kind: 'meta', improverVersion: 'v0', meta: { parentVersion: 'v0', diagnosed: { proposal: 'change', attempts: 1 }, compared: { outcome: 'adopt', reason: 'gate-passed' }, revision: 1 } })
    expect(validateImprovementFile('job', done)).toEqual([])
    expect(Object.keys(done.phases).sort()).toEqual(['compare', 'meta-diagnose', 'meta-propose'])
    expect((await store.activation()).version).toBe(childVersion)
    expect((await store.chain()).revisions.at(-1)).toMatchObject({ type: 'adopt', trigger: 'meta-job', jobId: meta.id, version: childVersion })

    // The two meta sessions were opened on the real project with exactly their tools; the arms in their copies, attributed to the meta job.
    const phases = scripted.opened.map(request => `${request.comparisonArm ?? 'real'}:${request.phase}`)
    expect(phases).toEqual(['real:meta-diagnose', 'real:meta-propose', 'parent:diagnose', 'parent:propose', 'child:diagnose', 'child:propose'])
    expect(scripted.opened[0]!.tools!.map(tool => tool.definition.name)).toEqual(['improve_list_jobs', 'improve_read_job', 'improve_read_session', 'improve_read_ledger', 'improve_report_meta_diagnosis'])
    expect(scripted.opened[1]!.tools!.map(tool => tool.definition.name)).toEqual(['improve_read_improver', 'improve_read_job', 'improve_propose_change'])
    const arms = scripted.opened.slice(2)
    expect(arms.every(request => request.metaJobId === meta.id && request.ledgerRoot === fixture.layout.root && request.projectRoot !== fixture.layout.root)).toBe(true)
    expect(arms.map(request => request.improverVersion)).toEqual(['v0', 'v0', childVersion, childVersion])
    expect(startTrial.calls.map(call => call.arm)).toEqual(['parent', 'child'])
    expect(startTrial.calls.every(call => call.root !== fixture.layout.root)).toBe(true)
    // Each arm's gate is held to the origin's evaluator epoch, the project's.
    expect(startTrial.calls.map(call => call.epoch)).toEqual([await projectEpoch(fixture.layout), await projectEpoch(fixture.layout)])

    // The records: meta diagnosis, change and comparison, all schema-valid.
    const paths = jobPaths(directory, meta.id)
    const metaDiagnosis = JSON.parse(await readFile(paths.metaDiagnosis, 'utf8')) as unknown
    expect(validateImprovementFile('metaDiagnosis', metaDiagnosis)).toEqual([])
    expect(metaDiagnosis).toMatchObject({ improverVersion: 'v0', statusCounts: { adopted: 1 }, proposal: 'change' })
    const change = JSON.parse(await readFile(paths.change, 'utf8')) as unknown
    expect(change).toMatchObject({ parentVersion: 'v0', childVersion, change: CHANGE })
    expect((await store.load(childVersion!)).comparison.repeats).toBe(3)
    const comparison = JSON.parse(await readFile(paths.comparison, 'utf8')) as ImproverComparison
    expect(validateImprovementFile('comparison', comparison)).toEqual([])
    expect(comparison.origin).toMatchObject({ sourceJobId: source.id, feedbackIds: [fixture.feedback.id], capabilityVersion: 'baseline' })
    expect(comparison.parent.origin).toEqual(comparison.origin)
    expect(comparison.child.origin).toEqual(comparison.origin)
    expect(comparison.parent).toMatchObject({ arm: 'parent', improverVersion: 'v0', status: 'rejected' })
    expect(comparison.child).toMatchObject({ arm: 'child', improverVersion: childVersion, status: 'adopted' })
    expect(comparison.child.candidateId).toBeDefined()
    expect(comparison.parent.cost.estimatedUsd).toBeCloseTo(2 * 100e-6)
    expect(comparison.verdict).toEqual({ outcome: 'adopt', reason: 'gate-passed' })
    expect(comparison.kept).toBeUndefined()
    // Copies are gone, and nothing of the arms reached the real project's jobs or capabilities.
    expect((await readdir(copies)).filter(name => name.startsWith('nexgent-arm-'))).toEqual([])
    expect((await listJobs(directory)).map(job => job.id).sort()).toEqual([source.id, meta.id].sort())
    expect((await new CapabilityStore(fixture.layout.capabilities).decisions())).toHaveLength(1)

    // Ledger: arm requests carry the meta job and arm; improvement.end of the meta job has its kind and child.
    const requests = await ledgerOf(fixture.layout, 'llm.request.end')
    const armRequests = requests.filter(record => record.metaJobId === meta.id)
    expect(armRequests.map(record => record.comparisonArm)).toEqual(['parent', 'parent', 'child', 'child'])
    expect(done.phases.compare?.requestCount).toBe(4)
    const ends = (await ledgerOf(fixture.layout, 'improvement.end')).filter(record => record.type === 'improvement.end' && record.jobId === meta.id)
    expect(ends).toEqual([expect.objectContaining({ kind: 'meta', status: 'adopted', childVersion, improverVersion: 'v0' })])

    // The next real job pins the child.
    const next = await createJob(directory, { trigger: 'explicit', items: [signal(fixture)] })
    await runImprovementJob(fixture.layout, next.id, { stages: createImprovementStages({ runner: runner({ diagnose: diagnoseKind(fixture, 'none') }), startTrial }), chain: false })
    expect(await readJob(directory, next.id)).toMatchObject({ status: 'no-proposal', improverVersion: childVersion })
    const nextEnd = (await ledgerOf(fixture.layout, 'improvement.end')).find(record => record.type === 'improvement.end' && record.jobId === next.id)
    expect(nextEnd).toMatchObject({ improverVersion: childVersion })
  })

  it('a child without offspring is not adopted (no-offspring), and keepCopies keeps both copies', async () => {
    const { fixture, directory, metaScripts } = await withSource()
    const copies = await tempDir()
    const meta = await startExplicitMetaJob(directory, { parentVersion: 'v0', keepCopies: true })
    const scripted = runner({ ...metaScripts, 'parent:diagnose': diagnoseKind(fixture), 'parent:propose': proposeInCopy(fixture), 'child:diagnose': diagnoseKind(fixture) })
    await runImprovementJob(fixture.layout, meta.id, { stages: createImprovementStages({ runner: scripted, startTrial: gate({ parent: 'adopted', child: 'adopted' }), tempRoot: copies, priceUsd: PRICE }), chain: false })
    const done = await readJob(directory, meta.id)
    expect(done).toMatchObject({ status: 'rejected', meta: { compared: { outcome: 'reject', reason: 'no-offspring' } } })
    expect((await new ImproverStore(improversDir(fixture.layout)).activation()).version).toBe('v0')
    const comparison = JSON.parse(await readFile(jobPaths(directory, meta.id).comparison, 'utf8')) as ImproverComparison
    expect(comparison.child).toMatchObject({ status: 'failed' })
    expect(comparison.child.candidateId).toBeUndefined()
    expect(comparison.kept?.parent?.root.startsWith(copies)).toBe(true)
    expect(comparison.kept?.child?.bytes).toBeGreaterThan(0)
    expect((await readdir(copies)).filter(name => name.startsWith('nexgent-arm-')).sort()).toHaveLength(2)
    // Each arm job's improvement.end (in its kept copy) names its pinned improver, the meta job and the arm.
    for (const arm of ['parent', 'child'] as const) {
      const ends = await ledgerOf(resolveWorkspaceLayout(comparison.kept![arm]!.root), 'improvement.end')
      expect(ends.filter(record => record.type === 'improvement.end' && record.jobId === comparison[arm].jobId)).toEqual([
        expect.objectContaining({ improvementId: comparison[arm].jobId, improverVersion: arm === 'parent' ? 'v0' : done.meta!.childVersion, metaJobId: meta.id, comparisonArm: arm }),
      ])
    }
  })

  it('without a price table every arm cost is unknown, so nothing is adopted (unknown-arm); copies too large to keep are removed', async () => {
    const { fixture, directory, metaScripts } = await withSource()
    const copies = await tempDir()
    const meta = await startExplicitMetaJob(directory, { parentVersion: 'v0', keepCopies: true })
    const scripted = runner({ ...metaScripts, 'parent:diagnose': diagnoseKind(fixture), 'parent:propose': proposeInCopy(fixture), 'child:diagnose': diagnoseKind(fixture), 'child:propose': proposeInCopy(fixture) })
    await runImprovementJob(fixture.layout, meta.id, { stages: createImprovementStages({ runner: scripted, startTrial: gate({ parent: 'rejected', child: 'adopted' }), tempRoot: copies, keepMaxBytes: 1 }), chain: false })
    expect(await readJob(directory, meta.id)).toMatchObject({ status: 'rejected', meta: { compared: { reason: 'unknown-arm' } } })
    const comparison = JSON.parse(await readFile(jobPaths(directory, meta.id).comparison, 'utf8')) as ImproverComparison
    expect(comparison.kept).toBeUndefined()
    expect(await readdir(copies)).toEqual([])
    expect(await readFile(jobPaths(directory, meta.id).log, 'utf8')).toContain('too large to keep')
  })

  it('a meta diagnosis of none ends no-proposal without a proposal or comparison', async () => {
    const { fixture, directory, source } = await withSource()
    const meta = await startExplicitMetaJob(directory, { parentVersion: 'v0' })
    const scripted = runner({
      'meta-diagnose': async request => {
        const refused = await callTool(request, 'improve_report_meta_diagnosis', { findings: [{ stage: 'trial', label: 'x', jobIds: [randomUUID()] }], hypothesis: 'h', proposal: 'change' })
        expect(refused).toMatchObject({ isError: true })
        expect(refused.content).toContain('no improvement job')
        await callTool(request, 'improve_report_meta_diagnosis', { findings: [{ stage: 'other', label: 'taste', jobIds: [source.id] }], hypothesis: 'The feedback was about taste.', proposal: 'none' })
      },
    })
    await runImprovementJob(fixture.layout, meta.id, { stages: createImprovementStages({ runner: scripted, startTrial: gate({}) }), chain: false })
    expect(await readJob(directory, meta.id)).toMatchObject({ status: 'no-proposal', meta: { diagnosed: { proposal: 'none', attempts: 2 } } })
    expect(scripted.opened).toHaveLength(1)
  })

  it('stops at once when the meta budget is spent, and leaves the improvement budget alone', async () => {
    const fixture = await feedbackTask(true, { meta: { enabled: true, everyJobs: 3, budget: { maxTokens: 100, windowDays: 30 } } })
    const directory = improvementsDir(fixture.layout)
    const spent = await startExplicitMetaJob(directory, { parentVersion: 'v0' })
    await transitionJob(directory, spent.id, 'failed', { patch: { phases: { 'meta-diagnose': { usage: { ...ZERO_USAGE, inputTokens: 500, totalTokens: 500 }, requestCount: 1 } } } })
    const { releaseSlot } = await import('../src/queue.js')
    await releaseSlot(directory, spent.id, { autoStart: false })
    const meta = await startExplicitMetaJob(directory, { parentVersion: 'v0' })
    const scripted = runner({})
    await runImprovementJob(fixture.layout, meta.id, { stages: createImprovementStages({ runner: scripted, startTrial: gate({}) }), chain: false })
    expect(await readJob(directory, meta.id)).toMatchObject({ status: 'budget-exhausted' })
    expect(scripted.opened).toHaveLength(0)
    const host = new ImprovementHost(fixture.layout, { launch: (_layout, jobId) => ({ jobId, pid: process.pid, exited: Promise.resolve(0) }) })
    expect((await host.metaBudgetStatus()).exhausted).toBe(true)
    expect((await host.budgetStatus()).used).toBe(0)
    await expect(host.runMeta()).rejects.toMatchObject({ code: 'improvement/budget-exhausted' })
  })

  it('a meta job whose process was killed is marked interrupted on the next start and not re-run', async () => {
    const fixture = await feedbackTask(true, META)
    const directory = improvementsDir(fixture.layout)
    const meta = await startExplicitMetaJob(directory, { parentVersion: 'v0' })
    await transitionJob(directory, meta.id, 'meta-diagnosing')
    await writeFile(jobPaths(directory, meta.id).lock, '999999999\n')
    const host = new ImprovementHost(fixture.layout, {})
    const [marked] = await host.recover()
    expect(marked).toMatchObject({ id: meta.id, kind: 'meta', status: 'interrupted' })
    expect((await readQueue(directory))?.activeJobId).toBeUndefined()
    const again = await runImprovementJob(fixture.layout, meta.id, { stages: createImprovementStages({ runner: runner({}), startTrial: gate({}) }), chain: false })
    expect(again.skipped).toContain('interrupted')
  })
})

describe('the meta-propose tools', () => {
  it('refuse more than one change, evaluator fields and out-of-bounds values; accept one change and store the child', async () => {
    const fixture = await feedbackTask(true, META)
    const directory = improvementsDir(fixture.layout)
    const job = await startExplicitMetaJob(directory, { parentVersion: 'v0' })
    const state: MetaChangeState = { attempts: 0 }
    const sessionId = randomUUID()
    const tools = metaProposeTools({ layout: fixture.layout, job, sessionId, improver: { version: 'v0', bundle: IMPROVER_V0 }, state })
    const propose = tools.find(tool => tool.definition.name === 'improve_propose_change')!
    const call = (input: unknown) => propose.handler(input, {} as never)
    expect((await call({ change: { op: 'set-comparison-param', param: 'repeats', value: 3, kinds: ['skill'] }, rationale: 'r' })).content).toContain('not-one-change')
    expect((await call({ change: { op: 'set-comparison-param', param: 'guardCases', value: 3 }, rationale: 'r' })).content).toContain('evaluator-field')
    expect((await call({ change: { op: 'set-comparison-param', param: 'repeats', value: 9 }, rationale: 'r' })).content).toContain('out-of-bounds')
    expect(state.attempts).toBe(3)
    expect((await call({ change: CHANGE, rationale: 'r' })).content).toContain('No proposals are left')

    const fresh: MetaChangeState = { attempts: 0 }
    const again = metaProposeTools({ layout: fixture.layout, job, sessionId, improver: { version: 'v0', bundle: IMPROVER_V0 }, state: fresh }).find(tool => tool.definition.name === 'improve_propose_change')!
    const accepted = await again.handler({ change: { op: 'set-proposal-kinds', kinds: ['skill', 'function-module'] }, rationale: 'Fewer kinds.' }, {} as never)
    expect(accepted.isError).toBeUndefined()
    const childVersion = fresh.accepted!.childVersion
    expect((await new ImproverStore(improversDir(fixture.layout)).load(childVersion)).proposal.kinds).toEqual(['skill', 'function-module'])
    expect((await new ImproverStore(improversDir(fixture.layout)).activation()).version).toBe('v0')
  })
})
