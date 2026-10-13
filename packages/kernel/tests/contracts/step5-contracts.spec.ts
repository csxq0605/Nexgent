import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  assertImprovementConfig,
  batchTrigger,
  canMoveImprovement,
  CANDIDATE_ORIGINS,
  countSignal,
  decideTrial,
  DEFAULT_IMPROVEMENT_CONFIG,
  DEFAULT_PROJECT_CONFIG,
  emptyImprovementQueue,
  GUARDED_PROJECT_CONFIG_FIELDS,
  IMPROVE_REPORT_DIAGNOSIS_TOOL,
  IMPROVEMENT_ACTIVE_STATUSES,
  IMPROVEMENT_DIAGNOSIS_TOOLS,
  IMPROVEMENT_FINAL_STATUSES,
  IMPROVEMENT_LIMITS,
  IMPROVEMENT_PARKED_STATUSES,
  IMPROVEMENT_PHASES,
  IMPROVEMENT_STATUSES,
  IMPROVEMENT_TRANSITIONS,
  isCountedFeedback,
  isFinalImprovementStatus,
  LEDGER_RECORD_TYPES,
  MEMBER_DENIED_TOOLS,
  NexgentError,
  perTurnFileName,
  releaseJobSlot,
  resolveImprovementConfig,
  resolveProjectConfig,
  SESSION_PURPOSES,
  signalKey,
  STEP4_TOOLS,
  takeBatch,
  TRIAL_RECEIPT_TYPES,
  validateJsonSchema,
  type CandidateRecord,
  type ImprovementEndRecord,
  type ImprovementQueue,
  type ImprovementSignal,
  type LedgerAttribution,
  type SessionStartRecord,
  type TrialReceipt,
  type TrialTally,
} from '../../src/index.js'

const AT = '2026-10-13T08:00:00.000Z'
const feedback = (id: string): ImprovementSignal => ({ kind: 'feedback', feedbackId: id, sessionId: 's1', deliverableId: 'd1', at: AT })
const check = (turn: number): ImprovementSignal => ({ kind: 'check-failure', taskId: 't1', sessionId: 's1', turn, at: AT })

describe('step-5 trigger counting', () => {
  it('counts ratings of 3 or less and comments without a rating, never 4–5', () => {
    expect(isCountedFeedback({})).toBe(true)
    expect(([1, 2, 3] as const).map(rating => isCountedFeedback({ rating }))).toEqual([true, true, true])
    expect(([4, 5] as const).map(rating => isCountedFeedback({ rating }))).toEqual([false, false])
  })

  it('keys a signal once: feedback by id, a failed check by task and turn', () => {
    expect(signalKey(feedback('f1'))).toBe('feedback:f1')
    expect(signalKey(check(2))).toBe('check:t1:2')
  })

  it('counts a key once, never before since, and takes a batch only when the slot is free', () => {
    const since = '2026-10-13T07:00:00.000Z'
    let queue = emptyImprovementQueue(since)
    expect(countSignal(queue, { ...feedback('old'), at: '2026-10-12T00:00:00.000Z' })).toEqual({ queue, counted: false })
    let step = countSignal(queue, feedback('f1'))
    expect(step.counted).toBe(true)
    queue = step.queue
    expect(countSignal(queue, feedback('f1'))).toEqual({ queue, counted: false })
    queue = countSignal(queue, check(1)).queue
    expect(takeBatch(queue, 3)).toEqual({ queue })
    queue = countSignal(queue, feedback('f2')).queue
    const taken = takeBatch(queue, 3)
    expect(taken.batch?.map(signalKey)).toEqual(['feedback:f1', 'check:t1:1', 'feedback:f2'])
    expect(taken.queue).toEqual({ formatVersion: 1, since, counted: ['feedback:f1', 'check:t1:1', 'feedback:f2'], pending: [] })

    // decision 8: one job per project; signals arriving meanwhile go to the next batch
    queue = { ...taken.queue, activeJobId: 'job-1' }
    for (const id of ['f3', 'f4', 'f5']) queue = countSignal(queue, feedback(id)).queue
    expect(takeBatch(queue, 3)).toEqual({ queue })
    expect(releaseJobSlot(queue, 'job-2')).toBe(queue)
    const released = releaseJobSlot(queue, 'job-1')
    expect(released).not.toHaveProperty('activeJobId')
    expect(takeBatch(released, 3).batch?.map(signalKey)).toEqual(['feedback:f3', 'feedback:f4', 'feedback:f5'])
    // an explicit "improve" takes whatever is pending, even nothing
    expect(takeBatch(emptyImprovementQueue(since), 0)).toEqual({ queue: emptyImprovementQueue(since), batch: [] })
  })

  it('keeps at most maxPendingSignals pending, never forgetting a counted key', () => {
    let queue: ImprovementQueue = { ...emptyImprovementQueue(AT), activeJobId: 'job-1' }
    for (let index = 0; index < IMPROVEMENT_LIMITS.maxPendingSignals + 5; index += 1) queue = countSignal(queue, feedback(`f${index}`)).queue
    expect(queue.pending).toHaveLength(IMPROVEMENT_LIMITS.maxPendingSignals)
    expect(queue.counted).toHaveLength(IMPROVEMENT_LIMITS.maxPendingSignals + 5)
  })

  it('names a batch of failed checks only check-failure', () => {
    expect(batchTrigger([check(1), check(2)])).toBe('check-failure')
    expect(batchTrigger([check(1), feedback('f1')])).toBe('feedback-count')
    expect(batchTrigger([])).toBe('feedback-count')
  })
})

