import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  CHECKS,
  evaluateItem,
  EXIT_FAIL,
  EXIT_NOT_READY,
  LAYERS,
  OPTIONAL_CHECKS,
  parseLayers,
  REAL_MODEL,
  realModelKeySource,
  regressionVerdict,
  type CheckResult,
} from '../../../scripts/accept-common/step4-checks.mjs'
import { CHECKS as STEP3_CHECKS } from '../../../scripts/accept-common/step3-checks.mjs'
import { JUDGES as STEP3_JUDGES } from '../../../scripts/accept-common/step3-judges.mjs'
import { realPrerequisites } from '../../../scripts/accept-common/step4-real.mjs'
import { validateAcceptanceSummary, type AcceptanceSummary } from '../src/index.js'

const script = fileURLToPath(new URL('../../../scripts/accept-step4.mjs', import.meta.url))
const plan = fileURLToPath(new URL('../../../docs/plan/step-4-work-partition.md', import.meta.url))
const range = (prefix: string, from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${String(from + i).padStart(2, '0')}`)

/** Step-4 headless items judged from the step-4 scenario (rounds 2–3). */
const STEP4 = range('H', 1, 18)
/** Of those, the ones that pass on today's product (W1, W2 and the SDK row landed; no gate yet). */
const PASSING = ['H01', 'H02', 'H03', 'H04', 'H05', 'H07', 'H10', 'H13', 'H17', 'H18']
/** Wired so far: the regressions (round 1) and STEP4. Everything else must report not-implemented. */
const WIRED = new Set(['H19', ...range('D', 1, 14), ...STEP4])

describe('accept-step4 checklist', () => {
  it('has every item of the step-4 plan in order, plus the D01–D14 regression', async () => {
    const ids = CHECKS.map(check => check.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual([...range('H', 1, 19), ...range('D', 1, 18), ...range('R', 1, 7)])
    for (const check of CHECKS) expect(LAYERS[check.layer].prefix).toBe(check.id[0])
    // The plan's tables are the source of truth; D01–D14 come from steps 2 and 3 and are not in them.
    const planIds = [...(await readFile(plan, 'utf8')).matchAll(/^\| ([HDR]\d\d) \|/gm)].map(match => match[1])
    expect(planIds).toEqual(ids.filter(id => !range('D', 1, 14).includes(id)))
    expect([...OPTIONAL_CHECKS]).toEqual(['R07'])
    // The regression runs step 3's own desktop items (D01–D10 are step 2's), not copies that could drift.
    const step3Desktop = STEP3_CHECKS.filter(c => c.layer === 'desktop')
    expect(step3Desktop.map(c => c.id)).toEqual(range('D', 1, 14))
    for (const check of step3Desktop) expect(CHECKS.find(c => c.id === check.id)?.run).toBe(check.run)
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
    expect(await evaluateItem(h19, { step3Error: 'boom' })).toEqual({ status: 'failed', evidence: 'step 3 headless scenario failed: boom' })
    expect(await evaluateItem(h19, { step3: {} })).toMatchObject({ status: 'failed', evidence: expect.stringMatching(/23 of 23 did not pass/) })
    for (const id of STEP4) {
      const check = CHECKS.find(c => c.id === id)!
      expect(await evaluateItem(check, { step4Error: 'boom' }), id).toEqual({ status: 'failed', evidence: 'step 4 headless scenario failed: boom' })
      expect(await evaluateItem(check, {}), id).toEqual({ status: 'failed', evidence: 'step 4 headless scenario did not run' })
    }
  })

  it('real-model facts follow the user decisions: thinking on, 15 USD', () => {
    expect(REAL_MODEL).toMatchObject({ model: 'claude-sonnet-5-5', thinking: 'on', budgetUsd: 15 })
    expect(realModelKeySource({ ANTHROPIC_API_KEY: 'k' })).toBe('ANTHROPIC_API_KEY')
    expect(realModelKeySource({ NEXGENT_API_KEY: '' })).toBeUndefined()
  })
})

describe('H19 verdict (step 3 regression)', () => {
  const ids = Object.keys(STEP3_JUDGES)
  const pass: CheckResult = { status: 'passed', evidence: 'ok' }
  const all = (status: CheckResult) => ids.map(id => [id, status] as const)

  it('passes only when all of step 3 H01–H23 passed', () => {
    expect(ids).toEqual(range('H', 1, 23))
    expect(regressionVerdict(all(pass))).toEqual({ status: 'passed', evidence: 'step 3 H01–H23: all 23 passed' })
  })

  it('fails on one failed item, naming it with its first evidence line', () => {
    const results = all(pass).map(([id, r]) => (id === 'H14' ? [id, { status: 'failed', evidence: 'approval lost\nstack' }] as const : [id, r] as const))
    expect(regressionVerdict(results)).toEqual({ status: 'failed', evidence: 'step 3 regression: 1 of 23 did not pass (H14 failed: approval lost)' })
  })

  it('fails on a not-implemented or missing item', () => {
    const notImpl = all(pass).map(([id, r]) => (id === 'H01' ? [id, { status: 'not-implemented', evidence: 'x' }] as const : [id, r] as const))
    expect(regressionVerdict(notImpl)).toMatchObject({ status: 'failed', evidence: expect.stringContaining('H01 not-implemented') })
    expect(regressionVerdict(all(pass).filter(([id]) => id !== 'H23'))).toMatchObject({ status: 'failed', evidence: expect.stringContaining('H23 not judged') })
  })
})

describe('real-layer prerequisites', () => {
  it('without a key or over budget: not runnable; with both: runnable, never returns the key', () => {
    expect(realPrerequisites({}, 15, [])).toEqual({ ok: false, reason: 'no API key (NEXGENT_API_KEY or ANTHROPIC_API_KEY is not set)' })
    expect(realPrerequisites({ NEXGENT_API_KEY: 'sk-secret-xyz' }, 15, [10, 5])).toMatchObject({ ok: false, reason: expect.stringMatching(/reached the 15 USD cap/) })
    expect(realPrerequisites({ NEXGENT_API_KEY: 'sk-secret-xyz' }, 15, ['unknown'])).toMatchObject({ ok: false, reason: expect.stringMatching(/unknown cost/) })
    const ready = realPrerequisites({ NEXGENT_API_KEY: 'sk-secret-xyz' }, 15, [0.79])
    expect(ready).toEqual({ ok: true, keySource: 'NEXGENT_API_KEY', remainingUsd: 14.21 })
    expect(JSON.stringify(ready)).not.toContain('sk-secret-xyz')
  })
})

describe('scripts/accept-step4.mjs (requires `pnpm build`)', () => {
  async function runScript(args: string[], env: NodeJS.ProcessEnv = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'nexgent-accept4-test-'))
    try {
      const out = join(dir, 'summary.json')
      const childEnv = { ...process.env, ...env }
      for (const [key, value] of Object.entries(env)) if (value === undefined) delete childEnv[key]
      const result = spawnSync(process.execPath, [script, '--out', out, '--work-dir', join(dir, 'work'), ...args], { encoding: 'utf8', env: childEnv, timeout: 150_000 })
      const raw = await readFile(out, 'utf8').catch(() => '')
      const summary = raw === '' ? undefined : JSON.parse(raw) as AcceptanceSummary
      return { result, summary, raw }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  // The gate (W3) has not landed: its items, and H14's adoption half, say so; nothing fails.
  it('headless layer: the landed items pass, the gate items name the missing part, exit 2, valid summary', async () => {
    const { result, summary } = await runScript(['--layer', 'headless'])
    expect(result.status, result.stderr).toBe(EXIT_NOT_READY)
    expect(validateAcceptanceSummary(summary)).toEqual({ valid: true, errors: [] })
    expect(summary?.result).toBe('fail')
    const items = (summary?.checks ?? []).filter(check => check.id !== undefined)
    expect(items.map(check => check.id)).toEqual(range('H', 1, 19))
    for (const check of items) {
      if (check.id === 'H19') expect(check).toMatchObject({ status: 'passed', passed: true, detail: 'step 3 H01–H23: all 23 passed' })
      else if (PASSING.includes(check.id!)) expect(check, `${check.id}: ${check.detail}`).toMatchObject({ status: 'passed', passed: true })
      else expect(check, `${check.id}: ${check.detail}`).toMatchObject({ status: 'not-implemented', passed: false, detail: expect.stringMatching(/the gate \(W3\)|the gate is present, but this item's scenario is not written yet/) })
    }
    // The midterm checkpoint: four named checks outside the checklist, all met.
    const points = (summary?.checks ?? []).filter(check => check.id === undefined)
    expect(points.map(check => check.name.slice(0, 7))).toEqual(['中期检查点 1', '中期检查点 2', '中期检查点 3', '中期检查点 4'])
    for (const point of points) expect(point, `${point.name}: ${point.detail}`).toMatchObject({ passed: true, detail: expect.stringMatching(/^passed: /) })
  }, 240_000)

  it('real layer: not runnable without a key, and with a key still calls no model (nothing wired); exit 2 both ways', async () => {
    const keyless = await runScript(['--layer', 'real'], { NEXGENT_API_KEY: undefined, ANTHROPIC_API_KEY: undefined })
    expect(keyless.result.status, keyless.result.stderr).toBe(EXIT_NOT_READY)
    expect(keyless.result.stderr).toContain('no API key')
    expect(validateAcceptanceSummary(keyless.summary)).toEqual({ valid: true, errors: [] })
    expect(keyless.summary?.checks.map(check => check.id)).toEqual(range('R', 1, 6))
    for (const check of keyless.summary?.checks ?? []) expect(check).toMatchObject({ passed: false, status: 'not-implemented' })

    const key = 'sk-ant-accept4-test-value'
    // A base URL nothing listens on: any model call would fail loudly instead of reaching a real API.
    const keyed = await runScript(['--layer', 'real'], { NEXGENT_API_KEY: key, NEXGENT_API_BASE_URL: 'http://127.0.0.1:9' })
    expect(keyed.result.status, keyed.result.stderr).toBe(EXIT_NOT_READY)
    expect(keyed.summary?.realModel).toBeNull()
    for (const check of keyed.summary?.checks ?? []) expect(check).toMatchObject({ passed: false, status: 'not-implemented' })
    expect(keyed.raw + keyed.result.stderr + keyed.result.stdout).not.toContain(key)
  }, 90_000)

  it('rejects an unknown layer with exit 1', async () => {
    const { result } = await runScript(['--layer', 'ui'])
    expect(result.status).toBe(EXIT_FAIL)
  }, 90_000)
})
