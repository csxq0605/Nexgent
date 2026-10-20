import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { functionToolName, resolveWorkspaceLayout, type LedgerRecord, type TrialReceipt, type WorkspaceLayout } from '@nexgent/kernel'
import {
  assertDisjoint,
  buildReplaySet,
  CapabilityStore,
  checkUsageRegression,
  listReplayCases,
  listTrials,
  readTrialReceipts,
  recoverInterruptedTrials,
  releaseTrialLock,
  runGate,
  writeTrialLock,
  type FeedbackCheckInput,
  type ReviewInput,
  type TrialReviewer,
} from '../src/index.js'
import { sampleComponents, tempDir } from './helpers.js'
import { feedbackTask, historyProject, improvementJob, pastTask, proposeCandidate, scriptedRunner, usage, type ArmScript } from './trial-fixture.js'

// Each gate here runs up to a dozen paired runs, each copying the project and spawning a check command;
// under a full parallel `pnpm test` that can pass the 5-second default although nothing is wrong.
vi.setConfig({ testTimeout: 30_000 })

async function writeConfig(layout: WorkspaceLayout, capabilities: Record<string, unknown>): Promise<void> {
  await writeFile(layout.configFile, JSON.stringify({ version: 1, capabilities }))
}

/** Candidate writes `candidate`, baseline writes `baseline` (each run passes its checks only when it wrote `good`). */
function arms(candidate: ArmScript, baseline: ArmScript) {
  return scriptedRunner(request => (request.arm === 'candidate' ? candidate : baseline))
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false)
}

function ledgerOf(records: readonly Partial<LedgerRecord>[]) {
  return {
    async *read() {
      for (const record of records) yield record as LedgerRecord
    },
  }
}

describe('replay set', () => {
  it('waits when the history is too short, and never writes anything', async () => {
    const { layout, tasks } = await historyProject(['summarize the june orders', 'summarize the july orders'])
    const candidate = await proposeCandidate(layout, tasks[0]!)
    const runner = arms({ output: 'good' }, { output: 'bad' })
    const result = await runGate({ layout, candidateId: candidate.id, runner, tempRoot: await tempDir() })
    expect(result.status).toBe('waiting')
    expect(runner.requests).toEqual([])
    expect(await listTrials(layout.capabilities)).toEqual([])
    expect(await new CapabilityStore(layout.capabilities).decisions()).toEqual([])
  })

  it('puts the proposing task first in selection, the least similar in guard, disjoint', async () => {
    const { layout, tasks } = await historyProject()
    const cases = await listReplayCases(layout)
    expect(cases).toHaveLength(3)
    const set = buildReplaySet(cases, tasks[0]!.taskId, { selection: 2, guard: 1 })
    if (set.status !== 'ready') throw new Error('expected a ready set')
    expect(set.selection.map(item => item.caseId)).toEqual([tasks[0]!.taskId, tasks[1]!.taskId])
    expect(set.guard.map(item => item.caseId)).toEqual([tasks[2]!.taskId])
    expect(set.selection[0]!.messages).toEqual([{ text: 'summarize the june orders by region' }])
    expect(() => assertDisjoint(set.selection, [set.selection[0]!])).toThrow()
  })

  it('by recency (an improver\'s choice) takes the newest tasks after the proposing one; the guard is still the least similar', () => {
    const at = (minute: number) => `2026-10-13T00:${String(minute).padStart(2, '0')}:00.000Z`
    const make = (caseId: string, text: string, minute: number) => ({ caseId, sessionId: `s-${caseId}`, tree: 'a'.repeat(64), checks: [], takenAt: at(minute), messages: [{ text }], feedback: [] })
    const cases = [
      make('origin', 'summarize the june orders by region', 1),
      make('similar', 'summarize the july orders by region', 2),
      make('newer', 'count the open tickets per team', 3),
      make('far', 'draw a logo', 4),
      make('newest', 'list the open tickets', 5),
    ]
    const similar = buildReplaySet(cases, 'origin', { selection: 2, guard: 1 })
    const recent = buildReplaySet(cases, 'origin', { selection: 3, guard: 1, order: 'recency' })
    if (similar.status !== 'ready' || recent.status !== 'ready') throw new Error('expected ready sets')
    expect(similar.selection.map(item => item.caseId)).toEqual(['origin', 'similar'])
    expect(recent.selection.map(item => item.caseId)).toEqual(['origin', 'newest', 'newer'])
    expect(recent.guard.map(item => item.caseId)).toEqual(similar.guard.map(item => item.caseId))
    expect(buildReplaySet(cases, 'origin', { selection: 2, guard: 1, order: 'similarity' })).toEqual(similar)
  })

  it('an improvement job\'s comparison counts raise the history the gate needs', async () => {
    const { layout, tasks } = await historyProject()
    const candidate = await proposeCandidate(layout, tasks[0]!)
    const runner = arms({ output: 'good' }, { output: 'bad' })
    const result = await runGate({ layout, candidateId: candidate.id, runner, tempRoot: await tempDir(), comparison: { selectionCases: 3, repeats: 2, selection: 'similarity' } })
    expect(result).toMatchObject({ status: 'waiting', detail: expect.stringContaining('3 selection and 1 guard') })
    expect(runner.requests).toEqual([])
  })

  it('skips tasks without checks', async () => {
    const { layout } = await historyProject()
    await pastTask(layout, 'a task nobody checked', { specs: [] })
    expect(await listReplayCases(layout)).toHaveLength(3)
  })
})

