import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveWorkspaceLayout, type TaskCheckSpec, type WorkspaceLayout } from '@nexgent/kernel'
import { LocalDeliverableStore } from '@nexgent/tasking'
import { contentSimilarity, isSimilarTask, runCheckSpecs, runGate, SIMILAR_CASE_MIN, type ReplayRunRequest, type TrialReviewer } from '../src/index.js'
import { tempDir } from './helpers.js'
import { feedbackTask, historyProject, improvementJob, pastTask, proposeCandidate, scriptedRunner, usage } from './trial-fixture.js'

/** Write `files` into a run's copy and present them (as `present` does). */
async function deliver(root: string, files: Record<string, string>, present = true): Promise<void> {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(root, ...path.split('/').slice(0, -1)), { recursive: true })
    await writeFile(join(root, ...path.split('/')), text)
  }
  if (present) await new LocalDeliverableStore(resolveWorkspaceLayout(root)).present({ sessionId: '00000000-0000-4000-8000-000000000001', turn: 1, toolCallId: 'call-present', paths: Object.keys(files), summary: 'the output' })
}

describe('ADR 0014: recorded deliverable paths follow the run\'s own deliverables', () => {
  const report: TaskCheckSpec[] = [
    { id: 'file-1', name: 'file-exists', path: 'out/my report.csv' },
    { id: 'parse-1', name: 'parses', path: 'out/my report.csv', format: 'csv' },
  ]

  it('checks a renamed or moved deliverable of the same kind in place of the recorded path', async () => {
    const root = await tempDir()
    await deliver(root, { 'archive/my_report.csv': 'a,b\n1,2\n' })
    const checks = await runCheckSpecs(root, report, { delivered: ['archive/my_report.csv'] })
    expect(checks).toEqual([
      { name: 'file-exists', passed: true, detail: 'delivered under another path', target: 'file-1' },
      { name: 'parses', passed: true, detail: 'delivered under another path', target: 'parse-1' },
    ])
    // The stand-in is checked for real: a broken file of the same kind still fails to parse.
    const broken = await tempDir()
    await deliver(broken, { 'my_report.csv': 'a,b\n1,"2\n' })
    expect((await runCheckSpecs(broken, report, { delivered: ['my_report.csv'] }))[1]).toMatchObject({ passed: false })
  })

  it('still fails without a presented file of that kind, or without the run\'s deliverables', async () => {
    const root = await tempDir()
    await deliver(root, { 'my_report.xlsx.txt': 'not a csv', 'my_report.csv': 'a\n1\n' }, false)
    // Nothing presented: the recorded path only (the step-4 behaviour).
    expect((await runCheckSpecs(root, report)).map(check => check.passed)).toEqual([false, false])
    // Presented, but of another kind.
    expect((await runCheckSpecs(root, report, { delivered: ['my_report.xlsx.txt'] })).map(check => check.passed)).toEqual([false, false])
    // Presented but deleted afterwards.
    expect((await runCheckSpecs(root, report, { delivered: ['gone.csv'] })).map(check => check.passed)).toEqual([false, false])
  })

  it('maps one presented file to one recorded path, and keeps a recorded path that is still there', async () => {
    const root = await tempDir()
    await deliver(root, { 'a.csv': 'x\n1\n', 'b_new.csv': 'x\n2\n' })
    const specs: TaskCheckSpec[] = [
      { id: 'file-1', name: 'file-exists', path: 'a.csv' },
      { id: 'file-2', name: 'file-exists', path: 'b old.csv' },
      { id: 'file-3', name: 'file-exists', path: 'c old.csv' },
    ]
    // a.csv is where it was recorded (not a stand-in); b_new.csv stands in for "b old.csv"; nothing is left for "c old.csv".
    expect(await runCheckSpecs(root, specs, { delivered: ['a.csv', 'b_new.csv'] })).toEqual([
      { name: 'file-exists', passed: true, target: 'file-1' },
      { name: 'file-exists', passed: true, detail: 'delivered under another path', target: 'file-2' },
      { name: 'file-exists', passed: false, detail: 'missing', target: 'file-3' },
    ])
  })

  it('lets the gate adopt a job candidate that renames outputs the way the feedback asks, on every task', { timeout: 60_000 }, async () => {
    const checks: TaskCheckSpec[] = [{ id: 'file-1', name: 'file-exists', path: 'out/my report.csv' }, { id: 'parse-1', name: 'parses', path: 'out/my report.csv', format: 'csv' }]
    const root = await tempDir()
    const layout: WorkspaceLayout = resolveWorkspaceLayout(root)
    await mkdir(layout.dataDir, { recursive: true })
    await writeFile(join(root, 'data.csv'), 'region,amount\nnorth,1\n')
    const tasks = []
    for (const text of ['merge the june sales sheets into one report', 'merge the july sales sheets into one report', 'rename the scanned invoices by date']) tasks.push(await pastTask(layout, text, { specs: checks }))
    const task = await feedbackTask(layout, 'merge the august sales sheets into one report', 'file names must not contain spaces', checks)
    const job = await improvementJob(layout, [{ kind: 'feedback', feedbackId: task.feedback.id, sessionId: task.sessionId, deliverableId: task.feedback.deliverableId, version: 1, rating: 2, at: new Date().toISOString() }])
    const candidate = await proposeCandidate(layout, tasks[2]!, 'function-module', job.id)
    const reviewer: TrialReviewer = {
      async review() { throw new Error('not expected') },
      async checkFeedback(input) {
        const spaced = input.output.files.some(file => file.path.includes(' '))
        return { status: spaced ? 'fail' : 'pass', reason: spaced ? 'a name has a space' : 'no spaces', usage: usage(10), requestCount: 1, estimatedUsd: 0.01 }
      },
    }
    // The candidate applies the convention everywhere (guard tasks too); the baseline keeps the old name.
    const runner = (presents: boolean) => {
      const inner = scriptedRunner(() => ({ estimatedUsd: 0.01 }))
      return {
        requests: inner.requests,
        async run(request: ReplayRunRequest, signal: AbortSignal) {
          await deliver(request.projectRoot, { [request.arm === 'candidate' ? 'out/my_report.csv' : 'out/my report.csv']: 'region,amount\nnorth,1\n' }, presents)
          return inner.run(request, signal)
        },
      }
    }
    const adopted = await runGate({ layout, candidateId: candidate.id, runner: runner(true), reviewer, tempRoot: await tempDir() })
    if (adopted.status !== 'decided') throw new Error(adopted.status)
    expect(adopted.verdict).toMatchObject({ outcome: 'adopt', reason: 'quality-up', passRate: { candidate: 1 }, similarPassRate: { candidate: 1, baseline: 1 } })

    // Before ADR 0014 (no deliverables to follow) the same rename read as a regression.
    const again = await proposeCandidate(layout, tasks[2]!, 'function-module', job.id, 'export function summarize() { return 2 }\n')
    const before = await runGate({ layout, candidateId: again.id, runner: runner(false), reviewer, tempRoot: await tempDir() })
    if (before.status !== 'decided') throw new Error(before.status)
    expect(before.verdict.outcome).toBe('reject')
  })
})

