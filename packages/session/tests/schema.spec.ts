import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  LEDGER_RECORD_TYPES,
  SESSION_RECORD_TYPES,
  UNKNOWN_USAGE,
  type SessionRecord,
  type SessionRecordInput,
} from '@nexgent/kernel'
import {
  encodeLine,
  evaluateSchema,
  isSessionRecord,
  ledgerRecordSchema,
  ledgerRecordValidators,
  projectSession,
  scanSessionLog,
  sessionRecordSchema,
  sessionRecordValidators,
  validateLedgerRecord,
  validateSessionRecord,
  validateSessionState,
} from '../src/index.js'
import { KNOWN_USAGE } from './helpers.js'

const ID = '6f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f'
const TS = '2026-10-07T08:00:00.000Z'
const SHA = 'a'.repeat(64)
const MATERIAL = {
  id: '9d3c1f0e-1111-4222-8333-444455556666',
  originalName: 'orders.csv',
  path: '.nexgent/materials/9d3c1f0e-1111-4222-8333-444455556666/orders.csv',
  size: 1234,
  sha256: SHA,
  mediaType: 'text/csv',
}

/** One input per record type (the checkpoint is filled in below). */
const inputs: SessionRecordInput[] = [
  {
    type: 'session.start',
    version: 1,
    projectRoot: '/p',
    model: 'claude-sonnet-5-5',
    sandboxMode: 'read-only',
    parentSessionId: 'parent-1',
    title: 'Title',
    member: { name: 'analyst', executionForm: 'delegated', preset: 'read-only-analyst' },
  },
  // step 3: a forked child's history comes right after session.start
  { type: 'fork.seed', fromSessionId: 'parent-1', throughSeq: 12, messages: [{ role: 'user', content: 'earlier' }] },
  { type: 'turn.start', turn: 1 },
  { type: 'user.message', turn: 1, content: 'hi', source: 'inject' },
  {
    type: 'assistant.message',
    turn: 1,
    step: 1,
    requestId: 'r1',
    content: 'x',
    toolCalls: [{ id: 'c1', name: 'bash', arguments: '{"command":"ls"}' }],
    usage: KNOWN_USAGE,
    finishReason: 'tool-calls',
  },
  {
    type: 'approval.request',
    turn: 1,
    request: {
      id: 'ap1',
      sessionId: ID,
      callId: 'c1',
      tool: 'bash',
      summary: 'ls',
      detail: 'cwd /p',
      risk: 'medium',
      options: ['once', 'session'],
      pattern: 'ls',
      expiresAt: TS,
      // step 3: a member raised it
      member: { name: 'analyst', executionForm: 'delegated', parentSessionId: 'parent-1' },
    },
  },
  { type: 'approval.decision', turn: 1, decision: { id: 'ap1', decision: 'allow', scope: 'session', decidedBy: 'user', reason: 'ok' } },
  { type: 'approval.grant', grant: { tool: 'bash', pattern: 'ls', grantedAt: TS } },
  {
    type: 'tool.result',
    turn: 1,
    step: 1,
    toolCallId: 'c1',
    name: 'bash',
    content: 'boom',
    isError: true,
    error: { name: 'NexgentError', code: 'tool/failed', message: 'boom', details: { exit: 1 } },
    meta: { diff: ['a', 1, null, true] },
    durationMs: 12.5,
  },
  { type: 'error', turn: 1, error: { name: 'NexgentError', code: 'ledger/write-failed', message: 'disk' }, fatal: false },
  { type: 'turn.end', turn: 1, reason: { kind: 'error', error: { name: 'Error', code: 'internal', message: 'x' } } },
  // step 2 records
  { type: 'material.added', material: MATERIAL },
  { type: 'goal.set', goal: { id: 'g1', text: 'Clean the orders', status: 'active', setAt: TS, updatedAt: TS } },
  { type: 'turn.start', turn: 2 },
  { type: 'feedback', turn: 2, feedback: { id: 'f1', deliverableId: 'd1', version: 1, rating: 3, comment: 'Use Chinese names' } },
  { type: 'user.message', turn: 2, content: 'Use Chinese names', source: 'feedback', materials: [MATERIAL.id] },
  {
    type: 'compaction',
    turn: 2,
    step: 1,
    summary: 'Earlier: listed files.',
    keepMessages: 1,
    compactedMessages: 3,
    requestId: 'r-compact',
    usage: KNOWN_USAGE,
    trigger: { inputTokens: 1200, threshold: 1000 },
  },
  {
    type: 'deliverable.presented',
    turn: 2,
    step: 1,
    toolCallId: 'c2',
    deliverable: {
      deliverableId: 'd1',
      version: 2,
      title: 'summary.csv',
      summary: 'Summary by region',
      files: [{ path: 'report/summary.csv', size: 10, sha256: SHA, mediaType: 'text/csv' }],
    },
  },
  { type: 'goal.update', turn: 2, goalId: 'g1', status: 'completed', note: 'done' },
  { type: 'session.title', turn: 2, title: '月报整理' },
  { type: 'turn.files', turn: 2, changes: [{ path: 'report/summary.csv', change: 'modified' }], omitted: 2 },
  // step 3 records (shapes only; a real child would not start members itself)
  { type: 'subagent.start', turn: 2, toolCallId: 'c9', childSessionId: 'child-1', childTurn: 1, name: 'checker', executionForm: 'workflow', workflowId: 'w1', task: 'check' },
  { type: 'subagent.end', turn: 2, childSessionId: 'child-1', childTurn: 1, result: { status: 'interrupted', text: '', deliverables: [], usage: UNKNOWN_USAGE, requestCount: 1 } },
  { type: 'team.member', member: { name: 'checker', sessionId: 'child-2', status: 'idle', preset: 'read-only-checker', persona: 'You check twice.' } },
  { type: 'team.task', turn: 2, task: { id: 't1', title: 'Check', status: 'completed', dependsOn: [], result: 'ok' } },
  { type: 'team.message', message: { id: 'm1', from: 'checker', to: 'lead', text: 'done', state: 'queued' } },
  { type: 'workflow.start', turn: 2, toolCallId: 'c9', workflowId: 'w1', kind: 'script' },
  { type: 'workflow.phase', turn: 2, workflowId: 'w1', phase: 'check' },
  { type: 'workflow.end', turn: 2, workflowId: 'w1', status: 'interrupted', members: 1 },
  // step 4 records
  { type: 'capability.draft', turn: 2, step: 2, toolCallId: 'c10', component: { kind: 'skill', name: 'csv-summary' }, files: [{ path: 'SKILL.md', sha256: SHA, bytes: 120 }], revision: 1 },
  { type: 'capability.try', turn: 2, step: 3, toolCallId: 'c11', component: { kind: 'function-module', name: 'csv-tools' }, revision: 1, tools: ['cap_csv-tools_sum'] },
  { type: 'capability.propose', turn: 2, step: 4, toolCallId: 'c12', candidateId: 'cand-1', proofs: [{ kind: 'function-module', name: 'csv-tools', turn: 2, toolCallId: 'c13' }] },
  { type: 'capability.version', turn: 2, version: 'baseline', previous: SHA, reason: 'load-failure', detail: 'functions/csv-tools/index.mjs hash mismatch' },
  { type: 'turn.end', turn: 2, reason: { kind: 'completed' } },
]

