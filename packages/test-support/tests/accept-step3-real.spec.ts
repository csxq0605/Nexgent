/**
 * The accept-step3 R judges against hand-made observations in the shape
 * step3-real.mjs collects: a passing set of five runs, and for every judge
 * copies broken in the ways it exists to catch. No model is called.
 */
import { describe, expect, it } from 'vitest'
import { judgeReal, REAL_JUDGES, type RealObservations } from '../../../scripts/accept-common/step3-real-judges.mjs'

const usage = (callCount: number, costUsd: number) => ({ callCount, known: { input: 100, output: 2000, cacheRead: 5000, cacheWrite: 3000 }, unknownCount: 0, unknownRequestIds: [], costUsd })
const turns = { first: { reason: { kind: 'completed' } }, feedback: { reason: { kind: 'completed' } } }
const member = (name: string, executionForm: string) => ({ sessionId: `s-${name}`, member: { name, executionForm, parentSessionId: 'root' } })
const run = (id: string, form: string, extra: Record<string, unknown>) => ({
  id, form, realModel: true, phases: structuredClone(turns), hidden: { pass: true, problems: [] }, children: [], deliverables: [],
  collaboration: { runs: [], workflows: [] }, formsUsed: [['direct']], rootTexts: [{ turn: 1, text: '我直接完成。' }], usage: usage(8, 0.2), ...extra,
})

function good(): RealObservations {
  return {
    budgetUsd: 15,
    spentBeforeUsd: 0.11,
    totalCostUsd: 2.4,
    runs: {
      R01: run('R01', 'direct', {}),
      R02: run('R02', 'delegated', {
        children: [member('writer', 'delegated')],
        deliverables: [{ deliverableId: 'd1', versions: [{ version: 1, memberName: 'writer', files: ['purchase.xlsx'] }] }],
        formsUsed: [['direct', 'delegated'], ['direct']],
      }),
      R03: run('R03', 'team', {
        children: [member('alice', 'team'), member('bob', 'team')],
        collaboration: { runs: [], workflows: [], team: { members: [{ name: 'alice' }, { name: 'bob' }], tasks: [], messages: [{ from: 'alice', to: 'bob', state: 'delivered' }] } },
        formsUsed: [['direct', 'team']],
      }),
      R04: run('R04', 'workflow', {
        children: [member('check', 'workflow'), member('write', 'workflow')],
        collaboration: { runs: [{ name: 'check', executionForm: 'workflow' }, { name: 'write', executionForm: 'workflow' }], workflows: [{ kind: 'script', status: 'completed' }] },
        formsUsed: [['direct', 'workflow']],
      }),
      R05: run('R05', 'unspecified', { rootTexts: [{ turn: 1, text: '任务简单，我直接完成。' }] }),
    },
  }
}
function broken(mutate: (obs: RealObservations) => void): RealObservations {
  const copy = good()
  mutate(copy)
  return copy
}

describe('accept-step3 R judges', () => {
  it('all pass on a complete real set of runs', () => {
    for (const id of Object.keys(REAL_JUDGES)) {
      const result = judgeReal(id, good())
      expect(result.status, `${id}: ${result.evidence}`).toBe('passed')
    }
    expect(judgeReal('R06', good()).evidence).toMatch(/R01 direct: 8 requests, ~0.2 USD, pass; R02 delegated/)
  })

  const cases: Array<[string, string, (obs: RealObservations) => void]> = [
    ['R01', 'the hidden check failed', obs => { obs.runs.R01.hidden = { pass: false, problems: ['v2: Plan P01: no formula cell'] } }],
    ['R01', 'it delegated', obs => { obs.runs.R01.children = [member('x', 'delegated')]; obs.runs.R01.formsUsed = [['direct', 'delegated']] }],
    ['R01', 'it ran against a loopback stand-in', obs => { obs.runs.R01.realModel = false }],
    ['R01', 'the feedback round did not complete', obs => { obs.runs.R01.phases.feedback = { skipped: 'no purchase.xlsx deliverable after round 1' } }],
    ['R02', 'no member was started', obs => { obs.runs.R02.children = [] }],
    ['R02', 'only the root presented', obs => { obs.runs.R02.deliverables[0].versions[0].memberName = null }],
    ['R03', 'one teammate only', obs => { obs.runs.R03.collaboration.team.members.pop() }],
    ['R03', 'no mailbox message', obs => { obs.runs.R03.collaboration.team.messages = [] }],
    ['R04', 'no workflow', obs => { obs.runs.R04.collaboration.workflows = [] }],
    ['R04', 'one workflow member', obs => { obs.runs.R04.collaboration.runs.pop() }],
    ['R05', 'the choice was not stated', obs => { obs.runs.R05.rootTexts = [] }],
    ['R05', 'the run errored', obs => { obs.runs.R05.error = 'Error: R05 round 1 did not finish' }],
    ['R06', 'a form did not run', obs => { delete obs.runs.R03 }],
    ['R06', 'a cost is unknown', obs => { obs.runs.R04.usage.costUsd = undefined }],
    ['R07', 'a run is missing (stopped for the budget)', obs => { delete obs.runs.R05; obs.stoppedForBudget = { before: 'R05', spentUsd: 13 } }],
    ['R07', 'the total passed the cap', obs => { obs.totalCostUsd = 15.5 }],
    ['R07', 'an unknown count is missing', obs => { delete obs.runs.R02.usage.unknownCount }],
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
    expect(Object.keys(REAL_JUDGES).filter(id => !covered.has(id))).toEqual([])
  })

  it('no observations at all is a failure, never a pass', () => {
    for (const id of Object.keys(REAL_JUDGES)) expect(judgeReal(id, {}).status, id).toBe('failed')
  })
})
