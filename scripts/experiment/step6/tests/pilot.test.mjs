import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { checkIsolation } from '../cases.mjs'
import { checkPilotPlan, judgePilotCase, pilotCases, pilotReferencePairs, tasteMet } from '../pilot/cases.mjs'
import { amountForms, applyAnswer, citesAll, dateForms, hasAny, normalize, parseCsv, withReview, writeFiles } from '../pilot/common.mjs'
import { pilotFeedback } from '../pilot/feedback.mjs'
import { MEMORY_POLICY, memoryInstructions } from '../pilot/memory.mjs'
import { crc32, readDocx, readXlsx, unzip, writeDocx, writeXlsx } from '../pilot/office.mjs'
import { buildPlan, PILOT_ID, PLAN_FILE, planSha256, ROUND_1_PLAN_FILE, ROUND_1_PLAN_SHA256 } from '../pilot/plan.mjs'

const ROUND_2_PLAN_SHA256 = 'fa5a9ae12668840b41bceac85934e5ed48d23f550fcbefa44dd1d1b3508a7e7a'
import { checkJudges, orderConsistency, pairAccuracy, reliabilityVerdict } from '../pilot/reliability.mjs'
import { comparePair, orderOutcome, pairRequest, parsePairReply, parsePointVerdicts, parsePreference, pointRequest, reviewPoints, scriptedComplete } from '../pilot/reviewer.mjs'
import { agreementRate, componentClass, followUpsByArm, literalRate, pairedRateDiff, repeatSpread, wholePass } from '../pilot/stats.mjs'

const cases = pilotCases()
const byId = (/** @type {string} */ id) => /** @type {import('../pilot/common.mjs').PilotCase} */ (cases.find(c => c.id === id))

test('the plan: 16 cases, 8 per family split 2/2/1/3, rubrics within the rules, sets disjoint', () => {
  assert.equal(cases.length, 16)
  assert.deepEqual(checkPilotPlan(cases), [])
  for (const family of ['docs', 'files']) {
    const mine = cases.filter(c => c.family === family)
    assert.deepEqual(['dev', 'selection', 'guard', 'holdout'].map(set => mine.filter(c => c.set === set).length), [2, 2, 1, 3])
    for (const task of mine) {
      assert.ok(task.rubric.filter(p => p.type === 'convention').length === 1, `${task.id} has its family convention`)
      assert.ok(task.rubric.some(p => p.type === 'taste'), `${task.id} has a taste point`)
    }
  }
  assert.ok(cases.filter(c => c.family === 'files').every(c => c.rubric.every(p => p.by !== 'review')), 'file tasks are judged deterministically')
})

test('generators are deterministic; round 1\'s frozen plan is untouched; this round\'s plan file, once frozen, is a fresh build', async () => {
  const again = pilotCases()
  for (const [i, task] of cases.entries()) {
    assert.equal(again[i].message, task.message)
    for (const [path, content] of Object.entries(task.files)) assert.ok(Buffer.from(again[i].files[path]).equals(Buffer.from(content)), `${task.id} ${path}`)
  }
  assert.equal(await planSha256(ROUND_1_PLAN_FILE), ROUND_1_PLAN_SHA256, 'round 1 (step6-pilot-1) ran on this plan; it is a record and never changes')
  assert.notEqual(PLAN_FILE, ROUND_1_PLAN_FILE)
  // Round 2 (step6-pilot-2) ran on its frozen plan too (handoff step6-closeout-measure.md); the file is a
  // record now, so later runner changes (K1 moved the project data) no longer have to match a fresh build.
  assert.equal(await planSha256(PLAN_FILE), ROUND_2_PLAN_SHA256, 'round 2 (step6-pilot-2) ran on this plan; it is a record and never changes')
  const plan = await buildPlan()
  assert.equal(plan.pilotId, PILOT_ID)
  assert.notEqual(PILOT_ID, 'step6-pilot-1')
  assert.equal(plan.reliability.pairs.length, 6)
  assert.equal(plan.statistics.bootstrap.iterations, 2000)
  assert.equal(plan.statistics.bootstrap.seed, 'step6-pilot')
  assert.deepEqual(plan.statistics.comparisons, [['parent', 'base'], ['memory', 'base'], ['parent', 'memory']])
  assert.equal(plan.reviewer.external.model, 'claude-opus-5-5')
})

test('criterion 1: every checker passes its good end state and fails the bad one made for it', async () => {
  const result = await checkJudges(cases)
  assert.deepEqual(result.results.filter(r => !r.ok), [])
  assert.deepEqual(result.uncovered, [])
  assert.equal(result.pass, true)
})

