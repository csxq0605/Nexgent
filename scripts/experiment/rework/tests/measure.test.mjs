import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ARMS, armSupport, firstMessage, FORMAT_TEXT, HANDBOOK_HEADER, NOTES_HEADER, NOTES_MAX_BYTES, notesText } from '../arms.mjs'
import { allCases, badOf, goodOf, judgeCase } from '../cases.mjs'
import { applyAnswer, writeFiles } from '../common.mjs'
import { caseFeedback, counts } from '../feedback.mjs'
import { buildPlan, planText, PLAN_FILE, PROFILES } from '../plan.mjs'
import { buildReport } from '../report.mjs'
import { deliveredFiles, reviewRequest, reviewRun, scriptedComplete } from '../reviewer.mjs'
import { comparisons, criteria, FAILURE_SCORE, pairedDiff, selfEvalAgreement, SUCCESS_SCORE } from '../stats.mjs'
import { readFile } from 'node:fs/promises'

const cases = allCases()
const task = /** @type {import('../common.mjs').ReworkCase} */ (cases.find(c => c.split === 'train' && c.rubric.some(p => p.type === 'taste')))

/** Judge an answer in a fresh directory. @param {import('../common.mjs').ReworkCase} t @param {import('../common.mjs').Answer} answer */
async function judged(t, answer) {
  const dir = await mkdtemp(join(tmpdir(), 'nx-rework-t-'))
  try {
    await writeFiles(dir, t.files)
    await applyAnswer(dir, answer)
    return { result: await judgeCase(t, dir), delivered: await deliveredFiles(t, dir) }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('feedback: a failed case gives three counted entries with the one-off preference; a passed case one praise', async () => {
  const bad = badOf(task)[0]
  const { result } = await judged(task, bad.answer)
  const fb = caseFeedback(task, result)
  assert.equal(fb.entries.filter(counts).length, 3)
  const taste = task.rubric.find(p => p.type === 'taste')
  assert.ok(fb.entries[0].comment.includes(String(taste?.feedback)))
  const ok = caseFeedback(task, (await judged(task, goodOf(task))).result)
  assert.equal(ok.entries.length, 1)
  assert.equal(counts(ok.entries[0]), false)
  const notes = notesText([{ at: '0001', comment: 'b' }, { at: '0000', comment: 'a\nc' }])
  assert.equal(notes.text, `${NOTES_HEADER}\n- a c\n- b`)
  assert.equal(notesText([]).text, '')
  const long = notesText(Array.from({ length: 40 }, (_, i) => ({ at: String(i).padStart(4, '0'), comment: `${i} ${'x'.repeat(600)}` })))
  assert.ok(Buffer.byteLength(long.text) <= NOTES_MAX_BYTES && long.dropped > 0 && long.text.includes('- 39 '))
})

test('reviewer: the request shows task, inputs, delivered files and every checked point; replies parse', async () => {
  const { delivered } = await judged(task, goodOf(task))
  assert.ok(delivered.length > 0)
  assert.ok(delivered.every(([path]) => !path.startsWith(task.folder)))
  const request = reviewRequest(task, delivered)
  assert.equal(request.model, 'claude-opus-5-5')
  for (const point of task.rubric.filter(p => p.by === 'check')) assert.ok(request.user.includes(`- ${point.id}：`))
  assert.ok(!request.user.includes('- t：'))
  const reply = await reviewRun(scriptedComplete(() => JSON.stringify({ points: [{ id: 'r1', verdict: '否', reason: 'x' }, { id: 'zz', verdict: '是', reason: 'y' }] })), task, delivered)
  assert.deepEqual(reply.verdicts, { r1: { verdict: 'no', reason: 'x' } })
  assert.equal((await reviewRun(scriptedComplete(() => 'not json'), task, delivered)).verdicts, null)
})

/** Synthetic holdout runs: `gain` points per arm on every case. */
function runsWith(/** @type {Record<string, number>} */ gain, repeats = 3) {
  const runs = []
  for (let c = 0; c < 10; c += 1) {
    for (const [arm, g] of Object.entries(gain)) {
      for (let r = 1; r <= repeats; r += 1) {
        const score = Math.min(1, 0.5 + g + ((c * 7 + r * 3) % 5) / 100)
        runs.push({ runId: `${arm}#c${c}#${r}`, family: c < 5 ? 'f1' : 'f2', caseId: `c${c}`, arm, repeat: r, score, pass: score === 1, points: [{ id: 'r1', type: 'wrong-result', weight: 3, pass: score > 0.6 }, { id: 'r2', type: 'unverified', weight: 2, pass: score > 0.7 }] })
      }
    }
  }
  return runs
}

test('statistics: paired difference with a seeded two-level bootstrap; criteria met, not met, not run', () => {
  const runs = runsWith({ base: 0, notes: 0.05, L1: 0.15, 'L1+L2': 0.25 })
  const d = pairedDiff(runs, { treatment: 'L1', control: 'notes', iterations: 2000 })
  assert.equal(d.n, 10)
  assert.ok(Math.abs(/** @type {number} */ (d.mean) - 10) < 1e-6)
  assert.equal(d.verdict, 'positive')
  assert.deepEqual(pairedDiff(runs, { treatment: 'L1', control: 'notes', iterations: 2000 }).ci, d.ci)
  const compared = comparisons(runs, { iterations: 2000 })
  const c = criteria(compared, { literalRate: 0, costOptimized: 0 })
  assert.equal(c[1], 'met')
  assert.equal(c[2], 'met')
  assert.equal(c[3], 'not-run')
  assert.equal(c[4], 'met')
  const flat = criteria(comparisons(runsWith({ notes: 0.1, L1: 0.1, 'L1+L2': 0.1 }), { iterations: 2000 }), { literalRate: 0.5, costOptimized: null })
  assert.equal(flat[1], 'not-met')
  assert.equal(flat[4], 'not-met')
  const worse = criteria(comparisons(runsWith({ base: 0.2, notes: 0 }), { iterations: 2000 }), { literalRate: null, costOptimized: null })
  assert.ok(worse[5].some(w => w.comparison === 'notes-base' && w.family === 'f1'))
  // Stand-in runs never enter a comparison.
  assert.equal(pairedDiff(runsWith({ notes: 0, L1: 0.2 }).map(r => ({ ...r, standIn: r.arm === 'L1' })), { treatment: 'L1', control: 'notes' }).verdict, 'insufficient')
})

test('report: the same records give the same bytes', () => {
  const runs = runsWith({ base: 0, notes: 0.05 })
  const compared = comparisons(runs, { iterations: 500 })
  const records = {
    experiment: 'rework', profile: 'smoke', backend: 'scripted', model: 'scripted', planSha256: 'x', stopped: null, error: null,
    judges: { pass: true, samples: 3, failed: [] }, stream: null, notes: null, isolation: { leaks: [], scanned: 1, skipped: 0 },
    arms: { base: { status: 'ran', reason: null, standIn: false }, notes: { status: 'ran', reason: null, standIn: false }, L1: { status: 'unavailable', reason: '需要 V1', standIn: false } },
    runs, reviews: [], agreement: { items: 0, known: 0, agree: 0, rate: null },
    selfEval: selfEvalAgreement([{ caseId: 'a', judgeScore: 1, selfOutcome: 'success' }]),
    learned: { notes: { items: 0, withLiterals: 0, rate: null, hits: [] }, learningArms: null, costOptimized: null },
    comparisons: compared, criteria: criteria(compared, { literalRate: null, costOptimized: null }), runNotes: [],
  }
  const a = buildReport(records)
  assert.equal(a, buildReport(JSON.parse(JSON.stringify(records))))
  assert.ok(a.includes('notes − base'))
  assert.ok(a.includes('需要 V1'))
})

test('arms: L1 runs once the handbook and the learner are built; later layers say what they need', () => {
  const none = armSupport({})
  assert.deepEqual(ARMS.filter(a => none[a].available), ['base', 'format', 'notes'])
  const support = armSupport({ capabilities: { Handbook: class {} }, evolve: { LearningHost: class {} } })
  assert.deepEqual(ARMS.filter(a => support[a].available), ['base', 'format', 'notes', 'L1'])
  for (const arm of ['L1+L2', 'L1+L2+L3']) assert.match(String(support[/** @type {import('../arms.mjs').Arm} */ (arm)].reason), /需要/)
})

test('arms: format and notes stand where the handbook stands, with its wording', async () => {
  assert.equal(firstMessage('', 'task'), 'task')
  assert.equal(firstMessage('notes', 'task'), 'notes\n\ntask')
  assert.ok(FORMAT_TEXT.startsWith(HANDBOOK_HEADER))
  const capabilities = await import(new URL('../../../../packages/capabilities/dist/index.js', import.meta.url).href).catch(() => null)
  if (capabilities !== null) assert.equal(HANDBOOK_HEADER, capabilities.HANDBOOK_INJECT_HEADER)
  const kernel = await import(new URL('../../../../packages/kernel/dist/index.js', import.meta.url).href).catch(() => null)
  if (kernel !== null) assert.deepEqual([SUCCESS_SCORE, FAILURE_SCORE], [kernel.SUCCESS_SCORE, kernel.FAILURE_SCORE])
})

test('self-evaluation agreement: success or not, by the C1 bands; unknown left out', () => {
  const a = selfEvalAgreement([
    { caseId: 'a', judgeScore: 1, selfOutcome: 'success' },
    { caseId: 'b', judgeScore: 0.6, selfOutcome: 'success' },
    { caseId: 'c', judgeScore: 0.6, selfOutcome: 'failure' },
    { caseId: 'd', judgeScore: 0.3, selfOutcome: 'failure' },
    { caseId: 'e', judgeScore: null, selfOutcome: 'success' },
    { caseId: 'f', judgeScore: 1, selfOutcome: 'unknown' },
  ])
  assert.equal(a.items, 6)
  assert.equal(a.known, 4)
  assert.equal(a.agree, 3)
  assert.equal(a.rate, 0.75)
  assert.equal(a.sameBand, 2)
  assert.equal(a.met, false)
  assert.deepEqual(a.selfTooKind, ['b'])
  assert.deepEqual(a.confusion, { 'failure/failure': 1, 'failure/mixed': 1, 'success/mixed': 1, 'success/success': 1 })
})

test('plan: the committed file is current; profiles match the partition', async () => {
  assert.equal((await readFile(PLAN_FILE, 'utf8')).replace(/\r\n/g, '\n'), await planText())
  const plan = await buildPlan()
  assert.equal(plan.cases.length, 56)
  assert.equal(PROFILES.smoke.holdout.length, 6)
  assert.deepEqual(PROFILES.smoke.arms, ['base', 'notes', 'L1'])
  assert.equal(PROFILES.smoke.repeats, 2)
  assert.equal(PROFILES.m3.holdout.length, 20)
  assert.deepEqual(PROFILES.m3.arms, ['base', 'format', 'notes', 'L1', 'L1+L2'])
  assert.equal(PROFILES.m3.repeats, 3)
  assert.equal(PROFILES.smoke.gateUsd, 9)
  assert.equal(PROFILES.m3.gateUsd, 90)
})
