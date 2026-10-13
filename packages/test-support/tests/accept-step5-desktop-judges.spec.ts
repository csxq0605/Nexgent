/**
 * The D19–D23 judges of accept-step5 (step5-desktop-judges.mjs) against a
 * hand-made observation in the shape the improvements desktop scenario
 * collects, and copies broken in the ways each judge exists to catch.
 * No model is called, no app is started.
 */
import { describe, expect, it } from 'vitest'
import { DESKTOP_JUDGES, judgeDesktop } from '../../../scripts/accept-common/step5-desktop-judges.mjs'
import type { ImprovementsDesktopObservations } from '../../../scripts/accept-common/step5-desktop.mjs'

const IDS = { noProposal: 'job-none', failed: 'job-failed', rejected: 'job-rejected', adopted: 'job-adopted' }
const FEEDBACK_SESSION = 'sess-feedback'
const DELIVERABLE = 'deliv-1'
const NEXT_SESSION = 'sess-next'
const DECIDED = '2026-10-13T09:00:00.000Z'
const FIRST_USE_AT = '2026-10-13T09:05:00.000Z'
const GATE_TEXT = 'Selection checks passed.'

const card = (id: string, status: string, statusText: string, items: number, cost: string, detailText: string | null) => ({
  id, status, statusText, trigger: `手动 · ${items} 条信号`, cost, detailText, cancel: false, expanded: false,
})
const phasesOf = (names: string[]) => names.map(phase => ({ phase, text: `${{ diagnose: '诊断', propose: '提出候选', trial: '门控试验' }[phase]}：104 tokens` }))
const candidateText = '候选技能 · region-table-convention已采用Region tables carry avg_order_value.'
const gate = (outcome: string, reason: string) => `${outcome}：${reason}。${GATE_TEXT}`

