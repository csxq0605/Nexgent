import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  HANDBOOK_DRAWS,
  HANDBOOK_EVIDENCE,
  HANDBOOK_OUTCOME_EVIDENCE,
  HANDBOOK_USAGE_KINDS,
  HANDBOOK_USER_EVIDENCE,
  handbookExposureEvidence,
  handbookStatusFromEvidence,
  type HandbookDraw,
  type HandbookExposureEvidence,
  type HandbookOutcomeEvidence,
  type HandbookUsageKind,
  type HandbookUsageRecord,
} from '../../src/index.js'

/** ADR 0023: randomized exposure and outcomes decide whether an entry helps. */
const TS = '2026-10-17T00:00:00.000Z'
const P = 'a'.repeat(64)
const E = '11111111-1111-4111-8111-111111111111'
const hit = (sessionId: string, draw?: HandbookDraw, entryId = E): HandbookUsageRecord => ({
  formatVersion: 1, kind: 'hit', at: TS, projectId: P, sessionId, entryId, given: draw !== 'held-back',
  ...(draw === undefined ? {} : { draw, showProbability: HANDBOOK_EVIDENCE.trialShowProbability, status: 'trial' as const }),
})
const outcome = (sessionId: string, score: number, extra: Partial<Extract<HandbookUsageRecord, { kind: 'outcome' }>> = {}): HandbookUsageRecord => ({
  formatVersion: 1, kind: 'outcome', at: TS, projectId: P, sessionId, taskId: `t-${sessionId}`, score, evidence: ['check'], ...extra,
})
const arms = (shown: readonly number[], held: readonly number[]): HandbookUsageRecord[] => [
  ...shown.flatMap((score, i) => [hit(`s${i}`, 'shown'), outcome(`s${i}`, score)]),
  ...held.flatMap((score, i) => [hit(`h${i}`, 'held-back'), outcome(`h${i}`, score)]),
]
const ev = (e: Partial<HandbookExposureEvidence>): HandbookExposureEvidence => ({ shown: 0, heldBack: 0, userNegative: false, ...e })

describe('handbook evidence (ADR 0023)', () => {
  it('constants and vocabularies match their types', () => {
    expect(HANDBOOK_EVIDENCE).toMatchObject({ trialShowProbability: 0.5, maxTrialPerTask: 1, maxActivePerTask: 4, activateMinPerArm: 3, retireMinShown: 4, retireMargin: 0.1 })
    expectTypeOf<(typeof HANDBOOK_DRAWS)[number]>().toEqualTypeOf<HandbookDraw>()
    expectTypeOf<(typeof HANDBOOK_OUTCOME_EVIDENCE)[number]>().toEqualTypeOf<HandbookOutcomeEvidence>()
    expectTypeOf<(typeof HANDBOOK_USAGE_KINDS)[number]>().toEqualTypeOf<HandbookUsageKind>()
    expect(new Set(HANDBOOK_DRAWS).size).toBe(2)
    expect(HANDBOOK_USAGE_KINDS).toEqual(['turn', 'hit', 'outcome'])
    for (const kind of HANDBOOK_USER_EVIDENCE) expect(HANDBOOK_OUTCOME_EVIDENCE).toContain(kind)
    // The same model's self-evaluation is not outcome evidence.
    expect(HANDBOOK_OUTCOME_EVIDENCE.some(kind => /self|model|vote/.test(kind))).toBe(false)
  })

  it('counts only drawn hits with a known outcome, once per session, last outcome wins', () => {
    const records: HandbookUsageRecord[] = [
      hit('old'), outcome('old', 1), // pre-ADR line: no draw, not evidence
      hit('a', 'shown'), hit('a', 'shown'), outcome('a', 0.2), outcome('a', 0.8),
      hit('b', 'held-back'), outcome('b', 0.4),
      hit('c', 'shown'), // no outcome yet: unknown
      hit('d', 'shown', '22222222-2222-4222-8222-222222222222'), outcome('d', 0),
      outcome('e', 1, { evidence: [] }),
    ]
    expect(handbookExposureEvidence(E, records)).toEqual({ shown: 1, heldBack: 1, shownMean: 0.8, heldBackMean: 0.4, userNegative: false })
    expect(handbookExposureEvidence(E, [])).toEqual({ shown: 0, heldBack: 0, userNegative: false })
    expect(handbookExposureEvidence(E, [hit('x', 'shown'), outcome('x', 0.9, { evidence: ['user-rating'], userNegative: true })]).userNegative).toBe(true)
    expect(handbookExposureEvidence(E, [hit('x', 'held-back'), outcome('x', 0.9, { userNegative: true })]).userNegative).toBe(false)
  })

  it('enables a trial entry only on enough randomized evidence, never on votes', () => {
    const trial = { status: 'trial' as const }
    expect(handbookStatusFromEvidence(trial, handbookExposureEvidence(E, arms([1, 1, 1], [0.5, 0.5, 0.5])))).toBe('active')
    expect(handbookStatusFromEvidence(trial, handbookExposureEvidence(E, arms([1, 1, 1], [0.5, 0.5])))).toBe('trial')
    expect(handbookStatusFromEvidence(trial, handbookExposureEvidence(E, arms([0.5, 0.5, 0.5], [0.5, 0.5, 0.5])))).toBe('active')
    expect(handbookStatusFromEvidence(trial, handbookExposureEvidence(E, arms([0.4, 0.5, 0.5], [0.5, 0.5, 0.5])))).toBe('trial')
    expect(handbookStatusFromEvidence(trial, ev({}))).toBe('trial')
  })

  it('retires on a user signal, on doing worse, or when superseded; the model can only demote', () => {
    expect(handbookStatusFromEvidence({ status: 'active' }, ev({ shown: 1, shownMean: 1, userNegative: true }))).toBe('retired')
    expect(handbookStatusFromEvidence({ status: 'active' }, handbookExposureEvidence(E, arms([0.5, 0.5, 0.5, 0.5], [0.7])))).toBe('retired')
    expect(handbookStatusFromEvidence({ status: 'active' }, handbookExposureEvidence(E, arms([0.5, 0.5, 0.5], [0.7])))).toBe('active')
    expect(handbookStatusFromEvidence({ status: 'active' }, handbookExposureEvidence(E, arms([0.65, 0.65, 0.65, 0.65], [0.7])))).toBe('active')
    expect(handbookStatusFromEvidence({ status: 'trial', supersededBy: E }, ev({}))).toBe('retired')
    expect(handbookStatusFromEvidence({ status: 'retired' }, handbookExposureEvidence(E, arms([1, 1, 1], [0, 0, 0])))).toBe('retired')
    expect(handbookStatusFromEvidence({ status: 'active' }, ev({}), true)).toBe('trial')
    expect(handbookStatusFromEvidence({ status: 'trial' }, ev({}), true)).toBe('trial')
  })
})
