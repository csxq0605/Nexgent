import { describe, expect, it } from 'vitest'
import { ZERO_USAGE } from '@nexgent/kernel'
import {
  billedTokens,
  budgetStatus,
  createJob,
  improvementsDir,
  PENDING_STAGES,
  readJob,
  runImprovementJob,
  startExplicitJob,
  transitionJob,
  updateJob,
  type ImprovementStages,
} from '../src/index.js'
import { project, stagesTo } from './helpers.js'

describe('job state machine', () => {
  it('rejects moves the state machine does not allow', async () => {
    const layout = await project()
    const directory = improvementsDir(layout)
    const job = await createJob(directory, { trigger: 'explicit', items: [] })
    await expect(transitionJob(directory, job.id, 'adopted')).rejects.toMatchObject({ code: 'internal' })
    await transitionJob(directory, job.id, 'diagnosing')
    await transitionJob(directory, job.id, 'failed', { detail: 'x' })
    await expect(transitionJob(directory, job.id, 'diagnosing')).rejects.toMatchObject({ code: 'internal' })
    expect(await transitionJob(directory, job.id, 'interrupted', { expect: ['diagnosing'] })).toBeUndefined()
    expect((await readJob(directory, job.id)).history.map(entry => entry.status)).toEqual(['queued', 'diagnosing', 'failed'])
  })

  it('a malformed job id or file is reported, not guessed', async () => {
    const layout = await project()
    await expect(readJob(improvementsDir(layout), '../x')).rejects.toMatchObject({ code: 'session/not-found' })
    await expect(readJob(improvementsDir(layout), '44444444-4444-4444-8444-444444444444')).rejects.toMatchObject({ code: 'session/not-found' })
  })
})

describe('running a job', () => {
  async function runTo(stages: ImprovementStages) {
    const layout = await project()
    const directory = improvementsDir(layout)
    const job = await startExplicitJob(directory, {})
    const result = await runImprovementJob(layout, job.id, { stages })
    return { layout, directory, job: await readJob(directory, job.id), result }
  }

  it('a host without a session runner ends the job failed and says so', async () => {
    const { job } = await runTo(PENDING_STAGES)
    expect(job.status).toBe('failed')
    expect(job.detail).toMatch(/No improvement session runner/)
    expect(job.candidateId).toBeUndefined()
  })

  it('a diagnosis of none ends no-proposal; failures end failed with no candidate', async () => {
    expect((await runTo(stagesTo('none'))).job).toMatchObject({ status: 'no-proposal' })
    const diag = (await runTo(stagesTo('diagnose-failed'))).job
    expect(diag).toMatchObject({ status: 'failed', detail: 'the diagnosis broke the schema 3 times' })
    expect(diag.candidateId).toBeUndefined()
    expect((await runTo(stagesTo('propose-failed'))).job).toMatchObject({ status: 'failed' })
  })

  it('records spend per phase and the gate outcome', async () => {
    const { job } = await runTo(stagesTo('waiting-history', 50))
    expect(job.status).toBe('waiting-history')
    expect(job.phases.diagnose).toMatchObject({ requestCount: 1, usage: { inputTokens: 50 } })
    expect(job.phases.propose).toMatchObject({ requestCount: 2 })
    expect(job.phases.trial).toMatchObject({ requestCount: 3 })
    expect(job.trialId).toBe('22222222-2222-4222-8222-222222222222')
  })

  it('an error thrown by a stage ends the job failed', async () => {
    const { job } = await runTo({ ...stagesTo('adopted'), async propose() { throw new Error('boom') } })
    expect(job).toMatchObject({ status: 'failed' })
    expect(job.detail).toMatch(/boom/)
  })

  it('a job that is not queued is not run again', async () => {
    const { layout, job } = await runTo(stagesTo('rejected'))
    const again = await runImprovementJob(layout, job.id, { stages: stagesTo('adopted') })
    expect(again.jobs).toEqual([])
    expect(again.skipped).toMatch(/rejected/)
  })
})

describe('budget (decision 6)', () => {
  it('counts billed tokens of jobs inside the window, unknown fields as a lower bound', async () => {
    expect(billedTokens({ ...ZERO_USAGE, inputTokens: 5, outputTokens: 7, cacheReadTokens: 11, cacheWriteTokens: 13 })).toEqual({ tokens: 36, complete: true })
    expect(billedTokens({ ...ZERO_USAGE, inputTokens: 'unknown', outputTokens: 3 })).toEqual({ tokens: 3, complete: false })
    const layout = await project()
    const directory = improvementsDir(layout)
    const old = await createJob(directory, { trigger: 'explicit', items: [], now: new Date('2026-08-01T00:00:00Z') })
    await updateJob(directory, old.id, { phases: { diagnose: { usage: { ...ZERO_USAGE, inputTokens: 900 }, requestCount: 1 } } })
    const recent = await createJob(directory, { trigger: 'explicit', items: [], now: new Date('2026-10-10T00:00:00Z') })
    await updateJob(directory, recent.id, { phases: { diagnose: { usage: { ...ZERO_USAGE, inputTokens: 40, outputTokens: 'unknown' }, requestCount: 1 } } })
    const { readJob: read } = await import('../src/index.js')
    const status = budgetStatus([await read(directory, old.id), await read(directory, recent.id)], { maxTokens: 100, windowDays: 30 }, new Date('2026-10-13T00:00:00Z'))
    expect(status).toMatchObject({ used: 40, remaining: 60, exhausted: false, unknownPhases: 1 })
  })

  it('stops before a phase once the budget is spent', async () => {
    const layout = await project(true, { budget: { maxTokens: 1_000, windowDays: 30 } })
    const directory = improvementsDir(layout)
    const job = await startExplicitJob(directory, {})
    await runImprovementJob(layout, job.id, { stages: stagesTo('adopted', 600) })
    const done = await readJob(directory, job.id)
    expect(done.status).toBe('budget-exhausted')
    expect(done.phases.trial).toBeUndefined()
    expect(done.detail).toMatch(/before the trial phase/)
    const next = await startExplicitJob(directory, {})
    await runImprovementJob(layout, next.id, { stages: stagesTo('adopted') })
    expect(await readJob(directory, next.id)).toMatchObject({ status: 'budget-exhausted' })
    expect((await readJob(directory, next.id)).phases).toEqual({})
  })
})
