/**
 * Hidden check of the step-3 real task (never shown to the model): computes
 * the expected restock plan from the fixture on its own
 * (step3-restock/generate.mjs) and checks the `purchase.xlsx` the model
 * delivered.
 *
 * Task text (docs/plan/step-3-work-partition.md §真实模型验收): “根据库存表生成
 * 采购计划 purchase.xlsx：Plan 表用公式计算目标库存、补货量（向上取整）和金额，
 * Summary 表汇总，完成后交给我。” Feedback: “P01 的现有库存应为 20，请更新。”
 *
 * Rules: 目标库存 = 周需求 × 交期(周) + 安全库存; 补货量 = max(0, ⌈目标库存 − 现有库存⌉);
 * 金额 = 补货量 × 单价; Summary = 补货量合计与金额合计.
 *
 * What counts: sheets named Plan and Summary (case and surrounding spaces
 * ignored); in Plan, the row of each SKU holds three distinct formula cells
 * whose cached values equal the expected target stock, order quantity and
 * amount (±0.005); in Summary, two distinct formula cells equal the totals.
 * A formula must reference at least one cell (a constant like `=34` is a
 * written-in number). Layout is otherwise free. Cached values are trusted as
 * written; recalculation is not checked here.
 */
import { createHash } from 'node:crypto'
import { FEEDBACK_OVERRIDE, SKUS } from './step3-restock/generate.mjs'
import { readWorkbook, sheetRows } from './step3-restock/xlsx.mjs'

export const PURCHASE_PATH = 'purchase.xlsx'
const TOLERANCE = 0.005
const round2 = value => Math.round(value * 100) / 100

/**
 * The expected plan.
 * @param override - `{ sku, onHand }` for the feedback round, or undefined for round 1.
 * @returns `{ rows: [{ sku, onHand, target, reorder, amount }], totals: { units, amount } }`.
 */
export function expectedPlan(override) {
  const rows = SKUS.map((s) => {
    const onHand = override?.sku === s.sku ? override.onHand : s.onHand
    const target = round2(s.weeklyDemand * s.leadWeeks + s.safetyStock)
    const reorder = Math.max(0, Math.ceil(target - onHand - 1e-9))
    return { sku: s.sku, onHand, target, reorder, amount: round2(reorder * s.unitPrice) }
  })
  return {
    rows,
    totals: { units: rows.reduce((sum, r) => sum + r.reorder, 0), amount: round2(rows.reduce((sum, r) => sum + r.amount, 0)) },
  }
}

/** The expected plans of both rounds. */
export const EXPECTED = { v1: expectedPlan(undefined), v2: expectedPlan(FEEDBACK_OVERRIDE) }

const REFERENCES_A_CELL = /(^|[^A-Za-z0-9_])\$?[A-Za-z]{1,3}\$?\d+/
const isFormulaCell = cell => typeof cell?.formula === 'string' && REFERENCES_A_CELL.test(cell.formula)
const near = (value, expected) => typeof value === 'number' && Math.abs(value - expected) <= TOLERANCE

/** Pick one distinct cell per expected value, in order; `undefined` where none is left. */
function pickDistinct(cells, expectedValues) {
  const used = new Set()
  return expectedValues.map((expected) => {
    const cell = cells.find(c => !used.has(c.ref) && near(c.value, expected))
    if (cell !== undefined) used.add(cell.ref)
    return cell
  })
}

function findSheet(workbook, name) {
  return workbook.sheets.find(sheet => String(sheet.name).trim().toLowerCase() === name.toLowerCase())
}

/**
 * Check one purchase.xlsx against an expected plan.
 * @returns `{ pass, problems: string[], found }`.
 */
export function checkPurchase(bytes, expected) {
  let workbook
  try {
    workbook = readWorkbook(bytes)
  } catch (error) {
    return { pass: false, problems: [`not a readable .xlsx: ${error instanceof Error ? error.message : String(error)}`], found: {} }
  }
  const problems = []
  const found = { sheets: workbook.sheets.map(s => s.name), rows: {}, totals: {} }
  const plan = findSheet(workbook, 'Plan')
  const summary = findSheet(workbook, 'Summary')
  if (plan === undefined) problems.push(`no Plan sheet (sheets: ${found.sheets.join(', ')})`)
  if (summary === undefined) problems.push(`no Summary sheet (sheets: ${found.sheets.join(', ')})`)
  if (plan !== undefined) {
    const rows = sheetRows(plan)
    for (const want of expected.rows) {
      const row = rows.find(r => (r ?? []).some(cell => typeof cell?.value === 'string' && cell.value.trim() === want.sku))
      if (row === undefined) {
        problems.push(`Plan: no row for ${want.sku}`)
        continue
      }
      const formulas = row.filter(isFormulaCell)
      const [target, reorder, amount] = pickDistinct(formulas, [want.target, want.reorder, want.amount])
      found.rows[want.sku] = { target: target?.ref, reorder: reorder?.ref, amount: amount?.ref }
      for (const [label, cell, value] of [['target stock', target, want.target], ['order quantity', reorder, want.reorder], ['amount', amount, want.amount]]) {
        if (cell !== undefined) continue
        const written = row.find(c => near(c?.value, value) && !isFormulaCell(c))
        problems.push(`Plan ${want.sku}: no formula cell with ${label} ${value}${written === undefined ? '' : ` (${written.ref} holds it as a written-in value)`}`)
      }
    }
  }
  if (summary !== undefined) {
    const cells = [...summary.cells].map(([ref, cell]) => ({ ref, ...cell })).filter(isFormulaCell)
    const [units, amount] = pickDistinct(cells, [expected.totals.units, expected.totals.amount])
    found.totals = { units: units?.ref, amount: amount?.ref }
    if (units === undefined) problems.push(`Summary: no formula cell with total order quantity ${expected.totals.units}`)
    if (amount === undefined) problems.push(`Summary: no formula cell with total amount ${expected.totals.amount}`)
  }
  return { pass: problems.length === 0, problems, found }
}

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

/**
 * Judge both rounds: v1 matches round 1, v2 matches the feedback round, and
 * the v1 snapshot is unchanged after v2.
 * @param input - `{ v1, v2, v1ShaAtPresent, v1ShaAtEnd }`: delivered bytes (v1, v2) and the
 *   recorded / final SHA-256 of v1's snapshot.
 * @returns `{ pass, problems, v1, v2 }`.
 */
export function judgeRestock({ v1, v2, v1ShaAtPresent, v1ShaAtEnd }) {
  const problems = []
  const r1 = v1 === undefined ? { pass: false, problems: ['no v1 purchase.xlsx'], found: {} } : checkPurchase(v1, EXPECTED.v1)
  const r2 = v2 === undefined ? { pass: false, problems: ['no v2 purchase.xlsx'], found: {} } : checkPurchase(v2, EXPECTED.v2)
  problems.push(...r1.problems.map(p => `v1: ${p}`), ...r2.problems.map(p => `v2: ${p}`))
  if (v1 !== undefined && v1ShaAtPresent !== undefined && sha256(v1) !== v1ShaAtPresent) problems.push('v1 bytes differ from the SHA-256 recorded when it was presented')
  if (v1ShaAtPresent === undefined || v1ShaAtEnd !== v1ShaAtPresent) problems.push('the v1 snapshot changed (or is missing) after the feedback round')
  return { pass: problems.length === 0, problems, v1: r1, v2: r2 }
}
