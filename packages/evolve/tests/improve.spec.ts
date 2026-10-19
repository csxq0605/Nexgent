import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { IMPROVEMENT_DIAGNOSIS_TOOLS, ZERO_USAGE, type CapabilityDecision, type ImprovementSignal, type WorkspaceLayout } from '@nexgent/kernel'
import { CapabilityStore, listCandidates } from '@nexgent/capabilities'
import { JsonlLedger, validateImprovementFile } from '@nexgent/session'
import {
  createImprovementStages,
  createJob,
  diagnosisTools,
  findFeedbackTask,
  pendingContextPolicies,
  ImprovementHost,
  improvementsDir,
  jobPaths,
  readJob,
  runImprovementJob,
  sweepAdoptedJobs,
  transitionJob,
  type DiagnosisState,
  type GateOutcome,
  type TrialStarter,
} from '../src/index.js'
import { ASK, callTool, feedbackTask, proposeIn, report, scriptedRunner, type FeedbackTaskFixture, type TurnScript } from './history.js'

const VERSION = 'a'.repeat(64)

function signal(fixture: FeedbackTaskFixture): ImprovementSignal {
  return {
    kind: 'feedback',
    feedbackId: fixture.feedback.id,
    sessionId: fixture.sessionId,
    deliverableId: fixture.feedback.deliverableId,
    version: 1,
    rating: 2,
    at: new Date().toISOString(),
  }
}

async function queuedJob(fixture: FeedbackTaskFixture) {
  return createJob(improvementsDir(fixture.layout), { trigger: 'feedback-count', items: [signal(fixture)] })
}

/** A gate that records a real decision with the given outcome. */
function gate(outcome: 'adopted' | 'rejected' | 'waiting'): TrialStarter & { calls: number } {
  const starter = async ({ layout, candidateId }: { layout: WorkspaceLayout; candidateId: string }): Promise<GateOutcome> => {
    starter.calls += 1
    if (outcome === 'waiting') return { status: 'waiting', detail: 'only 1 past task, 3 needed' }
    const trialId = '22222222-2222-4222-8222-222222222222'
    const decision: CapabilityDecision = await new CapabilityStore(layout.capabilities).recordDecision({
      outcome,
      reason: outcome === 'adopted' ? 'quality-up' : 'quality-down',
      trigger: 'gate',
      candidateId,
      trialId,
      fromVersion: 'baseline',
      toVersion: outcome === 'adopted' ? VERSION : 'baseline',
      detail: outcome === 'adopted' ? 'the candidate passed more checks' : 'no better than the baseline',
    })
    return { status: 'decided', trialId, decision }
  }
  starter.calls = 0
  return starter
}

const reportOnce = (fixture: FeedbackTaskFixture, kind = 'function-module'): TurnScript => async request => {
  await callTool(request, 'improve_report_diagnosis', report(fixture, kind))
}

/** The propose session uses the component and proposes it (in the copy, as a runner that does not route candidates would). */
const proposeInCopy = (fixture: FeedbackTaskFixture): TurnScript => async request => {
  const { join } = await import('node:path')
  await proposeIn(join(request.workspaceRoot!, '.nexgent', 'capabilities'), request.sessionId, fixture.taskId)
}