describe('ADR 0014: similar cases by content words', () => {
  it('does not count shared function words or instance numbers', () => {
    // Under ADR 0013's first reading any shared word counted ("the", "please").
    expect(contentSimilarity('please summarize the august orders by region', 'please write the poem for the class')).toBe(0)
    expect(isSimilarTask('please summarize the august orders by region', 'please write the poem for the class')).toBe(false)
    expect(isSimilarTask('把八月的订单按地区汇总成表', '请写一份会议纪要')).toBe(false)
    // Months, ids and amounts are the instance's: two instances of one task are the same task.
    expect(contentSimilarity('Write the region table of data/orders-2026-08.csv', 'Write the region table of data/orders-2026-09.csv')).toBe(1)
  })

  it('counts tasks of the same kind', () => {
    expect(isSimilarTask('summarize the august orders by region', 'summarize the june orders by region')).toBe(true)
    expect(isSimilarTask('把八月的订单按地区汇总成表', '把九月的订单按地区汇总成表')).toBe(true)
    expect(isSimilarTask('merge the csv files into one xlsx workbook', 'merge the quarterly csv exports into an xlsx workbook')).toBe(true)
    expect(SIMILAR_CASE_MIN).toBe(0.25)
  })

  it('makes a job candidate wait when the other selection tasks share only function words with the feedback task', { timeout: 60_000 }, async () => {
    const { layout, tasks } = await historyProject(['write the poem for the class', 'fix the login bug in the app', 'draw the cat on the page'])
    const task = await feedbackTask(layout, 'summarize the august orders by region')
    const job = await improvementJob(layout, [{ kind: 'feedback', feedbackId: task.feedback.id, sessionId: task.sessionId, deliverableId: task.feedback.deliverableId, version: 1, rating: 2, at: new Date().toISOString() }])
    const candidate = await proposeCandidate(layout, tasks[2]!, 'function-module', job.id)
    const reviewer: TrialReviewer = {
      async review() { throw new Error('not expected') },
      async checkFeedback(input) {
        const good = input.output.files.some(file => file.path === 'out/result.txt' && file.text === 'good')
        return { status: good ? 'pass' : 'fail', reason: 'r', usage: usage(10), requestCount: 1, estimatedUsd: 0.01 }
      },
    }
    const runner = scriptedRunner(request => ({ output: request.arm === 'candidate' || request.caseId !== task.taskId ? 'good' : 'bad', estimatedUsd: 0.01 }))
    const result = await runGate({ layout, candidateId: candidate.id, runner, reviewer, tempRoot: await tempDir() })
    if (result.status !== 'decided') throw new Error(result.status)
    expect(result.verdict).toMatchObject({ outcome: 'await-approval', reason: 'no-similar-cases' })
  })
})
