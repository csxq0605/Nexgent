#!/usr/bin/env node
/**
 * Step 1 real-task check (plan 4.1: "通过 Nexgent 入口启动，完成真实任务并保存原生会话").
 *
 * Copies `order-lib/` (a small Node library with two bugs in different files)
 * into a fresh project directory, then drives the real model through the
 * Nexgent CLI:
 *
 *   round 1  `nexgent run`    fix the bugs so `npm test` passes, test files untouched;
 *   round 2  `nexgent resume` same session: add shipping (new module, new return
 *                             field, README, tests) and keep everything green.
 *
 * Every verdict comes from this script, never from the model's own report:
 * the original tests and the hidden tests in `hidden/` (not visible to the
 * model) are run on a copy of the project after each round, and the session
 * JSONL and ledger are checked for complete turns and paired requests.
 *
 * Usage: NEXGENT_API_KEY=<key> node scripts/real-task/step1-real-task.mjs --out <dir>
 * `--out` receives the project copy, CLI transcripts, session, ledger and
 * summary.json. Keep it out of the repository (raw logs are not committed).
 * Exit codes: 0 pass; 1 fail; 2 not runnable (no key, build missing).
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const REPO_ROOT = resolve(HERE, '../..')
const CLI_BIN = join(REPO_ROOT, 'apps/cli/bin/nexgent.mjs')
const FIXTURE = join(HERE, 'order-lib')
const HIDDEN = join(HERE, 'hidden')
const RUN_TIMEOUT_MS = 30 * 60_000

/** Sonnet 5.5 list prices, USD per million tokens (cache write = 5-minute TTL, 1.25x input). */
const PRICE = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }

export const TASK_1 = '这个项目是一个订单计价库。运行 `npm test` 时有测试失败。请找出原因并修好源码，让全部测试通过。'
  + '不要修改、删除或跳过 test/ 下已有的测试。完成后再跑一次全部测试确认，并简要说明你改了什么、为什么。'

export const TASK_2 = '在同一个库里加运费：订单折后金额低于 50.00 时收 5.99 运费，达到或超过 50.00 免运费（金额单位都是分）。'
  + '新建 src/shipping.js，导出 shippingFor(amountAfterDiscount)；priceOrder 的返回值改为 { subtotal, discount, shipping, total }，'
  + '其中 total = subtotal - discount + shipping。更新 README，为运费补上测试，已有测试按新的返回值调整。最后跑全部测试确认通过。'

const { values: args } = parseArgs({ options: { out: { type: 'string' } } })
if (!args.out) {
  process.stderr.write('usage: node scripts/real-task/step1-real-task.mjs --out <dir>\n')
  process.exit(2)
}
if (!process.env.NEXGENT_API_KEY && !process.env.ANTHROPIC_API_KEY) {
  process.stderr.write('step1-real-task: NEXGENT_API_KEY is not set\n')
  process.exit(2)
}
if (!existsSync(join(REPO_ROOT, 'packages/kernel/dist'))) {
  process.stderr.write('step1-real-task: run `pnpm build` first\n')
  process.exit(2)
}

const out = resolve(args.out)
const project = join(out, 'project')
await rm(out, { recursive: true, force: true })
await mkdir(out, { recursive: true })
await cp(FIXTURE, project, { recursive: true })

const checks = []
function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) })
  process.stderr.write(`step1-real-task: ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}\n`)
}

async function hashTree(dir) {
  const hashes = {}
  for (const name of (await readdir(dir)).sort()) {
    hashes[name] = createHash('sha256').update(await readFile(join(dir, name))).digest('hex')
  }
  return hashes
}

