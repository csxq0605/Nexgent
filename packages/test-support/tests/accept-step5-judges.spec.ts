/**
 * The accept-step5 judges written in round 1 (H01–H04, H15; step5-judges.mjs)
 * against hand-made observations in the shape the step-5 headless scenario
 * will collect, and the feedback-fixture judge. Each judge has copies broken
 * in the ways it exists to catch. No model is called.
 */
import { describe, expect, it } from 'vitest'
import { judge, judgeFeedbackProject, JUDGES, type Step5Observations } from '../../../scripts/accept-common/step5-judges.mjs'
import { FEEDBACK, judgeRegionTable, ordersCsv, regionTable } from '../../../scripts/real-task/step5-orders.mjs'

const ids = FEEDBACK.map(f => `fb-${f.key}`)
const job = { jobId: 'j1', trigger: 'feedback', status: 'queued', feedbackIds: ['fb-first', 'fb-second', 'fb-third'] }

function good(): Step5Observations {
  return {
    features: { evolve: true },
    trigger: {
      counting: [
        { ...FEEDBACK[0], feedbackId: ids[0], queue: [], jobs: [] },
        { ...FEEDBACK[1], feedbackId: ids[1], queue: ['fb-first'], jobs: [] },
        { ...FEEDBACK[2], feedbackId: ids[2], queue: ['fb-first', 'fb-second'], jobs: [] },
        { ...FEEDBACK[3], feedbackId: ids[3], queue: ['fb-first', 'fb-second'], jobs: [] },
        { ...FEEDBACK[4], feedbackId: ids[4], queue: [], jobs: [job] },
      ],
      explicit: { autoImprove: false, queueBefore: [], job: { trigger: 'explicit', status: 'diagnosing' } },
      checkFailure: { failedChecks: 1, queueBefore: [], queueAfter: ['check:t1'], jobs: [] },
      disabled: { autoImprove: false, submitted: 3, recorded: 3, jobs: [] },
    },
    concurrency: { submitted: ['a', 'b'], queue: ['a', 'b'], maxRunning: 1, secondStart: { refused: true, reason: 'a job is running' } },
    recovery: { jobId: 'j2', statusAfterRestart: 'interrupted', reruns: 0, adoptedBefore: 'baseline', adoptedAfter: 'baseline' },
  }
}
function broken(mutate: (obs: Step5Observations) => void): Step5Observations {
  const copy = structuredClone(good())
  mutate(copy)
  return copy
}

describe('accept-step5 round-1 judges', () => {
  it('all pass on a complete observation', () => {
    for (const id of Object.keys(JUDGES)) expect(judge(id, good()), id).toMatchObject({ status: 'passed' })
    expect(Object.keys(JUDGES)).toEqual(['H01', 'H02', 'H03', 'H04', 'H15'])
  })

  it('without the improvement flow in the SDK every judge is not-implemented, never a pass', () => {
    for (const id of Object.keys(JUDGES)) {
      expect(judge(id, broken(o => { o.features.evolve = false })), id).toMatchObject({ status: 'not-implemented', evidence: expect.stringContaining('improvements.*') })
      expect(judge(id, {}).status, id).toBe('not-implemented')
    }
  })

  it('with evolve but nothing observed, every judge fails', () => {
    for (const id of Object.keys(JUDGES)) expect(judge(id, { features: { evolve: true } }).status, id).toBe('failed')
  })

  const cases: Array<[string, string, (obs: Step5Observations) => void]> = [
    ['H01', 'a job started at the second counted feedback', o => { o.trigger.counting[2].jobs = [job] }],
    ['H01', 'an uncounted feedback (rating 5) entered the queue', o => { o.trigger.counting[0].queue = ['fb-praise'] }],
    ['H01', 'an uncounted feedback (rating 4) entered the queue', o => { o.trigger.counting[3].queue = ['fb-first', 'fb-second', 'fb-fine'] }],
    ['H01', 'no job at the third counted feedback', o => { o.trigger.counting[4].jobs = [] }],
    ['H01', 'two jobs at the third counted feedback', o => { o.trigger.counting[4].jobs = [job, { ...job, jobId: 'j9' }] }],
    ['H01', 'the queue was not cleared', o => { o.trigger.counting[4].queue = ['fb-first', 'fb-second', 'fb-third'] }],
    ['H01', 'the job cites the wrong feedback', o => { o.trigger.counting[4].jobs = [{ ...job, feedbackIds: ['fb-first', 'fb-praise', 'fb-third'] }] }],
    ['H01', 'the job\'s trigger is not feedback', o => { o.trigger.counting[4].jobs = [{ ...job, trigger: 'explicit' }] }],
    ['H01', 'the phase had only counted feedback', o => { o.trigger.counting = o.trigger.counting.filter((s: { rating?: number }) => s.rating === undefined || s.rating <= 3) }],
    ['H02', 'no job started', o => { delete o.trigger.explicit.job }],
    ['H02', 'autoImprove was on', o => { o.trigger.explicit.autoImprove = true }],
    ['H02', 'the queue was not empty', o => { o.trigger.explicit.queueBefore = ['x'] }],
    ['H02', 'the start errored', o => { o.trigger.explicit.error = 'improvement/budget' }],
    ['H03', 'the failed check did not count', o => { o.trigger.checkFailure.queueAfter = [] }],
    ['H03', 'it counted twice', o => { o.trigger.checkFailure.queueAfter = ['check:t1', 'check:t1b'] }],
    ['H03', 'no check failed', o => { o.trigger.checkFailure.failedChecks = 0 }],
    ['H03', 'a job started below the threshold', o => { o.trigger.checkFailure.jobs = [job] }],
    ['H04', 'a job started with autoImprove off', o => { o.trigger.disabled.jobs = [job] }],
    ['H04', 'a feedback was not recorded', o => { o.trigger.disabled.recorded = 2 }],
    ['H04', 'too few feedbacks to reach the threshold', o => { o.trigger.disabled.submitted = 2; o.trigger.disabled.recorded = 2 }],
    ['H15', 'two jobs ran at once', o => { o.concurrency.maxRunning = 2 }],
    ['H15', 'a concurrent feedback counted twice', o => { o.concurrency.queue = ['a', 'b', 'b'] }],
    ['H15', 'a concurrent feedback was lost', o => { o.concurrency.queue = ['a'] }],
    ['H15', 'a second job started', o => { o.concurrency.secondStart = { refused: false } }],
    ['H15', 'the killed job is not interrupted', o => { o.recovery.statusAfterRestart = 'diagnosing' }],
    ['H15', 'the killed job ran again', o => { o.recovery.reruns = 1 }],
    ['H15', 'the adopted version changed across the kill', o => { o.recovery.adoptedAfter = 'a'.repeat(64) }],
    ['H15', 'recovery was not observed', o => { delete o.recovery }],
  ]
  for (const [id, defect, mutate] of cases) {
    it(`${id} fails when ${defect}`, () => {
      const result = judge(id, broken(mutate))
      expect(result.status, result.evidence).toBe('failed')
      expect(result.evidence).not.toContain('judge threw')
    })
  }

  it('every judge has at least one counterexample', () => {
    const covered = new Set(cases.map(([id]) => id))
    expect(Object.keys(JUDGES).filter(id => !covered.has(id))).toEqual([])
  })
})

