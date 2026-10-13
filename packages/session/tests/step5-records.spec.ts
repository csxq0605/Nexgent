import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  BASELINE_VERSION,
  emptyImprovementQueue,
  NexgentError,
  resolveWorkspaceLayout,
  UNKNOWN_USAGE,
  type Diagnosis,
  type ImprovementJob,
  type ImprovementQueue,
  type TrialReceipt,
} from '@nexgent/kernel'
import {
  improvementSchema,
  IMPROVEMENT_FILE_DEFS,
  JsonlSessionStore,
  projectSession,
  validateCapabilityFile,
  validateImprovementFile,
  validateLedgerRecord,
  validateSessionRecord,
  type ImprovementFileKind,
} from '../src/index.js'
import { KNOWN_USAGE, SESSION_ID, sessionInit, tempDir, turnRecords } from './helpers.js'

const SHA = 'd'.repeat(64)
const VERSION = 'e'.repeat(64)
const TS = '2026-10-13T00:00:00.000Z'
const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const cost = { usage: KNOWN_USAGE, requestCount: 2, estimatedUsd: 0.01 }
const unknownCost = { usage: UNKNOWN_USAGE, requestCount: 1, estimatedUsd: 'unknown' } as const
const phase = { usage: KNOWN_USAGE, requestCount: 2 }
const unknownPhase = { usage: UNKNOWN_USAGE, requestCount: 1 }

const queue: ImprovementQueue = {
  formatVersion: 1,
  since: TS,
  counted: ['feedback:f1', 'check:t1:2'],
  pending: [
    { kind: 'feedback', feedbackId: 'f1', sessionId: SESSION_ID, deliverableId: 'd1', version: 2, rating: 2, at: TS },
    { kind: 'check-failure', taskId: 't1', sessionId: SESSION_ID, turn: 2, failedChecks: ['parses'], at: TS },
  ],
}

const job: ImprovementJob = {
  formatVersion: 1,
  id: UUID(1),
  createdAt: TS,
  updatedAt: TS,
  trigger: 'feedback-count',
  items: queue.pending,
  status: 'adopted',
  history: [
    { status: 'queued', at: TS },
    { status: 'diagnosing', at: TS },
    { status: 'proposing', at: TS },
    { status: 'trialing', at: TS },
    { status: 'adopted', at: TS, detail: 'Quality 0.83 vs 0.50.' },
  ],
  baseVersion: BASELINE_VERSION,
  sessions: { diagnose: 'diag-1', propose: 'prop-1' },
  diagnosed: { at: TS, proposalKind: 'skill', attempts: 1 },
  candidateId: UUID(2),
  trialId: UUID(3),
  decisionId: UUID(4),
  firstUse: { taskId: 't9', sessionId: 's9', at: TS, version: VERSION },
  phases: { diagnose: phase, propose: phase, trial: unknownPhase },
}

const diagnosis: Diagnosis = {
  formatVersion: 1,
  jobId: UUID(1),
  createdAt: TS,
  sessionId: 'diag-1',
  attempts: 2,
  failureTypes: [{ category: 'task-verification', label: 'missed the region column', evidence: [{ sessionId: SESSION_ID, seq: 12, turn: 1 }] }],
  involved: { members: ['main', 'analyst'], tools: ['write_spreadsheet'], skills: [], components: [{ kind: 'skill', name: 'monthly-order-summary' }] },
  hypothesis: 'No step checks that every requested column exists.',
  proposalKind: 'skill',
  memberCosts: [{ memberId: 'c1', name: 'analyst', executionForm: 'delegated', usage: KNOWN_USAGE, requestCount: 3, toolCallCount: 4 }],
}

const VALID: Record<ImprovementFileKind, unknown[]> = {
  queue: [emptyImprovementQueue(TS), queue, { ...queue, pending: [], activeJobId: UUID(1) }],
  job: [
    job,
    {
      formatVersion: 1,
      id: UUID(5),
      createdAt: TS,
      updatedAt: TS,
      trigger: 'explicit',
      items: [],
      request: { deliverableId: 'd1', version: 1, note: '区域列不对' },
      status: 'failed',
      history: [{ status: 'queued', at: TS }, { status: 'failed', at: TS, detail: 'diagnosis rejected 3 times' }],
      phases: { diagnose: phase },
      detail: 'diagnosis rejected 3 times',
      error: { name: 'NexgentError', code: 'improvement/invalid-diagnosis', message: 'evidence seq 99 does not exist' },
    },
  ],
  diagnosis: [diagnosis, { ...diagnosis, proposalKind: 'none', failureTypes: [], involved: { members: [], tools: [], skills: [], components: [] }, memberCosts: [] }],
}

