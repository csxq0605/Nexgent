import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  applyImproverChange,
  canonicalImproverText,
  IMPROVER_V0,
  resolveWorkspaceLayout,
  type ImprovementJob,
  type ImprovementQueue,
  type ImproverBundle,
  type ImproverChangeRecord,
  type ImproverComparison,
  type ImproverRevision,
  type MetaDiagnosis,
  type ComparisonArmResult,
  type ComparisonOrigin,
  type TrialVerdict,
} from '@nexgent/kernel'
import {
  IMPROVEMENT_FILE_DEFS,
  JsonlSessionStore,
  validateCapabilityFile,
  validateImprovementFile,
  validateLedgerRecord,
  validateSessionRecord,
  type ImprovementFileKind,
} from '../src/index.js'
import { KNOWN_USAGE, SESSION_ID, sessionInit, tempDir } from './helpers.js'

const SHA = (c: string) => c.repeat(64)
const TS = '2026-10-13T00:00:00.000Z'
const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const phase = { usage: KNOWN_USAGE, requestCount: 2 }
const FIXTURES = new URL('./fixtures/step5-run2/', import.meta.url)

type Step6Kind = Extract<ImprovementFileKind, 'improver' | 'improverRevision' | 'metaDiagnosis' | 'change' | 'comparison'>

const child: ImproverBundle = applyImproverChange(IMPROVER_V0, { op: 'set-comparison-param', param: 'repeats', value: 3 })

const revision: ImproverRevision = { format: 1, revision: 1, previous: null, from: 'v0', version: SHA('b'), type: 'adopt', trigger: 'meta-job', jobId: UUID(9), committedAt: TS }
const rollback: ImproverRevision = { format: 1, revision: 2, previous: SHA('c'), from: SHA('b'), version: 'v0', type: 'rollback', trigger: 'manual', reason: '子改进器更差', committedAt: TS }

const metaDiagnosis: MetaDiagnosis = {
  formatVersion: 1,
  jobId: UUID(9),
  createdAt: TS,
  sessionId: 'meta-diag-1',
  attempts: 1,
  improverVersion: 'v0',
  basis: [UUID(1), UUID(2), UUID(3)],
  statusCounts: { adopted: 1, rejected: 2 },
  findings: [{ stage: 'trial', label: 'two replays per case miss the regressions', jobIds: [UUID(2), UUID(3)] }],
  hypothesis: 'The gate replays too few times to see the regression.',
  proposal: 'change',
}

const change: ImproverChangeRecord = {
  formatVersion: 1,
  jobId: UUID(9),
  createdAt: TS,
  sessionId: 'meta-prop-1',
  attempts: 1,
  parentVersion: 'v0',
  childVersion: SHA('b'),
  change: { op: 'set-comparison-param', param: 'repeats', value: 3 },
  rationale: '重复次数不够，回归看不出来。',
}

const origin: ComparisonOrigin = { kind: 'unresolved', sourceJobId: UUID(3), tree: SHA('a'), feedbackIds: ['f1', 'f2'], capabilityVersion: 'baseline', epoch: SHA('e') }
const verdict: TrialVerdict = { outcome: 'adopt', reason: 'quality-up', passRate: { candidate: 1, baseline: 0.5 }, costRatio: 1.1, costBasis: 'usd', decidedByReview: false }
const parentArm: ComparisonArmResult = { arm: 'parent', improverVersion: 'v0', origin, jobId: UUID(10), status: 'rejected', candidateId: UUID(12), verdict: { ...verdict, outcome: 'reject', reason: 'no-improvement' }, cost: { ...phase, estimatedUsd: 0.8 } }
const childArm: ComparisonArmResult = { arm: 'child', improverVersion: SHA('b'), origin, jobId: UUID(11), status: 'adopted', candidateId: UUID(13), verdict, cost: { ...phase, estimatedUsd: 0.9 } }
const comparison: ImproverComparison = {
  formatVersion: 1,
  jobId: UUID(9),
  createdAt: TS,
  origin,
  parent: parentArm,
  child: childArm,
  verdict: { outcome: 'adopt', reason: 'gate-passed', costRatio: 0.9 / 0.8 },
  kept: { child: { root: '/tmp/nexgent-compare/child', bytes: 1024 } },
}

