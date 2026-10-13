import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { writeCaseFiles } from '../cases.mjs'
import { codeCase, codeParams, judgeCodeCase, referenceInvoice, referenceSolution, renderProject } from '../code.mjs'

const kinds = result => [...new Set(result.issues.map(issue => issue.kind))].sort()

async function project(task, files) {
  const dir = await mkdtemp(join(tmpdir(), 'nx6-c-'))
  const root = task.hidden.dir
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, root, path)), { recursive: true })
    await writeFile(join(dir, root, path), text)
  }
  return dir
}

async function judged(task, files, options) {
  const dir = await project(task, files)
  try {
    return await judgeCodeCase(task, dir, options)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('the same seed gives the same project and hidden tests', () => {
  assert.deepEqual(codeCase({ id: 'x', set: 'dev', variant: 'feature', seed: 102 }), codeCase({ id: 'x', set: 'dev', variant: 'feature', seed: 102 }))
  assert.notDeepEqual(codeParams(101), codeParams(102))
})

test('the task text never names the conventions', () => {
  for (const variant of ['bugfix', 'feature', 'refactor']) {
    const { message } = codeCase({ id: 'x', set: 'dev', variant, seed: 103 })
    assert.ok(!/test\/|测试文件|整数分/.test(message), message)
  }
})

test('the bugfix message quotes a wrong total the bug really produces', () => {
  for (const seed of [101, 103, 109]) {
    const p = codeParams(seed)
    const { message } = codeCase({ id: 'x', set: 'dev', variant: 'bugfix', seed })
    assert.match(message, /发票总额是 [\d.]+ 元，应该是 [\d.]+ 元/)
    const [, wrong, right] = message.match(/发票总额是 ([\d.]+) 元，应该是 ([\d.]+) 元/)
    assert.notEqual(wrong, right, p.bug)
  }
})

test('reference model: discount at exactly the threshold, tax on the discounted amount', () => {
  const p = codeParams(101)
  const at = [{ sku: p.products[0].sku, quantity: 5 }]
  const right = referenceInvoice(p, at, p.regions[0])
  assert.equal(right.subtotal, p.thresholdCents)
  assert.equal(right.discount, Math.round(p.thresholdCents * p.discountPercent / 100))
  assert.equal(referenceInvoice(p, at, p.regions[0], { bug: 'threshold' }).discount, 0)
  assert.equal(right.tax, Math.round((right.subtotal - right.discount) * p.taxBp[p.regions[0]] / 10000))
})

for (const [variant, seed] of [['bugfix', 101], ['bugfix', 103], ['bugfix', 109], ['feature', 102], ['feature', 106], ['refactor', 108]]) {
  test(`${variant} ${seed}: untouched project fails, reference passes, reference without tests fails only on the convention`, async () => {
    const task = codeCase({ id: 'x', set: 'holdout', variant, seed })
    const dir = await mkdtemp(join(tmpdir(), 'nx6-c-'))
    try {
      await writeCaseFiles(task, dir)
      const untouched = await judgeCodeCase(task, dir)
      assert.equal(untouched.pass, false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
    assert.deepEqual(await judged(task, referenceSolution(task, { withTests: true })), { pass: true, issues: [], problems: [] })
    const bare = await judged(task, referenceSolution(task, { withTests: false }))
    assert.deepEqual(kinds(bare), ['convention-tests'])
  })
}

test('amounts in yuan instead of cents fail the cents check', async () => {
  const task = codeCase({ id: 'x', set: 'dev', variant: 'feature', seed: 102 })
  assert.equal(codeParams(102).feature, 'shipping')
  const result = await judged(task, referenceSolution(task, { withTests: true, centsAsYuan: true }))
  assert.ok(kinds(result).includes('convention-cents'), result.problems.join('\n'))
})

test('a refactor that adds the helper but keeps rounding in tax.js is incomplete', async () => {
  const task = codeCase({ id: 'x', set: 'guard', variant: 'refactor', seed: 107 })
  const files = referenceSolution(task, { withTests: true })
  files['src/tax.js'] = renderProject(codeParams(107))['src/tax.js']
  files['test/tax.test.js'] = "import { test } from 'node:test'\nimport { taxCents } from '../src/tax.js'\ntest('tax', () => { taxCents(100, Object.keys({})[0] ?? 'x') === 0 || true })\n"
  const result = await judged(task, files)
  assert.deepEqual(kinds(result), ['refactor-incomplete'])
})

test('a regions refactor that leaves the rate table in tax.js is incomplete', async () => {
  const task = codeCase({ id: 'x', set: 'holdout', variant: 'refactor', seed: 108 })
  assert.equal(codeParams(108).refactor, 'regions')
  const files = referenceSolution(task, { withTests: true })
  files['src/tax.js'] = `${renderProject(codeParams(108))['src/tax.js']}\nexport { taxRateBp } from './regions.js'\n`
  const result = await judged(task, files)
  assert.deepEqual(result.issues, [{ kind: 'refactor-incomplete', detail: 'src/tax.js still holds the tax-rate table' }])
})

test('editing a module without touching its existing test file breaks the convention', async () => {
  const task = codeCase({ id: 'x', set: 'selection', variant: 'bugfix', seed: 103 })
  assert.equal(codeParams(103).bug, 'tax-base')
  const files = referenceSolution(task, { withTests: false })
  const result = await judged(task, files)
  assert.deepEqual(result.issues, [{ kind: 'convention-tests', detail: 'invoice' }])
})

test('no src directory is a missing output; a hanging project is unknown, not a failure', async () => {
  const task = codeCase({ id: 'x', set: 'dev', variant: 'bugfix', seed: 101 })
  assert.deepEqual(kinds(await judged(task, { 'README.md': 'empty\n' })), ['missing-output'])
  const files = referenceSolution(task, { withTests: true })
  files['src/invoice.js'] = 'export function buildInvoice() { for (;;) {} }\n'
  files['test/invoice.test.js'] = `${files['test/invoice.test.js']}\n// touched\n`
  const result = await judged(task, files, { timeoutMs: 1500 })
  assert.equal(result.pass, null)
})
