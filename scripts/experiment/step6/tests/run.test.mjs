import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cleanEnv } from '../code.mjs'
import { copied, costOf, loadPackages, parseArgs, pickedCases, rawRecords, realKeyPresent, runExperiment, runIdOf } from '../run.mjs'

const RUN = fileURLToPath(new URL('../run.mjs', import.meta.url))
const price = (/** @type {string} */ model, /** @type {any} */ usage) => (model === 'priced' ? usage.inputTokens / 1000 : 'unknown')

test('costOf prices every request end and is unknown when one is missing or unpriced', () => {
  const start = (/** @type {string} */ id, model = 'priced') => ({ type: 'llm.request.start', requestId: id, model })
  const end = (/** @type {string} */ id, model = 'priced') => ({ type: 'llm.request.end', requestId: id, model, usage: { inputTokens: 500 } })
  assert.equal(costOf([start('a'), end('a'), start('b'), end('b'), { type: 'task.outcome' }], price), 1)
  assert.equal(costOf([], price), 0)
  assert.equal(costOf([start('a')], price), null)
  assert.equal(costOf([start('a', 'other'), end('a', 'other')], price), null)
})

test('copies skip lock files, and run copies skip the improvement jobs', () => {
  assert.equal(copied('.nexgent/sessions/s/session.jsonl', { jobs: false }), true)
  assert.equal(copied('.nexgent\\improvements\\queue.json', { jobs: false }), false)
  assert.equal(copied('.nexgent/improvements/queue.json', { jobs: true }), true)
  assert.equal(copied('.nexgent/improvements/queue.json.lock', { jobs: true }), false)
})

test('run ids and gate picks', () => {
  assert.equal(runIdOf('child', 'code/holdout/feature-106', 2), 'child#code/holdout/feature-106#2')
  assert.deepEqual(pickedCases('trial s2 … s1', { s1: 'b', s2: 'a', s3: 'c' }), ['a', 'b'])
})

test('parseArgs: a backend and --out are required; numbers must be positive; dev trial defaults', () => {
  assert.deepEqual(parseArgs([]).problems, ['choose --scripted or --real', '--out <dir> is required'])
  assert.ok(parseArgs(['--scripted', '--real', '--out', 'x']).problems.includes('--scripted and --real exclude each other'))
  assert.ok(parseArgs(['--scripted', '--out', 'x', '--repeats', '0']).problems.includes('--repeats must be a positive number'))
  assert.ok(parseArgs(['--scripted', '--out', 'x', '--families', 'tables,nope']).problems.includes('unknown family nope'))
  const { options, problems } = parseArgs(['--real', '--out', 'x', '--dev-trial'])
  assert.deepEqual(problems, [])
  assert.deepEqual(options.devTrial, { caseId: 'code/dev/bugfix-101', repeats: 3 })
})

test('rawRecords: arms, improvers, capability versions and decisions reach the manifest; missing data is a note', () => {
  const family = (/** @type {string} */ name, /** @type {any} */ extra) => ({
    family: name, notes: [], approvals: [], costs: [], runs: [], checks: {}, arms: { base: { capabilityVersion: 'baseline' } }, meta: null, ...extra,
  })
  const raw = rawRecords([
    family('code', {
      arms: { base: { capabilityVersion: 'baseline' }, parent: { capabilityVersion: 'v-p' }, child: { capabilityVersion: 'v-c' } },
      meta: { jobId: 'm', status: 'rejected', comparison: { origin: { epoch: 'e1' }, parent: { improverVersion: 'v0' }, child: { improverVersion: 'v1' }, verdict: { outcome: 'reject', reason: 'no-improvement' } } },
      runs: [{ runId: 'base#c#1', family: 'code', caseId: 'c', arm: 'base', repeat: 1, pass: false, costUsd: 0.1, componentsUsed: [], extra: 'dropped' }],
    }),
    family('tables', { meta: { jobId: 'n', status: 'failed' }, notes: ['parent arm: no kept comparison copy'] }),
  ], { experimentId: 'x', backend: 'scripted', model: 'scripted', iterations: 10 })
  assert.deepEqual(raw.manifest.capabilities, { base: 'code: baseline; tables: baseline', parent: 'code: v-p', child: 'code: v-c' })
  assert.deepEqual(raw.manifest.improvers, { parent: 'code: v0', child: 'code: v1' })
  assert.deepEqual(raw.manifest.decisions, { code: 'reject (no-improvement)', tables: 'no comparison (meta job failed)' })
  assert.equal(raw.manifest.epochId, 'e1')
  assert.deepEqual(Object.keys(raw.runs[0]).sort(), ['arm', 'caseId', 'componentsUsed', 'costUsd', 'family', 'pass', 'repeat', 'runId'])
  assert.ok(raw.notes.includes('tables: parent arm: no kept comparison copy'))
  assert.ok(raw.notes.some(n => n.startsWith('feedback check vs hidden judge: not compared')))
})

test('the real backend without a key exits 2 and runs nothing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nx6-r-'))
  try {
    const env = { ...cleanEnv() }
    delete env.NEXGENT_API_KEY
    delete env.ANTHROPIC_API_KEY
    assert.equal(realKeyPresent(env), false)
    const run = spawnSync(process.execPath, [RUN, '--real', '--dev-trial', '--out', join(dir, 'out')], { env, encoding: 'utf8' })
    assert.equal(run.status, 2, run.stderr)
    assert.match(run.stderr, /no model key/)
    const bad = spawnSync(process.execPath, [RUN, '--scripted'], { env, encoding: 'utf8' })
    assert.equal(bad.status, 2)
    assert.match(bad.stderr, /usage:/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

const built = (await loadPackages()).ok
test('scripted dev trial: one repeat on v0 fails only on the convention; a tiny cap stops before any run', { skip: built ? false : 'packages not built (pnpm build)' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nx6-r-'))
  try {
    const log = () => {}
    const ok = await runExperiment({ backend: 'scripted', out: join(dir, 'a'), devTrial: { caseId: 'tables/dev/region-2026-09', repeats: 1 }, log })
    assert.equal(ok.code, 0, ok.reason)
    const trial = JSON.parse(await readFile(join(dir, 'a', 'dev-trial.json'), 'utf8'))
    assert.equal(trial.runs.length, 1)
    assert.equal(trial.runs[0].pass, false)
    assert.equal(trial.taskRightRate, 1)
    assert.ok(trial.spentUsd > 0)

    await runExperiment({ backend: 'scripted', out: join(dir, 'b'), cap: 0.1, devTrial: { caseId: 'tables/dev/region-2026-09', repeats: 2 }, log })
    const stopped = JSON.parse(await readFile(join(dir, 'b', 'dev-trial.json'), 'utf8'))
    assert.equal(stopped.runs.length, 0)
    assert.match(stopped.stopped, /cap|exceed|35|0\.1/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