describe('the four read-only diagnosis tools', () => {
  it('read the session, the ledger and the feedback, and accept a report only with real evidence', async () => {
    const fixture = await feedbackTask()
    const job = await queuedJob(fixture)
    const state: DiagnosisState = { attempts: 0 }
    const tools = diagnosisTools({ layout: fixture.layout, job, sessionId: '33333333-3333-4333-8333-333333333333', taskIds: [fixture.taskId], state })
    expect(tools.map(tool => tool.definition.name)).toEqual(IMPROVEMENT_DIAGNOSIS_TOOLS.map(tool => tool.name))
    const call = (name: string, input: unknown) => tools.find(tool => tool.definition.name === name)!.handler(input, {} as never)

    const session = await call('improve_read_session', { sessionId: fixture.sessionId, types: ['feedback'] })
    expect(session.content).toContain('the region column is missing again')
    expect(session.content).not.toContain(ASK)
    expect((await call('improve_read_session', { sessionId: 'nope' })).isError).toBe(true)
    expect((await call('improve_list_feedback', { sessionId: fixture.sessionId })).content).toContain(fixture.feedback.id)
    expect((await call('improve_read_ledger', { taskId: fixture.taskId })).content).toBe('(no ledger records match)')

    const bad = await call('improve_report_diagnosis', report(fixture, 'function-module', {
      failureTypes: [{ category: 'task-verification', label: 'x', evidence: [{ sessionId: fixture.sessionId, seq: 9999 }] }],
    }))
    expect(bad.isError).toBe(true)
    expect(bad.content).toMatch(/no record seq 9999/)
    expect(state.attempts).toBe(1)
    expect(state.accepted).toBeUndefined()

    const good = await call('improve_report_diagnosis', report(fixture))
    expect(good.isError).toBeUndefined()
    expect(state.accepted).toMatchObject({ jobId: job.id, attempts: 2, proposalKind: 'function-module' })
    const written: unknown = JSON.parse(await readFile(jobPaths(improvementsDir(fixture.layout), job.id).diagnosis, 'utf8'))
    expect(validateImprovementFile('diagnosis', written)).toEqual([])
    expect((await call('improve_report_diagnosis', report(fixture))).content).toMatch(/already accepted/)
  })

  it('refuse a proposal without any failure type', async () => {
    const fixture = await feedbackTask()
    const job = await queuedJob(fixture)
    const state: DiagnosisState = { attempts: 0 }
    const tools = diagnosisTools({ layout: fixture.layout, job, sessionId: '33333333-3333-4333-8333-333333333333', taskIds: [], state })
    const result = await tools[3]!.handler(report(fixture, 'skill', { failureTypes: [] }), {} as never)
    expect(result.isError).toBe(true)
    expect(state.lastProblems?.join(' ')).toMatch(/at least one failure/)
  })
})

describe('pending context policies', () => {
  it('lists tried context policies until something is proposed', () => {
    const tried = { type: 'capability.try', seq: 1, ts: '', turn: 1, step: 1, toolCallId: 'c', component: { kind: 'context-policy', name: 'p' }, revision: 1 }
    const skill = { ...tried, seq: 2, component: { kind: 'skill', name: 's' } }
    expect(pendingContextPolicies([tried, skill] as never)).toEqual([{ kind: 'context-policy', name: 'p' }])
    expect(pendingContextPolicies([tried, { type: 'capability.propose', seq: 3, ts: '', turn: 2, step: 1, toolCallId: 'd', candidateId: 'x', proofs: [] }] as never)).toEqual([])
    expect(pendingContextPolicies([skill] as never)).toEqual([])
  })
})

describe('the feedback task', () => {
  it('replays the user messages before the first feedback, never the feedback itself', async () => {
    const fixture = await feedbackTask()
    const task = await findFeedbackTask(fixture.layout, await queuedJob(fixture))
    expect(task).toMatchObject({ firstFeedbackTurn: 2, sandboxMode: 'workspace-write', messages: [{ text: ASK }] })
    expect(task.replay.caseId).toBe(fixture.taskId)
  })
})