function good(): ImprovementsDesktopObservations {
  const diagnosis = (hypothesis: string) => ({ hypothesis, proposalKind: 'skill' })
  const decision = (outcome: string, reason: string, extra: object = {}) => ({ outcome, reason, decidedByReview: false, passRate: { candidate: 1, baseline: 1 }, ...extra })
  const candidate = { components: [{ kind: 'skill', name: 'region-table-convention' }], summary: 'Region tables carry avg_order_value.' }
  const detailWithGate = (verdictText: string, feedback: string | null) => ({
    diagnosis: '诊断假设：The region table lacks the column.建议的组件：技能',
    failures: ['任务验证 · output not checked（1 条证据）'],
    candidate: candidateText,
    gate: `门控结果${verdictText}检查通过率 候选 100% / 基线 100%`,
    gateVerdict: verdictText,
    gateRate: '检查通过率 候选 100% / 基线 100%',
    gateFeedback: feedback,
    gateReview: null,
    phases: phasesOf(['diagnose', 'propose', 'trial']),
    firstUse: null,
    rolledBack: null,
  })
  return {
    consoleErrors: { first: [], second: [], third: [] },
    prepared: {
      feedbackSession: FEEDBACK_SESSION,
      deliverableId: DELIVERABLE,
      noProposal: { id: IDS.noProposal, status: 'no-proposal' },
      failed: { id: IDS.failed, status: 'failed' },
      rejected: { id: IDS.rejected, status: 'rejected' },
      adopted: { id: IDS.adopted, status: 'adopted' },
    },
    list: {
      pending: '已计入 0 / 3 条反馈',
      budget: '预算 7,176 / 3,000,000 tokens（30 天内）',
      cards: [
        card(IDS.adopted, 'adopted', '已采用', 3, '≈ $0.01 · 3,224 tokens', gate('已采用', '检查通过率高于基线')),
        card(IDS.rejected, 'rejected', '未采用', 3, '≈ $0.01 · 3,224 tokens', `Rejected (unknown-runs): ${GATE_TEXT}`),
        card(IDS.failed, 'failed', '失败', 0, '≈ $0.00 · 624 tokens', 'The candidate has 2 components; an improvement job proposes exactly one.'),
        card(IDS.noProposal, 'no-proposal', '不是能力问题', 3, '≈ $0.00 · 104 tokens', 'Not a capability problem: nothing was missing.'),
      ],
    },
    details: {
      [IDS.noProposal]: { diagnosis: '诊断假设：Nothing was missing.建议的组件：无系统设计 · requirement changed（1 条证据）', failures: ['系统设计 · requirement changed（1 条证据）'], candidate: '候选还没有产生候选。', gate: '门控结果还没有门控结果。', gateVerdict: null, gateRate: null, gateFeedback: null, gateReview: null, phases: phasesOf(['diagnose']), firstUse: null, rolledBack: null },
      [IDS.failed]: { diagnosis: '诊断假设：Missing column.建议的组件：技能任务验证 · x（1 条证据）', failures: ['任务验证 · x（1 条证据）'], candidate: '候选还没有产生候选。', gate: '门控结果还没有门控结果。', gateVerdict: null, gateRate: null, gateFeedback: null, gateReview: null, phases: phasesOf(['diagnose', 'propose']), firstUse: null, rolledBack: null },
      [IDS.rejected]: { ...detailWithGate(gate('未采用', '有运行结果未知'), '反馈检查（单独记）候选 未知 / 基线 0%'), candidate: candidateText.replace('已采用', '未采用') },
      [IDS.adopted]: detailWithGate(gate('已采用', '检查通过率高于基线'), '反馈检查（单独记）候选 100% / 基线 0%（2/4）'),
    },
    files: {
      queue: { counted: 3, pending: 0 },
      jobs: {
        [IDS.noProposal]: { id: IDS.noProposal, trigger: 'explicit', status: 'no-proposal', items: 3, request: { sessionId: FEEDBACK_SESSION }, detail: 'Not a capability problem: nothing was missing.', phases: ['diagnose'], diagnosis: diagnosis('Nothing was missing.') },
        [IDS.failed]: { id: IDS.failed, trigger: 'explicit', status: 'failed', items: 0, request: { sessionId: FEEDBACK_SESSION }, detail: 'The candidate has 2 components; an improvement job proposes exactly one.', phases: ['diagnose', 'propose'], diagnosis: diagnosis('Missing column.') },
        [IDS.rejected]: { id: IDS.rejected, trigger: 'explicit', status: 'rejected', items: 3, request: { sessionId: FEEDBACK_SESSION }, detail: `Rejected (unknown-runs): ${GATE_TEXT}`, phases: ['diagnose', 'propose', 'trial'], candidate, decision: decision('rejected', 'unknown-runs', { feedbackPassRate: { candidate: null, baseline: 0 } }), diagnosis: diagnosis('Missing column.') },
        [IDS.adopted]: { id: IDS.adopted, trigger: 'explicit', status: 'adopted', items: 3, request: { sessionId: FEEDBACK_SESSION }, detail: gate('已采用', ''), phases: ['diagnose', 'propose', 'trial'], candidate, decision: decision('adopted', 'quality-up', { feedbackPassRate: { candidate: 1, baseline: 0 } }), diagnosis: diagnosis('Missing column.') },
      },
    },
    firstUse: {
      nextSession: NEXT_SESSION,
      ui: '首次被任务使用：10-13 09:05',
      nudged: true,
      file: { taskId: 't1', sessionId: NEXT_SESSION, at: FIRST_USE_AT, version: 'v'.repeat(64) },
      adoptedDecidedAt: DECIDED,
    },
    deliverable: { cardCount: 1 },
    deliverableJob: {
      id: 'job-new',
      firstSeen: 'queued',
      seen: ['queued', 'diagnosing', 'no-proposal'],
      final: card('job-new', 'no-proposal', '不是能力问题', 0, '≈ $0.00 · 104 tokens', 'Not a capability problem.'),
      file: { id: 'job-new', trigger: 'explicit', status: 'no-proposal', items: 0, request: { sessionId: FEEDBACK_SESSION, deliverableId: DELIVERABLE } },
      deliverableId: DELIVERABLE,
      feedbackSession: FEEDBACK_SESSION,
      newJobs: ['job-new'],
    },
    settings: {
      initial: { autoImprove: false, budget: '3000000', window: '30' },
      saveOn: { approvalDialogs: 0 },
      configOn: { autoImprove: true, budget: 2_500_000, window: 7 },
      restartOn: { autoImprove: true, budget: '2500000', window: '7' },
      saveOff: { approvalDialogs: 0 },
      configOff: { autoImprove: false, budget: 3_000_000, window: 10 },
      restartOff: { autoImprove: false, budget: '3000000', window: '10' },
    },
    autoOff: { submitted: ['first', 'second', 'third'], jobsBefore: 5, jobsAfter: 5, queueBefore: { counted: 3, pending: 0 }, queueAfter: { counted: 6, pending: 3 }, config: { autoImprove: false, budget: 3_000_000, window: 10 } },
  }
}

