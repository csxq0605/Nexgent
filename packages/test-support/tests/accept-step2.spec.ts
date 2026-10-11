import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  budgetGate,
  CHECKS,
  decideExit,
  evaluateItem,
  EXIT_FAIL,
  EXIT_NOT_READY,
  EXIT_PASS,
  LAYERS,
  OPTIONAL_CHECKS,
  parseLayers,
  realModelKeySource,
} from '../../../scripts/accept-common/step2-checks.mjs'
import { realLikeScript } from '../../../scripts/accept-common/step2-real-scripted.mjs'
import { filesContaining } from '../../../scripts/accept-common/step2-headless.mjs'
import { scriptedModelServer, validateAcceptanceSummary, type AcceptanceSummary } from '../src/index.js'

const script = fileURLToPath(new URL('../../../scripts/accept-step2.mjs', import.meta.url))
const plan = fileURLToPath(new URL('../../../docs/plan/step-2-work-partition.md', import.meta.url))

describe('accept-step2 checklist', () => {
  it('has the 40 items of the step-2 plan, in order, each once', async () => {
    const ids = CHECKS.map(check => check.id)
    expect(new Set(ids).size).toBe(ids.length)
    const range = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${String(i + 1).padStart(2, '0')}`)
    expect(ids).toEqual([...range('H', 23), ...range('D', 10), ...range('R', 7)])
    for (const check of CHECKS) expect(LAYERS[check.layer].prefix).toBe(check.id[0])
    // The plan's tables are the source of truth: every `| H01 |` row there is here and vice versa.
    const planIds = [...(await readFile(plan, 'utf8')).matchAll(/^\| ([HDR]\d\d) \|/gm)].map(match => match[1])
    expect(planIds).toEqual(ids)
    expect([...OPTIONAL_CHECKS]).toEqual(['R06'])
  })

  it('selects layers: default headless + desktop; real only when asked; unknown rejected', () => {
    expect(parseLayers(undefined)).toEqual({ ok: true, layers: ['headless', 'desktop'] })
    expect(parseLayers('real')).toEqual({ ok: true, layers: ['real'] })
    expect(parseLayers('desktop,headless')).toEqual({ ok: true, layers: ['headless', 'desktop'] })
    expect(parseLayers('all')).toEqual({ ok: true, layers: ['headless', 'desktop', 'real'] })
    expect(parseLayers('ui')).toMatchObject({ ok: false })
  })

  it('an item without run is not-implemented; a throw or a malformed result is failed', async () => {
    expect(await evaluateItem({ id: 'H01' }, {})).toEqual({ status: 'not-implemented', evidence: 'not implemented yet' })
    expect(await evaluateItem({ run: () => ({ pass: true, evidence: 'ok' }) }, {})).toEqual({ status: 'passed', evidence: 'ok' })
    expect(await evaluateItem({ run: async () => ({ pass: false, evidence: 'no v2' }) }, {})).toEqual({ status: 'failed', evidence: 'no v2' })
    expect((await evaluateItem({ run: () => { throw new Error('boom') } }, {})).status).toBe('failed')
    expect((await evaluateItem({ run: () => ({ pass: 'yes' }) as never }, {})).status).toBe('failed')
    expect(await evaluateItem({ run: () => ({ status: 'not-implemented', evidence: 'needs the SDK' }) }, {})).toEqual({ status: 'not-implemented', evidence: 'needs the SDK' })
    expect((await evaluateItem({ run: () => ({ status: 'passed?' }) as never }, {})).status).toBe('failed')
    // Headless items judge the scenario's observations; a crashed scenario fails them all.
    const h02 = CHECKS.find(check => check.id === 'H02')!
    expect(await evaluateItem(h02, { scenarioError: 'boom' })).toMatchObject({ status: 'failed' })
    const d05 = CHECKS.find(check => check.id === 'D05')!
    expect(await evaluateItem(d05, { scenarioError: 'boom' })).toMatchObject({ status: 'failed' })
    expect(await evaluateItem(d05, { obs: {} })).toMatchObject({ status: 'failed' })
    // Every item has a check.
    expect(CHECKS.filter(check => typeof check.run !== 'function').map(check => check.id)).toEqual([])
    const r01 = CHECKS.find(check => check.id === 'R01')!
    expect(await evaluateItem(r01, { scenarioError: 'boom' })).toMatchObject({ status: 'failed' })
  })

  it('exit code: any failure is 1, anything not implemented or not runnable is 2, never 0 without checks', () => {
    expect(decideExit(['passed', 'passed'])).toBe(EXIT_PASS)
    expect(decideExit(['passed', 'not-implemented'])).toBe(EXIT_NOT_READY)
    expect(decideExit(['failed', 'not-implemented'])).toBe(EXIT_FAIL)
    expect(decideExit(['passed'], 1)).toBe(EXIT_NOT_READY)
    expect(decideExit(['failed'], 1)).toBe(EXIT_FAIL)
    expect(decideExit([])).toBe(EXIT_NOT_READY)
  })

  it('budget gate refuses once earlier runs reach the cap or a cost is unknown', () => {
    expect(budgetGate(15, [])).toEqual({ ok: true, remainingUsd: 15 })
    expect(budgetGate(15, [1.2, 3])).toMatchObject({ ok: true })
    expect(budgetGate(15, [10, 5])).toMatchObject({ ok: false })
    expect(budgetGate(15, [1, 'unknown'])).toMatchObject({ ok: false })
    expect(budgetGate(0, [])).toMatchObject({ ok: false })
  })

  it('names the key variable without returning its value', () => {
    expect(realModelKeySource({ NEXGENT_API_KEY: 'k1', ANTHROPIC_API_KEY: 'k2' })).toBe('NEXGENT_API_KEY')
    expect(realModelKeySource({ ANTHROPIC_API_KEY: 'k2' })).toBe('ANTHROPIC_API_KEY')
    expect(realModelKeySource({ NEXGENT_API_KEY: '' })).toBeUndefined()
  })
})

describe('scripts/accept-step2.mjs (requires `pnpm build`)', () => {
  async function runScript(args: string[], env: NodeJS.ProcessEnv = {}, timeout = 60_000) {
    const dir = await mkdtemp(join(tmpdir(), 'nexgent-accept2-test-'))
    try {
      const out = join(dir, 'summary.json')
      const childEnv = { ...process.env, ...env }
      for (const [key, value] of Object.entries(env)) if (value === undefined) delete childEnv[key]
      const result = spawnSync(process.execPath, [script, '--out', out, '--work-dir', join(dir, 'work'), ...args], { encoding: 'utf8', env: childEnv, timeout })
      const summary = await readFile(out, 'utf8').then(text => JSON.parse(text) as AcceptanceSummary).catch(() => undefined)
      const raw = await readFile(out, 'utf8').catch(() => '')
      return { result, summary, raw }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  // The desktop layer runs the full Electron scenario; its judges are tested in accept-step2-desktop.spec.ts.
  it('desktop layer: all ten items pass, the summary is valid, exit 0', async () => {
    const { result, summary } = await runScript(['--layer', 'desktop'], {}, 240_000)
    expect(result.status, result.stderr).toBe(EXIT_PASS)
    expect(validateAcceptanceSummary(summary)).toEqual({ valid: true, errors: [] })
    expect(summary?.checks.map(check => check.id)).toEqual(CHECKS.filter(check => check.layer === 'desktop').map(check => check.id))
    for (const check of summary?.checks ?? []) expect(check, check.detail).toMatchObject({ passed: true, status: 'passed' })
  }, 300_000)

  it('rejects the retired --allow-not-ready flag', async () => {
    const { result } = await runScript(['--layer', 'real', '--allow-not-ready'], { NEXGENT_API_KEY: undefined, ANTHROPIC_API_KEY: undefined })
    expect(result.status).toBe(EXIT_FAIL)
    expect(result.stderr).toContain('allow-not-ready')
  }, 90_000)

  it('real layer: without a key it is not runnable (exit 2) and calls no model', async () => {
    const { result, summary } = await runScript(['--layer', 'real'], { NEXGENT_API_KEY: undefined, ANTHROPIC_API_KEY: undefined })
    expect(result.status, result.stderr).toBe(EXIT_NOT_READY)
    expect(result.stderr).toContain('no API key')
    expect(summary?.scripted).toBeNull()
    // Never a fake pass: every item of a layer that cannot run is listed as not implemented, and the summary fails.
    expect(validateAcceptanceSummary(summary)).toEqual({ valid: true, errors: [] })
    expect(summary?.result).toBe('fail')
    expect(summary?.checks.map(check => check.id)).toEqual(CHECKS.filter(check => check.layer === 'real' && !OPTIONAL_CHECKS.has(check.id)).map(check => check.id))
    for (const check of summary?.checks ?? []) expect(check).toMatchObject({ passed: false, status: 'not-implemented' })
    expect(summary?.realModel).toMatchObject({ model: 'claude-sonnet-5-5', thinking: 'on', callCount: 0, result: 'fail' })
  }, 90_000)

  it('real layer against a loopback stand-in: R01–R05 pass, nothing claims a real run, the key value is never written', async () => {
    const key = 'nexgent-accept2-test-key-value'
    const server = await scriptedModelServer({ script: realLikeScript() as never })
    const dir = await mkdtemp(join(tmpdir(), 'nexgent-accept2-real-'))
    try {
      const out = join(dir, 'summary.json')
      const env: Record<string, string> = {}
      for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('NEXGENT_') && k !== 'ANTHROPIC_API_KEY') env[k] = v
      Object.assign(env, { NEXGENT_API_KEY: key, NEXGENT_API_BASE_URL: server.baseUrl })
      const child = spawn(process.execPath, [script, '--layer', 'real', '--out', out, '--work-dir', join(dir, 'work')], { env, stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''
      child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()))
      child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()))
      const code = await new Promise<number | null>(resolve => child.once('exit', resolve))
      const raw = await readFile(out, 'utf8')
      const summary = JSON.parse(raw) as AcceptanceSummary
      expect(validateAcceptanceSummary(summary)).toEqual({ valid: true, errors: [] })
      const status = Object.fromEntries(summary.checks.map(check => [check.id, check.status]))
      expect(status, output).toMatchObject({ R01: 'passed', R02: 'passed', R03: 'passed', R04: 'passed', R05: 'passed', R07: 'not-implemented' })
      // R06 (optional, Windows only) did not run: listed as untested, not as a check.
      if (process.platform !== 'win32') {
        expect(status).not.toHaveProperty('R06')
        expect(summary.failures.untested.join(' ')).toContain('R06')
      }
      // R07 (not a real run) keeps the exit code at 2: a stand-in can never pass the real layer.
      expect(code, output).toBe(EXIT_NOT_READY)
      expect(summary.result).toBe('fail')
      expect(summary.realModel).toMatchObject({ result: 'fail', thinking: 'on' })
      expect(summary.realModel?.runNote).toContain('NOT a real-model run')
      expect(summary.realModel?.unknownCount).toBe(1)
      expect(summary.failures.knownIssues.join(' ')).toContain('loopback stand-in')
      expect(raw).not.toContain(key)
      expect(output).not.toContain(key)
      for (const file of await filesContaining(join(dir, 'work'), key)) expect.fail(`key value written to ${file}`)
    } finally {
      await server.close()
      await rm(dir, { recursive: true, force: true })
    }
  }, 240_000)
})