describe('step-5 job states', () => {
  it('splits statuses into active (slot held), parked and final', () => {
    expect([...IMPROVEMENT_ACTIVE_STATUSES, ...IMPROVEMENT_PARKED_STATUSES, ...IMPROVEMENT_FINAL_STATUSES].sort()).toEqual([...IMPROVEMENT_STATUSES].sort())
    expect(IMPROVEMENT_PARKED_STATUSES).toEqual(['waiting-history', 'awaiting-approval'])
    expect(isFinalImprovementStatus('waiting-history')).toBe(false)
    expect(isFinalImprovementStatus('awaiting-approval')).toBe(false)
    expect(Object.keys(IMPROVEMENT_TRANSITIONS).sort()).toEqual([...IMPROVEMENT_STATUSES].sort())
    // step 6 appends the meta phases
    expect(IMPROVEMENT_PHASES).toEqual(['diagnose', 'propose', 'trial', 'meta-diagnose', 'meta-propose'])
  })

  it('allows the lifecycle moves and the four exits, nothing out of a final status', () => {
    expect(canMoveImprovement('queued', 'diagnosing')).toBe(true)
    expect(canMoveImprovement('diagnosing', 'no-proposal')).toBe(true)
    expect(canMoveImprovement('proposing', 'no-proposal')).toBe(true)
    expect(canMoveImprovement('trialing', 'waiting-history')).toBe(true)
    expect(canMoveImprovement('waiting-history', 'trialing')).toBe(true)
    expect(canMoveImprovement('awaiting-approval', 'adopted')).toBe(true)
    expect(canMoveImprovement('awaiting-approval', 'cancelled')).toBe(false)
    expect(canMoveImprovement('waiting-history', 'budget-exhausted')).toBe(false)
    expect(canMoveImprovement('queued', 'trialing')).toBe(false)
    for (const exit of ['failed', 'interrupted', 'budget-exhausted', 'cancelled'] as const) expect(canMoveImprovement('proposing', exit)).toBe(true)
    for (const final of IMPROVEMENT_FINAL_STATUSES) expect(canMoveImprovement(final, 'failed')).toBe(false)
  })
})

