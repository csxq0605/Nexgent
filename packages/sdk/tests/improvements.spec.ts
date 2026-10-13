/**
 * Step 5 through the SDK (W4): the SDK installs `@nexgent/evolve`, so
 * counted feedback starts improvement jobs; `improvements.list / show / run
 * / cancel` and `improvement.job` events; improvement sessions stay out of
 * the conversation list and are read-only; the improve entry runs a job's
 * diagnose session through the SDK against the scripted model server (no
 * real model).
 */
import { randomUUID } from 'node:crypto'
import { access, readFile, writeFile } from 'node:fs/promises'
import * as nodePath from 'node:path'
import { listCandidates } from '@nexgent/capabilities'
import { createJob, improvementsDir, readJob, transitionJob, updateJob } from '@nexgent/evolve'
import { IMPROVEMENT_DIAGNOSIS_TOOLS, resolveWorkspaceLayout, type SessionRecord } from '@nexgent/kernel'
import { JsonlLedger } from '@nexgent/session'
import { readLedgerRecords, readSessionRecords, scriptedModelServer } from '@nexgent/test-support'
import { describe, expect, it } from 'vitest'
import { runImprovementProcess, step5ProfileRows, type SdkEvent } from '../src/index.js'
import { propose, skill } from './capability-fixtures.js'
import { TEST_KEY, testSdk, waitForEvent, type TestSdk } from './helpers.js'

const usage = { inputTokens: 1000, outputTokens: 200, totalTokens: 1200, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }

async function openProject(t: TestSdk): Promise<{ root: string; projectId: string }> {
  const project = await t.sdk.call('projects.open', { root: nodePath.join(t.base, 'p'), create: true })
  return { root: project.root, projectId: project.projectId }
}

const jobEvents = (t: TestSdk) => t.events.filter((event): event is Extract<SdkEvent, { type: 'improvement.job' }> => event.type === 'improvement.job')

