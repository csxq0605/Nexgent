import { test } from 'node:test'
import assert from 'node:assert/strict'
import { counts, feedbackFor, TEMPLATES } from '../feedback.mjs'
import { judgeTableText, referenceTable } from '../tables.mjs'

const fail = (...issues) => ({ pass: false, issues: issues.map(([kind, detail]) => ({ kind, detail })), problems: [] })

test('a failed case gets three counted entries, all worded differently, about the main problem', () => {
  const result = judgeTableText('region', '2026-09', referenceTable('region', '2026-09', { withConvention: false }))
  const { primary, entries } = feedbackFor(result)
  assert.equal(primary, 'convention-column')
  assert.equal(entries.length, 3)
  assert.ok(entries.every(counts))
  assert.equal(new Set(entries.map(e => e.comment)).size, 3)
  assert.deepEqual(entries.map(e => e.rating), [2, undefined, 3])
  assert.ok(entries[0].comment.includes('avg_order_value'))
})

test('the same judge result gives the same feedback', () => {
  const result = fail(['convention-tests', 'discount'])
  assert.deepEqual(feedbackFor(result), feedbackFor(result))
})

test('the task problem comes before a convention; other problems ride along in the first entry', () => {
  const { primary, entries } = feedbackFor(fail(['convention-tests', 'tax'], ['hidden-test', 'invoice 2 (east)']))
  assert.equal(primary, 'hidden-test')
  assert.ok(entries[0].comment.includes('invoice 2 (east)'))
  assert.ok(entries[0].comment.includes('另外'))
  assert.ok(entries[0].comment.includes('tax'))
  assert.ok(!entries[1].comment.includes('另外'))
})

test('amounts not in cents are named before the invoice tests they break', () => {
  assert.equal(feedbackFor(fail(['hidden-test', 'invoice 1'], ['convention-cents', '[cents] x'])).primary, 'convention-cents')
})

test('a passed case gets one praise that does not count; an unknown result gets none', () => {
  const praise = feedbackFor({ pass: true, issues: [], problems: [] })
  assert.equal(praise.entries.length, 1)
  assert.equal(counts(praise.entries[0]), false)
  assert.deepEqual(feedbackFor({ pass: null, issues: [], problems: [] }).entries, [])
})

test('no template mentions capability tools, skills or components', () => {
  const all = Object.values(TEMPLATES).flat().join('\n')
  assert.doesNotMatch(all, /技能|能力|工具|组件|插件|skill|tool|capabilit|component|plugin/i)
})

test('an unknown problem kind still gets three entries', () => {
  const { entries } = feedbackFor(fail(['something-new', 'x']))
  assert.equal(entries.length, 3)
  assert.ok(entries.every(e => e.comment.includes('x')))
})