const VALID: Record<Step6Kind, unknown[]> = {
  improver: [IMPROVER_V0, child],
  improverRevision: [revision, rollback],
  metaDiagnosis: [metaDiagnosis, { ...metaDiagnosis, basis: [], findings: [], proposal: 'none' }],
  change: [change, { ...change, change: { op: 'set-proposal-kinds', kinds: ['skill', 'preset'] } }, { ...change, change: { op: 'set-diagnosis-paragraph', index: 0, text: 'x' } }],
  comparison: [comparison, { ...comparison, kept: undefined, verdict: { outcome: 'reject', reason: 'unknown-arm' }, child: { ...childArm, status: 'failed', error: { name: 'NexgentError', code: 'llm/request-failed', message: 'down' }, verdict: undefined, candidateId: undefined, cost: { ...phase, estimatedUsd: 'unknown' } } }],
}

const INVALID: Record<Step6Kind, unknown[]> = {
  improver: [
    { ...IMPROVER_V0, code: 'x' },
    { ...IMPROVER_V0, proposal: { ...IMPROVER_V0.proposal, kinds: ['plugin'] } },
    { ...IMPROVER_V0, comparison: { ...IMPROVER_V0.comparison, repeats: 4 } },
    { ...IMPROVER_V0, comparison: { ...IMPROVER_V0.comparison, selection: 'random' } },
    { ...IMPROVER_V0, comparison: { ...IMPROVER_V0.comparison, costRatioCap: 1.5 } },
  ],
  improverRevision: [{ ...revision, version: 'v1' }, { ...revision, trigger: 'gate' }, { ...revision, revision: 0 }],
  metaDiagnosis: [{ ...metaDiagnosis, improverVersion: undefined }, { ...metaDiagnosis, proposal: 'maybe' }, { ...metaDiagnosis, findings: [{ stage: 'gate', label: 'x', jobIds: [UUID(1)] }] }],
  change: [
    { ...change, change: { op: 'set-comparison-param', param: 'costRatioCap', value: 1.5 } },
    { ...change, change: { op: 'rewrite-code', code: 'x' } },
    { ...change, change: { op: 'set-proposal-kinds', kinds: ['plugin'] } },
    { ...change, rationale: '' },
  ],
  comparison: [{ ...comparison, verdict: { outcome: 'adopt', reason: 'quality-win' } }, { ...comparison, parent: { ...parentArm, arm: 'sibling' } }, { ...comparison, origin: { ...origin, epoch: 'e' } }, { ...comparison, origin: { ...origin, kind: 'latest' } }],
}

