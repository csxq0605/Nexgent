/**
 * The accept-step5 judges (H01–H04, H15, H16; step5-judges.mjs) against hand-made
 * observations in the shape the step-5 headless scenario collects, and the
 * feedback-fixture judge. Each judge has copies broken in the ways it exists to
 * catch. No model is called.
 */
import { describe, expect, it } from 'vitest'
import { judge, judgeFeedbackProject, JUDGES, type Step5Observations } from '../../../scripts/accept-common/step5-judges.mjs'
import { FEEDBACK, judgeRegionTable, ordersCsv, regionTable } from '../../../scripts/real-task/step5-orders.mjs'

const id = (key: string) => `fb-${key}`
const keys = (...names: string[]) => names.map(n => `feedback:${id(n)}`)
const job = { jobId: 'j1', trigger: 'feedback-count', status: 'failed', feedbackIds: [id('first'), id('second'), id('third')], checkItems: 0, history: ['queued', 'diagnosing', 'failed'] }
const files = (turns: number) => ({
  tasks: Object.fromEntries(Array.from({ length: turns }, (_, i) => [String(i + 1), { sha: `t${i + 1}` }])),
  checks: Object.fromEntries(Array.from({ length: turns }, (_, i) => [String(i + 1), { sha: `c${i + 1}` }])),
  legacy: { tasks: 't1-legacy', checks: `c${turns}-legacy` },
})

function good(): Step5Observations {
  const step = (f: (typeof FEEDBACK)[number], queue: string[], counted: string[], jobs: unknown[] = []) => ({ ...f, feedbackId: id(f.key), queue, counted, jobs })
  return {
    features: { evolvePackage: true, shipped: true },
    trigger: {
      counting: [
        step(FEEDBACK[0]!, [], []),
        step(FEEDBACK[1]!, [id('first')], keys('first')),
        step(FEEDBACK[2]!, [id('first'), id('second')], keys('first', 'second')),
        step(FEEDBACK[3]!, [id('first'), id('second')], keys('first', 'second')),
        step(FEEDBACK[4]!, [], keys('first', 'second', 'third'), [job]),
      ],
      explicit: { autoImprove: false, queueBefore: [], via: 'sdk', job: { trigger: 'explicit', status: 'queued' } },
      checkFailure: { failedChecks: 1, queueBefore: [], queueAfter: ['check:t1:1'], jobs: [] },
      disabled: { autoImprove: false, submitted: 5, recorded: 5, counted: keys('first', 'second', 'third'), jobs: [] },
    },
    concurrency: { submitted: ['a', 'b'], queue: ['z', 'a', 'b'], allCounted: true, jobStarted: true, jobs: [{ ...job, status: 'diagnosing' }], maxRunning: 1, drivers: [] },
    recovery: { jobId: 'j2', statusBeforeKill: 'diagnosing', statusAfterRestart: 'interrupted', starts: 1, reruns: 0, adoptedBefore: 'baseline', adoptedAfter: 'baseline' },
    turns: { taskId: 't', feedbackTurns: 5, before: files(1), after: { ...files(6), legacy: { tasks: 't1-legacy', checks: 'c6-legacy' } } },
    errors: {},
  }
}
function broken(mutate: (obs: Step5Observations) => void): Step5Observations {
  const copy = structuredClone(good())
  mutate(copy)
  return copy
}
const EVOLVE = ['H01', 'H02', 'H03', 'H04', 'H15']