type Mutate = (obs: ImprovementsDesktopObservations) => void
function broken(mutate: Mutate): { improvements: ImprovementsDesktopObservations } {
  const copy = structuredClone(good())
  mutate(copy)
  return { improvements: copy }
}
const run = (id: string, mutate: Mutate) => judgeDesktop(id, broken(mutate))
const card_ = (o: ImprovementsDesktopObservations, id: string) => o['list'].cards.find((c: { id: string }) => c.id === id)

/** Counterexamples: [item, what is wrong, how to break a good copy]. */
const BREAKS: Array<[string, string, Mutate]> = [
  // D19
  ['D19', 'a job is missing from the tab', o => { o['list'].cards = o['list'].cards.filter((c: { id: string }) => c.id !== IDS.failed) }],
  ['D19', 'a card shows another status than the job file', o => { card_(o, IDS.rejected).status = 'failed' }],
  ['D19', 'the adoption is not said in words', o => { card_(o, IDS.adopted).statusText = '失败' }],
  ['D19', 'the trigger reason is missing', o => { card_(o, IDS.adopted).trigger = '3 条信号' }],
  ['D19', 'the signal count disagrees with the job', o => { card_(o, IDS.adopted).trigger = '手动 · 9 条信号' }],
  ['D19', 'the cost is unknown', o => { card_(o, IDS.rejected).cost = '费用未知' }],
  ['D19', 'a job does not open', o => { o['details'][IDS.rejected] = { error: 'timed out' } }],
  ['D19', 'the cost by phase misses a phase', o => { o['details'][IDS.adopted].phases.pop() }],
  ['D19', 'the candidate does not say what it changed', o => { o['details'][IDS.adopted].candidate = '候选还没有产生候选。' }],
  ['D19', 'the gate result is not shown', o => { o['details'][IDS.adopted].gateVerdict = null }],
  ['D19', 'the gate result says the wrong outcome', o => { o['details'][IDS.rejected].gateVerdict = gate('已采用', '有运行结果未知') }],
  ['D19', 'the pass rates are not shown', o => { o['details'][IDS.adopted].gateRate = null }],
  ['D19', 'the budget is not shown', o => { o['list'].budget = null }],
  ['D19', 'the adopted job claims a use before any task', o => { o['details'][IDS.adopted].firstUse = '首次被任务使用：10-13 08:00' }],
  ['D19', 'console errors in the first launch', o => { o['consoleErrors'].first = ['boom'] }],
  ['D19', 'the prepared jobs are not of the four kinds', o => { o['prepared'].rejected.status = 'adopted' }],
  // D20
  ['D20', 'the no-proposal reason is not on the card', o => { card_(o, IDS.noProposal).detailText = null }],
  ['D20', 'the no-proposal job shows no diagnosis', o => { o['details'][IDS.noProposal].diagnosis = null }],
  ['D20', 'the no-proposal job lists no failure type', o => { o['details'][IDS.noProposal].failures = [] }],
  ['D20', 'the failure reason differs from the job', o => { card_(o, IDS.failed).detailText = 'something went wrong' }],
  ['D20', 'the failed job shows nothing of its diagnosis', o => { o['details'][IDS.failed].diagnosis = '诊断' }],
  ['D20', 'the rejection reason is not in words', o => { o['details'][IDS.rejected].gateVerdict = '未采用：unknown-runs' }],
  ['D20', 'the rejected job is not rejected in the job file', o => { o['files'].jobs[IDS.rejected].decision.outcome = 'adopted' }],
  ['D20', 'the feedback check line is missing', o => { o['details'][IDS.adopted].gateFeedback = null }],
  ['D20', 'the feedback check is not marked as separate', o => { o['details'][IDS.adopted].gateFeedback = '候选 100% / 基线 0%' }],
  ['D20', 'the feedback check is mixed into the pass rate line', o => { o['details'][IDS.adopted].gateRate = '检查通过率 候选 100% / 基线 100% 反馈检查（单独记）候选 100%' }],
  ['D20', 'the reviewer note is absent although the review decided', o => { o['files'].jobs[IDS.rejected].decision.decidedByReview = true }],
  ['D20', 'the reviewer note is shown although the checks decided', o => { o['details'][IDS.adopted].gateReview = '审核模型的意见决定了结果（仅在检查持平时）。' }],
  ['D20', 'a feedback line is shown without a feedback verdict', o => { delete o['files'].jobs[IDS.rejected].decision.feedbackPassRate }],
  ['D20', 'console errors', o => { o['consoleErrors'].first = ['boom'] }],
  // D21
  ['D21', 'no deliverable card on screen', o => { o['deliverable'].cardCount = 0 }],
  ['D21', 'no new job appeared', o => { delete o['deliverableJob'].id }],
  ['D21', 'more than one job was added', o => { o['deliverableJob'].newJobs = ['job-new', 'job-other'] }],
  ['D21', 'the job is not explicit', o => { o['deliverableJob'].file.trigger = 'feedback-count' }],
  ['D21', 'the job does not point at the deliverable', o => { o['deliverableJob'].file.request = { sessionId: FEEDBACK_SESSION } }],
  ['D21', 'the job points at another conversation', o => { o['deliverableJob'].file.request.sessionId = 'other' }],
  ['D21', 'the tab never showed progress', o => { o['deliverableJob'].seen = ['no-proposal'] }],
  ['D21', 'the tab ends on another status than the file', o => { o['deliverableJob'].final.status = 'diagnosing' }],
  ['D21', 'the job never ended', o => { o['deliverableJob'].final.status = 'diagnosing'; o['deliverableJob'].file.status = 'diagnosing' }],
  ['D21', 'the final status text is wrong', o => { o['deliverableJob'].final.statusText = '失败' }],
  // D22
  ['D22', 'the page did not start from the stored value', o => { o['settings'].initial.autoImprove = true }],
  ['D22', 'saving asked for approval', o => { o['settings'].saveOn.approvalDialogs = 1 }],
  ['D22', 'config.json did not take the toggle', o => { o['settings'].configOn.autoImprove = false }],
  ['D22', 'config.json did not take the budget', o => { o['settings'].configOn.budget = undefined }],
  ['D22', 'the value did not survive the first restart', o => { o['settings'].restartOn.window = '30' }],
  ['D22', 'the toggle did not survive the first restart', o => { o['settings'].restartOn.autoImprove = false }],
  ['D22', 'the second change is not in config.json', o => { o['settings'].configOff = { ...o['settings'].configOn } }],
  ['D22', 'the value did not survive the second restart', o => { o['settings'].restartOff.budget = '2500000' }],
  ['D22', 'the final toggle is still on', o => { o['settings'].restartOff.autoImprove = true; o['settings'].configOff.autoImprove = true }],
  ['D22', 'console errors after a restart', o => { o['consoleErrors'].third = ['boom'] }],
  ['D22', 'fewer than three feedback entries were submitted', o => { o['autoOff'].submitted = ['first'] }],
  ['D22', 'the queue did not count them', o => { o['autoOff'].queueAfter.counted = 3 }],
  ['D22', 'a job started although it was off', o => { o['autoOff'].jobsAfter = 6 }],
  ['D22', 'automatic improvement was on while submitting', o => { o['autoOff'].config.autoImprove = true }],
  // D23
  ['D23', 'the screen never shows the first use', o => { o['firstUse'].ui = null }],
  ['D23', 'the screen shows no time', o => { o['firstUse'].ui = '首次被任务使用：' }],
  ['D23', 'the job file records no first use', o => { o['firstUse'].file = null }],
  ['D23', 'the recorded use is not the next task', o => { o['firstUse'].file.sessionId = 'other' }],
  ['D23', 'the recorded use is before the adoption', o => { o['firstUse'].file.at = '2026-10-13T08:00:00.000Z' }],
  ['D23', 'the job claimed a use before the next task', o => { o['files'].jobs[IDS.adopted].firstUse = { at: DECIDED } }],
  ['D23', 'the next task did not run', o => { delete o['firstUse'].nextSession }],
  ['D23', 'the job under test was not adopted', o => { o['prepared'].adopted.status = 'rejected' }],
  ['D23', 'the rejected job shows a use', o => { o['details'][IDS.rejected].firstUse = '首次被任务使用：10-13 09:05' }],
]

