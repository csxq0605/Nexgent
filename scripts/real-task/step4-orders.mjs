/**
 * Step-4 task family (docs/plan/step-4-work-partition.md §真实模型验收): monthly
 * order CSVs of one shop, generated deterministically, and the hidden judge
 * of the monthly summary every task in the family produces.
 *
 * The same files serve the scripted layers (replay fixture, good and bad
 * candidates: step4-fixtures.mjs) and the real-model layer. The judge
 * computes the expected values from the CSV on its own; it shares no code
 * with the candidate components or the verify script it is used to test.
 *
 * Linux, macOS and Windows; no dependencies.
 */

export const COLUMNS = ['order_id', 'date', 'region', 'product', 'quantity', 'unit_price', 'discount']
export const REGIONS = ['East', 'North', 'South', 'West']
export const PRODUCTS = [
  { name: 'Desk', price: 189.5 },
  { name: 'Chair', price: 74.25 },
  { name: 'Lamp', price: 23.9 },
  { name: 'Shelf', price: 112 },
  { name: 'Mat', price: 15.75 },
]
const DISCOUNTS = [0, 0, 0, 0.05, 0.1]

/** History months (replay set), task A's month and task B's month. */
export const MONTHS = { history: ['2026-06', '2026-07', '2026-08'], taskA: '2026-09', taskB: '2026-10' }

/** Seeded PRNG (mulberry32), seeded from the month text, so every platform gets the same rows. */
function rng(seedText) {
  let seed = 0
  for (const char of seedText) seed = (Math.imul(seed, 31) + char.charCodeAt(0)) >>> 0
  return () => {
    seed = (seed + 0x6D2B79F5) >>> 0
    let t = seed
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * The order CSV of one month (`YYYY-MM`): 24–35 orders, `\n` line ends, a header row.
 * At least one order has a discount, so a summary that ignores discounts is always wrong.
 */
export function ordersCsv(month) {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error(`ordersCsv: month must be YYYY-MM (got ${month})`)
  const next = rng(month)
  const pick = list => list[Math.floor(next() * list.length)]
  const count = 24 + Math.floor(next() * 12)
  const rows = [COLUMNS.join(',')]
  for (let i = 1; i <= count; i += 1) {
    const product = pick(PRODUCTS)
    const day = String(1 + Math.floor(next() * 28)).padStart(2, '0')
    const discount = i === 3 ? 0.1 : pick(DISCOUNTS)
    rows.push([`${month.replace('-', '')}-${String(i).padStart(3, '0')}`, `${month}-${day}`, pick(REGIONS), product.name, 1 + Math.floor(next() * 9), product.price, discount].join(','))
  }
  return `${rows.join('\n')}\n`
}

const cents = value => Math.round(value * 100) / 100

/** Parse an order CSV into rows; throws on a header or a row that does not match {@link COLUMNS}. */
export function parseOrders(csvText) {
  const lines = csvText.split(/\r?\n/).filter(line => line.trim() !== '')
  if (lines[0] !== COLUMNS.join(',')) throw new Error(`unexpected header: ${lines[0]}`)
  return lines.slice(1).map((line, index) => {
    const cells = line.split(',')
    if (cells.length !== COLUMNS.length) throw new Error(`row ${index + 2}: expected ${COLUMNS.length} cells, got ${cells.length}`)
    const [orderId, date, region, product, quantity, unitPrice, discount] = cells
    return { orderId, date, region, product, quantity: Number(quantity), unitPrice: Number(unitPrice), discount: Number(discount) }
  })
}

/**
 * The expected monthly summary: `{ month, orders, units, revenue, byRegion, topProduct }`.
 * Revenue is quantity × unit price × (1 − discount), summed and rounded to cents;
 * `byRegion` has every region that has orders; `topProduct` sells the most units (ties: name order).
 */
export function expectedSummary(csvText) {
  const rows = parseOrders(csvText)
  const byRegion = {}
  const units = {}
  let revenue = 0
  for (const row of rows) {
    const amount = row.quantity * row.unitPrice * (1 - row.discount)
    revenue += amount
    byRegion[row.region] = (byRegion[row.region] ?? 0) + amount
    units[row.product] = (units[row.product] ?? 0) + row.quantity
  }
  const topProduct = Object.keys(units).sort((a, b) => units[b] - units[a] || a.localeCompare(b))[0] ?? null
  return {
    month: rows[0]?.date.slice(0, 7) ?? null,
    orders: rows.length,
    units: Object.values(units).reduce((sum, value) => sum + value, 0),
    revenue: cents(revenue),
    byRegion: Object.fromEntries(Object.keys(byRegion).sort().map(region => [region, cents(byRegion[region])])),
    topProduct,
  }
}

/** The expected region table (guard task): `region,orders,revenue` rows sorted by region. */
export function expectedRegionsCsv(csvText) {
  const rows = parseOrders(csvText)
  const table = {}
  for (const row of rows) {
    const entry = table[row.region] ?? (table[row.region] = { orders: 0, revenue: 0 })
    entry.orders += 1
    entry.revenue += row.quantity * row.unitPrice * (1 - row.discount)
  }
  const lines = ['region,orders,revenue', ...Object.keys(table).sort().map(region => `${region},${table[region].orders},${cents(table[region].revenue).toFixed(2)}`)]
  return `${lines.join('\n')}\n`
}

const close = (a, b) => typeof a === 'number' && Math.abs(a - b) < 0.005

/**
 * Hidden check of a summary JSON against the order CSV it was made from.
 * @returns `{ pass, problems }`; a file that is not JSON fails with one problem.
 */
export function judgeSummary(csvText, summaryText) {
  const expected = expectedSummary(csvText)
  let got
  try {
    got = JSON.parse(summaryText)
  } catch (error) {
    return { pass: false, problems: [`summary is not JSON (${error instanceof Error ? error.message : String(error)})`] }
  }
  const problems = []
  if (got?.month !== expected.month) problems.push(`month ${JSON.stringify(got?.month)}, expected ${expected.month}`)
  if (got?.orders !== expected.orders) problems.push(`orders ${JSON.stringify(got?.orders)}, expected ${expected.orders}`)
  if (got?.units !== expected.units) problems.push(`units ${JSON.stringify(got?.units)}, expected ${expected.units}`)
  if (!close(got?.revenue, expected.revenue)) problems.push(`revenue ${JSON.stringify(got?.revenue)}, expected ${expected.revenue}`)
  const regions = Object.keys(expected.byRegion)
  const gotRegions = Object.keys(got?.byRegion ?? {}).sort()
  if (gotRegions.join() !== regions.join()) problems.push(`regions ${gotRegions.join('/') || 'none'}, expected ${regions.join('/')}`)
  for (const region of regions) {
    if (!close(got?.byRegion?.[region], expected.byRegion[region])) problems.push(`${region} revenue ${JSON.stringify(got?.byRegion?.[region])}, expected ${expected.byRegion[region]}`)
  }
  if (got?.topProduct !== expected.topProduct) problems.push(`topProduct ${JSON.stringify(got?.topProduct)}, expected ${expected.topProduct}`)
  return { pass: problems.length === 0, problems }
}
