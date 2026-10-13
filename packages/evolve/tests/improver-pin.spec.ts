import { createHash, randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  canonicalImproverText,
  IMPROVER_V0,
  NexgentError,
  type CapabilityDecision,
  type ImproverBundle,
  type ImproverComparisonParams,
  type ImproverVersion,
  type ImprovementSignal,
} from '@nexgent/kernel'
import { CapabilityStore, improversDir, ImproverStore } from '@nexgent/capabilities'
import { validateImprovementFile } from '@nexgent/session'
import {
  createImprovementStages,
  createJob,
  improvementsDir,
  readJob,
  runImprovementJob,
  trialComparison,
  type GateOutcome,
  type ImproverSource,
  type TrialStarter,
} from '../src/index.js'
import { callTool, feedbackTask, proposeIn, report, scriptedRunner, type FeedbackTaskFixture, type TurnScript } from './history.js'

/**
 * Step 6 W2 part 1 (ADR 0008 decision 1): a job pins the improver in force
 * when it starts, writes the version into `job.json` and the session
 * requests, and runs on that bundle to the end; an improver adopted while it
 * runs only affects the next job. The default source is the project's
 * `ImproverStore`; the stand-in below lets a test switch versions freely.
 */
const CUSTOM: ImproverBundle = {
  formatVersion: 1,
  diagnosis: { paragraphs: ['You diagnose improvement jobs of this project; propose only {{allowedKinds}}.', ...IMPROVER_V0.diagnosis.paragraphs.slice(1)] },
  proposal: { kinds: ['skill'], briefs: { skill: `# Custom brief for {{jobId}}\n{{hypothesis}}\n{{failures}}\nBuild one {{kind}}.\n# The task` } },
  comparison: { selectionCases: 3, repeats: 3, selection: 'recency' },
}
const CUSTOM_VERSION: ImproverVersion = createHash('sha256').update(canonicalImproverText(CUSTOM)).digest('hex')

/** A stand-in store whose version in force the test switches. */
function source(initial: ImproverVersion = 'v0'): ImproverSource & { inForce: ImproverVersion; loads: ImproverVersion[] } {
  const bundleOf = (version: ImproverVersion): ImproverBundle => {
    if (version === 'v0') return IMPROVER_V0
    if (version === CUSTOM_VERSION) return CUSTOM
    throw new NexgentError('improver/not-found', `no improver ${version}`)
  }
  const store = {
    inForce: initial,
    loads: [] as ImproverVersion[],
    async current() {
      return { version: store.inForce, bundle: bundleOf(store.inForce) }
    },
    async load(_layout: unknown, version: ImproverVersion) {
      store.loads.push(version)
      return bundleOf(version)
    },
  }
  return store
}

function signal(fixture: FeedbackTaskFixture): ImprovementSignal {
  return { kind: 'feedback', feedbackId: fixture.feedback.id, sessionId: fixture.sessionId, deliverableId: fixture.feedback.deliverableId, version: 1, rating: 2, at: new Date().toISOString() }
}

const queuedJob = (fixture: FeedbackTaskFixture) => createJob(improvementsDir(fixture.layout), { trigger: 'feedback-count', items: [signal(fixture)] })

/** A gate that records what it was asked and answers as told. */
function gate(outcome: 'adopted' | 'waiting'): TrialStarter & { comparisons: ImproverComparisonParams[] } {
  const starter = async ({ layout, candidateId, comparison }: Parameters<TrialStarter>[0]): Promise<GateOutcome> => {
    starter.comparisons.push(comparison)
    if (outcome === 'waiting') return { status: 'waiting', detail: 'not enough past tasks' }
    const trialId = '22222222-2222-4222-8222-222222222222'
    const decision: CapabilityDecision = await new CapabilityStore(layout.capabilities).recordDecision({
      outcome: 'adopted', reason: 'quality-up', trigger: 'gate', candidateId, trialId, fromVersion: 'baseline', toVersion: 'a'.repeat(64), detail: 'better',
    })
    return { status: 'decided', trialId, decision }
  }
  starter.comparisons = [] as ImproverComparisonParams[]
  return starter
}

