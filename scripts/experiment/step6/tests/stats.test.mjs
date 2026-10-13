import { test } from 'node:test'
import assert from 'node:assert/strict'
import { amortize, armCost, pairedDiff, quantile, spread, verdictOf } from '../stats.mjs'

/** Runs from a table `{ caseId: { arm: [pass, ...] } }`. */
function runs(table, { family = 'f', cost = 0.1 } = {}) {
  const out = []
  for (const [caseId, arms] of Object.entries(table)) {
    for (const [arm, results] of Object.entries(arms)) {
      results.forEach((pass, repeat) => out.push({ runId: `${caseId}-${arm}-${repeat}`, family, caseId, arm, repeat, pass, costUsd: cost }))
    }
  }
  return out
}

test('quantile interpolates between order statistics', () => {
  assert.equal(quantile([1, 2, 3, 4, 5], 0.5), 3)
  assert.equal(quantile([0, 10], 0.25), 2.5)
  assert.ok(Number.isNaN(quantile([], 0.5)))
})

test('verdict: lower bound above 0 positive, upper below 0 negative, else zero', () => {
  assert.equal(verdictOf([0.1, 5]), 'positive')
  assert.equal(verdictOf([-5, -0.1]), 'negative')
  assert.equal(verdictOf([-5, 21]), 'zero')
  assert.equal(verdictOf([0, 0]), 'zero')
  assert.equal(verdictOf(null), 'insufficient')
})

test('child always passes, parent never: +100 points, interval [100, 100], positive', () => {
  const r = runs({ a: { parent: [false, false, false], child: [true, true, true] }, b: { parent: [false, false, false], child: [true, true, true] } })
  const d = pairedDiff(r, { treatment: 'child', control: 'parent', iterations: 500 })
  assert.equal(d.n, 2)
  assert.equal(d.mean, 100)
  assert.deepEqual(d.ci, [100, 100])
  assert.equal(d.verdict, 'positive')
})

test('identical arms give 0 with interval [0, 0]; reversed arms are negative', () => {
  const same = runs({ a: { base: [true, false, true], parent: [true, false, true] } })
  const d = pairedDiff(same, { treatment: 'parent', control: 'base', iterations: 500 })
  assert.equal(d.mean, 0)
  assert.equal(d.verdict, 'zero')
  const worse = runs({ a: { base: [true, true, true], parent: [false, false, false] } })
  assert.equal(pairedDiff(worse, { treatment: 'parent', control: 'base', iterations: 500 }).verdict, 'negative')
})

test('a known mixed sample: mean is the mean of per-case differences, and the interval straddles 0', () => {
  // case a: child 3/3 vs parent 1/3 → +66.67; case b: 1/3 vs 2/3 → −33.33; case c: 2/3 vs 2/3 → 0
  const r = runs({
    a: { parent: [true, false, false], child: [true, true, true] },
    b: { parent: [true, true, false], child: [false, false, true] },
    c: { parent: [true, false, true], child: [true, true, false] },
  })
  const d = pairedDiff(r, { treatment: 'child', control: 'parent', iterations: 2000 })
  assert.equal(Math.round(d.mean * 1000) / 1000, 11.111)
  assert.ok(d.ci[0] < 0 && d.ci[1] > 0, JSON.stringify(d.ci))
  assert.equal(d.verdict, 'zero')
  assert.deepEqual(d.cases.map(c => Math.round(c.diff * 100) / 100), [66.67, -33.33, 0])
})

test('same records and seed give the same interval; another seed may differ only within noise', () => {
  const r = runs({ a: { parent: [true, false, false], child: [true, true, false] }, b: { parent: [false, false, true], child: [true, true, true] } })
  const one = pairedDiff(r, { treatment: 'child', control: 'parent', iterations: 1000 })
  const two = pairedDiff(r, { treatment: 'child', control: 'parent', iterations: 1000 })
  assert.deepEqual(one, two)
})

test('unknown runs are left out of the rate; a case with no known run in an arm is missing', () => {
  const r = runs({
    a: { parent: [true, null, false], child: [true, true, null] },
    b: { parent: [true, true, true], child: [null, null, null] },
  })
  const d = pairedDiff(r, { treatment: 'child', control: 'parent', iterations: 200 })
  assert.equal(d.n, 1)
  assert.equal(d.mean, 50)
  assert.deepEqual(d.missing, [{ caseId: 'b', arm: 'child' }])
  assert.deepEqual(spread(r, 'a', 'parent'), { passes: 1, known: 2, unknown: 1, runIds: ['a-parent-0', 'a-parent-1', 'a-parent-2'] })
  const none = pairedDiff(runs({ x: { base: [true] } }), { treatment: 'child', control: 'base' })
  assert.equal(none.verdict, 'insufficient')
  assert.equal(none.mean, null)
})

test('family scope only uses that family', () => {
  const r = [...runs({ a: { base: [false], child: [true] } }, { family: 'tables' }), ...runs({ b: { base: [true], child: [false] } }, { family: 'code' })]
  assert.equal(pairedDiff(r, { treatment: 'child', control: 'base', family: 'tables', iterations: 100 }).mean, 100)
  assert.equal(pairedDiff(r, { treatment: 'child', control: 'base', family: 'code', iterations: 100 }).mean, -100)
  assert.equal(pairedDiff(r, { treatment: 'child', control: 'base', iterations: 100 }).mean, 0)
})

test('arm cost: mean over priced runs, unpriced counted', () => {
  const r = [
    { runId: '1', family: 'f', caseId: 'a', arm: 'base', repeat: 0, pass: true, costUsd: 0.1 },
    { runId: '2', family: 'f', caseId: 'a', arm: 'base', repeat: 1, pass: true, costUsd: 0.3 },
    { runId: '3', family: 'f', caseId: 'a', arm: 'base', repeat: 2, pass: true, costUsd: null },
  ]
  assert.deepEqual(armCost(r, 'base'), { runs: 3, priced: 2, unpriced: 1, totalUsd: 0.4, meanUsd: 0.2 })
  assert.equal(armCost(r, 'child').meanUsd, null)
})

test('amortization: break-even task count, dollars per point, or nothing', () => {
  assert.deepEqual(amortize({ investmentUsd: 3, baseCostPerTask: 0.2, treatedCostPerTask: 0.15, gainPoints: 0 }), { investmentUsd: 3, savingsPerTaskUsd: 0.05, tasksToBreakEven: 60, usdPerPoint: null })
  assert.deepEqual(amortize({ investmentUsd: 3, baseCostPerTask: 0.2, treatedCostPerTask: 0.25, gainPoints: 12 }), { investmentUsd: 3, savingsPerTaskUsd: -0.05, tasksToBreakEven: null, usdPerPoint: 0.25 })
  assert.deepEqual(amortize({ investmentUsd: 3, baseCostPerTask: null, treatedCostPerTask: 0.2, gainPoints: null }), { investmentUsd: 3, savingsPerTaskUsd: null, tasksToBreakEven: null, usdPerPoint: null })
})
