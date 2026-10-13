// @ts-check
/**
 * Step-6 task family "tables / data" (docs/plan/step-6-work-partition.md §测量):
 * one shop's monthly order CSVs (step 4's generator, imported, not changed) and
 * a returns CSV, turned into one table per task. Variants:
 *
 *   region     region,orders,revenue                                  one row per region
 *   category   product,orders,units,revenue                           one row per product
 *   returns    product,orders,revenue,returned_orders,return_rate     one row per product
 *   summary    a JSON month summary (step 4's shape)                   the guard task, no convention
 *
 * The user's convention, named only by feedback: every grouped table also has
 * `avg_order_value` = revenue / orders, to cents. The task text never mentions it.
 *
 * The hidden judge computes every expected value from the CSVs on its own; it
 * shares no code with capability components or a project's check script.
 *
 * Linux, macOS and Windows; no dependencies.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ordersCsv, parseOrders } from '../../real-task/step4-orders.mjs'
import { picker } from './rng.mjs'

/** The column only feedback names. */
export const CONVENTION_COLUMN = 'avg_order_value'

export const TABLE_VARIANTS = /** @type {const} */ (['region', 'category', 'returns', 'summary'])

const RETURN_REASONS = ['damaged', 'wrong-item', 'late', 'changed-mind']

/**
 * The returns CSV of one month: `order_id,reason`, about one order in six, at least two.
 * @param {string} month YYYY-MM
 */
export function returnsCsv(month) {
  const orders = parseOrders(ordersCsv(month))
  const { next, pick } = picker(`returns:${month}`)
  const returned = orders.filter((_, index) => index === 1 || index === 4 || next() < 0.12)
  return `${['order_id,reason', ...returned.map(row => `${row.orderId},${pick(RETURN_REASONS)}`)].join('\n')}\n`
}

const cents = (/** @type {number} */ value) => Math.round(value * 100) / 100
const amountOf = (/** @type {{quantity:number, unitPrice:number, discount:number}} */ row) => row.quantity * row.unitPrice * (1 - row.discount)

/**
 * Expected rows of a grouped variant, keyed and sorted; every value a number.
 * @param {'region' | 'category' | 'returns'} variant
 * @param {string} month
 * @returns {{ key: string, columns: string[], rows: Array<Record<string, string | number>> }}
 */
export function expectedTable(variant, month) {
  const orders = parseOrders(ordersCsv(month))
  const key = variant === 'region' ? 'region' : 'product'
  /** @type {Record<string, {orders:number, units:number, revenue:number, returned:number}>} */
  const groups = {}
  const returned = variant === 'returns'
    ? new Set(returnsCsv(month).split('\n').slice(1).filter(Boolean).map(line => line.split(',')[0]))
    : new Set()
  for (const row of orders) {
    const name = key === 'region' ? row.region : row.product
    const entry = groups[name] ?? (groups[name] = { orders: 0, units: 0, revenue: 0, returned: 0 })
    entry.orders += 1
    entry.units += row.quantity
    entry.revenue += amountOf(row)
    if (returned.has(row.orderId)) entry.returned += 1
  }
  const columns = variant === 'region' ? ['region', 'orders', 'revenue']
    : variant === 'category' ? ['product', 'orders', 'units', 'revenue']
      : ['product', 'orders', 'revenue', 'returned_orders', 'return_rate']
  const rows = Object.keys(groups).sort().map(name => {
    const g = groups[name]
    const revenue = cents(g.revenue)
    return {
      [key]: name,
      orders: g.orders,
      units: g.units,
      revenue,
      returned_orders: g.returned,
      return_rate: Math.round((g.returned / g.orders) * 1000) / 10,
      [CONVENTION_COLUMN]: cents(revenue / g.orders),
    }
  })
  return { key, columns, rows }
}

/**
 * The table text the user actually wants (reference answer for judge tests).
 * @param {'region' | 'category' | 'returns'} variant
 * @param {string} month
 * @param {{ withConvention: boolean }} options
 */
export function referenceTable(variant, month, { withConvention }) {
  const { columns, rows } = expectedTable(variant, month)
  const header = [...columns, ...(withConvention ? [CONVENTION_COLUMN] : [])]
  const format = (/** @type {string} */ column, /** @type {string | number} */ value) =>
    column === 'revenue' || column === CONVENTION_COLUMN ? Number(value).toFixed(2)
      : column === 'return_rate' ? Number(value).toFixed(1) : String(value)
  return `${[header.join(','), ...rows.map(row => header.map(column => format(column, row[column])).join(','))].join('\n')}\n`
}

