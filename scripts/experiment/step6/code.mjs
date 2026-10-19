// @ts-check
/**
 * Step-6 task family "multi-file code" (docs/plan/step-6-work-partition.md §测量):
 * a small invoicing library (6 modules + visible tests) generated from a seed,
 * plus hidden tests the project never sees. Variants:
 *
 *   bugfix     an invoice comes out wrong; the cause sits in another module
 *              (discount threshold `>` for `>=`, tax on the undiscounted amount,
 *              tax floored instead of rounded)
 *   feature    a feature across three files (shipping fee, or bulk-line discount)
 *   refactor   behaviour unchanged: move the duplicated "rate of an amount, rounded
 *              to cents" into money.js (percentOfCents), or move the tax-rate table
 *              out of tax.js into a new regions.js (regions)
 *
 * The user's conventions, named only by feedback:
 *   - every changed or added module under src/ (index.js aside) gets a matching
 *     test/<module>.test.js that is new or changed and imports it;
 *   - amounts stay integer cents (a hidden test tagged [cents]).
 *
 * The hidden judge runs its own tests (expected values from the reference model
 * here, not from the project's code) in a temporary copy, so nothing hidden is
 * ever written into the project.
 *
 * Linux, macOS and Windows; needs only Node.
 */
import { spawn } from 'node:child_process'
import { cp, mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { picker } from './rng.mjs'

export const CODE_VARIANTS = /** @type {const} */ (['bugfix', 'feature', 'refactor'])
export const BUG_KINDS = /** @type {const} */ (['threshold', 'tax-base', 'tax-rounding'])
export const FEATURE_KINDS = /** @type {const} */ (['shipping', 'bulk'])
export const REFACTOR_KINDS = /** @type {const} */ (['percentOfCents', 'regions'])

const WORDS = ['kestrel', 'juniper', 'harbor', 'quartz', 'meadow', 'falcon', 'cobalt', 'willow', 'ember', 'tundra', 'saffron', 'larch']
const PRODUCT_NAMES = ['Desk lamp', 'Notebook', 'Stapler', 'Monitor arm', 'Cable tray', 'Chair mat', 'Whiteboard', 'Paper tray', 'Webcam', 'Footrest']
const REGIONS = ['north', 'south', 'east', 'west', 'central']

/**
 * @typedef {{ sku: string, name: string, priceCents: number }} Product
 * @typedef {{ sku: string, quantity: number }} Line
 * @typedef {{
 *   seed: number, dir: string, products: Product[], thresholdCents: number, discountPercent: number,
 *   taxBp: Record<string, number>, regions: string[],
 *   bug: typeof BUG_KINDS[number], feature: typeof FEATURE_KINDS[number],
 *   ship: { freeCents: number, baseCents: Record<string, number>, perItemCents: number },
 *   bulk: { quantity: number, percent: number },
 *   refactor: typeof REFACTOR_KINDS[number],
 * }} CodeParams
 */

/**
 * All parameters of one generated project, from its seed.
 * @param {number} seed
 * @returns {CodeParams}
 */
export function codeParams(seed) {
  const { int, pick, shuffle } = picker(`code:${seed}`)
  const thresholdCents = pick([5000, 8000, 10000, 12000])
  const prefix = String.fromCharCode(65 + int(0, 25)) + String.fromCharCode(65 + int(0, 25))
  const names = shuffle(PRODUCT_NAMES).slice(0, 5)
  const skus = new Set()
  const products = names.map((name, index) => {
    let sku
    do sku = `${prefix}-${int(100, 999)}`
    while (skus.has(sku))
    skus.add(sku)
    // Product 0 costs exactly a fifth of the discount threshold, so 5 of it hit the threshold.
    return { sku, name, priceCents: index === 0 ? thresholdCents / 5 : int(150, 4999) }
  })
  const regions = shuffle(REGIONS).slice(0, 3).sort()
  const taxBp = Object.fromEntries(regions.map(region => [region, pick([500, 625, 725, 800, 875, 1000])]))
  return {
    seed,
    dir: `${pick(WORDS)}-billing-${seed}`,
    products,
    thresholdCents,
    discountPercent: pick([5, 8, 10, 15]),
    taxBp,
    regions,
    bug: pick(BUG_KINDS),
    feature: pick(FEATURE_KINDS),
    ship: {
      freeCents: thresholdCents + pick([0, 2000, 5000]),
      baseCents: Object.fromEntries(regions.map(region => [region, pick([450, 600, 650, 800, 990])])),
      perItemCents: pick([50, 75, 100, 120]),
    },
    bulk: { quantity: pick([5, 6, 8, 10]), percent: pick([5, 10, 12]) },
    refactor: pick(REFACTOR_KINDS),
  }
}

// ---------------------------------------------------------------------------
// Reference model (the hidden tests' expectations come from here only)

/**
 * @param {CodeParams} p
 * @param {Line[]} lines
 * @param {string} region
 * @param {{ feature?: typeof FEATURE_KINDS[number] | null, bug?: typeof BUG_KINDS[number] | null }} [mode]
 */
export function referenceInvoice(p, lines, region, { feature = null, bug = null } = {}) {
  const price = (/** @type {string} */ sku) => /** @type {Product} */ (p.products.find(product => product.sku === sku)).priceCents
  let bulkSavings = 0
  const lineTotal = (/** @type {Line} */ line) => {
    const full = price(line.sku) * line.quantity
    if (feature !== 'bulk' || line.quantity < p.bulk.quantity) return full
    const reduced = Math.round(full * (100 - p.bulk.percent) / 100)
    bulkSavings += full - reduced
    return reduced
  }
  const subtotal = lines.reduce((sum, line) => sum + lineTotal(line), 0)
  const qualifies = bug === 'threshold' ? subtotal > p.thresholdCents : subtotal >= p.thresholdCents
  const discount = qualifies ? Math.round(subtotal * p.discountPercent / 100) : 0
  const taxable = subtotal - discount
  const base = bug === 'tax-base' ? subtotal : taxable
  const tax = bug === 'tax-rounding' ? Math.floor(base * p.taxBp[region] / 10000) : Math.round(base * p.taxBp[region] / 10000)
  /** @type {Record<string, number>} */
  const invoice = { subtotal, discount, tax, total: taxable + tax }
  if (feature === 'shipping') {
    const items = lines.reduce((sum, line) => sum + line.quantity, 0)
    invoice.shipping = taxable >= p.ship.freeCents ? 0 : p.ship.baseCents[region] + p.ship.perItemCents * items
    invoice.total += invoice.shipping
  }
  if (feature === 'bulk') invoice.bulkSavings = bulkSavings
  return invoice
}

const yuan = (/** @type {number} */ cents) => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`

// ---------------------------------------------------------------------------
// Project sources

/**
 * @typedef {{ bug?: typeof BUG_KINDS[number] | null, feature?: typeof FEATURE_KINDS[number] | null, refactor?: typeof REFACTOR_KINDS[number] | null }} SourceMode
 */

/**
 * The project's files (paths relative to the project directory `p.dir`).
 * @param {CodeParams} p
 * @param {SourceMode} mode
 * @returns {Record<string, string>}
 */
export function renderProject(p, mode = {}) {
  const { bug = null, feature = null, refactor = null } = mode
  const percent = refactor === 'percentOfCents'
  /** @type {Record<string, string>} */
  const files = {}
  files['package.json'] = `${JSON.stringify({ name: p.dir, version: '0.1.0', private: true, type: 'module', description: 'Invoices for a small office-supply shop: cart, discount, tax.', scripts: { test: 'node --test' } }, null, 2)}\n`
  files['README.md'] = `# ${p.dir}\n\nInvoices for a small office-supply shop.\n\n- \`src/catalog.js\` products and prices\n- \`src/cart.js\` line totals and subtotal\n- \`src/discount.js\` order discount above a threshold\n- \`src/tax.js\` regional tax\n- \`src/invoice.js\` puts it together\n\nRun the tests with \`npm test\` (or \`node --test\`).\n`
  files['src/money.js'] = [
    'export function formatCents(cents) {',
    "  const sign = cents < 0 ? '-' : ''",
    '  const abs = Math.abs(cents)',
    "  return sign + Math.floor(abs / 100) + '.' + String(abs % 100).padStart(2, '0')",
    '}',
    '',
    'export function sumCents(values) {',
    '  return values.reduce((sum, value) => sum + value, 0)',
    '}',
    ...(percent ? ['', 'export function percentOfCents(amountCents, numerator, denominator) {', '  return Math.round(amountCents * numerator / denominator)', '}'] : []),
    '',
  ].join('\n')
  files['src/catalog.js'] = [
    'export const PRODUCTS = {',
    ...p.products.map(product => `  '${product.sku}': { name: '${product.name}', priceCents: ${product.priceCents} },`),
    '}',
    '',
    'export function priceOf(sku) {',
    '  const product = PRODUCTS[sku]',
    "  if (product === undefined) throw new Error('unknown sku ' + sku)",
    '  return product.priceCents',
    '}',
    '',
  ].join('\n')
  files['src/cart.js'] = feature === 'bulk'
    ? [
      "import { priceOf } from './catalog.js'",
      "import { sumCents } from './money.js'",
      '',
      `export const BULK_QUANTITY = ${p.bulk.quantity}`,
      `export const BULK_PERCENT = ${p.bulk.percent}`,
      '',
      'function fullLineTotal(line) {',
      '  return priceOf(line.sku) * line.quantity',
      '}',
      '',
      'export function lineTotal(line) {',
      '  const full = fullLineTotal(line)',
      '  if (line.quantity < BULK_QUANTITY) return full',
      '  return Math.round(full * (100 - BULK_PERCENT) / 100)',
      '}',
      '',
      'export function subtotal(lines) {',
      '  return sumCents(lines.map(lineTotal))',
      '}',
      '',
      'export function bulkSavingsCents(lines) {',
      '  return sumCents(lines.map(line => fullLineTotal(line) - lineTotal(line)))',
      '}',
      '',
    ].join('\n')
    : [
      "import { priceOf } from './catalog.js'",
      "import { sumCents } from './money.js'",
      '',
      'export function lineTotal(line) {',
      '  return priceOf(line.sku) * line.quantity',
      '}',
      '',
      'export function subtotal(lines) {',
      '  return sumCents(lines.map(lineTotal))',
      '}',
      '',
    ].join('\n')
  files['src/discount.js'] = [
    ...(percent ? ["import { percentOfCents } from './money.js'", ''] : []),
    `export const THRESHOLD_CENTS = ${p.thresholdCents}`,
    `export const DISCOUNT_PERCENT = ${p.discountPercent}`,
    '',
    'export function discountCents(subtotalCents) {',
    `  if (subtotalCents ${bug === 'threshold' ? '>' : '>='} THRESHOLD_CENTS) {`,
    percent ? '    return percentOfCents(subtotalCents, DISCOUNT_PERCENT, 100)' : '    return Math.round(subtotalCents * DISCOUNT_PERCENT / 100)',
    '  }',
    '  return 0',
    '}',
    '',
  ].join('\n')
  files['src/tax.js'] = refactor === 'regions'
    ? [
      "import { taxRateBp } from './regions.js'",
      '',
      'export function taxCents(amountCents, region) {',
      '  return Math.round(amountCents * taxRateBp(region) / 10000)',
      '}',
      '',
    ].join('\n')
    : [
      ...(percent ? ["import { percentOfCents } from './money.js'", ''] : []),
      '// Tax rates in basis points (1/100 of a percent).',
      'export const TAX_RATES_BP = {',
      ...p.regions.map(region => `  ${region}: ${p.taxBp[region]},`),
      '}',
      '',
      'export function taxCents(amountCents, region) {',
      '  const rate = TAX_RATES_BP[region]',
      "  if (rate === undefined) throw new Error('unknown region ' + region)",
      percent ? '  return percentOfCents(amountCents, rate, 10000)' : `  return Math.${bug === 'tax-rounding' ? 'floor' : 'round'}(amountCents * rate / 10000)`,
      '}',
      '',
    ].join('\n')
  if (refactor === 'regions') {
    files['src/regions.js'] = [
      '// Tax rates in basis points (1/100 of a percent).',
      'export const TAX_RATES_BP = {',
      ...p.regions.map(region => `  ${region}: ${p.taxBp[region]},`),
      '}',
      '',
      'export const REGIONS = Object.keys(TAX_RATES_BP)',
      '',
      'export function taxRateBp(region) {',
      '  const rate = TAX_RATES_BP[region]',
      "  if (rate === undefined) throw new Error('unknown region ' + region)",
      '  return rate',
      '}',
      '',
    ].join('\n')
  }
  if (feature === 'shipping') {
    files['src/shipping.js'] = [
      "import { subtotal } from './cart.js'",
      "import { discountCents } from './discount.js'",
      '',
      `export const FREE_SHIPPING_CENTS = ${p.ship.freeCents}`,
      `export const PER_ITEM_CENTS = ${p.ship.perItemCents}`,
      'export const BASE_FEE_CENTS = {',
      ...p.regions.map(region => `  ${region}: ${p.ship.baseCents[region]},`),
      '}',
      '',
      'export function shippingCents(lines, region) {',
      '  const sub = subtotal(lines)',
      '  if (sub - discountCents(sub) >= FREE_SHIPPING_CENTS) return 0',
      '  const base = BASE_FEE_CENTS[region]',
      "  if (base === undefined) throw new Error('unknown region ' + region)",
      '  const items = lines.reduce((sum, line) => sum + line.quantity, 0)',
      '  return base + PER_ITEM_CENTS * items',
      '}',
      '',
    ].join('\n')
  }
  files['src/invoice.js'] = [
    `import { subtotal${feature === 'bulk' ? ', bulkSavingsCents' : ''} } from './cart.js'`,
    "import { discountCents } from './discount.js'",
    "import { taxCents } from './tax.js'",
    ...(feature === 'shipping' ? ["import { shippingCents } from './shipping.js'"] : []),
    '',
    'export function buildInvoice(lines, region) {',
    '  const sub = subtotal(lines)',
    '  const discount = discountCents(sub)',
    '  const taxable = sub - discount',
    `  const tax = taxCents(${bug === 'tax-base' ? 'sub' : 'taxable'}, region)`,
    ...(feature === 'shipping'
      ? ['  const shipping = shippingCents(lines, region)', '  return { subtotal: sub, discount, tax, shipping, total: taxable + tax + shipping }']
      : feature === 'bulk'
        ? ['  return { subtotal: sub, discount, tax, bulkSavings: bulkSavingsCents(lines), total: taxable + tax }']
        : ['  return { subtotal: sub, discount, tax, total: taxable + tax }']),
    '}',
    '',
  ].join('\n')
  files['src/index.js'] = [
    "export { formatCents, sumCents } from './money.js'",
    "export { PRODUCTS, priceOf } from './catalog.js'",
    `export { lineTotal, subtotal${feature === 'bulk' ? ', bulkSavingsCents' : ''} } from './cart.js'`,
    "export { discountCents } from './discount.js'",
    "export { taxCents } from './tax.js'",
    ...(feature === 'shipping' ? ["export { shippingCents } from './shipping.js'"] : []),
    "export { buildInvoice } from './invoice.js'",
    '',
  ].join('\n')
  const [a, b] = p.products
  const region = p.regions[0]
  const small = [{ sku: a.sku, quantity: 1 }, { sku: b.sku, quantity: 2 }]
  files['test/money.test.js'] = [
    "import { test } from 'node:test'",
    "import assert from 'node:assert/strict'",
    "import { formatCents, sumCents } from '../src/money.js'",
    '',
    "test('formatCents writes yuan with two decimals', () => {",
    "  assert.equal(formatCents(1205), '12.05')",
    "  assert.equal(formatCents(7), '0.07')",
    '})',
    '',
    "test('sumCents adds amounts', () => {",
    '  assert.equal(sumCents([100, 250, 5]), 355)',
    '})',
    '',
  ].join('\n')
  files['test/cart.test.js'] = [
    "import { test } from 'node:test'",
    "import assert from 'node:assert/strict'",
    "import { lineTotal, subtotal } from '../src/cart.js'",
    '',
    "test('lineTotal is price times quantity', () => {",
    `  assert.equal(lineTotal({ sku: '${b.sku}', quantity: 2 }), ${b.priceCents * 2})`,
    '})',
    '',
    "test('subtotal adds the lines', () => {",
    `  assert.equal(subtotal(${JSON.stringify(small)}), ${a.priceCents + b.priceCents * 2})`,
    '})',
    '',
  ].join('\n')
  files['test/invoice.test.js'] = [
    "import { test } from 'node:test'",
    "import assert from 'node:assert/strict'",
    "import { buildInvoice } from '../src/invoice.js'",
    '',
    "test('a small order gets no discount', () => {",
    `  const invoice = buildInvoice([{ sku: '${a.sku}', quantity: 1 }], '${region}')`,
    `  assert.equal(invoice.subtotal, ${a.priceCents})`,
    '  assert.equal(invoice.discount, 0)',
    '})',
    '',
  ].join('\n')
  return files
}