describe('step-5 diagnosis tools', () => {
  it('gives the diagnose session four read-only tools that members never see', () => {
    expect(IMPROVEMENT_DIAGNOSIS_TOOLS.map(tool => tool.name)).toEqual(['improve_read_session', 'improve_read_ledger', 'improve_list_feedback', 'improve_report_diagnosis'])
    for (const tool of IMPROVEMENT_DIAGNOSIS_TOOLS) {
      expect(tool.effects).toEqual(['read'])
      expect(tool.approval).toBe('never')
      expect(MEMBER_DENIED_TOOLS).toContain(tool.name)
      expect(STEP4_TOOLS.map(step4 => step4.name)).not.toContain(tool.name)
    }
  })

  it('validates a diagnosis report', () => {
    const report = {
      failureTypes: [{ category: 'task-verification', label: 'missed the region column', evidence: [{ sessionId: 's1', seq: 12, turn: 1 }] }],
      involved: { members: ['main'], tools: ['write_spreadsheet'], skills: [], components: [{ kind: 'skill', name: 'monthly-order-summary' }] },
      hypothesis: 'No step checks that every requested column exists.',
      proposalKind: 'skill',
    }
    const schema = IMPROVE_REPORT_DIAGNOSIS_TOOL.inputSchema
    expect(validateJsonSchema(report, schema)).toBeUndefined()
    expect(validateJsonSchema({ ...report, proposalKind: 'none' }, schema)).toBeUndefined()
    expect(validateJsonSchema({ ...report, proposalKind: 'magic' }, schema)).toBeDefined()
    expect(validateJsonSchema({ ...report, failureTypes: [{ ...report.failureTypes[0], category: 'other' }] }, schema)).toBeDefined()
    expect(validateJsonSchema({ ...report, hypothesis: 'x'.repeat(IMPROVEMENT_LIMITS.maxHypothesisChars + 1) }, schema)).toBeDefined()
    expect(validateJsonSchema({ ...report, extra: 1 }, schema)).toBeDefined()
  })
})

describe('step-5 feedback check in the adoption rule (ADR 0006)', () => {
  const arm = (passed: number, failed: number, unknown = 0) => ({ passed, failed, unknown })
  const tally = (overrides: Partial<TrialTally> = {}): TrialTally => ({
    selection: { candidate: arm(2, 2), baseline: arm(2, 2) },
    guard: { candidate: arm(2, 0), baseline: arm(2, 0) },
    review: { candidate: 0, baseline: 0, tie: 0 },
    tokens: { candidate: 1000, baseline: 1000 },
    budgetExhausted: false,
    requiresApproval: false,
    ...overrides,
  })

  it('without feedback the step-4 verdict is unchanged', () => {
    expect(decideTrial(tally(), 1.2)).not.toHaveProperty('feedbackPassRate')
  })

  it('counts each feedback check as one more run of its arm and reports it separately', () => {
    const verdict = decideTrial(tally({ feedback: { candidate: arm(2, 0), baseline: arm(0, 2) } }), 1.2)
    expect(verdict).toMatchObject({ outcome: 'adopt', reason: 'quality-up', passRate: { candidate: 4 / 6, baseline: 2 / 6 }, feedbackPassRate: { candidate: 1, baseline: 0 } })
    expect(decideTrial(tally({ feedback: { candidate: arm(0, 2), baseline: arm(2, 0) } }), 1.2)).toMatchObject({ outcome: 'reject', reason: 'quality-down' })
  })

  it('an unknown feedback check rejects like an unknown run', () => {
    expect(decideTrial(tally({ feedback: { candidate: arm(1, 0, 1), baseline: arm(0, 2) } }), 1.2)).toMatchObject({ outcome: 'reject', reason: 'unknown-runs' })
  })
})

