import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CHECKS as STEP4_CHECKS } from '../../../scripts/accept-common/step4-checks.mjs'
import {
  CHECKS,
  evaluateItem,
  EXIT_FAIL,
  EXIT_NOT_READY,
  EXIT_PASS,
  LAYERS,
  OPTIONAL_CHECKS,
  parseLayers,
  REAL_MODEL,
  realModelKeySource,
  regressionVerdict,
  STEP4_HEADLESS,
  type CheckResult,
} from '../../../scripts/accept-common/step5-checks.mjs'
import { validateAcceptanceSummary, type AcceptanceSummary } from '../src/index.js'

const script = fileURLToPath(new URL('../../../scripts/accept-step5.mjs', import.meta.url))
const plan = fileURLToPath(new URL('../../../docs/plan/step-5-work-partition.md', import.meta.url))
const range = (prefix: string, from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${String(from + i).padStart(2, '0')}`)

/** Step-5 headless items with a judge (round 3). */
const JUDGED = range('H', 1, 18)
/** Wired so far: every headless and desktop item (round 3). The real layer is round 4 and must report not-implemented. */
const WIRED = new Set([...range('H', 1, 19), ...range('D', 1, 23)])

describe('accept-step5 checklist', () => {
  it('has every item of the step-5 plan in order, plus the D01–D18 regression', async () => {
    const ids = CHECKS.map(check => check.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual([...range('H', 1, 19), ...range('D', 1, 23), ...range('R', 1, 8)])
    for (const check of CHECKS) expect(LAYERS[check.layer].prefix).toBe(check.id[0])
    // The plan's tables are the source of truth; D01–D18 come from steps 2–4 and are not in them.
    const planIds = [...(await readFile(plan, 'utf8')).matchAll(/^\| ([HDR]\d\d) \|/gm)].map(match => match[1])
    expect(planIds).toEqual(ids.filter(id => !range('D', 1, 18).includes(id)))
    expect([...OPTIONAL_CHECKS]).toEqual(['R07', 'R08'])
    // The regressions run step 4's own items, not copies that could drift.
    const step4Desktop = STEP4_CHECKS.filter(c => c.layer === 'desktop')
    expect(step4Desktop.map(c => c.id)).toEqual(range('D', 1, 18))
    for (const check of step4Desktop) expect(CHECKS.find(c => c.id === check.id)?.run).toBe(check.run)
    expect(STEP4_HEADLESS.map(c => c.id)).toEqual(range('H', 1, 19))
    expect(STEP4_HEADLESS.every(c => typeof c.run === 'function')).toBe(true)
  })

  it('selects layers: default headless + desktop; real only when asked; unknown rejected', () => {
    expect(parseLayers(undefined)).toEqual({ ok: true, layers: ['headless', 'desktop'] })
    expect(parseLayers('real')).toEqual({ ok: true, layers: ['real'] })
    expect(parseLayers('all')).toEqual({ ok: true, layers: ['headless', 'desktop', 'real'] })
    expect(parseLayers('ui')).toMatchObject({ ok: false })
  })

  it('nothing fakes a pass: unwired items are not-implemented, wired ones fail without observations', async () => {
    for (const check of CHECKS) {
      const result = await evaluateItem(check, {})
      if (WIRED.has(check.id)) expect(result.status, check.id).toBe('failed')
      else expect(result, check.id).toEqual({ status: 'not-implemented', evidence: 'not implemented yet' })
    }
    const h19 = CHECKS.find(c => c.id === 'H19')!
    expect(await evaluateItem(h19, { regressionError: 'boom' })).toEqual({ status: 'failed', evidence: 'step 4 headless scenarios failed: boom' })
    expect(await evaluateItem(h19, { regression: {} })).toMatchObject({ status: 'failed', evidence: expect.stringMatching(/19 of 19 did not pass/) })
    for (const id of JUDGED) {
      const check = CHECKS.find(c => c.id === id)!
      expect(await evaluateItem(check, { step5Error: 'boom' }), id).toEqual({ status: 'failed', evidence: 'step 5 headless scenario failed: boom' })
    }
    for (const id of JUDGED.filter(id => id !== 'H16')) {
      const check = CHECKS.find(c => c.id === id)!
      expect(await evaluateItem(check, { step5: { features: { shipped: false } } }), id).toMatchObject({ status: 'failed' })
    }
  })

  it('real-model facts follow the user decisions: thinking on, 15 USD', () => {
    expect(REAL_MODEL).toMatchObject({ model: 'claude-sonnet-5-5', thinking: 'on', budgetUsd: 15 })
    expect(realModelKeySource({ ANTHROPIC_API_KEY: 'k' })).toBe('ANTHROPIC_API_KEY')
    expect(realModelKeySource({ NEXGENT_API_KEY: '' })).toBeUndefined()
  })
})

describe('H19 verdict (step 4 regression)', () => {
  const ids = STEP4_HEADLESS.map(c => c.id)
  const pass: CheckResult = { status: 'passed', evidence: 'ok' }
  const all = (status: CheckResult) => ids.map(id => [id, status] as const)

  it('passes only when all of step 4 H01–H19 passed', () => {
    expect(regressionVerdict(all(pass))).toEqual({ status: 'passed', evidence: 'step 4 H01–H19: all 19 passed (H19 there: step 3 H01–H23)' })
  })

  it('fails on one failed item, naming it with its first evidence line', () => {
    const results = all(pass).map(([id, r]) => (id === 'H07' ? [id, { status: 'failed', evidence: 'B ran in the parent\nstack' }] as const : [id, r] as const))
    expect(regressionVerdict(results)).toEqual({ status: 'failed', evidence: 'step 4 regression: 1 of 19 did not pass (H07 failed: B ran in the parent)' })
  })

  it('fails on a not-implemented or missing item', () => {
    const notImpl = all(pass).map(([id, r]) => (id === 'H01' ? [id, { status: 'not-implemented', evidence: 'x' }] as const : [id, r] as const))
    expect(regressionVerdict(notImpl)).toMatchObject({ status: 'failed', evidence: expect.stringContaining('H01 not-implemented') })
    expect(regressionVerdict(all(pass).filter(([id]) => id !== 'H19'))).toMatchObject({ status: 'failed', evidence: expect.stringContaining('H19 not judged') })
  })
})

describe('scripts/accept-step5.mjs (requires `pnpm build`)', () => {
  async function runScript(args: string[], env: NodeJS.ProcessEnv = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'nexgent-accept5-test-'))
    try {
      const out = join(dir, 'summary.json')
      const childEnv = { ...process.env, ...env }
      for (const [key, value] of Object.entries(env)) if (value === undefined) delete childEnv[key]
      const result = spawnSync(process.execPath, [script, '--out', out, '--work-dir', join(dir, 'work'), ...args], { encoding: 'utf8', env: childEnv, timeout: 780_000 })
      const raw = await readFile(out, 'utf8').catch(() => '')
      const summary = raw === '' ? undefined : JSON.parse(raw) as AcceptanceSummary
      return { result, summary, raw }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  // Round 3: the SDK as shipped runs the improvement flow; every headless item passes.
  it('headless layer: H01–H19 pass through the SDK as shipped (exit 0)', async () => {
    const { result, summary } = await runScript(['--layer', 'headless'])
    expect(result.status, result.stderr).toBe(EXIT_PASS)
    expect(validateAcceptanceSummary(summary)).toEqual({ valid: true, errors: [] })
    const items = (summary?.checks ?? []).filter(check => check.id !== undefined)
    expect(items.map(check => check.id)).toEqual(range('H', 1, 19))
    for (const check of items) expect(check, `${check.id}: ${check.detail}`).toMatchObject({ status: 'passed', passed: true })
    expect(items.find(check => check.id === 'H19')?.detail).toBe('step 4 H01–H19: all 19 passed (H19 there: step 3 H01–H23)')
    const fixture = (summary?.checks ?? []).filter(check => check.id === undefined)
    expect(fixture).toHaveLength(1)
    expect(fixture[0], fixture[0]?.detail).toMatchObject({ passed: true, detail: expect.stringMatching(/^passed: .*5 feedbacks recorded \(3 count\)/) })
  }, 840_000)

  it('real layer: no model call this round; exit 2 with or without a key, the key never appears', async () => {
    const keyless = await runScript(['--layer', 'real'], { NEXGENT_API_KEY: undefined, ANTHROPIC_API_KEY: undefined })
    expect(keyless.result.status, keyless.result.stderr).toBe(EXIT_NOT_READY)
    expect(keyless.result.stderr).toContain('no API key')
    expect(validateAcceptanceSummary(keyless.summary)).toEqual({ valid: true, errors: [] })
    expect(keyless.summary?.checks.map(check => check.id)).toEqual(range('R', 1, 6))

    const key = 'sk-ant-accept5-test-value'
    // A base URL nothing listens on: if anything tried a model call it would fail loudly.
    const keyed = await runScript(['--layer', 'real'], { NEXGENT_API_KEY: key, NEXGENT_API_BASE_URL: 'http://127.0.0.1:9' })
    expect(keyed.result.status, keyed.result.stderr).toBe(EXIT_NOT_READY)
    expect(validateAcceptanceSummary(keyed.summary)).toEqual({ valid: true, errors: [] })
    expect(keyed.summary?.realModel).toMatchObject({ result: 'fail', callCount: 0, cost: 0, runNote: expect.stringContaining('no model call made') })
    for (const check of keyed.summary?.checks ?? []) expect(check).toMatchObject({ passed: false, status: 'not-implemented' })
    expect(keyed.raw + keyed.result.stderr + keyed.result.stdout).not.toContain(key)
  }, 180_000)

  it('rejects an unknown layer with exit 1', async () => {
    const { result } = await runScript(['--layer', 'ui'])
    expect(result.status).toBe(EXIT_FAIL)
  }, 90_000)
})