describe('an improvement job with a session runner (the three playbooks)', () => {
  it('should improve: diagnoses, redoes the task in a copy, proposes one component marked as the job\'s, and the gate adopts it', async () => {
    const fixture = await feedbackTask()
    const job = await queuedJob(fixture)
    const runner = scriptedRunner({ diagnose: reportOnce(fixture), propose: proposeInCopy(fixture) })
    const startTrial = gate('adopted')
    await runImprovementJob(fixture.layout, job.id, { stages: createImprovementStages({ runner, startTrial }) })
    const done = await readJob(improvementsDir(fixture.layout), job.id)
    expect(done.status).toBe('adopted')
    expect(done.diagnosed).toMatchObject({ proposalKind: 'function-module', attempts: 1 })
    expect(done.baseVersion).toBe('baseline')
    expect(Object.keys(done.phases).sort()).toEqual(['diagnose', 'propose', 'trial'])
    expect(done.trialId).toBeDefined()
    expect(done.decisionId).toBeDefined()

    const [diagnose, propose] = runner.opened
    expect(diagnose).toMatchObject({ phase: 'diagnose', jobId: job.id, model: 'claude-sonnet-5-5', thinking: 'on', sessionId: done.sessions?.diagnose })
    expect(diagnose!.tools!.map(tool => tool.definition.name)).toEqual(IMPROVEMENT_DIAGNOSIS_TOOLS.map(tool => tool.name))
    expect(propose).toMatchObject({ phase: 'propose', sessionId: done.sessions?.propose, sandboxMode: 'workspace-write' })
    expect(propose!.workspaceRoot).not.toBe(fixture.layout.root)
    expect(propose!.tools).toBeUndefined()
    // The proposal request carries the brief and then the original ask verbatim (what the playbooks key on).
    expect(runner.texts[1]).toMatch(/^# Improvement job[\s\S]*# The task\n/)
    expect(runner.texts[1]!.endsWith(ASK)).toBe(true)

    const candidates = await listCandidates(fixture.layout.capabilities)
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({ id: done.candidateId, origin: 'improvement', jobId: job.id, sessionId: done.sessions?.propose })

    const ends = []
    for await (const record of new JsonlLedger({ ledgersDir: fixture.layout.ledgers }).read({ types: ['improvement.end'] })) ends.push(record)
    expect(ends).toEqual([expect.objectContaining({ jobId: job.id, status: 'adopted', trigger: 'feedback-count', candidateId: done.candidateId })])
  })

  it('takes a candidate the runner routed to the real project when it is marked as the job\'s', async () => {
    const fixture = await feedbackTask()
    const job = await queuedJob(fixture)
    const runner = scriptedRunner({
      diagnose: reportOnce(fixture),
      propose: async request => { await proposeIn(fixture.layout.capabilities, request.sessionId, fixture.taskId, { origin: 'improvement', jobId: request.jobId }) },
    })
    await runImprovementJob(fixture.layout, job.id, { stages: createImprovementStages({ runner, startTrial: gate('rejected') }) })
    const done = await readJob(improvementsDir(fixture.layout), job.id)
    expect(done.status).toBe('rejected')
    expect(await listCandidates(fixture.layout.capabilities)).toHaveLength(1)
  })

  it('not a capability problem: the diagnosis says none and the job ends no-proposal without a propose session', async () => {
    const fixture = await feedbackTask()
    const job = await queuedJob(fixture)
    const runner = scriptedRunner({ diagnose: reportOnce(fixture, 'none') })
    const startTrial = gate('adopted')
    await runImprovementJob(fixture.layout, job.id, { stages: createImprovementStages({ runner, startTrial }) })
    const done = await readJob(improvementsDir(fixture.layout), job.id)
    expect(done).toMatchObject({ status: 'no-proposal', diagnosed: { proposalKind: 'none' } })
    expect(done.detail).toMatch(/Not a capability problem/)
    expect(runner.opened.map(request => request.phase)).toEqual(['diagnose'])
    expect(startTrial.calls).toBe(0)
  })

  it('the proposal never runs: no candidate means the job failed, and the copy is gone', async () => {
    const fixture = await feedbackTask()
    const job = await queuedJob(fixture)
    const runner = scriptedRunner({ diagnose: reportOnce(fixture) })
    await runImprovementJob(fixture.layout, job.id, { stages: createImprovementStages({ runner, startTrial: gate('adopted') }) })
    const done = await readJob(improvementsDir(fixture.layout), job.id)
    expect(done.status).toBe('failed')
    expect(done.detail).toMatch(/without a candidate/)
    expect(done.phases.propose).toBeDefined()
    const { existsSync } = await import('node:fs')
    expect(existsSync(runner.opened[1]!.workspaceRoot!)).toBe(false)
  })

  it('a session that never reports a valid diagnosis ends failed after three attempts', async () => {
    const fixture = await feedbackTask()
    const job = await queuedJob(fixture)
    const runner = scriptedRunner({ diagnose: async (request, _text, index) => { if (index === 1) await callTool(request, 'improve_report_diagnosis', { proposalKind: 'skill' }) } })
    await runImprovementJob(fixture.layout, job.id, { stages: createImprovementStages({ runner, startTrial: gate('adopted') }) })
    const done = await readJob(improvementsDir(fixture.layout), job.id)
    expect(done.status).toBe('failed')
    expect(done.error?.code).toBe('improvement/invalid-diagnosis')
    expect(runner.texts).toHaveLength(3)
    expect(runner.texts[1]).toMatch(/improve_report_diagnosis/)
  })

  it('a diagnosis that asks for a plugin fails the job (plugins cannot be proposed headless)', async () => {
    const fixture = await feedbackTask()
    const job = await queuedJob(fixture)
    const runner = scriptedRunner({ diagnose: reportOnce(fixture, 'plugin') })
    await runImprovementJob(fixture.layout, job.id, { stages: createImprovementStages({ runner, startTrial: gate('adopted') }) })
    expect(await readJob(improvementsDir(fixture.layout), job.id)).toMatchObject({ status: 'failed' })
    expect(runner.opened).toHaveLength(1)
  })

  it('a context policy tried in the task gets one turn to check under it and one to propose it', async () => {
    const fixture = await feedbackTask()
    const job = await queuedJob(fixture)
    const { JsonlSessionStore } = await import('@nexgent/session')
    const store = new JsonlSessionStore({ sessionsDir: fixture.layout.sessions })
    const policy = { kind: 'context-policy' as const, name: 'region-table-rules' }
    let lock: Awaited<ReturnType<typeof store.create>> | undefined
    const turn = async (sessionId: string, n: number, extra?: () => Promise<unknown>) => {
      await store.append(sessionId, { type: 'turn.start', turn: n })
      await extra?.()
      await store.append(sessionId, { type: 'turn.end', turn: n, reason: { kind: 'completed' } })
    }
    const runner = scriptedRunner({
      diagnose: reportOnce(fixture, 'context-policy'),
      propose: async (request, _text, index) => {
        if (index === 0) {
          // The task turn: the policy is drafted and tried; proposing it now would be refused.
          lock = await store.create({ sessionId: request.sessionId, projectRoot: fixture.layout.root, model: 'claude-sonnet-5-5', sandboxMode: 'workspace-write', capabilityVersion: 'baseline' })
          await turn(request.sessionId, 1, () => store.append(request.sessionId, { type: 'capability.try', turn: 1, step: 1, toolCallId: 'call-try', component: policy, revision: 1 }))
        } else if (index === 1) {
          await turn(request.sessionId, 2)
        } else {
          await turn(request.sessionId, 3, () => proposeIn(fixture.layout.capabilities, request.sessionId, fixture.taskId, { origin: 'improvement', jobId: request.jobId }))
          await store.release(lock!)
        }
      },
    })
    await runImprovementJob(fixture.layout, job.id, { stages: createImprovementStages({ runner, startTrial: gate('adopted') }) })
    const done = await readJob(improvementsDir(fixture.layout), job.id)
    expect(done.status).toBe('adopted')
    expect(runner.texts).toHaveLength(4)
    expect(runner.texts[1]).toMatch(/context-policy takes effect from the turn after you try it/)
    expect(runner.texts[2]).toMatch(/region-table-rules is in effect now[\s\S]*Do not call capability_try or capability_propose/)
    expect(runner.texts[3]).toMatch(/call capability_propose with exactly that one component \(kind context-policy\)/)
  })

  it('a skill proposed in the task turn gets no extra turns', async () => {
    const fixture = await feedbackTask()
    const job = await queuedJob(fixture)
    const runner = scriptedRunner({ diagnose: reportOnce(fixture, 'skill'), propose: proposeInCopy(fixture) })
    await runImprovementJob(fixture.layout, job.id, { stages: createImprovementStages({ runner, startTrial: gate('adopted') }) })
    expect(runner.texts).toHaveLength(2)
  })

  it('a gate waiting for history parks the job; once resumed only the trial runs', async () => {
    const fixture = await feedbackTask()
    const job = await queuedJob(fixture)
    const runner = scriptedRunner({ diagnose: reportOnce(fixture), propose: proposeInCopy(fixture) })
    await runImprovementJob(fixture.layout, job.id, { stages: createImprovementStages({ runner, startTrial: gate('waiting') }) })
    const parked = await readJob(improvementsDir(fixture.layout), job.id)
    expect(parked.status).toBe('waiting-history')
    expect(parked.candidateId).toBeDefined()
    const later = scriptedRunner({})
    await runImprovementJob(fixture.layout, job.id, { stages: createImprovementStages({ runner: later, startTrial: gate('adopted') }) })
    const done = await readJob(improvementsDir(fixture.layout), job.id)
    expect(done.status).toBe('adopted')
    expect(done.candidateId).toBe(parked.candidateId)
    expect(later.opened).toHaveLength(0)
  })
})

describe('after adoption', () => {
  it('records the first root task that used the component on the adopted version, and a later rollback', async () => {
    const fixture = await feedbackTask()
    const job = await queuedJob(fixture)
    const runner = scriptedRunner({ diagnose: reportOnce(fixture), propose: proposeInCopy(fixture) })
    await runImprovementJob(fixture.layout, job.id, { stages: createImprovementStages({ runner, startTrial: gate('adopted') }) })
    expect(await sweepAdoptedJobs(fixture.layout)).toEqual([])

    const ledger = new JsonlLedger({ ledgersDir: fixture.layout.ledgers })
    const outcome = (taskId: string, extra: Record<string, unknown>, calls = 1) => ledger.append({
      type: 'task.outcome', sessionId: 's-1', taskId, status: 'completed', totalUsage: ZERO_USAGE, requestCount: 1, toolCallCount: 1, turns: 1, toolsUsed: ['cap_region_summary_summarize'],
      componentsUsed: [{ kind: 'function-module', name: 'region-summary', version: VERSION, calls, errors: 0 }], capabilityVersion: VERSION, ...extra,
    } as never)
    await outcome('trial-task', { trialId: '22222222-2222-4222-8222-222222222222', arm: 'candidate' })
    await outcome('unused-task', {}, 0)
    await outcome('used-task', { memberId: 'main' })
    await outcome('second-task', {})
    const [changed] = await sweepAdoptedJobs(fixture.layout)
    expect(changed?.firstUse).toMatchObject({ taskId: 'used-task', sessionId: 's-1', version: VERSION })
    expect(changed?.rolledBack).toBeUndefined()

    await new CapabilityStore(fixture.layout.capabilities).recordDecision({ outcome: 'rolled-back', reason: 'usage-regression', trigger: 'usage-regression', fromVersion: VERSION, toVersion: 'baseline', detail: 'checks failed after adoption' })
    const [rolled] = await sweepAdoptedJobs(fixture.layout)
    expect(rolled).toMatchObject({ firstUse: { taskId: 'used-task' }, rolledBack: { at: expect.any(String) } })
    expect(await sweepAdoptedJobs(fixture.layout)).toEqual([])
  })

  it('shows the first use as soon as the task outcome is in the ledger, without another turn starting', async () => {
    const fixture = await feedbackTask()
    const job = await queuedJob(fixture)
    const runner = scriptedRunner({ diagnose: reportOnce(fixture), propose: proposeInCopy(fixture) })
    await runImprovementJob(fixture.layout, job.id, { stages: createImprovementStages({ runner, startTrial: gate('adopted') }) })
    const host = new ImprovementHost(fixture.layout, {})
    await host.start()
    expect((await host.show(job.id)).firstUse).toBeUndefined()
    // The next task ends: its outcome lands in the ledger; no turn starts and the host does not restart.
    await new JsonlLedger({ ledgersDir: fixture.layout.ledgers }).append({
      type: 'task.outcome', sessionId: 's-next', taskId: 'next-task', status: 'completed', totalUsage: ZERO_USAGE, requestCount: 1, toolCallCount: 1, turns: 1, toolsUsed: ['cap_region_summary_summarize'],
      componentsUsed: [{ kind: 'function-module', name: 'region-summary', version: VERSION, calls: 1, errors: 0 }], capabilityVersion: VERSION, memberId: 'main',
    } as never)
    expect((await host.list()).find(item => item.id === job.id)?.firstUse).toMatchObject({ taskId: 'next-task', sessionId: 's-next', version: VERSION })
    expect((await host.show(job.id)).firstUse).toMatchObject({ taskId: 'next-task' })
  })
})

describe('the host', () => {
  it('refuses an explicit run once the improvement budget is spent', async () => {
    const fixture = await feedbackTask(true, { budget: { maxTokens: 100, windowDays: 30 } })
    const directory = improvementsDir(fixture.layout)
    const old = await createJob(directory, { trigger: 'explicit', items: [] })
    const { updateJob } = await import('../src/index.js')
    await updateJob(directory, old.id, { phases: { diagnose: { usage: { ...ZERO_USAGE, inputTokens: 150 }, requestCount: 1 } } })
    await transitionJob(directory, old.id, 'diagnosing')
    await transitionJob(directory, old.id, 'failed')
    const host = new ImprovementHost(fixture.layout, { launch: (_layout, jobId) => ({ jobId, pid: process.pid, exited: Promise.resolve(0) }) })
    await host.start()
    await expect(host.run()).rejects.toMatchObject({ code: 'improvement/budget-exhausted' })
  })

  it('cancels a parked job and frees nothing it does not hold', async () => {
    const fixture = await feedbackTask()
    const job = await queuedJob(fixture)
    const runner = scriptedRunner({ diagnose: reportOnce(fixture), propose: proposeInCopy(fixture) })
    await runImprovementJob(fixture.layout, job.id, { stages: createImprovementStages({ runner, startTrial: gate('waiting') }) })
    const host = new ImprovementHost(fixture.layout, {})
    await host.start()
    const cancelled = await host.cancel(job.id)
    expect(cancelled.status).toBe('cancelled')
    await expect(host.cancel(job.id)).rejects.toThrow()
    await expect(host.show('00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({ code: 'improvement/not-found' })
  })
})
