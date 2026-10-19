import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
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
import { CapabilityStore, ImproverStore, projectEpoch, writeBundle } from '@nexgent/capabilities'
import { JsonlLedger, JsonlSessionStore, validateImprovementFile } from '@nexgent/session'
import { LocalDeliverableStore } from '@nexgent/tasking'
import {
  createImprovementStages,
  createJob,
  ImprovementHost,
  improvementsDir,
  jobPaths,
  listJobs,
  metaDiagnosisPrompt,
  metaDiagnosisTools,
  metaProjects,
  metaProposeTools,
  readJob,
  readQueue,
  readUserQueue,
  releaseUserMeta,
  runImprovementJob,
  startExplicitUserMetaJob,
  transitionJob,
  updateJob,
  chooseOrigin,
  adoptedCapabilities,
  userImproversDir,
  userProjectId,
  type GateOutcome,
  type ImprovementSession,
  type ImprovementSessionRequest,
  type ImprovementSessionRunner,
  type MetaChangeState,
  type MetaDiagnosisState,
  type TrialStarter,
} from '../src/index.js'
import { callTool, feedbackTask, proposeIn, report, type FeedbackTaskFixture } from './history.js'
import { home, stagesTo, tempDir, userConfig } from './helpers.js'

/**
 * Step 6 W2 part 2 (ADR 0008 decisions 3–4): meta jobs with a scripted
 * session runner and gate. Each scripted turn writes one model request to
 * the ledger the runner was given (the real project's for comparison arms),
 * so the arms' costs are known and priced. ADR 0012: the improver, the meta
 * queue and the meta settings are the user's (the test's Nexgent home).
 */
const META = { enabled: true, everyJobs: 3 }
const PRICE = (_model: string, usage: { inputTokens: number | 'unknown' }) => (usage.inputTokens === 'unknown' ? 'unknown' as const : usage.inputTokens * 1e-6)