// ---------------------------------------------------------------------------
// Hidden tests

/**
 * Carts the hidden tests price: below, at and above the discount threshold, in every region.
 * @param {CodeParams} p
 * @returns {Array<{ lines: Line[], region: string }>}
 */
export function hiddenCarts(p) {
  const { int, pick } = picker(`carts:${p.seed}`)
  const [a, b, c, d] = p.products
  /** @type {Array<{ lines: Line[], region: string }>} */
  const carts = [
    { lines: [{ sku: a.sku, quantity: 1 }], region: p.regions[0] },
    { lines: [{ sku: a.sku, quantity: 5 }], region: p.regions[1] },
    { lines: [{ sku: a.sku, quantity: 6 }, { sku: b.sku, quantity: 1 }], region: p.regions[2] },
    { lines: [{ sku: b.sku, quantity: 2 }, { sku: c.sku, quantity: 3 }], region: p.regions[0] },
    { lines: [{ sku: d.sku, quantity: p.bulk.quantity }, { sku: c.sku, quantity: 1 }], region: p.regions[1] },
    { lines: [{ sku: a.sku, quantity: 12 }, { sku: d.sku, quantity: 2 }], region: p.regions[2] },
  ]
  for (let i = 0; i < 4; i += 1) {
    carts.push({ lines: [{ sku: pick(p.products).sku, quantity: int(1, 11) }, { sku: pick(p.products).sku, quantity: int(1, 4) }], region: pick(p.regions) })
  }
  return carts
}