/**
 * Step 4's month summary, computed here independently.
 * @param {string} month
 */
export function expectedSummary(month) {
  const orders = parseOrders(ordersCsv(month))
  /** @type {Record<string, number>} */ const byRegion = {}
  /** @type {Record<string, number>} */ const units = {}
  let revenue = 0
  for (const row of orders) {
    revenue += amountOf(row)
    byRegion[row.region] = (byRegion[row.region] ?? 0) + amountOf(row)
    units[row.product] = (units[row.product] ?? 0) + row.quantity
  }
  return {
    month,
    orders: orders.length,
    units: Object.values(units).reduce((sum, value) => sum + value, 0),
    revenue: cents(revenue),
    byRegion: Object.fromEntries(Object.keys(byRegion).sort().map(region => [region, cents(byRegion[region])])),
    topProduct: Object.keys(units).sort((a, b) => units[b] - units[a] || a.localeCompare(b))[0],
  }
}

const VARIANT_TEXT = {
  region: { what: '地区汇总表', rows: '每个地区一行', columns: 'region,orders,revenue', sort: '按 region 字母顺序排列' },
  category: { what: '商品汇总表', rows: '每个商品一行', columns: 'product,orders,units,revenue', sort: '按 product 字母顺序排列' },
  returns: { what: '退货率表', rows: '每个商品一行', columns: 'product,orders,revenue,returned_orders,return_rate', sort: '按 product 字母顺序排列' },
}

/**
 * Output path of a table case, relative to the project root.
 * @param {string} variant
 * @param {string} month
 */
export function tableOutput(variant, month) {
  return variant === 'summary' ? `reports/summary-${month}.json` : `reports/${variant}-${month}.csv`
}

/**
 * One table task: user message, materials and the hidden expectations.
 * @param {{ id: string, set: import('./cases.mjs').CaseSet, variant: typeof TABLE_VARIANTS[number], month: string }} spec
 * @returns {import('./cases.mjs').TaskCase}
 */
export function tableCase({ id, set, variant, month }) {
  const orders = ordersCsv(month)
  // The data sits in the project's work tree (`data/`), so the task's snapshot, the gate's
  // replays and an arm copy all carry it.
  /** @type {Record<string, string>} */
  const files = { [`data/orders-${month}.csv`]: orders }
  if (variant === 'returns') files[`data/returns-${month}.csv`] = returnsCsv(month)
  const output = tableOutput(variant, month)
  let message
  if (variant === 'summary') {
    message = `请根据 data/orders-${month}.csv 做 ${month} 的月度汇总，保存为 ${output}。JSON 字段：month、orders（订单数）、units（件数）、revenue（收入，数量×单价×(1−折扣)，保留两位小数）、byRegion（各地区收入）、topProduct（件数最多的商品，并列取名字靠前的）。`
  } else {
    const text = VARIANT_TEXT[variant]
    const extra = variant === 'returns'
      ? `退货记录在 data/returns-${month}.csv（一行一个退货的订单）；returned_orders 是退货订单数，return_rate 是退货订单占订单数的百分比，保留一位小数；revenue 不扣退货。`
      : ''
    message = `请根据 data/orders-${month}.csv 做 ${month} 的${text.what}，保存为 ${output}：${text.rows}，列为 ${text.columns}，${text.sort}。revenue = 数量×单价×(1−折扣)，保留两位小数。${extra}`
  }
  const firstRow = orders.split('\n')[1]
  return {
    id,
    family: 'tables',
    set,
    variant,
    seed: month,
    message,
    files,
    materials: [],
    outputs: [output],
    fingerprints: [message, firstRow, `${month.replace('-', '')}-001`],
    hidden: { kind: 'table', variant, month, output },
  }
}

const close = (/** @type {number} */ a, /** @type {number} */ b, tolerance = 0.005) => Number.isFinite(a) && Math.abs(a - b) < tolerance

/**
 * Hidden judge of a grouped table's text.
 * @param {'region' | 'category' | 'returns'} variant
 * @param {string} month
 * @param {string | null | undefined} text
 * @returns {import('./cases.mjs').JudgeResult}
 */
