/**
 * Step 6 through the SDK (W5; API 7): `improvers.list / show / rollback`
 * over the user's improver version line, `userSettings.*`, application-level
 * `improver.version` events, the meta
 * listing fields, `improvements.runMeta`, and a meta job's detail (meta
 * diagnosis, change, comparison) with both arms in its dollar estimate.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import * as nodePath from 'node:path'
import { ImproverStore, improversDir, userImproversDir } from '@nexgent/capabilities'
import { createJob, improvementsDir, jobPaths, readJob, transitionJob, updateJob } from '@nexgent/evolve'
import {
  applyImproverChange,
  IMPROVER_V0,
  resolveWorkspaceLayout,
  type ComparisonArmResult,
  type ImproverChange,
  type ImproverChangeRecord,
  type ImproverComparison,
  type MetaDiagnosis,
  type SessionRecord,
} from '@nexgent/kernel'
import { readLedgerRecords, readSessionRecords, scriptedModelServer } from '@nexgent/test-support'
import { describe, expect, it } from 'vitest'
import { runImprovementProcess, type SdkEvent } from '../src/index.js'
import { TEST_KEY, testSdk, type TestSdk } from './helpers.js'

const CHANGE: ImproverChange = { op: 'set-comparison-param', param: 'repeats', value: 3 }
const CHILD = applyImproverChange(IMPROVER_V0, CHANGE)

async function openProject(t: TestSdk): Promise<{ root: string; projectId: string }> {
  const project = await t.sdk.call('projects.open', { root: nodePath.join(t.base, 'p'), create: true })
  return { root: project.root, projectId: project.projectId }
}

async function until(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

const versionEvents = (t: TestSdk) => t.events.filter((event): event is Extract<SdkEvent, { type: 'improver.version' }> => event.type === 'improver.version')

describe('improver versions through the SDK (API 7: the user line)', () => {
  it('a fresh home runs v0; an adopted child is listed with the projects that used it and shown with its change; rollback is a manual, application-level event', async () => {
    const t = await testSdk([])
    const { root, projectId } = await openProject(t)
    expect(await t.sdk.call('improvers.list', {})).toEqual({ current: { version: 'v0', revision: 0 }, history: [], usedBy: [] })
    const v0 = await t.sdk.call('improvers.show', { version: 'v0' })
    expect(v0).toEqual({ version: 'v0', bundle: IMPROVER_V0, current: true })
    await expect(t.sdk.call('improvers.show', { version: 'f'.repeat(64) })).rejects.toMatchObject({ code: 'improver/not-found' })

    // A meta job hosted in this project proposed the child (change.json) and adopted it on the user line.
    const layout = resolveWorkspaceLayout(root)
    const store = ImproverStore.user({ home: t.home })
    const { version } = await store.write(CHILD)
    const jobs = improvementsDir(layout)
    const metaId = randomUUID()
    await createJob(jobs, { id: metaId, trigger: 'explicit', items: [], kind: 'meta', meta: { parentVersion: 'v0', basis: [] } } as Parameters<typeof createJob>[1])
    await updateJob(jobs, metaId, { meta: { parentVersion: 'v0', basis: [], childVersion: version } } as Parameters<typeof updateJob>[2])
    const change: ImproverChangeRecord = { formatVersion: 1, jobId: metaId, createdAt: '2026-10-13T10:00:00.000Z', sessionId: randomUUID(), attempts: 1, parentVersion: 'v0', childVersion: version, change: CHANGE, rationale: 'more runs per case' }
    await writeFile(jobPaths(jobs, metaId).change, JSON.stringify(change))
    expect(await store.adopt(version, { jobId: metaId })).not.toBeNull()
    // A capability job of this project ran on the child (user scope); one of another, recent project too; an old project-scope job does not count.
    const used = randomUUID()
    await createJob(jobs, { id: used, trigger: 'explicit', items: [] } as Parameters<typeof createJob>[1])
    await updateJob(jobs, used, { improverVersion: version, improverScope: 'user' } as Parameters<typeof updateJob>[2])
    const other = await t.sdk.call('projects.open', { root: nodePath.join(t.base, 'other'), create: true })
    const otherJobs = improvementsDir(resolveWorkspaceLayout(other.root))
    const old = randomUUID()
    await createJob(otherJobs, { id: old, trigger: 'explicit', items: [] } as Parameters<typeof createJob>[1])
    await updateJob(otherJobs, old, { improverVersion: version } as Parameters<typeof updateJob>[2])

    const listing = await t.sdk.call('improvers.list', {})
    expect(listing.current).toMatchObject({ version, revision: 1, trigger: 'meta-job', jobId: metaId, since: expect.any(String) })
    expect(listing.history.map(revision => [revision.type, revision.from, revision.version])).toEqual([['adopt', 'v0', version]])
    expect(listing.usedBy).toEqual([{ root, name: 'p', lastJobAt: expect.any(String) }])
    // A projectId is ignored: every project sees the same line.
    expect(await t.sdk.call('improvers.list', { projectId: other.projectId })).toEqual(listing)
    expect(await t.sdk.call('improvers.show', { version })).toEqual({ version, bundle: CHILD, change, current: true })
    expect((await t.sdk.call('improvers.show', { version: 'v0' })).current).toBe(false)

    await expect(t.sdk.call('improvers.rollback', { reason: 42 } as never)).rejects.toMatchObject({ code: 'tool/invalid-input' })
    const back = await t.sdk.call('improvers.rollback', { reason: 'the old one was better' })
    expect(back).toMatchObject({ version: 'v0', revision: 2, trigger: 'manual' })
    expect(versionEvents(t)).toEqual([expect.objectContaining({ type: 'improver.version', current: back, eventSeq: 1 })])
    expect(versionEvents(t)[0]).not.toHaveProperty('sessionId')
    expect(versionEvents(t)[0]).not.toHaveProperty('projectId')
    const after = await t.sdk.call('improvers.list', {})
    expect(after.history.map(revision => [revision.type, revision.trigger, revision.reason])).toEqual([['adopt', 'meta-job', undefined], ['rollback', 'manual', 'the old one was better']])
    // Files stay: the rolled-back child can still be shown, and rolled forward to.
    expect((await t.sdk.call('improvers.show', { version })).current).toBe(false)
    expect(await t.sdk.call('improvers.rollback', { projectId, toVersion: version })).toMatchObject({ version, revision: 3 })
    expect((await ImproverStore.user({ home: t.home }).activation()).version).toBe(version)
  })

  it('an improver that fails to load is rolled back on read; the view names the problem and an event follows', async () => {
    const t = await testSdk([])
    await openProject(t)
    const store = ImproverStore.user({ home: t.home })
    const { version } = await store.write(CHILD)
    await store.adopt(version, { jobId: randomUUID() })
    await writeFile(nodePath.join(userImproversDir(t.home), 'bundles', `${version}.json`), '{"formatVersion":1}')
    const listing = await t.sdk.call('improvers.list', {})
    expect(listing.current).toMatchObject({ version: 'v0', revision: 2, trigger: 'load-failure' })
    expect(listing.current.problem).toContain(version.slice(0, 12))
    expect(versionEvents(t)).toHaveLength(1)
  })

  it('a project\'s own step-6 line is history only: it is not the improver in force', async () => {
    const t = await testSdk([])
    const { root } = await openProject(t)
    const project = new ImproverStore(improversDir(resolveWorkspaceLayout(root)), { scope: 'user' }) // written as step 6 did
    const { version } = await project.write(CHILD)
    await project.adopt(version, { jobId: randomUUID() })
    expect((await t.sdk.call('improvers.list', {})).current).toEqual({ version: 'v0', revision: 0 })
  })
})

describe('learning settings through the SDK (API 8)', () => {
  it('project learning settings read, patch and fall back to autoImprove; the notice is acknowledged once', async () => {
    const t = await testSdk([])
    const { projectId } = await openProject(t)
    const settings = await t.sdk.call('settings.get', { projectId })
    expect(settings.learning).toEqual({ enabled: true, budget: { maxUsd: 3, windowDays: 30 }, selfEvalMaxUsd: 0.05, useShared: true, contribute: true })
    expect((await t.sdk.call('settings.update', { projectId, patch: { autoImprove: false } })).learning.enabled).toBe(false)
    expect((await t.sdk.call('settings.update', { projectId, patch: { autoImprove: false } })).learning.enabled).toBe(false)
    const patched = await t.sdk.call('settings.update', { projectId, patch: { learning: { enabled: true, budget: { maxUsd: 1 } }, costCaps: { perConversation: { maxUsd: 5 } } } })
    expect(patched.learning).toMatchObject({ enabled: true, budget: { maxUsd: 1, windowDays: 30 } })
    expect(patched.autoImprove).toBe(true)
    expect(patched.costCaps).toEqual({ perConversation: { maxUsd: 5 } })
    await expect(t.sdk.call('settings.update', { projectId, patch: { learning: { budget: { maxUsd: -1 } } } })).rejects.toMatchObject({ code: 'config/invalid' })
    expect((await t.sdk.call('userSettings.get', {})).learning).toEqual({})
    const first = await t.sdk.call('learning.acknowledge', {})
    expect(first.learning.noticeAcknowledgedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect((await t.sdk.call('learning.acknowledge', {})).learning).toEqual(first.learning)
    for (const method of ['handbook.list', 'learning.status'] as const) await expect(t.sdk.call(method, { projectId } as never)).rejects.toMatchObject({ code: 'internal' })
  })
})

describe('user settings through the SDK (API 7)', () => {
  it('reads defaults, writes <home>/config.json, keeps the meta switch off unless asked, and rejects invalid values', async () => {
    const t = await testSdk([])
    const { projectId } = await openProject(t)
    const defaults = await t.sdk.call('userSettings.get', {})
    expect(defaults.improvement.meta).toMatchObject({ enabled: false, everyJobs: 3, budget: { maxTokens: 6_000_000, windowDays: 30 } })
    const meta = { enabled: true, everyJobs: 4, budget: { maxTokens: 2_000_000, windowDays: 14 } }
    const saved = await t.sdk.call('userSettings.update', { patch: { improvement: { meta } } })
    expect(saved.improvement.meta).toMatchObject(meta)
    expect(JSON.parse(await readFile(nodePath.join(t.home, 'config.json'), 'utf8'))).toEqual({ version: 1, improvement: { meta } })
    expect(await t.sdk.call('userSettings.get', {})).toEqual(saved)
    // Every project's listing shows the user's meta settings.
    expect((await t.sdk.call('improvements.list', { projectId })).meta).toEqual({ enabled: true, pending: 0, everyJobs: 4, budget: { usedTokens: 0, maxTokens: 2_000_000, windowDays: 14 } })
    await expect(t.sdk.call('userSettings.update', { patch: { improvement: { meta: { everyJobs: 0 } } } })).rejects.toMatchObject({ code: 'config/invalid' })
    await expect(t.sdk.call('userSettings.update', { patch: { model: 'x' } as never })).rejects.toMatchObject({ code: 'config/invalid' })
    expect(await t.sdk.call('userSettings.get', {})).toEqual(saved)
    // The project keeps only its sharing switch (default on).
    expect((await t.sdk.call('settings.get', { projectId })).improvement.shareImproverEvidence).toBe(true)
    const off = await t.sdk.call('settings.update', { projectId, patch: { improvement: { shareImproverEvidence: false } } })
    expect(off.improvement.shareImproverEvidence).toBe(false)
  })
})

describe('meta jobs through the SDK', () => {
  it('runMeta starts an explicit meta job (event, listing meta fields); a second waits busy', async () => {
    const t = await testSdk([])
    const { projectId } = await openProject(t)
    await expect(t.sdk.call('improvements.runMeta', { projectId, keepCopies: 'yes' } as never)).rejects.toMatchObject({ code: 'tool/invalid-input' })
    const job = await t.sdk.call('improvements.runMeta', { projectId })
    expect(job).toMatchObject({ kind: 'meta', trigger: 'explicit', status: 'queued', estimatedUsd: 0 })
    expect(t.launched).toEqual([expect.objectContaining({ jobId: job.id })])
    await until(() => t.events.some(event => event.type === 'improvement.job'))
    expect(t.events.find(event => event.type === 'improvement.job')).toMatchObject({ job: { id: job.id, kind: 'meta' } })
    const listing = await t.sdk.call('improvements.list', { projectId })
    // ADR 0012: a meta job holds the user's meta slot, never the project's job slot.
    expect(listing.activeJobId).toBeUndefined()
    expect(listing.meta).toEqual({ enabled: false, pending: 0, everyJobs: 3, budget: { usedTokens: 0, maxTokens: 6_000_000, windowDays: 30 } })
    await expect(t.sdk.call('improvements.runMeta', { projectId })).rejects.toMatchObject({ code: 'improvement/busy' })
  })

  it('a meta job shows its meta diagnosis, change and comparison; its estimate adds both arms', async () => {
    const t = await testSdk([])
    const { root, projectId } = await openProject(t)
    const layout = resolveWorkspaceLayout(root)
    const jobs = improvementsDir(layout)
    const id = randomUUID()
    const child = 'c'.repeat(64)
    const basis = [randomUUID(), randomUUID(), randomUUID()]
    await createJob(jobs, { id, trigger: 'job-count', items: [], kind: 'meta', meta: { parentVersion: 'v0', basis } } as Parameters<typeof createJob>[1])
    for (const status of ['meta-diagnosing', 'meta-proposing', 'comparing', 'rejected'] as const) await transitionJob(jobs, id, status)
    await updateJob(jobs, id, { meta: { parentVersion: 'v0', basis, childVersion: child, compared: { at: '2026-10-13T10:05:00.000Z', outcome: 'reject', reason: 'no-offspring' } } } as Parameters<typeof updateJob>[2])
    const paths = jobPaths(jobs, id)
    await mkdir(paths.directory, { recursive: true })
    const metaDiagnosis: MetaDiagnosis = { formatVersion: 1, jobId: id, createdAt: '2026-10-13T10:00:00.000Z', sessionId: randomUUID(), attempts: 1, improverVersion: 'v0', basis, statusCounts: { adopted: 1, failed: 2 }, findings: [{ stage: 'diagnose', label: 'diagnoses skip the failed checks', jobIds: basis.slice(0, 2) }], hypothesis: 'The diagnosis policy never asks for the failed checks.', proposal: 'change' }
    const change: ImproverChangeRecord = { formatVersion: 1, jobId: id, createdAt: '2026-10-13T10:01:00.000Z', sessionId: randomUUID(), attempts: 1, parentVersion: 'v0', childVersion: child, change: CHANGE, rationale: 'more runs' }
    const origin = { kind: 'unresolved' as const, sourceJobId: basis[2]!, tree: 'a'.repeat(64), feedbackIds: ['f1'], capabilityVersion: 'baseline', epoch: 'e'.repeat(64) }
    const zero = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
    const arm = (side: 'parent' | 'child', usd: number): ComparisonArmResult => ({ arm: side, improverVersion: side === 'parent' ? 'v0' : child, origin, jobId: randomUUID(), status: 'no-proposal', cost: { usage: zero, requestCount: 3, estimatedUsd: usd } })
    const comparison: ImproverComparison = { formatVersion: 1, jobId: id, createdAt: '2026-10-13T10:05:00.000Z', origin, parent: arm('parent', 0.4), child: arm('child', 0.35), verdict: { outcome: 'reject', reason: 'no-offspring' } }
    await writeFile(paths.metaDiagnosis, JSON.stringify(metaDiagnosis))
    await writeFile(paths.change, JSON.stringify(change))
    await writeFile(paths.comparison, JSON.stringify(comparison))

    const detail = await t.sdk.call('improvements.show', { projectId, jobId: id })
    expect(detail).toMatchObject({ metaDiagnosis, change, comparison })
    expect(detail.view).toMatchObject({ kind: 'meta', status: 'rejected', meta: { childVersion: child, outcome: 'reject', reason: 'no-offspring' } })
    expect(detail.view.estimatedUsd).toBeCloseTo(0.75, 10)
    const listed = (await t.sdk.call('improvements.list', { projectId })).jobs[0]!
    expect(listed.estimatedUsd).toBeCloseTo(0.75, 10)
    // An unknown arm makes the meta job's estimate unknown.
    await writeFile(paths.comparison, JSON.stringify({ ...comparison, child: { ...comparison.child, cost: { ...comparison.child.cost, estimatedUsd: 'unknown' } } }))
    expect((await t.sdk.call('improvements.show', { projectId, jobId: id })).view.estimatedUsd).toBe('unknown')
  })

  it('the improve entry runs a meta job\'s meta-diagnose session through the SDK (scripted model server); none ends no-proposal', async () => {
    const usage = { inputTokens: 1000, outputTokens: 200, totalTokens: 1200, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
    const t = await testSdk([])
    const { root, projectId } = await openProject(t)
    const server = await scriptedModelServer({
      script: [
        { toolCalls: [{ name: 'improve_report_meta_diagnosis', arguments: { findings: [], hypothesis: 'No improver problem is visible yet.', proposal: 'none' } }], usage },
        { content: 'Reported.', usage },
      ],
    })
    try {
      const job = await t.sdk.call('improvements.runMeta', { projectId })
      const result = await runImprovementProcess(root, job.id, { NEXGENT_API_KEY: TEST_KEY, NEXGENT_HOME: t.home, NEXGENT_API_BASE_URL: server.baseUrl })
      expect(result.jobs.map(item => item.status)).toEqual(['no-proposal'])
      server.assertConsumed()
      const detail = await t.sdk.call('improvements.show', { projectId, jobId: job.id })
      expect(detail.metaDiagnosis).toMatchObject({ proposal: 'none', improverVersion: 'v0' })
      expect(detail.view).toMatchObject({ kind: 'meta', status: 'no-proposal', improverVersion: 'v0', tokens: { 'meta-diagnose': 2400 } })
      expect(detail.view.estimatedUsd).toBeGreaterThan(0)
      const session = (await readJob(improvementsDir(resolveWorkspaceLayout(root)), job.id)).sessions!['meta-diagnose']!
      const records = (await readSessionRecords(root, session)).records as SessionRecord[]
      expect(records[0]).toMatchObject({ type: 'session.start', purpose: 'improvement', improvement: { jobId: job.id, phase: 'meta-diagnose', improverVersion: 'v0', improverScope: 'user' } })
      const requests = (await readLedgerRecords(root)).records.filter(record => record.type === 'llm.request.end' && record.sessionId === session)
      expect(requests).toHaveLength(2)
      for (const record of requests) expect(record).toMatchObject({ improvementId: job.id, improvementPhase: 'meta-diagnose', improverVersion: 'v0', improverScope: 'user' })
      // Not a conversation.
      expect(await t.sdk.call('sessions.list', { projectId })).toEqual([])
    } finally {
      await server.close()
    }
  })
})