const INVALID: Record<ImprovementFileKind, unknown[]> = {
  queue: [
    { formatVersion: 1, since: TS, counted: [], pending: [{ kind: 'feedback', feedbackId: 'f1', at: TS }] },
    { formatVersion: 1, since: TS, counted: [], pending: [], activeJobId: 'job-1' },
    { formatVersion: 1, counted: [], pending: [] },
    { formatVersion: 1, since: TS, counted: [], pending: [{ ...queue.pending[0], rating: 6 }] },
    { formatVersion: 2, since: TS, counted: [], pending: [] },
  ],
  job: [
    { ...job, status: 'paused' },
    { ...job, trigger: 'timer' },
    { ...job, history: [] },
    { ...job, phases: { diagnose: cost } },
    { ...job, phases: { review: phase } },
    { ...job, request: { note: 'x'.repeat(2001) } },
    { ...job, history: [{ status: 'queued', at: TS, detail: 'x'.repeat(2001) }] },
  ],
  diagnosis: [
    { ...diagnosis, attempts: 4 },
    { ...diagnosis, proposalKind: 'magic' },
    { ...diagnosis, failureTypes: [{ ...diagnosis.failureTypes[0], evidence: [] }] },
    { ...diagnosis, failureTypes: [{ ...diagnosis.failureTypes[0], category: 'other' }] },
    { ...diagnosis, hypothesis: 'x'.repeat(501) },
    { ...diagnosis, involved: { ...diagnosis.involved, components: [{ kind: 'skill', name: 'Bad Name' }] } },
  ],
}

describe('improvement file schema', () => {
  it('covers every file kind with valid and invalid samples', () => {
    expect(Object.keys(VALID).sort()).toEqual(Object.keys(IMPROVEMENT_FILE_DEFS).sort())
    for (const kind of Object.keys(IMPROVEMENT_FILE_DEFS) as ImprovementFileKind[]) {
      for (const value of VALID[kind]) expect(validateImprovementFile(kind, JSON.parse(JSON.stringify(value))), kind).toEqual([])
      for (const value of INVALID[kind]) expect(validateImprovementFile(kind, value), kind).not.toEqual([])
    }
    expect(validateImprovementFile('queue', { ...queue, extra: 1 })).not.toEqual([])
  })

  it('is published verbatim as schema/improvement.v1.schema.json', async () => {
    const text = await readFile(new URL('../schema/improvement.v1.schema.json', import.meta.url), 'utf8')
    expect(JSON.parse(text)).toEqual(improvementSchema)
  })
})

