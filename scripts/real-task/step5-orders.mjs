/**
 * Step-5 task family (docs/plan/step-5-work-partition.md §真实模型验收, §W5):
 * the shop's monthly region table, where the user's convention includes one
 * column the task never asks for. Only feedback names it, so a later task gets
 * it right only when something learned from the feedback is used.
 *
 *   base table      region,orders,revenue — what the task asks for, rows sorted by region
 *   convention      a fourth column avg_order_value = revenue / orders, rounded to cents
 *   feedback        three differently worded counted feedbacks naming the missing column, and
 *                   two that do not count (rating 4–5): user decision 2 (2026-10-13), counted =
 *                   rating ≤ 3, or a comment without a rating
 *
 * The order CSVs are step 4's (`ordersCsv`), so the same months mean the same
 * rows. The hidden judge computes the expected table from the CSV on its own
 * and shares no code with the components or the project's check script.
 * The task asks and the feedback never mention capability tools (R01, R02).
 *
 * Linux, macOS and Windows; no dependencies.
 */
import { parseOrders } from './step4-orders.mjs'

export { ordersCsv } from './step4-orders.mjs'

/** The column only the feedback names. */
export const CONVENTION_COLUMN = 'avg_order_value'

/** History months (replay set), the feedback task's month, the next task's month, the second job's month. */
export const MONTHS = { history: ['2026-06', '2026-07', '2026-08'], feedback: '2026-09', next: '2026-10', second: '2026-11' }

const cents = value => Math.round(value * 100) / 100

/** Per-region orders and revenue (quantity × unit price × (1 − discount)), regions sorted. */
function regionTotals(csvText) {
  const table = {}
  for (const row of parseOrders(csvText)) {
    const entry = table[row.region] ?? (table[row.region] = { orders: 0, revenue: 0 })
    entry.orders += 1
    entry.revenue += row.quantity * row.unitPrice * (1 - row.discount)
  }
  return Object.keys(table).sort().map(region => ({ region, orders: table[region].orders, revenue: cents(table[region].revenue) }))
}

/**
 * The region table: `region,orders,revenue` and, with `withAverage`, `avg_order_value`
 * (the table the user actually wants). Money to two decimals, `\n` line ends.
 */
export function regionTable(csvText, { withAverage }) {
  const header = ['region', 'orders', 'revenue', ...(withAverage ? [CONVENTION_COLUMN] : [])]
  const rows = regionTotals(csvText).map(({ region, orders, revenue }) => [
    region, orders, revenue.toFixed(2), ...(withAverage ? [cents(revenue / orders).toFixed(2)] : []),
  ])
  return `${[header, ...rows].map(cells => cells.join(',')).join('\n')}\n`
}

const close = (a, b) => Number.isFinite(a) && Math.abs(a - b) < 0.005

/**
 * Hidden check of a region table against the CSV it was made from: the three asked
 * columns must be right and the convention column present and right.
 * @returns `{ pass, problems, missingConvention }`; `missingConvention` is true exactly
 *   when the only thing wrong is the absent column (the problem the feedback names).
 */
export function judgeRegionTable(csvText, tableText) {
  if (typeof tableText !== 'string' || tableText.trim() === '') return { pass: false, problems: ['the region table is empty or missing'], missingConvention: false }
  const lines = tableText.split(/\r?\n/).filter(line => line.trim() !== '')
  const header = lines[0].split(',').map(cell => cell.trim())
  const at = name => header.indexOf(name)
  const problems = []
  for (const name of ['region', 'orders', 'revenue']) if (at(name) < 0) problems.push(`column ${name} is missing`)
  if (problems.length > 0) return { pass: false, problems, missingConvention: false }
  const want = regionTotals(csvText)
  const got = lines.slice(1).map(line => line.split(',').map(cell => cell.trim()))
  const regions = got.map(cells => cells[at('region')])
  if (regions.join() !== want.map(row => row.region).join()) problems.push(`regions ${regions.join('/') || 'none'}, expected ${want.map(row => row.region).join('/')} in that order`)
  for (const row of want) {
    const cells = got.find(c => c[at('region')] === row.region)
    if (cells === undefined) continue
    if (Number(cells[at('orders')]) !== row.orders) problems.push(`${row.region} orders ${cells[at('orders')]}, expected ${row.orders}`)
    if (!close(Number(cells[at('revenue')]), row.revenue)) problems.push(`${row.region} revenue ${cells[at('revenue')]}, expected ${row.revenue.toFixed(2)}`)
  }
  const baseRight = problems.length === 0
  if (at(CONVENTION_COLUMN) < 0) {
    problems.push(`column ${CONVENTION_COLUMN} is missing`)
  } else {
    for (const row of want) {
      const cells = got.find(c => c[at('region')] === row.region)
      if (cells !== undefined && !close(Number(cells[at(CONVENTION_COLUMN)]), cents(row.revenue / row.orders))) problems.push(`${row.region} ${CONVENTION_COLUMN} ${cells[at(CONVENTION_COLUMN)]}, expected ${cents(row.revenue / row.orders).toFixed(2)}`)
    }
  }
  return { pass: problems.length === 0, problems, missingConvention: baseRight && problems.length === 1 && at(CONVENTION_COLUMN) < 0 }
}

/**
 * Whether a feedback entry counts toward the improvement threshold (user decision 2,
 * 2026-10-13): a rating of 3 or less, or a comment without a rating. The test-side
 * oracle the judges compare `@nexgent/evolve`'s counter against.
 */
export function countsTowardImprovement(entry) {
  if (entry?.rating !== undefined) return entry.rating <= 3
  return typeof entry?.comment === 'string' && entry.comment.trim() !== ''
}

/** The threshold N (plan 4.9 #7). */
export const THRESHOLD = 3

/**
 * Feedback on the feedback task's region table, in submission order. The three counted
 * ones name the same problem in different words; the other two do not count.
 */
export const FEEDBACK = [
  { key: 'praise', rating: 5, comment: '格式很清楚，谢谢。' },
  { key: 'first', rating: 2, comment: '地区表少了一列：每个地区的平均客单价（总收入除以订单数，保留两位小数）。' },
  { key: 'second', comment: '我们的地区表一直都要带平均客单价那一列，这次又没有。' },
  { key: 'fine', rating: 4, comment: '数字对上了。' },
  { key: 'third', rating: 3, comment: '还是缺 avg_order_value，以后每个月的地区表都要有这一列。' },
]

/**
 * The column the second family of feedback names (R07): each region's share of the month's
 * revenue, in percent to one decimal. Another column, not a new row order, so the table the
 * task asks for (sorted by region) and the project's check stay right.
 */
export const SECOND_COLUMN = 'revenue_share'

/** A second family of feedback for R07 (a different problem: the revenue share column is missing). */
export const SECOND_FEEDBACK = [
  { key: 'first', rating: 2, comment: '地区表还要一列收入占比：每个地区收入占当月总收入的百分比，保留一位小数。' },
  { key: 'second', comment: '收入占比那一列还是没有，我们每个月都要看这个。' },
  { key: 'third', rating: 3, comment: '请以后的地区表都加上 revenue_share 列（百分比，一位小数）。' },
]