/**
 * The example a bug report quotes: the first hidden cart the bug makes wrong.
 * @param {CodeParams} p
 */
export function bugExample(p) {
  const carts = [...hiddenCarts(p)]
  // The rounding bug needs a fractional part of at least a half; search a few more carts.
  for (let q = 1; q <= 40; q += 1) for (const product of p.products) carts.push({ lines: [{ sku: product.sku, quantity: q }], region: p.regions[q % p.regions.length] })
  for (const cart of carts) {
    const right = referenceInvoice(p, cart.lines, cart.region)
    const wrong = referenceInvoice(p, cart.lines, cart.region, { bug: p.bug })
    if (right.total !== wrong.total) return { ...cart, right, wrong }
  }
  throw new Error(`no cart shows bug ${p.bug} for seed ${p.seed}`)
}

/**
 * Hidden test file text for one case (ESM, imports the project through `../src/`).
 * @param {CodeParams} p
 * @param {typeof CODE_VARIANTS[number]} variant
 */
export function hiddenTests(p, variant) {
  const feature = variant === 'feature' ? p.feature : null
  const carts = hiddenCarts(p)
  if (variant === 'bugfix') carts.unshift(bugExample(p))
  const fields = ['subtotal', 'discount', 'tax', 'total', ...(feature === 'shipping' ? ['shipping'] : []), ...(feature === 'bulk' ? ['bulkSavings'] : [])]
  const out = [
    "import { test } from 'node:test'",
    "import assert from 'node:assert/strict'",
    '',
    "const load = path => import(new URL(path, import.meta.url).href)",
    `const pick = invoice => Object.fromEntries(${JSON.stringify(fields)}.map(field => [field, invoice?.[field]]))`,
    '',
  ]
  carts.forEach((cart, index) => {
    const want = referenceInvoice(p, cart.lines, cart.region, { feature })
    out.push(
      `test('invoice ${index + 1} (${cart.region})', async () => {`,
      "  const { buildInvoice } = await load('../src/invoice.js')",
      `  assert.deepEqual(pick(buildInvoice(${JSON.stringify(cart.lines)}, '${cart.region}')), ${JSON.stringify(Object.fromEntries(fields.map(field => [field, want[field]])))})`,
      '})',
      '',
    )
  })
  out.push(
    "test('[cents] invoice amounts are integer cents', async () => {",
    "  const { buildInvoice } = await load('../src/invoice.js')",
    `  for (const cart of ${JSON.stringify(carts.slice(0, 6).map(cart => [cart.lines, cart.region]))}) {`,
    '    const invoice = buildInvoice(cart[0], cart[1])',
    `    for (const field of ${JSON.stringify(fields)}) if (invoice[field] !== undefined) assert.ok(Number.isInteger(invoice[field]), field + ' = ' + invoice[field])`,
    '  }',
    '})',
    '',
  )
  if (feature === 'shipping') {
    const cart = carts[3]
    out.push(
      "test('shippingCents is exported from src/index.js', async () => {",
      "  const { shippingCents } = await load('../src/index.js')",
      `  assert.equal(shippingCents(${JSON.stringify(cart.lines)}, '${cart.region}'), ${referenceInvoice(p, cart.lines, cart.region, { feature }).shipping})`,
      '})',
      '',
    )
  }
  if (feature === 'bulk') {
    const cart = carts[4]
    out.push(
      "test('bulkSavingsCents is exported from src/index.js', async () => {",
      "  const { bulkSavingsCents } = await load('../src/index.js')",
      `  assert.equal(bulkSavingsCents(${JSON.stringify(cart.lines)}), ${referenceInvoice(p, cart.lines, cart.region, { feature }).bulkSavings})`,
      '})',
      '',
    )
  }
  if (variant === 'refactor' && p.refactor === 'regions') {
    out.push(
      "test('src/regions.js lists the regions and their tax rates', async () => {",
      "  const { REGIONS, taxRateBp } = await load('../src/regions.js')",
      `  assert.deepEqual([...REGIONS].sort(), ${JSON.stringify(p.regions)})`,
      ...p.regions.map(region => `  assert.equal(taxRateBp('${region}'), ${p.taxBp[region]})`),
      "  assert.throws(() => taxRateBp('nowhere'))",
      '})',
      '',
    )
  }
  if (variant === 'refactor' && p.refactor === 'percentOfCents') {
    out.push(
      "test('percentOfCents in src/money.js rounds to the nearest cent', async () => {",
      "  const { percentOfCents } = await load('../src/money.js')",
      '  assert.equal(percentOfCents(1005, 5, 100), 50)',
      '  assert.equal(percentOfCents(1010, 5, 100), 51)',
      '  assert.equal(percentOfCents(12345, 725, 10000), 895)',
      '})',
      '',
    )
  }
  return out.join('\n')
}