describe('accept-step5 desktop judges (D19–D23)', () => {
  it('has the five items', () => {
    expect(Object.keys(DESKTOP_JUDGES)).toEqual(['D19', 'D20', 'D21', 'D22', 'D23'])
  })

  it('all pass on a complete observation', () => {
    for (const id of Object.keys(DESKTOP_JUDGES)) expect(judgeDesktop(id, { improvements: good() }), id).toMatchObject({ status: 'passed' })
  })

  it('a pass names what was seen', () => {
    expect(judgeDesktop('D21', { improvements: good() }).evidence).toMatch(/job-new|queued → diagnosing → no-proposal/)
    expect(judgeDesktop('D23', { improvements: good() }).evidence).toContain('首次被任务使用')
    expect(judgeDesktop('D22', { improvements: good() }).evidence).toContain('2500000')
  })

  for (const [id, what, mutate] of BREAKS) {
    it(`${id} fails when ${what}`, () => {
      const result = run(id, mutate)
      expect(result.status).toBe('failed')
      expect(result.evidence).toMatch(/not satisfied/)
    })
  }

  it('every item has at least three counterexamples', () => {
    for (const id of Object.keys(DESKTOP_JUDGES)) expect(BREAKS.filter(([item]) => item === id).length, id).toBeGreaterThanOrEqual(3)
  })

  it('without observations, or with the scenario error, every item fails', () => {
    for (const id of Object.keys(DESKTOP_JUDGES)) {
      expect(judgeDesktop(id, {}), id).toMatchObject({ status: 'failed', evidence: expect.stringMatching(/no observations/) })
      expect(judgeDesktop(id, { improvementsError: new Error('chromium missing') }), id).toMatchObject({ status: 'failed', evidence: expect.stringContaining('chromium missing') })
      expect(judgeDesktop(id, { improvements: undefined, improvementsError: 'no display' }), id).toMatchObject({ status: 'failed' })
    }
  })

  it('a scenario that stopped fails the items whose observations are missing, naming the step; items already observed still judge', () => {
    const stopped = good()
    stopped['error'] = { step: 'D21 improve from a deliverable card', message: 'locator timed out\nstack' }
    delete stopped['deliverableJob']
    delete stopped['settings']
    delete stopped['autoOff']
    expect(judgeDesktop('D21', { improvements: stopped })).toMatchObject({ status: 'failed', evidence: expect.stringContaining('D21 improve from a deliverable card') })
    expect(judgeDesktop('D22', { improvements: stopped })).toMatchObject({ status: 'failed', evidence: expect.stringContaining('D21 improve from a deliverable card') })
    for (const id of ['D19', 'D20', 'D23']) expect(judgeDesktop(id, { improvements: stopped }), id).toMatchObject({ status: 'passed' })
  })

  it('an unknown result is no pass: empty observations of an otherwise running scenario fail', () => {
    for (const id of Object.keys(DESKTOP_JUDGES)) expect(judgeDesktop(id, { improvements: {} }).status, id).toBe('failed')
  })

  it('a throwing judge becomes failed', () => {
    const hostile = { improvements: new Proxy({}, { get() { throw new Error('exploded') } }) }
    expect(judgeDesktop('D19', hostile as never)).toMatchObject({ status: 'failed', evidence: expect.stringContaining('exploded') })
    expect(judgeDesktop('D99', { improvements: good() })).toMatchObject({ status: 'failed' })
  })
})