describe('step-6 improvement file schema', () => {
  it('covers every file kind (step 5 plus step 6)', () => {
    // `userQueue` (ADR 0012) is covered by step6-rework-records.spec.ts.
    const covered: ImprovementFileKind[] = ['queue', 'job', 'diagnosis', 'userQueue', ...(Object.keys(VALID) as Step6Kind[])]
    expect(covered.sort()).toEqual((Object.keys(IMPROVEMENT_FILE_DEFS) as ImprovementFileKind[]).sort())
  })

  it('accepts the valid samples and refuses the invalid ones', () => {
    for (const kind of Object.keys(VALID) as Step6Kind[]) {
      for (const value of VALID[kind]) expect(validateImprovementFile(kind, JSON.parse(JSON.stringify(value))), kind).toEqual([])
      for (const value of INVALID[kind]) expect(validateImprovementFile(kind, JSON.parse(JSON.stringify(value))), `${kind} ${JSON.stringify(value).slice(0, 120)}`).not.toEqual([])
    }
  })

  it('stores bundles as their canonical text', () => {
    expect(validateImprovementFile('improver', JSON.parse(canonicalImproverText(child)))).toEqual([])
  })

  it('a meta job, an arm job and the meta queue fields validate', () => {
    const meta: ImprovementJob = {
      formatVersion: 1,
      id: UUID(9),
      kind: 'meta',
      improverVersion: 'v0',
      createdAt: TS,
      updatedAt: TS,
      trigger: 'job-count',
      items: [],
      status: 'adopted',
      history: [
        { status: 'queued', at: TS },
        { status: 'meta-diagnosing', at: TS },
        { status: 'meta-proposing', at: TS },
        { status: 'comparing', at: TS },
        { status: 'adopted', at: TS },
      ],
      sessions: { 'meta-diagnose': 'meta-diag-1', 'meta-propose': 'meta-prop-1' },
      phases: { 'meta-diagnose': phase, 'meta-propose': phase, compare: phase },
      meta: {
        basis: [UUID(1), UUID(2), UUID(3)],
        parentVersion: 'v0',
        childVersion: SHA('b'),
        diagnosed: { at: TS, attempts: 1, proposal: 'change' },
        compared: { at: TS, outcome: 'adopt', reason: 'gate-passed' },
        revision: 1,
      },
    }
    expect(validateImprovementFile('job', meta)).toEqual([])
    expect(validateImprovementFile('job', { ...meta, kind: 'other' })).not.toEqual([])
    expect(validateImprovementFile('job', { ...meta, phases: { review: phase } })).not.toEqual([])
    expect(validateImprovementFile('job', { ...meta, meta: { ...meta.meta, compared: { at: TS, outcome: 'adopt', reason: 'quality-win' } } })).not.toEqual([])
    const arm = { ...meta, id: UUID(11), kind: 'capability', improverVersion: SHA('b'), trigger: 'explicit', arm: { metaJobId: UUID(9), arm: 'child' }, meta: undefined, status: 'queued', history: [{ status: 'queued', at: TS }], phases: {}, sessions: undefined }
    expect(validateImprovementFile('job', JSON.parse(JSON.stringify(arm)))).toEqual([])
    expect(validateImprovementFile('job', { ...JSON.parse(JSON.stringify(arm)), arm: { metaJobId: UUID(9), arm: 'both' } })).not.toEqual([])
    const queue: ImprovementQueue = { formatVersion: 1, since: TS, counted: [], pending: [], metaCounted: [UUID(1), UUID(2)], metaPending: [UUID(2)] }
    expect(validateImprovementFile('queue', queue)).toEqual([])
    expect(validateImprovementFile('queue', { ...queue, metaPending: ['x'] })).not.toEqual([])
  })
})

describe('step-6 ledger fields', () => {
  const request = { type: 'llm.request.start', ts: TS, sessionId: 'meta-diag-1', requestId: 'r1', provider: 'anthropic', endpoint: 'https://api.anthropic.com', model: 'claude-sonnet-5-5', purpose: 'task', thinking: 'on', improvementId: UUID(9), improvementPhase: 'meta-diagnose', improverVersion: 'v0' }
  const end = { type: 'improvement.end', ts: TS, jobId: UUID(9), kind: 'meta', trigger: 'job-count', status: 'adopted', childVersion: SHA('b'), phases: { 'meta-diagnose': phase, 'meta-propose': phase, compare: phase }, improvementId: UUID(9) }

  it('accept the meta phases, the arm attribution and the meta improvement.end for writers', () => {
    expect(validateLedgerRecord(request, { forbidAdditionalProperties: true })).toEqual([])
    const armRequest = { ...request, improvementId: UUID(11), improvementPhase: 'trial', improverVersion: SHA('b'), metaJobId: UUID(9), comparisonArm: 'child' }
    expect(validateLedgerRecord(armRequest, { forbidAdditionalProperties: true })).toEqual([])
    expect(validateLedgerRecord({ ...armRequest, comparisonArm: 'both' })).not.toEqual([])
    expect(validateLedgerRecord({ ...request, improverVersion: 'v1' })).not.toEqual([])
    // compare is a job cost bucket, never a request's phase
    expect(validateLedgerRecord({ ...request, improvementPhase: 'compare' })).not.toEqual([])
    expect(validateLedgerRecord(end, { forbidAdditionalProperties: true })).toEqual([])
    expect(validateLedgerRecord({ ...end, kind: 'other' })).not.toEqual([])
    expect(validateLedgerRecord({ ...end, phases: { review: phase } }, { forbidAdditionalProperties: true })).not.toEqual([])
  })
})