type Script = (request: ImprovementSessionRequest, index: number, text: string) => Promise<void> | void

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
        async send(text: string) {
          const key = request.comparisonArm === undefined ? request.phase : `${request.comparisonArm}:${request.phase}`
          await scripts[key]?.(request, index++, text)
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
  const fixture = await feedbackTask(true)
  const directory = improvementsDir(fixture.layout)
  const source = await createJob(directory, { trigger: 'feedback-count', items: [signal(fixture)] })
  const sourceRunner = runner({ diagnose: diagnoseKind(fixture), propose: proposeInCopy(fixture) })
  await runImprovementJob(fixture.layout, source.id, { stages: createImprovementStages({ runner: sourceRunner, startTrial: gate({ real: outcome }) }), chain: false })
  expect((await readJob(directory, source.id)).status).toBe(outcome)
  const metaScripts = {
    'meta-diagnose': async (request: ImprovementSessionRequest) => {
      const listed = await callTool(request, 'improve_list_jobs', {})
      expect(listed.content).toContain(source.id)
      expect(listed.content).toContain(await userProjectId(fixture.layout.root))
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

/** An explicit meta job in the fixture's project (ADR 0012: the user's slot). */
const explicitMeta = (fixture: FeedbackTaskFixture, keepCopies?: boolean) => startExplicitUserMetaJob(home(), fixture.layout, { parentVersion: 'v0', ...(keepCopies === undefined ? {} : { keepCopies }) })

/** The user's improver line. */
const userStore = () => new ImproverStore(userImproversDir(home()))

async function ledgerOf(layout: WorkspaceLayout, type: LedgerRecord['type']): Promise<LedgerRecord[]> {
  const records: LedgerRecord[] = []
  for await (const record of new JsonlLedger({ ledgersDir: layout.ledgers }).read({ types: [type] })) records.push(record)
  return records
}

describe('meta jobs: counting and the trigger per user (ADR 0012 decision 3)', () => {
  it('the K-th finished job of the user starts a meta job, the (K-1)-th does not; cancelled jobs are not counted; the project queue keeps no meta count', async () => {
    await userConfig(META)
    const fixture = await feedbackTask(true)
    const directory = improvementsDir(fixture.layout)
    const projectId = await userProjectId(fixture.layout.root)
    const finished: string[] = []
    for (const end of ['rejected', 'none'] as const) {
      const job = await createJob(directory, { trigger: 'explicit', items: [] })
      await runImprovementJob(fixture.layout, job.id, { stages: stagesTo(end), chain: false })
      finished.push(job.id)
    }
    const cancelled = await createJob(directory, { trigger: 'explicit', items: [] })
    await transitionJob(directory, cancelled.id, 'cancelled')
    expect((await listJobs(directory)).filter(job => job.kind === 'meta')).toEqual([])
    expect((await readUserQueue(home()))?.pending.map(entry => [entry.projectId, entry.jobId])).toEqual(finished.map(id => [projectId, id]))

    const third = await createJob(directory, { trigger: 'explicit', items: [] })
    const result = await runImprovementJob(fixture.layout, third.id, { stages: stagesTo('diagnose-failed'), chain: false })
    expect(result.jobs.map(job => job.id)).toEqual([third.id])
    const [meta] = (await listJobs(directory)).filter(job => job.kind === 'meta')
    const basis = [...finished, third.id]
    expect(meta).toMatchObject({ kind: 'meta', trigger: 'job-count', status: 'queued', meta: { basis, parentVersion: 'v0', batch: basis.map(jobId => ({ projectId, root: fixture.layout.root, jobId })) } })
    expect(validateImprovementFile('job', meta)).toEqual([])
    const queue = await readUserQueue(home())
    expect(validateImprovementFile('userQueue', queue)).toEqual([])
    expect(queue).toMatchObject({ active: { projectId, jobId: meta!.id }, pending: [], counted: basis.map(id => `${projectId}:${id}`), metaJobs: [{ jobId: meta!.id, root: fixture.layout.root }] })
    // The project's slot and step-6 meta counts are untouched: capability jobs never wait on a meta job.
    const project = await readQueue(directory)
    expect(project?.activeJobId).toBeUndefined()
    expect(project?.metaPending).toBeUndefined()
  })

  it('with the user\'s switch off finished jobs are still counted but no meta job starts; the project\'s old switch is ignored', async () => {
    const fixture = await feedbackTask(true, { meta: META })
    const directory = improvementsDir(fixture.layout)
    for (let index = 0; index < 3; index += 1) {
      const job = await createJob(directory, { trigger: 'explicit', items: [] })
      await runImprovementJob(fixture.layout, job.id, { stages: stagesTo('rejected'), chain: false })
    }
    expect((await listJobs(directory)).some(job => job.kind === 'meta')).toBe(false)
    expect((await readUserQueue(home()))?.pending).toHaveLength(3)
  })

  it('jobs of two projects add up; the meta job lives in the project whose job completed the batch, and this process runs it next', async () => {
    await userConfig(META)
    const first = await feedbackTask(true)
    const second = await feedbackTask(true)
    for (const fixture of [first, second]) {
      const job = await createJob(improvementsDir(fixture.layout), { trigger: 'explicit', items: [] })
      await runImprovementJob(fixture.layout, job.id, { stages: stagesTo('rejected'), chain: false })
    }
    const last = await createJob(improvementsDir(first.layout), { trigger: 'explicit', items: [] })
    // With chaining on, the process runs the meta job it started (it fails: these stages have no meta phases).
    const result = await runImprovementJob(first.layout, last.id, { stages: stagesTo('rejected') })
    expect(result.jobs.map(job => job.kind ?? 'capability')).toEqual(['capability', 'meta'])
    const meta = result.jobs[1]!
    expect(meta).toMatchObject({ status: 'failed' })
    expect((await listJobs(improvementsDir(second.layout))).some(job => job.kind === 'meta')).toBe(false)
    const ids = [await userProjectId(first.layout.root), await userProjectId(second.layout.root), await userProjectId(first.layout.root)]
    expect((await readJob(improvementsDir(first.layout), meta.id)).meta?.batch?.map(entry => entry.projectId)).toEqual(ids)
    // Its end freed the user's slot.
    expect((await readUserQueue(home()))?.active).toBeUndefined()
  })

  it('a project with shareImproverEvidence off is not counted', async () => {
    await userConfig(META)
    const shared = await feedbackTask(true)
    const private_ = await feedbackTask(true, { shareImproverEvidence: false })
    for (const fixture of [private_, private_, shared]) {
      const job = await createJob(improvementsDir(fixture.layout), { trigger: 'explicit', items: [] })
      await runImprovementJob(fixture.layout, job.id, { stages: stagesTo('rejected'), chain: false })
    }
    const queue = await readUserQueue(home())
    expect(queue?.pending.map(entry => entry.projectId)).toEqual([await userProjectId(shared.layout.root)])
    expect(queue?.active).toBeUndefined()
  })
})

describe('a meta job end to end (scripted)', () => {
  it('diagnoses, proposes one change, runs both arms in copies, adopts the child whose offspring passed the gate, and the next real job runs on it', async () => {
    const { fixture, directory, source, metaScripts } = await withSource()
    const copies = await tempDir()
    const meta = await explicitMeta(fixture)
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
    const store = userStore()
    const childVersion = done.meta?.childVersion
    expect(childVersion).toMatch(/^[a-f0-9]{64}$/)
    expect(done).toMatchObject({ status: 'adopted', kind: 'meta', improverVersion: 'v0', improverScope: 'user', meta: { parentVersion: 'v0', diagnosed: { proposal: 'change', attempts: 1 }, compared: { outcome: 'adopt', reason: 'gate-passed' }, revision: 1 } })
    expect(validateImprovementFile('job', done)).toEqual([])
    expect(Object.keys(done.phases).sort()).toEqual(['compare', 'meta-diagnose', 'meta-propose'])
    expect((await store.activation()).version).toBe(childVersion)
    // The arms adopted nothing in the user's line: the one revision is the meta job's.
    expect((await store.chain()).revisions).toEqual([expect.objectContaining({ type: 'adopt', trigger: 'meta-job', jobId: meta.id, version: childVersion })])

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
    // The source job was adopted (solved), so the origin is its feedback task on the version that task ran on (ADR 0009).
    expect(comparison.origin).toMatchObject({ kind: 'feedback-version', sourceJobId: source.id, feedbackIds: [fixture.feedback.id], capabilityVersion: 'baseline', projectId: await userProjectId(fixture.layout.root) })
    expect(await readFile(jobPaths(directory, meta.id).log, 'utf8')).toContain('compare: feedback-version origin')
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
    expect(ends).toEqual([expect.objectContaining({ kind: 'meta', status: 'adopted', childVersion, improverVersion: 'v0', improverScope: 'user' })])
    // The arms were never counted in the user's queue, and the meta job freed the user's slot.
    expect(await readUserQueue(home())).toMatchObject({ pending: [], counted: [`${await userProjectId(fixture.layout.root)}:${source.id}`] })
    expect((await readUserQueue(home()))?.active).toBeUndefined()

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
    const meta = await explicitMeta(fixture, true)
    const scripted = runner({ ...metaScripts, 'parent:diagnose': diagnoseKind(fixture), 'parent:propose': proposeInCopy(fixture), 'child:diagnose': diagnoseKind(fixture) })
    await runImprovementJob(fixture.layout, meta.id, { stages: createImprovementStages({ runner: scripted, startTrial: gate({ parent: 'adopted', child: 'adopted' }), tempRoot: copies, priceUsd: PRICE }), chain: false })
    const done = await readJob(directory, meta.id)
    expect(done).toMatchObject({ status: 'rejected', meta: { compared: { outcome: 'reject', reason: 'no-offspring' } } })
    expect((await userStore().activation()).version).toBe('v0')
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
    const meta = await explicitMeta(fixture, true)
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
    const meta = await explicitMeta(fixture)
    const scripted = runner({
      'meta-diagnose': async request => {
        const refused = await callTool(request, 'improve_report_meta_diagnosis', { findings: [{ stage: 'trial', label: 'x', jobIds: [randomUUID()] }], hypothesis: 'h', proposal: 'change' })
        expect(refused).toMatchObject({ isError: true })
        expect(refused.content).toContain('no improvement job')
        expect(refused.content).toContain('this meta job\'s projects')
        await callTool(request, 'improve_report_meta_diagnosis', { findings: [{ stage: 'other', label: 'taste', jobIds: [source.id] }], hypothesis: 'The feedback was about taste.', proposal: 'none' })
      },
    })
    await runImprovementJob(fixture.layout, meta.id, { stages: createImprovementStages({ runner: scripted, startTrial: gate({}) }), chain: false })
    expect(await readJob(directory, meta.id)).toMatchObject({ status: 'no-proposal', meta: { diagnosed: { proposal: 'none', attempts: 2 } } })
    expect(scripted.opened).toHaveLength(1)
  })

  it('stops at once when the user\'s meta budget is spent, whichever project spent it, and leaves the improvement budget alone', async () => {
    await userConfig({ enabled: true, everyJobs: 3, budget: { maxTokens: 100, windowDays: 30 } })
    const other = await feedbackTask(true)
    const fixture = await feedbackTask(true)
    const directory = improvementsDir(fixture.layout)
    const spent = await explicitMeta(other)
    await transitionJob(improvementsDir(other.layout), spent.id, 'failed', { patch: { phases: { 'meta-diagnose': { usage: { ...ZERO_USAGE, inputTokens: 500, totalTokens: 500 }, requestCount: 1 } } } })
    await releaseUserMeta(home(), spent.id)
    const meta = await explicitMeta(fixture)
    const scripted = runner({})
    await runImprovementJob(fixture.layout, meta.id, { stages: createImprovementStages({ runner: scripted, startTrial: gate({}) }), chain: false })
    expect(await readJob(directory, meta.id)).toMatchObject({ status: 'budget-exhausted' })
    expect(scripted.opened).toHaveLength(0)
    const host = new ImprovementHost(fixture.layout, { launch: (_layout, jobId) => ({ jobId, pid: process.pid, exited: Promise.resolve(0) }) })
    expect((await host.metaBudgetStatus()).exhausted).toBe(true)
    expect((await host.budgetStatus()).used).toBe(0)
    await expect(host.runMeta()).rejects.toMatchObject({ code: 'improvement/budget-exhausted' })
  })

  it('one meta job runs at a time for the user; one whose process was killed is marked interrupted on the next start, frees the slot and is not re-run', async () => {
    const fixture = await feedbackTask(true)
    const other = await feedbackTask(true)
    const directory = improvementsDir(fixture.layout)
    const meta = await explicitMeta(fixture)
    await expect(explicitMeta(other)).rejects.toMatchObject({ code: 'improvement/busy' })
    await transitionJob(directory, meta.id, 'meta-diagnosing')
    await writeFile(jobPaths(directory, meta.id).lock, '999999999\n')
    const host = new ImprovementHost(fixture.layout, {})
    const [marked] = await host.recover()
    expect(marked).toMatchObject({ id: meta.id, kind: 'meta', status: 'interrupted' })
    expect((await readUserQueue(home()))?.active).toBeUndefined()
    await expect(explicitMeta(other)).resolves.toMatchObject({ kind: 'meta' })
    const again = await runImprovementJob(fixture.layout, meta.id, { stages: createImprovementStages({ runner: runner({}), startTrial: gate({}) }), chain: false })
    expect(again.skipped).toContain('interrupted')
  })
})

describe('the meta-propose tools', () => {
  it('refuse more than one change, evaluator fields and out-of-bounds values; accept one change and store the child in the user\'s line', async () => {
    const fixture = await feedbackTask(true)
    const job = await explicitMeta(fixture)
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
    expect((await userStore().load(childVersion)).proposal.kinds).toEqual(['skill', 'function-module'])
    expect((await userStore().activation()).version).toBe('v0')
  })
})

describe('the comparison origin (ADR 0009, ADR 0010)', () => {
  const FEEDBACK_TIME = 'c'.repeat(64)
  const STARTED_ON = 'b'.repeat(64)

  /** A finished feedback job ending `end`, then patched (its start version, its decision). */
  async function finishedJob(fixture: FeedbackTaskFixture, end: Parameters<typeof stagesTo>[0], patch: Parameters<typeof updateJob>[2] = {}) {
    const directory = improvementsDir(fixture.layout)
    const job = await createJob(directory, { trigger: 'feedback-count', items: [signal(fixture)] })
    await runImprovementJob(fixture.layout, job.id, { stages: stagesTo(end), chain: false })
    return updateJob(directory, job.id, patch)
  }

  async function baselinePassedDecision(fixture: FeedbackTaskFixture, baseline: number): Promise<string> {
    const decision = await new CapabilityStore(fixture.layout.capabilities).recordDecision({
      outcome: 'rejected', reason: 'no-improvement', trigger: 'gate', candidateId: randomUUID(), trialId: randomUUID(), fromVersion: 'baseline', toVersion: 'baseline', detail: 'no better than the baseline',
      verdict: { outcome: 'reject', reason: 'no-improvement', passRate: { candidate: 1, baseline }, feedbackPassRate: { candidate: 1, baseline }, costRatio: 1, decidedByReview: false },
    })
    return decision.id
  }

  // A meta job record only (its creation time bounds the origin search).
  const metaJob = async (fixture: FeedbackTaskFixture) => createJob(improvementsDir(fixture.layout), { trigger: 'explicit', items: [], kind: 'meta', meta: { basis: [], parentVersion: 'v0' } })

  it('takes a job that did not solve its feedback over a later solved one; an adoption between its task and its start puts the arms on the task\'s version', async () => {
    const fixture = await feedbackTask(true, undefined, FEEDBACK_TIME)
    const unresolved = await finishedJob(fixture, 'rejected', { baseVersion: STARTED_ON })
    await finishedJob(fixture, 'adopted', { baseVersion: STARTED_ON })
    const choice = await chooseOrigin(fixture.layout, await listJobs(improvementsDir(fixture.layout)), await metaJob(fixture))
    expect(choice).toMatchObject({ kind: 'unresolved', job: { id: unresolved.id }, capabilityVersion: FEEDBACK_TIME, startedOn: STARTED_ON })
  })

  it('an unresolved job whose task ran on the version it started on starts the arms there', async () => {
    const fixture = await feedbackTask(true, undefined, STARTED_ON)
    const unresolved = await finishedJob(fixture, 'rejected', { baseVersion: STARTED_ON })
    const choice = await chooseOrigin(fixture.layout, await listJobs(improvementsDir(fixture.layout)), await metaJob(fixture))
    expect(choice).toMatchObject({ kind: 'unresolved', job: { id: unresolved.id }, capabilityVersion: STARTED_ON, startedOn: STARTED_ON })
  })

  it('counts no-proposal and failed jobs as unresolved; without a recorded start version reads the version in force when the job started', async () => {
    for (const end of ['none', 'diagnose-failed'] as const) {
      const fixture = await feedbackTask(true, undefined, FEEDBACK_TIME)
      const job = await finishedJob(fixture, end)
      expect(job.baseVersion).toBeUndefined()
      const choice = await chooseOrigin(fixture.layout, await listJobs(improvementsDir(fixture.layout)), await metaJob(fixture))
      // Nothing was ever adopted in this project: the job started on the baseline; its task's own version wins.
      expect(choice).toMatchObject({ kind: 'unresolved', job: { id: job.id }, capabilityVersion: FEEDBACK_TIME, startedOn: 'baseline' })
    }
  })

  it('skips a job rejected because the baseline already passed every feedback check, falling back to the feedback task\'s own version', async () => {
    const partlyFixture = await feedbackTask(true, undefined, FEEDBACK_TIME)
    const partly = await finishedJob(partlyFixture, 'rejected', { baseVersion: STARTED_ON, decisionId: await baselinePassedDecision(partlyFixture, 0.5) })
    expect(await chooseOrigin(partlyFixture.layout, await listJobs(improvementsDir(partlyFixture.layout)), await metaJob(partlyFixture)))
      .toMatchObject({ kind: 'unresolved', job: { id: partly.id }, capabilityVersion: FEEDBACK_TIME })

    const fixture = await feedbackTask(true, undefined, FEEDBACK_TIME)
    const solvedBefore = await finishedJob(fixture, 'rejected', { baseVersion: STARTED_ON, decisionId: await baselinePassedDecision(fixture, 1) })
    expect(await chooseOrigin(fixture.layout, await listJobs(improvementsDir(fixture.layout)), await metaJob(fixture)))
      .toMatchObject({ kind: 'feedback-version', job: { id: solvedBefore.id }, capabilityVersion: FEEDBACK_TIME })
  })

  it('with only solved jobs replays the latest on the version its feedback task ran on, not the one the job started on', async () => {
    const fixture = await feedbackTask(true, undefined, FEEDBACK_TIME)
    await finishedJob(fixture, 'adopted', { baseVersion: STARTED_ON })
    const latest = await finishedJob(fixture, 'adopted', { baseVersion: STARTED_ON })
    const choice = await chooseOrigin(fixture.layout, await listJobs(improvementsDir(fixture.layout)), await metaJob(fixture))
    expect(choice).toMatchObject({ kind: 'feedback-version', job: { id: latest.id }, capabilityVersion: FEEDBACK_TIME })
  })

  it('without a finished feedback job there is no origin', async () => {
    const fixture = await feedbackTask(true)
    expect(await chooseOrigin(fixture.layout, [], await metaJob(fixture))).toBeUndefined()
  })

  it('a meta job compares on an unresolved origin end to end and records its kind', async () => {
    const { fixture, directory, source, metaScripts } = await withSource('rejected')
    const meta = await explicitMeta(fixture)
    const scripted = runner({ ...metaScripts, 'parent:diagnose': diagnoseKind(fixture), 'parent:propose': proposeInCopy(fixture), 'child:diagnose': diagnoseKind(fixture), 'child:propose': proposeInCopy(fixture) })
    await runImprovementJob(fixture.layout, meta.id, { stages: createImprovementStages({ runner: scripted, startTrial: gate({ parent: 'rejected', child: 'adopted' }), tempRoot: await tempDir(), priceUsd: PRICE }), chain: false })
    const comparison = JSON.parse(await readFile(jobPaths(directory, meta.id).comparison, 'utf8')) as ImproverComparison
    expect(validateImprovementFile('comparison', comparison)).toEqual([])
    expect(comparison.origin).toMatchObject({ kind: 'unresolved', sourceJobId: source.id, capabilityVersion: 'baseline' })
    expect(comparison.parent.origin).toEqual(comparison.origin)
    expect(comparison.child.origin).toEqual(comparison.origin)
    expect(comparison.verdict).toMatchObject({ outcome: 'adopt', reason: 'gate-passed' })
    expect(await readFile(jobPaths(directory, meta.id).log, 'utf8')).toContain(`compare: unresolved origin, job ${source.id} (rejected)`)
  })
})

describe('adopted components in the diagnosis, and arms on the task\'s version (ADR 0010)', () => {
  const POLICY = { formatVersion: 1, name: 'module-test-convention', description: 'Changed modules get their own tests.', instructions: 'Every changed or added module gets test/<module>.test.js with cases.' }

  async function adoptPolicy(layout: WorkspaceLayout): Promise<string> {
    const bundle = await writeBundle(layout.capabilities, [{ kind: 'context-policy', name: POLICY.name, files: [{ path: 'policy.json', content: JSON.stringify(POLICY) }] }])
    await new CapabilityStore(layout.capabilities).adopt(bundle.version, { trigger: 'manual', detail: 'adopted by an earlier improvement (test)' })
    return bundle.version
  }

  it('the diagnosis prompt lists the components the job runs on; with none it has no such section', async () => {
    const fixture = await feedbackTask(true)
    const directory = improvementsDir(fixture.layout)
    const prompts: string[] = []
    const capture: Script = (_request, index, text) => { if (index === 0) prompts.push(text) }
    const first = await createJob(directory, { trigger: 'feedback-count', items: [signal(fixture)] })
    await runImprovementJob(fixture.layout, first.id, { stages: createImprovementStages({ runner: runner({ diagnose: capture }), startTrial: gate({}) }), chain: false })
    expect(prompts[0]).not.toContain('# Adopted capabilities')

    const version = await adoptPolicy(fixture.layout)
    expect(await adoptedCapabilities(fixture.layout)).toEqual({ version, components: [{ kind: 'context-policy', name: POLICY.name, description: POLICY.description, instructions: POLICY.instructions }] })
    const second = await createJob(directory, { trigger: 'feedback-count', items: [signal(fixture)] })
    await runImprovementJob(fixture.layout, second.id, { stages: createImprovementStages({ runner: runner({ diagnose: capture }), startTrial: gate({}) }), chain: false })
    expect(prompts[1]).toContain(`# Adopted capabilities\nThis job runs on capability version ${version}.`)
    expect(prompts[1]).toContain(`- context-policy ${POLICY.name}: ${POLICY.description}\n  Instructions: ${JSON.stringify(POLICY.instructions)}`)
    expect(prompts[1]!.indexOf('# Adopted capabilities')).toBeLessThan(prompts[1]!.indexOf('# Sessions to examine'))
  })

  it('a job that started after an adoption its task did not have: both arms start on the task\'s version, reach the gate, and the gate can tell them apart', async () => {
    const fixture = await feedbackTask(true)
    const directory = improvementsDir(fixture.layout)
    const version = await adoptPolicy(fixture.layout)
    // The job answering the task's feedback started on the adopted version and failed to propose (as in the step-6 trial).
    const job = await createJob(directory, { trigger: 'feedback-count', items: [signal(fixture)] })
    await runImprovementJob(fixture.layout, job.id, { stages: stagesTo('propose-failed'), chain: false })
    await updateJob(directory, job.id, { baseVersion: version })
    expect((await readJob(directory, job.id)).status).toBe('failed')

    const meta = await explicitMeta(fixture)
    const prompts: Record<string, string> = {}
    const diagnose = (arm: string): Script => async (request, index, text) => {
      if (index === 0) prompts[arm] = text
      await diagnoseKind(fixture, 'context-policy')(request, index, text)
    }
    const scripted = runner({
      'meta-diagnose': async request => {
        await callTool(request, 'improve_report_meta_diagnosis', { findings: [{ stage: 'diagnose', label: 'the diagnosis re-proposed a component the project already had', jobIds: [job.id] }], hypothesis: 'Diagnoses should look at the adopted components first.', proposal: 'change' })
      },
      'meta-propose': async request => {
        await callTool(request, 'improve_propose_change', { change: CHANGE, rationale: 'Three runs per case.' })
      },
      'parent:diagnose': diagnose('parent'),
      'parent:propose': proposeInCopy(fixture),
      'child:diagnose': diagnose('child'),
      'child:propose': proposeInCopy(fixture),
    })
    const startTrial = gate({ parent: 'rejected', child: 'adopted' })
    await runImprovementJob(fixture.layout, meta.id, { stages: createImprovementStages({ runner: scripted, startTrial, tempRoot: await tempDir(), priceUsd: PRICE }), chain: false })

    const comparison = JSON.parse(await readFile(jobPaths(directory, meta.id).comparison, 'utf8')) as ImproverComparison
    expect(comparison.origin).toMatchObject({ kind: 'unresolved', sourceJobId: job.id, capabilityVersion: 'baseline' })
    expect(await readFile(jobPaths(directory, meta.id).log, 'utf8')).toContain(`compare: job ${job.id} started on ${version}, after its feedback task ran on baseline; the arms start on the latter`)
    // Both arms produced offspring and reached the gate, which told them apart.
    expect(startTrial.calls.map(call => call.arm)).toEqual(['parent', 'child'])
    expect(comparison.parent.candidateId).toBeDefined()
    expect(comparison.child.candidateId).toBeDefined()
    expect(comparison.verdict).toMatchObject({ outcome: 'adopt', reason: 'gate-passed' })
    // On the task's version nothing was adopted yet, so the arms' diagnoses list no components.
    expect(prompts.parent).toBeDefined()
    expect(prompts.child).not.toContain('# Adopted capabilities')
  })
})

describe('a meta job over several projects (ADR 0012 decisions 4–5)', () => {
  /** A project with one finished feedback job (counted in the user's queue). */
  async function projectWithJob(end: Parameters<typeof stagesTo>[0], comment?: string) {
    const fixture = await feedbackTask(true, undefined, 'baseline', comment)
    const job = await createJob(improvementsDir(fixture.layout), { trigger: 'feedback-count', items: [signal(fixture)] })
    await runImprovementJob(fixture.layout, job.id, { stages: stagesTo(end), chain: false })
    return { fixture, job: await readJob(improvementsDir(fixture.layout), job.id), projectId: await userProjectId(fixture.layout.root) }
  }

  it('the meta-diagnose tools read only the batch\'s projects that still share; others are refused', async () => {
    const a = await projectWithJob('rejected')
    const b = await projectWithJob('adopted')
    const c = await projectWithJob('none')
    // C stops sharing after its job was counted: it leaves the batch.
    await writeFile(c.fixture.layout.configFile, `${JSON.stringify({ version: 1, autoImprove: true, improvement: { shareImproverEvidence: false } })}\n`)
    const meta = await explicitMeta(a.fixture)
    expect(meta.meta?.batch?.map(entry => entry.projectId)).toEqual([a.projectId, b.projectId])
    const projects = await metaProjects(a.fixture.layout, meta)
    expect(projects.map(project => project.projectId)).toEqual([a.projectId, b.projectId])

    const state: MetaDiagnosisState = { attempts: 0 }
    const tools = metaDiagnosisTools({ layout: a.fixture.layout, job: meta, sessionId: randomUUID(), improver: { version: 'v0', bundle: IMPROVER_V0 }, state })
    expect(tools.map(tool => tool.definition.name)).toEqual(['improve_list_jobs', 'improve_read_job', 'improve_read_session', 'improve_read_ledger', 'improve_report_meta_diagnosis'])
    expect((tools[2]!.definition.inputSchema as { required: string[] }).required).toContain('projectId')
    const call = (name: string, input: unknown) => tools.find(tool => tool.definition.name === name)!.handler(input, {} as never)

    const listed = await call('improve_list_jobs', {})
    const lines = listed.content.split('\n').map(line => JSON.parse(line) as { projectId: string; id: string })
    expect(lines.map(line => [line.projectId, line.id])).toEqual([[a.projectId, a.job.id], [b.projectId, b.job.id]])
    expect((await call('improve_list_jobs', { projectId: b.projectId })).content).not.toContain(a.job.id)
    expect(await call('improve_list_jobs', { projectId: c.projectId })).toMatchObject({ isError: true })

    const read = await call('improve_read_job', { jobId: b.job.id })
    expect(read.isError).toBeUndefined()
    expect(read.content).toContain(b.projectId)
    expect(await call('improve_read_job', { jobId: c.job.id })).toMatchObject({ isError: true })

    const session = await call('improve_read_session', { projectId: b.projectId, sessionId: b.fixture.sessionId, types: ['user.message'] })
    expect(session.isError).toBeUndefined()
    expect(session.content).toContain('user.message')
    const refused = await call('improve_read_session', { projectId: c.projectId, sessionId: c.fixture.sessionId })
    expect(refused).toMatchObject({ isError: true })
    expect(refused.content).toContain('not one of this meta job\'s projects')
    expect(await call('improve_read_ledger', { projectId: c.projectId })).toMatchObject({ isError: true })

    expect((await call('improve_report_meta_diagnosis', { findings: [{ stage: 'trial', label: 'x', jobIds: [c.job.id] }], hypothesis: 'h', proposal: 'change' })).content).toContain('no improvement job')
    await call('improve_report_meta_diagnosis', { findings: [{ stage: 'diagnose', label: 'one diagnosis missed the cause', jobIds: [a.job.id, b.job.id] }], hypothesis: 'h', proposal: 'change' })
    expect(state.accepted).toMatchObject({ statusCounts: { rejected: 1, adopted: 1 } })

    const prompt = metaDiagnosisPrompt(meta, { version: 'v0', bundle: IMPROVER_V0 }, projects)
    expect(prompt).toContain(`# Projects\n`)
    expect(prompt).toContain(`- ${b.projectId} (`)
    expect(prompt).toContain(`${b.job.id} (project `)
    expect(prompt).not.toContain(c.projectId)
  })

  it('a change carrying a value of another project\'s feedback or of a deliverable is refused; a project constant is not', async () => {
    const b = await projectWithJob('rejected', 'the total should be 2384.13, not 2384.10')
    // A: the feedback was about a deliverable whose file holds 4410.5 and 1000; 1000 is also in two of A's tasks (a project constant).
    const a = await feedbackTask(true)
    await mkdir(join(a.layout.root, 'out'), { recursive: true })
    await writeFile(join(a.layout.root, 'out', 'summary.csv'), 'region,total\nnorth,4410.5\nthreshold,1000\n')
    const presented = await new LocalDeliverableStore(a.layout).present({ sessionId: a.sessionId, turn: 1, toolCallId: 'call-1', paths: ['out/summary.csv'], summary: 'the summary' })
    const sessions = new JsonlSessionStore({ sessionsDir: a.layout.sessions })
    for (let index = 0; index < 2; index += 1) {
      const sessionId = randomUUID()
      const lock = await sessions.create({ sessionId, projectRoot: a.layout.root, model: 'claude-sonnet-5-5', sandboxMode: 'workspace-write' })
      await sessions.append(sessionId, { type: 'user.message', turn: 1, content: 'list the orders above 1000', source: 'user' })
      await sessions.release(lock)
    }
    const signalA: ImprovementSignal = { kind: 'feedback', feedbackId: randomUUID(), sessionId: a.sessionId, deliverableId: presented.deliverableId, version: presented.version, rating: 2, at: new Date().toISOString() }
    const jobA = await createJob(improvementsDir(a.layout), { trigger: 'feedback-count', items: [signalA] })
    await runImprovementJob(a.layout, jobA.id, { stages: stagesTo('rejected'), chain: false })
    const meta = await explicitMeta(a)
    expect(meta.meta?.batch?.map(entry => entry.jobId)).toEqual([b.job.id, jobA.id])

    const state: MetaChangeState = { attempts: 0 }
    const propose = metaProposeTools({ layout: a.layout, job: meta, sessionId: randomUUID(), improver: { version: 'v0', bundle: IMPROVER_V0 }, state })
      .find(tool => tool.definition.name === 'improve_propose_change')!
    const paragraph = (text: string) => propose.handler({ change: { op: 'set-diagnosis-paragraph', index: IMPROVER_V0.diagnosis.paragraphs.length, text }, rationale: 'r' }, {} as never)
    const fromFeedback = await paragraph('Check that totals such as 2384.13 match the source rows.')
    expect(fromFeedback).toMatchObject({ isError: true })
    expect(fromFeedback.content).toContain('instance-literal')
    expect(fromFeedback.content).toContain('2384.13')
    const fromDeliverable = await paragraph('Rows like north 4410.5 must keep their region.')
    expect(fromDeliverable.content).toContain('instance-literal')
    expect(fromDeliverable.content).toContain(`deliverable:${presented.deliverableId}/v${presented.version}/out/summary.csv`)
    const accepted = await paragraph('When a fixed limit such as 1000 is the user\'s, check the output against it.')
    expect(accepted.isError).toBeUndefined()
    expect(state.accepted?.change).toMatchObject({ op: 'set-diagnosis-paragraph' })
  })

  it('the origin is searched in every project of the batch; the arms run in copies of the origin\'s project and write its ledger', async () => {
    const b = await projectWithJob('rejected')
    const a = await projectWithJob('adopted')
    const meta = await explicitMeta(a.fixture)
    const scripted = runner({
      'meta-diagnose': async request => {
        await callTool(request, 'improve_report_meta_diagnosis', { findings: [{ stage: 'propose', label: 'no candidate solved it', jobIds: [b.job.id] }], hypothesis: 'More runs per case.', proposal: 'change' })
      },
      'meta-propose': async request => {
        await callTool(request, 'improve_propose_change', { change: CHANGE, rationale: 'Three runs per case.' })
      },
      'parent:diagnose': diagnoseKind(b.fixture),
      'parent:propose': proposeInCopy(b.fixture),
      'child:diagnose': diagnoseKind(b.fixture),
      'child:propose': proposeInCopy(b.fixture),
    })
    const startTrial = gate({ parent: 'rejected', child: 'adopted' })
    await runImprovementJob(a.fixture.layout, meta.id, { stages: createImprovementStages({ runner: scripted, startTrial, tempRoot: await tempDir(), priceUsd: PRICE }), chain: false })
    const comparison = JSON.parse(await readFile(jobPaths(improvementsDir(a.fixture.layout), meta.id).comparison, 'utf8')) as ImproverComparison
    expect(validateImprovementFile('comparison', comparison)).toEqual([])
    // B's job did not solve its feedback; A's later one did: B's is the origin.
    expect(comparison.origin).toMatchObject({ kind: 'unresolved', sourceJobId: b.job.id, projectId: b.projectId })
    expect(comparison.parent.origin).toEqual(comparison.origin)
    expect(comparison.verdict).toMatchObject({ outcome: 'adopt', reason: 'gate-passed' })
    const arms = scripted.opened.filter(request => request.comparisonArm !== undefined)
    expect(arms.every(request => request.ledgerRoot === b.fixture.layout.root)).toBe(true)
    expect(startTrial.calls.map(call => call.epoch)).toEqual([await projectEpoch(b.fixture.layout), await projectEpoch(b.fixture.layout)])
    expect((await ledgerOf(b.fixture.layout, 'llm.request.end')).filter(record => record.metaJobId === meta.id)).toHaveLength(4)
    expect((await ledgerOf(a.fixture.layout, 'llm.request.end')).filter(record => record.metaJobId === meta.id)).toHaveLength(0)
    // The child is the user's: adopted once, by the meta job.
    expect((await userStore().chain()).revisions).toEqual([expect.objectContaining({ type: 'adopt', jobId: meta.id, version: meta.meta?.childVersion ?? expect.any(String) })])
  })
})
