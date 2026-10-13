/**
 * The accept-step5 judges (H01–H18; step5-judges.mjs) against an observation recorded from
 * one run of the step-5 headless scenario (fixtures/step5-observations.json: the scenario's
 * output cut down to the fields the judges read; no paths, no key), and the feedback-fixture
 * judge. Each judge has copies broken in the ways it exists to catch. No model is called.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { judge, judgeFeedbackProject, JUDGES, type Step5Observations } from '../../../scripts/accept-common/step5-judges.mjs'
import { FEEDBACK, judgeRegionTable, ordersCsv, regionTable } from '../../../scripts/real-task/step5-orders.mjs'

const RECORDED: Step5Observations = JSON.parse(readFileSync(new URL('./fixtures/step5-observations.json', import.meta.url), 'utf8'))
const good = (): Step5Observations => structuredClone(RECORDED)
function broken(mutate: (obs: Step5Observations) => void): Step5Observations {
  const copy = good()
  mutate(copy)
  return copy
}
const ITEMS = Array.from({ length: 18 }, (_, i) => `H${String(i + 1).padStart(2, '0')}`)
const receipts = (o: Step5Observations) => o.main.detail.candidate.receipts as Array<Record<string, any>>
const ledger = (o: Step5Observations) => o.main.ledger as Array<Record<string, any>>

describe('accept-step5 judges', () => {
  it('all pass on the recorded observation', () => {
    expect(Object.keys(JUDGES)).toEqual(ITEMS)
    for (const key of ITEMS) expect(judge(key, good()), key).toMatchObject({ status: 'passed' })
  })

  it('without the SDK running the flow every evolve item fails, never a pass; H16 does not depend on it', () => {
    const notShipped = broken(o => { o.features = { evolvePackage: true, shipped: false, shippedNote: 'improvements.list: unknown method' } })
    for (const key of ITEMS.filter(k => k !== 'H16')) expect(judge(key, notShipped), key).toMatchObject({ status: 'failed', evidence: expect.stringContaining('improvements.list: unknown method') })
    expect(judge('H16', notShipped).status).toBe('passed')
    for (const key of ITEMS) {
      expect(judge(key, {}).status, key).toBe('failed')
      expect(judge(key, { features: { shipped: true } }).status, key).toBe('failed')
    }
  })

  it('a crashed phase fails its judges with the phase error', () => {
    const crashed = broken(o => { delete o.main; delete o.trigger.counting; delete o.turns; o.errors = { main: 'Error: boom\n  at x' } })
    expect(judge('H01', crashed)).toEqual({ status: 'failed', evidence: 'trigger.counting: phase main failed: Error: boom' })
    expect(judge('H06', crashed)).toEqual({ status: 'failed', evidence: 'main: phase main failed: Error: boom' })
    expect(judge('H16', crashed)).toEqual({ status: 'failed', evidence: 'main phase failed: Error: boom' })
    const killed = broken(o => { delete o.recovery; o.errors = { concurrency: 'Error: no lock' } })
    expect(judge('H15', killed)).toEqual({ status: 'failed', evidence: 'recovery: phase concurrency failed: Error: no lock' })
  })

  const cases: Array<[string, string, (obs: Step5Observations) => void]> = [
    ['H01', 'a job started at the second counted feedback', o => { o.trigger.counting[2].jobs = o.trigger.counting[4].jobs }],
    ['H01', 'an uncounted feedback (rating 5) was counted', o => { const s = o.trigger.counting[0]; s.queue = [s.feedbackId]; s.counted = [`feedback:${s.feedbackId}`] }],
    ['H01', 'an uncounted feedback (rating 4) was counted', o => { const s = o.trigger.counting[3]; s.counted = [...s.counted, `feedback:${s.feedbackId}`] }],
    ['H01', 'a counted feedback was not counted', o => { o.trigger.counting[2].counted = o.trigger.counting[1].counted }],
    ['H01', 'no job at the third counted feedback', o => { o.trigger.counting[4].jobs = [] }],
    ['H01', 'two jobs at the third counted feedback', o => { const j = o.trigger.counting[4].jobs[0]; o.trigger.counting[4].jobs = [j, { ...j, jobId: 'j9' }] }],
    ['H01', 'the batch stayed in the queue', o => { o.trigger.counting[4].queue = o.trigger.counting[4].jobs[0].feedbackIds }],
    ['H01', 'the job cites the wrong feedback', o => { o.trigger.counting[4].jobs[0].feedbackIds[1] = o.trigger.counting[0].feedbackId }],
    ['H01', 'the job\'s trigger is not feedback-count', o => { o.trigger.counting[4].jobs[0].trigger = 'explicit' }],
    ['H01', 'the phase had only counted feedback', o => { o.trigger.counting = o.trigger.counting.filter((s: { rating?: number | null }) => s.rating == null || s.rating <= 3) }],
    ['H02', 'no job started', o => { delete o.trigger.explicit.job }],
    ['H02', 'the start went around the SDK', o => { o.trigger.explicit.via = 'host' }],
    ['H02', 'autoImprove was on', o => { o.trigger.explicit.autoImprove = true }],
    ['H02', 'the queue was not empty', o => { o.trigger.explicit.queueBefore = ['x'] }],
    ['H02', 'the start errored', o => { o.trigger.explicit.error = 'improvement/busy' }],
    ['H02', 'the job never ran', o => { o.trigger.explicit.job.history = ['queued'] }],
    ['H03', 'the broken table did not count', o => { o.trigger.checkFailure.runs.corrupt.added = [] }],
    ['H03', 'a failing test run is not a failed check (decision B)', o => { o.trigger.checkFailure.runs.failing.results = o.trigger.checkFailure.runs.failing.results.filter((r: { name: string }) => r.name !== 'test-command') }],
    ['H03', 'a failing test run did not count (decision B)', o => { o.trigger.checkFailure.runs.failing.added = [] }],
    ['H03', 'a failing exploratory command counted', o => { o.trigger.checkFailure.runs.explore.added = ['check:x:1'] }],
    ['H03', 'an exploratory command became a check', o => { o.trigger.checkFailure.runs.explore.specs.push({ command: 'cat data/missing-export.csv' }) }],
    ['H03', 'a test failing then fixed counted', o => { o.trigger.checkFailure.runs.fixed.added = ['check:y:1'] }],
    ['H03', 'a test failing then fixed is recorded failed', o => { o.trigger.checkFailure.runs.fixed.results.at(-1).passed = false }],
    ['H03', 'a task did not complete', o => { o.trigger.checkFailure.runs.explore.reason = 'error' }],
    ['H03', 'it counted twice', o => { const r = o.trigger.checkFailure.runs.corrupt; r.added = [...r.added, r.added[0]] }],
    ['H03', 'the queue did not grow by two', o => { o.trigger.checkFailure.queueAfter = o.trigger.checkFailure.queueAfter.slice(1) }],
    ['H03', 'a job started below the threshold', o => { o.trigger.checkFailure.jobs = [{}] }],
    ['H04', 'a job started with autoImprove off', o => { o.trigger.disabled.jobs = [{}] }],
    ['H04', 'a feedback was not recorded', o => { o.trigger.disabled.recorded = 4 }],
    ['H04', 'too few feedbacks to reach the threshold', o => { o.trigger.disabled.submitted = 2; o.trigger.disabled.recorded = 2 }],
    ['H05', 'no diagnosis was written', o => { delete o.main.diagnosis }],
    ['H05', 'the diagnosis fails the schema', o => { o.main.integrity.issues = ['diagnosis.json: /failureTypes/0/category: must be equal to one of the allowed values'] }],
    ['H05', 'a failure type is not a MAST category', o => { o.main.diagnosis.failureTypes[0].category = 'bad-luck' }],
    ['H05', 'a failure type has no evidence', o => { o.main.diagnosis.failureTypes[0].evidence = [] }],
    ['H05', 'a cited record does not exist', o => { o.main.evidence[0].found = false }],
    ['H05', 'memberCosts differ from the ledger', o => { o.main.diagnosis.memberCosts[0].requestCount += 1 }],
    ['H05', 'memberCosts input tokens differ from the ledger', o => { o.main.diagnosis.memberCosts[0].usage.inputTokens -= 40 }],
    ['H05', 'three refused reports did not fail the job', o => { o.disabled.invalid.job = { status: 'adopted', history: ['queued', 'diagnosing', 'proposing'] } }],
    ['H05', 'the refused diagnosis left a file', o => { o.disabled.invalid.diagnosis = {} }],
    ['H06', 'a write tool was offered to diagnose', o => { o.main.diagnoseSessions[0].tools.push('write_file') }],
    ['H06', 'a diagnose tool is missing', o => { o.main.diagnoseSessions[0].tools.pop() }],
    ['H06', 'no diagnose session ran', o => { o.main.diagnoseSessions = [] }],
    ['H06', 'an improvement session is in sessions.list', o => { o.main.listedSessions.push(o.main.job.sessions.propose) }],
    ['H06', 'a user task session is missing from sessions.list', o => { o.main.listedSessions.pop() }],
    ['H06', 'resuming an improvement session was allowed', o => { o.main.resume.diagnose = { code: undefined } }],
    ['H07', 'the candidate has two components', o => { const c = o.main.detail.candidate.record.components; c.push({ ...c[0], name: 'other' }) }],
    ['H07', 'the candidate is not the job\'s', o => { o.main.detail.candidate.record.origin = 'manual' }],
    ['H07', 'the candidate carries config', o => { o.main.detail.candidate.record.components[0].files.push({ path: '.nexgent/config.json' }) }],
    ['H07', 'the candidate fails the schema', o => { o.main.integrity.issues = ['candidate x: bad'] }],
    ['H07', 'two components were accepted', o => { o.disabled.two.job = { status: 'adopted' } }],
    ['H07', 'a two-component candidate was kept', o => { o.disabled.candidatesAdded = 1 }],
    ['H07', 'proposalKind none still proposed', o => { o.disabled.none.job = { status: 'failed', history: ['queued', 'diagnosing', 'proposing', 'failed'] } }],
    ['H07', 'a component never used successfully became a candidate', o => { o.trigger.explicit.candidates = 1 }],
    ['H08', 'the propose session sent nothing', o => { o.main.requests = o.main.requests.filter((r: { kind: string }) => r.kind !== 'propose') }],
    ['H08', 'a project file changed', o => { const t = o.main.isolation.treeAfter; t[Object.keys(t)[0]!] = 'changed' }],
    ['H08', 'a user session changed', o => { o.main.isolation.sessionsChanged = ['s'] }],
    ['H08', 'the feedback session grew', o => { o.main.isolation.feedbackSessionExtra = 2 }],
    ['H08', 'deliverables changed', o => { o.main.isolation.deliverablesAfter = [] }],
    ['H08', 'an extra session appeared', o => { o.main.isolation.newSessions.push('extra') }],
    ['H09', 'no trial.start', o => { o.main.detail.candidate.receipts = receipts(o).filter(r => r.type !== 'trial.start') }],
    ['H09', 'selection does not start with the feedback task', o => { receipts(o)[0]!.plan.selection.reverse() }],
    ['H09', 'the feedback case replays past turn 1', o => { receipts(o)[0]!.plan.selection[0].throughTurn = 6 }],
    ['H09', 'the feedback case lacks the feedback ids', o => { receipts(o)[0]!.plan.selection[0].feedbackIds = [] }],
    ['H09', 'guard is the feedback task', o => { receipts(o)[0]!.plan.guard = [receipts(o)[0]!.plan.selection[0]] }],
    ['H09', 'guard overlaps selection', o => { receipts(o)[0]!.plan.guard.push(receipts(o)[0]!.plan.selection[1]) }],
    ['H09', 'a replay quotes the feedback', o => { o.main.requests.find((r: { phase: string; kind: string }) => r.phase === 'job' && r.kind === 'task').quotesFeedback = true }],
    ['H10', 'only one arm had a feedback check', o => { o.main.detail.candidate.receipts = receipts(o).filter(r => !(r.type === 'trial.feedback' && r.arm === 'baseline')) }],
    ['H10', 'the feedback checks did not tell the arms apart', o => { for (const r of receipts(o)) if (r.type === 'trial.feedback') r.status = 'pass' }],
    ['H10', 'a feedback check did not see the feedback', o => { o.main.feedbackChecks[0].quotesFeedback = false }],
    ['H10', 'no feedback pass rate', o => { delete receipts(o).at(-1)!.verdict.feedbackPassRate }],
    ['H10', 'the decision mixes the feedback checks in', o => { o.main.decisions[0].detail = 'adopt (quality-up). Quality passed.' }],
    ['H10', 'unknown answers were adopted', o => { o.waiting.job.status = 'adopted'; o.waiting.activation = [{}] }],
    ['H10', 'the unknown case answered', o => { o.waiting.feedbackChecks[0].solved = true }],
    ['H11', 'the job was not adopted', o => { o.main.job.status = 'rejected' }],
    ['H11', 'the next task ran in the same process', o => { o.main.next.pid = o.main.next.parentPid }],
    ['H11', 'the next task ran on another version', o => { o.main.next.version = 'baseline' }],
    ['H11', 'the ledger does not show the skill used', o => { for (const r of ledger(o)) if (r.type === 'task.outcome') r.componentsUsed = [] }],
    ['H11', 'the next table still lacks the column', o => { o.main.next.judged = { pass: false, problems: ['column avg_order_value is missing'] } }],
    ['H11', 'firstUse points elsewhere', o => { o.main.firstUse.taskId = 'other' }],
    ['H12', 'the rejected candidate was not kept', o => { o.waiting.after.candidate = undefined }],
    ['H12', 'receipts were dropped', o => { o.waiting.after.receipts = [] }],
    ['H12', 'the version changed after a rejection', o => { o.waiting.after.version = 'abc' }],
    ['H12', 'the next task failed on the old version', o => { o.waiting.after.reason = 'error' }],
    ['H13', 'the job did not park', o => { o.waiting.parked.status = 'rejected' }],
    ['H13', 'the parked job does not say what it needs', o => { o.waiting.parked.detail = 'waiting' }],
    ['H13', 'the job never continued', o => { o.waiting.job.history = ['queued', 'diagnosing', 'proposing', 'trialing', 'waiting-history']; o.waiting.job.status = 'waiting-history'; o.waiting.statusAfterHistory = 'queued' }],
    ['H13', 'the job was diagnosed again', o => { o.waiting.diagnoseSessions = 2 }],
    ['H13', 'the gate ran smaller than it waited for', o => { Object.values(o.waiting.trials as Record<string, Array<Record<string, any>>>)[0]![0]!.plan.selection.pop() }],
    ['H14', 'the job over budget kept going', o => { o.disabled.stopped.job.status = 'rejected' }],
    ['H14', 'the job stopped after proposing', o => { o.disabled.stopped.job.phases.propose = {} }],
    ['H14', 'a run with the budget spent was accepted', o => { o.disabled.refused = { job: { status: 'queued' } } }],
    ['H14', 'the settings budget was not applied', o => { o.disabled.budget.settingsLimit = 3_000_000 }],
    ['H14', 'a phase is missing in the ledger', o => { o.main.ledger = ledger(o).filter(r => r.improvementPhase !== 'trial') }],
    ['H14', 'a user task carries an improvementId', o => { o.main.ledger.push({ type: 'llm.request.end', sessionId: o.main.taskSessions[0].sessionId, improvementId: 'x' }) }],
    ['H14', 'the window is not the job\'s phases', o => { o.main.listing.budget.usedTokens += 1 }],
    ['H15', 'two jobs ran at once', o => { o.concurrency.maxRunning = 2 }],
    ['H15', 'a concurrent feedback counted twice', o => { o.concurrency.queue.push(o.concurrency.submitted[0]) }],
    ['H15', 'a concurrent feedback was lost', o => { o.concurrency.queue.pop(); o.concurrency.allCounted = false }],
    ['H15', 'only one process submitted', o => { o.concurrency.submitted.pop() }],
    ['H15', 'two jobs were created', o => { o.concurrency.jobs.push({}) }],
    ['H15', 'the killed job is not interrupted', o => { o.recovery.statusAfterRestart = 'diagnosing' }],
    ['H15', 'the killed job ran again', o => { o.recovery.reruns = 1; o.recovery.starts = 2 }],
    ['H15', 'the adopted version changed across the kill', o => { o.recovery.adoptedAfter = 'a'.repeat(64) }],
    ['H15', 'the kill did not happen', o => { o.recovery.killError = 'no job process id in job.lock' }],
    ['H16', 'the first turn\'s snapshot was overwritten', o => { o.turns.after.tasks['1'].sha = 'changed' }],
    ['H16', 'the first turn\'s checks were overwritten', o => { o.turns.after.checks['1'].sha = 'changed' }],
    ['H16', 'a feedback turn has no snapshot', o => { delete o.turns.after.tasks['4'] }],
    ['H16', 'a feedback turn has no checks', o => { delete o.turns.after.checks['6'] }],
    ['H16', 'the step-4 snapshot file was replaced by a later turn', o => { o.turns.after.legacy.tasks = 't6' }],
    ['H16', 'the feedback task was not found', o => { delete o.turns.taskId }],
    ['H17', 'config.json changed during the job', o => { o.main.configAfter = 'changed' }],
    ['H17', 'config.json changed during explicit jobs', o => { o.disabled.config.afterJobs = 'changed' }],
    ['H17', 'config.json did not change on settings.update', o => { o.disabled.config.afterSettings = o.disabled.config.afterJobs }],
    ['H17', 'the switch was turned on', o => { o.disabled.configFile.autoImprove = true }],
    ['H18', 'a record fails the schema', o => { o.main.integrity.issues = ['ledger line 4: bad'] }],
    ['H18', 'a record kind was not checked', o => { o.main.integrity.files.decision = 0 }],
    ['H18', 'no improvement.end', o => { o.main.ledger = ledger(o).filter(r => r.type !== 'improvement.end') }],
    ['H18', 'the key is under .nexgent/', o => { o.main.integrity.secretHits = ['.nexgent/ledger.jsonl'] }],
    ['H18', 'the export failed', o => { o.main.export.code = 1 }],
    ['H18', 'the key is in the export', o => { o.main.export.secretHits = ['session.jsonl'] }],
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
    expect(ITEMS.filter(key => !covered.has(key))).toEqual([])
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