describe('runGate', () => {
  it('adopts a better candidate: paired runs in copies, receipts, a gate revision', async () => {
    const { layout, tasks } = await historyProject()
    const candidate = await proposeCandidate(layout, tasks[0]!)
    const versions: string[] = []
    const runner = scriptedRunner(request => ({
      output: request.arm === 'candidate' ? 'good' : 'bad',
      inspect: async () => {
        expect(request.projectRoot.startsWith(layout.root)).toBe(false)
        versions.push(`${request.arm}:${(await new CapabilityStore(resolveWorkspaceLayout(request.projectRoot).capabilities).activation()).version}`)
        const config = JSON.parse(await readFile(resolveWorkspaceLayout(request.projectRoot).configFile, 'utf8')) as { capabilities: { autoTrial: boolean } }
        expect(config.capabilities.autoTrial).toBe(false)
        expect(await readFile(join(request.projectRoot, 'check.mjs'), 'utf8')).toContain('good')
      },
    }))
    const receipts: TrialReceipt[] = []
    const result = await runGate({ layout, candidateId: candidate.id, runner, tempRoot: await tempDir(), onReceipt: receipt => receipts.push(receipt) })
    if (result.status !== 'decided') throw new Error(`expected a decision, got ${result.status}`)
    expect(result.verdict).toMatchObject({ outcome: 'adopt', reason: 'quality-up', passRate: { candidate: 1, baseline: 0 }, costRatio: 1 })
    // 3 cases × 2 repeats × 2 arms, candidate first in each pair.
    expect(runner.requests).toHaveLength(12)
    expect(runner.requests.slice(0, 2).map(request => request.arm)).toEqual(['candidate', 'baseline'])
    expect(runner.requests.filter(request => request.set === 'guard')).toHaveLength(4)
    expect(new Set(runner.requests.map(request => request.projectRoot)).size).toBe(12)
    expect(versions.filter(item => item.startsWith('candidate:')).every(item => item === `candidate:${candidate.version}`)).toBe(true)
    expect(versions.filter(item => item.startsWith('baseline:')).every(item => item === 'baseline:baseline')).toBe(true)

    const store = new CapabilityStore(layout.capabilities)
    expect((await store.activation()).version).toBe(candidate.version)
    const tail = (await store.history()).at(-1)!
    expect(tail).toMatchObject({ type: 'adopt', trigger: 'gate', version: candidate.version, decisionId: result.decision.id })
    expect(result.decision).toMatchObject({ outcome: 'adopted', trigger: 'gate', candidateId: candidate.id, trialId: result.trialId })

    const onDisk = await readTrialReceipts(layout.capabilities, result.trialId)
    expect(onDisk).toEqual(receipts)
    expect(onDisk.map(receipt => receipt.type)).toEqual(['trial.start', ...Array<string>(12).fill('trial.run'), 'trial.end'])
    const start = onDisk[0]
    if (start?.type !== 'trial.start') throw new Error('no start')
    expect(start).toMatchObject({ candidateId: candidate.id, baselineVersion: 'baseline', plan: { repeats: 2, costRatioCap: 1.2 } })
    const run = onDisk[1]
    if (run?.type !== 'trial.run') throw new Error('no run')
    expect(run.checks.map(check => check.passed)).toEqual([true, true])
    // The real project was never touched by a run, and the copies are gone.
    expect(await exists(join(layout.root, 'out'))).toBe(false)
    expect(await exists(runner.requests[0]!.projectRoot)).toBe(false)
  })

  it('copies the materials the project had when the task started, attached or not', async () => {
    const { layout, tasks } = await historyProject()
    const ids = { before: '11111111-1111-4111-8111-111111111111', removed: '22222222-2222-4222-8222-222222222222', after: '33333333-3333-4333-8333-333333333333' }
    const material = async (id: string, fields: Record<string, string>) => {
      await mkdir(join(layout.materials, id), { recursive: true })
      await writeFile(join(layout.materials, id, 'orders.csv'), 'region,amount\nnorth,1\n')
      await writeFile(join(layout.materials, id, 'material.json'), JSON.stringify({ formatVersion: 1, id, originalName: 'orders.csv', path: `.nexgent/materials/${id}/orders.csv`, size: 21, sha256: 'x', mediaType: 'text/csv', text: true, status: 'active', ...fields }))
    }
    await material(ids.before, { addedAt: '2000-01-01T00:00:00.000Z' })
    await material(ids.removed, { addedAt: '2000-01-01T00:00:00.000Z', status: 'removed', removedAt: '2000-01-02T00:00:00.000Z' })
    await material(ids.after, { addedAt: '2999-01-01T00:00:00.000Z' })
    const candidate = await proposeCandidate(layout, tasks[0]!)
    const seen: string[][] = []
    const runner = scriptedRunner(request => ({
      output: 'good',
      inspect: async () => {
        seen.push((await readdir(resolveWorkspaceLayout(request.projectRoot).materials).catch(() => [] as string[])).sort())
      },
    }))
    await runGate({ layout, candidateId: candidate.id, runner, tempRoot: await tempDir() })
    expect(seen.length).toBeGreaterThan(0)
    for (const listed of seen) expect(listed).toEqual([ids.before])
  })

  it('a candidate beaten to adoption while its trial ran is rejected as interrupted, with no adopted decision left behind', async () => {
    const { layout, tasks } = await historyProject()
    const candidate = await proposeCandidate(layout, tasks[0]!)
    const store = new CapabilityStore(layout.capabilities)
    let other: Awaited<ReturnType<typeof store.adopt>> = null
    const runner = scriptedRunner(request => ({
      output: request.arm === 'candidate' ? 'good' : 'bad',
      inspect: async () => {
        if (other !== null) return
        // Another candidate is adopted while this trial runs.
        const bundle = await store.write(sampleComponents('rival'))
        other = await store.adopt(bundle.version, { trigger: 'approval', reason: 'approved', detail: 'another candidate', candidateId: '8b1f2a6e-3c4d-4e5f-9a0b-1c2d3e4f5a6b' })
      },
    }))
    const result = await runGate({ layout, candidateId: candidate.id, runner, tempRoot: await tempDir() })
    if (result.status !== 'decided') throw new Error(`expected a decision, got ${result.status}`)
    expect(result.verdict).toMatchObject({ outcome: 'adopt' })
    expect(result.decision).toMatchObject({ outcome: 'rejected', reason: 'interrupted', candidateId: candidate.id, trialId: result.trialId })
    expect(other).not.toBeNull()
    const history = await store.history()
    expect(history.map(revision => revision.decisionId)).toEqual([other!.decision.id])
    const decisions = await store.decisions()
    expect(decisions.filter(decision => decision.candidateId === candidate.id)).toEqual([result.decision])
    // Every adopted decision is named by a revision.
    for (const decision of decisions.filter(item => item.outcome === 'adopted')) {
      expect(history.some(revision => revision.decisionId === decision.id)).toBe(true)
    }
  })

  it('rejects a worse candidate and keeps it and its receipts on record', async () => {
    const { layout, tasks } = await historyProject()
    const candidate = await proposeCandidate(layout, tasks[0]!)
    const result = await runGate({ layout, candidateId: candidate.id, runner: arms({ output: 'bad' }, { output: 'good' }), tempRoot: await tempDir() })
    if (result.status !== 'decided') throw new Error('expected a decision')
    expect(result.verdict).toMatchObject({ outcome: 'reject' })
    expect(['guard-regressed', 'quality-down']).toContain(result.verdict.reason)
    expect(result.decision).toMatchObject({ outcome: 'rejected', fromVersion: 'baseline', toVersion: 'baseline' })
    const store = new CapabilityStore(layout.capabilities)
    expect((await store.activation()).version).toBe('baseline')
    expect(await store.versions()).toContain(candidate.version)
    expect(await listTrials(layout.capabilities, candidate.id)).toHaveLength(1)
    // A candidate is tried once.
    expect((await runGate({ layout, candidateId: candidate.id, runner: arms({ output: 'good' }, { output: 'bad' }) })).status).toBe('skipped')
  })

  it('adopts a better candidate that costs 1.5× in dollars (ADR 0007)', async () => {
    const { layout, tasks } = await historyProject()
    const candidate = await proposeCandidate(layout, tasks[0]!)
    const result = await runGate({ layout, candidateId: candidate.id, runner: arms({ output: 'good', tokens: 300, estimatedUsd: 0.015 }, { output: 'bad', tokens: 100, estimatedUsd: 0.01 }), tempRoot: await tempDir() })
    if (result.status !== 'decided') throw new Error('expected a decision')
    expect(result.verdict).toMatchObject({ outcome: 'adopt', reason: 'quality-up', costBasis: 'usd' })
    expect(result.verdict.costRatio).toBeCloseTo(1.5)
    expect(result.decision.detail).toContain('estimated USD')
    expect((await new CapabilityStore(layout.capabilities).activation()).version).toBe(candidate.version)
  })

  it('sends a better candidate that costs more than twice the baseline to the user\'s approval', async () => {
    const { layout, tasks } = await historyProject()
    const candidate = await proposeCandidate(layout, tasks[0]!)
    const receipts: TrialReceipt[] = []
    const result = await runGate({ layout, candidateId: candidate.id, runner: arms({ output: 'good', estimatedUsd: 0.025 }, { output: 'bad', estimatedUsd: 0.01 }), tempRoot: await tempDir(), onReceipt: receipt => receipts.push(receipt) })
    if (result.status !== 'decided') throw new Error('expected a decision')
    expect(result.verdict).toMatchObject({ outcome: 'await-approval', reason: 'quality-up', costBasis: 'usd' })
    expect(result.decision).toMatchObject({ outcome: 'rejected', reason: 'quality-up' })
    expect(result.decision.detail).toContain('no longer adopted')
    const start = receipts[0]
    if (start?.type !== 'trial.start') throw new Error('no start')
    expect(start.plan).toMatchObject({ costRatioCap: 1.2, costApprovalRatio: 2 })
    expect((await new CapabilityStore(layout.capabilities).activation()).version).toBe('baseline')
  })

  it('rejects a tie that costs more, and falls back to tokens without dollars', async () => {
    const { layout, tasks } = await historyProject()
    const candidate = await proposeCandidate(layout, tasks[0]!)
    const result = await runGate({ layout, candidateId: candidate.id, runner: arms({ output: 'good', tokens: 100, estimatedUsd: 0.013 }, { output: 'good', tokens: 100, estimatedUsd: 0.01 }), tempRoot: await tempDir() })
    if (result.status !== 'decided') throw new Error('expected a decision')
    expect(result.verdict).toMatchObject({ outcome: 'reject', reason: 'no-improvement', costBasis: 'usd' })
    const second = await historyProject()
    const other = await proposeCandidate(second.layout, second.tasks[0]!)
    const byTokens = await runGate({ layout: second.layout, candidateId: other.id, runner: arms({ output: 'good', tokens: 130 }, { output: 'good', tokens: 100 }), tempRoot: await tempDir() })
    if (byTokens.status !== 'decided') throw new Error('expected a decision')
    expect(byTokens.verdict).toMatchObject({ outcome: 'reject', reason: 'no-improvement', costBasis: 'tokens', costRatio: 1.3 })
  })

  it('counts a run that does not complete as unknown, never as a failure', async () => {
    const { layout, tasks } = await historyProject()
    const candidate = await proposeCandidate(layout, tasks[0]!)
    const result = await runGate({ layout, candidateId: candidate.id, runner: arms({ outcome: 'error' }, { output: 'good' }), tempRoot: await tempDir() })
    if (result.status !== 'decided') throw new Error('expected a decision')
    expect(result.verdict).toMatchObject({ outcome: 'reject', reason: 'unknown-runs' })
    const runs = (await readTrialReceipts(layout.capabilities, result.trialId)).filter(receipt => receipt.type === 'trial.run' && receipt.arm === 'candidate')
    expect(runs.every(receipt => receipt.type === 'trial.run' && receipt.status === 'unknown' && receipt.reason === 'error')).toBe(true)
  })

  it('stops when the trial budget runs out', async () => {
    const { layout, tasks } = await historyProject()
    await writeConfig(layout, { trialBudget: { maxRequests: 3 } })
    const candidate = await proposeCandidate(layout, tasks[0]!)
    const runner = arms({ output: 'good' }, { output: 'bad' })
    const result = await runGate({ layout, candidateId: candidate.id, runner, tempRoot: await tempDir() })
    if (result.status !== 'decided') throw new Error('expected a decision')
    expect(result.verdict).toMatchObject({ outcome: 'reject', reason: 'budget-exhausted' })
    expect(runner.requests).toHaveLength(3)
    const runs = (await readTrialReceipts(layout.capabilities, result.trialId)).filter(receipt => receipt.type === 'trial.run')
    expect(runs.at(-1)).toMatchObject({ status: 'unknown', reason: 'budget' })
  })

  it('asks the reviewer only on a check tie, and adopts when it prefers the candidate', async () => {
    const { layout, tasks } = await historyProject()
    const candidate = await proposeCandidate(layout, tasks[0]!)
    const asked: ReviewInput[] = []
    const reviewer: TrialReviewer = {
      async review(input) {
        asked.push(input)
        return { preference: 'candidate', reason: 'clearer', usage: usage(12), requestCount: 1 }
      },
    }
    const result = await runGate({ layout, candidateId: candidate.id, runner: arms({ output: 'good' }, { output: 'good' }), reviewer, tempRoot: await tempDir() })
    if (result.status !== 'decided') throw new Error('expected a decision')
    expect(result.verdict).toMatchObject({ outcome: 'adopt', reason: 'review-preferred', decidedByReview: true })
    // Selection runs only: 2 cases × 2 repeats, each pair asked in both orders (ADR 0016).
    expect(asked).toHaveLength(8)
    expect(asked[0]!.candidate.files).toEqual([{ path: 'out/result.txt', text: 'good' }])
    const reviews = (await readTrialReceipts(layout.capabilities, result.trialId)).filter(receipt => receipt.type === 'trial.review')
    expect(reviews).toHaveLength(4)
    expect(result.decision.cost?.review.requestCount).toBe(8)

    // Without a reviewer the same tie rejects.
    const other = await historyProject()
    const second = await proposeCandidate(other.layout, other.tasks[0]!)
    const tie = await runGate({ layout: other.layout, candidateId: second.id, runner: arms({ output: 'good' }, { output: 'good' }), tempRoot: await tempDir() })
    if (tie.status !== 'decided') throw new Error('expected a decision')
    expect(tie.verdict).toMatchObject({ outcome: 'reject', reason: 'no-improvement' })
  })

  it('does not ask the reviewer when the checks decide', async () => {
    const { layout, tasks } = await historyProject()
    const candidate = await proposeCandidate(layout, tasks[0]!)
    let asked = 0
    const reviewer: TrialReviewer = { async review() { asked += 1; throw new Error('not expected') } }
    await runGate({ layout, candidateId: candidate.id, runner: arms({ output: 'good' }, { output: 'bad' }), reviewer, tempRoot: await tempDir() })
    expect(asked).toBe(0)
  })

  it('rejects a passing plugin candidate instead of adopting it (approval was removed)', async () => {
    const { layout, tasks } = await historyProject()
    const candidate = await proposeCandidate(layout, tasks[0]!, 'plugin')
    const result = await runGate({ layout, candidateId: candidate.id, runner: arms({ output: 'good' }, { output: 'bad' }), tempRoot: await tempDir() })
    if (result.status !== 'decided') throw new Error('expected a decision')
    expect(result.decision).toMatchObject({ outcome: 'rejected', reason: 'quality-up' })
    expect((await new CapabilityStore(layout.capabilities).activation()).version).toBe('baseline')
  })
})

