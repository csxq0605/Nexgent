/**
 * ADR 0026 layer 3 under a scripted evaluator and proposer: plan → approve
 * → seed → iterations (Pareto × children parent choice, minibatch
 * acceptance, refused edits remembered) → holdout bootstrap → a
 * recommendation that still waits for the user; the cap, the stop file,
 * resuming, frozen fields and a tampered plan.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  OFFLINE_RUN_FILE,
  offlineCandidateProblems,
  offlinePairedBootstrap,
  offlineParentWeights,
  offlineRng,
  type OfflineArchiveEntry,
  type OfflineCandidate,
  type PracticeCase,
} from '@nexgent/kernel'
import type { TrialRunner } from '@nexgent/capabilities'
import {
  approveOfflineRun,
  decideOfflineRun,
  listOfflineRuns,
  offlineRunDirectory,
  offlineStartingVersion,
  practiceReplayEvaluator,
  parseOfflineProposal,
  planOfflineRun,
  readOfflineRun,
  ReplayPracticeEvaluator,
  runOfflineEvolution,
  stopOfflineRun,
  type OfflineProposer,
  type PracticeEvaluator,
} from '../src/index.js'
import { home } from './helpers.js'

const START: OfflineCandidate = { executionGuidance: '', retrieval: { handbookTopK: 5, handbookMinCoverage: 0.2, handbookMinSharedTerms: 2, skillMaxActive: 2 } }
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const CASES: Pick<PracticeCase, 'id' | 'split'>[] = [
  ...[1, 2, 3, 4].map(n => ({ id: id(n), split: 'train' as const })),
  ...[5, 6, 7].map(n => ({ id: id(n), split: 'selection' as const })),
  ...[8, 9, 10, 11].map(n => ({ id: id(n), split: 'holdout' as const })),
  { id: id(12), split: 'guard' as const },
]

/** Guidance that asks to verify scores 0.9 on every case, else 0.5; each case run costs `usd`. */
function evaluator(usd = 0.01): PracticeEvaluator & { calls: number } {
  const self = {
    calls: 0,
    async evaluate({ candidate, caseIds }: { candidate: OfflineCandidate; caseIds: readonly string[] }) {
      self.calls += 1
      return caseIds.map(caseId => ({ caseId, score: /verify/i.test(candidate.executionGuidance) ? 0.9 : 0.5, feedback: 'the result was not checked', input: `task ${caseId}`, usd }))
    },
  }
  return self
}

/** Retrieval proposals are refused (a frozen field), guidance proposals ask to verify. */
const proposer: OfflineProposer = {
  async propose(input) {
    if (input.component === 'retrieval') return { candidate: { ...input.parent, costCaps: {} } as unknown as OfflineCandidate, usd: 0.01 }
    return { candidate: { ...input.parent, executionGuidance: 'Verify the result against the request before finishing.' }, usd: 0.01 }
  },
}

