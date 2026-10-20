import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  canonicalEvaluatorText,
  DEFAULT_CAPABILITIES_CONFIG,
  evaluatorSettings,
  type CapabilityDecision,
  type TrialReceipt,
  type WorkspaceLayout,
} from '@nexgent/kernel'
import { LocalDeliverableStore } from '@nexgent/tasking'
import {
  assertSameEpoch,
  candidateInstanceLiterals,
  evaluatorEpoch,
  listTrials,
  readTrialReceipts,
  runGate,
  trialEpoch,
  type TrialReviewer,
} from '../src/index.js'
import { tempDir } from './helpers.js'
import { feedbackTask, historyProject, improvementJob, pastTask, proposeCandidate, scriptedRunner, usage, type ArmScript } from './trial-fixture.js'

const FEEDBACK_TASK = 'summarize the august orders by region'
/** Past tasks that share no word with {@link FEEDBACK_TASK}. */
const UNLIKE = ['draw a cat', 'write one poem', 'fix login bug']

/** A reviewer whose feedback check passes runs that wrote `good`. */
const reviewer: TrialReviewer = {
  async review() { throw new Error('not expected') },
  async checkFeedback(input) {
    const good = input.output.files.some(file => file.path === 'out/result.txt' && file.text === 'good')
    return { status: good ? 'pass' : 'fail', reason: good ? 'solved' : 'still missing', usage: usage(10), requestCount: 1, estimatedUsd: 0.01 }
  },
}

/** Past tasks, a feedback task, a job answering its feedback and the job's candidate. */
async function jobProject(options: { readonly texts?: readonly string[]; readonly comment?: string; readonly moduleSource?: string } = {}) {
  const { layout, tasks } = await historyProject(options.texts)
  const task = await feedbackTask(layout, FEEDBACK_TASK, options.comment)
  const job = await improvementJob(layout, [{ kind: 'feedback', feedbackId: task.feedback.id, sessionId: task.sessionId, deliverableId: task.feedback.deliverableId, version: 1, rating: 2, at: new Date().toISOString() }])
  const candidate = await proposeCandidate(layout, tasks[2]!, 'function-module', job.id, options.moduleSource)
  return { layout, tasks, task, job, candidate }
}

/** Per run: the candidate fixes the feedback task; `similar` says how it does on the other selection tasks. */
function runner(feedbackTaskId: string, similar: 'good' | 'bad') {
  return scriptedRunner((request): ArmScript => {
    const isFeedback = request.caseId === feedbackTaskId
    if (request.arm === 'candidate') return { output: isFeedback || request.set === 'guard' ? 'good' : similar, estimatedUsd: 0.01 }
    return { output: isFeedback ? 'bad' : 'good', estimatedUsd: 0.01 }
  })
}

async function decided(layout: WorkspaceLayout, candidateId: string, run: ReturnType<typeof runner>) {
  const result = await runGate({ layout, candidateId, runner: run, reviewer, tempRoot: await tempDir() })
  if (result.status !== 'decided') throw new Error(`expected a decision, got ${result.status}`)
  return result
}

describe('ADR 0013: similar cases may not get worse', { timeout: 60_000 }, () => {
  it('rejects a job candidate that fixes the feedback task but does worse on the similar tasks', async () => {
    const { layout, task, candidate } = await jobProject()
    const result = await decided(layout, candidate.id, runner(task.taskId, 'bad'))
    expect(result.verdict).toMatchObject({ outcome: 'reject', reason: 'similar-regression', similarPassRate: { candidate: 0, baseline: 1 } })
    // Without the rule the quality (checks and feedback checks) went up.
    expect(result.verdict.passRate.candidate).toBeGreaterThan(result.verdict.passRate.baseline)
    expect(result.decision).toMatchObject({ outcome: 'rejected', reason: 'similar-regression' })
    expect(result.decision.detail).toContain('Similar cases (selection tasks other than the feedback task; deterministic checks only) passed: candidate 0%, baseline 100%')
  })

  it('adopts a job candidate that fixes the feedback task and holds on the similar tasks', async () => {
    const { layout, task, candidate } = await jobProject()
    const result = await decided(layout, candidate.id, runner(task.taskId, 'good'))
    expect(result.verdict).toMatchObject({ outcome: 'adopt', reason: 'quality-up', similarPassRate: { candidate: 1, baseline: 1 } })
  })

  it('rejects a job candidate with no similar task (it would have needed approval)', async () => {
    const { layout, task, candidate } = await jobProject({ texts: UNLIKE })
    const result = await decided(layout, candidate.id, runner(task.taskId, 'good'))
    expect(result.verdict).toMatchObject({ outcome: 'await-approval', reason: 'no-similar-cases' })
    expect(result.verdict.similarPassRate).toBeUndefined()
    expect(result.decision).toMatchObject({ outcome: 'rejected', reason: 'no-similar-cases' })
    expect(result.decision.detail).toContain('it was checked on the feedback task only')
    expect(result.decision.detail).toContain('It was checked on the feedback task only, with no similar past task to show it carries over (ADR 0013). Candidates that need the user\'s approval are no longer adopted.')
  })

  it('leaves a user task\'s own candidate as before', async () => {
    const { layout, tasks } = await historyProject(UNLIKE)
    const candidate = await proposeCandidate(layout, tasks[0]!)
    const run = scriptedRunner(request => ({ output: request.arm === 'candidate' ? 'good' : 'bad' }))
    const result = await decided(layout, candidate.id, run)
    expect(result.verdict).toMatchObject({ outcome: 'adopt', reason: 'quality-up' })
    expect(result.verdict.similarPassRate).toBeUndefined()
    expect(result.decision.detail).not.toContain('Similar cases')
  })
})