describe('interrupted trials', () => {
  it('a gate that died mid-trial is closed as interrupted on the next start and never re-run', async () => {
    const { layout, tasks } = await historyProject()
    const candidate = await proposeCandidate(layout, tasks[0]!)
    const runner = arms({ output: 'good' }, { output: 'bad' })
    // The gate "dies" right after its first run receipt.
    await expect(runGate({
      layout,
      candidateId: candidate.id,
      runner,
      tempRoot: await tempDir(),
      onReceipt: receipt => {
        if (receipt.type === 'trial.run') throw new Error('killed')
      },
    })).rejects.toThrow('killed')
    const [trial] = await listTrials(layout.capabilities)
    expect(trial?.end).toBeUndefined()

    const store = new CapabilityStore(layout.capabilities)
    // A trial whose lock names a live process is still running.
    await writeTrialLock(layout.capabilities, trial!.trialId, process.pid)
    expect(await recoverInterruptedTrials(store)).toEqual([])
    await releaseTrialLock(layout.capabilities, trial!.trialId)

    const written = await recoverInterruptedTrials(store)
    expect(written).toHaveLength(1)
    expect(written[0]).toMatchObject({ outcome: 'rejected', reason: 'interrupted', candidateId: candidate.id, trialId: trial!.trialId, toVersion: 'baseline' })
    expect(await recoverInterruptedTrials(store)).toEqual([])
    expect((await runGate({ layout, candidateId: candidate.id, runner })).status).toBe('skipped')
    expect(runner.requests).toHaveLength(1)
    expect((await readdir(join(layout.capabilities, 'trials'))).some(name => name.endsWith('.lock'))).toBe(false)
  })
})