const reportKind = (fixture: FeedbackTaskFixture, kind: string, then?: () => void): TurnScript => async request => {
  await callTool(request, 'improve_report_diagnosis', report(fixture, kind))
  then?.()
}

const proposeInCopy = (fixture: FeedbackTaskFixture): TurnScript => async request => {
  await proposeIn(join(request.workspaceRoot!, '.nexgent', 'capabilities'), request.sessionId, fixture.taskId)
}

describe('a job runs on the improver it pinned when it started', () => {
  it('without an improver store the job pins v0, writes it into job.json and both sessions, and the gate gets v0\'s parameters', async () => {
    const fixture = await feedbackTask()
    const job = await queuedJob(fixture)
    const runner = scriptedRunner({ diagnose: reportKind(fixture, 'function-module'), propose: proposeInCopy(fixture) })
    const startTrial = gate('adopted')
    await runImprovementJob(fixture.layout, job.id, { stages: createImprovementStages({ runner, startTrial }) })
    const done = await readJob(improvementsDir(fixture.layout), job.id)
    expect(done).toMatchObject({ status: 'adopted', improverVersion: 'v0' })
    expect(validateImprovementFile('job', done)).toEqual([])
    expect(runner.opened.map(request => [request.phase, request.improverVersion])).toEqual([['diagnose', 'v0'], ['propose', 'v0']])
    expect(startTrial.comparisons).toEqual([{ selectionCases: 2, repeats: 2, selection: 'similarity' }])
  })

  it('an improver adopted while the job runs does not change it; the next job runs on the new one', async () => {
    const fixture = await feedbackTask()
    const store = new ImproverStore(improversDir(fixture.layout))
    expect((await store.write(CUSTOM)).version).toBe(CUSTOM_VERSION)
    const first = await queuedJob(fixture)
    // A meta job adopts CUSTOM (in the project's improver store) while the first job is diagnosing.
    const adopted: Promise<unknown>[] = []
    const runner = scriptedRunner({ diagnose: reportKind(fixture, 'function-module', () => { adopted.push(store.adopt(CUSTOM_VERSION, { jobId: randomUUID() })) }), propose: proposeInCopy(fixture) })
    const startTrial = gate('adopted')
    await runImprovementJob(fixture.layout, first.id, { stages: createImprovementStages({ runner, startTrial }), chain: false })
    expect(await Promise.all(adopted)).toHaveLength(1)
    expect((await store.activation()).version).toBe(CUSTOM_VERSION)
    const done = await readJob(improvementsDir(fixture.layout), first.id)
    expect(done).toMatchObject({ status: 'adopted', improverVersion: 'v0' })
    expect(runner.texts[0]).toContain(IMPROVER_V0.diagnosis.paragraphs[0])
    expect(runner.texts[1]).toMatch(/^# Improvement job\n/)
    expect(runner.opened.every(request => request.improverVersion === 'v0')).toBe(true)
    expect(startTrial.comparisons).toEqual([{ selectionCases: 2, repeats: 2, selection: 'similarity' }])

    // The next job pins CUSTOM: its policy opens the prompt, and a kind CUSTOM does not propose fails the job.
    const second = await createJob(improvementsDir(fixture.layout), { trigger: 'explicit', items: [] })
    const next = scriptedRunner({ diagnose: reportKind(fixture, 'function-module') })
    await runImprovementJob(fixture.layout, second.id, { stages: createImprovementStages({ runner: next, startTrial }), chain: false })
    const failed = await readJob(improvementsDir(fixture.layout), second.id)
    expect(failed).toMatchObject({ status: 'failed', improverVersion: CUSTOM_VERSION, diagnosed: { proposalKind: 'function-module' } })
    expect(failed.history.at(-1)?.detail).toBe(`The diagnosis suggests a function-module, which improver ${CUSTOM_VERSION} does not propose (it proposes skill).`)
    expect(next.texts[0]).toMatch(/^# Policy\nYou diagnose improvement jobs of this project; propose only skill\.\n/)
    expect(next.opened).toHaveLength(1)
    expect(next.opened[0]?.improverVersion).toBe(CUSTOM_VERSION)
  })

  it('a job on a custom improver gets its brief and its comparison parameters (counts never below the project\'s)', async () => {
    const fixture = await feedbackTask()
    const job = await queuedJob(fixture)
    const runner = scriptedRunner({ diagnose: reportKind(fixture, 'skill'), propose: proposeInCopy(fixture) })
    const startTrial = gate('waiting')
    await runImprovementJob(fixture.layout, job.id, { stages: createImprovementStages({ runner, startTrial }), improvers: source(CUSTOM_VERSION) })
    expect(runner.texts[1]).toMatch(new RegExp(`^# Custom brief for ${job.id}\\nNo reusable summary that keeps the region column\\.\\n- task-verification: never checked that the region column is present\\nBuild one skill\\.\\n# The task\\n`))
    expect(startTrial.comparisons).toEqual([{ selectionCases: 3, repeats: 3, selection: 'recency' }])
    expect(await readJob(improvementsDir(fixture.layout), job.id)).toMatchObject({ status: 'waiting-history', improverVersion: CUSTOM_VERSION })

    // Resumed after v0 is back in force (a rollback): the trial still runs on the pinned CUSTOM.
    const improvers = source('v0')
    const resumed = gate('adopted')
    await runImprovementJob(fixture.layout, job.id, { stages: createImprovementStages({ runner: scriptedRunner({}), startTrial: resumed }), improvers })
    expect(await readJob(improvementsDir(fixture.layout), job.id)).toMatchObject({ status: 'adopted', improverVersion: CUSTOM_VERSION })
    expect(resumed.comparisons).toEqual([{ selectionCases: 3, repeats: 3, selection: 'recency' }])
    expect(improvers.loads).toEqual([CUSTOM_VERSION])
  })

  it('a resumed job whose pinned improver can no longer be loaded fails before the trial', async () => {
    const fixture = await feedbackTask()
    const job = await queuedJob(fixture)
    const runner = scriptedRunner({ diagnose: reportKind(fixture, 'skill'), propose: proposeInCopy(fixture) })
    await runImprovementJob(fixture.layout, job.id, { stages: createImprovementStages({ runner, startTrial: gate('waiting') }), improvers: source(CUSTOM_VERSION) })
    const startTrial = gate('adopted')
    const missing = { ...source('v0'), load: async () => { throw new NexgentError('improver/not-found', 'gone') } }
    await runImprovementJob(fixture.layout, job.id, { stages: createImprovementStages({ runner: scriptedRunner({}), startTrial }), improvers: missing })
    expect(await readJob(improvementsDir(fixture.layout), job.id)).toMatchObject({ status: 'failed', improverVersion: CUSTOM_VERSION, error: { code: 'improver/not-found' } })
    expect(startTrial.comparisons).toEqual([])
  })

  it('the project\'s store heals an improver that no longer loads: the job runs on the version it falls back to', async () => {
    const fixture = await feedbackTask()
    const store = new ImproverStore(improversDir(fixture.layout))
    await store.write(CUSTOM)
    await store.adopt(CUSTOM_VERSION, { jobId: randomUUID() })
    await writeFile(join(improversDir(fixture.layout), 'bundles', `${CUSTOM_VERSION}.json`), '{"broken": true}\n')
    const job = await queuedJob(fixture)
    const runner = scriptedRunner({ diagnose: reportKind(fixture, 'none') })
    await runImprovementJob(fixture.layout, job.id, { stages: createImprovementStages({ runner, startTrial: gate('adopted') }) })
    expect(await readJob(improvementsDir(fixture.layout), job.id)).toMatchObject({ status: 'no-proposal', improverVersion: 'v0' })
    expect((await store.chain()).revisions.at(-1)).toMatchObject({ type: 'rollback', trigger: 'load-failure', version: 'v0' })
  })

  it('the gate counts are the larger of the project\'s floor and the improver\'s; the selection is the improver\'s', () => {
    expect(trialComparison({ selectionCases: 2, repeats: 2 }, IMPROVER_V0)).toEqual({ selectionCases: 2, repeats: 2, selection: 'similarity' })
    expect(trialComparison({ selectionCases: 4, repeats: 1 }, CUSTOM)).toEqual({ selectionCases: 4, repeats: 3, selection: 'recency' })
  })
})
