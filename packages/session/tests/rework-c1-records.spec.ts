import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  COST_CAP_SCOPES,
  COST_WARNING_LEVELS,
  DECISION_REASONS,
  foldHandbook,
  HANDBOOK_ACTORS,
  HANDBOOK_ENTRY_STATUSES,
  HANDBOOK_OP_KINDS,
  HANDBOOK_SCOPES,
  LEARNING_PHASES,
  LEARNING_RULES,
  MIGRATION_STATUSES,
  PRACTICE_SPLITS,
  PROJECT_DATA_SUBDIRS,
  SELF_EVAL_OUTCOMES,
  SELF_EVAL_SAMPLES,
  type HandbookOp,
  type MigrationRecord,
  type PracticeCase,
  type ProjectGrantsFile,
  type ProjectIdentity,
  type SelfEvaluation,
} from '@nexgent/kernel'
import { ledgerRecordSchema, learningSchema, sessionRecordSchema, validateLearningFile, validateLedgerRecord, validateSessionRecord } from '../src/index.js'
import { KNOWN_USAGE } from './helpers.js'

/**
 * Rework C1 (ADR 0017–0019): project identity and user data directory files,
 * self-evaluations, practice cases and handbook operations round-trip
 * through `learning.v1.schema.json`; ledger and session additions validate;
 * every enum of the schemas equals its kernel constant; records written
 * before the rework still validate.
 */
const SHA = (c: string) => c.repeat(64)
const TS = '2026-10-16T08:00:00.000Z'
const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const P1 = SHA('a')
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const cost = { usage: KNOWN_USAGE, requestCount: 2, estimatedUsd: 0.012 }

type Defs = Record<string, Record<string, unknown>>
const LEARNING_DEFS = learningSchema.$defs as Defs
const prop = (def: string, field: string): unknown => (LEARNING_DEFS[def]?.['properties'] as Defs)[field]

describe('learning.v1.schema.json', () => {
  it('is published verbatim', async () => {
    const text = await readFile(new URL('../schema/learning.v1.schema.json', import.meta.url), 'utf8')
    expect(JSON.parse(text)).toEqual(learningSchema)
  })

  it('every enum equals its kernel constant', () => {
    expect(prop('migrationRecord', 'status')).toEqual({ enum: [...MIGRATION_STATUSES] })
    expect(prop('migrationEntry', 'name')).toEqual({ enum: [...PROJECT_DATA_SUBDIRS] })
    expect(prop('selfEvaluation', 'sample')).toEqual({ enum: [...SELF_EVAL_SAMPLES] })
    expect(prop('selfEvaluation', 'outcome')).toEqual({ enum: [...SELF_EVAL_OUTCOMES] })
    expect(prop('selfEvaluation', 'rules')).toEqual({ const: LEARNING_RULES })
    expect(prop('practiceCase', 'split')).toEqual({ enum: [...PRACTICE_SPLITS] })
    const ops = (LEARNING_DEFS['handbookOp']?.['oneOf'] as Defs[]).map(def => def['properties'] as Defs)
    expect(ops.map(op => op['op']?.['const'])).toEqual([...HANDBOOK_OP_KINDS])
    for (const op of ops) expect(op['actor']).toEqual({ enum: [...HANDBOOK_ACTORS] })
    expect(ops[0]?.['scope']).toEqual({ enum: [...HANDBOOK_SCOPES] })
    expect(ops[4]?.['status']).toEqual({ enum: [...HANDBOOK_ENTRY_STATUSES] })
  })
})

describe('project identity and user data directory files', () => {
  it('round-trip', () => {
    const identity: ProjectIdentity = { formatVersion: 1, projectId: P1, createdAt: TS, name: '销售分析' }
    expect(validateLearningFile('projectIdentity', plain(identity))).toEqual([])
    expect(validateLearningFile('projectDataIndex', { formatVersion: 1, projectId: P1, root: 'C:\\work\\a', lastOpenedAt: TS })).toEqual([])
    const grants: ProjectGrantsFile = { formatVersion: 1, approvals: [{ tool: 'run_command', pattern: 'pnpm test', grantedAt: TS }] }
    expect(validateLearningFile('projectGrants', plain(grants))).toEqual([])
    const migration: MigrationRecord = {
      formatVersion: 1, projectId: P1, from: '/work/a/.nexgent', status: 'done', startedAt: TS, finishedAt: TS,
      entries: [{ name: 'sessions', files: 3, bytes: 4096 }, { name: 'ledgers', files: 1, bytes: 512 }], grantsMoved: 1, oldDataKept: true,
    }
    expect(validateLearningFile('migration', plain(migration))).toEqual([])
    expect(validateLearningFile('migration', plain({ ...migration, status: 'failed', error: { name: 'Error', code: 'internal', message: 'disk full' } }))).toEqual([])
  })

  it('refuse malformed files', () => {
    for (const [kind, bad] of [
      ['projectIdentity', { formatVersion: 1, projectId: 'p1', createdAt: TS }],
      ['projectIdentity', { formatVersion: 1, projectId: P1, createdAt: TS, root: '/work/a' }],
      ['projectGrants', { formatVersion: 1, approvals: [{ tool: '', grantedAt: TS }] }],
      ['migration', { formatVersion: 1, projectId: P1, from: '/x', status: 'done', startedAt: TS, entries: [], grantsMoved: 0, oldDataKept: false }],
      ['migration', { formatVersion: 1, projectId: P1, from: '/x', status: 'done', startedAt: TS, entries: [{ name: 'config.json', files: 1, bytes: 1 }], grantsMoved: 0, oldDataKept: true }],
    ] as const) {
      expect(validateLearningFile(kind, bad), JSON.stringify(bad)).not.toEqual([])
    }
  })
})