describe('step-5 record and file additions', () => {
  it('adds trial.feedback receipts, improvement.end ledger records and session purposes', () => {
    expect(TRIAL_RECEIPT_TYPES).toContain('trial.feedback')
    expect(LEDGER_RECORD_TYPES).toContain('improvement.end')
    expect(SESSION_PURPOSES).toEqual(['task', 'improvement'])
    expect(CANDIDATE_ORIGINS).toEqual(['session', 'improvement'])
    expectTypeOf<Extract<TrialReceipt, { type: 'trial.feedback' }>['status']>().toEqualTypeOf<'pass' | 'fail' | 'unknown'>()
    expectTypeOf<NonNullable<ImprovementEndRecord['phases']['trial']>['requestCount']>().toBeNumber()
    // step 6 adds the two phases a meta job runs itself
    expectTypeOf<LedgerAttribution['improvementPhase']>().toEqualTypeOf<'diagnose' | 'propose' | 'trial' | 'meta-diagnose' | 'meta-propose' | undefined>()
    expectTypeOf<NonNullable<SessionStartRecord['improvement']>['phase']>().toEqualTypeOf<'diagnose' | 'propose' | 'meta-diagnose' | 'meta-propose'>()
    expectTypeOf<CandidateRecord['origin']>().toEqualTypeOf<'session' | 'improvement' | undefined>()
  })

  it('names per-turn snapshot and checks files', () => {
    expect(perTurnFileName('t1', 2)).toBe('t1.t2.json')
    expect(() => perTurnFileName('t1', 0)).toThrow(NexgentError)
    expect(() => perTurnFileName('t1', 1.5)).toThrow(NexgentError)
  })
})

describe('step-5 settings', () => {
  it('turns autoImprove on by default and guards it with the improvement settings', () => {
    expect(DEFAULT_PROJECT_CONFIG.autoImprove).toBe(true)
    expect(DEFAULT_PROJECT_CONFIG.improvement).toEqual(DEFAULT_IMPROVEMENT_CONFIG)
    // step 6 adds `meta` (off by default)
    expect(DEFAULT_IMPROVEMENT_CONFIG).toMatchObject({ feedbackThreshold: 3, budget: { maxTokens: 3_000_000, windowDays: 30 }, model: 'claude-sonnet-5-5', thinking: 'on' })
    expect(GUARDED_PROJECT_CONFIG_FIELDS).toEqual(expect.arrayContaining(['autoImprove', 'improvement']))
    expect(resolveProjectConfig({ autoImprove: false, improvement: { budget: { windowDays: 7 } } })).toMatchObject({
      autoImprove: false,
      improvement: { feedbackThreshold: 3, budget: { maxTokens: 3_000_000, windowDays: 7 } },
    })
    expect(resolveImprovementConfig({ model: 'claude-opus-5-5' }).model).toBe('claude-opus-5-5')
  })

  it('rejects unknown or out-of-range improvement fields, naming the field', () => {
    expect(() => assertImprovementConfig({ feedbackThreshold: 5, budget: { maxTokens: 10, windowDays: 30 }, model: 'claude-opus-5-5', thinking: 'off' })).not.toThrow()
    const field = (value: unknown) => {
      try {
        assertImprovementConfig(value)
      } catch (error) {
        expect(error).toBeInstanceOf(NexgentError)
        expect((error as NexgentError).code).toBe('config/invalid')
        return (error as NexgentError).details?.['field']
      }
      return undefined
    }
    expect(field([])).toBe('improvement')
    expect(field({ feedbackThreshold: 0 })).toBe('improvement.feedbackThreshold')
    expect(field({ feedbackThreshold: 21 })).toBe('improvement.feedbackThreshold')
    expect(field({ budget: { maxTokens: 0 } })).toBe('improvement.budget.maxTokens')
    expect(field({ budget: { windowDays: 366 } })).toBe('improvement.budget.windowDays')
    expect(field({ budget: { usd: 3 } })).toBe('improvement.budget.usd')
    expect(field({ model: ' ' })).toBe('improvement.model')
    expect(field({ thinking: 'maybe' })).toBe('improvement.thinking')
    expect(field({ autoStart: true })).toBe('improvement.autoStart')
  })
})
