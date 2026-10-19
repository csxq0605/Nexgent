import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
  EXIT_PASS,
  LAYERS,
  OPTIONAL_CHECKS,
  parseLayers,
  REAL_MODEL,
  realModelKeySource,
  regressionVerdict,
  REWORK_EXPECTATIONS,
  REWORK_ITEMS,
  STEP5_HEADLESS,
  type CheckResult,
} from '../../../scripts/accept-common/step6-checks.mjs'
import { arm, changeFor, COST_DOWN_RATIO, PLAYBOOKS, referenceImproverDecision, type ArmLike, type OriginLike } from '../../../scripts/accept-common/step6-improver-rule.mjs'
import { judgePilotReport, judgePinned, judgeReport, judgeSets, judgeStore, judgeV0 } from '../../../scripts/accept-common/step6-judges.mjs'
import { loadExperiment, pilotReportObservation, reportObservation, setsObservation } from '../../../scripts/accept-common/step6-experiment.mjs'
import { loadCapabilities, storePhase } from '../../../scripts/accept-common/step6-headless.mjs'
import * as kernel from '@nexgent/kernel'
import { validateAcceptanceSummary, type AcceptanceSummary } from '../src/index.js'

const script = fileURLToPath(new URL('../../../scripts/accept-step6.mjs', import.meta.url))
const range = (prefix: string, from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${String(from + i).padStart(2, '0')}`)

/** Wired: every headless (H19–H24 since R7 round 3), desktop and experiment item; the real layer is not. */
const WIRED = new Set([...range('H', 1, 24), ...range('D', 1, 27), ...range('E', 1, 4)])
const experimentDir = fileURLToPath(new URL('../../../scripts/experiment/step6', import.meta.url))

describe('accept-step6 checklist', () => {
  it('has every item of the step-6 plan in order, plus the D01–D23 regression', async () => {
    const ids = CHECKS.map(check => check.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual([...range('H', 1, 24), ...range('D', 1, 27), ...range('E', 1, 4), ...range('R', 1, 8)])
    for (const check of CHECKS) expect(LAYERS[check.layer].prefix).toBe(check.id[0])
    expect(REWORK_ITEMS).toEqual(range('H', 19, 24))
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

  it('rework (ADR 0011–0013): H19–H24 wired; every expectation names an existing item once, with a reason', async () => {
    for (const id of REWORK_ITEMS) {
      const check = CHECKS.find(c => c.id === id)
      expect(check?.layer, id).toBe('headless')
      expect(typeof check?.run, id).toBe('function')
      expect(check?.title, id).toMatch(/ADR 001[23]/)
      expect(await evaluateItem(check!, {}), id).toMatchObject({ status: 'failed' })
      expect(await evaluateItem(check!, { step6ReworkError: 'boom' }), id).toMatchObject({ status: 'failed', evidence: expect.stringContaining('boom') })
    }
    const step5Ids = new Set(STEP5_CHECKS.map(c => c.id))
    const step6Ids = new Set(CHECKS.map(c => c.id))
    const keys = REWORK_EXPECTATIONS.map(e => `${e.step}:${e.id}`)
    expect(new Set(keys).size).toBe(keys.length)
    for (const e of REWORK_EXPECTATIONS) {
      expect((e.step === 5 ? step5Ids : step6Ids).has(e.id), `${e.step}:${e.id}`).toBe(true)
      expect(['change', 'verify', 'rewritten']).toContain(e.kind)
      expect(['0011', '0012', '0013']).toContain(e.adr)
      expect(e.why.length, `${e.step}:${e.id}`).toBeGreaterThan(10)
      expect(REWORK_ITEMS.includes(e.id) && e.step === 6, `${e.id} is new, not a changed item`).toBe(false)
    }
    // The items whose own wording the ADRs reversed were rewritten on the user's decision, not removed.
    const rewritten = REWORK_EXPECTATIONS.filter(e => e.kind === 'rewritten')
    expect(rewritten.map(e => `${e.step}:${e.id}`)).toEqual(['6:H15', '6:E03', '6:R03', '6:R04', '6:R05', '6:R06', '6:R07'])
    for (const e of rewritten) {
      expect(e.decided, e.id).toBe('2026-10-14 08:12 按推薦')
      const check = CHECKS.find(c => c.id === e.id)
      expect(check?.title, e.id).toMatch(/ADR 001[12]/)
    }
    expect(REWORK_EXPECTATIONS.some(e => e.kind === 'stale')).toBe(false)
  })

  it('real-model facts follow the user decisions: sonnet 5.5, thinking on, 40 USD for step 6', () => {
    expect(REAL_MODEL).toMatchObject({ model: 'claude-sonnet-5-5', thinking: 'on', budgetUsd: 40, pilotGateUsd: 12 })
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

describe('parent / child improver rule (the judge\'s recomputation for H10; ADR 0008 decision 4, ADR 0009 origin kind)', () => {
  const origin: OriginLike = { kind: 'unresolved', sourceJobId: 'job-1', tree: 't'.repeat(64), feedbackIds: ['f2', 'f1'], capabilityVersion: 'c'.repeat(64), epoch: 'e'.repeat(64) }
  const make = (name: 'parent' | 'child', over: Record<string, unknown> = {}): ArmLike & Record<string, unknown> =>
    ({ ...arm(origin, name, { status: 'adopted', offspring: true, passRate: 1, costUsd: 1 }), ...over })
  const decide = (parent: Record<string, unknown>, child: Record<string, unknown>) => referenceImproverDecision(origin, make('parent', parent), make('child', child))
  const verdict = (passRate: number, reason = 'quality-up') => ({ verdict: { outcome: 'adopt', reason, passRate: { candidate: passRate, baseline: 0.67 } } })

  it('origins: a different epoch is epoch-mismatch, any other difference (the kind too) origin-mismatch; feedback order does not matter', () => {
    expect(decide({}, { origin: { ...origin, epoch: 'f'.repeat(64) } })).toEqual({ outcome: 'reject', reason: 'epoch-mismatch' })
    expect(decide({}, { origin: { ...origin, kind: 'feedback-version' } })).toEqual({ outcome: 'reject', reason: 'origin-mismatch' })
    expect(decide({ origin: { ...origin, tree: 'u'.repeat(64) } }, {})).toEqual({ outcome: 'reject', reason: 'origin-mismatch' })
    expect(decide({}, { origin: { ...origin, feedbackIds: ['f1'] } })).toEqual({ outcome: 'reject', reason: 'origin-mismatch' })
    expect(decide({}, { origin: { ...origin, feedbackIds: ['f1', 'f2'] }, cost: { estimatedUsd: 0.5 } })).toEqual({ outcome: 'adopt', reason: 'cost-down' })
    expect(referenceImproverDecision(undefined, make('parent'), make('child'))).toEqual({ outcome: 'reject', reason: 'unknown-arm' })
  })

  it('any unknown arm is never adopted, even when the child looks better', () => {
    expect(decide({ status: 'rejected' }, { cost: { estimatedUsd: 'unknown' } })).toMatchObject({ outcome: 'reject', reason: 'unknown-arm' })
    expect(decide({ status: 'interrupted' }, {})).toMatchObject({ reason: 'unknown-arm' })
    expect(decide({}, { status: 'trialing' })).toMatchObject({ reason: 'unknown-arm' })
    expect(decide({ status: 'failed', error: { code: 'llm/overloaded' } }, {})).toMatchObject({ reason: 'unknown-arm' })
    expect(decide({ status: 'rejected', verdict: { reason: 'unknown-runs', passRate: { candidate: 0 } } }, {})).toMatchObject({ reason: 'unknown-arm' })
    // The improver's own failure (invalid diagnosis) is a result, not unknown.
    expect(decide({ status: 'failed', error: { code: 'improvement/invalid-diagnosis' } }, {})).toMatchObject({ outcome: 'adopt', reason: 'gate-passed' })
  })

  it('a child without offspring is not adopted; a child whose offspring passes the gate where the parent\'s did not is', () => {
    expect(decide({ status: 'rejected' }, { status: 'no-proposal', candidateId: undefined, verdict: undefined })).toMatchObject({ outcome: 'reject', reason: 'no-offspring' })
    expect(decide({ status: 'rejected', ...verdict(0.67, 'no-improvement') }, { cost: { estimatedUsd: 5 } })).toEqual({ outcome: 'adopt', reason: 'gate-passed' })
    expect(decide({ status: 'no-proposal', candidateId: undefined, verdict: undefined }, {})).toEqual({ outcome: 'adopt', reason: 'gate-passed' })
    // Quality and cost never decide unless both passed.
    expect(decide({}, { status: 'rejected', ...verdict(1), cost: { estimatedUsd: 0.1 } })).toMatchObject({ outcome: 'reject', reason: 'no-improvement' })
    expect(decide({ status: 'rejected' }, { status: 'rejected', cost: { estimatedUsd: 0.1 } })).toMatchObject({ outcome: 'reject', reason: 'no-improvement' })
  })

  it('both passed: higher quality wins; equal quality needs at least 10% lower cost (exactly 10% counts)', () => {
    expect(COST_DOWN_RATIO).toBe(kernel.IMPROVER_COST_DOWN_RATIO)
    expect(decide(verdict(0.67), { ...verdict(1), cost: { estimatedUsd: 3 } })).toEqual({ outcome: 'adopt', reason: 'quality-up' })
    expect(decide(verdict(1), { ...verdict(0.67), cost: { estimatedUsd: 0.1 } })).toMatchObject({ outcome: 'reject', reason: 'no-improvement' })
    expect(decide({}, { cost: { estimatedUsd: 0.85 } })).toEqual({ outcome: 'adopt', reason: 'cost-down' })
    expect(decide({}, { cost: { estimatedUsd: 0.9 } })).toEqual({ outcome: 'adopt', reason: 'cost-down' })
    expect(decide({}, { cost: { estimatedUsd: 0.95 } })).toMatchObject({ reason: 'no-improvement' })
    expect(decide({ cost: { estimatedUsd: 0 } }, { cost: { estimatedUsd: 0 } })).toMatchObject({ reason: 'no-improvement' })
  })

  it('agrees with the product\'s decideImprover over a grid of arm records (outcome and reason)', () => {
    expect([...kernel.IMPROVER_DECISION_REASONS].sort()).toEqual(['cost-down', 'epoch-mismatch', 'gate-passed', 'no-improvement', 'no-offspring', 'origin-mismatch', 'quality-up', 'unknown-arm'])
    const statuses: Array<[string, Record<string, unknown>]> = [
      ['adopted', {}], ['rejected', {}], ['no-proposal', {}], ['failed', {}], ['failed', { error: { code: 'improvement/invalid-diagnosis', message: 'x' } }],
      ['failed', { error: { code: 'llm/overloaded', message: 'x' } }], ['interrupted', {}], ['budget-exhausted', {}], ['trialing', {}],
    ]
    const arms: Array<Record<string, unknown>> = []
    for (const [status, extra] of statuses) {
      for (const offspring of [true, false]) {
        for (const passRate of [null, 0.67, 1]) {
          for (const cost of [1, 0.9, 0.95, 0, 'unknown'] as const) {
            for (const trialReason of ['quality-up', 'unknown-runs']) {
              if (passRate === null && trialReason !== 'quality-up') continue
              arms.push({
                status, ...extra,
                ...(offspring ? { candidateId: 'cand' } : {}),
                ...(passRate === null ? {} : { verdict: { outcome: status === 'adopted' ? 'adopt' : 'reject', reason: trialReason, passRate: { candidate: passRate, baseline: 0.67 } } }),
                cost: { estimatedUsd: cost },
              })
            }
          }
        }
      }
    }
    const asArm = (name: 'parent' | 'child', fields: Record<string, unknown>, at: OriginLike = origin) => ({ arm: name, improverVersion: name === 'parent' ? 'v0' : 'a'.repeat(64), origin: at, jobId: `${name}-job`, ...fields })
    let compared = 0
    const reasons = new Set<string>()
    for (const parent of arms) {
      for (const child of arms) {
        const p = asArm('parent', parent)
        const c = asArm('child', child)
        const product = kernel.decideImprover(origin as never, p as never, c as never)
        const ours = referenceImproverDecision(origin, p, c)
        if (product.outcome !== ours.outcome || product.reason !== ours.reason) expect({ parent, child, product, ours }).toBeUndefined()
        reasons.add(ours.reason)
        compared += 1
      }
    }
    for (const at of [{ ...origin, epoch: 'f'.repeat(64) }, { ...origin, sourceJobId: 'job-2' }, { ...origin, feedbackIds: ['f1', 'f2'] }, { ...origin, kind: 'feedback-version' }]) {
      const p = asArm('parent', arms[0]!)
      const c = asArm('child', arms[0]!, at)
      const product = kernel.decideImprover(origin as never, p as never, c as never)
      expect(referenceImproverDecision(origin, p, c), JSON.stringify(at)).toMatchObject({ outcome: product.outcome, reason: product.reason })
      reasons.add(product.reason)
    }
    expect(compared).toBeGreaterThan(10_000)
    expect([...reasons].sort()).toEqual([...kernel.IMPROVER_DECISION_REASONS].sort())
  })

  it('the scripted playbooks cover the four plan scenarios; their changes and arms decide as the product would', () => {
    expect(PLAYBOOKS.map(p => p.id)).toEqual(['improve-the-improver', 'improver-is-fine', 'child-is-worse', 'out-of-bounds-change'])
    const checked = PLAYBOOKS.map(p => [p.id, p.change === null ? null : kernel.checkImproverChange(kernel.IMPROVER_V0, changeFor(p, kernel.IMPROVER_V0))] as const)
    expect(checked.map(([id, check]) => [id, check === null ? null : check.ok ? 'ok' : check.refusal])).toEqual([
      ['improve-the-improver', 'ok'], ['improver-is-fine', null], ['child-is-worse', 'ok'], ['out-of-bounds-change', 'evaluator-field'],
    ])
    for (const playbook of PLAYBOOKS) {
      if (playbook.arms === null) {
        expect(playbook.expect.status, playbook.id).not.toBe('adopted')
        continue
      }
      const parent = arm(origin, 'parent', playbook.arms.parent)
      const child = arm(origin, 'child', playbook.arms.child)
      const decision = referenceImproverDecision(origin, parent, child)
      expect(decision, playbook.id).toEqual({ outcome: playbook.expect.status === 'adopted' ? 'adopt' : 'reject', reason: playbook.expect.reason })
      expect(kernel.decideImprover(origin as never, parent as never, child as never), playbook.id).toMatchObject(decision)
      expect(playbook.expect.nextJobUsesChild, playbook.id).toBe(decision.outcome === 'adopt')
    }
    expect(PLAYBOOKS.find(p => p.id === 'improver-is-fine')?.metaDiagnosis.proposalKind).toBe('none')
  })
})

describe('step-6 judges (counterexamples)', () => {
  const C = 'c'.repeat(64)
  const passedRegression: CheckResult = { status: 'passed', evidence: 'step 5 H01–H19: all 19 passed' }

  const homes = [{ home: 'main/home', bundles: 0, revisions: 0 }]

  it('H01: v0 everywhere passes; a job on another version, an improvers dir, a failed step-5 item or no jobs fail', () => {
    const project = (over: Record<string, unknown> = {}) => ({
      root: 'main/project',
      jobs: [{ jobId: 'job-aaaaaaaa', status: 'adopted', improverVersion: 'v0', improverScope: 'user', history: ['queued', 'diagnosing', 'adopted'] }, { jobId: 'job-bbbbbbbb', status: 'budget-exhausted', history: ['queued', 'budget-exhausted'] }],
      sessions: [{ id: 'session-1', jobId: 'job-aaaaaaaa', phase: 'diagnose', improverVersion: 'v0', improverScope: 'user' }],
      ledger: [{ type: 'llm.request.end', improvementId: 'job-aaaaaaaa', improvementPhase: 'diagnose', improverVersion: 'v0', improverScope: 'user' }, { type: 'llm.request.end', improvementId: 'job-aaaaaaaa', improvementPhase: 'trial', improverScope: 'user' }],
      improversDir: false,
      ...over,
    })
    expect(judgeV0({ homes, projects: [project()] }, passedRegression)).toMatchObject({ status: 'passed' })
    expect(judgeV0({ homes, projects: [project({ jobs: [{ jobId: 'job-cccccccc', status: 'adopted', improverVersion: C, history: [] }] })] }, passedRegression)).toMatchObject({ status: 'failed', evidence: expect.stringContaining('pinned') })
    expect(judgeV0({ homes, projects: [project({ jobs: [{ jobId: 'job-cccccccc', status: 'adopted', history: ['diagnosing'] }] })] }, passedRegression)).toMatchObject({ status: 'failed', evidence: expect.stringContaining('without improverVersion') })
    expect(judgeV0({ homes, projects: [project({ improversDir: true })] }, passedRegression)).toMatchObject({ status: 'failed', evidence: expect.stringContaining('.nexgent/improvers/') })
    expect(judgeV0({ homes, projects: [project({ ledger: [{ type: 'llm.request.end', improvementId: 'x', improvementPhase: 'trial', improverVersion: C }] })] }, passedRegression)).toMatchObject({ status: 'failed', evidence: expect.stringContaining('not on v0') })
    expect(judgeV0({ homes, projects: [project()] }, { status: 'failed', evidence: 'H07 failed' })).toMatchObject({ status: 'failed', evidence: expect.stringContaining('H07 failed') })
    // ADR 0012: the line is the user's; jobs, headers and ledger say improverScope user.
    expect(judgeV0({ projects: [project()], homes: [] }, passedRegression)).toMatchObject({ status: 'failed', evidence: expect.stringContaining('no Nexgent home') })
    expect(judgeV0({ projects: [project()], homes: [{ home: 'main/home', bundles: 1, revisions: 1 }] }, passedRegression)).toMatchObject({ status: 'failed', evidence: expect.stringContaining('main/home/improvers holds 1 improver(s) and 1 revision(s)') })
    expect(judgeV0({ homes, projects: [project({ jobs: [{ jobId: 'job-aaaaaaaa', status: 'adopted', improverVersion: 'v0', history: [] }] })] }, passedRegression)).toMatchObject({ status: 'failed', evidence: expect.stringContaining('improverScope absent (want user)') })
    expect(judgeV0({ homes, projects: [project({ sessions: [{ id: 's', jobId: 'job-aaaaaaaa', phase: 'diagnose', improverVersion: 'v0' }] })] }, passedRegression)).toMatchObject({ status: 'failed', evidence: expect.stringContaining('a session header says improverScope absent') })
    expect(judgeV0({ homes, projects: [project({ ledger: [{ type: 'llm.request.end', improvementId: 'job-aaaaaaaa', improvementPhase: 'trial', improverScope: 'project' }] })] }, passedRegression)).toMatchObject({ status: 'failed', evidence: expect.stringContaining('a ledger record says improverScope project') })
    expect(judgeV0({ projects: [] }, passedRegression)).toMatchObject({ status: 'failed' })
    expect(judgeV0(undefined, passedRegression)).toMatchObject({ status: 'failed' })
  })

  it('H02: the real improver store passes; a broken chain, a deleted file or a missing load-failure rollback fail (requires `pnpm build`)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nexgent-accept6-store-'))
    try {
      const obs = await storePhase(await loadCapabilities(), kernel, dir) as Record<string, any>
      expect(judgeStore(obs)).toMatchObject({ status: 'passed' })
      const broken = structuredClone(obs)
      broken.chain.revisions[1].previous = '0'.repeat(64)
      expect(judgeStore(broken)).toMatchObject({ status: 'failed', evidence: expect.stringContaining('names previous') })
      const deleted = structuredClone(obs)
      deleted.chain.bundlesKept = deleted.chain.bundlesKept.slice(1)
      expect(judgeStore(deleted)).toMatchObject({ status: 'failed', evidence: expect.stringContaining('removed an improver file') })
      const loaded = structuredClone(obs)
      loaded.damage.resolved = { version: loaded.damage.version, rollbacks: [] }
      expect(judgeStore(loaded)).toMatchObject({ status: 'failed', evidence: expect.stringContaining('resolve gave') })
      const versions = structuredClone(obs)
      versions.content.reordered.version = 'f'.repeat(64)
      expect(judgeStore(versions)).toMatchObject({ status: 'failed', evidence: expect.stringContaining('reordered') })
      expect(judgeStore(undefined)).toMatchObject({ status: 'failed' })
      // ADR 0012: the store under test is the user's line, writable.
      expect(obs).toMatchObject({ scope: 'user', readOnly: false })
      expect(judgeStore({ ...obs, scope: 'project', readOnly: true })).toMatchObject({ status: 'failed', evidence: expect.stringContaining('the store is project, read-only') })
      expect(judgeStore({ ...obs, directory: 'project/.nexgent/improvers' })).toMatchObject({ status: 'failed', evidence: expect.stringContaining('not <NEXGENT_HOME>/improvers') })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('H03: a pinned job passes; a child-pinned record without a version, a late adoption or a child paragraph in A fail', () => {
    const good = () => ({
      adoptedBy: 'ImproverStore.adopt',
      child: { version: C },
      adoption: { inForce: C },
      jobA: { id: 'a', pinnedBeforeAdoption: 'v0', statusAtAdoption: 'diagnosing', status: 'adopted', improverVersion: 'v0', improverScope: 'user', history: ['queued', 'diagnosing', 'proposing', 'trialing', 'adopted'] },
      jobB: { id: 'b', status: 'rejected', improverVersion: C, improverScope: 'user', history: ['queued', 'diagnosing', 'proposing', 'trialing', 'rejected'] },
      projectLine: { bundles: 0, revisions: 0 },
      facts: {
        sessions: [
          { id: 's1', jobId: 'a', phase: 'diagnose', improverVersion: 'v0', improverScope: 'user' }, { id: 's2', jobId: 'a', phase: 'propose', improverVersion: 'v0', improverScope: 'user' },
          { id: 's3', jobId: 'b', phase: 'diagnose', improverVersion: C, improverScope: 'user' },
        ],
        ledger: [
          { type: 'llm.request.end', improvementId: 'a', improvementPhase: 'trial', improverScope: 'user' },
          { type: 'llm.request.end', improvementId: 'b', improvementPhase: 'diagnose', improverVersion: C, improverScope: 'user' },
          { type: 'llm.request.end', improvementId: 'b', improvementPhase: 'trial', improverVersion: C, improverScope: 'user' },
        ],
      } as { sessions: Record<string, unknown>[]; ledger: Record<string, unknown>[] },
      diagnoseTexts: [{ playbook: 'improve', hasChildParagraph: false }, { playbook: 'notes', hasChildParagraph: true }],
    })
    expect(judgePinned(good())).toMatchObject({ status: 'passed' })
    const unstamped = good()
    unstamped.facts.ledger.push({ type: 'improvement.end', improvementId: 'b', improverScope: 'user' })
    expect(judgePinned(unstamped)).toMatchObject({ status: 'failed', evidence: expect.stringContaining('(absent → v0)') })
    const late = good()
    late.jobA.statusAtAdoption = 'adopted'
    expect(judgePinned(late)).toMatchObject({ status: 'failed', evidence: expect.stringContaining('did not land mid-job') })
    const leaked = good()
    leaked.facts.sessions[1]!.improverVersion = C
    expect(judgePinned(leaked)).toMatchObject({ status: 'failed', evidence: expect.stringContaining('propose session header') })
    const prompt = good()
    prompt.diagnoseTexts[0]!.hasChildParagraph = true
    expect(judgePinned(prompt)).toMatchObject({ status: 'failed', evidence: expect.stringContaining('carried the child') })
    const bOnV0 = good()
    bOnV0.jobB.improverVersion = 'v0'
    expect(judgePinned(bOnV0)).toMatchObject({ status: 'failed', evidence: expect.stringContaining('not the child') })
    expect(judgePinned(undefined)).toMatchObject({ status: 'failed' })
    // ADR 0012: both jobs say improverScope user; the adoption stays out of the project's line.
    const unscoped = good()
    delete (unscoped.jobB as Record<string, unknown>).improverScope
    expect(judgePinned(unscoped)).toMatchObject({ status: 'failed', evidence: expect.stringContaining("job B's job.json improverScope absent (want user)") })
    const projectLine = good()
    projectLine.projectLine = { bundles: 1, revisions: 1 }
    expect(judgePinned(projectLine)).toMatchObject({ status: 'failed', evidence: expect.stringContaining("reached the project's .nexgent/improvers") })
    const header = good()
    delete header.facts.sessions[2]!.improverScope
    expect(judgePinned(header)).toMatchObject({ status: 'failed', evidence: expect.stringContaining('a session header says improverScope absent') })
    const record = good()
    record.facts.ledger[0]!.improverScope = 'project'
    expect(judgePinned(record)).toMatchObject({ status: 'failed', evidence: expect.stringContaining('a ledger record says improverScope project') })
  })

  it('E01 / E04 over the measurement scripts pass; a differing generation, a missing run or a different second build fail', async () => {
    const experiment = await loadExperiment(experimentDir)
    const sets = setsObservation(experiment) as Record<string, any>
    expect(judgeSets(sets)).toMatchObject({ status: 'passed' })
    const drifted = structuredClone(sets)
    drifted.second[3].hashes.message = '0'.repeat(64)
    expect(judgeSets(drifted)).toMatchObject({ status: 'failed', evidence: expect.stringContaining(drifted.second[3].id) })
    const overlapping = structuredClone(sets)
    overlapping.sets.tables.holdout.push(overlapping.sets.tables.dev[0])
    expect(judgeSets(overlapping)).toMatchObject({ status: 'failed', evidence: expect.stringContaining('more than one set') })
    expect(judgeSets({ ...sets, problems: ['tables: seed 1 is used more than once'] })).toMatchObject({ status: 'failed', evidence: expect.stringContaining('checkSets') })

    const dir = await mkdtemp(join(tmpdir(), 'nexgent-accept6-report-'))
    try {
      const report = await reportObservation(experiment, dir, { iterations: 200 }) as Record<string, any>
      expect(judgeReport(report)).toMatchObject({ status: 'passed' })
      expect(judgeReport({ ...report, second: `${report.first}\n` })).toMatchObject({ status: 'failed', evidence: expect.stringContaining('differ') })
      const runId = report.raw.runs[5].runId as string
      expect(judgeReport({ ...report, first: report.first.replaceAll(runId, 'x'), second: report.first.replaceAll(runId, 'x'), cli: { code: 0, sameAsInProcess: true } })).toMatchObject({ status: 'failed', evidence: expect.stringContaining(runId) })
      const cheaper = structuredClone(report)
      cheaper.raw.costs[0].usd += 2
      expect(judgeReport(cheaper)).toMatchObject({ status: 'failed', evidence: expect.stringContaining('total cost') })
      expect(judgeReport({ ...report, flipped: { runId, report: report.first } })).toMatchObject({ status: 'failed', evidence: expect.stringContaining('left the report unchanged') })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 120_000)
})

/** Pilot raw records in the shape pilot/run.mjs `pilotRawRecords` writes (one family, one holdout case). */
function pilotRaw(): Record<string, any> {
  const runs = []
  for (const arm of ['base', 'memory', 'parent']) {
    for (const repeat of [1, 2, 3]) {
      const rate = arm === 'base' ? 0.5 : repeat === 3 ? 0.75 : 1
      runs.push({
        runId: `${arm}#docs/holdout/a#${repeat}`, family: 'docs', caseId: 'docs/holdout/a', arm, repeat, rate, pass: rate === 1, unclear: arm === 'parent' && repeat === 2 ? 1 : 0,
        points: [{ id: 'c', type: 'convention', by: 'check', pass: rate === 1 }], costUsd: 0.01, componentsUsed: [], capabilityVersions: ['baseline'], followUp: arm === 'base' && repeat === 1, turn: 'completed',
      })
    }
  }
  return {
    pilotId: 'step6-pilot', planSha256: 'h'.repeat(64), backend: 'scripted', model: 'm',
    reviewers: { external: { model: 'e', thinking: 'on' }, inLoop: { model: 'i', thinking: 'on' } },
    epochs: { docs: 'e'.repeat(64) },
    arms: { docs: { base: { home: 'homes/docs-base', capabilityVersion: 'baseline', improverVersion: 'v0' }, memory: { home: 'homes/docs-memory', capabilityVersion: 'm'.repeat(64), improverVersion: 'v0' }, parent: { home: 'homes/docs-parent', capabilityVersion: 'p'.repeat(64), improverVersion: 'v0' } } },
    memory: { docs: { version: 'm'.repeat(64), digest: 'd'.repeat(64), entries: 3, kept: 3, dropped: 0, bytes: 100 } },
    jobs: { docs: [{ caseId: 'docs/dev/x', status: 'adopted', improverVersion: 'v0', history: ['queued', 'adopted'] }] },
    dev: { docs: [{ caseId: 'docs/dev/x', primary: 'c', feedback: [{ rating: 2, comment: 'c' }] }] },
    isolation: { docs: { leaks: 0, scanned: 9, skipped: 0 } },
    judges: { pass: true, samples: 77, failed: [], uncovered: [] },
    referencePairs: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'].map((id, i) => ({ id, caseId: 'docs/dev/x', flaw: 'f', ab: i === 5 ? 'B' : 'A', ba: 'B' })),
    armPairs: [{ family: 'docs', caseId: 'docs/holdout/a', first: 'parent', second: 'memory', ab: 'tie', ba: 'tie' }],
    agreement: [{ runId: 'x', pointId: 'r', external: true, inLoop: false }],
    components: { docs: {
      base: { components: [], literal: { components: 0, withLiterals: 0, rate: null } },
      memory: { components: [{ kind: 'context-policy', name: 'project-notes', class: 'convention-or-fact' }], literal: { components: 1, withLiterals: 0, rate: 0 } },
      parent: { components: [{ kind: 'skill', name: 's', class: 'way-of-working' }, { kind: 'skill', name: 't', class: 'convention-or-fact' }], literal: { components: 2, withLiterals: 1, rate: 0.5 } },
    } },
    runs,
    costs: [{ kind: 'holdout', family: 'docs', ref: 'r', usd: 0.1 }, { kind: 'improvement', family: 'docs', ref: 'j', usd: null }],
    notes: ['n'],
  }
}