describe('offline evolution: pure parts', () => {
  const entry = (n: number, scores: Record<string, number>, children = 0): OfflineArchiveEntry => ({ id: n, candidate: START, scores, children, createdAt: 'x' })

  it('weights parents by per-case fronts, without dominated ones, divided by 1 + children', () => {
    const archive = [entry(0, { a: 0.5, b: 0.5 }), entry(1, { a: 0.9, b: 0.4 }), entry(2, { a: 0.4, b: 0.9 }, 1), entry(3, { a: 0.9, b: 0.3 })]
    const weights = offlineParentWeights(archive, ['a', 'b'])
    expect([...weights]).toEqual([[0, 0], [1, 1], [2, 0.5], [3, 0]])
  })

  it('bootstraps a paired interval', () => {
    const seed = { a: [0.5], b: [0.5], c: [0.4], d: [0.6] }
    const better = { a: [0.8], b: [0.9], c: [0.7], d: [0.9] }
    const result = offlinePairedBootstrap(seed, better, offlineRng({ state: 1 }), 500)
    expect(result.meanDiff).toBeCloseTo(0.325)
    expect(result.ciLow).toBeGreaterThan(0)
    expect(offlinePairedBootstrap(seed, seed, offlineRng({ state: 1 }), 200).ciLow).toBe(0)
  })

  it('refuses frozen fields and out-of-bound parameters', () => {
    expect(offlineCandidateProblems(START)).toEqual([])
    expect(offlineCandidateProblems({ ...START, permissions: {} })).toEqual(['permissions is frozen and may not be changed'])
    expect(offlineCandidateProblems({ ...START, retrieval: { ...START.retrieval, handbookTopK: 20 } })).toEqual(['retrieval.handbookTopK must be an integer in 1–8'])
    expect(parseOfflineProposal('retrieval', START, '{"retrieval":{"handbookTopK":3,"handbookMinCoverage":0.2,"handbookMinSharedTerms":2,"skillMaxActive":2}}')).toEqual({ candidate: { ...START, retrieval: { ...START.retrieval, handbookTopK: 3 } } })
    expect(parseOfflineProposal('execution-guidance', START, '{"executionGuidance":"x","sandbox":"off"}')).toEqual({ problem: 'the reply changes more than executionGuidance: sandbox' })
    expect(parseOfflineProposal('execution-guidance', START, '{"executionGuidance":""}')).toEqual({ problem: 'the proposal is the same as the parent' })
  })
})

