import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canStart, gate, readSpend, recordSpend, STEP6_CAP_USD } from '../budget.mjs'

test('the step-6 cap is 35 USD', () => {
  assert.equal(STEP6_CAP_USD, 35)
})

test('a run starts only while spent + estimate stays within the cap', () => {
  const spend = { capUsd: 35, entries: [{ label: 'a', usd: 30 }] }
  assert.equal(canStart(spend, 5).ok, true)
  const over = canStart(spend, 5.01)
  assert.equal(over.ok, false)
  assert.match(over.reason, /35 USD cap/)
  assert.equal(canStart(spend, Number.NaN).ok, false)
  assert.equal(canStart(spend, -1).ok, false)
})

test('spend accumulates on disk across calls; an unreadable file blocks every run', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nx6-b-'))
  try {
    const file = join(dir, 'nested', 'spend.json')
    assert.deepEqual(await readSpend(file), { capUsd: 35, entries: [] })
    await recordSpend(file, { label: 'history tables', usd: 20 })
    await recordSpend(file, { label: 'improvement tables', usd: 14 })
    assert.equal((await gate(file, 1)).ok, true)
    assert.equal((await gate(file, 1.5)).ok, false)
    assert.equal((await gate(file, 0.5, 30)).ok, false)
    await assert.rejects(recordSpend(file, { label: 'bad', usd: Number.POSITIVE_INFINITY }))
    await writeFile(file, '{ not json')
    const blocked = await gate(file, 0.01)
    assert.equal(blocked.ok, false)
    assert.match(blocked.reason, /spend unknown/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
