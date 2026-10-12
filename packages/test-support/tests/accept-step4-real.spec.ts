/**
 * The accept-step4 R judges against hand-made observations in the shape
 * step4-real.mjs collects: a passing run (history, task A, an adopting gate,
 * task B in its own process, an injected regression rolled back), and for
 * every judge copies broken in the ways it exists to catch. No model is called.
 */
import { describe, expect, it } from 'vitest'
import { judgeReal, REAL_JUDGES, type RealObservations } from '../../../scripts/accept-common/step4-real-judges.mjs'
import { brokenModuleSource, hiddenCheck, usageOf } from '../../../scripts/accept-common/step4-real.mjs'
import { expectedSummary, ordersCsv } from '../../../scripts/real-task/step4-orders.mjs'

const A = 'a'.repeat(64)
const I = 'b'.repeat(64)
const usage = (callCount: number, costUsd: number) => ({ callCount, known: { input: 100, output: 2000, cacheRead: 5000, cacheWrite: 3000 }, unknownCount: 0, unknownRequestIds: [], costUsd })
const checks = [{ command: 'node --test checks/x.test.mjs', passed: true }]
const done = (id: string, sessionId: string, version: string, extra: Record<string, unknown> = {}) => ({
  id, sessionId, reason: { kind: 'completed' }, version, taskId: `t-${sessionId}`, componentsUsed: [], checks: structuredClone(checks), hidden: { pass: true, problems: [] }, ...extra,
})
const used = (version: string, errors = 0) => [{ kind: 'function-module', name: 'order-summary', version, calls: 2, errors }]

function good(): RealObservations {
  return {
    realModel: true,
    budgetUsd: 15,
    spentBeforeUsd: 0,
    rule: { windowTasks: 3, consecutiveErrors: 3 },
    tasks: {
      history1: done('summary-2026-06', 's1', 'baseline'),
      history2: done('regions-2026-08', 's2', 'baseline'),
      A: done('summary-2026-09', 'sA', 'baseline'),
      B: done('summary-2026-10', 'sB', A, { componentsUsed: used(A), child: { pid: 222, parentPid: 111, exitCode: 0 } }),
      regress1: done('summary-2026-11', 'sR1', I, { componentsUsed: used(I, 2) }),
      regress2: done('summary-2026-12', 'sR2', I, { componentsUsed: used(I, 1) }),
      afterRollback: done('summary-2027-02', 'sD', A, { componentsUsed: used(A) }),
    },
    candidates: [{ id: 'c1', version: A, base: 'baseline', taskId: 't-sA', components: [{ kind: 'function-module', name: 'order-summary' }, { kind: 'skill', name: 'monthly-summary' }] }],
    proposals: [{ candidateId: 'c1', proofs: [{ kind: 'function-module', name: 'order-summary', turn: 1, toolCallId: 'x' }] }],
    gate: { c1: { line: { status: 'adopted', verdict: { outcome: 'adopt', reason: 'quality-up' } } } },
    adopted: { candidateId: 'c1', version: A },
    trials: {
      tr1: [
        { type: 'trial.start', trialId: 'tr1', candidateId: 'c1', plan: { repeats: 2, selection: [{ caseId: 'k1' }], guard: [{ caseId: 'k2' }] } },
        { type: 'trial.run', arm: 'candidate', status: 'pass' },
        { type: 'trial.run', arm: 'baseline', status: 'fail' },
        { type: 'trial.end', status: 'adopted', verdict: { outcome: 'adopt', reason: 'quality-up', passRate: { candidate: 1, baseline: 0.5 }, costRatio: 0.9, decidedByReview: false } },
      ],
    },
    decisions: [
      { id: 'd1', outcome: 'adopted', trigger: 'gate', candidateId: 'c1', trialId: 'tr1', fromVersion: 'baseline', toVersion: A, verdict: { outcome: 'adopt' }, cost: { candidate: {}, baseline: {}, review: {} } },
      { id: 'd2', outcome: 'adopted', trigger: 'gate', candidateId: 'c2', fromVersion: A, toVersion: I, verdict: { outcome: 'adopt' } },
      { id: 'd3', outcome: 'rolled-back', trigger: 'usage-regression', reason: 'component-errors', candidateId: 'c2', fromVersion: I, toVersion: A, regression: { observations: [{ taskId: 't-sR1' }, { taskId: 't-sR2' }], consecutiveErrors: 3 } },
    ],
    activation: [
      { revision: 1, type: 'adopt', trigger: 'gate', version: A, decisionId: 'd1' },
      { revision: 2, type: 'adopt', trigger: 'gate', version: I, decisionId: 'd2' },
      { revision: 3, type: 'rollback', trigger: 'usage-regression', from: I, version: A, decisionId: 'd3' },
    ],
    injection: { candidateId: 'c2', version: I, from: A, module: 'order-summary', functions: ['summarizeOrders'] },
    regression: { tasks: ['regress1', 'regress2'] },
    snapshots: ['s1/out/summary-2026-06.json', 's2/out/regions-2026-08.csv'],
    ledgerVersions: { s1: ['baseline'], s2: ['baseline'], sA: ['baseline'], sB: [A], sR1: [I], sR2: [I], sD: [A] },
    usage: {
      tasks: { history1: usage(6, 0.2), history2: usage(5, 0.18), A: usage(14, 0.6), B: usage(4, 0.15), regress1: usage(7, 0.25), regress2: usage(6, 0.2), afterRollback: usage(5, 0.17) },
      trials: { tr1: usage(40, 1.5) },
      trial: usage(40, 1.5),
      main: usage(47, 1.75),
      total: usage(87, 3.25),
    },
    totalCostUsd: 3.25,
  }
}
function broken(mutate: (obs: RealObservations) => void): RealObservations {
  const copy = good()
  mutate(copy)
  return copy
}

