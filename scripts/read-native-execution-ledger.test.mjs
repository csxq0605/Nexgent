import test from 'node:test'
import assert from 'node:assert/strict'
import { summarizeNativeExecutionLedger } from './read-native-execution-ledger.mjs'

const start = (id = 'request', extra = {}) => ({ format: 1, type: 'request-start', id, provider: 'mimo', model: 'mimo-v2.6-pro', startedAt: 1, ...extra })
const end = (id = 'request', extra = {}) => ({ format: 1, type: 'request-end', id, endedAt: 2, durationMs: 1, termination: 'exhausted', finishReason: 'stop', usageState: 'reported', usage: { inputTokens: 10, outputTokens: 3, reasoningTokens: 2 }, ...extra })
const close = { format: 1, type: 'ledger-close', writeFailures: 0 }
const text = rows => rows.map(JSON.stringify).join('\n') + '\n'

test('keeps auxiliary and member requests, preserves unavailable buckets and does not double-add reasoning', () => {
  const receipt = summarizeNativeExecutionLedger(text([start('main', { sessionId: 'parent' }), start('title', { purpose: 'session-title' }), end('title'), end('main'), close]))
  assert.equal(receipt.observedRequests, 2)
  assert.equal(receipt.inputOutputUsageComplete, true)
  assert.deepEqual(receipt.reportedTokens.outputTokens, { reported: 6, missingReports: 0 })
  assert.deepEqual(receipt.reportedTokens.totalTokens, { reported: 0, missingReports: 2 })
  assert.equal(receipt.groups[1].purpose, 'session-title')
  assert.equal(receipt.groups[1].sessionId, null)
})

test('retains an unfinished invocation even when shutdown has been recorded', () => {
  const receipt = summarizeNativeExecutionLedger(text([start(), close]))
  assert.equal(receipt.observationsComplete, false)
  assert.equal(receipt.openRequests, 1)
  assert.equal(receipt.inputOutputUsageComplete, false)
})

test('does not accept an unclosed file or a storage failure as complete accounting', () => {
  for (const rows of [[start(), end()], [start(), end(), { ...close, writeFailures: 1 }]]) {
    const receipt = summarizeNativeExecutionLedger(text(rows))
    assert.equal(receipt.observationsComplete, false)
    assert.equal(receipt.inputOutputUsageComplete, false)
  }
})

test('preserves failure outcomes and missing usage without pretending they are free', () => {
  const receipt = summarizeNativeExecutionLedger(text([start(), end('request', { usageState: 'missing', usage: undefined, finishReason: 'error' }), close]))
  assert.equal(receipt.inputOutputUsageComplete, false)
  assert.equal(receipt.coverage.missing, 1)
  assert.equal(receipt.outcomes.error, 1)
  assert.equal(receipt.reportedTokens.inputTokens.missingReports, 1)
})

test('rejects a torn line, duplicate or orphan settlement and appended records after shutdown', () => {
  for (const input of [text([start(), end(), close]).slice(0, -1), text([start(), start()]), text([end()]), text([start(), end(), end()]), text([close, start()])]) {
    assert.throws(() => summarizeNativeExecutionLedger(input))
  }
})

test('rejects fabricated or malformed usage, unknown fields and unsupported file formats', () => {
  for (const row of [end('request', { usageState: 'missing' }), end('request', { usage: { inputTokens: -1, outputTokens: 1 } }), end('request', { usage: { inputTokens: 1, outputTokens: 1, secret: 1 } }), end('request', { secret: 'x' }), { ...end(), format: 2 }]) {
    assert.throws(() => summarizeNativeExecutionLedger(text([start(), row, close])))
  }
})

test('refuses overflow instead of silently rounding token totals', () => {
  assert.throws(() => summarizeNativeExecutionLedger(text([start('a'), end('a', { usage: { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0 } }), start('b'), end('b'), close])), /overflow/)
})