function nexgent(argv, transcript) {
  const started = Date.now()
  const result = spawnSync(process.execPath, [CLI_BIN, ...argv], {
    cwd: project, encoding: 'utf8', timeout: RUN_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024,
  })
  const elapsedMs = Date.now() - started
  return writeFile(join(out, transcript), `$ nexgent ${argv.map(a => JSON.stringify(a)).join(' ')}\n# exit ${result.status} signal ${result.signal} ${elapsedMs} ms\n\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}\n`)
    .then(() => ({ code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', elapsedMs }))
}

/** Run node --test on a copy of the project with extra test files; returns { ok, pass, fail }. */
async function runTests(label, testFiles) {
  const dir = join(out, `check-${label}`)
  await rm(dir, { recursive: true, force: true })
  await cp(project, dir, { recursive: true, filter: src => !src.includes(`${join(project, '.nexgent')}`) })
  for (const [name, source] of Object.entries(testFiles.extra ?? {})) {
    await mkdir(join(dir, 'hidden'), { recursive: true })
    await cp(source, join(dir, 'hidden', name))
  }
  const files = testFiles.files(dir)
  const result = spawnSync(process.execPath, ['--test', ...files], { cwd: dir, encoding: 'utf8', timeout: 120_000 })
  const text = `${result.stdout}\n${result.stderr}`
  await writeFile(join(out, `check-${label}.txt`), text)
  const pass = Number(/^# pass (\d+)/m.exec(text)?.[1] ?? NaN)
  const fail = Number(/^# fail (\d+)/m.exec(text)?.[1] ?? NaN)
  return { ok: result.status === 0 && fail === 0 && pass > 0, pass, fail }
}

async function testFilesIn(dir) {
  return (await readdir(join(dir, 'test'))).filter(name => name.endsWith('.test.js')).sort().map(name => join('test', name))
}

const originalTests = await hashTree(join(FIXTURE, 'test'))

// Baseline: the fixture really fails before the model touches it.
const baseline = await runTests('baseline', { files: () => Object.keys(originalTests).map(n => join('test', n)) })
check('baseline: fixture tests fail before the run', !baseline.ok && baseline.fail === 3, `pass ${baseline.pass}, fail ${baseline.fail}`)

// Round 1.
const r1 = await nexgent(['run', '--project', project, '--task', TASK_1], 'round1-cli.txt')
const sessionId = /new session ([0-9a-f-]{36})/.exec(r1.stdout + r1.stderr)?.[1]
check('round 1: nexgent run exits 0', r1.code === 0, `exit ${r1.code}, ${Math.round(r1.elapsedMs / 1000)} s`)
check('round 1: session id reported', sessionId !== undefined, sessionId)
const testsAfter1 = await hashTree(join(project, 'test'))
check('round 1: original test files unchanged', JSON.stringify(testsAfter1) === JSON.stringify(originalTests))
const check1 = await runTests('round1', {
  files: () => [...Object.keys(originalTests).map(n => join('test', n)), 'hidden/round1.test.js'],
  extra: { 'round1.test.js': join(HIDDEN, 'round1.test.js') },
})
check('round 1: original + hidden tests pass', check1.ok, `pass ${check1.pass}, fail ${check1.fail}`)
const srcChanged = []
for (const name of ['catalog.js', 'discount.js', 'inventory.js', 'order.js']) {
  const before = await readFile(join(FIXTURE, 'src', name), 'utf8')
  const after = await readFile(join(project, 'src', name), 'utf8').catch(() => '')
  if (before !== after) srcChanged.push(name)
}
check('round 1: fixes span at least two source files', srcChanged.length >= 2, srcChanged.join(', '))
await cp(join(project, 'src'), join(out, 'snapshot-round1-src'), { recursive: true })

// Round 2, same session.
let r2 = { code: null }
if (sessionId) r2 = await nexgent(['resume', sessionId, '--project', project, '--task', TASK_2], 'round2-cli.txt')
check('round 2: nexgent resume exits 0', r2.code === 0, `exit ${r2.code}${r2.elapsedMs ? `, ${Math.round(r2.elapsedMs / 1000)} s` : ''}`)
const projectTests = await testFilesIn(project)
const own2 = await runTests('round2-own', { files: () => projectTests })
check('round 2: the project\'s own tests pass', own2.ok, `pass ${own2.pass}, fail ${own2.fail}, files ${projectTests.join(' ')}`)
check('round 2: test count did not shrink', own2.pass >= 12, `pass ${own2.pass} (fixture had 12)`)
const testText = (await Promise.all(projectTests.map(f => readFile(join(project, f), 'utf8')))).join('\n')
check('round 2: tests cover shipping', /shippingFor|shipping/.test(testText))
const check2 = await runTests('round2-hidden', {
  files: () => ['hidden/round2.test.js'],
  extra: { 'round2.test.js': join(HIDDEN, 'round2.test.js') },
})
check('round 2: hidden shipping tests pass', check2.ok, `pass ${check2.pass}, fail ${check2.fail}`)
const readme = await readFile(join(project, 'README.md'), 'utf8')
check('round 2: README mentions shipping', /shipping|运费/i.test(readme))

// Native session and ledger.
const sessionFile = sessionId ? join(project, '.nexgent/sessions', sessionId, 'session.jsonl') : ''
const lines = text => text.split(/\r?\n/).filter(l => l.trim() !== '').map(l => JSON.parse(l))
let records = []
let ledger = []
try { records = lines(await readFile(sessionFile, 'utf8')) } catch {}
for (const month of (await readdir(join(project, '.nexgent/ledgers')).catch(() => [])).sort()) {
  ledger.push(...lines(await readFile(join(project, '.nexgent/ledgers', month, 'requests.jsonl'), 'utf8').catch(() => '')))
}
check('session: JSONL saved', records.length > 0, sessionFile.replace(out, '<out>'))
check('session: seq contiguous', records.every((r, i) => r.seq === i + 1))
const ends = records.filter(r => r.type === 'turn.end')
check('session: two turns, both completed', ends.length === 2 && ends.every(r => r.reason?.kind === 'completed'), ends.map(r => r.reason?.kind).join(', '))
const starts = new Set(ledger.filter(r => r.type === 'llm.request.start').map(r => r.requestId))
const endsL = ledger.filter(r => r.type === 'llm.request.end')
const unpaired = [...starts].filter(id => !endsL.some(e => e.requestId === id)).length + endsL.filter(e => !starts.has(e.requestId)).length
check('ledger: every request has a start and an end', unpaired === 0 && starts.size > 0, `${starts.size} requests`)
const notOk = endsL.filter(e => e.status !== 'ok')
check('ledger: no failed or unknown requests', notOk.length === 0, notOk.map(e => e.status).join(', ') || undefined)
const outcomes = ledger.filter(r => r.type === 'task.outcome')
check('ledger: two task outcomes, both completed', outcomes.length === 2 && outcomes.every(o => o.status === 'completed'), outcomes.map(o => o.status).join(', '))

// Usage and cost.
const sum = key => endsL.reduce((n, e) => n + (typeof e.usage?.[key] === 'number' ? e.usage[key] : 0), 0)
const usage = { input: sum('inputTokens'), output: sum('outputTokens'), cacheRead: sum('cacheReadTokens'), cacheWrite: sum('cacheWriteTokens') }
const unknownUsage = endsL.filter(e => ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'].some(k => typeof e.usage?.[k] !== 'number')).length
const costUsd = (usage.input * PRICE.input + usage.output * PRICE.output + usage.cacheRead * PRICE.cacheRead + usage.cacheWrite * PRICE.cacheWrite) / 1e6
const perRound = outcomes.map((o, i) => ({ round: i + 1, status: o.status, requests: o.requestCount, toolCalls: o.toolCallCount, toolsUsed: o.toolsUsed }))
const toolCalls = ledger.filter(r => r.type === 'tool.call')
const toolCounts = {}
for (const call of toolCalls) toolCounts[call.name] = (toolCounts[call.name] ?? 0) + 1

await cp(join(project, '.nexgent'), join(out, 'nexgent-data'), { recursive: true }).catch(() => {})
const passed = checks.every(c => c.ok)
const summary = {
  script: 'scripts/real-task/step1-real-task.mjs',
  model: records.find(r => r.type === 'session.start')?.model,
  sessionId,
  passed,
  checks,
  requests: starts.size,
  perRound,
  toolCalls: toolCalls.length,
  toolCounts,
  usage,
  unknownUsageRequests: unknownUsage,
  estimatedCostUsd: Number(costUsd.toFixed(4)),
  priceBasis: PRICE,
  elapsedSeconds: { round1: Math.round(r1.elapsedMs / 1000), round2: r2.elapsedMs ? Math.round(r2.elapsedMs / 1000) : null },
  sourceFilesChangedInRound1: srcChanged,
  node: process.version,
  platform: process.platform,
  finishedAt: new Date().toISOString(),
}
await writeFile(join(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
process.stderr.write(`step1-real-task: ${passed ? 'PASSED' : 'FAILED'}; summary at ${join(out, 'summary.json')}\n`)
process.exit(passed ? 0 : 1)
