import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
} from '../../../scripts/accept-common/step3-checks.mjs'
import { CHECKS as STEP2_CHECKS } from '../../../scripts/accept-common/step2-checks.mjs'
import { judge, JUDGES } from '../../../scripts/accept-common/step3-judges.mjs'
import { repoInventory, runHeadlessScenario } from '../../../scripts/accept-common/step3-headless.mjs'
import { realPrerequisites } from '../../../scripts/accept-common/step3-real.mjs'
import { validateAcceptanceSummary, type AcceptanceSummary } from '../src/index.js'

const script = fileURLToPath(new URL('../../../scripts/accept-step3.mjs', import.meta.url))
const plan = fileURLToPath(new URL('../../../docs/plan/step-3-work-partition.md', import.meta.url))
const range = (prefix: string, from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${String(from + i).padStart(2, '0')}`)

/** The judges and step-2 regression items wired so far; everything else must report not-implemented. */
const WIRED = new Set(['H01', 'H02', 'H03', 'H04', 'H10', 'H12', 'H15', 'H16', 'H22', 'H23', ...range('D', 1, 10)])
/** Items the headless layer passes today (H10, H15, H22 wait for team and workflow). */
const PASSING = new Set<string>(['H01', 'H02', 'H03', 'H04', 'H12', 'H16', 'H23'])

describe('accept-step3 checklist', () => {
  it('has every item of the step-3 plan in order, plus the D01–D10 regression', async () => {
    const ids = CHECKS.map(check => check.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual([...range('H', 1, 23), ...range('D', 1, 14), ...range('R', 1, 8)])
    for (const check of CHECKS) expect(LAYERS[check.layer].prefix).toBe(check.id[0])
    // The plan's tables are the source of truth; D01–D10 come from step 2 and are not in them.
    const planIds = [...(await readFile(plan, 'utf8')).matchAll(/^\| ([HDR]\d\d) \|/gm)].map(match => match[1])
    expect(planIds).toEqual(ids.filter(id => !range('D', 1, 10).includes(id)))
    expect([...OPTIONAL_CHECKS]).toEqual(['R08'])
    // The regression runs step 2's own desktop items, not copies that could drift.
    expect(CHECKS.filter(c => WIRED.has(c.id) && c.id.startsWith('D')).map(c => c.id)).toEqual(STEP2_CHECKS.filter(c => c.layer === 'desktop').map(c => c.id))
  })

  it('selects layers: default headless + desktop; real only when asked; unknown rejected', () => {
    expect(parseLayers(undefined)).toEqual({ ok: true, layers: ['headless', 'desktop'] })
    expect(parseLayers('real')).toEqual({ ok: true, layers: ['real'] })
    expect(parseLayers('all')).toEqual({ ok: true, layers: ['headless', 'desktop', 'real'] })
    expect(parseLayers('ui')).toMatchObject({ ok: false })
  })

  it('nothing fakes a pass: unwired items are not-implemented, wired ones fail without observations', async () => {
    expect(Object.keys(JUDGES)).toEqual(['H01', 'H02', 'H03', 'H04', 'H10', 'H12', 'H15', 'H16', 'H22', 'H23'])
    for (const check of CHECKS) {
      const result = await evaluateItem(check, { obs: {} })
      if (WIRED.has(check.id)) expect(result.status, check.id).not.toBe('passed')
      else expect(result, check.id).toEqual({ status: 'not-implemented', evidence: 'not implemented yet' })
    }
    // A crashed scenario fails every wired item of its layer.
    for (const id of ['H23', 'D01', 'D08']) {
      expect(await evaluateItem(CHECKS.find(c => c.id === id)!, { scenarioError: 'boom' })).toMatchObject({ status: 'failed' })
    }
  })

  it('real-model facts follow the user decisions: thinking on, 15 USD, five runs', () => {
    expect(REAL_MODEL).toMatchObject({ model: 'claude-sonnet-5-5', thinking: 'on', budgetUsd: 15, runs: 5 })
    expect(realModelKeySource({ ANTHROPIC_API_KEY: 'k' })).toBe('ANTHROPIC_API_KEY')
    expect(realModelKeySource({ NEXGENT_API_KEY: '' })).toBeUndefined()
  })
})

describe('H23 judge (no Python on trunk)', () => {
  const clean = ['README.md', 'packages/kernel/src/index.ts', 'packages/context/tests/instructions.spec.ts', 'docs/tests.md', 'scripts/stage-notes.mjs']
  const h23 = (files: string[] | undefined) => judge('H23', files === undefined ? {} : { repo: { source: 'test', files } })

  it('passes a clean tree (nested tests/ dirs and look-alike names are fine)', () => {
    expect(h23(clean)).toMatchObject({ status: 'passed' })
  })

  it.each([
    ['a Python file anywhere', [...clean, 'scripts/tool.py']],
    ['an upper-case .PY file', [...clean, 'a/B.PY']],
    ['the old nexgent/ package', [...clean, 'nexgent/__init__.md']],
    ['a stage-* directory', [...clean, 'stage-3/README.md']],
    ['the old top-level tests/', [...clean, 'tests/README.md']],
    ['config.py', [...clean, 'config.py']],
    ['runtime/', [...clean, 'runtime/state.json']],
  ])('fails on %s', (_label, files) => {
    expect(h23(files)).toMatchObject({ status: 'failed' })
  })

  it('fails when no file list was collected', () => {
    expect(h23(undefined)).toMatchObject({ status: 'failed' })
    expect(h23([])).toMatchObject({ status: 'failed' })
  })

  it('the repository itself passes; a non-git tree is walked instead', async () => {
    const repo = await repoInventory()
    expect(repo.source).toBe('git ls-files')
    expect(judge('H23', { repo })).toMatchObject({ status: 'passed' })
    const dir = await mkdtemp(join(tmpdir(), 'nexgent-h23-'))
    try {
      await mkdir(join(dir, 'stage-1', 'node_modules'), { recursive: true })
      await writeFile(join(dir, 'stage-1', 'run.py'), '')
      await writeFile(join(dir, 'stage-1', 'node_modules', 'skip.py'), '')
      const obs = await runHeadlessScenario(undefined, dir, { root: dir })
      expect(obs.repo).toEqual({ source: 'directory walk', files: ['stage-1/run.py'] })
      expect(judge('H23', obs)).toMatchObject({ status: 'failed' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('real-layer prerequisites', () => {
  it('without a key, over budget, or (for now) unwired: never runnable, never returns the key', () => {
    expect(realPrerequisites({}, 15, [])).toEqual({ ok: false, reason: 'no API key (NEXGENT_API_KEY or ANTHROPIC_API_KEY is not set)' })
    expect(realPrerequisites({ NEXGENT_API_KEY: 'sk-secret-xyz' }, 15, [10, 5])).toMatchObject({ ok: false, reason: expect.stringMatching(/reached the 15 USD cap/) })
    expect(realPrerequisites({ NEXGENT_API_KEY: 'sk-secret-xyz' }, 15, ['unknown'])).toMatchObject({ ok: false, reason: expect.stringMatching(/unknown cost/) })
    const unwired = realPrerequisites({ NEXGENT_API_KEY: 'sk-secret-xyz' }, 15, [1.26])
    expect(unwired).toMatchObject({ ok: false, reason: expect.stringMatching(/NEXGENT_API_KEY, 13\.74 USD left, .*not wired yet/) })
    expect(JSON.stringify(unwired)).not.toContain('sk-secret-xyz')
  })
})

describe('scripts/accept-step3.mjs (requires `pnpm build`)', () => {
  async function runScript(args: string[], env: NodeJS.ProcessEnv = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'nexgent-accept3-test-'))
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

  it('headless layer: the delegation items, H01 and H23 pass, every other item is not-implemented, exit 2, valid summary', async () => {
    const { result, summary } = await runScript(['--layer', 'headless'])
    expect(result.status, result.stderr).toBe(EXIT_NOT_READY)
    expect(validateAcceptanceSummary(summary)).toEqual({ valid: true, errors: [] })
    expect(summary?.result).toBe('fail')
    expect(summary?.checks.map(check => check.id)).toEqual(range('H', 1, 23))
    for (const check of summary?.checks ?? []) {
      expect(check, check.id).toMatchObject(PASSING.has(check.id ?? '') ? { status: 'passed', passed: true } : { status: 'not-implemented', passed: false })
    }
  }, 180_000)

  it('real layer: without a key it is not runnable (exit 2), calls no model, lists R01–R07', async () => {
    const { result, summary } = await runScript(['--layer', 'real'], { NEXGENT_API_KEY: undefined, ANTHROPIC_API_KEY: undefined })
    expect(result.status, result.stderr).toBe(EXIT_NOT_READY)
    expect(result.stderr).toContain('no API key')
    expect(validateAcceptanceSummary(summary)).toEqual({ valid: true, errors: [] })
    expect(summary?.checks.map(check => check.id)).toEqual(range('R', 1, 7))
    for (const check of summary?.checks ?? []) expect(check).toMatchObject({ passed: false, status: 'not-implemented' })
    expect(summary?.realModel).toMatchObject({ model: 'claude-sonnet-5-5', thinking: 'on', callCount: 0, result: 'fail' })
  }, 90_000)

  it('real layer with a key: still exit 2 until wired, and the key value is never written', async () => {
    const key = 'sk-ant-accept3-test-value'
    const { result, raw } = await runScript(['--layer', 'real'], { NEXGENT_API_KEY: key, NEXGENT_API_BASE_URL: 'http://127.0.0.1:9' })
    expect(result.status, result.stderr).toBe(EXIT_NOT_READY)
    expect(result.stderr).toContain('not wired yet')
    expect(raw).not.toBe('')
    expect(raw + result.stderr + result.stdout).not.toContain(key)
  }, 90_000)

  it('rejects an unknown layer with exit 1', async () => {
    const { result } = await runScript(['--layer', 'ui'])
    expect(result.status).toBe(EXIT_FAIL)
  }, 90_000)
})