// ---------------------------------------------------------------------------
// Cases

/**
 * The user message of a code case.
 * @param {CodeParams} p
 * @param {typeof CODE_VARIANTS[number]} variant
 */
export function codeMessage(p, variant) {
  const tail = `改完后在 ${p.dir} 目录里运行 node --test，项目自带的测试要通过。`
  if (variant === 'bugfix') {
    const example = bugExample(p)
    const items = example.lines.map(line => `${/** @type {Product} */ (p.products.find(x => x.sku === line.sku)).name}（${line.sku}）× ${line.quantity}`).join('、')
    const rule = p.bug === 'threshold'
      ? `店里的规则是小计满 ${yuan(p.thresholdCents)} 元（含正好 ${yuan(p.thresholdCents)} 元）打 ${p.discountPercent}% 折扣`
      : p.bug === 'tax-base' ? '店里的规则是税按打折后的金额计算' : '店里的规则是税额四舍五入到分'
    return `${p.dir}/ 是我们开发票用的小库。客户反映一张发票不对：${items}，地区 ${example.region}，发票总额是 ${yuan(example.wrong.total)} 元，应该是 ${yuan(example.right.total)} 元（${rule}）。请找到原因并修好。${tail}`
  }
  if (variant === 'feature' && p.feature === 'shipping') {
    const fees = p.regions.map(region => `${region} ${yuan(p.ship.baseCents[region])} 元`).join('、')
    return `${p.dir}/ 是我们开发票用的小库。请加上运费：新建 src/shipping.js，导出 shippingCents(lines, region)；折后金额（小计减折扣）满 ${yuan(p.ship.freeCents)} 元免运费，否则运费 = 地区基础运费（${fees}）+ 每件 ${yuan(p.ship.perItemCents)} 元。buildInvoice 返回的发票加一个 shipping 字段，total 也要加上运费（运费不计税）；src/index.js 也要导出 shippingCents。${tail}`
  }
  if (variant === 'feature') {
    return `${p.dir}/ 是我们开发票用的小库。请加上大宗折扣：同一行数量达到 ${p.bulk.quantity} 件及以上时，这一行按 ${100 - p.bulk.percent}% 计价（四舍五入到分），小计、订单折扣和税都按优惠后的行金额算。cart.js 再导出 bulkSavingsCents(lines)（各行省下的钱之和），buildInvoice 返回的发票加一个 bulkSavings 字段，src/index.js 也要导出 bulkSavingsCents。${tail}`
  }
  if (p.refactor === 'regions') {
    return `${p.dir}/ 是我们开发票用的小库。请把地区数据从 tax.js 挪出来：新建 src/regions.js，税率表放在那里，并导出 REGIONS（所有地区名的数组）和 taxRateBp(region)（该地区税率的基点数，未知地区抛错）；tax.js 改用 taxRateBp，不再自己存税率表。src/index.js 导出的函数和计算结果都不变。${tail}`
  }
  return `${p.dir}/ 是我们开发票用的小库。discount.js 和 tax.js 各自写了"按比例算金额再四舍五入到分"。请把它抽成 src/money.js 里的 percentOfCents(amountCents, numerator, denominator)（结果 = amountCents × numerator ÷ denominator 四舍五入），discount.js 和 tax.js 改用它，不再自己取整；对外接口和计算结果都不变。${tail}`
}