describe('feedback fixture judge', () => {
  const month = (id: string) => id.slice(-7)
  const helpers = { judgeTable: judgeRegionTable, csvOf: (task: { id: string }) => ordersCsv(month(task.id)) }
  const task = (id: string, output: string) => ({ id, sessionId: `s-${id}`, reason: { kind: 'completed' }, output, check: { passed: true, exitCode: 0, stdout: 'ok' } })
  const project = () => ({
    tasks: [
      task('summary-2026-06', '{}'),
      task('summary-2026-07', '{}'),
      task('regions-2026-08', regionTable(ordersCsv('2026-08'), { withAverage: false })),
      task('regions-2026-09', regionTable(ordersCsv('2026-09'), { withAverage: false })),
    ],
    deliverable: { deliverableId: 'd', version: 1, sessionId: 's-regions-2026-09' },
    feedback: FEEDBACK.map(f => ({ ...f, id: `id-${f.key}`, counted: f.rating === undefined || f.rating <= 3, reason: { kind: 'completed' } })),
    listing: FEEDBACK.map(f => ({ id: `id-${f.key}`, comment: f.comment, sessionId: 's', turn: 1 })),
  })

  it('passes on a complete fixture', () => {
    expect(judgeFeedbackProject(project(), helpers)).toMatchObject({ status: 'passed' })
  })

  const defects: Array<[string, (p: ReturnType<typeof project>) => void]> = [
    ['the feedback task already has the column', p => { p.tasks[3]!.output = regionTable(ordersCsv('2026-09'), { withAverage: true }) }],
    ['a task did not complete', p => { p.tasks[1]!.reason = { kind: 'error' } }],
    ['a check failed', p => { p.tasks[0]!.check.passed = false }],
    ['no deliverable', p => { delete (p as { deliverable?: unknown }).deliverable }],
    ['a feedback is not listed', p => { p.listing.pop() }],
    ['a feedback turn did not complete', p => { p.feedback[2]!.reason = { kind: 'cancelled' } }],
    ['only two feedbacks count', p => { p.feedback = p.feedback.filter(f => f.key !== 'third') }],
  ]
  for (const [defect, mutate] of defects) {
    it(`fails when ${defect}`, () => {
      const p = project()
      mutate(p)
      expect(judgeFeedbackProject(p, helpers).status).toBe('failed')
    })
  }
  it('fails when the project did not run', () => {
    expect(judgeFeedbackProject(undefined, helpers)).toEqual({ status: 'failed', evidence: 'the feedback project did not run' })
  })
})
