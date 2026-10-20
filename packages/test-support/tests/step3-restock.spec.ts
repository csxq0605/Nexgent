import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { FEEDBACK_OVERRIDE, HEADER, inventoryXlsx, SKUS } from '../../../scripts/real-task/step3-restock/generate.mjs'
import { readWorkbook, sheetRows, writeWorkbook, type WriteCell } from '../../../scripts/real-task/step3-restock/xlsx.mjs'
import { checkPurchase, EXPECTED, expectedPlan, judgeRestock, sha256, type Plan } from '../../../scripts/real-task/step3-restock-hidden.mjs'

const committed = fileURLToPath(new URL('../../../scripts/real-task/step3-restock/inventory.xlsx', import.meta.url))

/**
 * A purchase.xlsx the way a careful model would build it: Inputs copied, Plan
 * computed by cross-sheet formulas with correct cached values, Summary by SUM.
 * `tweak` can rewrite any Plan / Summary cell before writing.
 */
function purchase(plan: Plan, options: { compress?: boolean; tweak?: (sheets: Record<string, WriteCell[][]>) => void } = {}): Buffer {
  const onHand = new Map(plan.rows.map(r => [r.sku, r.onHand]))
  const inputs: WriteCell[][] = [[...HEADER], ...SKUS.map(s => [s.sku, s.name, onHand.get(s.sku)!, s.weeklyDemand, s.leadWeeks, s.safetyStock, s.unitPrice])]
  const planRows: WriteCell[][] = [['SKU', '名称', '现有库存', '目标库存', '补货量', '金额']]
  plan.rows.forEach((row, i) => {
    const r = i + 2
    planRows.push([
      row.sku,
      SKUS[i]!.name,
      { formula: `Inputs!C${r}`, value: row.onHand },
      { formula: `Inputs!D${r}*Inputs!E${r}+Inputs!F${r}`, value: row.target },
      { formula: `MAX(0,ROUNDUP(D${r}-C${r},0))`, value: row.reorder },
      { formula: `E${r}*Inputs!G${r}`, value: row.amount },
    ])
  })
  const summary: WriteCell[][] = [['项目', '合计'], ['补货量合计', { formula: 'SUM(Plan!E2:E7)', value: plan.totals.units }], ['金额合计', { formula: 'SUM(Plan!F2:F7)', value: plan.totals.amount }]]
  const sheets = { Inputs: inputs, Plan: planRows, Summary: summary }
  options.tweak?.(sheets)
  return writeWorkbook(Object.entries(sheets).map(([name, rows]) => ({ name, rows })), { compress: options.compress ?? false })
}

describe('restock fixture', () => {
  it('is deterministic and the committed inventory.xlsx is current', async () => {
    expect(inventoryXlsx().equals(inventoryXlsx())).toBe(true)
    expect((await readFile(committed)).equals(inventoryXlsx())).toBe(true)
  })

  it('reads back as one Inputs sheet with six SKUs, two above target', () => {
    const [sheet, ...rest] = readWorkbook(inventoryXlsx()).sheets
    expect(rest).toHaveLength(0)
    expect(sheet!.name).toBe('Inputs')
    const rows = sheetRows(sheet!).map(r => (r ?? []).map(c => c?.value))
    expect(rows[0]).toEqual([...HEADER])
    expect(rows.slice(1).map(r => r[0])).toEqual(['P01', 'P02', 'P03', 'P04', 'P05', 'P06'])
    expect(EXPECTED.v1.rows.filter(r => r.reorder === 0).map(r => r.sku)).toEqual(['P03', 'P05'])
  })

  it('pins the expected plans (computed independently by hand)', () => {
    expect(EXPECTED.v1.rows.map(r => [r.sku, r.target, r.reorder, r.amount])).toEqual([
      ['P01', 34, 20, 40], ['P02', 27.5, 19, 85.5], ['P03', 28, 0, 0], ['P04', 13.5, 12, 150], ['P05', 30, 0, 0], ['P06', 33.75, 14, 44.8],
    ])
    expect(EXPECTED.v1.totals).toEqual({ units: 65, amount: 320.3 })
    expect(FEEDBACK_OVERRIDE).toEqual({ sku: 'P01', onHand: 20 })
    expect(EXPECTED.v2.rows[0]).toMatchObject({ sku: 'P01', onHand: 20, reorder: 14, amount: 28 })
    expect(EXPECTED.v2.totals).toEqual({ units: 59, amount: 308.3 })
    expect(expectedPlan()).toEqual(EXPECTED.v1)
  })

  it('no input of a SKU equals one of its computed values (a copied input cannot pass as a result)', () => {
    for (const plan of [EXPECTED.v1, EXPECTED.v2]) {
      for (const row of plan.rows) {
        const s = SKUS.find(x => x.sku === row.sku)!
        const inputs = [row.onHand, s.weeklyDemand, s.leadWeeks, s.safetyStock, s.unitPrice]
        for (const value of [row.target, row.reorder, row.amount]) expect(inputs, `${row.sku} ${value}`).not.toContain(value)
      }
    }
  })
})