describe('self-evaluations and practice cases', () => {
  const rubric = { items: [{ id: 'r1', text: '结果文件包含每个地区的合计', weight: 2 }, { id: 'r2', text: '说明了数据来源' }], model: 'claude-sonnet-5-5', createdAt: TS, generator: 'v0' }
  const evaluation: SelfEvaluation = {
    formatVersion: 1, rules: LEARNING_RULES, projectId: P1, taskId: 't1', sessionId: 's1', turn: 2, createdAt: TS,
    checks: [{ name: 'pnpm test', passed: true }], sample: 'random', rubric, scores: [{ itemId: 'r1', score: 1 }, { itemId: 'r2', score: 0.5, note: '只提了一句' }],
    scorer: 'claude-sonnet-5-5', feedback: { feedbackIds: ['f1'], rating: 4 }, score: 0.92, outcome: 'success', cost,
    calibration: { model: 'claude-opus-5-5', score: 0.9, agree: true, at: TS, cost },
  }

  it('round-trip, the minimal unscored form included', () => {
    expect(validateLearningFile('selfEvaluation', plain(evaluation))).toEqual([])
    const unscored = { formatVersion: 1, rules: LEARNING_RULES, projectId: P1, taskId: 't2', sessionId: 's2', turn: 1, createdAt: TS, checks: [], sample: 'budget-exhausted', outcome: 'unknown', cost: { usage: KNOWN_USAGE, requestCount: 0, estimatedUsd: 'unknown' } }
    expect(validateLearningFile('selfEvaluation', unscored)).toEqual([])
    const practice: PracticeCase = {
      formatVersion: 1, id: UUID(1), source: 'task', createdAt: TS, prompt: '把订单表按地区汇总', input: { projectId: P1, tree: SHA('b') },
      projectId: P1, taskId: 't1', sessionId: 's1', similarityKey: ['订单', '汇总'], clusterId: 'c-17', split: 'holdout', rubric, outcome: 'success', score: 0.92,
    }
    expect(validateLearningFile('practiceCase', plain(practice))).toEqual([])
    expect(validateLearningFile('practiceCase', { formatVersion: 1, id: UUID(2), source: 'generic', createdAt: TS, prompt: 'x', similarityKey: [], clusterId: 'g1', split: 'guard' })).toEqual([])
  })

  it('refuse records of another epoch or with bad scores', () => {
    for (const bad of [
      { ...evaluation, rules: 'adr-0016' },
      { ...evaluation, scores: [{ itemId: 'r1', score: 0.7 }] },
      { ...evaluation, sample: 'always' },
      { ...evaluation, feedback: { feedbackIds: [], rating: 6 } },
      { ...evaluation, rubric: { ...rubric, items: [] } },
      { ...evaluation, rubric: { ...rubric, items: [{ id: 'item-1', text: 'x' }] } },
      { ...evaluation, extra: 1 },
    ]) {
      expect(validateLearningFile('selfEvaluation', plain(bad))).not.toEqual([])
    }
    expect(validateLearningFile('practiceCase', { formatVersion: 1, id: UUID(3), source: 'task', createdAt: TS, prompt: 'x', similarityKey: ['Upper'], clusterId: 'c', split: 'train' })).not.toEqual([])
    expect(validateLearningFile('practiceCase', { formatVersion: 1, id: UUID(3), source: 'task', createdAt: TS, prompt: 'x', similarityKey: [], clusterId: 'c', split: 'test' })).not.toEqual([])
  })
})

