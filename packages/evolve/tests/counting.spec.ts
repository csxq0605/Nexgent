import { describe, expect, it } from 'vitest'
import { runImprovementJob, ImprovementHost, countsTowardImprovement, readQueue, type ImprovementHostConfig, type ImprovementStages, type StartedJob } from '../src/index.js'
import { feedback, project, stagesTo } from './helpers.js'
import { signalKey, type WorkspaceLayout } from '@nexgent/kernel'

/**
 * A host whose jobs run in this process with the given stages. These tests
 * cover the retired counting path (ADR 0018), so every host here opts in
 * with `legacyCounting`.
 */
function inProcess(layout: WorkspaceLayout, stages: ImprovementStages = stagesTo('adopted'), extra: ImprovementHostConfig = {}): ImprovementHost {
  return new ImprovementHost(layout, {
    legacyCounting: true,
    ...extra,
    launch: (target, jobId): StartedJob => ({ jobId, pid: process.pid, exited: runImprovementJob(target, jobId, { stages }).then(() => 0) }),
  })
}

describe('which feedback counts (decision 2)', () => {
  it('counts ratings of 3 or less and comments without a rating, not 4 or 5', () => {
    expect(countsTowardImprovement({ rating: 1, comment: '' })).toBe(true)
    expect(countsTowardImprovement({ rating: 3, comment: 'ok-ish' })).toBe(true)
    expect(countsTowardImprovement({ rating: 4, comment: 'missing a column' })).toBe(false)
    expect(countsTowardImprovement({ rating: 5, comment: '' })).toBe(false)
    expect(countsTowardImprovement({ comment: 'the totals are wrong' })).toBe(true)
    expect(countsTowardImprovement({ comment: '  ' })).toBe(false)
  })
})

describe('counting and the feedback trigger', () => {
  it('two counted feedbacks do not start a job, the third does; 4–5 ratings add nothing', async () => {
    const layout = await project()
    const host = inProcess(layout)
    await host.start()
    expect((await host.noteFeedback([feedback({ rating: 2 })])).started).toBeUndefined()
    expect((await host.noteFeedback([feedback({ rating: 5 }), feedback({ rating: 4 })])).added).toHaveLength(0)
    const second = await host.noteFeedback([feedback()])
    expect(second.started).toBeUndefined()
    expect(second.pending).toBe(2)
    expect(await host.list()).toHaveLength(0)
    const third = await host.noteFeedback([feedback({ rating: 3 })])
    expect(third.started).toMatchObject({ trigger: 'feedback-count', status: 'queued' })
    expect(third.started!.items).toHaveLength(3)
    expect(third.pending).toBe(0)
    await host.settled()
    const [job] = await host.list()
    expect(job).toMatchObject({ status: 'adopted', candidateId: '11111111-1111-4111-8111-111111111111', decisionId: '33333333-3333-4333-8333-333333333333' })
    expect(job!.history.map(entry => entry.status)).toEqual(['queued', 'diagnosing', 'proposing', 'trialing', 'adopted'])
    expect((await readQueue(host.directory))!.activeJobId).toBeUndefined()
  })

  it('the same feedback submitted again is not counted twice', async () => {
    const layout = await project()
    const host = inProcess(layout)
    await host.start()
    const entry = feedback()
    await host.noteFeedback([entry])
    await host.noteFeedback([entry])
    const again = await host.noteFeedback([entry, entry])
    expect(again.added).toHaveLength(0)
    expect(again.pending).toBe(1)
    expect((await readQueue(host.directory))!.counted).toEqual([`feedback:${entry.id}`])
  })

  it('feedback from before counting began is not counted', async () => {
    const layout = await project()
    const host = inProcess(layout)
    await host.start()
    const result = await host.noteFeedback([feedback({ submittedAt: '2026-01-01T00:00:00.000Z' })])
    expect(result.added).toHaveLength(0)
  })

  it('syncFeedback reads the store and counts only new, counting entries', async () => {
    const layout = await project()
    const sessionId = 'session-a'
    const entries = [feedback({ sessionId }), feedback({ sessionId, rating: 5 }), feedback({ sessionId })]
    const host = new ImprovementHost(layout, { legacyCounting: true }, () => ({ list: async filter => entries.filter(entry => filter?.sessionId === undefined || entry.sessionId === filter.sessionId) }))
    await host.start()
    expect((await host.syncFeedback(sessionId)).added).toHaveLength(2)
    expect((await host.syncFeedback(sessionId)).added).toHaveLength(0)
    expect((await host.syncFeedback('other')).added).toHaveLength(0)
  })

  it('with autoImprove off feedback is still counted but starts nothing', async () => {
    const layout = await project(false)
    const host = inProcess(layout)
    await host.start()
    const result = await host.noteFeedback([feedback(), feedback(), feedback(), feedback()])
    expect(result.added).toHaveLength(4)
    expect(result.started).toBeUndefined()
    expect(await host.list()).toEqual([])
  })

  it('without an entry or launcher counted items wait instead of starting a job', async () => {
    const layout = await project()
    const host = new ImprovementHost(layout, { legacyCounting: true })
    await host.start()
    const result = await host.noteFeedback([feedback(), feedback(), feedback()])
    expect(result.started).toBeUndefined()
    expect(result.pending).toBe(3)
    await expect(host.run()).rejects.toMatchObject({ code: 'internal' })
  })
})

