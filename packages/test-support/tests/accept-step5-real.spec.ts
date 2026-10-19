/**
 * The accept-step5 R judges (step5-real-judges.mjs) against an observation in the shape
 * step5-real.mjs collects (fixtures/step5-real-observations.json: a scripted rehearsal of
 * the real scenario, cut down to the fields the judges read, `realModel` set as a real run
 * sets it), and for every judge copies broken in the ways it exists to catch. Also the
 * scenario's pure helpers. No model is called.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { judgeReal, REAL_JUDGES, TOOL_NAMES, type RealObservations } from '../../../scripts/accept-common/step5-real-judges.mjs'
import { hiddenCheck, jobUsage, SECOND_TASK } from '../../../scripts/accept-common/step5-real.mjs'
import { FEEDBACK_TASK, HISTORY_TASKS, NEXT_TASK } from '../../../scripts/accept-common/step5-fixtures.mjs'
import { FEEDBACK, ordersCsv, regionTable, SECOND_FEEDBACK } from '../../../scripts/real-task/step5-orders.mjs'

const RECORDED: RealObservations = JSON.parse(readFileSync(new URL('./fixtures/step5-real-observations.json', import.meta.url), 'utf8'))
const good = (): RealObservations => structuredClone(RECORDED)
function broken(mutate: (obs: RealObservations) => void): RealObservations {
  const copy = good()
  mutate(copy)
  return copy
}
const ITEMS = ['R01', 'R02', 'R03', 'R04', 'R05', 'R06', 'R07']
const receipts = (o: RealObservations) => o.jobs.main.show.candidate.receipts as Array<Record<string, any>>

describe('accept-step5 real judges', () => {
  it('all pass on a complete observation', () => {
    expect(Object.keys(REAL_JUDGES)).toEqual(ITEMS)
    for (const id of ITEMS) expect(judgeReal(id, good()), id).toMatchObject({ status: 'passed' })
  })

  it('a loopback stand-in, no observation or a stopped run is never a pass', () => {
    for (const id of ITEMS) {
      expect(judgeReal(id, broken(o => { o.realModel = false })).status, id).toBe('failed')
      expect(judgeReal(id, {}).status, id).toBe('failed')
    }
    const stopped = broken(o => { delete o.tasks.next; delete o.adopted; o.stopped = { step: 'main', reason: 'main: job x did not settle' } })
    expect(judgeReal('R05', stopped)).toMatchObject({ status: 'failed', evidence: expect.stringContaining('the scenario stopped at main') })
    expect(judgeReal('R09', good())).toEqual({ status: 'not-implemented', evidence: 'no judge' })
  })

  const cases: Array<[string, string, (obs: RealObservations) => void]> = [
    ['R01', 'a history task did not complete', o => { o.tasks.history2.reason = { kind: 'error' } }],
    ['R01', 'a history table is wrong', o => { o.tasks.history3.hidden.base = false }],
    ['R01', 'a history task has no passing checks', o => { o.tasks.history1.checks = [] }],
    ['R01', 'no snapshots', o => { o.snapshots = [] }],
    ['R01', 'an ask names a capability tool', o => { o.prompts.asks.push('Draft it with capability_draft.') }],
    ['R02', 'the feedback task\'s table already has the column', o => { o.tasks.feedback.hidden.missingConvention = false }],
    ['R02', 'the feedback task\'s asked columns are wrong', o => { o.tasks.feedback.hidden.base = false }],
    ['R02', 'a feedback turn did not complete', o => { o.feedback.main[2].reason = { kind: 'error' } }],
    ['R02', 'a feedback was not recorded', o => { delete o.feedback.main[1].id }],
    ['R02', 'only two feedbacks count', o => { o.feedback.main[4].counted = false }],
    ['R02', 'a feedback names a capability tool', o => { o.prompts.comments.push('Use load_skill next time.') }],
    ['R03', 'no job started', o => { delete o.jobs.main }],
    ['R03', 'the job was started by hand', o => { o.jobs.main.trigger = 'explicit' }],
    ['R03', 'the job does not cite the counted feedback', o => { o.jobs.main.feedbackIds = [] }],
    ['R03', 'the diagnosis fails the schema', o => { o.diagnosisValid.main = { valid: false, errors: ['/failureTypes: required'] } }],
    ['R03', 'the diagnosis proposed nothing', o => { o.jobs.main.diagnosis.proposalKind = 'none' }],
    ['R03', 'no candidate came out', o => { o.candidates = [] }],
    ['R03', 'the candidate has two components', o => { o.candidates[0].components.push({ kind: 'skill', name: 'other' }) }],
    ['R03', 'the candidate is not the job\'s', o => { o.candidates[0].jobId = 'other' }],
    ['R04', 'the job never settled', o => { o.jobs.main.status = 'trialing' }],
    ['R04', 'the candidate never reached the gate', o => { o.jobs.main.history = ['queued', 'diagnosing', 'proposing', 'failed'] }],
    ['R04', 'no decision was written', o => { o.decisions = [] }],
    ['R04', 'a feedback check is unknown', o => { for (const r of receipts(o)) if (r.type === 'trial.feedback' && r.arm === 'baseline') r.status = 'unknown' }],
    ['R04', 'the feedback checks are not listed apart', o => { o.decisions[0].detail = 'adopt (quality-up). Quality passed.' }],
    ['R05', 'the gate did not adopt', o => { o.adopted = null }],
    ['R05', 'the next task did not complete', o => { o.tasks.next.reason = { kind: 'error' } }],
    ['R05', 'the next table still lacks the column', o => { o.tasks.next.hidden.pass = false }],
    ['R05', 'the next task ran in this process', o => { o.tasks.next.child.pid = o.tasks.next.child.parentPid }],
    ['R05', 'the next task ran on another version', o => { o.tasks.next.version = 'baseline' }],
    ['R05', 'the ledger shows another version', o => { o.ledgerVersions[o.tasks.next.sessionId] = ['baseline'] }],
    ['R05', 'the component was not used', o => { o.tasks.next.componentsUsed = [] }],
    ['R05', 'first use points elsewhere', o => { o.jobs.main.firstUse = { taskId: 'other' } }],
    ['R06', 'a task has no usage', o => { delete o.usage.tasks.next.costUsd }],
    ['R06', 'a feedback turn has no usage', o => { delete o.usage.feedbackTurns['main:first'].callCount }],
    ['R06', 'a job phase has no usage', o => { delete o.usage.jobs.main.phases.trial.unknownCount }],
    ['R06', 'costs do not add up', o => { o.usage.total.costUsd += 1 }],
    ['R06', 'the cap was passed', o => { o.spentBeforeUsd = 15 }],
    ['R07', 'no second job', o => { delete o.jobs.second }],
    ['R07', 'the second job did not settle', o => { o.jobs.second.status = 'proposing' }],
    ['R07', 'the second job was started by hand', o => { o.jobs.second.trigger = 'explicit' }],
  ]
  for (const [id, defect, mutate] of cases) {
    it(`${id} fails when ${defect}`, () => {
      const result = judgeReal(id, broken(mutate))
      expect(result.status, result.evidence).toBe('failed')
      expect(result.evidence).not.toContain('judge threw')
    })
  }

  it('every judge has at least one counterexample', () => {
    const covered = new Set(cases.map(([id]) => id))
    expect(ITEMS.filter(id => !covered.has(id))).toEqual([])
  })
})

describe('step-5 real scenario helpers', () => {
  it('no task ask or feedback names a capability tool (R01–R03)', () => {
    for (const text of [...HISTORY_TASKS, FEEDBACK_TASK, NEXT_TASK, SECOND_TASK].map(t => t.ask)) expect(text).not.toMatch(TOOL_NAMES)
    for (const f of [...FEEDBACK, ...SECOND_FEEDBACK]) expect(f.comment).not.toMatch(TOOL_NAMES)
  })

  it('the hidden check tells the asked columns from the convention column', () => {
    const csv = ordersCsv(FEEDBACK_TASK.month)
    expect(hiddenCheck(FEEDBACK_TASK, regionTable(csv, { withAverage: false }))).toMatchObject({ pass: false, base: true, missingConvention: true })
    expect(hiddenCheck(FEEDBACK_TASK, regionTable(csv, { withAverage: true }))).toMatchObject({ pass: true, base: true })
    expect(hiddenCheck(FEEDBACK_TASK, 'region,orders,revenue\nNorth,1,1.00\n')).toMatchObject({ pass: false, base: false })
    expect(hiddenCheck(FEEDBACK_TASK, null)).toMatchObject({ pass: false, base: false })
  })

  it('prices a job per phase from its ledger records only', () => {
    const end = (requestId: string, improvementId: string | undefined, improvementPhase: string | undefined) => [
      { type: 'llm.request.start', requestId, improvementId, improvementPhase },
      { type: 'llm.request.end', requestId, improvementId, improvementPhase, usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 } },
    ]
    const ledger = [...end('a', 'j1', 'diagnose'), ...end('b', 'j1', 'trial'), ...end('c', 'j2', 'diagnose'), ...end('d', undefined, undefined)]
    const usage = jobUsage(ledger, 'j1')
    expect(Object.keys(usage.phases)).toEqual(['diagnose', 'trial'])
    expect(usage.total.callCount).toBe(2)
    expect(usage.phases.diagnose?.known).toMatchObject({ input: 1000, output: 100 })
  })
})