describe('step-6 session and trial records', () => {
  it('a meta session and an arm session record their improver', async () => {
    const root = await tempDir()
    const store = new JsonlSessionStore({ layout: resolveWorkspaceLayout(root) })
    const lock = await store.create(sessionInit(root, { purpose: 'improvement', improvement: { jobId: UUID(9), phase: 'meta-diagnose', improverVersion: 'v0' } }))
    await store.release(lock)
    const { records } = await store.readAll(SESSION_ID)
    expect(records[0]).toMatchObject({ improvement: { jobId: UUID(9), phase: 'meta-diagnose', improverVersion: 'v0' } })
    for (const record of records) expect(validateSessionRecord(record), record.type).toEqual([])
    const start = records[0] as unknown as Record<string, unknown>
    expect(validateSessionRecord({ ...start, improvement: { jobId: UUID(11), phase: 'propose', improverVersion: SHA('b'), metaJobId: UUID(9), comparisonArm: 'child' } })).toEqual([])
    expect(validateSessionRecord({ ...start, improvement: { jobId: UUID(11), phase: 'trial' } })).not.toEqual([])
    expect(validateSessionRecord({ ...start, improvement: { jobId: UUID(11), phase: 'propose', comparisonArm: 'both' } })).not.toEqual([])
  })

  it('a trial plan may name its epoch', async () => {
    const lines = (await readFile(new URL('trial.jsonl', FIXTURES), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    const start = lines.find(line => line['type'] === 'trial.start') as Record<string, unknown> & { plan: Record<string, unknown> }
    expect(validateCapabilityFile('trialReceipt', { ...start, plan: { ...start.plan, epoch: SHA('e') } })).toEqual([])
    expect(validateCapabilityFile('trialReceipt', { ...start, plan: { ...start.plan, epoch: 'e' } })).not.toEqual([])
  })
})

describe('step-5 real-run files still read (fixtures from the step-5 Linux run 2)', () => {
  const json = async (name: string) => JSON.parse(await readFile(new URL(name, FIXTURES), 'utf8')) as unknown
  const jsonl = async (name: string) => (await readFile(new URL(name, FIXTURES), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as unknown)

  it('queue, jobs and diagnoses', async () => {
    expect(validateImprovementFile('queue', await json('queue.json'))).toEqual([])
    for (const id of ['091f3c65', '6a9114e1']) {
      expect(validateImprovementFile('job', await json(`job-${id}.json`)), id).toEqual([])
      expect(validateImprovementFile('diagnosis', await json(`diagnosis-${id}.json`)), id).toEqual([])
    }
  })

  it('ledger lines, session starts and trial receipts', async () => {
    for (const line of await jsonl('ledger.jsonl')) expect(validateLedgerRecord(line), JSON.stringify(line).slice(0, 80)).toEqual([])
    for (const line of await jsonl('session-starts.jsonl')) expect(validateSessionRecord(line)).toEqual([])
    for (const line of await jsonl('trial.jsonl')) expect(validateCapabilityFile('trialReceipt', line)).toEqual([])
  })
})