describe('usage-regression rollback', () => {
  async function adopted() {
    const { layout, tasks } = await historyProject()
    const candidate = await proposeCandidate(layout, tasks[0]!)
    const reviewer: TrialReviewer = { async review() { return { preference: 'candidate', reason: 'better', usage: usage(2), requestCount: 1 } } }
    // Both arms pass every check: the baseline pass rate the watch compares against is 100%.
    const result = await runGate({ layout, candidateId: candidate.id, runner: arms({ output: 'good' }, { output: 'good' }), reviewer, tempRoot: await tempDir() })
    if (result.status !== 'decided' || result.decision.outcome !== 'adopted') throw new Error('expected an adoption')
    return { layout, candidate, store: new CapabilityStore(layout.capabilities) }
  }
  const rule = { windowTasks: 3, consecutiveErrors: 3 }
  const passed = [{ name: 'file-exists', passed: true }]
  const failed = [{ name: 'file-exists', passed: false }]

  it('rolls back when the first three tasks check worse than the baseline', async () => {
    const { candidate, store } = await adopted()
    const version = candidate.version
    const outcome = (taskId: string, checks: typeof passed) => ({ type: 'task.outcome', taskId, capabilityVersion: version, checks }) as Partial<LedgerRecord>
    // Two tasks are not enough; trial records and other versions are ignored.
    const early = ledgerOf([outcome('t1', failed), outcome('t2', failed), { ...outcome('t9', failed), trialId: 'x' } as Partial<LedgerRecord>, { ...outcome('t8', failed), capabilityVersion: 'baseline' } as Partial<LedgerRecord>])
    expect(await checkUsageRegression({ store, ledger: early, rule })).toBeUndefined()
    // The third comes from the turn that just ended (not in the ledger yet).
    const rolled = await checkUsageRegression({ store, ledger: early, rule, pending: { taskId: 't3', capabilityVersion: version, checks: passed } })
    expect(rolled?.decision).toMatchObject({ outcome: 'rolled-back', trigger: 'usage-regression', reason: 'usage-regression', candidateId: candidate.id, fromVersion: version, toVersion: 'baseline' })
    expect(rolled?.decision.regression?.observations.map(item => item.taskId)).toEqual(['t1', 't2', 't3'])
    expect((await store.activation()).version).toBe('baseline')
    // Once rolled back the watch does nothing.
    expect(await checkUsageRegression({ store, ledger: early, rule, pending: { taskId: 't4', capabilityVersion: version, checks: failed } })).toBeUndefined()
  })

  it('keeps the version when the first tasks check as well as the baseline', async () => {
    const { candidate, store } = await adopted()
    const ledger = ledgerOf(['t1', 't2', 't3'].map(taskId => ({ type: 'task.outcome', taskId, capabilityVersion: candidate.version, checks: passed }) as Partial<LedgerRecord>))
    expect(await checkUsageRegression({ store, ledger, rule })).toBeUndefined()
    expect((await store.activation()).version).toBe(candidate.version)
  })

  it('rolls back after three errors in a row of the new components', async () => {
    const { candidate, store } = await adopted()
    const tool = functionToolName('order-summary', 'summarize')
    const call = (taskId: string, isError: boolean) => ({ type: 'tool.call', taskId, capabilityVersion: candidate.version, name: tool, isError }) as Partial<LedgerRecord>
    const other = { type: 'tool.call', taskId: 't1', capabilityVersion: candidate.version, name: 'read_file', isError: true } as Partial<LedgerRecord>
    const rolled = await checkUsageRegression({ store, ledger: ledgerOf([call('t1', true), other, call('t1', true), call('t2', true)]), rule })
    expect(rolled?.decision).toMatchObject({ outcome: 'rolled-back', reason: 'component-errors', regression: { consecutiveErrors: 3 } })
    expect((await store.activation()).version).toBe('baseline')
  })

  it('ignores manual adoptions', async () => {
    const { layout, tasks } = await historyProject()
    const candidate = await proposeCandidate(layout, tasks[0]!)
    const store = new CapabilityStore(layout.capabilities)
    await store.adopt(candidate.version, { trigger: 'manual', reason: 'manual', detail: 'by hand' })
    const ledger = ledgerOf(['t1', 't2', 't3'].map(taskId => ({ type: 'task.outcome', taskId, capabilityVersion: candidate.version, checks: failed }) as Partial<LedgerRecord>))
    expect(await checkUsageRegression({ store, ledger, rule })).toBeUndefined()
  })
})