/**
 * One code task. `files` are written under the project root before the task.
 * @param {{ id: string, set: import('./cases.mjs').CaseSet, variant: typeof CODE_VARIANTS[number], seed: number }} spec
 * @returns {import('./cases.mjs').TaskCase}
 */
export function codeCase({ id, set, variant, seed }) {
  const p = codeParams(seed)
  const original = renderProject(p, { bug: variant === 'bugfix' ? p.bug : null })
  const files = Object.fromEntries(Object.entries(original).map(([path, text]) => [`${p.dir}/${path}`, text]))
  const message = codeMessage(p, variant)
  return {
    id,
    family: 'code',
    set,
    variant,
    seed,
    message,
    files,
    materials: [],
    outputs: [`${p.dir}/src`, `${p.dir}/test`],
    fingerprints: [message, p.dir, `'${p.products[1].sku}': { name: '${p.products[1].name}', priceCents: ${p.products[1].priceCents} }`],
    hidden: { kind: 'code', variant, seed, dir: p.dir, kindDetail: variant === 'bugfix' ? p.bug : variant === 'feature' ? p.feature : p.refactor, tests: hiddenTests(p, variant) },
  }
}

/**
 * A reference answer: the project as the user wants it after the task.
 * @param {import('./cases.mjs').TaskCase} task
 * @param {{ withTests: boolean, centsAsYuan?: boolean }} options `withTests` adds the convention's test files;
 *   `centsAsYuan` (a known-bad answer) makes the new amounts yuan instead of cents
 * @returns {Record<string, string>} paths relative to the project directory
 */