test('an untouched project fails every checked point; the taste detector reads the deliverable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nx6-p-'))
  try {
    const task = byId('files/selection/xlsx-to-csv-f-103')
    await writeFiles(dir, task.files)
    const judged = await judgePilotCase(task, dir)
    assert.equal(judged.pass, false)
    assert.ok(judged.points.every(p => p.pass === false))
    assert.equal(await tasteMet(task, dir), false)
    await applyAnswer(dir, { write: { 'f-103/output/a.csv': '﻿订单号,客户,金额,日期\n' }, remove: [] })
    assert.equal(await tasteMet(task, dir), true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('holdout isolation: a holdout fingerprint in a project file is found', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nx6-p-'))
  try {
    const holdout = cases.filter(c => c.set === 'holdout')
    assert.ok(holdout.every(c => c.fingerprints.length > 0))
    await writeFile(join(dir, 'session.jsonl'), JSON.stringify({ text: holdout[0].fingerprints[0] }))
    const clean = await checkIsolation(/** @type {any} */ (cases.filter(c => c.set !== 'holdout')), [dir])
    assert.equal(clean.leaks.length, 0)
    const found = await checkIsolation(/** @type {any} */ (cases), [dir])
    assert.equal(found.leaks[0].caseId, holdout[0].id)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('office files: xlsx and docx round-trip; a deflated zip entry reads', () => {
  const book = readXlsx(writeXlsx([{ name: '表 1', rows: [['a', 'b'], [1, 'x&y'], [null, 2.5]] }, { name: 'S2', rows: [['z']] }]))
  assert.deepEqual(book.map(s => s.name), ['表 1', 'S2'])
  assert.deepEqual(book[0].rows, [['a', 'b'], [1, 'x&y'], [null, 2.5]])
  assert.deepEqual(book[0].types[1], ['n', 's'])
  const blocks = /** @type {import('../pilot/office.mjs').Block[]} */ ([{ kind: 'heading', level: 2, text: '标题' }, { kind: 'paragraph', text: '正文 <1>' }, { kind: 'table', rows: [['h1', 'h2'], ['1', '2']] }])
  assert.deepEqual(readDocx(writeDocx(blocks)), blocks)
  const data = Buffer.from('hello hello hello')
  const packed = deflateRawSync(data)
  const name = Buffer.from('a.txt')
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034B50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(crc32(data), 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26)
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014B50, 0); central.writeUInt16LE(8, 10); central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28)
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054B50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(46 + name.length, 12); end.writeUInt32LE(30 + name.length + packed.length, 16)
  const zipped = Buffer.concat([local, name, packed, central, name, end])
  assert.equal(Buffer.from(/** @type {Uint8Array} */ (unzip(zipped).get('a.txt'))).toString(), 'hello hello hello')
})

test('text matching: dates, amounts, citations, csv', () => {
  assert.ok(hasAny(normalize('截止 10月5日'), dateForms('2026-10-05')))
  assert.ok(hasAny(normalize('预算 380,000 元'), amountForms(380000)))
  assert.ok(hasAny(normalize('共 38 万元'), amountForms(380000)))
  assert.ok(!hasAny(normalize('预算 1380000 元'), amountForms(380000)))
  assert.deepEqual(citesAll('正文 a.txt\n\n## 引用资料\n- b.txt', ['a.txt', 'b.txt']), ['a.txt'])
  assert.deepEqual(parseCsv('﻿a;b\n"x;1";2\n'), [['a', 'b'], ['x;1', '2']])
  assert.deepEqual(parseCsv('a,b\r\n"q""q",\n'), [['a', 'b'], ['q"q', '']])
})

test('feedback: unmet checked points by priority, taste only as a remark, review points never, unknown silent', () => {
  const task = byId('docs/dev/minutes-d-201')
  /** @param {Record<string, boolean | null>} passes */
  const judged = passes => ({ pass: null, rate: null, problems: [], points: task.rubric.filter(p => p.by !== 'none').map(p => ({ id: p.id, type: p.type, by: p.by, pass: p.id in passes ? passes[p.id] : null, detail: '' })) })
  const failed = pilotFeedback(task, /** @type {any} */ (judged({ m: true, u: false, c: false })), false)
  assert.equal(failed.primary, 'u')
  assert.deepEqual(failed.entries.map(e => e.rating), [2, undefined, 3])
  assert.match(failed.entries[0].comment, /预算数字/)
  assert.match(failed.entries[0].comment, /另外，文末没有列出用到的资料文件。/)
  assert.match(failed.entries[0].comment, /还有，这次我想要短一点/)
  assert.ok(!failed.entries[1].comment.includes('另外'))
  assert.ok(failed.entries.every(e => !e.comment.includes('记录里没有的内容')), 'review points do not become feedback')
  const passed = pilotFeedback(task, /** @type {any} */ (judged({ m: true, u: true, c: true })), true)
  assert.deepEqual(passed.entries, [{ key: 'praise', rating: 5, comment: '这次的结果没问题，谢谢。' }])
  assert.equal(pilotFeedback(task, /** @type {any} */ (judged({ m: true, u: true, c: true })), false).entries[0].rating, 4)
  assert.deepEqual(pilotFeedback(task, /** @type {any} */ (judged({ m: null, u: true, c: true })), false).entries, [])
})

test('external reviewer: request carries review points and materials; replies parse; both orders compared', async () => {
  const task = byId('docs/selection/compare-memo-d-204')
  const request = pointRequest(task, '# 备忘')
  assert.equal(request.model, 'claude-opus-5-5')
  assert.equal(request.thinking, 'on')
  assert.match(request.user, /- r：推荐意见符合预算约束/)
  assert.ok(!request.user.includes('- m：'), 'checked points are not sent to the reviewer')
  assert.match(request.user, /【客服系统替换-方案A\.md】|【.*-方案A\.md】/)
  assert.deepEqual(parsePointVerdicts('想了想\n```json\n{"points":[{"id":"r","verdict":"是","reason":"在预算内"},{"id":"f","verdict":"看不出","reason":"?"},{"id":"zz","verdict":"否"}]}\n```', ['r', 'f']),
    { r: { verdict: 'yes', reason: '在预算内' }, f: { verdict: 'unclear', reason: '?' } })
  assert.equal(parsePointVerdicts('no json here', ['r']), null)
  assert.equal(parsePreference('{"preference":"B","reason":"x"}'), 'B')
  assert.equal(parsePreference('{"preference":"C"}'), null)
  assert.deepEqual(parsePairReply('{"differences":[],"preference":"A","reason":"差不多"}'), { preference: 'tie', reason: '差不多', differences: [] }, 'no difference listed: a tie whatever it names')
  assert.deepEqual(parsePairReply('{"differences":["A 写了负责人"],"preference":"A","reason":"r"}'), { preference: 'A', reason: 'r', differences: ['A 写了负责人'] })
  const pair = pairRequest(task, 'DOC-A', 'DOC-B')
  assert.ok(pair.user.indexOf('# 评分要点') < pair.user.indexOf('# 成果 A'), 'the points come before the documents')
  for (const point of task.rubric) assert.equal(pair.user.includes(`- ${point.id}：${point.text}`), point.by !== 'none', `${point.id} (${point.by})`)
  const reviewed = await reviewPoints(scriptedComplete(() => '{"points":[{"id":"r","verdict":"否","reason":"超预算"}]}'), task, '# 备忘')
  const merged = withReview({ pass: null, rate: null, problems: [], points: [{ id: 'm', type: 'missing', by: 'check', pass: true, detail: '' }, { id: 'r', type: 'wrong-result', by: 'review', pass: null, detail: '' }, { id: 'f', type: 'format', by: 'review', pass: null, detail: '' }] }, reviewed.verdicts)
  assert.equal(merged.pass, null, 'a point the reviewer skipped stays unknown')
  const unclear = withReview(merged, { r: { verdict: 'no', reason: '' }, f: { verdict: 'unclear', reason: '' } })
  assert.equal(unclear.pass, false)
  assert.equal(unclear.rate, 1 / 3)
  assert.equal(unclear.points.find(p => p.id === 'f')?.unclear, true)
  const prefersFirst = scriptedComplete(request => (request.user.indexOf('GOOD') < request.user.indexOf('BAD') ? '{"preference":"A"}' : '{"preference":"B"}'))
  assert.deepEqual(await comparePair(prefersFirst, task, 'GOOD', 'BAD'), { ab: 'A', ba: 'B', consistent: true, winner: 'first', replies: { ab: { reason: '', differences: [] }, ba: { reason: '', differences: [] } }, usd: 0 })
  const alwaysA = scriptedComplete(() => '{"differences":["前一份更完整"],"preference":"A","reason":"更完整"}')
  const biased = await comparePair(alwaysA, task, 'GOOD', 'BAD')
  assert.equal(biased.consistent, false)
  assert.deepEqual(biased.replies.ba, { reason: '更完整', differences: ['前一份更完整'] }, 'each order\'s reason is kept')
  const broken = await comparePair(async () => { throw new Error('down') }, task, 'GOOD', 'BAD')
  assert.deepEqual(broken.replies.ab, { failed: 'down' })
  assert.deepEqual(orderOutcome('tie', 'tie'), { consistent: true, winner: 'tie' })
})

test('reliability: six reference pairs from non-holdout tasks; thresholds 5/6 and 80%', () => {
  const pairs = pilotReferencePairs()
  assert.equal(pairs.length, 6)
  assert.ok(pairs.every(p => !p.caseId.includes('/holdout/') && p.good !== p.bad))
  const right = { ab: /** @type {const} */ ('A'), ba: /** @type {const} */ ('B') }
  const wrong = { ab: /** @type {const} */ ('A'), ba: /** @type {const} */ ('A') }
  assert.equal(pairAccuracy(pairs.map((p, i) => ({ id: p.id, ...(i === 0 ? wrong : right) }))).pass, true)
  assert.equal(pairAccuracy(pairs.map((p, i) => ({ id: p.id, ...(i < 2 ? wrong : right) }))).pass, false)
  assert.equal(orderConsistency([right, right, right, right, wrong]).pass, true)
  assert.equal(orderConsistency([right, right, right, wrong, wrong]).pass, false)
  assert.equal(orderConsistency([right, right, right, right, { ab: null, ba: 'B' }]).pass, false, 'a failed reply is not a pass')
  assert.deepEqual(reliabilityVerdict({ judges: { pass: true }, pairs: { pass: false }, order: { pass: true } }), { reliable: false, failed: ['pairs'] })
})

test('stats: paired rate difference with a seeded two-level bootstrap, spread, follow-ups, classes, literals, agreement', () => {
  /** @type {import('../pilot/stats.mjs').PilotRun[]} */
  const runs = []
  for (const caseId of ['h1', 'h2', 'h3']) {
    for (let repeat = 1; repeat <= 3; repeat += 1) {
      runs.push({ runId: `base#${caseId}#${repeat}`, family: 'docs', caseId, arm: 'base', repeat, rate: 0.5, pass: false, followUp: repeat === 1 })
      runs.push({ runId: `parent#${caseId}#${repeat}`, family: 'docs', caseId, arm: 'parent', repeat, rate: repeat === 3 ? 0.75 : 1, pass: repeat !== 3 })
      runs.push({ runId: `memory#${caseId}#${repeat}`, family: 'docs', caseId, arm: 'memory', repeat, rate: caseId === 'h3' ? null : 0.5, pass: caseId === 'h3' ? null : false })
    }
  }
  const up = pairedRateDiff(runs, { treatment: 'parent', control: 'base' })
  assert.equal(up.n, 3)
  assert.ok(Math.abs(/** @type {number} */ (up.mean) - 41.666666667) < 1e-6)
  assert.equal(up.verdict, 'positive')
  assert.deepEqual(up, pairedRateDiff(runs, { treatment: 'parent', control: 'base' }), 'same seed, same interval')
  const flat = pairedRateDiff(runs, { treatment: 'memory', control: 'base' })
  assert.equal(flat.n, 2)
  assert.equal(flat.verdict, 'zero')
  assert.deepEqual(flat.missing, [{ caseId: 'h3', arm: 'memory' }])
  assert.deepEqual(wholePass(runs, 'memory'), { runs: 9, known: 6, passed: 0, rate: 0, unknown: 3 })
  assert.deepEqual(repeatSpread(runs, 'h1', 'parent'), { rates: [1, 1, 0.75], min: 0.75, max: 1, range: 0.25, unknown: 0 })
  assert.deepEqual(followUpsByArm(runs).base, { runs: 9, followUps: 3 })
  assert.equal(componentClass({ kind: 'skill' }), 'way-of-working')
  assert.equal(componentClass({ kind: 'context-policy', text: '输出文件名不含空格。' }), 'convention-or-fact')
  assert.equal(componentClass({ kind: 'context-policy', text: '(1) 先读资料 (2) 交付前核对数字' }), 'way-of-working')
  const finder = (/** @type {string[]} */ texts, /** @type {string[]} */ sources) => texts.flatMap(t => (t.includes('2384.13') && sources.some(s => s.includes('2384.13')) ? ['2384.13'] : []))
  assert.deepEqual(literalRate([{ name: 'a', texts: ['check 2384.13'], sources: ['财务是 2384.13'], projectMessages: [] }, { name: 'b', texts: ['no spaces'], sources: ['财务是 2384.13'], projectMessages: [] }], finder).rate, 0.5)
  assert.deepEqual(agreementRate([{ a: true, b: true }, { a: true, b: false }, { a: null, b: true }]), { items: 3, known: 2, agree: 1, rate: 0.5 })
})

test('memory arm: feedback oldest first under the fixed title; over the limit, the oldest go', () => {
  const entries = [{ at: '2026-10-14T02:00:00Z', comment: '第二条' }, { at: '2026-10-14T01:00:00Z', comment: '第一条' }]
  const all = memoryInstructions(entries)
  assert.equal(all.instructions, `${MEMORY_POLICY.title}\n\n- 第一条\n- 第二条\n`)
  const small = memoryInstructions(entries, Buffer.byteLength(`${MEMORY_POLICY.title}\n\n- 第二条\n`))
  assert.deepEqual([small.kept, small.dropped], [1, 1])
  assert.ok(small.instructions.endsWith('- 第二条\n'))
})
