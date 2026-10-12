import { access, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
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
  type ReviewInput,
  type TrialReviewer,
} from '../src/index.js'
import { tempDir } from './helpers.js'
import { historyProject, pastTask, proposeCandidate, scriptedRunner, usage, type ArmScript } from './trial-fixture.js'

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

  it('rejects a better candidate that costs more than the cap', async () => {
    const { layout, tasks } = await historyProject()
    const candidate = await proposeCandidate(layout, tasks[0]!)
    const result = await runGate({ layout, candidateId: candidate.id, runner: arms({ output: 'good', tokens: 130 }, { output: 'bad', tokens: 100 }), tempRoot: await tempDir() })
    if (result.status !== 'decided') throw new Error('expected a decision')
    expect(result.verdict).toMatchObject({ outcome: 'reject', reason: 'cost-over-cap', costRatio: 1.3 })
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
    // Selection runs only: 2 cases × 2 repeats.
    expect(asked).toHaveLength(4)
    expect(asked[0]!.candidate.files).toEqual([{ path: 'out/result.txt', text: 'good' }])
    const reviews = (await readTrialReceipts(layout.capabilities, result.trialId)).filter(receipt => receipt.type === 'trial.review')
    expect(reviews).toHaveLength(4)
    expect(result.decision.cost?.review.requestCount).toBe(4)

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

  it('sends a passing plugin candidate to approval instead of adopting it', async () => {
    const { layout, tasks } = await historyProject()
    const candidate = await proposeCandidate(layout, tasks[0]!, 'plugin')
    const result = await runGate({ layout, candidateId: candidate.id, runner: arms({ output: 'good' }, { output: 'bad' }), tempRoot: await tempDir() })
    if (result.status !== 'decided') throw new Error('expected a decision')
    expect(result.decision).toMatchObject({ outcome: 'awaiting-approval', reason: 'quality-up' })
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
