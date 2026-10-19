import { createHash } from 'node:crypto'
import { access, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_CAPABILITIES_CONFIG, resolveCapabilitiesConfig, type TrialReceipt, type WorkspaceLayout } from '@nexgent/kernel'
import {
  assertSameEpoch,
  CapabilityStore,
  evaluatorEpoch,
  listReplayCases,
  listTrials,
  prepareProjectCopy,
  projectEpoch,
  readTrialReceipts,
  runGate,
  trialEpoch,
} from '../src/index.js'
import { tempDir } from './helpers.js'
import { feedbackTask, historyProject, improvementJob, proposeCandidate, scriptedRunner, type ArmScript } from './trial-fixture.js'

function arms(candidate: ArmScript, baseline: ArmScript) {
  return scriptedRunner(request => (request.arm === 'candidate' ? candidate : baseline))
}

async function writeCapabilities(layout: WorkspaceLayout, capabilities: Record<string, unknown>): Promise<void> {
  await writeFile(layout.configFile, JSON.stringify({ version: 1, capabilities }))
}

/** Every file under a directory with its content hash (to prove nothing changed). */
async function fingerprint(root: string): Promise<Map<string, string>> {
  const found = new Map<string, string>()
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const path = join(entry.parentPath, entry.name)
    found.set(relative(root, path), createHash('sha256').update(await readFile(path)).digest('hex'))
  }
  return found
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false)
}

describe('evaluator epoch (ADR 0008 decision 5)', () => {
  it('is the hash of the evaluator settings only', () => {
    const base = evaluatorEpoch(DEFAULT_CAPABILITIES_CONFIG)
    expect(base).toMatch(/^[0-9a-f]{64}$/)
    // Not part of the evaluator: the counts and the budget.
    expect(evaluatorEpoch(resolveCapabilitiesConfig({ repeats: 3, selectionCases: 4, trialBudget: { maxTokens: 5 } }))).toBe(base)
    // Part of it: every evaluator setting.
    for (const changed of [{ costRatioCap: 1.3 }, { costApprovalRatio: 3 }, { guardCases: 2 }, { reviewer: { model: 'claude-opus-5-5' } }, { reviewer: { thinking: 'off' as const } }]) {
      expect(evaluatorEpoch(resolveCapabilitiesConfig(changed))).not.toBe(base)
    }
  })

  it('is frozen into the trial plan; trials of different epochs are not compared', async () => {
    const first = await historyProject()
    const one = await runGate({ layout: first.layout, candidateId: (await proposeCandidate(first.layout, first.tasks[0]!)).id, runner: arms({ output: 'good' }, { output: 'bad' }), tempRoot: await tempDir() })
    if (one.status !== 'decided') throw new Error(one.status)
    const receiptsOne = await readTrialReceipts(first.layout.capabilities, one.trialId)
    expect(trialEpoch(receiptsOne)).toBe(await projectEpoch(first.layout))

    const second = await historyProject()
    await writeCapabilities(second.layout, { costRatioCap: 1.5 })
    const two = await runGate({ layout: second.layout, candidateId: (await proposeCandidate(second.layout, second.tasks[0]!)).id, runner: arms({ output: 'good' }, { output: 'bad' }), tempRoot: await tempDir() })
    if (two.status !== 'decided') throw new Error(two.status)
    const receiptsTwo = await readTrialReceipts(second.layout.capabilities, two.trialId)
    expect(trialEpoch(receiptsTwo)).not.toBe(trialEpoch(receiptsOne))

    expect(assertSameEpoch([receiptsOne, receiptsOne])).toBe(trialEpoch(receiptsOne))
    expect(() => assertSameEpoch([receiptsOne, receiptsTwo])).toThrow(expect.objectContaining({ code: 'improvement/epoch-mismatch' }))
    // A step-4/5 trial has no epoch: never comparable.
    const old = receiptsOne.map(receipt => (receipt.type === 'trial.start' ? { ...receipt, plan: { ...receipt.plan, epoch: undefined } } : receipt)) as TrialReceipt[]
    expect(() => assertSameEpoch([old, receiptsOne])).toThrow(expect.objectContaining({ code: 'improvement/epoch-mismatch' }))
  })

  it('refuses to run in another epoch than the caller expects, and writes nothing', async () => {
    const { layout, tasks } = await historyProject()
    const candidate = await proposeCandidate(layout, tasks[0]!)
    const runner = arms({ output: 'good' }, { output: 'bad' })
    const other = evaluatorEpoch(resolveCapabilitiesConfig({ costApprovalRatio: 4 }))
    await expect(runGate({ layout, candidateId: candidate.id, runner, tempRoot: await tempDir(), epoch: other })).rejects.toMatchObject({ code: 'improvement/epoch-mismatch' })
    expect(runner.requests).toEqual([])
    expect(await listTrials(layout.capabilities)).toEqual([])
    // The candidate was not claimed: the right epoch runs it.
    const result = await runGate({ layout, candidateId: candidate.id, runner, tempRoot: await tempDir(), epoch: await projectEpoch(layout) })
    expect(result.status).toBe('decided')
  })
})