describe('step 5: feedback task and feedback checks', { timeout: 60_000 }, () => {
  /** A project with three step-4 tasks and one task with feedback; a job answering that feedback; its candidate proposed from another session. */
  async function jobProject() {
    const { layout, tasks } = await historyProject()
    const task = await feedbackTask(layout, 'summarize the august orders by region')
    const job = await improvementJob(layout, [{ kind: 'feedback', feedbackId: task.feedback.id, sessionId: task.sessionId, deliverableId: task.feedback.deliverableId, version: 1, rating: 2, at: new Date().toISOString() }])
    // The propose session's task is not the feedback task.
    const candidate = await proposeCandidate(layout, tasks[2]!, 'function-module', job.id)
    return { layout, tasks, task, job, candidate }
  }

  /** A reviewer whose feedback check passes runs that wrote `good`. */
  function feedbackReviewer(checked: FeedbackCheckInput[], status?: 'unknown'): TrialReviewer {
    return {
      async review() { throw new Error('not expected') },
      async checkFeedback(input) {
        checked.push(input)
        const good = input.output.files.some(file => file.path === 'out/result.txt' && file.text === 'good')
        return { status: status ?? (good ? 'pass' : 'fail'), reason: good ? 'solved' : 'still missing', usage: usage(10), requestCount: 1, estimatedUsd: 0.01 }
      },
    }
  }

  it('replays a per-turn task only up to the turn before its first feedback', async () => {
    const { layout, task } = await jobProject()
    const replay = (await listReplayCases(layout)).find(item => item.caseId === task.taskId)!
    expect(replay.throughTurn).toBe(1)
    expect(replay.messages).toEqual([{ text: 'summarize the august orders by region' }])
    expect(replay.feedback.map(item => [item.turn, item.entry.id])).toEqual([[2, task.feedback.id]])
    // Step-4 tasks replay as before.
    expect((await listReplayCases(layout)).filter(item => item.caseId !== task.taskId).every(item => item.throughTurn === undefined)).toBe(true)
  })

  it('anchors the selection on the job\'s feedback task and adopts when the candidate solves the feedback', async () => {
    const { layout, task, job, candidate } = await jobProject()
    const checked: FeedbackCheckInput[] = []
    const runner = arms({ output: 'good', estimatedUsd: 0.02 }, { output: 'bad', estimatedUsd: 0.02 })
    const receipts: TrialReceipt[] = []
    const result = await runGate({ layout, candidateId: candidate.id, runner, reviewer: feedbackReviewer(checked), tempRoot: await tempDir(), onReceipt: receipt => receipts.push(receipt) })
    if (result.status !== 'decided') throw new Error(`expected a decision, got ${result.status}`)
    expect(result.verdict).toMatchObject({ outcome: 'adopt', feedbackPassRate: { candidate: 1, baseline: 0 } })
    const start = receipts[0]
    if (start?.type !== 'trial.start') throw new Error('no start')
    expect(start.plan.selection[0]).toMatchObject({ caseId: task.taskId, throughTurn: 1, feedbackIds: [task.feedback.id] })
    expect(start.plan.selection.slice(1).every(item => item.feedbackIds === undefined)).toBe(true)
    // Runs of a job's candidate belong to the job; the feedback text is never replayed.
    expect(runner.requests.every(request => request.improvement?.jobId === job.id)).toBe(true)
    const feedbackRuns = runner.requests.filter(request => request.caseId === task.taskId)
    expect(feedbackRuns).toHaveLength(4)
    expect(feedbackRuns.every(request => JSON.stringify(request.messages) === JSON.stringify([{ text: 'summarize the august orders by region' }]))).toBe(true)
    // One feedback check per run of the feedback task, receipts apart from the runs.
    const checks = receipts.filter(receipt => receipt.type === 'trial.feedback')
    expect(checks).toHaveLength(4)
    expect(checks.map(receipt => receipt.type === 'trial.feedback' && [receipt.arm, receipt.status])).toEqual([['candidate', 'pass'], ['baseline', 'fail'], ['candidate', 'pass'], ['baseline', 'fail']])
    expect(checked[0]!.feedback.map(entry => entry.comment)).toEqual(['the summary misses the south region'])
    expect(result.decision.detail).toContain('Feedback checks')
    // Display-only USD sums run and review costs.
    const end = receipts.at(-1)
    if (end?.type !== 'trial.end') throw new Error('no end')
    expect(end.cost.review.estimatedUsd).toBeCloseTo(0.04)
    expect(end.cost.candidate.estimatedUsd).toBeCloseTo(0.02 * 6)
  })

  it('rejects when a feedback check is unknown, or there is no feedback checker', async () => {
    const first = await jobProject()
    const unknown = await runGate({ layout: first.layout, candidateId: first.candidate.id, runner: arms({ output: 'good' }, { output: 'bad' }), reviewer: feedbackReviewer([], 'unknown'), tempRoot: await tempDir() })
    if (unknown.status !== 'decided') throw new Error('expected a decision')
    expect(unknown.verdict).toMatchObject({ outcome: 'reject', reason: 'unknown-runs' })
    const second = await jobProject()
    const none = await runGate({ layout: second.layout, candidateId: second.candidate.id, runner: arms({ output: 'good' }, { output: 'bad' }), tempRoot: await tempDir() })
    if (none.status !== 'decided') throw new Error('expected a decision')
    expect(none.verdict).toMatchObject({ outcome: 'reject', reason: 'unknown-runs' })
  })

  it('rejects when the candidate does not solve the feedback even though its checks pass', async () => {
    const { layout, candidate } = await jobProject()
    const reviewer: TrialReviewer = {
      async review() { throw new Error('not expected') },
      async checkFeedback(input) {
        return { status: input.arm === 'candidate' ? 'fail' : 'pass', reason: 'r', usage: usage(1), requestCount: 1 }
      },
    }
    const result = await runGate({ layout, candidateId: candidate.id, runner: arms({ output: 'good' }, { output: 'good' }), reviewer, tempRoot: await tempDir() })
    if (result.status !== 'decided') throw new Error('expected a decision')
    expect(result.verdict.outcome).toBe('reject')
    expect(result.verdict.feedbackPassRate).toEqual({ candidate: 0, baseline: 1 })
  })

  it('waits for history without writing anything, then runs once the history suffices', async () => {
    const { layout } = await historyProject(['summarize the june orders'])
    const task = await feedbackTask(layout, 'summarize the august orders by region')
    const job = await improvementJob(layout, [{ kind: 'feedback', feedbackId: task.feedback.id, sessionId: task.sessionId, deliverableId: task.feedback.deliverableId, version: 1, rating: 2, at: new Date().toISOString() }])
    const candidate = await proposeCandidate(layout, task, 'function-module', job.id)
    const runner = arms({ output: 'good' }, { output: 'bad' })
    expect((await runGate({ layout, candidateId: candidate.id, runner, reviewer: feedbackReviewer([]), tempRoot: await tempDir() })).status).toBe('waiting')
    expect(await listTrials(layout.capabilities)).toEqual([])
    await pastTask(layout, 'summarize the july orders')
    const result = await runGate({ layout, candidateId: candidate.id, runner, reviewer: feedbackReviewer([]), tempRoot: await tempDir() })
    expect(result.status).toBe('decided')
  })

  it('anchors a check-failure job on its task, without feedback checks', async () => {
    const { layout, tasks } = await historyProject()
    const job = await improvementJob(layout, [{ kind: 'check-failure', taskId: tasks[1]!.taskId, sessionId: tasks[1]!.sessionId, turn: 1, at: new Date().toISOString() }])
    const candidate = await proposeCandidate(layout, tasks[0]!, 'function-module', job.id)
    const receipts: TrialReceipt[] = []
    const result = await runGate({ layout, candidateId: candidate.id, runner: arms({ output: 'good' }, { output: 'bad' }), tempRoot: await tempDir(), onReceipt: receipt => receipts.push(receipt) })
    if (result.status !== 'decided') throw new Error('expected a decision')
    expect(result.verdict).toMatchObject({ outcome: 'adopt' })
    expect(result.verdict.feedbackPassRate).toBeUndefined()
    const start = receipts[0]
    if (start?.type !== 'trial.start') throw new Error('no start')
    expect(start.plan.selection[0]!.caseId).toBe(tasks[1]!.taskId)
    expect(receipts.some(receipt => receipt.type === 'trial.feedback')).toBe(false)
  })

  it('skips a job candidate whose task cannot be replayed', async () => {
    const { layout, tasks } = await historyProject()
    const job = await improvementJob(layout, [{ kind: 'feedback', feedbackId: '00000000-0000-4000-8000-000000000000', sessionId: '11111111-1111-4111-8111-111111111111', deliverableId: 'd', rating: 1, at: new Date().toISOString() }])
    const candidate = await proposeCandidate(layout, tasks[0]!, 'function-module', job.id)
    const result = await runGate({ layout, candidateId: candidate.id, runner: arms({ output: 'good' }, { output: 'bad' }), tempRoot: await tempDir() })
    expect(result.status).toBe('skipped')
  })
})