describe('ADR 0013: instance literals are rejected before any replay', { timeout: 60_000 }, () => {
  it('rejects a job candidate carrying values of its feedback or deliverables, and replays nothing', async () => {
    const { layout, task, candidate } = await jobProject({
      comment: 'the east total should read 2,384.13',
      moduleSource: 'export function summarize() { return { east: 2384.13, north: 1999.50, regions: 4, at: "2026-10-05" } }\n',
    })
    // The feedback task's deliverable (presented in its session).
    await writeFile(join(layout.root, 'report.md'), 'North 1999.50, South 812.00\n')
    await new LocalDeliverableStore(layout).present({ sessionId: task.sessionId, turn: 1, toolCallId: 'call-present', paths: ['report.md'], summary: 'the report' })
    expect(await candidateInstanceLiterals(layout, candidate)).toHaveLength(2)
    const recorded: CapabilityDecision[] = []
    const run = runner(task.taskId, 'good')
    const result = await runGate({ layout, candidateId: candidate.id, runner: run, reviewer, tempRoot: await tempDir(), onDecision: decision => { recorded.push(decision) } })
    if (result.status !== 'refused') throw new Error(`expected a refusal, got ${result.status}`)
    expect(result.decision).toMatchObject({ outcome: 'rejected', reason: 'instance-literal', trigger: 'gate', candidateId: candidate.id, fromVersion: 'baseline', toVersion: 'baseline' })
    expect(result.decision.trialId).toBeUndefined()
    expect(result.decision.instanceLiterals?.map(hit => [hit.value, hit.path, hit.source.split(':')[0]])).toEqual([
      ['2384.13', 'index.mjs', 'feedback'],
      ['1999.50', 'index.mjs', 'deliverable'],
    ])
    expect(result.decision.detail).toContain('2384.13 in index.mjs')
    // Nothing was replayed: no run, no trial; the ledger gets the decision only.
    expect(run.requests).toEqual([])
    expect(await listTrials(layout.capabilities)).toEqual([])
    expect(recorded.map(decision => decision.id)).toEqual([result.decision.id])
    // Tried once: running again does nothing.
    expect((await runGate({ layout, candidateId: candidate.id, runner: run, reviewer, tempRoot: await tempDir() })).status).toBe('skipped')
  })

  it('does not count a project constant (in two tasks\' messages), and runs the gate', async () => {
    const { layout, task, candidate } = await jobProject({
      texts: ['summarize the june orders by region, threshold 500', 'summarize the july orders by region, threshold 500', 'build the region lookup table'],
      comment: 'flag the regions above 500',
      moduleSource: 'export function summarize() { return 500 }\n',
    })
    expect(await candidateInstanceLiterals(layout, candidate)).toEqual([])
    const result = await decided(layout, candidate.id, runner(task.taskId, 'good'))
    expect(result.verdict).toMatchObject({ outcome: 'adopt' })
  })

  it('does not check a user task\'s own candidate', async () => {
    const { layout, tasks } = await historyProject()
    await pastTask(layout, 'total is 2384.13')
    const candidate = await proposeCandidate(layout, tasks[0]!, 'function-module', undefined, 'export const total = 2384.13\n')
    expect(await candidateInstanceLiterals(layout, candidate)).toBeUndefined()
  })
})

describe('ADR 0013 to 0016: a new evaluator epoch', { timeout: 60_000 }, () => {
  it('derives the epoch from the rules id adr-0016; trials of the adr-0008, adr-0013, adr-0014 and adr-0015 epochs are not compared with new ones', async () => {
    const settings = evaluatorSettings(DEFAULT_CAPABILITIES_CONFIG)
    expect(settings.rules).toBe('adr-0019')
    const epochOf = (rules: string) => createHash('sha256').update(canonicalEvaluatorText({ ...settings, rules } as typeof settings), 'utf8').digest('hex')
    const old = epochOf('adr-0015')
    for (const rules of ['adr-0008', 'adr-0013', 'adr-0014', 'adr-0015']) expect(evaluatorEpoch(DEFAULT_CAPABILITIES_CONFIG)).not.toBe(epochOf(rules))

    const { layout, task, candidate } = await jobProject()
    const result = await decided(layout, candidate.id, runner(task.taskId, 'good'))
    const receipts = await readTrialReceipts(layout.capabilities, result.trialId)
    expect(trialEpoch(receipts)).toBe(evaluatorEpoch(DEFAULT_CAPABILITIES_CONFIG))
    const before = receipts.map(receipt => (receipt.type === 'trial.start' ? { ...receipt, plan: { ...receipt.plan, epoch: old } } : receipt)) as TrialReceipt[]
    expect(() => assertSameEpoch([before, receipts])).toThrow(expect.objectContaining({ code: 'improvement/epoch-mismatch' }))
  })
})