export function referenceSolution(task, { withTests, centsAsYuan = false }) {
  const hidden = /** @type {CodeHidden} */ (task.hidden)
  const p = codeParams(hidden.seed)
  const mode = hidden.variant === 'feature' ? { feature: p.feature } : hidden.variant === 'refactor' ? { refactor: p.refactor } : {}
  const files = renderProject(p, mode)
  if (centsAsYuan && hidden.variant === 'feature' && p.feature === 'shipping') {
    files['src/shipping.js'] = files['src/shipping.js'].replace('return base + PER_ITEM_CENTS * items', 'return (base + PER_ITEM_CENTS * items) / 100')
  }
  if (withTests) {
    const original = renderProject(p, { bug: hidden.variant === 'bugfix' ? p.bug : null })
    for (const module of changedModules(original, files)) {
      const path = `test/${module}.test.js`
      files[path] = `${files[path] ?? "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\n"}\nimport * as subject from '../src/${module}.js'\n\ntest('${module} exports what the task asked for', () => {\n  assert.ok(Object.keys(subject).length > 0)\n})\n`
    }
  }
  return files
}

/**
 * Modules under src/ (index.js aside) that are new or changed, by name without `.js`.
 * @param {Record<string, string>} before paths relative to the project directory
 * @param {Record<string, string | undefined>} after
 */