export function judgeTableText(variant, month, text) {
  /** @type {import('./cases.mjs').Issue[]} */
  const issues = []
  if (typeof text !== 'string' || text.trim() === '') {
    issues.push({ kind: 'missing-output', detail: tableOutput(variant, month) })
    return finish(issues)
  }
  const lines = text.split(/\r?\n/).filter(line => line.trim() !== '')
  const header = lines[0].split(',').map(cell => cell.trim())
  const at = (/** @type {string} */ name) => header.indexOf(name)
  const { key, columns, rows } = expectedTable(variant, month)
  for (const column of columns) if (at(column) < 0) issues.push({ kind: 'missing-column', detail: column })
  if (issues.length > 0) return finish(issues)
  const got = lines.slice(1).map(line => line.split(',').map(cell => cell.trim()))
  const keys = got.map(cells => cells[at(key)])
  if (keys.join() !== rows.map(row => row[key]).join()) {
    issues.push({ kind: 'wrong-rows', detail: `${keys.join('/') || 'none'}, expected ${rows.map(row => row[key]).join('/')}` })
  }
  for (const row of rows) {
    const cells = got.find(c => c[at(key)] === row[key])
    if (cells === undefined) continue
    for (const column of columns) {
      if (column === key) continue
      const tolerance = column === 'return_rate' ? 0.05 + 1e-9 : 0.005
      if (!close(Number(cells[at(column)]), Number(row[column]), tolerance)) {
        issues.push({ kind: 'wrong-value', detail: `${row[key]} ${column} ${cells[at(column)]}, expected ${row[column]}` })
      }
    }
  }
  if (at(CONVENTION_COLUMN) < 0) {
    issues.push({ kind: 'convention-column', detail: CONVENTION_COLUMN })
  } else {
    for (const row of rows) {
      const cells = got.find(c => c[at(key)] === row[key])
      if (cells !== undefined && !close(Number(cells[at(CONVENTION_COLUMN)]), Number(row[CONVENTION_COLUMN]))) {
        issues.push({ kind: 'convention-value', detail: `${row[key]} ${CONVENTION_COLUMN} ${cells[at(CONVENTION_COLUMN)]}, expected ${row[CONVENTION_COLUMN]}` })
      }
    }
  }
  return finish(issues)
}

/**
 * Hidden judge of the JSON month summary (guard variant).
 * @param {string} month
 * @param {string | null | undefined} text
 * @returns {import('./cases.mjs').JudgeResult}
 */
export function judgeSummaryText(month, text) {
  /** @type {import('./cases.mjs').Issue[]} */
  const issues = []
  if (typeof text !== 'string' || text.trim() === '') {
    issues.push({ kind: 'missing-output', detail: tableOutput('summary', month) })
    return finish(issues)
  }
  let got
  try {
    got = JSON.parse(text)
  } catch {
    issues.push({ kind: 'invalid-output', detail: 'not JSON' })
    return finish(issues)
  }
  const want = expectedSummary(month)
  for (const field of /** @type {const} */ (['month', 'orders', 'units', 'topProduct'])) {
    if (got?.[field] !== want[field]) issues.push({ kind: 'wrong-value', detail: `${field} ${JSON.stringify(got?.[field])}, expected ${JSON.stringify(want[field])}` })
  }
  if (!close(got?.revenue, want.revenue)) issues.push({ kind: 'wrong-value', detail: `revenue ${JSON.stringify(got?.revenue)}, expected ${want.revenue}` })
  const regions = Object.keys(want.byRegion)
  if (Object.keys(got?.byRegion ?? {}).sort().join() !== regions.join()) issues.push({ kind: 'wrong-rows', detail: `byRegion keys, expected ${regions.join('/')}` })
  for (const region of regions) {
    if (!close(got?.byRegion?.[region], want.byRegion[region])) issues.push({ kind: 'wrong-value', detail: `byRegion.${region} ${JSON.stringify(got?.byRegion?.[region])}, expected ${want.byRegion[region]}` })
  }
  return finish(issues)
}

/**
 * Judge a table case in a project directory (reads the case's output file).
 * @param {import('./cases.mjs').TaskCase} task
 * @param {string} projectDir
 * @returns {Promise<import('./cases.mjs').JudgeResult>}
 */
export async function judgeTableCase(task, projectDir) {
  const hidden = /** @type {{ variant: string, month: string, output: string }} */ (task.hidden)
  let text = null
  try {
    text = await readFile(join(projectDir, hidden.output), 'utf8')
  } catch {
    text = null
  }
  return hidden.variant === 'summary'
    ? judgeSummaryText(hidden.month, text)
    : judgeTableText(/** @type {'region' | 'category' | 'returns'} */ (hidden.variant), hidden.month, text)
}

/**
 * @param {import('./cases.mjs').Issue[]} issues
 * @returns {import('./cases.mjs').JudgeResult}
 */
function finish(issues) {
  return { pass: issues.length === 0, issues, problems: issues.map(issue => `${issue.kind}: ${issue.detail}`) }
}