describe('xlsx reader', () => {
  it('round-trips strings, numbers, formulas with cached values, stored or deflated', () => {
    for (const compress of [false, true]) {
      const bytes = writeWorkbook([{ name: 'S & <1>', rows: [['a & b', 1.5, { formula: 'B1*2', value: 3 }, { formula: 'A1&"!"', value: 'a & b!' }, null, { formula: 'NOW()' }]] }], { compress })
      const [sheet] = readWorkbook(bytes).sheets
      expect(sheet!.name).toBe('S & <1>')
      expect([...sheet!.cells]).toEqual([
        ['A1', { value: 'a & b' }],
        ['B1', { value: 1.5 }],
        ['C1', { value: 3, formula: 'B1*2' }],
        ['D1', { value: 'a & b!', formula: 'A1&"!"' }],
        ['F1', { value: null, formula: 'NOW()' }],
      ])
    }
  })

  it('rejects bytes that are not a workbook', () => {
    expect(() => readWorkbook(Buffer.from('not a zip at all, just text'))).toThrow(/not a zip/)
  })
})

describe('hidden check: checkPurchase', () => {
  it('passes a correct workbook for each round, stored or deflated', () => {
    expect(checkPurchase(purchase(EXPECTED.v1), EXPECTED.v1)).toMatchObject({ pass: true, problems: [] })
    expect(checkPurchase(purchase(EXPECTED.v2, { compress: true }), EXPECTED.v2)).toMatchObject({ pass: true, problems: [] })
  })

  it.each<[string, (s: Record<string, WriteCell[][]>) => void, RegExp]>([
    ['written-in numbers instead of formulas', s => { s['Plan']!.slice(1).forEach(row => { for (let c = 2; c < 6; c += 1) row[c] = (row[c] as { value: number }).value }) }, /written-in value/],
    ['a constant formula (=34)', s => { s['Plan']![1]![3] = { formula: '34', value: 34 } }, /P01: no formula cell with target stock 34/],
    ['order quantity not rounded up', s => { s['Plan']![2]![4] = { formula: 'D3-C3', value: 18.5 } }, /P02: no formula cell with order quantity 19/],
    ['a negative order for a SKU above target', s => { s['Plan']![3]![4] = { formula: 'D4-C4', value: -32 } }, /P03: no formula cell with (order quantity|amount) 0/],
    ['a wrong amount', s => { s['Plan']![4]![5] = { formula: 'E5*12', value: 144 } }, /P04: no formula cell with amount 150/],
    ['a missing SKU row', s => { s['Plan']!.splice(6, 1) }, /Plan: no row for P06/],
    ['a wrong total', s => { s['Summary']![2]![1] = { formula: 'SUM(Plan!F2:F6)', value: 275.5 } }, /total amount 320.3/],
  ])('fails on %s', (_label, tweak, problem) => {
    const result = checkPurchase(purchase(EXPECTED.v1, { tweak }), EXPECTED.v1)
    expect(result.pass).toBe(false)
    expect(result.problems.join('\n')).toMatch(problem)
  })

  it('fails without a Plan or Summary sheet, and on a non-workbook', () => {
    const noSummary = writeWorkbook([{ name: 'Plan', rows: [['P01']] }])
    expect(checkPurchase(noSummary, EXPECTED.v1).problems.join('\n')).toMatch(/no Summary sheet/)
    expect(checkPurchase(Buffer.from('nope'), EXPECTED.v1)).toMatchObject({ pass: false, problems: [expect.stringMatching(/not a readable/)] })
  })

  it('a round-1 workbook does not pass as the feedback version', () => {
    const result = checkPurchase(purchase(EXPECTED.v1), EXPECTED.v2)
    expect(result.pass).toBe(false)
    expect(result.problems.join('\n')).toMatch(/P01: no formula cell with (order quantity 14|amount 28)/)
  })
})

describe('hidden check: judgeRestock', () => {
  const v1 = purchase(EXPECTED.v1)
  const v2 = purchase(EXPECTED.v2)
  it('passes both rounds with an unchanged v1 snapshot', () => {
    expect(judgeRestock({ v1, v2, v1ShaAtPresent: sha256(v1), v1ShaAtEnd: sha256(v1) })).toMatchObject({ pass: true, problems: [] })
  })
  it('fails when v1 changed after the feedback round, when v2 is missing, or when v2 equals v1', () => {
    expect(judgeRestock({ v1, v2, v1ShaAtPresent: sha256(v1), v1ShaAtEnd: sha256(v2) }).problems).toContain('the v1 snapshot changed (or is missing) after the feedback round')
    expect(judgeRestock({ v1, v1ShaAtPresent: sha256(v1), v1ShaAtEnd: sha256(v1) }).problems).toContain('v2: no v2 purchase.xlsx')
    expect(judgeRestock({ v1, v2: v1, v1ShaAtPresent: sha256(v1), v1ShaAtEnd: sha256(v1) }).pass).toBe(false)
    expect(judgeRestock({ v1, v2, v1ShaAtPresent: sha256(v2), v1ShaAtEnd: sha256(v2) }).problems.join('\n')).toMatch(/differ from the SHA-256 recorded/)
  })
})
