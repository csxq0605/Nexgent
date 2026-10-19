import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CONVENTION_COLUMN, expectedSummary, judgeSummaryText, judgeTableCase, judgeTableText, referenceTable, returnsCsv, tableCase,
} from '../tables.mjs'

const kinds = result => [...new Set(result.issues.map(issue => issue.kind))].sort()

test('the same month gives the same case, byte for byte', () => {
  const a = tableCase({ id: 'x', set: 'holdout', variant: 'returns', month: '2027-02' })
  const b = tableCase({ id: 'x', set: 'holdout', variant: 'returns', month: '2027-02' })
  assert.deepEqual(a, b)
  assert.deepEqual(Object.keys(a.files).sort(), ['data/orders-2027-02.csv', 'data/returns-2027-02.csv'])
  assert.deepEqual(a.materials, [])
  assert.notEqual(returnsCsv('2027-02'), returnsCsv('2027-01'))
})

test('the task text never names the convention column', () => {
  for (const variant of ['region', 'category', 'returns', 'summary']) {
    assert.ok(!tableCase({ id: 'x', set: 'dev', variant, month: '2026-09' }).message.includes(CONVENTION_COLUMN))
  }
})

test('returns CSV has at least two returned orders, all from that month', () => {
  const lines = returnsCsv('2026-12').trim().split('\n')
  assert.equal(lines[0], 'order_id,reason')
  assert.ok(lines.length - 1 >= 2)
  for (const line of lines.slice(1)) assert.match(line, /^202612-\d{3},/)
})

for (const variant of ['region', 'category', 'returns']) {
  test(`${variant}: the wanted table passes, the table without the convention fails only on it`, () => {
    assert.deepEqual(judgeTableText(variant, '2026-12', referenceTable(variant, '2026-12', { withConvention: true })), { pass: true, issues: [], problems: [] })
    const without = judgeTableText(variant, '2026-12', referenceTable(variant, '2026-12', { withConvention: false }))
    assert.equal(without.pass, false)
    assert.deepEqual(kinds(without), ['convention-column'])
  })
}

test('a wrong number, a missing column, wrong row order and no file each fail', () => {
  const good = referenceTable('region', '2026-09', { withConvention: true })
  const lines = good.trim().split('\n')
  const cells = lines[1].split(',')
  cells[2] = (Number(cells[2]) + 1).toFixed(2)
  assert.deepEqual(kinds(judgeTableText('region', '2026-09', [lines[0], cells.join(','), ...lines.slice(2)].join('\n'))), ['wrong-value'])
  const dropped = lines.map(line => line.split(',').filter((_, i) => i !== 1).join(',')).join('\n')
  assert.deepEqual(kinds(judgeTableText('region', '2026-09', dropped)), ['missing-column'])
  assert.deepEqual(kinds(judgeTableText('region', '2026-09', [lines[0], ...lines.slice(1).reverse()].join('\n'))), ['wrong-rows'])
  assert.deepEqual(kinds(judgeTableText('region', '2026-09', '')), ['missing-output'])
  const avg = lines.map((line, i) => (i === 0 ? line : line.replace(/,[\d.]+$/, ',1.00'))).join('\n')
  assert.deepEqual(kinds(judgeTableText('region', '2026-09', avg)), ['convention-value'])
})

test('a table with gross revenue (discount ignored) fails on revenue', () => {
  const good = referenceTable('category', '2026-08', { withConvention: true })
  const bad = good.replace(/\n([^,\n]+),(\d+),(\d+),([\d.]+),/, (_, p, o, u, r) => `\n${p},${o},${u},${(Number(r) * 1.1).toFixed(2)},`)
  assert.equal(judgeTableText('category', '2026-08', bad).pass, false)
})

test('summary judge: the expected summary passes, a wrong field fails, non-JSON fails', () => {
  const want = expectedSummary('2026-06')
  assert.equal(judgeSummaryText('2026-06', JSON.stringify(want)).pass, true)
  assert.deepEqual(kinds(judgeSummaryText('2026-06', JSON.stringify({ ...want, units: want.units + 1 }))), ['wrong-value'])
  assert.deepEqual(kinds(judgeSummaryText('2026-06', 'not json')), ['invalid-output'])
  assert.deepEqual(kinds(judgeSummaryText('2026-06', null)), ['missing-output'])
})

test('judgeTableCase reads the output from the project directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nx6-t-'))
  try {
    const task = tableCase({ id: 'x', set: 'holdout', variant: 'category', month: '2027-01' })
    assert.deepEqual(kinds(await judgeTableCase(task, dir)), ['missing-output'])
    await mkdir(join(dir, 'reports'), { recursive: true })
    await writeFile(join(dir, task.outputs[0]), referenceTable('category', '2027-01', { withConvention: true }))
    assert.equal((await judgeTableCase(task, dir)).pass, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('hard: finance net figures pass, the plain table fails on finance values and the column, the returns file is always there', () => {
  for (const [variant, month] of /** @type {const} */ ([['region', '2026-09'], ['region', '2026-10'], ['category', '2026-08'], ['returns', '2027-02']])) {
    assert.deepEqual(judgeTableText(variant, month, referenceTable(variant, month, { withConvention: true, hard: true }), { hard: true }).problems, [])
    const plain = judgeTableText(variant, month, referenceTable(variant, month, { withConvention: false, hard: true }), { hard: true })
    assert.equal(plain.pass, false)
    assert.deepEqual(kinds(plain), ['convention-column', 'finance-value'], `${variant} ${month}`)
    for (const issue of plain.issues.filter(i => i.kind === 'finance-value')) assert.match(issue.detail, /财务是 .+，表里是 /)
  }
  const task = tableCase({ id: 'x', set: 'dev', variant: 'region', month: '2026-09', hard: true })
  assert.ok(task.files['data/returns-2026-09.csv'] !== undefined)
  assert.ok(!task.message.includes('退货'))
  assert.equal(task.hidden.hard, true)
  const returns = tableCase({ id: 'x', set: 'holdout', variant: 'returns', month: '2027-02', hard: true })
  assert.ok(returns.message.includes('orders 是全部订单数') && !returns.message.includes('revenue 不扣退货'))
  // The standard table with the plain avg column still disagrees with finance.
  assert.equal(judgeTableText('region', '2026-09', referenceTable('region', '2026-09', { withConvention: true }), { hard: true }).pass, false)
})
