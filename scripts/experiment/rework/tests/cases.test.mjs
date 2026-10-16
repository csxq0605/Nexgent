import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  allCases, buildCase, checkPlan, FAMILIES, feedbackCases, guardPracticeCases, HOLDOUT_FAMILIES, holdoutIsolation, TRAIN_FAMILIES, trainingOrder,
} from '../cases.mjs'
import { checkFamily } from '../check-family.mjs'
import { practiceCaseOf } from '../common.mjs'
import { checkJudges } from '../judges.mjs'

const cases = allCases()

test('the plan: 4 training families × 8, 2 whole families held out × 10, 1 guard per training family; every rule holds', () => {
  assert.equal(FAMILIES.length, 6)
  assert.deepEqual(HOLDOUT_FAMILIES, ['file-batch', 'recompute'])
  assert.equal(TRAIN_FAMILIES.length, 4)
  assert.equal(cases.filter(c => c.split === 'train').length, 32)
  assert.equal(cases.filter(c => c.split === 'holdout').length, 20)
  assert.equal(cases.filter(c => c.split === 'guard').length, 4)
  assert.ok(cases.filter(c => c.split === 'holdout').every(c => HOLDOUT_FAMILIES.includes(c.family)))
  assert.deepEqual(checkPlan(cases), [])
})

test('no case is passed by one remembered convention: at most one convention point, at most a fifth of the score', () => {
  for (const task of cases) {
    const scored = task.rubric.filter(p => p.by === 'check')
    const conventions = scored.filter(p => p.type === 'convention')
    assert.ok(conventions.length <= 1, task.id)
    const share = conventions.reduce((s, p) => s + p.weight, 0) / scored.reduce((s, p) => s + p.weight, 0)
    assert.ok(share <= 0.2 + 1e-9, `${task.id}: ${share}`)
    assert.ok(task.traps.length >= 2, task.id)
  }
  assert.ok(cases.some(c => c.rubric.some(p => p.type === 'convention')))
  assert.ok(cases.some(c => !c.rubric.some(p => p.type === 'convention')))
})

test('the generators give the same case for the same seed', () => {
  const text = (/** @type {unknown} */ v) => JSON.stringify(v, (_, x) => (x instanceof Uint8Array ? Buffer.from(x).toString('base64') : x))
  for (const family of FAMILIES) {
    const a = family.build('determinism-check', { convention: true })
    const b = family.build('determinism-check', { convention: true })
    assert.equal(text(a), text(b), family.name)
  }
  assert.equal(text(buildCase('reconcile', 'train', 3).task), text(cases.find(c => c.id === 'reconcile/train/03')))
})

test('training order is round robin; half of each family gets feedback', () => {
  const order = trainingOrder()
  assert.equal(order.length, 32)
  assert.deepEqual(order.slice(0, 4).map(id => id.split('/')[0]), TRAIN_FAMILIES)
  const fb = feedbackCases()
  assert.equal(fb.length, 16)
  for (const name of TRAIN_FAMILIES) assert.equal(fb.filter(id => id.startsWith(`${name}/`)).length, 4)
})

test('every checker passes its good end state and fails the bad one made for it, on all 56 cases', async () => {
  const result = await checkJudges(cases)
  assert.deepEqual(result.results.filter(r => !r.ok), [])
  assert.ok(result.results.length > 300)
})

test('each family passes its own checks over fresh seeds', async () => {
  for (const family of FAMILIES) assert.deepEqual(await checkFamily(family, 3), [], family.name)
})

test('the guard set is in the C1 practice-case form', async () => {
  const guard = guardPracticeCases()
  assert.equal(guard.length, 4)
  for (const pc of guard) {
    assert.equal(pc.source, 'generic')
    assert.equal(pc.split, 'guard')
    assert.match(pc.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    assert.ok(pc.similarityKey.length <= 16)
    assert.ok(pc.rubric.items.every(item => item.text.length <= 300))
  }
  const session = await import(new URL('../../../../packages/session/dist/index.js', import.meta.url).href).catch(() => null)
  if (session === null) return
  for (const task of cases) assert.deepEqual(session.validateLearningFile('practiceCase', practiceCaseOf(task)), [], task.id)
})

test('holdout isolation finds a planted fingerprint and nothing in a clean tree', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nx-rework-iso-'))
  try {
    await mkdir(join(dir, 'clean'), { recursive: true })
    const train = cases.find(c => c.split === 'train')
    await writeFile(join(dir, 'clean', 'a.txt'), train?.message ?? '')
    assert.equal((await holdoutIsolation([join(dir, 'clean')])).leaks.length, 0)
    const held = cases.find(c => c.split === 'holdout')
    await mkdir(join(dir, 'dirty'), { recursive: true })
    await writeFile(join(dir, 'dirty', 'b.txt'), `x ${held?.fingerprints[0]} y`)
    const found = await holdoutIsolation([join(dir, 'dirty')])
    assert.equal(found.leaks.length, 1)
    assert.equal(found.leaks[0].caseId, held?.id)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