describe('check failures', () => {
  it('a failed root check counts once per task and turn; passing checks count nothing', async () => {
    const layout = await project()
    const host = inProcess(layout)
    await host.start()
    const checks = [{ name: 'file-exists', passed: true }, { name: 'parses', passed: false, target: 'c1' }]
    expect((await host.noteCheckFailure({ taskId: 't1', sessionId: 's', turn: 1, checks: [{ name: 'parses', passed: true }] })).added).toHaveLength(0)
    const first = await host.noteCheckFailure({ taskId: 't1', sessionId: 's', turn: 1, checks })
    expect(first.added).toEqual([expect.objectContaining({ kind: 'check-failure', taskId: 't1', turn: 1, failedChecks: ['c1'] })])
    expect(first.added.map(signalKey)).toEqual(['check:t1:1'])
    expect((await host.noteCheckFailure({ taskId: 't1', sessionId: 's', turn: 1, checks })).added).toHaveLength(0)
    await host.noteFeedback([feedback()])
    const third = await host.noteCheckFailure({ taskId: 't2', sessionId: 's', turn: 1, checks })
    // A mixed batch is a feedback-count batch (the contract's batchTrigger).
    expect(third.started).toMatchObject({ trigger: 'feedback-count' })
    await host.settled()
  })

  it('a batch of check failures only is a check-failure batch', async () => {
    const layout = await project()
    const host = inProcess(layout)
    await host.start()
    const checks = [{ name: 'parses', passed: false, target: 'c1' }]
    for (const taskId of ['t1', 't2']) await host.noteCheckFailure({ taskId, sessionId: 's', turn: 1, checks })
    const third = await host.noteCheckFailure({ taskId: 't3', sessionId: 's', turn: 1, checks })
    expect(third.started).toMatchObject({ trigger: 'check-failure' })
    await host.settled()
  })
})

describe('explicit 改进', () => {
  it('starts at once with a zero count, also with autoImprove off, and takes the pending batch', async () => {
    const layout = await project(false)
    const host = inProcess(layout, stagesTo('none'))
    await host.start()
    await host.noteFeedback([feedback()])
    const job = await host.run({ deliverableId: 'd1', version: 2, note: 'make it better' })
    expect(job).toMatchObject({ trigger: 'explicit', request: { deliverableId: 'd1', version: 2 } })
    expect(job.items).toHaveLength(1)
    await host.settled()
    expect(await host.show(job.id)).toMatchObject({ status: 'no-proposal', detail: 'a change of requirements, not a missing capability' })
    expect((await readQueue(host.directory))!.pending).toEqual([])
  })

  it('is refused while another job runs in the project', async () => {
    const layout = await project()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const slow: ImprovementStages = { ...stagesTo('adopted'), async diagnose(input) { await gate; return stagesTo('adopted').diagnose(input) } }
    const host = inProcess(layout, slow)
    await host.start()
    await host.run()
    await expect(host.run()).rejects.toMatchObject({ code: 'improvement/busy' })
    release()
    await host.settled()
    await expect(host.run()).resolves.toMatchObject({ trigger: 'explicit' })
    await host.settled()
  })
})

describe('one job per project (decision 8)', () => {
  it('feedback during a job forms the next batch, which starts when the job is done', async () => {
    const layout = await project()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let calls = 0
    const slow: ImprovementStages = {
      ...stagesTo('rejected'),
      async diagnose(input) {
        calls += 1
        if (calls === 1) await gate
        return stagesTo('rejected').diagnose(input)
      },
    }
    const host = inProcess(layout, slow)
    await host.start()
    const first = await host.noteFeedback([feedback(), feedback(), feedback()])
    expect(first.started).toBeDefined()
    const during = await host.noteFeedback([feedback(), feedback(), feedback()])
    expect(during.started).toBeUndefined()
    expect(during.pending).toBe(3)
    release()
    await host.settled()
    const jobs = await host.list()
    expect(jobs).toHaveLength(2)
    expect(jobs.map(job => job.status)).toEqual(['rejected', 'rejected'])
    expect(jobs[1]!.items.map(signalKey)).toEqual(during.added.map(signalKey))
    expect((await readQueue(host.directory))!).toMatchObject({ pending: [] })
    expect((await readQueue(host.directory))!.activeJobId).toBeUndefined()
  })
})

describe('the feedback counter provider', () => {
  it('counts the session feedback when a turn starts and contributes nothing to the prompt', async () => {
    const { feedbackCounter } = await import('../src/index.js')
    const layout = await project(false)
    const entry = feedback({ sessionId: 's1' })
    const host = new ImprovementHost(layout, { legacyCounting: true }, () => ({ list: async () => [entry] }))
    await host.start()
    const contribution = await feedbackCounter(host).beginTurn!({ sessionId: 's1' } as Parameters<NonNullable<ReturnType<typeof feedbackCounter>['beginTurn']>>[0])
    expect(contribution).toEqual({})
    const queue = await (async () => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const value = await readQueue(host.directory)
        if (value !== undefined && value.counted.length > 0) return value
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      return readQueue(host.directory)
    })()
    expect(queue!.counted).toEqual([`feedback:${entry.id}`])
  })
})
