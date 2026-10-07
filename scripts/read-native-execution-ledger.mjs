import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'

const buckets = ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']
const count = value => Number.isSafeInteger(value) && value >= 0
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const nonempty = value => typeof value === 'string' && value.length > 0

/** Validate persisted observations before a delivery probe reports their accounting. */
export function summarizeNativeExecutionLedger(text) {
  assert.ok(text.endsWith('\n'), 'Ledger has an incomplete final line')
  const rows = text.trimEnd().split('\n').map(line => JSON.parse(line))
  const requests = new Map()
  let close
  for (const row of rows) {
    assert.ok(object(row) && row.format === 1, 'Invalid ledger record')
    assert.equal(close, undefined, 'Record after ledger shutdown')
    if (row.type === 'ledger-close') {
      assert.ok(count(row.writeFailures), 'Invalid ledger failure count')
      assert.deepEqual(Object.keys(row).sort(), ['format', 'type', 'writeFailures'])
      close = row
      continue
    }
    assert.ok(nonempty(row.id), 'Missing request identity')
    if (row.type === 'request-start') {
      assert.ok(nonempty(row.provider) && nonempty(row.model) && count(row.startedAt), 'Invalid request start')
      assert.ok(row.sessionId === undefined || nonempty(row.sessionId), 'Invalid session identity')
      assert.ok(row.purpose === undefined || ['compaction', 'session-title'].includes(row.purpose), 'Invalid request purpose')
      assert.ok(Object.keys(row).every(key => ['format', 'type', 'id', 'provider', 'model', 'startedAt', 'sessionId', 'purpose'].includes(key)), 'Unexpected request start field')
      assert.ok(!requests.has(row.id), 'Duplicate request start')
      requests.set(row.id, { start: row })
    } else {
      assert.equal(row.type, 'request-end', 'Unknown ledger record')
      const request = requests.get(row.id)
      assert.ok(request && !request.end, 'Unmatched or duplicate request settlement')
      assert.ok(count(row.endedAt) && Number.isFinite(row.durationMs) && row.durationMs >= 0, 'Invalid settlement time')
      assert.ok(['exhausted', 'threw', 'consumer-closed'].includes(row.termination), 'Invalid termination')
      assert.ok(row.finishReason === undefined || nonempty(row.finishReason), 'Invalid finish reason')
      assert.ok(['reported', 'missing', 'invalid'].includes(row.usageState), 'Invalid usage status')
      assert.ok(Object.keys(row).every(key => ['format', 'type', 'id', 'endedAt', 'durationMs', 'termination', 'finishReason', 'usageState', 'usage'].includes(key)), 'Unexpected request end field')
      if (row.usageState === 'reported') {
        assert.ok(object(row.usage) && count(row.usage.inputTokens) && count(row.usage.outputTokens), 'Invalid reported usage')
        assert.ok(Object.keys(row.usage).every(key => buckets.includes(key) && count(row.usage[key])), 'Invalid usage bucket')
      } else assert.equal(row.usage, undefined, 'Unreported usage must not contain fabricated counts')
      request.end = row
    }
  }
  const groups = new Map()
  const totals = Object.fromEntries(buckets.map(bucket => [bucket, { reported: 0, missingReports: 0 }]))
  const coverage = { reported: 0, missing: 0, invalid: 0 }
  const outcomes = Object.create(null)
  let openRequests = 0
  for (const { start, end } of requests.values()) {
    const identity = { provider: start.provider, model: start.model, sessionId: start.sessionId ?? null, purpose: start.purpose ?? 'conversation' }
    const key = JSON.stringify(identity)
    const group = groups.get(key) ?? { ...identity, requests: 0, settled: 0 }
    group.requests++
    if (end) {
      group.settled++
      coverage[end.usageState]++
      const outcome = end.termination === 'exhausted' ? end.finishReason ?? 'missing-finish' : end.termination
      outcomes[outcome] = (outcomes[outcome] ?? 0) + 1
    } else openRequests++
    groups.set(key, group)
    for (const bucket of buckets) {
      const value = end?.usage?.[bucket]
      if (value === undefined) totals[bucket].missingReports++
      else {
        totals[bucket].reported += value
        assert.ok(count(totals[bucket].reported), 'Usage total overflow')
      }
    }
  }
  const observationsComplete = close !== undefined && close.writeFailures === 0 && openRequests === 0
  return { scope: 'native stream observations; no invoice, transport retry, evaluation, adoption or RSI claim',
    observedRequests: requests.size, settledRequests: requests.size - openRequests, openRequests,
    closed: close !== undefined, writeFailures: close?.writeFailures ?? null, observationsComplete,
    inputOutputUsageComplete: observationsComplete && coverage.reported === requests.size,
    coverage, outcomes, reportedTokens: totals, groups: [...groups.values()] }
}

/** Read every composition's file in one application's own ledger directory. */
export async function readNativeExecutionLedgers(directory) {
  const files = (await readdir(directory)).filter(file => file.endsWith('.jsonl')).sort()
  assert.ok(files.length > 0, 'Native execution ledger was not composed into the application')
  return Promise.all(files.map(async file => ({ file, ...summarizeNativeExecutionLedger(await readFile(resolve(directory, file), 'utf8')) })))
}
