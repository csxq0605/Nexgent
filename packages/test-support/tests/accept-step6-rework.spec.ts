/**
 * The H19–H24 judges of accept-step6 (step6-rework-judges.mjs; ADR 0012, 0013) against an
 * observation recorded from one run of the rework scenario (fixtures/step6-rework-observations.json:
 * the scenario's output, no absolute paths, no key), and copies broken one fact at a time.
 * No model is called, no app is started.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { REWORK_JUDGES, type ReworkObservations } from '../../../scripts/accept-common/step6-rework-judges.mjs'

type Obs = ReworkObservations
type Mutation = (o: Obs) => void

const RECORDED: Obs = JSON.parse(readFileSync(new URL('./fixtures/step6-rework-observations.json', import.meta.url), 'utf8'))
const good = (): Obs => ({ ...structuredClone(RECORDED), step5H19: { status: 'passed', evidence: 'step 5 H19 passed' } })
const mutated = (fn: Mutation): Obs => {
  const o = good()
  fn(o)
  return o
}
const V0 = 'v0'

type Case = readonly [name: string, mutate: Mutation, phrase: string]
const COUNTERS: Record<keyof typeof REWORK_JUDGES, readonly Case[]> = {
  H19: [
    ['a job of project two did not pin the shared child', o => { o.shared.jobs.twoOnChild.improverVersion = V0 }, 'project two (sharing off): the job pinned v0'],
    ['a job after the rollback still pinned the child', o => { o.shared.jobs.oneAfterRollback.improverVersion = o.shared.child }, 'project one after the rollback: the job pinned'],
    ['a job.json says project scope', o => { o.shared.jobs.oneOnChild.improverScope = 'project' }, 'project one: job.json improverScope project'],
    ['the rollback left the child in force', o => { o.shared.rollback.inForce = o.shared.child }, 'the rollback left'],
    ['the project line is writable', o => { o.shared.projectLine.readOnly = false }, 'ImproverStore.project is project, writable'],
    ['writing the project line was not refused', o => { o.shared.projectLine.write = 'ok' }, 'writing / adopting in the project line: ok'],
    ['the project line no longer reads as history', o => { o.shared.projectLine.resolved = V0 }, 'no longer reads as history'],
    ['a job ran on the old project-level improver', o => { o.shared.jobs.oneOnChild.improverVersion = o.shared.projectLine.planted }, 'ran on its old project-level improver'],
    ['the project line changed after planting', o => { o.shared.projectLineAfter.revisions = 2 }, 'the project line changed after the planting'],
    ['project two counted with sharing off', o => { o.shared.queue.counted.push(`${o.shared.projectIds.two}:job-x`) }, 'a job of project two (sharing off) was counted'],
    ['project one\'s job is not counted', o => { o.shared.queue.counted = [] }, 'is not counted in the user queue'],
    ['a meta job of project one read project two', o => { o.shared.probe.toolResults.find((r: Obs) => r.projectId === o.shared.projectIds.two).isError = false }, 'a meta job of project one read project two'],
    ['a meta job could not read its own project', o => { o.shared.probe.toolResults.find((r: Obs) => r.projectId === o.shared.projectIds.one).isError = true }, 'could not read its own project'],
    ['improvement.end lacks the scope', o => { for (const r of o.shared.ledger.one) delete r.improverScope }, 'improvement.end says improverScope absent'],
    ['the job did not start', o => { o.shared.jobs.twoAfterRollback = { code: 'improvement/busy' } }, 'project two after the rollback: the job did not start (improvement/busy)'],
  ],
  H20: [
    ['the figure was accepted', o => { o.literal.first.proposals[0] = { isError: false, text: 'Proposed candidate x' } }, 'was accepted'],
    ['the refusal does not name the value', o => { o.literal.first.proposals[0].text = o.literal.first.proposals[0].text.replaceAll(o.literal.figure, '#') }, 'does not name the value'],
    ['the refusal does not name its source', o => { o.literal.first.proposals[0].text = o.literal.first.proposals[0].text.replace(/deliverable:|feedback:/g, 'x:') }, 'does not name the source'],
    ['the refusal does not name the file', o => { o.literal.first.proposals[0].text = o.literal.first.proposals[0].text.replaceAll('skills/region-table-figures/', '') }, 'does not name the file'],
    ['the project constant is refused too', o => { o.literal.first.proposals[0].text += ` ${o.literal.constant} (integer)` }, 'names the project constant'],
    ['the column name is refused too', o => { o.literal.first.proposals[0].text += ' avg_order_value' }, 'names the column avg_order_value'],
    ['the redraft without the figure was refused', o => { o.literal.first.proposals[1] = { isError: true, text: 'Error: not proposed' } }, 'the proposal without the figure was refused'],
    ['no candidate came of the redraft', o => { delete o.literal.first.candidateId }, 'job 1 has no candidate'],
  ],
  H21: [
    ['the job was adopted', o => { o.similar.fail.job.status = 'adopted'; o.similar.fail.decision.reason = 'gate-passed' }, 'fail: the job ended adopted (gate-passed)'],
    ['the feedback task was not fixed', o => { o.similar.fail.decision.verdict.feedbackPassRate = { candidate: 0, baseline: 0 } }, 'did not fix the feedback task'],
    ['the similar case did not get worse', o => { o.similar.fail.decision.verdict.similarPassRate = { candidate: 1, baseline: 1 } }, 'the similar case did not get worse'],
    ['overall the candidate is not better', o => { o.similar.fail.decision.verdict.passRate = { candidate: 0.5, baseline: 0.5 } }, 'overall the candidate is not better'],
    ['the similar case\'s runs do not show the failure', o => { o.similar.fail.similarTaskCase = 'nope' }, 'the similar case\'s runs'],
    ['the similar case was never replayed', o => { o.similar.fail.similarReplays = 0 }, 'never replayed the similar case'],
    ['the decision text omits similar cases', o => { o.similar.fail.decision.detail = 'x' }, 'does not report the similar cases'],
    ['an unknown similar run is not unknown-runs', o => { o.similar.unknown.decision.reason = 'similar-regression' }, 'unknown: the job ended rejected (similar-regression)'],
    ['the unknown run is not recorded', o => { o.similar.unknown.similarTaskCase = 'nope' }, 'carry no unknown'],
  ],
  H22: [
    ['the job was adopted without similar cases', o => { o.similar.none.job.status = 'adopted' }, 'the job ended adopted'],
    ['the gate gave another reason', o => { o.similar.none.decision.reason = 'gate-passed' }, 'the gate: await-approval (gate-passed)'],
    ['a similar pass rate without similar cases', o => { o.similar.none.decision.verdict.similarPassRate = { candidate: 1, baseline: 1 } }, 'carries a similar pass rate'],
    ['the decision text does not say feedback task only', o => { o.similar.none.decision.detail = 'x' }, 'checked on the feedback task only'],
    ['a history task asked in other words failed', o => { o.similar.none.asks[0].check = false }, 'did not all pass their checks'],
    ['the user-task candidates regressed', o => { o.step5H19 = { status: 'failed', evidence: 'x' } }, 'user-task candidates (step 5 H19, step 4\'s items): failed'],
  ],
  H23: [
    ['the late value was refused at propose time', o => { o.literal.second.proposal = { isError: true, text: 'Error: not proposed' } }, 'the gate\'s own check is not reached'],
    ['the note was not presented', o => { o.literal.second.notePresented = false }, 'the note with the value was not presented'],
    ['the gate replayed instead', o => { o.literal.second.decision.reason = 'no-improvement' }, 'the gate decided rejected (no-improvement)'],
    ['the decision does not list the value', o => { o.literal.second.decision.instanceLiterals = [] }, 'the decision does not list'],
    ['the hit\'s source is not the deliverable', o => { o.literal.second.decision.instanceLiterals[0].source = 'feedback:x' }, 'the hit\'s source is feedback:x'],
    ['a trial was created', o => { o.literal.second.decision.trialId = 't' }, 'a trial was created'],
    ['trial records were written', o => { o.literal.second.newTrialRecords = 3 }, '3 ledger records with a trialId'],
    ['replays reached the model', o => { o.literal.second.replayRequests = 2 }, '2 replay / review requests'],
    ['the rules id is adr-0008', o => { o.literal.rules.id = 'adr-0008' }, 'the evaluator rules id is adr-0008'],
    ['the rules id is the superseded adr-0013', o => { o.literal.rules.id = 'adr-0013' }, 'the evaluator rules id is adr-0013'],
    ['the epoch did not move with the rules id', o => { o.literal.rules.epochAdr0008 = o.literal.rules.epoch }, 'did not change with the rules id'],
    ['job 1\'s trial ran in another epoch', o => { o.literal.rules.firstTrialEpoch = 'f'.repeat(64) }, 'job 1\'s trial ran in epoch'],
  ],
  H24: [
    ['the change was accepted', o => { o.metaLiteral.refusal = { isError: false, text: 'stored' } }, 'was not refused as instance-literal'],
    ['the refusal does not name the value', o => { o.metaLiteral.refusal.text = o.metaLiteral.refusal.text.replaceAll(o.metaLiteral.figure, '#') }, 'the refusal does not name'],
    ['change.json was written', o => { o.metaLiteral.meta.change = {} }, 'change.json was written'],
    ['the meta job was adopted', o => { o.metaLiteral.meta.status = 'adopted' }, 'the meta job ended adopted'],
    ['a child was stored', o => { o.metaLiteral.lineAfter.versions.push('c'.repeat(64)) }, 'a child improver was stored'],
    ['the user line got a revision', o => { o.metaLiteral.lineAfter.history.push({ revision: 9 }) }, 'got a revision'],
    ['the batch lacks the feedback job', o => { o.metaLiteral.meta.batch = [] }, 'the meta job\'s batch lacks the feedback job'],
  ],
}

describe('step 6 rework judges (H19–H24)', () => {
  it.each(Object.entries(REWORK_JUDGES))('%s passes on the recorded observation', (_id, judge) => {
    const r = judge(good())
    expect(r.status, r.evidence).toBe('passed')
  })

  it.each(Object.entries(REWORK_JUDGES))('%s fails on undefined and on an empty observation', (_id, judge) => {
    expect(judge(undefined).status).toBe('failed')
    expect(judge({}).status).toBe('failed')
  })

  it('has counterexamples for every judge', () => {
    expect(Object.keys(COUNTERS).sort()).toEqual(Object.keys(REWORK_JUDGES).sort())
  })

  for (const [id, cases] of Object.entries(COUNTERS)) {
    describe(`${id} counterexamples`, () => {
      it.each(cases)('fails when %s', (_name, mutate, phrase) => {
        const r = REWORK_JUDGES[id as keyof typeof REWORK_JUDGES](mutated(mutate))
        expect(r.status).toBe('failed')
        expect(r.evidence).toContain(phrase)
      })
    })
  }
})