function sampleRecords(): SessionRecord[] {
  const records = inputs.map((input, index) => ({ ...input, seq: index + 1, ts: TS, sessionId: ID }) as SessionRecord)
  const state = projectSession(records)
  records.push({ type: 'checkpoint', seq: records.length + 1, ts: TS, sessionId: ID, coversSeq: records.length, state })
  return records
}

describe('session record schema', () => {
  it('has a validator, a $defs entry and a sample for every record type', () => {
    const records = sampleRecords()
    expect(new Set(records.map(record => record.type))).toEqual(new Set(SESSION_RECORD_TYPES))
    expect(Object.keys(sessionRecordValidators).sort()).toEqual([...SESSION_RECORD_TYPES].sort())
    for (const record of records) {
      expect(sessionRecordValidators[record.type](record), record.type).toEqual([])
      // The published root schema (oneOf) accepts it too.
      expect(evaluateSchema(sessionRecordSchema, sessionRecordSchema, record), record.type).toEqual([])
    }
  })

  it('round-trips every record type through a JSONL line', () => {
    const records = sampleRecords()
    const bytes = Buffer.from(records.map(encodeLine).join(''), 'utf8')
    const scan = scanSessionLog(bytes, ID)
    expect(scan.truncation).toBeUndefined()
    expect(scan.records).toEqual(records)
  })

  it('accepts every turn.end reason and rejects unknown kinds', () => {
    const base = { type: 'turn.end', seq: 2, ts: TS, sessionId: ID, turn: 1 }
    for (const reason of [
      { kind: 'completed' },
      { kind: 'cancelled', cause: 'cost-cap' },
      { kind: 'cancelled', cause: 'parent' },
      { kind: 'max-tokens' },
      { kind: 'interrupted' },
    ]) {
      expect(validateSessionRecord({ ...base, reason })).toEqual([])
    }
    expect(validateSessionRecord({ ...base, reason: { kind: 'cancelled' } })).not.toEqual([])
    expect(validateSessionRecord({ ...base, reason: { kind: 'exploded' } })).not.toEqual([])
  })

  it('rejects malformed records with a path to the problem', () => {
    const [start] = sampleRecords()
    expect(validateSessionRecord({ ...start, type: 'nope' })[0]?.path).toBe('/type')
    expect(validateSessionRecord({ ...start, seq: 0 })[0]?.path).toBe('/seq')
    expect(validateSessionRecord({ ...start, seq: 1.5 })[0]?.path).toBe('/seq')
    expect(validateSessionRecord({ ...start, ts: '2026-10-07 08:00' })[0]?.path).toBe('/ts')
    expect(validateSessionRecord({ ...start, version: 2 })[0]?.path).toBe('/version')
    expect(validateSessionRecord({ ...start, sandboxMode: 'yolo' })[0]?.path).toBe('/sandboxMode')
    expect(validateSessionRecord({ ...start, extra: 1 })[0]).toEqual({ path: '/extra', message: 'unknown property' })
    // Readers accept unknown optional fields from a newer same-version writer.
    expect(validateSessionRecord({ ...start, extra: 1 }, { allowAdditionalProperties: true })).toEqual([])
    const { model: _model, ...noModel } = start as SessionRecord & { model: string }
    expect(validateSessionRecord(noModel)[0]?.message).toMatch(/model/)
    expect(validateSessionRecord({ ...start, title: undefined })[0]?.message).toMatch(/JSON-safe/)
    const usage = { ...UNKNOWN_USAGE, inputTokens: -1 }
    expect(
      validateSessionRecord({
        type: 'assistant.message', seq: 2, ts: TS, sessionId: ID, turn: 1, step: 1, requestId: 'r', content: '', usage, finishReason: 'stop',
      }),
    ).not.toEqual([])
    expect(isSessionRecord(start)).toBe(true)
  })

  it('checks the member of an approval request field by field', () => {
    const request = sampleRecords().find(record => record.type === 'approval.request')!
    const withMember = (member: unknown) => ({ ...request, request: { ...(request as { request: object }).request, member } })
    expect(validateSessionRecord(withMember({ name: 'writer', executionForm: 'team', parentSessionId: 'p' }))).toEqual([])
    expect(validateSessionRecord(withMember({ name: 'writer', executionForm: 'team' }))[0]?.message).toMatch(/parentSessionId/)
    expect(validateSessionRecord(withMember({ name: 'writer', executionForm: 'direct', parentSessionId: 'p' }))[0]?.path).toBe('/request/member/executionForm')
    expect(validateSessionRecord(withMember({ name: 'Writer', executionForm: 'team', parentSessionId: 'p' }))[0]?.path).toBe('/request/member/name')
    expect(validateSessionRecord(withMember({ name: 'writer', executionForm: 'team', parentSessionId: 'p', preset: 'x' }))[0]).toEqual({ path: '/request/member/preset', message: 'unknown property' })
  })

  it('validates checkpoint states', () => {
    const records = sampleRecords()
    const checkpoint = records.at(-1)
    if (checkpoint?.type !== 'checkpoint') throw new Error('expected checkpoint')
    expect(validateSessionState(checkpoint.state)).toEqual([])
    expect(validateSessionState({ ...checkpoint.state, messages: [{ role: 'system', content: 'x' }] })).not.toEqual([])
    expect(validateSessionState({ ...checkpoint.state, metadata: { ...checkpoint.state.metadata, grants: undefined } })).not.toEqual([])
  })

  it('accepts the spec examples (data-formats.md §示例) and their checkpoint equals the projection', async () => {
    const text = await readFile(new URL('./fixtures/spec-example.jsonl', import.meta.url), 'utf8')
    const scan = scanSessionLog(Buffer.from(text, 'utf8'), ID)
    expect(scan.truncation).toBeUndefined()
    expect(scan.records).toHaveLength(12)
    for (const record of scan.records) expect(validateSessionRecord(record)).toEqual([])
    // Round trip: re-encoding yields the fixture byte for byte.
    expect(scan.records.map(encodeLine).join('')).toBe(text)
    const checkpoint = scan.records[7]
    if (checkpoint?.type !== 'checkpoint') throw new Error('expected checkpoint')
    expect(checkpoint.state).toEqual(projectSession(scan.records.slice(0, 7)))
  })

  it('reads records written before cacheWriteTokens existed with it as unknown', async () => {
    const text = await readFile(new URL('./fixtures/spec-example.jsonl', import.meta.url), 'utf8')
    // Such records also predate `lastUsage` (ADR 0021).
    const legacy = text.replace(/,"lastUsage":\{[^}]*\}/g, '').replace(/"cacheWriteTokens":(?:"unknown"|\d+),/g, '')
    expect(legacy).not.toContain('cacheWriteTokens')
    const scan = scanSessionLog(Buffer.from(legacy, 'utf8'), ID)
    expect(scan.truncation).toBeUndefined()
    const message = scan.records[3]
    const checkpoint = scan.records[7]
    if (message?.type !== 'assistant.message' || checkpoint?.type !== 'checkpoint') throw new Error('unexpected fixture')
    expect(message.usage.cacheWriteTokens).toBe('unknown')
    expect(checkpoint.state.metadata.totalUsage.cacheWriteTokens).toBe('unknown')
    expect(checkpoint.state).toEqual(projectSession(scan.records.slice(0, 7)))
  })

  it('is published verbatim as schema/session.v1.schema.json', async () => {
    const text = await readFile(new URL('../schema/session.v1.schema.json', import.meta.url), 'utf8')
    expect(JSON.parse(text)).toEqual(sessionRecordSchema)
  })
})