describe('the gate in a project copy (nested copies)', { timeout: 60_000 }, () => {
  it('comes to the same verdict as in the real project, adopts only in the copy and never touches the project', async () => {
    const { layout, tasks } = await historyProject()
    const origin = (await listReplayCases(layout)).find(item => item.caseId === tasks[0]!.taskId)!
    const before = await fingerprint(layout.root)
    const copy = await prepareProjectCopy({ layout, origin, version: 'baseline', tempRoot: await tempDir() })
    expect(copy.epoch).toBe(await projectEpoch(layout))
    // The copy has the project's history and the origin's working tree.
    expect(await readFile(join(copy.root, 'check.mjs'), 'utf8')).toBe(await readFile(join(layout.root, 'check.mjs'), 'utf8'))
    expect((await listReplayCases(copy.layout)).map(item => item.caseId).sort()).toEqual((await listReplayCases(layout)).map(item => item.caseId).sort())
    const config = JSON.parse(await readFile(copy.layout.configFile, 'utf8')) as { autoImprove: boolean; capabilities: { autoTrial: boolean } }
    expect(config).toMatchObject({ autoImprove: false, capabilities: { autoTrial: false } })

    // The gate in the copy builds its own replay copies (outside the copy) and adopts there.
    const inCopy = await proposeCandidate(copy.layout, tasks[0]!)
    const copyRunner = arms({ output: 'good' }, { output: 'bad' })
    const nested = await runGate({ layout: copy.layout, candidateId: inCopy.id, runner: copyRunner, tempRoot: await tempDir() })
    if (nested.status !== 'decided') throw new Error(nested.status)
    expect(copyRunner.requests.every(request => !request.projectRoot.startsWith(copy.root) && !request.projectRoot.startsWith(layout.root))).toBe(true)
    expect((await new CapabilityStore(copy.layout.capabilities).activation()).version).toBe(inCopy.version)
    expect(await fingerprint(layout.root)).toEqual(before)
    expect((await new CapabilityStore(layout.capabilities).activation()).version).toBe('baseline')

    // The same candidate in the real project: the same verdict.
    const inProject = await proposeCandidate(layout, tasks[0]!)
    const real = await runGate({ layout, candidateId: inProject.id, runner: arms({ output: 'good' }, { output: 'bad' }), tempRoot: await tempDir() })
    if (real.status !== 'decided') throw new Error(real.status)
    expect(real.verdict).toEqual(nested.verdict)
    expect(trialEpoch(await readTrialReceipts(layout.capabilities, real.trialId))).toBe(trialEpoch(await readTrialReceipts(copy.layout.capabilities, nested.trialId)))
    expect((await copy.release()).status).toBe('removed')
    expect(await exists(copy.root)).toBe(false)
  })

  it('attributes a comparison arm job\'s runs to the arm, its meta job and its improver', async () => {
    const { layout } = await historyProject()
    const task = await feedbackTask(layout, 'summarize the august orders by region')
    const job = await improvementJob(layout, [{ kind: 'feedback', feedbackId: task.feedback.id, sessionId: task.sessionId, deliverableId: task.feedback.deliverableId, version: 1, rating: 2, at: new Date().toISOString() }])
    const metaJobId = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'
    const path = join(layout.dataDir, 'improvements', job.id, 'job.json')
    await writeFile(path, JSON.stringify({ ...job, improverVersion: 'v0', improverScope: 'user', arm: { metaJobId, arm: 'child' } }))
    const candidate = await proposeCandidate(layout, task, 'function-module', job.id)
    const runner = arms({ output: 'good' }, { output: 'bad' })
    const reviewer = { async review() { throw new Error('not expected') }, async checkFeedback() { return { status: 'pass' as const, reason: 'ok', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2, reasoningTokens: 0 }, requestCount: 1 } } }
    await runGate({ layout, candidateId: candidate.id, runner, reviewer, tempRoot: await tempDir() })
    expect(runner.requests.length).toBeGreaterThan(0)
    for (const request of runner.requests) expect(request.improvement).toEqual({ jobId: job.id, improverVersion: 'v0', improverScope: 'user', metaJobId, comparisonArm: 'child' })
  })

  it('keeps a copy on request when it is small enough, and deletes a larger one', async () => {
    const { layout, tasks } = await historyProject()
    const origin = (await listReplayCases(layout)).find(item => item.caseId === tasks[0]!.taskId)!
    const kept = await prepareProjectCopy({ layout, origin, version: 'baseline', tempRoot: await tempDir() })
    const result = await kept.release({ keep: true })
    if (result.status !== 'kept') throw new Error(result.status)
    expect(result.copy.root).toBe(kept.root)
    expect(result.copy.bytes).toBeGreaterThan(0)
    expect((await stat(kept.root)).isDirectory()).toBe(true)
    expect(await kept.release()).toBe(result)

    const large = await prepareProjectCopy({ layout, origin, version: 'baseline', tempRoot: await tempDir(), keepMaxBytes: 10 })
    const refused = await large.release({ keep: true })
    expect(refused.status).toBe('too-large')
    expect(await exists(large.root)).toBe(false)
  })

  it('refuses a copy inside the project', async () => {
    const { layout, tasks } = await historyProject()
    const origin = (await listReplayCases(layout)).find(item => item.caseId === tasks[0]!.taskId)!
    await expect(prepareProjectCopy({ layout, origin, version: 'baseline', tempRoot: join(layout.root, 'tmp') })).rejects.toMatchObject({ code: 'tool/invalid-input' })
  })
})