describe('offline evolution: a run', () => {
  it('plans without spending, runs only when approved at the planned cap, and recommends a better version', async () => {
    const planned = await planOfflineRun({ home: home(), cases: CASES, start: START, seed: 7, usdPerRun: 0.01, maxIterations: 4, patience: 3 })
    expect(planned.status).toBe('awaiting-approval')
    expect(planned.plan.cases).toMatchObject({ selection: expect.any(Array), holdout: expect.any(Array), guard: [id(12)] })
    expect(planned.plan.cases.minibatch).toHaveLength(4)
    expect(planned.plan.capUsd).toBeCloseTo(planned.plan.estimate.usd * 1.5, 1)
    const { runId } = planned.plan
    const ev = evaluator()
    await expect(runOfflineEvolution(home(), runId, { evaluator: ev, proposer })).rejects.toThrow(/not approved/)
    await expect(approveOfflineRun(home(), runId, planned.plan.capUsd + 1)).rejects.toThrow(/differs/)
    expect(ev.calls).toBe(0)
    await approveOfflineRun(home(), runId, planned.plan.capUsd)
    const done = await runOfflineEvolution(home(), runId, { evaluator: ev, proposer })
    expect(done.status).toBe('awaiting-user')
    expect(done.result).toMatchObject({ verdict: 'recommended', bestId: 1 })
    expect(done.result!.holdout!.ciLow).toBeGreaterThan(0)
    expect(done.archive.map(entry => [entry.id, entry.parentId, entry.component])).toEqual([[0, undefined, undefined], [1, 0, 'execution-guidance']])
    expect(done.rejected.some(edit => edit.component === 'retrieval' && /frozen/.test(edit.reason))).toBe(true)
    expect(done.spentUsd).toBeLessThanOrEqual(done.plan.capUsd)
    // Finished: running again changes nothing.
    expect(await runOfflineEvolution(home(), runId, { evaluator: ev, proposer })).toEqual(await readOfflineRun(home(), runId))
  })

  it('says no-better when nothing beats the start, without spending on held-out cases', async () => {
    const { plan } = await planOfflineRun({ home: home(), cases: CASES, start: START, seed: 3, usdPerRun: 0.01, maxIterations: 2, patience: 2 })
    await approveOfflineRun(home(), plan.runId, plan.capUsd)
    const flat: OfflineProposer = { async propose(input) { return { candidate: { ...input.parent, executionGuidance: 'Work carefully.' }, usd: 0 } } }
    const done = await runOfflineEvolution(home(), plan.runId, { evaluator: evaluator(), proposer: flat })
    expect(done.result).toMatchObject({ verdict: 'no-better', bestId: 0 })
    expect(done.result!.holdout).toBeUndefined()
    expect(done.iteration).toBe(2)
  })

  it('stops before passing the cap, and at the stop file; resuming finishes the run', async () => {
    const expensive = await planOfflineRun({ home: home(), cases: CASES, start: START, seed: 7, usdPerRun: 0.01, maxIterations: 4 })
    await approveOfflineRun(home(), expensive.plan.runId, expensive.plan.capUsd)
    const stopped = await runOfflineEvolution(home(), expensive.plan.runId, { evaluator: evaluator(1), proposer })
    expect(stopped.status).toBe('stopped')
    expect(stopped.stop?.reason).toBe('budget')
    expect(stopped.spentUsd).toBeLessThanOrEqual(stopped.plan.capUsd + 3 * 1)

    const { plan } = await planOfflineRun({ home: home(), cases: CASES, start: START, seed: 7, usdPerRun: 0.01, maxIterations: 4, patience: 3 })
    await approveOfflineRun(home(), plan.runId, plan.capUsd)
    await stopOfflineRun(home(), plan.runId)
    // The stop file is cleared on start, so stop again from inside the first evaluation.
    const ev = evaluator()
    const once: PracticeEvaluator = { evaluate: async input => { await stopOfflineRun(home(), plan.runId); return ev.evaluate(input) } }
    const paused = await runOfflineEvolution(home(), plan.runId, { evaluator: once, proposer })
    expect(paused).toMatchObject({ status: 'stopped', stop: { reason: 'stop-file' } })
    expect(Object.keys(paused.archive[0]!.scores)).toHaveLength(3)
    const resumed = await runOfflineEvolution(home(), plan.runId, { evaluator: evaluator(), proposer })
    expect(resumed.status).toBe('awaiting-user')
    expect(resumed.stop).toBeUndefined()
  })

  it('refuses to resume a run whose plan was changed', async () => {
    const { plan } = await planOfflineRun({ home: home(), cases: CASES, start: START, seed: 1, usdPerRun: 0.01 })
    await approveOfflineRun(home(), plan.runId, plan.capUsd)
    const file = join(offlineRunDirectory(home(), plan.runId), OFFLINE_RUN_FILE)
    const state = JSON.parse(await readFile(file, 'utf8'))
    state.plan.cases.holdout = state.plan.cases.holdout.slice(1)
    await writeFile(file, JSON.stringify(state))
    await expect(runOfflineEvolution(home(), plan.runId, { evaluator: evaluator(), proposer })).rejects.toThrow(/no longer matches/)
  })
})

describe('replay evaluator', () => {
  it('runs each case in its own copy, scores finished runs and counts unfinished ones as 0', async () => {
    const disposed: string[] = []
    const practice = (n: number): PracticeCase => ({ formatVersion: 1, id: id(n), source: 'task', createdAt: 'x', prompt: `task ${n}`, similarityKey: [], clusterId: 'c', split: 'holdout' })
    const replay = new ReplayPracticeEvaluator({
      practiceCase: async caseId => (caseId === id(3) ? undefined : practice(Number(caseId.slice(-1)))),
      prepare: async practiceCase => ({ projectRoot: `/copy/${practiceCase.id}`, dispose: async () => { disposed.push(practiceCase.id) } }),
      run: async ({ practiceCase }) => (practiceCase.id === id(2) ? { outcome: 'timeout', usd: 0.2 } : { outcome: 'completed', usd: 0.3, output: 'wrote the report' }),
      score: async () => ({ score: 0.8, feedback: 'two of three checks passed', usd: 0.05 }),
    })
    const results = await replay.evaluate({ candidate: START, caseIds: [id(1), id(2), id(3)], signal: new AbortController().signal })
    expect(results.map(result => [result.score, result.unknown === true])).toEqual([[0.8, false], [0, true], [0, true]])
    expect(results[0]).toMatchObject({ input: 'task 1', output: 'wrote the report', usd: 0.35 })
    expect(disposed).toEqual([id(1), id(2)])
  })
})