export function changedModules(before, after) {
  return Object.keys(after)
    .filter(path => /^src\/[^/]+\.js$/.test(path) && path !== 'src/index.js' && after[path] !== before[path])
    .map(path => path.slice(4, -3))
    .sort()
}

/**
 * @typedef {{ kind: 'code', variant: typeof CODE_VARIANTS[number], seed: number, dir: string, kindDetail: string, tests: string }} CodeHidden
 */

// ---------------------------------------------------------------------------
// Judge

/**
 * Read every file under a directory as `relative path → text` (skips node_modules and dot dirs).
 * @param {string} root
 * @returns {Promise<Record<string, string>>}
 */
async function readTree(root) {
  const { readdir } = await import('node:fs/promises')
  /** @type {Record<string, string>} */
  const out = {}
  /** @param {string} rel */
  async function walk(rel) {
    let entries
    try {
      entries = await readdir(join(root, rel), { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const path = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) out[path] = await readFile(join(root, path), 'utf8')
    }
  }
  await walk('')
  return out
}

/**
 * The environment for a child `node --test`: without the parent test runner's context
 * (`NODE_TEST_CONTEXT` makes a nested runner report to its parent instead of printing TAP)
 * and without NODE_OPTIONS that could load code into the judged project.
 */
export function cleanEnv() {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  delete env.NODE_OPTIONS
  return env
}

/**
 * Run one test file with `node --test` (TAP), bounded by a timeout.
 * @param {string} cwd
 * @param {string} file
 * @param {number} timeoutMs
 * @returns {Promise<{ code: number | null, timedOut: boolean, output: string }>}
 */
function runNodeTest(cwd, file, timeoutMs) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['--test', '--test-reporter=tap', file], { cwd, env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let output = ''
    let timedOut = false
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    const timer = setTimeout(() => { timedOut = true; child.kill() }, timeoutMs)
    child.on('error', error => { clearTimeout(timer); resolve({ code: null, timedOut, output: `${output}\n${error.message}` }) })
    child.on('close', code => { clearTimeout(timer); resolve({ code, timedOut, output }) })
  })
}

