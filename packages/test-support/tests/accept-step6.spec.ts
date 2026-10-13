import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CHECKS as STEP5_CHECKS } from '../../../scripts/accept-common/step5-checks.mjs'
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
  STEP5_HEADLESS,
  type CheckResult,
} from '../../../scripts/accept-common/step6-checks.mjs'
import { COST_WIN_FRACTION, PLAYBOOKS, referenceImproverDecision, type ArmRecord } from '../../../scripts/accept-common/step6-improver-rule.mjs'
import { validateAcceptanceSummary, type AcceptanceSummary } from '../src/index.js'

const script = fileURLToPath(new URL('../../../scripts/accept-step6.mjs', import.meta.url))
const plan = fileURLToPath(new URL('../../../docs/plan/step-6-work-partition.md', import.meta.url))
const range = (prefix: string, from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${String(from + i).padStart(2, '0')}`)

/** Round 1: only the regressions are wired (H18 = step 5 H01–H19; D01–D23 = step 5's desktop items). */
const WIRED = new Set(['H18', ...range('D', 1, 23)])

describe('accept-step6 checklist', () => {
  it('has every item of the step-6 plan in order, plus the D01–D23 regression', async () => {
    const ids = CHECKS.map(check => check.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual([...range('H', 1, 18), ...range('D', 1, 27), ...range('E', 1, 4), ...range('R', 1, 8)])
    for (const check of CHECKS) expect(LAYERS[check.layer].prefix).toBe(check.id[0])
    // The plan's tables are the source of truth; D01–D23 come from steps 2–5 and are not in them.
    const planIds = [...(await readFile(plan, 'utf8')).matchAll(/^\| ([HDER]\d\d) \|/gm)].map(match => match[1])
    expect(planIds).toEqual(ids.filter(id => !range('D', 1, 23).includes(id)))
    expect([...OPTIONAL_CHECKS]).toEqual(['R07', 'R08'])
    // The regressions run step 5's own items, not copies that could drift.
    const step5Desktop = STEP5_CHECKS.filter(c => c.layer === 'desktop')
    expect(step5Desktop.map(c => c.id)).toEqual(range('D', 1, 23))
    for (const check of step5Desktop) expect(CHECKS.find(c => c.id === check.id)?.run).toBe(check.run)
    expect(STEP5_HEADLESS.map(c => c.id)).toEqual(range('H', 1, 19))
    expect(STEP5_HEADLESS.every(c => typeof c.run === 'function')).toBe(true)
  })

  it('selects layers: default headless + desktop + experiment; real only when asked; unknown rejected', () => {
    expect(parseLayers(undefined)).toEqual({ ok: true, layers: ['headless', 'desktop', 'experiment'] })
    expect(parseLayers('real')).toEqual({ ok: true, layers: ['real'] })
    expect(parseLayers('real,experiment')).toEqual({ ok: true, layers: ['experiment', 'real'] })
    expect(parseLayers('all')).toEqual({ ok: true, layers: ['headless', 'desktop', 'experiment', 'real'] })
    expect(parseLayers('ui')).toMatchObject({ ok: false })
  })

  it('nothing fakes a pass: unwired items are not-implemented, wired ones fail without observations', async () => {
    expect(new Set(CHECKS.filter(c => c.run !== undefined).map(c => c.id))).toEqual(WIRED)
    for (const check of CHECKS) {
      const result = await evaluateItem(check, {})
      expect(result.status, check.id).toBe(WIRED.has(check.id) ? 'failed' : 'not-implemented')
    }
    const crashed = await evaluateItem(CHECKS.find(c => c.id === 'H18')!, { regressionError: 'boom' })
    expect(crashed).toMatchObject({ status: 'failed', evidence: expect.stringContaining('boom') })
  })

  it('real-model facts follow the user decisions: sonnet 5.5, thinking on, 35 USD for step 6', () => {
    expect(REAL_MODEL).toMatchObject({ model: 'claude-sonnet-5-5', thinking: 'on', budgetUsd: 35 })
    expect(realModelKeySource({ ANTHROPIC_API_KEY: 'x' })).toBe('ANTHROPIC_API_KEY')
    expect(realModelKeySource({ NEXGENT_API_KEY: 'a', ANTHROPIC_API_KEY: 'b' })).toBe('NEXGENT_API_KEY')
    expect(realModelKeySource({ NEXGENT_API_KEY: '' })).toBeUndefined()
  })
})

describe('H18 verdict (step 5 regression)', () => {
  const pass: CheckResult = { status: 'passed', evidence: 'ok' }
  const all = (result: CheckResult) => STEP5_HEADLESS.map(c => [c.id, result] as const)

  it('passes only when all of step 5 H01–H19 passed', () => {
    expect(regressionVerdict(all(pass))).toMatchObject({ status: 'passed', evidence: expect.stringContaining('all 19 passed') })
  })

  it('fails on one failed item, naming it with its first evidence line', () => {
    const one = all(pass).map(([id, r]) => (id === 'H07' ? [id, { status: 'failed', evidence: 'two components\nmore' }] as const : [id, r] as const))
    const verdict = regressionVerdict(one)
    expect(verdict).toMatchObject({ status: 'failed', evidence: expect.stringContaining('H07 failed: two components') })
    expect(verdict.evidence).not.toContain('more')
  })

  it('fails on a not-implemented or missing item', () => {
    const notImpl = all(pass).map(([id, r]) => (id === 'H01' ? [id, { status: 'not-implemented', evidence: 'x' }] as const : [id, r] as const))
    expect(regressionVerdict(notImpl)).toMatchObject({ status: 'failed', evidence: expect.stringContaining('H01 not-implemented') })
    expect(regressionVerdict(all(pass).filter(([id]) => id !== 'H19'))).toMatchObject({ status: 'failed', evidence: expect.stringContaining('H19 not judged') })
  })
})

describe('parent / child improver rule (the judge\'s recomputation for H10, user decision 4)', () => {
  const arm = (over: Partial<ArmRecord> = {}): ArmRecord => ({ descendant: true, gatePassed: true, quality: 1, costUsd: 1, ...over })
  const decide = (parent: Partial<ArmRecord>, child: Partial<ArmRecord>) => referenceImproverDecision(arm(parent), arm(child))

  it('any unknown in either arm is never adopted, even when the child looks better', () => {
    expect(decide({ gatePassed: false }, { costUsd: 'unknown' })).toMatchObject({ adopt: false, reason: 'unknown' })
    expect(decide({ quality: 'unknown' }, { quality: 2 })).toMatchObject({ adopt: false, reason: 'unknown' })
    expect(decide({ descendant: 'unknown' }, {})).toMatchObject({ adopt: false, reason: 'unknown' })
    expect(referenceImproverDecision(undefined, arm())).toMatchObject({ adopt: false, reason: 'unknown' })
    expect(decide({}, { quality: Number.NaN })).toMatchObject({ adopt: false, reason: 'unknown' })
  })

  it('a child without a descendant is not adopted, whatever the parent did', () => {
    expect(decide({ gatePassed: false }, { descendant: false, gatePassed: 'unknown', quality: 'unknown' })).toMatchObject({ adopt: false, reason: 'no-descendant' })
    expect(decide({ descendant: false, gatePassed: 'unknown', quality: 'unknown' }, { descendant: false, gatePassed: 'unknown', quality: 'unknown' })).toMatchObject({ adopt: false, reason: 'no-descendant' })
  })

  it('the child wins when its descendant passes the gate and the parent\'s does not (or the parent has none)', () => {
    expect(decide({ gatePassed: false, quality: 0.67 }, { quality: 0.67, costUsd: 5 })).toMatchObject({ adopt: true, reason: 'gate-win' })
    expect(decide({ descendant: false, gatePassed: 'unknown', quality: 'unknown' }, {})).toMatchObject({ adopt: true, reason: 'gate-win' })
    expect(decide({}, { gatePassed: false, quality: 2 })).toMatchObject({ adopt: false, reason: 'no-gain' })
    expect(decide({ gatePassed: false }, { gatePassed: false, quality: 2, costUsd: 0.1 })).toMatchObject({ adopt: false, reason: 'no-gain' })
  })

  it('both passed: higher quality wins; equal quality needs at least 10% lower cost', () => {
    expect(COST_WIN_FRACTION).toBe(0.1)
    expect(decide({ quality: 0.67 }, { quality: 1, costUsd: 3 })).toMatchObject({ adopt: true, reason: 'quality-win' })
    expect(decide({ quality: 1 }, { quality: 0.67, costUsd: 0.1 })).toMatchObject({ adopt: false, reason: 'no-gain' })
    expect(decide({ costUsd: 1 }, { costUsd: 0.85 })).toMatchObject({ adopt: true, reason: 'cost-win' })
    expect(decide({ costUsd: 1 }, { costUsd: 0.9 })).toMatchObject({ adopt: true, reason: 'cost-win' })
    expect(decide({ costUsd: 1 }, { costUsd: 0.95 })).toMatchObject({ adopt: false, reason: 'no-gain' })
    expect(decide({ costUsd: 1 }, { costUsd: 1 })).toMatchObject({ adopt: false, reason: 'no-gain' })
  })

  it('the scripted playbooks cover the four plan scenarios and their arms decide as expected', () => {
    expect(PLAYBOOKS.map(p => p.id)).toEqual(['improve-the-improver', 'improver-is-fine', 'child-is-worse', 'out-of-bounds-change'])
    for (const playbook of PLAYBOOKS) {
      if (playbook.arms === null) {
        expect(playbook.expect.status, playbook.id).not.toBe('adopted')
        continue
      }
      const decision = referenceImproverDecision(playbook.arms.parent, playbook.arms.child)
      expect(decision.reason, playbook.id).toBe(playbook.expect.reason)
      expect(decision.adopt, playbook.id).toBe(playbook.expect.status === 'adopted')
      expect(playbook.expect.nextJobUsesChild, playbook.id).toBe(decision.adopt)
    }
    expect(PLAYBOOKS.find(p => p.id === 'improver-is-fine')?.metaDiagnosis.proposalKind).toBe('none')
    expect(PLAYBOOKS.find(p => p.id === 'out-of-bounds-change')?.change?.field).toBe('costApprovalRatio')
  })
})

describe('scripts/accept-step6.mjs (requires `pnpm build`)', () => {
  async function runScript(args: string[], env: NodeJS.ProcessEnv = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'nexgent-accept6-test-'))
    try {
      const out = join(dir, 'summary.json')
      const childEnv = { ...process.env, ...env }
      for (const [key, value] of Object.entries(env)) if (value === undefined) delete childEnv[key]
      const result = spawnSync(process.execPath, [script, '--out', out, '--work-dir', join(dir, 'work'), ...args], { encoding: 'utf8', env: childEnv, timeout: 120_000 })
      const raw = await readFile(out, 'utf8').catch(() => '')
      const summary = raw === '' ? undefined : JSON.parse(raw) as AcceptanceSummary
      return { result, summary, raw }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  it('experiment layer: not runnable before scripts/experiment/step6 exists, or not wired; exit 2, E01–E04 not-implemented', async () => {
    const { result, summary } = await runScript(['--layer', 'experiment'])
    expect(result.status, result.stderr).toBe(EXIT_NOT_READY)
    expect(validateAcceptanceSummary(summary)).toEqual({ valid: true, errors: [] })
    expect(summary?.checks.map(check => check.id)).toEqual(range('E', 1, 4))
    for (const check of summary?.checks ?? []) expect(check).toMatchObject({ passed: false, status: 'not-implemented' })
  }, 150_000)

  it('real layer: no model call; without a key or with one, exit 2 and nothing passes; the key never appears', async () => {
    const keyless = await runScript(['--layer', 'real'], { NEXGENT_API_KEY: undefined, ANTHROPIC_API_KEY: undefined })
    expect(keyless.result.status, keyless.result.stderr).toBe(EXIT_NOT_READY)
    expect(keyless.result.stderr).toContain('no API key')
    expect(validateAcceptanceSummary(keyless.summary)).toEqual({ valid: true, errors: [] })
    expect(keyless.summary?.checks.map(check => check.id)).toEqual(range('R', 1, 6))

    const key = 'sk-ant-accept6-test-value'
    // A base URL nothing listens on: should anything try a model call it fails instead of reaching a real API.
    const keyed = await runScript(['--layer', 'real'], { NEXGENT_API_KEY: key, NEXGENT_API_BASE_URL: 'http://127.0.0.1:9' })
    expect(keyed.result.status, keyed.result.stderr).toBe(EXIT_NOT_READY)
    expect(validateAcceptanceSummary(keyed.summary)).toEqual({ valid: true, errors: [] })
    expect(keyed.summary?.realModel).toMatchObject({ result: 'fail', callCount: 0, cost: 0 })
    for (const check of keyed.summary?.checks ?? []) expect(check).toMatchObject({ passed: false, status: 'not-implemented' })
    expect(keyed.raw + keyed.result.stderr + keyed.result.stdout).not.toContain(key)
  }, 300_000)

  it('rejects an unknown layer with exit 1', async () => {
    const { result } = await runScript(['--layer', 'ui'])
    expect(result.status).toBe(EXIT_FAIL)
  }, 90_000)
})
