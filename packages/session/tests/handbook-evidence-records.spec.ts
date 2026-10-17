import { describe, expect, it } from 'vitest'
import { HANDBOOK_DRAWS, HANDBOOK_ENTRY_STATUSES, HANDBOOK_EVIDENCE, HANDBOOK_OUTCOME_EVIDENCE, HANDBOOK_USAGE_KINDS, type HandbookUsageRecord } from '@nexgent/kernel'
import { learningSchema, validateLearningFile } from '../src/index.js'

/** ADR 0023: `usage.jsonl` lines (exposure and outcome) through `learning.v1.schema.json`. */
type Defs = Record<string, Record<string, unknown>>
const TS = '2026-10-17T00:00:00.000Z'
const P = 'b'.repeat(64)
const E = '11111111-1111-4111-8111-111111111111'
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const lines = ((learningSchema.$defs as Defs)['handbookUsage']?.['oneOf'] as Defs[]).map(def => def['properties'] as Defs)

describe('handbook usage lines (ADR 0023)', () => {
  it('every enum equals its kernel constant', () => {
    expect(lines.map(line => line['kind']?.['const'])).toEqual([...HANDBOOK_USAGE_KINDS])
    expect(lines[1]?.['draw']).toEqual({ enum: [...HANDBOOK_DRAWS] })
    expect(lines[1]?.['status']).toEqual({ enum: HANDBOOK_ENTRY_STATUSES.filter(status => status !== 'retired') })
    expect(lines[1]?.['showProbability']).toEqual({ enum: [HANDBOOK_EVIDENCE.trialShowProbability, HANDBOOK_EVIDENCE.activeShowProbability] })
    expect((lines[2]?.['evidence'] as Defs)['items']).toEqual({ enum: [...HANDBOOK_OUTCOME_EVIDENCE] })
  })

  it('round-trip, and lines written before ADR 0023 still read', () => {
    const records: HandbookUsageRecord[] = [
      { formatVersion: 1, kind: 'turn', at: TS, projectId: P, sessionId: 's1' },
      { formatVersion: 1, kind: 'hit', at: TS, projectId: P, sessionId: 's1', entryId: E, given: true },
      { formatVersion: 1, kind: 'hit', at: TS, projectId: P, sessionId: 's1', entryId: E, given: false, taskId: 't1', status: 'trial', draw: 'held-back', showProbability: 0.5 },
      { formatVersion: 1, kind: 'hit', at: TS, projectId: P, sessionId: 's1', entryId: E, given: true, status: 'active', draw: 'shown', showProbability: 0.9 },
      { formatVersion: 1, kind: 'outcome', at: TS, projectId: P, sessionId: 's1', taskId: 't1', score: 0.75, evidence: ['check', 'user-rating'], userNegative: false },
    ]
    for (const record of records) expect(validateLearningFile('handbookUsage', plain(record)), record.kind).toEqual([])
  })

  it('rejects self-evaluation as evidence and malformed lines', () => {
    const outcome = { formatVersion: 1, kind: 'outcome', at: TS, projectId: P, sessionId: 's1', taskId: 't1', score: 0.5, evidence: ['check'] }
    const hit = { formatVersion: 1, kind: 'hit', at: TS, projectId: P, sessionId: 's1', entryId: E, given: true }
    const bad: unknown[] = [
      { ...outcome, evidence: ['self-eval'] },
      { ...outcome, evidence: [] },
      { ...outcome, score: -0.1 },
      { ...outcome, taskId: undefined },
      { ...hit, draw: 'maybe' },
      { ...hit, showProbability: 0.3 },
      { ...hit, status: 'retired' },
      { ...hit, extra: 1 },
      { ...hit, kind: 'exposure' },
    ]
    for (const line of bad) expect(validateLearningFile('handbookUsage', plain(line)), JSON.stringify(line)).not.toEqual([])
  })
})
