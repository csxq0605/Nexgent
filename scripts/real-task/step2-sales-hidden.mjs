/**
 * Hidden check of the step-2 real task (never shown to the model): computes
 * the expected summary from the original orders.csv on its own and checks
 * the project the model left behind.
 *
 * Contract the task text gives the model:
 * - `data/orders.csv` is an unchanged copy of the material;
 * - `node scripts/build-report.mjs`, run from the project root, writes
 *   `report/summary.csv` with header `region,month,sales,mom_growth`
 *   (region = Chinese name from regions.xlsx, month = YYYY-MM, sales with
 *   two decimals, mom_growth = growth over the same region's previous month,
 *   empty for the first month);
 * - `report/README.md` explains the cleaning rules, including duplicates.
 * Cleaning rules: a repeated order id keeps its first line; an order with an
 * empty region is dropped; region codes are trimmed and lower-cased; amounts
 * lose their thousands separators.
 */
import { spawnSync } from 'node:child_process'
import { cp, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MONTHS, REGIONS } from './step2-sales/generate.mjs'

export const SCRIPT_PATH = 'scripts/build-report.mjs'
export const SUMMARY_PATH = 'report/summary.csv'
export const README_PATH = 'report/README.md'
export const DATA_PATH = 'data/orders.csv'
export const HEADER = ['region', 'month', 'sales', 'mom_growth']

/** RFC 4180-ish CSV parsing (quotes, doubled quotes). */
export function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"'
        i += 1
      } else if (ch === '"') quoted = false
      else field += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else field += ch
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter(r => !(r.length === 1 && r[0] === ''))
}

/** The expected summary rows `{ region, month, sales, growth }` (growth `null` for the first month). */
export function expectedSummary(ordersText) {
  const [, ...lines] = parseCsv(ordersText)
  const seen = new Set()
  const totals = new Map()
  for (const [id, date, region, amount] of lines) {
    if (seen.has(id)) continue
    seen.add(id)
    const code = String(region ?? '').trim().toLowerCase()
    if (code === '') continue
    const name = REGIONS[code]
    if (name === undefined) throw new Error(`unknown region code ${JSON.stringify(region)}`)
    const key = `${name}|${date.slice(0, 7)}`
    totals.set(key, (totals.get(key) ?? 0) + Number(String(amount).replace(/,/g, '')))
  }
  const rows = []
  for (const name of Object.values(REGIONS)) {
    let previous
    for (const month of MONTHS) {
      const sales = Math.round((totals.get(`${name}|${month}`) ?? 0) * 100) / 100
      rows.push({ region: name, month, sales, growth: previous === undefined ? null : (sales - previous) / previous })
      previous = sales
    }
  }
  return rows
}

/** A growth cell: ratio (0.1234), percent with sign (12.34%), or empty. */
function growthMatches(cell, expected) {
  const text = String(cell ?? '').trim()
  if (expected === null) return text === '' || text === '-' || text.toLowerCase() === 'n/a' || text.toLowerCase() === 'null'
  if (text.endsWith('%')) return Math.abs(Number(text.slice(0, -1)) - expected * 100) <= 0.06
  const value = Number(text)
  return text !== '' && Number.isFinite(value) && (Math.abs(value - expected) <= 0.0006 || Math.abs(value - expected * 100) <= 0.06)
}

/** Check a summary.csv text against the expected rows. Returns `[ok, description]` pairs. */
export function checkSummary(text, expected) {
  const rows = parseCsv(text ?? '')
  const header = (rows[0] ?? []).map(cell => cell.trim().toLowerCase())
  const col = Object.fromEntries(HEADER.map(name => [name, header.indexOf(name)]))
  const body = rows.slice(1)
  const byKey = new Map(body.map(row => [`${String(row[col.region] ?? '').trim()}|${String(row[col.month] ?? '').trim()}`, row]))
  const missing = expected.filter(e => !byKey.has(`${e.region}|${e.month}`))
  const wrongSales = expected.filter(e => byKey.has(`${e.region}|${e.month}`) && !(Math.abs(Number(byKey.get(`${e.region}|${e.month}`)[col.sales]) - e.sales) <= 0.01))
  const wrongGrowth = expected.filter(e => byKey.has(`${e.region}|${e.month}`) && !growthMatches(byKey.get(`${e.region}|${e.month}`)[col.mom_growth], e.growth))
  const show = list => list.slice(0, 3).map(e => `${e.region} ${e.month}`).join(', ')
  return [
    [HEADER.every(name => col[name] >= 0), `header has ${HEADER.join(', ')} (got ${JSON.stringify(rows[0] ?? [])})`],
    [body.length === expected.length && byKey.size === expected.length, `${expected.length} rows, one per region and month (got ${body.length})`],
    [missing.length === 0, `every region (Chinese name) × month present (missing ${show(missing)})`],
    [wrongSales.length === 0, `sales within 0.01 (wrong ${show(wrongSales)})`],
    [wrongGrowth.length === 0, `mom_growth matches (wrong ${show(wrongGrowth)})`],
  ]
}

/** README must explain the cleaning rules and the duplicate handling. */
export function checkReadme(text) {
  const t = String(text ?? '')
  return [
    [/重复/.test(t) && /(订单号|订单)/.test(t), 'README explains repeated orders'],
    [/空/.test(t) && /地区/.test(t), 'README explains empty regions'],
    [/(千分位|逗号|千位)/.test(t), 'README explains the thousands separators'],
  ]
}

async function copyForRerun(root, dest) {
  for (const name of await readdir(root)) {
    if (name === '.nexgent' || name === 'report' || name === 'node_modules') continue
    await cp(join(root, name), join(dest, name), { recursive: true })
  }
}

/**
 * Check the project the model left behind.
 * @param root - the project directory.
 * @param ordersPath - the original orders.csv.
 * @returns `{ checks: Array<{ name, ok }> , expected }`.
 */
export async function checkSalesProject(root, ordersPath) {
  const ordersText = await readFile(ordersPath, 'utf8')
  const expected = expectedSummary(ordersText)
  const read = path => readFile(join(root, ...path.split('/')), 'utf8').catch(() => null)
  const checks = []
  const add = pairs => pairs.forEach(([ok, name]) => checks.push({ name, ok: Boolean(ok) }))

  const summary = await read(SUMMARY_PATH)
  add([[summary !== null, `${SUMMARY_PATH} exists`]])
  add(checkSummary(summary, expected))
  add([[(await read(DATA_PATH)) === ordersText, `${DATA_PATH} is an unchanged copy of the material`]])
  add(checkReadme(await read(README_PATH)))

  // Re-run the script in a fresh copy: same summary.
  const fresh = await mkdtemp(join(tmpdir(), 'step2-sales-rerun-'))
  try {
    await copyForRerun(root, fresh)
    const run = spawnSync(process.execPath, [SCRIPT_PATH], { cwd: fresh, encoding: 'utf8', timeout: 60_000, env: { PATH: process.env.PATH ?? '' } })
    const again = await readFile(join(fresh, 'report', 'summary.csv'), 'utf8').catch(() => null)
    add([
      [run.status === 0, `node ${SCRIPT_PATH} exits 0 in a fresh copy (got ${run.status}; ${String(run.stderr ?? '').slice(0, 160)})`],
      [again !== null && again === summary, 'the fresh run writes the same summary.csv'],
    ])
  } finally {
    await rm(fresh, { recursive: true, force: true })
  }
  return { checks, expected }
}