describe('product replay evaluator (ADR 0027)', () => {
  it('replays a practice case in a copy with the candidate, scores it by the external reviewer on the frozen rubric, and counts a lost project as unknown', async () => {
    const { feedbackTask, ASK } = await import('./history.js')
    const { handbookProjectId, practiceCasesDirectory, readExecutionProfile, isTrialCopy, CapabilityStore } = await import('@nexgent/capabilities')
    const { JsonlSessionStore } = await import('@nexgent/session')
    const { mkdir: mk } = await import('node:fs/promises')
    const { resolveWorkspaceLayout, ZERO_USAGE } = await import('@nexgent/kernel')
    const fixture = await feedbackTask()
    const projectId = await handbookProjectId(fixture.layout.root)
    const tree = JSON.parse(await readFile(join(fixture.layout.dataDir, 'snapshots', 'tasks', `${fixture.taskId}.json`), 'utf8')).tree as string
    const rubric = { items: [{ id: 'r1', text: 'The summary has a region column.' }, { id: 'r2', text: 'Every order is counted.' }], model: 'm', createdAt: '2026-10-19T00:00:00.000Z', generator: 'v0' }
    const practice = (n: number, extra: Record<string, unknown> = {}): PracticeCase => ({ formatVersion: 1, id: id(n), source: 'task', createdAt: '2026-10-19T00:00:00.000Z', prompt: ASK, input: { projectId, tree }, projectId, taskId: fixture.taskId, sessionId: fixture.sessionId, similarityKey: ['orders'], clusterId: 'c', split: 'selection', rubric, ...extra } as PracticeCase)
    await mk(practiceCasesDirectory(home()), { recursive: true })
    await writeFile(join(practiceCasesDirectory(home()), `${id(1)}.json`), JSON.stringify(practice(1)))
    await writeFile(join(practiceCasesDirectory(home()), `${id(2)}.json`), JSON.stringify(practice(2, { projectId: 'a'.repeat(64), input: { projectId: 'a'.repeat(64), tree } })))

    const candidate: OfflineCandidate = { ...START, executionGuidance: 'Verify the result before finishing.' }
    const seen: { messages?: readonly string[]; ledgersDir?: string; profile?: unknown; copy?: boolean } = {}
    const runner = {
      async run(request: { projectRoot: string; messages: readonly { text: string }[]; ledgersDir: string; caseId: string }) {
        const copy = resolveWorkspaceLayout(request.projectRoot)
        seen.messages = request.messages.map(message => message.text)
        seen.ledgersDir = request.ledgersDir
        seen.profile = await readExecutionProfile({ home: home(), dataDir: copy.dataDir, trialCopy: true })
        seen.copy = await isTrialCopy(new CapabilityStore(copy.capabilities))
        await mk(join(request.projectRoot, 'out'), { recursive: true })
        await writeFile(join(request.projectRoot, 'out', 'summary.csv'), 'region,total\nnorth,1\nsouth,2\n')
        const store = new JsonlSessionStore({ sessionsDir: copy.sessions })
        const sessionId = '11111111-1111-4111-8111-111111111111'
        const lock = await store.create({ sessionId, projectRoot: request.projectRoot, model: 'm', sandboxMode: 'workspace-write', capabilityVersion: 'baseline' })
        await store.append(sessionId, { type: 'assistant.message', turn: 1, step: 1, requestId: 'r', content: 'Wrote out/summary.csv by region.', usage: ZERO_USAGE, finishReason: 'stop' })
        await store.release(lock)
        await mk(join(copy.dataDir, 'snapshots', 'checks'), { recursive: true })
        await writeFile(join(copy.dataDir, 'snapshots', 'checks', 't.json'), JSON.stringify({ formatVersion: 1, taskId: 't', sessionId, checkedAt: 'x', specs: [], results: [{ name: 'file-exists', passed: true, target: 'f' }] }))
        return { outcome: 'completed' as const, usage: ZERO_USAGE, requestCount: 3, estimatedUsd: 0.2 }
      },
    }
    const prompts: string[] = []
    const scorer = {
      async score(request: { user: string }) {
        prompts.push(request.user)
        return { text: '{"scores":[{"id":"r1","score":1,"note":"has the column"},{"id":"r2","score":0.5,"note":"one order is missing"}]}', usd: 0.05 }
      },
    }
    const evaluatorUnderTest = practiceReplayEvaluator({ home: home(), runId: id(99), runner: runner as unknown as TrialRunner, scorer, locate: async pid => (pid === projectId ? fixture.layout : undefined) })
    const results = await evaluatorUnderTest.evaluate({ candidate, caseIds: [id(1), id(2)], signal: new AbortController().signal })
    expect(seen).toMatchObject({ messages: [ASK], profile: candidate, copy: true })
    expect(seen.ledgersDir).toBe(join(offlineRunDirectory(home(), id(99)), 'ledgers'))
    expect(prompts[0]).toContain('north,1')
    expect(prompts[0]).toContain('Wrote out/summary.csv by region.')
    // Checks pass (1 of 1, generic ones included) and the rubric gives 0.75: the mean.
    expect(results[0]!.score).toBeGreaterThan(0.75)
    expect(results[0]).toMatchObject({ usd: 0.25, output: 'Wrote out/summary.csv by region.' })
    expect(results[0]!.feedback).toContain('Every order is counted.: partly met (one order is missing)')
    expect(results[1]).toMatchObject({ score: 0, unknown: true })
    expect(results[1]!.feedback).toMatch(/not on this computer/)
  })

  it('applies a recommended version for every project only on the user\'s word, and refuses to apply a no-better run', async () => {
    const { readAppliedProfile } = await import('@nexgent/capabilities')
    const { plan } = await planOfflineRun({ home: home(), cases: CASES, start: START, seed: 7, usdPerRun: 0.01, maxIterations: 4, patience: 3 })
    await approveOfflineRun(home(), plan.runId, plan.capUsd)
    const done = await runOfflineEvolution(home(), plan.runId, { evaluator: evaluator(), proposer })
    expect(done.result?.verdict).toBe('recommended')
    expect(await readAppliedProfile(home())).toBeUndefined()
    const applied = await decideOfflineRun(home(), plan.runId, 'apply')
    expect(applied.decision?.outcome).toBe('applied')
    expect((await readAppliedProfile(home()))?.candidate.executionGuidance).toMatch(/Verify/)
    await expect(decideOfflineRun(home(), plan.runId, 'decline')).rejects.toThrow(/already applied/)
    expect((await offlineStartingVersion(home())).executionGuidance).toMatch(/Verify/)
    expect((await listOfflineRuns(home())).map(run => run.plan.runId)).toEqual([plan.runId])

    const flatPlan = await planOfflineRun({ home: home(), cases: CASES, start: START, seed: 3, usdPerRun: 0.01, maxIterations: 1, patience: 1 })
    await approveOfflineRun(home(), flatPlan.plan.runId, flatPlan.plan.capUsd)
    const flat: OfflineProposer = { async propose(input) { return { candidate: { ...input.parent, executionGuidance: 'Work carefully.' }, usd: 0 } } }
    await runOfflineEvolution(home(), flatPlan.plan.runId, { evaluator: evaluator(), proposer: flat })
    await expect(decideOfflineRun(home(), flatPlan.plan.runId, 'apply')).rejects.toThrow(/recommends no version/)
  })
})