describe('step-5 capability file additions', () => {
  const candidate = {
    formatVersion: 1,
    id: UUID(2),
    proposedAt: TS,
    sessionId: 'prop-1',
    taskId: 'task-1',
    turn: 1,
    base: BASELINE_VERSION,
    version: VERSION,
    components: [{ kind: 'skill', name: 'monthly-order-summary', files: [{ path: 'SKILL.md', sha256: SHA, bytes: 10 }] }],
    proofs: [{ kind: 'skill', name: 'monthly-order-summary', turn: 1, toolCallId: 'c1' }],
    requiresApproval: false,
  }
  const feedbackReceipt: TrialReceipt = {
    type: 'trial.feedback',
    format: 1,
    trialId: UUID(3),
    ts: TS,
    caseId: 'task-1',
    arm: 'candidate',
    repeat: 1,
    feedbackIds: ['f1'],
    status: 'pass',
    reason: 'The region column is present.',
    model: 'claude-sonnet-5-5',
    cost,
  }

  it('candidates carry their origin and job; a step-4 candidate still reads', () => {
    expect(validateCapabilityFile('candidate', candidate)).toEqual([])
    expect(validateCapabilityFile('candidate', { ...candidate, origin: 'improvement', jobId: UUID(1) })).toEqual([])
    expect(validateCapabilityFile('candidate', { ...candidate, origin: 'gate' })).not.toEqual([])
  })

  it('trial.feedback receipts and feedback cases validate, separately from runs', () => {
    expect(validateCapabilityFile('trialReceipt', feedbackReceipt)).toEqual([])
    expect(validateCapabilityFile('trialReceipt', { ...feedbackReceipt, status: 'unknown', reason: 'reviewer answer did not parse', cost: unknownCost })).toEqual([])
    expect(validateCapabilityFile('trialReceipt', { ...feedbackReceipt, feedbackIds: [] })).not.toEqual([])
    expect(validateCapabilityFile('trialReceipt', { ...feedbackReceipt, set: 'selection' })).not.toEqual([])
    const ref = { caseId: 'task-1', sessionId: SESSION_ID, tree: SHA, checks: [], throughTurn: 1, feedbackIds: ['f1'] }
    const plan = { selection: [ref, { ...ref, caseId: 'task-2', throughTurn: undefined, feedbackIds: undefined }], guard: [ref], repeats: 1, costRatioCap: 1.2, reviewer: { model: 'm', thinking: 'on' }, budget: {} }
    const start = { type: 'trial.start', format: 1, trialId: UUID(3), ts: TS, candidateId: UUID(2), candidateVersion: VERSION, baselineVersion: BASELINE_VERSION, plan }
    expect(validateCapabilityFile('trialReceipt', JSON.parse(JSON.stringify(start)))).toEqual([])
    expect(validateCapabilityFile('trialReceipt', { ...start, plan: { ...plan, guard: [{ ...ref, throughTurn: 0 }] } })).not.toEqual([])
    const verdict = { outcome: 'adopt', reason: 'quality-up', passRate: { candidate: 0.8, baseline: 0.5 }, feedbackPassRate: { candidate: 1, baseline: 0 }, costRatio: 1, decidedByReview: false }
    expect(validateCapabilityFile('trialReceipt', { type: 'trial.end', format: 1, trialId: UUID(3), ts: TS, status: 'pass', verdict, cost: { candidate: cost, baseline: cost, review: cost } })).toEqual([])
  })

  it('a context policy cannot carry the improvement switch or budget', () => {
    const policy = { formatVersion: 1, name: 'loose', description: 'x' }
    expect(validateCapabilityFile('contextPolicy', policy)).toEqual([])
    expect(validateCapabilityFile('contextPolicy', { ...policy, autoImprove: false })).not.toEqual([])
    expect(validateCapabilityFile('contextPolicy', { ...policy, improvement: { budget: { maxTokens: 1e9 } } })).not.toEqual([])
  })

  it('snapshots and checks may name their turn; step-4 files without it still read', () => {
    const snapshot = { formatVersion: 1, taskId: 'task-1', sessionId: SESSION_ID, takenAt: TS, tree: SHA, capabilityVersion: BASELINE_VERSION }
    const checks = { formatVersion: 1, taskId: 'task-1', sessionId: SESSION_ID, checkedAt: TS, specs: [], results: [] }
    expect(validateCapabilityFile('taskSnapshot', snapshot)).toEqual([])
    expect(validateCapabilityFile('taskSnapshot', { ...snapshot, turn: 2 })).toEqual([])
    expect(validateCapabilityFile('taskChecks', { ...checks, turn: 2 })).toEqual([])
    expect(validateCapabilityFile('taskChecks', { ...checks, turn: 0 })).not.toEqual([])
  })
})