describe('accept-step4 R judges', () => {
  it('all pass on a complete real run', () => {
    for (const id of Object.keys(REAL_JUDGES)) {
      const result = judgeReal(id, good())
      expect(result.status, `${id}: ${result.evidence}`).toBe('passed')
    }
    expect(judgeReal('R03', good()).evidence).toMatch(/gate verdict adopt \(quality-up\)/)
    expect(judgeReal('R06', good()).evidence).toMatch(/trial 40 req ~1.5 USD; total ~3.25 USD/)
  })

  const cases: Array<[string, string, (obs: RealObservations) => void]> = [
    ['R01', 'it ran against a loopback stand-in', obs => { obs.realModel = false }],
    ['R01', 'a history task failed the hidden check', obs => { obs.tasks.history2.hidden = { pass: false, problems: ['the region table does not match the orders'] } }],
    ['R01', 'a history task recorded no checks', obs => { obs.tasks.history1.checks = [] }],
    ['R01', 'there are no snapshots', obs => { obs.snapshots = [] }],
    ['R02', 'task A did not complete', obs => { obs.tasks.A.reason = { kind: 'cap-reached' } }],
    ['R02', 'task A proposed nothing', obs => { obs.candidates = []; obs.proposals = [] }],
    ['R02', 'the candidate is neither a function module nor a skill', obs => { obs.candidates[0].components = [{ kind: 'context-policy', name: 'p' }] }],
    ['R02', 'the proposal has no proofs', obs => { obs.proposals = [{ candidateId: 'c1', proofs: [] }] }],
    ['R03', 'the trial result is unknown', obs => { obs.trials.tr1[3].status = 'unknown' }],
    ['R03', 'the trial never ended', obs => { obs.trials.tr1.pop() }],
    ['R03', 'only the candidate arm ran', obs => { obs.trials.tr1.splice(2, 1) }],
    ['R03', 'no gate decision was written', obs => { obs.decisions = obs.decisions.filter((d: { id: string }) => d.id !== 'd1') }],
    ['R03', 'the gate printed nothing', obs => { obs.gate.c1.line = null }],
    ['R04', 'the gate rejected', obs => { obs.adopted = null; delete obs.tasks.B; obs.stopped = { step: 'gate', reason: 'the gate did not adopt a candidate' } }],
    ['R04', 'B ran in the parent process', obs => { obs.tasks.B.child.pid = 111 }],
    ['R04', 'B did not call the component', obs => { obs.tasks.B.componentsUsed = [] }],
    ['R04', 'B ran on the baseline', obs => { obs.tasks.B.version = 'baseline'; obs.ledgerVersions.sB = ['baseline'] }],
    ['R04', 'part of B\'s ledger carries another version', obs => { obs.ledgerVersions.sB = [A, 'baseline'] }],
    ['R04', 'B failed the hidden check', obs => { obs.tasks.B.hidden = { pass: false, problems: ['revenue 1, expected 2'] } }],
    ['R05', 'nothing was injected', obs => { obs.injection = { skipped: 'the adopted version has no function module to break' } }],
    ['R05', 'no rollback fired', obs => { obs.decisions.pop(); obs.activation.pop() }],
    ['R05', 'the rollback came too late', obs => { obs.decisions[2].regression.observations = [{}, {}, {}, {}] }],
    ['R05', 'the next task stayed on the injected version', obs => { obs.tasks.afterRollback.version = I }],
    ['R05', 'the next task did not complete', obs => { obs.tasks.afterRollback.reason = { kind: 'error' } }],
    ['R05', 'the rollback was manual', obs => { obs.decisions[2].trigger = 'manual' }],
    ['R06', 'a task\'s cost is unknown', obs => { obs.usage.tasks.B.costUsd = undefined }],
    ['R06', 'the trial is not reported apart', obs => { delete obs.usage.trial }],
    ['R06', 'the total passed the cap', obs => { obs.spentBeforeUsd = 12; obs.totalCostUsd = 3.25 }],
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

describe('accept-step4 real helpers', () => {
  it('hiddenCheck passes the right summary and region table and fails a wrong one', () => {
    const month = '2026-11'
    const summary = expectedSummary(ordersCsv(month))
    const task = { kind: 'summary', month, output: `out/summary-${month}.json` }
    expect(hiddenCheck(task, JSON.stringify(summary)).pass).toBe(true)
    expect(hiddenCheck(task, JSON.stringify({ ...summary, revenue: summary.revenue + 1 })).pass).toBe(false)
    expect(hiddenCheck(task, null)).toEqual({ pass: false, problems: [`${task.output} was not written`] })
    expect(hiddenCheck({ kind: 'regions', month, output: 'out/r.csv' }, 'region,orders,revenue\n').pass).toBe(false)
  })

  it('brokenModuleSource exports every declared function, each throwing', async () => {
    const source = brokenModuleSource({ functions: [{ name: 'summarizeOrders' }, { name: 'topProduct' }] })
    const module = await import(`data:text/javascript,${encodeURIComponent(source)}`) as Record<string, () => unknown>
    expect(Object.keys(module).sort()).toEqual(['summarizeOrders', 'topProduct'])
    expect(() => module.summarizeOrders!()).toThrow(/injected regression/)
  })

  it('usageOf counts requests across sessions and marks a request without usage unknown', () => {
    const u = usageOf([
      { type: 'llm.request.start', requestId: 'r1', sessionId: 'a' },
      { type: 'llm.request.end', requestId: 'r1', sessionId: 'a', usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } },
      { type: 'llm.request.start', requestId: 'r2', sessionId: 'b' },
    ])
    expect(u).toMatchObject({ callCount: 2, unknownCount: 1, unknownRequestIds: ['r2'], costUsd: 2 })
  })
})