describe('E04 pilot report (ADR 0011)', () => {
  it('a reproducible, traceable pilot report passes; a mismatched column, a second build, an unchanged rebuild or a missing change fail', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nexgent-accept6-pilot-'))
    try {
      const records = join(dir, 'raw.json')
      await writeFile(records, JSON.stringify(pilotRaw()))
      const obs = await pilotReportObservation(experimentDir, records, join(dir, 'work')) as Record<string, any>
      const passed = judgePilotReport(obs) as unknown as { status: string; evidence: string }
      expect(passed.status, passed.evidence).toBe('passed')
      expect(passed.evidence).toContain('6 reference pairs with 5 right') // ab B / ba B is not "first"
      const tampered = (mutate: (raw: Record<string, any>) => void) => {
        const copy = structuredClone(obs)
        mutate(copy.raw)
        return judgePilotReport(copy)
      }
      expect(judgePilotReport(undefined)).toMatchObject({ status: 'failed' })
      expect(judgePilotReport({ ...obs, second: `${obs.first}\n` })).toMatchObject({ status: 'failed', evidence: expect.stringContaining('two builds') })
      expect(judgePilotReport({ ...obs, cli: { code: 0, sameAsInProcess: false } })).toMatchObject({ status: 'failed', evidence: expect.stringContaining('wrote a different report') })
      // The records say something the report does not: each added column is checked against them.
      expect(tampered(raw => { raw.runs[1].followUp = true })).toMatchObject({ status: 'failed', evidence: expect.stringContaining('docs base: the per-arm row') })
      expect(tampered(raw => { raw.runs[8].unclear = 3 })).toMatchObject({ status: 'failed', evidence: expect.stringContaining("can't tell") })
      expect(tampered(raw => { raw.runs[4].rate = 0.25 })).toMatchObject({ status: 'failed', evidence: expect.stringContaining('docs/holdout/a memory: the repeat-spread row') })
      expect(tampered(raw => { raw.components.docs.parent.components[1].class = 'way-of-working' })).toMatchObject({ status: 'failed', evidence: expect.stringContaining('docs parent: the component row') })
      expect(tampered(raw => { raw.components.docs.parent.literal.withLiterals = 2 })).toMatchObject({ status: 'failed', evidence: expect.stringContaining('docs parent: the component row') })
      expect(tampered(raw => { raw.components.docs.parent.literal.components = 1 })).toMatchObject({ status: 'failed', evidence: expect.stringContaining('the literal rate counts 1 components of 2') })
      expect(tampered(raw => { raw.judges.samples = 78 })).toMatchObject({ status: 'failed', evidence: expect.stringContaining('criterion 1') })
      expect(tampered(raw => { raw.judges.pass = false })).toMatchObject({ status: 'failed', evidence: expect.stringContaining('criterion 1') })
      expect(tampered(raw => { raw.referencePairs[5].ab = 'A' })).toMatchObject({ status: 'failed', evidence: expect.stringContaining('criterion 2') })
      expect(tampered(raw => { raw.armPairs[0].ba = 'A' })).toMatchObject({ status: 'failed', evidence: expect.stringContaining('criterion 3') })
      expect(tampered(raw => { raw.costs[0].usd = 0.2 })).toMatchObject({ status: 'failed', evidence: expect.stringContaining('the total') })
      expect(tampered(raw => { raw.runs = raw.runs.filter((r: { arm: string }) => r.arm !== 'memory') })).toMatchObject({ status: 'failed', evidence: expect.stringContaining('no memory run') })
      // A change to the records that leaves the report as it was, or a change not tried.
      expect(judgePilotReport({ ...obs, changes: { ...obs.changes, followUp: { what: 'x', report: obs.first } } })).toMatchObject({ status: 'failed', evidence: expect.stringContaining('changing followUp (x) left the pilot report unchanged') })
      expect(judgePilotReport({ ...obs, changes: { ...obs.changes, componentClass: { what: undefined } } })).toMatchObject({ status: 'failed', evidence: expect.stringContaining('the componentClass change could not be made') })
      const { rate: _rate, ...withoutRate } = obs.changes
      expect(judgePilotReport({ ...obs, changes: withoutRate })).toMatchObject({ status: 'failed', evidence: expect.stringContaining('the rate change was not tried') })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 60_000)
})

describe('scripts/accept-step6.mjs (requires `pnpm build`)', () => {
  async function runScript(args: string[], env: NodeJS.ProcessEnv = {}, timeout = 120_000) {
    const dir = await mkdtemp(join(tmpdir(), 'nexgent-accept6-test-'))
    try {
      const out = join(dir, 'summary.json')
      const childEnv = { ...process.env, ...env }
      for (const [key, value] of Object.entries(env)) if (value === undefined) delete childEnv[key]
      const result = spawnSync(process.execPath, [script, '--out', out, '--work-dir', join(dir, 'work'), ...args], { encoding: 'utf8', env: childEnv, timeout })
      const raw = await readFile(out, 'utf8').catch(() => '')
      const summary = raw === '' ? undefined : JSON.parse(raw) as AcceptanceSummary
      return { result, summary, raw }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  it('experiment layer: E01–E04 pass over the measurement scripts and a scripted rehearsal of the runner, exit 0', async () => {
    const { result, summary } = await runScript(['--layer', 'experiment'], {}, 900_000)
    expect(result.status, result.stderr.slice(-4000)).toBe(EXIT_PASS)
    expect(validateAcceptanceSummary(summary)).toEqual({ valid: true, errors: [] })
    expect(summary?.checks.map(check => check.id)).toEqual(range('E', 1, 4))
    for (const check of summary?.checks ?? []) expect(check, `${check.id} ${JSON.stringify(check)}`).toMatchObject({ passed: true, status: 'passed' })
  }, 960_000)

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