async function until(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

describe('improvement jobs through the SDK', () => {
  it('installs @nexgent/evolve with the SDK improve entry; a fresh project lists no jobs', async () => {
    const rows = step5ProfileRows({ NEXGENT_API_BASE_URL: 'http://127.0.0.1:1', NEXGENT_API_KEY: 'secret' }, '/home/x')
    expect(rows).toEqual([{ id: 'evolve', name: '@nexgent/evolve', config: { entry: expect.stringMatching(/improve-entry\.(js|ts)$/), env: { NEXGENT_API_BASE_URL: 'http://127.0.0.1:1', NEXGENT_HOME: '/home/x' } } }])
    const t = await testSdk([])
    const { projectId } = await openProject(t)
    expect(await t.sdk.call('improvements.list', { projectId })).toEqual({ jobs: [], pending: 0, threshold: 3, budget: { usedTokens: 0, maxTokens: 3_000_000, windowDays: 30 }, autoImprove: true, meta: { enabled: false, pending: 0, everyJobs: 3, budget: { usedTokens: 0, maxTokens: 6_000_000, windowDays: 30 } } })
    await expect(t.sdk.call('improvements.show', { projectId, jobId: randomUUID() })).rejects.toMatchObject({ code: 'improvement/not-found' })
  })

  it('three counted feedback entries start a job (an event, the listing); a fourth waits for the next batch', async () => {
    const t = await testSdk([
      { toolCalls: [{ name: 'write_file', arguments: { path: 'regions.md', content: '| region | revenue |\n' } }], usage },
      { toolCalls: [{ name: 'present', arguments: { paths: ['regions.md'], summary: 'region table' } }], usage },
      { content: 'done', usage },
      { content: 'noted 1', usage },
      { content: 'noted 2', usage },
      { content: 'noted 3', usage },
      { content: 'noted 4', usage },
    ])
    const { projectId } = await openProject(t)
    const { sessionId } = await t.sdk.call('sessions.create', { projectId })
    await (await t.sdk.startTurn({ projectId, sessionId, text: 'make the region table' })).done
    const [deliverable] = await t.sdk.call('deliverables.list', { projectId })
    const comments = ['missing the average order value', 'every month I need avg_order_value', 'still no average column', 'and sort by revenue']
    for (const [index, comment] of comments.slice(0, 3).entries()) {
      await t.sdk.call('feedback.submit', { projectId, sessionId, deliverableId: deliverable!.deliverableId, version: 1, rating: 2, comment })
      await waitForEvent(t, event => event.type === 'turn.end' && event.sessionId === sessionId && event.turn === index + 2)
      if (index < 2) await until(async () => (await t.sdk.call('improvements.list', { projectId })).pending === index + 1)
    }
    await until(() => t.launched.length === 1)
    const listing = await t.sdk.call('improvements.list', { projectId })
    expect(listing).toMatchObject({ pending: 0, threshold: 3, activeJobId: t.launched[0]!.jobId })
    expect(listing.jobs).toEqual([expect.objectContaining({ id: t.launched[0]!.jobId, trigger: 'feedback-count', status: 'queued', itemCount: 3, tokens: {}, estimatedUsd: 0 })])
    await until(() => jobEvents(t).length > 0)
    expect(jobEvents(t)[0]).toMatchObject({ projectId, job: { id: t.launched[0]!.jobId, status: 'queued' } })
    expect(jobEvents(t)[0]).not.toHaveProperty('sessionId')

    // A fourth counted entry goes to the next batch; no second job while one runs.
    await t.sdk.call('feedback.submit', { projectId, sessionId, deliverableId: deliverable!.deliverableId, version: 1, comment: comments[3]! })
    await waitForEvent(t, event => event.type === 'turn.end' && event.sessionId === sessionId && event.turn === 5)
    await until(async () => (await t.sdk.call('improvements.list', { projectId })).pending === 1)
    expect(t.launched).toHaveLength(1)
  })

  it('run starts an explicit job at once (busy while it runs); cancel ends it; each change is an event', async () => {
    const t = await testSdk([])
    const { projectId } = await openProject(t)
    await expect(t.sdk.call('improvements.run', { projectId, sessionId: 7 as never })).rejects.toMatchObject({ code: 'tool/invalid-input' })
    const started = await t.sdk.call('improvements.run', { projectId, deliverableId: 'd-1' })
    expect(started).toMatchObject({ trigger: 'explicit', status: 'queued', itemCount: 0 })
    expect(t.launched.map(item => item.jobId)).toEqual([started.id])
    await expect(t.sdk.call('improvements.run', { projectId })).rejects.toMatchObject({ code: 'improvement/busy' })
    const detail = await t.sdk.call('improvements.show', { projectId, jobId: started.id })
    expect(detail.job.request).toEqual({ deliverableId: 'd-1' })
    expect(detail).not.toHaveProperty('diagnosis')

    const cancelled = await t.sdk.call('improvements.cancel', { projectId, jobId: started.id })
    expect(cancelled.status).toBe('cancelled')
    await expect(t.sdk.call('improvements.cancel', { projectId, jobId: started.id })).rejects.toMatchObject({ code: 'tool/invalid-input' })
    expect(jobEvents(t).map(event => event.job.status)).toEqual(['queued', 'cancelled'])
    expect((await t.sdk.call('improvements.list', { projectId })).activeJobId).toBeUndefined()
  })

  it('reports a job another process changes; refuses run when the budget window is spent', async () => {
    const t = await testSdk([])
    const { root, projectId } = await openProject(t)
    const dir = improvementsDir(resolveWorkspaceLayout(root))
    const job = await createJob(dir, { trigger: 'explicit', items: [], request: {} })
    await until(() => jobEvents(t).some(event => event.job.id === job.id))
    await transitionJob(dir, job.id, 'diagnosing', { expect: ['queued'] })
    await until(() => jobEvents(t).some(event => event.job.id === job.id && event.job.status === 'diagnosing'))
    await updateJob(dir, job.id, { phases: { diagnose: { usage: { ...usage, inputTokens: 3_000_000 }, requestCount: 1 } } })
    await transitionJob(dir, job.id, 'failed', { expect: ['diagnosing'], detail: 'test' })
    await until(() => jobEvents(t).some(event => event.job.id === job.id && event.job.status === 'failed'))
    const listing = await t.sdk.call('improvements.list', { projectId })
    expect(listing.budget.usedTokens).toBe(3_000_200)
    expect(listing.jobs[0]).toMatchObject({ status: 'failed', detail: 'test', tokens: { diagnose: 3_000_200 }, estimatedUsd: 'unknown' })
    await expect(t.sdk.call('improvements.run', { projectId })).rejects.toMatchObject({ code: 'improvement/budget-exhausted' })
    expect(t.launched).toHaveLength(0)
  })

  it('show: the diagnosis, the candidate and an estimate from the job\'s ledger requests', async () => {
    const t = await testSdk([])
    const { root, projectId } = await openProject(t)
    const layout = resolveWorkspaceLayout(root)
    const dir = improvementsDir(layout)
    const candidate = await propose(root, [skill('region-table')])
    const job = await createJob(dir, { trigger: 'explicit', items: [], request: {} })
    const diagnosis = { formatVersion: 1, jobId: job.id, createdAt: new Date().toISOString(), attempts: 1, failureTypes: [], involved: { members: [], tools: [], skills: [], components: [] }, memberCosts: [], hypothesis: 'h', proposalKind: 'skill' }
    await writeFile(nodePath.join(dir, job.id, 'diagnosis.json'), JSON.stringify(diagnosis))
    await updateJob(dir, job.id, { candidateId: candidate.id, diagnosed: { at: diagnosis.createdAt, proposalKind: 'skill', attempts: 1 }, phases: { diagnose: { usage, requestCount: 1 } } })
    await new JsonlLedger({ ledgersDir: layout.ledgers }).append({
      type: 'llm.request.end', requestId: randomUUID(), provider: 'anthropic', endpoint: 'https://api.anthropic.com', model: 'claude-sonnet-5-5', status: 'ok', usage, latencyMs: 1, finishReason: 'stop', improvementId: job.id, improvementPhase: 'diagnose',
    } as never)
    const detail = await t.sdk.call('improvements.show', { projectId, jobId: job.id })
    expect(detail.diagnosis).toEqual(diagnosis)
    expect(detail.candidate?.record.id).toBe(candidate.id)
    expect(detail.view).toMatchObject({ proposalKind: 'skill', candidateId: candidate.id, tokens: { diagnose: 1200 } })
    expect(detail.view.estimatedUsd).toBeGreaterThan(0)
  })
})

describe('the improve entry over the SDK (scripted model server)', () => {
  it('runs a job\'s diagnose session: purpose improvement, only the four tools, ledger stamps, hidden from the list; no-proposal', async () => {
    const t = await testSdk([{ content: 'Here is the summary.', usage }])
    const { root, projectId } = await openProject(t)
    const { sessionId } = await t.sdk.call('sessions.create', { projectId })
    await (await t.sdk.startTurn({ projectId, sessionId, text: 'summarize the orders' })).done
    const user = (await readSessionRecords(root, sessionId)).records.find(record => record.type === 'user.message')!
    const report = {
      failureTypes: [{ category: 'system-design', label: 'requirement changed after delivery', evidence: [{ sessionId, seq: user.seq }] }],
      involved: { members: ['root'], tools: [], skills: [], components: [] },
      hypothesis: 'The user changed what they want; no capability was missing.',
      proposalKind: 'none',
    }
    const server = await scriptedModelServer({
      script: [
        { toolCalls: [{ name: 'improve_report_diagnosis', arguments: report }], usage },
        { content: 'Diagnosis reported.', usage },
      ],
    })
    try {
      const job = await t.sdk.call('improvements.run', { projectId, sessionId })
      const env = { NEXGENT_API_KEY: TEST_KEY, NEXGENT_HOME: t.home, NEXGENT_API_BASE_URL: server.baseUrl }
      const result = await runImprovementProcess(root, job.id, env)
      expect(result.jobs.map(item => item.status)).toEqual(['no-proposal'])
      server.assertConsumed()
      // The diagnose request offered exactly the four read-only tools.
      expect(((server.requests[0]!.body as { tools: { name: string }[] }).tools).map(tool => tool.name).sort()).toEqual(IMPROVEMENT_DIAGNOSIS_TOOLS.map(tool => tool.name).sort())

      const detail = await t.sdk.call('improvements.show', { projectId, jobId: job.id })
      expect(detail.diagnosis).toMatchObject({ proposalKind: 'none', hypothesis: report.hypothesis })
      expect(detail.view).toMatchObject({ status: 'no-proposal', tokens: { diagnose: 2400 } })
      expect(detail.view.estimatedUsd).toBeGreaterThan(0)
      const diagnose = (await readJob(improvementsDir(resolveWorkspaceLayout(root)), job.id)).sessions!.diagnose!
      const records = (await readSessionRecords(root, diagnose)).records as SessionRecord[]
      expect(records[0]).toMatchObject({ type: 'session.start', purpose: 'improvement', improvement: { jobId: job.id, phase: 'diagnose' } })
      const requests = (await readLedgerRecords(root)).records.filter(record => record.type === 'llm.request.end' && record.sessionId === diagnose)
      expect(requests).toHaveLength(2)
      for (const record of requests) expect(record).toMatchObject({ improvementId: job.id, improvementPhase: 'diagnose' })

      // Not a conversation: out of the list, readable, not resumable.
      expect((await t.sdk.call('sessions.list', { projectId })).map(item => item.sessionId)).toEqual([sessionId])
      expect((await t.sdk.call('sessions.view', { projectId, sessionId: diagnose })).items.length).toBeGreaterThan(0)
      await expect(t.sdk.call('sessions.open', { projectId, sessionId: diagnose })).rejects.toMatchObject({ code: 'tool/denied' })
      await until(() => jobEvents(t).some(event => event.job.status === 'no-proposal'))
      expect(JSON.parse(await readFile(nodePath.join(improvementsDir(resolveWorkspaceLayout(root)), job.id, 'diagnosis.json'), 'utf8'))).toMatchObject({ proposalKind: 'none' })
    } finally {
      await server.close()
    }
  })

  it('runs the propose session in the snapshot copy (session and ledger in the real project); the candidate comes back marked; the gate waits for history', async () => {
    const check = "import { test } from 'node:test'\nimport { readFileSync } from 'node:fs'\ntest('table', () => { readFileSync('regions.md', 'utf8') })\n"
    const t = await testSdk([
      { toolCalls: [{ name: 'write_file', arguments: { path: 'check.test.mjs', content: check } }], usage },
      { toolCalls: [{ name: 'write_file', arguments: { path: 'regions.md', content: '| region | revenue |\n' } }], usage },
      { toolCalls: [{ name: 'bash', arguments: { command: 'node --test check.test.mjs' } }], usage },
      { toolCalls: [{ name: 'present', arguments: { paths: ['regions.md'], summary: 'region table' } }], usage },
      { content: 'done', usage },
    ], { approvalResponder: async request => ({ id: request.id, decision: 'allow', scope: 'once', decidedBy: 'user' }) })
    const { root, projectId } = await openProject(t)
    const { sessionId } = await t.sdk.call('sessions.create', { projectId })
    await (await t.sdk.startTurn({ projectId, sessionId, text: 'write the region table to regions.md and check it' })).done
    const user = (await readSessionRecords(root, sessionId)).records.find(record => record.type === 'user.message')!
    const skillFile = '---\nname: region-table-convention\ndescription: Region tables carry the average order value.\n---\n\nAdd avg_order_value.\n'
    const ref = { kind: 'skill', name: 'region-table-convention' }
    const server = await scriptedModelServer({
      script: [
        { toolCalls: [{ name: 'improve_report_diagnosis', arguments: {
          failureTypes: [{ category: 'task-verification', label: 'output not checked against the convention', evidence: [{ sessionId, seq: user.seq }] }],
          involved: { members: ['root'], tools: ['write_file'], skills: [], components: [] },
          hypothesis: 'Nothing records the region-table convention.',
          proposalKind: 'skill',
        } }], usage },
        { content: 'Diagnosis reported.', usage },
        { toolCalls: [{ name: 'capability_draft', arguments: { ...ref, files: [{ path: 'SKILL.md', content: skillFile }] } }], usage },
        { toolCalls: [{ name: 'capability_try', arguments: ref }], usage },
        { toolCalls: [{ name: 'load_skill', arguments: { name: ref.name } }], usage },
        { toolCalls: [{ name: 'write_file', arguments: { path: 'regions.md', content: '| region | revenue | avg_order_value |\n' } }], usage },
        { toolCalls: [{ name: 'capability_propose', arguments: { components: [ref], summary: 'Region tables carry avg_order_value.' } }], usage },
        { content: 'Proposed the skill.', usage },
      ],
    })
    try {
      const job = await t.sdk.call('improvements.run', { projectId, sessionId })
      const env = { NEXGENT_API_KEY: TEST_KEY, NEXGENT_HOME: t.home, NEXGENT_API_BASE_URL: server.baseUrl }
      const [ran] = (await runImprovementProcess(root, job.id, env)).jobs
      server.assertConsumed()
      if (ran!.status !== 'waiting-history') {
        const diag = (await readSessionRecords(root, ran!.sessions!.diagnose!)).records.filter(record => record.type === 'tool.result').map(record => (record as { content: string }).content.slice(0, 600))
        throw new Error(`${ran!.detail}\n${diag.join('\n---\n')}`)
      }
      expect(ran!.candidateId).toEqual(expect.any(String))
      // The copy took the write; the real project is unchanged.
      expect(await readFile(nodePath.join(root, 'regions.md'), 'utf8')).toBe('| region | revenue |\n')
      const [candidate] = await listCandidates(resolveWorkspaceLayout(root).capabilities)
      expect(candidate).toMatchObject({ id: ran!.candidateId, origin: 'improvement', jobId: job.id, components: [expect.objectContaining(ref)] })
      // The propose session and its requests live in the real project, hidden from the list.
      const propose = ran!.sessions!.propose!
      const records = (await readSessionRecords(root, propose)).records as SessionRecord[]
      expect(records[0]).toMatchObject({ type: 'session.start', purpose: 'improvement', improvement: { jobId: job.id, phase: 'propose' } })
      const requests = (await readLedgerRecords(root)).records.filter(record => record.type === 'llm.request.end' && record.sessionId === propose)
      expect(requests).toHaveLength(6)
      for (const record of requests) expect(record).toMatchObject({ improvementId: job.id, improvementPhase: 'propose' })
      expect((await t.sdk.call('sessions.list', { projectId })).map(item => item.sessionId)).toEqual([sessionId])
      const detail = await t.sdk.call('improvements.show', { projectId, jobId: job.id })
      expect(detail.candidate?.record.id).toBe(ran!.candidateId)
      expect(detail.view.tokens).toEqual({ diagnose: 2400, propose: 7200, trial: 0 })
      await expect(access(nodePath.join(root, '.nexgent', 'improvements', 'queue.json'))).resolves.toBeUndefined()
    } finally {
      await server.close()
    }
  })
})
