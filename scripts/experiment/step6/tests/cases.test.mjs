import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { allCases, checkGatePicks, checkIsolation, checkSets, familyCases, PLAN, SET_SIZES } from '../cases.mjs'

test('both families split into dev 2 / selection 2 / guard 1 / holdout 3 with no overlap', () => {
  const cases = allCases()
  assert.equal(cases.length, 16)
  assert.deepEqual(checkSets(cases), [])
  for (const family of ['tables', 'code']) {
    for (const [set, n] of Object.entries(SET_SIZES)) assert.equal(familyCases(family).filter(c => c.set === set).length, n)
  }
})

test('every holdout set has a variant dev never had', () => {
  for (const family of ['tables', 'code']) {
    const dev = new Set(PLAN[family].filter(e => e.set === 'dev').map(e => e.variant))
    assert.ok(PLAN[family].some(e => e.set === 'holdout' && !dev.has(e.variant)), family)
  }
})

test('generating twice gives identical cases', () => {
  assert.deepEqual(JSON.stringify(allCases()), JSON.stringify(allCases()))
})

test('checkSets reports a reused seed, a wrong set size and a shared fingerprint', () => {
  const cases = familyCases('tables')
  const copy = cases.map(c => ({ ...c }))
  copy[5] = { ...copy[5], set: 'dev', seed: copy[0].seed, fingerprints: [...copy[5].fingerprints, copy[0].message] }
  const problems = checkSets(copy)
  assert.ok(problems.some(p => p.includes('seed 2026-09')), problems.join('\n'))
  assert.ok(problems.some(p => p.includes('dev has 3')), problems.join('\n'))
  assert.ok(problems.some(p => p.includes('share')), problems.join('\n'))
})

test('the gate may pick history cases but never holdout ones', () => {
  const cases = allCases()
  const history = cases.filter(c => c.set !== 'holdout').map(c => c.id)
  const holdout = cases.find(c => c.set === 'holdout').id
  assert.deepEqual(checkGatePicks(history, cases), [])
  assert.deepEqual(checkGatePicks([history[0], holdout], cases), [`gate picked holdout case ${holdout}`])
  assert.deepEqual(checkGatePicks(['nope'], cases), ['gate picked nope, which is not a planned case'])
})

test('isolation: history content is fine, a holdout message in a session or its CSV in a snapshot is a leak', async () => {
  const cases = allCases()
  const root = await mkdtemp(join(tmpdir(), 'nx6-i-'))
  try {
    const dev = cases.find(c => c.set === 'dev' && c.family === 'tables')
    await mkdir(join(root, 'sessions', 's1'), { recursive: true })
    await writeFile(join(root, 'sessions', 's1', 'session.jsonl'), `${JSON.stringify({ type: 'user', text: dev.message })}\n`)
    await writeFile(join(root, 'blob.bin'), Buffer.from([0, 1, 2, 3]))
    let result = await checkIsolation(cases, [root])
    assert.deepEqual(result.leaks, [])
    assert.equal(result.scanned, 1)
    assert.equal(result.skipped.length, 1)

    const code = cases.find(c => c.set === 'holdout' && c.family === 'code')
    await writeFile(join(root, 'sessions', 's1', 'session.jsonl'), `${JSON.stringify({ type: 'user', text: `请做：\n${code.message}` })}\n`)
    const table = cases.find(c => c.set === 'holdout' && c.family === 'tables')
    await mkdir(join(root, 'snapshots', 'v2'), { recursive: true })
    await writeFile(join(root, 'snapshots', 'v2', 'orders.csv'), table.materials[0].content)
    result = await checkIsolation(cases, [root])
    assert.ok(result.leaks.some(l => l.caseId === code.id && l.file.includes('session.jsonl')), JSON.stringify(result.leaks))
    assert.ok(result.leaks.some(l => l.caseId === table.id && l.file.includes('orders.csv')), JSON.stringify(result.leaks))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a JSON-escaped multi-line holdout fingerprint is still found', async () => {
  const cases = allCases()
  const task = { ...cases.find(c => c.set === 'holdout'), fingerprints: ['line one\nline "two"'] }
  const root = await mkdtemp(join(tmpdir(), 'nx6-i-'))
  try {
    await writeFile(join(root, 'r.jsonl'), `${JSON.stringify({ note: 'x line one\nline "two" y' })}\n`)
    const { leaks } = await checkIsolation([task], [root])
    assert.equal(leaks.length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