describe('handbook operations', () => {
  const ops: HandbookOp[] = [
    { formatVersion: 1, seq: 1, at: TS, entryId: UUID(1), actor: 'reflection', op: 'add', text: '先读完输入文件的表头再动手', keywords: ['csv', '表格'], scope: 'user', source: { projectId: P1, taskId: 't1' } },
    { formatVersion: 1, seq: 2, at: TS, entryId: UUID(1), actor: 'execution', op: 'upvote', source: { taskId: 't2' }, reason: '避免了列名错位' },
    { formatVersion: 1, seq: 3, at: TS, entryId: UUID(1), actor: 'user', op: 'downvote' },
    { formatVersion: 1, seq: 4, at: TS, entryId: UUID(1), actor: 'reflection', op: 'edit', keywords: ['csv'] },
    { formatVersion: 1, seq: 5, at: TS, entryId: UUID(1), actor: 'host', op: 'status', status: 'active' },
    { formatVersion: 1, seq: 6, at: TS, entryId: UUID(2), actor: 'migration', op: 'add', text: '回答用用户的语言', keywords: [], scope: 'project', projectId: P1, status: 'active', supersedes: [UUID(1)] },
  ]

  it('every operation kind round-trips and folds', () => {
    for (const op of ops) expect(validateLearningFile('handbookOp', plain(op)), op.op).toEqual([])
    const [first, second] = foldHandbook(ops)
    expect(first).toMatchObject({ status: 'retired', supersededBy: UUID(2), helpful: 1, harmful: 1, keywords: ['csv'] })
    expect(second).toMatchObject({ status: 'active', scope: 'project', supersedes: [UUID(1)] })
  })

  it('refuses malformed operations', () => {
    for (const bad of [
      { ...ops[0], op: 'rewrite' },
      { ...ops[0], seq: 0 },
      { ...ops[0], entryId: 'e1' },
      { ...ops[0], status: 'retired' },
      { ...ops[0], text: '' },
      { ...ops[0], text: 'x'.repeat(601) },
      { ...ops[1], text: 'not allowed on a vote' },
      { ...ops[4], status: 'deleted' },
      { ...ops[0], actor: 'model' },
    ]) {
      expect(validateLearningFile('handbookOp', plain(bad)), JSON.stringify(bad).slice(0, 100)).not.toEqual([])
    }
  })
})

describe('ledger and session additions', () => {
  const base = { ts: TS, sessionId: 's1' }

  it('cost.warning, learningPhase, attempt and usageEstimated validate for writers', () => {
    const writer = { forbidAdditionalProperties: true }
    expect(validateLedgerRecord({ ...base, type: 'cost.warning', scope: 'perConversation', level: 'warning', limit: 'maxUsd', used: 4.1, cap: 5, estimated: true }, writer)).toEqual([])
    expect(validateLedgerRecord({ ...base, type: 'llm.request.start', requestId: 'r1', provider: 'anthropic', endpoint: 'https://api.anthropic.com', model: 'm', purpose: 'auxiliary', thinking: 'on', attempt: 2, learningPhase: 'self-eval', taskId: 't1' }, writer)).toEqual([])
    expect(validateLedgerRecord({ ...base, type: 'llm.request.end', requestId: 'r1', provider: 'anthropic', endpoint: 'https://api.anthropic.com', model: 'm', status: 'unknown', usage: KNOWN_USAGE, latencyMs: 10, usageEstimated: true, attempt: 2 }, writer)).toEqual([])
    expect(validateLedgerRecord({ ...base, type: 'cost.warning', scope: 'perTask', level: 'ok', limit: 'maxUsd', used: 1, cap: 5, estimated: false })).not.toEqual([])
    expect(validateLedgerRecord({ ...base, type: 'llm.request.end', requestId: 'r1', provider: 'a', endpoint: 'e', model: 'm', status: 'ok', usage: KNOWN_USAGE, latencyMs: 1, usageEstimated: false })).not.toEqual([])
    expect(validateLedgerRecord({ ...base, type: 'llm.request.start', requestId: 'r1', provider: 'a', endpoint: 'e', model: 'm', purpose: 'task', thinking: 'on', attempt: 0 })).not.toEqual([])
  })

  it('ledger and decision enums equal the kernel constants', () => {
    const defs = ledgerRecordSchema.$defs as Defs
    const props = (def: string) => defs[def]?.['properties'] as Defs
    expect(props('costWarningRecord')['scope']).toEqual({ enum: [...COST_CAP_SCOPES] })
    expect(props('costWarningRecord')['level']).toEqual({ enum: [...COST_WARNING_LEVELS] })
    expect(props('llmRequestEndRecord')['learningPhase']).toEqual({ enum: [...LEARNING_PHASES] })
    expect(props('capabilityDecisionRecord')['reason']).toEqual({ enum: [...DECISION_REASONS] })
    expect(DECISION_REASONS).toContain('cost-optimized')
    expect(DECISION_REASONS).toContain('scorer-unreliable')
  })

  it('turn.start carries the injected handbook entry ids; old turn.start records still validate', () => {
    const turn = { seq: 3, ts: TS, sessionId: 's1', type: 'turn.start', turn: 2 }
    expect(validateSessionRecord(turn)).toEqual([])
    expect(validateSessionRecord({ ...turn, handbook: [UUID(1), UUID(2)] })).toEqual([])
    expect(validateSessionRecord({ ...turn, handbook: [''] })).not.toEqual([])
    const def = (sessionRecordSchema.$defs as Defs)['turnStartRecord']?.['properties'] as Defs
    expect(def['handbook']).toBeDefined()
  })
})