describe('accept-step5 judges', () => {
  it('all pass on a complete observation with the SDK running the flow', () => {
    expect(Object.keys(JUDGES)).toEqual(['H01', 'H02', 'H03', 'H04', 'H15', 'H16'])
    for (const key of Object.keys(JUDGES)) expect(judge(key, good()), key).toMatchObject({ status: 'passed' })
  })

  it('while the SDK does not run the flow, holding conditions are not-implemented ("checked so far"), never a pass; H16 does not depend on it', () => {
    const notShipped = broken(o => { o.features.shipped = false })
    for (const key of EVOLVE) expect(judge(key, notShipped), key).toMatchObject({ status: 'not-implemented', evidence: expect.stringMatching(/W4.*checked so far: /) })
    expect(judge('H16', notShipped).status).toBe('passed')
    // A defect still fails, shipped or not.
    expect(judge('H01', broken(o => { o.features.shipped = false; o.trigger.counting[4].jobs = [] })).status).toBe('failed')
  })

  it('an explicit start through the plugin host instead of the SDK is not a pass', () => {
    const viaHost = broken(o => { o.trigger.explicit.via = 'host'; o.trigger.explicit.sdkError = 'improvements.run is not available yet' })
    expect(judge('H02', viaHost)).toMatchObject({ status: 'not-implemented', evidence: expect.stringContaining('improvements.run refused') })
  })

  it('without @nexgent/evolve the evolve judges are not-implemented; with it but nothing observed, every judge fails', () => {
    for (const key of EVOLVE) {
      expect(judge(key, broken(o => { o.features.evolvePackage = false })), key).toMatchObject({ status: 'not-implemented' })
      expect(judge(key, {}).status, key).toBe('not-implemented')
    }
    for (const key of Object.keys(JUDGES)) expect(judge(key, { features: { evolvePackage: true, shipped: true } }).status, key).toBe('failed')
  })

  it('a crashed phase fails its judge with the phase error', () => {
    const crashed = broken(o => { delete o.trigger.checkFailure; o.errors['check-failure'] = 'Error: boom\n  at x' })
    expect(judge('H03', crashed)).toEqual({ status: 'failed', evidence: 'trigger.checkFailure: phase check-failure failed: Error: boom' })
  })

  const cases: Array<[string, string, (obs: Step5Observations) => void]> = [
    ['H01', 'a job started at the second counted feedback', o => { o.trigger.counting[2].jobs = [job] }],
    ['H01', 'an uncounted feedback (rating 5) was counted', o => { o.trigger.counting[0].queue = [id('praise')]; o.trigger.counting[0].counted = keys('praise') }],
    ['H01', 'an uncounted feedback (rating 4) was counted', o => { o.trigger.counting[3].counted = keys('first', 'second', 'fine') }],
    ['H01', 'a counted feedback was not counted', o => { o.trigger.counting[2].counted = keys('first') }],
    ['H01', 'no job at the third counted feedback', o => { o.trigger.counting[4].jobs = [] }],
    ['H01', 'two jobs at the third counted feedback', o => { o.trigger.counting[4].jobs = [job, { ...job, jobId: 'j9' }] }],
    ['H01', 'the batch stayed in the queue', o => { o.trigger.counting[4].queue = [id('first'), id('second'), id('third')] }],
    ['H01', 'the job cites the wrong feedback', o => { o.trigger.counting[4].jobs = [{ ...job, feedbackIds: [id('first'), id('praise'), id('third')] }] }],
    ['H01', 'the job\'s trigger is not feedback-count', o => { o.trigger.counting[4].jobs = [{ ...job, trigger: 'explicit' }] }],
    ['H01', 'the phase had only counted feedback', o => { o.trigger.counting = o.trigger.counting.filter((s: { rating?: number }) => s.rating === undefined || s.rating <= 3) }],
    ['H02', 'no job started', o => { delete o.trigger.explicit.job }],
    ['H02', 'autoImprove was on', o => { o.trigger.explicit.autoImprove = true }],
    ['H02', 'the queue was not empty', o => { o.trigger.explicit.queueBefore = ['x'] }],
    ['H02', 'the start errored', o => { o.trigger.explicit.error = 'improvement/budget-exhausted' }],
    ['H03', 'the failed check did not count', o => { o.trigger.checkFailure.queueAfter = [] }],
    ['H03', 'it counted twice', o => { o.trigger.checkFailure.queueAfter = ['check:t1:1', 'check:t1:1b'] }],
    ['H03', 'it counted as something other than a check failure', o => { o.trigger.checkFailure.queueAfter = ['feedback:x'] }],
    ['H03', 'no check failed', o => { o.trigger.checkFailure.failedChecks = 0 }],
    ['H03', 'a job started below the threshold', o => { o.trigger.checkFailure.jobs = [job] }],
    ['H04', 'a job started with autoImprove off', o => { o.trigger.disabled.jobs = [job] }],
    ['H04', 'a feedback was not recorded', o => { o.trigger.disabled.recorded = 4 }],
    ['H04', 'too few feedbacks to reach the threshold', o => { o.trigger.disabled.submitted = 2; o.trigger.disabled.recorded = 2 }],
    ['H15', 'two jobs ran at once', o => { o.concurrency.maxRunning = 2 }],
    ['H15', 'a concurrent feedback counted twice', o => { o.concurrency.queue = ['z', 'a', 'b', 'b'] }],
    ['H15', 'a concurrent feedback was lost', o => { o.concurrency.queue = ['z', 'a']; o.concurrency.allCounted = false }],
    ['H15', 'only one process submitted', o => { o.concurrency.submitted = ['a'] }],
    ['H15', 'two jobs were created', o => { o.concurrency.jobs = [job, { ...job, jobId: 'j3' }] }],
    ['H15', 'the killed job is not interrupted', o => { o.recovery.statusAfterRestart = 'diagnosing' }],
    ['H15', 'the killed job ran again', o => { o.recovery.reruns = 1 }],
    ['H15', 'the adopted version changed across the kill', o => { o.recovery.adoptedAfter = 'a'.repeat(64) }],
    ['H15', 'the kill did not happen', o => { o.recovery.killError = 'no job process id in job.lock' }],
    ['H15', 'recovery was not observed', o => { delete o.recovery }],
    ['H16', 'the first turn\'s snapshot was overwritten', o => { o.turns.after.tasks['1'].sha = 'changed' }],
    ['H16', 'the first turn\'s checks were overwritten', o => { o.turns.after.checks['1'].sha = 'changed' }],
    ['H16', 'a feedback turn has no snapshot', o => { delete o.turns.after.tasks['4'] }],
    ['H16', 'a feedback turn has no checks', o => { delete o.turns.after.checks['6'] }],
    ['H16', 'the step-4 snapshot file was replaced by a later turn', o => { o.turns.after.legacy.tasks = 't6' }],
    ['H16', 'the feedback task was not found', o => { delete o.turns.taskId }],
  ]
  for (const [key, defect, mutate] of cases) {
    it(`${key} fails when ${defect}`, () => {
      const result = judge(key, broken(mutate))
      expect(result.status, result.evidence).toBe('failed')
      expect(result.evidence).not.toContain('judge threw')
    })
  }

  it('every judge has at least one counterexample', () => {
    const covered = new Set(cases.map(([key]) => key))
    expect(Object.keys(JUDGES).filter(key => !covered.has(key))).toEqual([])
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
