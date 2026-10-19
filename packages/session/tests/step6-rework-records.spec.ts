import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  countUserFinishedJob,
  emptyUserMetaQueue,
  type CapabilityDecision,
  type ComparisonOrigin,
  type ImprovementJob,
  type TrialVerdict,
  type UserMetaQueue,
} from '@nexgent/kernel'
import { capabilitiesSchema, validateCapabilityFile, validateImprovementFile, validateLedgerRecord, validateSessionRecord } from '../src/index.js'
import { KNOWN_USAGE } from './helpers.js'

/**
 * Step 6 rework (ADR 0012, ADR 0013): the user-level meta queue, the
 * improver scope on jobs, ledger lines and session starts, the batch's
 * projects on a meta job and its comparison origin, the similar-case pass
 * rates on a verdict and the instance-literal decision. Files written
 * before the rework (no `improverScope`) still read: they are project-level.
 */
const SHA = (c: string) => c.repeat(64)
const TS = '2026-10-14T00:00:00.000Z'
const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const P1 = SHA('1')
const P2 = SHA('2')
const phase = { usage: KNOWN_USAGE, requestCount: 2 }
const FIXTURES = new URL('./fixtures/step5-run2/', import.meta.url)

describe('user-level meta queue (<NEXGENT_HOME>/improvements/queue.json)', () => {
  const finished = (n: number): Pick<ImprovementJob, 'id' | 'status' | 'kind' | 'arm' | 'updatedAt'> => ({ id: UUID(n), status: 'rejected', updatedAt: TS })

  it('the queue the pure helpers write validates', () => {
    let queue: UserMetaQueue = emptyUserMetaQueue(TS)
    queue = countUserFinishedJob(queue, { projectId: P1, root: '/work/a', shares: true }, finished(1), TS).queue
    queue = countUserFinishedJob(queue, { projectId: P2, root: 'C:\\work\\b', shares: true }, { ...finished(2), status: 'adopted' }, TS).queue
    queue = { ...queue, active: { projectId: P2, root: 'C:\\work\\b', jobId: UUID(9), createdAt: TS }, metaJobs: [{ projectId: P2, root: 'C:\\work\\b', jobId: UUID(9), createdAt: TS }] }
    expect(queue.counted).toEqual([`${P1}:${UUID(1)}`, `${P2}:${UUID(2)}`])
    expect(validateImprovementFile('userQueue', JSON.parse(JSON.stringify(queue)))).toEqual([])
    expect(validateImprovementFile('userQueue', emptyUserMetaQueue(TS))).toEqual([])
  })

  it('refuses malformed queues', () => {
    const queue = emptyUserMetaQueue(TS)
    const entry = { projectId: P1, root: '/work/a', jobId: UUID(1), status: 'rejected', at: TS }
    for (const bad of [
      { ...queue, formatVersion: 2 },
      { ...queue, metaJobs: undefined },
      { ...queue, counted: [UUID(1)] },
      { ...queue, pending: [{ ...entry, projectId: 'p1' }] },
      { ...queue, pending: [{ ...entry, jobId: 'j1' }] },
      { ...queue, pending: [{ ...entry, status: 'done' }] },
      { ...queue, active: { projectId: P1, root: '/work/a', jobId: UUID(9) } },
      { ...queue, extra: true },
    ]) {
      expect(validateImprovementFile('userQueue', JSON.parse(JSON.stringify(bad))), JSON.stringify(bad).slice(0, 120)).not.toEqual([])
    }
  })
})