describe('ledger record schema', () => {
  it('has a validator for every ledger type and accepts the spec examples', async () => {
    expect(Object.keys(ledgerRecordValidators).sort()).toEqual([...LEDGER_RECORD_TYPES].sort())
    const text = await readFile(new URL('./fixtures/ledger-example.jsonl', import.meta.url), 'utf8')
    const records = text.trimEnd().split('\n').map(line => JSON.parse(line) as { type: string })
    expect(new Set(records.map(record => record.type))).toEqual(new Set(LEDGER_RECORD_TYPES))
    for (const record of records) {
      expect(validateLedgerRecord(record, { forbidAdditionalProperties: true }), record.type).toEqual([])
      expect(evaluateSchema(ledgerRecordSchema, ledgerRecordSchema, record)).toEqual([])
      expect(JSON.parse(JSON.stringify(record))).toEqual(record)
    }
  })

  it('is open for readers and closed for writers', () => {
    const record = {
      type: 'tool.call', ts: TS, sessionId: ID, turn: 1, callId: 'c', name: 'bash', effects: ['execute'],
      approval: { required: true, decision: 'allow', scope: 'once', requestId: 'ap' }, isError: false, durationMs: 0,
      futureField: 'x',
    }
    expect(validateLedgerRecord(record)).toEqual([])
    expect(validateLedgerRecord(record, { forbidAdditionalProperties: true })).toEqual([
      { path: '/futureField', message: 'unknown property' },
    ])
    expect(validateLedgerRecord({ ...record, type: 'llm.request.retry' })[0]?.path).toBe('/type')
    expect(validateLedgerRecord({ ...record, effects: ['teleport'] })).not.toEqual([])
  })
})