describe('step-5 ledger fields', () => {
  const end = {
    type: 'improvement.end',
    ts: TS,
    jobId: UUID(1),
    trigger: 'check-failure',
    status: 'no-proposal',
    phases: { diagnose: { usage: KNOWN_USAGE, requestCount: 3 } },
    improvementId: UUID(1),
  }

  it('accept improvement attribution and the improvement.end record for writers', () => {
    const request = { type: 'llm.request.start', ts: TS, sessionId: 'diag-1', requestId: 'r1', provider: 'anthropic', endpoint: 'https://api.anthropic.com', model: 'claude-sonnet-5-5', purpose: 'task', thinking: 'on', improvementId: UUID(1), improvementPhase: 'diagnose' }
    expect(validateLedgerRecord(request, { forbidAdditionalProperties: true })).toEqual([])
    expect(validateLedgerRecord({ ...request, improvementPhase: 'review' })).not.toEqual([])
    expect(validateLedgerRecord(end, { forbidAdditionalProperties: true })).toEqual([])
    expect(validateLedgerRecord({ ...end, candidateId: UUID(2), decisionId: UUID(4), status: 'adopted' }, { forbidAdditionalProperties: true })).toEqual([])
    expect(validateLedgerRecord({ ...end, phases: { review: end.phases.diagnose } }, { forbidAdditionalProperties: true })).not.toEqual([])
    const { phases: _phases, ...noPhases } = end
    expect(validateLedgerRecord(noPhases)).not.toEqual([])
    expect(validateLedgerRecord({ ...end, status: 'paused' })).not.toEqual([])
    expect(validateLedgerRecord({ ...end, phases: { diagnose: { ...end.phases.diagnose, estimatedUsd: 1 } } }, { forbidAdditionalProperties: true })).not.toEqual([])
  })
})

describe('step-5 session records', () => {
  it('an improvement session records its purpose and job, and projects them', async () => {
    const root = await tempDir()
    const store = new JsonlSessionStore({ layout: resolveWorkspaceLayout(root) })
    const lock = await store.create(sessionInit(root, { purpose: 'improvement', improvement: { jobId: UUID(1), phase: 'diagnose' } }))
    for (const record of turnRecords(1)) await store.append(SESSION_ID, record)
    await store.release(lock)
    const { records } = await store.readAll(SESSION_ID)
    expect(records[0]).toMatchObject({ type: 'session.start', purpose: 'improvement', improvement: { jobId: UUID(1), phase: 'diagnose' } })
    for (const record of records) expect(validateSessionRecord(record), record.type).toEqual([])
    const state = await store.resume(SESSION_ID)
    expect(state).toEqual(projectSession(records))
    expect(state.metadata).toMatchObject({ purpose: 'improvement', improvement: { jobId: UUID(1), phase: 'diagnose' } })
  })

  it('refuses an improvement purpose without its job, and a job without the purpose', async () => {
    const root = await tempDir()
    const store = new JsonlSessionStore({ layout: resolveWorkspaceLayout(root) })
    await expect(store.create(sessionInit(root, { purpose: 'improvement' }))).rejects.toBeInstanceOf(NexgentError)
    await expect(store.create(sessionInit(root, { improvement: { jobId: UUID(1), phase: 'propose' } }))).rejects.toBeInstanceOf(NexgentError)
    await expect(store.create(sessionInit(root, { purpose: 'task', improvement: { jobId: UUID(1), phase: 'propose' } }))).rejects.toBeInstanceOf(NexgentError)
  })

  it('a step-4 session (no purpose) still reads as a task session', async () => {
    const root = await tempDir()
    const store = new JsonlSessionStore({ layout: resolveWorkspaceLayout(root) })
    const lock = await store.create(sessionInit(root, { capabilityVersion: VERSION }))
    for (const record of turnRecords(1)) await store.append(SESSION_ID, record)
    await store.release(lock)
    const state = await store.resume(SESSION_ID)
    expect(state.metadata.purpose).toBeUndefined()
    expect(state.metadata.improvement).toBeUndefined()
  })

  it('rejects malformed starts', () => {
    const start = { type: 'session.start', seq: 1, ts: TS, sessionId: SESSION_ID, version: 1, projectRoot: '/p', model: 'm', sandboxMode: 'read-only' }
    expect(validateSessionRecord({ ...start, purpose: 'task' })).toEqual([])
    expect(validateSessionRecord({ ...start, purpose: 'review' })).not.toEqual([])
    expect(validateSessionRecord({ ...start, purpose: 'improvement', improvement: { jobId: UUID(1), phase: 'trial' } })).not.toEqual([])
    expect(validateSessionRecord({ ...start, purpose: 'improvement', improvement: { jobId: UUID(1) } })).not.toEqual([])
  })
})