describe('improver scope and the batch of a meta job', () => {
  const meta: ImprovementJob = {
    formatVersion: 1,
    id: UUID(9),
    kind: 'meta',
    improverVersion: 'v0',
    improverScope: 'user',
    createdAt: TS,
    updatedAt: TS,
    trigger: 'job-count',
    items: [],
    status: 'meta-diagnosing',
    history: [{ status: 'queued', at: TS }, { status: 'meta-diagnosing', at: TS }],
    phases: { 'meta-diagnose': phase },
    meta: {
      basis: [UUID(1), UUID(2)],
      parentVersion: 'v0',
      batch: [
        { projectId: P1, root: '/work/a', jobId: UUID(1), status: 'rejected', at: TS },
        { projectId: P2, root: '/work/b', jobId: UUID(2), status: 'adopted', at: TS },
      ],
    },
  }

  it('job.json: improverScope and meta.batch validate; unknown scopes do not', () => {
    expect(validateImprovementFile('job', meta)).toEqual([])
    expect(validateImprovementFile('job', { ...meta, improverScope: 'project' })).toEqual([])
    expect(validateImprovementFile('job', { ...meta, improverScope: 'team' })).not.toEqual([])
    expect(validateImprovementFile('job', { ...meta, meta: { ...meta.meta, batch: [{ projectId: P1, jobId: UUID(1) }] } })).not.toEqual([])
  })

  it('comparison origin may name the source project', () => {
    const origin: ComparisonOrigin = { kind: 'unresolved', sourceJobId: UUID(1), projectId: P1, tree: SHA('a'), feedbackIds: ['f1'], capabilityVersion: 'baseline', epoch: SHA('e') }
    const verdict: TrialVerdict = { outcome: 'reject', reason: 'no-improvement', passRate: { candidate: 0.5, baseline: 0.5 }, costRatio: 1, costBasis: 'usd', decidedByReview: false }
    const arm = (n: number, armName: 'parent' | 'child') => ({ arm: armName, improverVersion: armName === 'parent' ? 'v0' : SHA('b'), origin, jobId: UUID(n), status: 'rejected', verdict, cost: { ...phase, estimatedUsd: 0.5 } })
    const comparison = { formatVersion: 1, jobId: UUID(9), createdAt: TS, origin, parent: arm(10, 'parent'), child: arm(11, 'child'), verdict: { outcome: 'reject', reason: 'no-improvement' } }
    expect(validateImprovementFile('comparison', comparison)).toEqual([])
    expect(validateImprovementFile('comparison', { ...comparison, origin: { ...origin, projectId: 'p1' } })).not.toEqual([])
  })

  it('ledger lines and session starts carry the scope', () => {
    const request = { type: 'llm.request.start', ts: TS, sessionId: 'meta-diag-1', requestId: 'r1', provider: 'anthropic', endpoint: 'https://api.anthropic.com', model: 'claude-sonnet-5-5', purpose: 'task', thinking: 'on', improvementId: UUID(9), improvementPhase: 'meta-diagnose', improverVersion: 'v0', improverScope: 'user' }
    expect(validateLedgerRecord(request, { forbidAdditionalProperties: true })).toEqual([])
    expect(validateLedgerRecord({ ...request, improverScope: 'team' })).not.toEqual([])
    const start = { type: 'session.start', seq: 1, ts: TS, sessionId: 'meta-diag-1', formatVersion: 1, projectRoot: '/work/b', model: 'claude-sonnet-5-5', sandboxMode: 'read-only', purpose: 'improvement', improvement: { jobId: UUID(9), phase: 'meta-diagnose', improverVersion: 'v0', improverScope: 'user' } }
    const issues = validateSessionRecord(start)
    // Only the scope matters here: whatever else the minimal start lacks fails the same way without it.
    const { improverScope: _scope, ...withoutScope } = start.improvement
    expect(issues).toEqual(validateSessionRecord({ ...start, improvement: withoutScope }))
    expect(validateSessionRecord({ ...start, improvement: { ...start.improvement, improverScope: 'team' } }).length).toBeGreaterThan(issues.length)
  })

  it('step-5 files without improverScope still read (project-level old data)', async () => {
    const json = async (name: string) => JSON.parse(await readFile(new URL(name, FIXTURES), 'utf8')) as Record<string, unknown>
    const jsonl = async (name: string) => (await readFile(new URL(name, FIXTURES), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    const job = await json('job-091f3c65.json')
    expect(job['improverScope']).toBeUndefined()
    expect(validateImprovementFile('job', job)).toEqual([])
    for (const line of await jsonl('ledger.jsonl')) expect(validateLedgerRecord(line)).toEqual([])
    for (const line of await jsonl('session-starts.jsonl')) expect(validateSessionRecord(line)).toEqual([])
  })
})

describe('similar cases and instance literals in gate records', () => {
  const verdict: TrialVerdict = { outcome: 'reject', reason: 'similar-regression', passRate: { candidate: 1, baseline: 0.5 }, costRatio: 1.1, costBasis: 'usd', decidedByReview: false, similarPassRate: { candidate: 0.5, baseline: 1 } }
  const decision: CapabilityDecision = {
    formatVersion: 1,
    id: UUID(20),
    outcome: 'rejected',
    reason: 'instance-literal',
    trigger: 'gate',
    decidedAt: TS,
    candidateId: UUID(21),
    fromVersion: 'baseline',
    toVersion: 'baseline',
    instanceLiterals: [{ value: '2384.13', kind: 'decimal', path: 'SKILL.md', source: 'feedback:f1' }, { value: '2026-10', kind: 'date', path: 'SKILL.md', source: 'deliverable:d1/v2/report.md' }],
    detail: 'The component carries values of the task it was learned from.',
  }

  const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value))

  it('the new reasons, similarPassRate and instanceLiterals validate', () => {
    expect(validateCapabilityFile('decision', decision)).toEqual([])
    expect(validateCapabilityFile('decision', plain({ ...decision, reason: 'similar-regression', instanceLiterals: undefined, verdict }))).toEqual([])
    expect(validateCapabilityFile('decision', plain({ ...decision, reason: 'no-similar-cases', outcome: 'awaiting-approval', instanceLiterals: undefined, verdict: { ...verdict, outcome: 'await-approval', reason: 'no-similar-cases', similarPassRate: undefined } }))).toEqual([])
  })

  it('refuses malformed hits and rates', () => {
    expect(validateCapabilityFile('decision', { ...decision, instanceLiterals: [{ value: '2384.13', kind: 'float', path: 'SKILL.md', source: 'feedback:f1' }] })).not.toEqual([])
    expect(validateCapabilityFile('decision', { ...decision, instanceLiterals: [{ value: '2384.13', kind: 'decimal', path: 'SKILL.md' }] })).not.toEqual([])
    expect(validateCapabilityFile('decision', { ...decision, verdict: { ...verdict, similarPassRate: { candidate: 0.5 } } })).not.toEqual([])
    expect(validateCapabilityFile('decision', { ...decision, reason: 'similar-win' })).not.toEqual([])
  })

  it('the published schema lists the hit kinds', () => {
    const defs = capabilitiesSchema['$defs'] as Record<string, { properties: Record<string, { enum?: unknown[] }> }>
    expect(defs['instanceLiteralHit']?.properties['kind']?.enum).toEqual(['decimal', 'integer', 'date'])
  })
})