/**
 * Hidden judge of a code case in a project directory.
 * `pass` is null (unknown, not a success) when the hidden tests could not be run to the end.
 * @param {import('./cases.mjs').TaskCase} task
 * @param {string} projectDir
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<import('./cases.mjs').JudgeResult>}
 */
export async function judgeCodeCase(task, projectDir, { timeoutMs = 60_000 } = {}) {
  const hidden = /** @type {CodeHidden} */ (task.hidden)
  const root = join(projectDir, hidden.dir)
  const prefix = `${hidden.dir}/`
  const original = Object.fromEntries(Object.entries(task.files).filter(([path]) => path.startsWith(prefix)).map(([path, text]) => [path.slice(prefix.length), text]))
  const now = await readTree(root)
  /** @type {import('./cases.mjs').Issue[]} */
  const issues = []
  if (Object.keys(now).filter(path => path.startsWith('src/')).length === 0) {
    issues.push({ kind: 'missing-output', detail: `${hidden.dir}/src` })
    return finish(issues)
  }
  // Convention: a changed module gets a new or changed test file that imports it.
  for (const module of changedModules(original, now)) {
    const path = `test/${module}.test.js`
    const text = now[path]
    if (text === undefined || text === original[path] || !text.includes(`${module}.js`)) issues.push({ kind: 'convention-tests', detail: module })
  }
  if (hidden.variant === 'refactor' && hidden.kindDetail === 'regions') {
    const tax = now['src/tax.js'] ?? ''
    const p = codeParams(hidden.seed)
    if (!tax.includes('regions.js')) issues.push({ kind: 'refactor-incomplete', detail: 'src/tax.js does not use src/regions.js' })
    if (p.regions.some(region => new RegExp(`\\b${region}\\s*:\\s*\\d`).test(tax))) issues.push({ kind: 'refactor-incomplete', detail: 'src/tax.js still holds the tax-rate table' })
  }
  if (hidden.variant === 'refactor' && hidden.kindDetail === 'percentOfCents') {
    for (const module of ['discount', 'tax']) {
      const text = now[`src/${module}.js`] ?? ''
      if (/Math\.(round|floor|ceil|trunc)/.test(text)) issues.push({ kind: 'refactor-incomplete', detail: `src/${module}.js still rounds by itself` })
      if (!text.includes('percentOfCents')) issues.push({ kind: 'refactor-incomplete', detail: `src/${module}.js does not use percentOfCents` })
    }
  }
  const work = await mkdtemp(join(tmpdir(), 'nx6-judge-'))
  try {
    await cp(root, join(work, 'p'), { recursive: true, filter: source => !source.split(/[\\/]/).includes('node_modules') })
    await mkdir(join(work, 'p', '__hidden__'), { recursive: true })
    await writeFile(join(work, 'p', '__hidden__', 'hidden.test.mjs'), hidden.tests)
    const run = await runNodeTest(join(work, 'p'), join('__hidden__', 'hidden.test.mjs'), timeoutMs)
    const failed = [...run.output.matchAll(/^\s*not ok \d+ - (.+)$/gm)].map(match => match[1].trim())
    const passed = [...run.output.matchAll(/^\s*ok \d+ - (.+)$/gm)].length
    if (run.timedOut || run.code === null || (run.code !== 0 && failed.length === 0) || (passed === 0 && failed.length === 0)) {
      return { pass: null, issues, problems: [...issues.map(issue => `${issue.kind}: ${issue.detail}`), `hidden tests did not finish (exit ${run.code}${run.timedOut ? ', timed out' : ''})`] }
    }
    for (const name of failed) {
      issues.push(name.startsWith('[cents]') ? { kind: 'convention-cents', detail: name } : { kind: 'hidden-test', detail: name })
    }
  } finally {
    await rm(work, { recursive: true, force: true })
  }
  return finish(issues)
}

/**
 * @param {import('./cases.mjs').Issue[]} issues
 * @returns {import('./cases.mjs').JudgeResult}
 */
function finish(issues) {
  return { pass: issues.length === 0, issues, problems: issues.map(issue => `${issue.kind}: ${issue.detail}`) }
}
