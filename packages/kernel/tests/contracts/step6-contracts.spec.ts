import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  applyImproverChange,
  assertImprovementConfig,
  assertImproverBundle,
  canMoveJob,
  canonicalEvaluatorText,
  canonicalImproverText,
  checkImproverChange,
  countFinishedJob,
  decideImprover,
  DEFAULT_CAPABILITIES_CONFIG,
  DEFAULT_IMPROVEMENT_CONFIG,
  effectiveTrialCounts,
  emptyImprovementQueue,
  EVALUATOR_FIELDS,
  evaluatorSettings,
  IMPROVE_PROPOSE_CHANGE_TOOL,
  IMPROVEMENT_ACTIVE_STATUSES,
  IMPROVEMENT_COST_PHASES,
  IMPROVEMENT_FILES,
  IMPROVEMENT_STATUSES,
  IMPROVEMENT_TRANSITIONS,
  IMPROVEMENT_TRIGGERS,
  IMPROVER_LIMITS,
  IMPROVER_V0,
  IMPROVER_V0_VERSION,
  IMPROVER_VERSION_PATTERN,
  improverProblems,
  INITIAL_IMPROVER_ACTIVATION,
  isImproverV0,
  isNextImproverRevision,
  jobFeedbackIds,
  jobPhaseTimes,
  MEMBER_DENIED_TOOLS,
  META_COUNTED_STATUSES,
  META_DIAGNOSIS_TOOLS,
  META_JOB_STATUSES,
  META_PROPOSE_TOOLS,
  NexgentError,
  PROPOSABLE_KINDS,
  renderDiagnosisPolicy,
  renderImproverText,
  resolveImprovementConfig,
  statusesOfKind,
  takeMetaBatch,
  validateJsonSchema,
  type ComparisonArmResult,
  type ComparisonOrigin,
  type ImprovementEndRecord,
  type ImprovementJob,
  type ImprovementPhase,
  type ImproverBundle,
  type ImproverRevision,
  type LedgerAttribution,
  type SessionImprovement,
  type TrialPlan,
  type TrialVerdict,
  UNKNOWN_USAGE,
} from '../../src/index.js'

const TS = '2026-10-13T00:00:00.000Z'
const SHA = (c: string) => c.repeat(64)

describe('step-6 improver bundle', () => {
  it('v0 is valid, named v0 by content, and carries step 5\'s parameters', () => {
    expect(improverProblems(IMPROVER_V0)).toEqual([])
    expect(() => assertImproverBundle(IMPROVER_V0)).not.toThrow()
    expect(isImproverV0(JSON.parse(JSON.stringify(IMPROVER_V0)) as ImproverBundle)).toBe(true)
    expect(IMPROVER_V0_VERSION).toMatch(IMPROVER_VERSION_PATTERN)
    expect(SHA('a')).toMatch(IMPROVER_VERSION_PATTERN)
    expect('baseline').not.toMatch(IMPROVER_VERSION_PATTERN)
    expect(IMPROVER_V0.comparison).toEqual({ selectionCases: DEFAULT_CAPABILITIES_CONFIG.selectionCases, repeats: DEFAULT_CAPABILITIES_CONFIG.repeats, selection: 'similarity' })
    expect(IMPROVER_V0.proposal.kinds).not.toContain('plugin')
    expect([...IMPROVER_V0.proposal.kinds].sort()).toEqual([...PROPOSABLE_KINDS].sort())
    // v0's policy has no placeholder, so it renders to its paragraphs joined by newlines
    expect(renderDiagnosisPolicy(IMPROVER_V0)).toBe(IMPROVER_V0.diagnosis.paragraphs.join('\n'))
  })

  it('canonical text ignores key order but keeps paragraph and kind order', () => {
    const shuffled = { comparison: { selection: 'similarity', repeats: 2, selectionCases: 2 }, proposal: { briefs: IMPROVER_V0.proposal.briefs, kinds: IMPROVER_V0.proposal.kinds }, diagnosis: IMPROVER_V0.diagnosis, formatVersion: 1 } as unknown as ImproverBundle
    expect(canonicalImproverText(shuffled)).toBe(canonicalImproverText(IMPROVER_V0))
    const reordered: ImproverBundle = { ...IMPROVER_V0, proposal: { ...IMPROVER_V0.proposal, kinds: [...IMPROVER_V0.proposal.kinds].reverse() } }
    expect(canonicalImproverText(reordered)).not.toBe(canonicalImproverText(IMPROVER_V0))
    expect(isImproverV0(reordered)).toBe(false)
  })

  it('renders placeholders in one pass and drops a line whose only placeholder is empty', () => {
    expect(renderImproverText('a {{kind}}\n{{failures}}\nb', { kind: 'skill', failures: '' })).toBe('a skill\nb')
    expect(renderImproverText('{{hypothesis}}', { hypothesis: 'x {{kind}}' })).toBe('x {{kind}}')
    expect(renderImproverText('{sessionId, seq}', {})).toBe('{sessionId, seq}')
    expect(() => renderImproverText('{{jobId}}', {})).toThrow(NexgentError)
    const prefer = { ...IMPROVER_V0, diagnosis: { paragraphs: [...IMPROVER_V0.diagnosis.paragraphs, 'Prefer, in order: {{allowedKinds}}.'] } }
    expect(renderDiagnosisPolicy(prefer).split('\n').at(-1)).toBe(`Prefer, in order: ${IMPROVER_V0.proposal.kinds.join(', ')}.`)
  })

  it('refuses malformed bundles with improver/invalid', () => {
    const bad: unknown[] = [
      { ...IMPROVER_V0, formatVersion: 2 },
      { ...IMPROVER_V0, extra: 1 },
      { ...IMPROVER_V0, diagnosis: { paragraphs: [] } },
      { ...IMPROVER_V0, diagnosis: { paragraphs: ['two\nlines'] } },
      { ...IMPROVER_V0, diagnosis: { paragraphs: ['x'.repeat(IMPROVER_LIMITS.maxParagraphChars + 1)] } },
      { ...IMPROVER_V0, diagnosis: { paragraphs: ['uses {{jobId}}'] } },
      { ...IMPROVER_V0, proposal: { ...IMPROVER_V0.proposal, kinds: ['plugin'] } },
      { ...IMPROVER_V0, proposal: { ...IMPROVER_V0.proposal, kinds: ['skill', 'skill'] } },
      { ...IMPROVER_V0, proposal: { kinds: ['skill'], briefs: {} } },
      { ...IMPROVER_V0, proposal: { kinds: ['skill'], briefs: { skill: 'uses {{allowedKinds}}' } } },
      { ...IMPROVER_V0, comparison: { ...IMPROVER_V0.comparison, selectionCases: 5 } },
      { ...IMPROVER_V0, comparison: { ...IMPROVER_V0.comparison, repeats: 1 } },
      { ...IMPROVER_V0, comparison: { ...IMPROVER_V0.comparison, selection: 'random' } },
      { ...IMPROVER_V0, comparison: { ...IMPROVER_V0.comparison, costRatioCap: 5 } },
    ]
    for (const value of bad) {
      expect(improverProblems(value), JSON.stringify(value).slice(0, 80)).not.toEqual([])
      expect(() => assertImproverBundle(value)).toThrow(expect.objectContaining({ code: 'improver/invalid' }))
    }
  })

  it('the project floor wins over a smaller improver count', () => {
    expect(effectiveTrialCounts(DEFAULT_CAPABILITIES_CONFIG, IMPROVER_V0)).toEqual({ selectionCases: 2, repeats: 2 })
    expect(effectiveTrialCounts({ selectionCases: 5, repeats: 2 }, { ...IMPROVER_V0, comparison: { ...IMPROVER_V0.comparison, selectionCases: 3, repeats: 3 } })).toEqual({ selectionCases: 5, repeats: 3 })
  })
})

describe('step-6 improver changes', () => {
  it('accepts exactly one typed change within bounds', () => {
    const cases: [unknown, (child: ImproverBundle) => unknown, unknown][] = [
      [{ op: 'set-diagnosis-paragraph', index: 7, text: 'Read the failed checks first.' }, child => child.diagnosis.paragraphs.length, 8],
      [{ op: 'set-diagnosis-paragraph', index: 0, text: 'Rewritten.' }, child => child.diagnosis.paragraphs[0], 'Rewritten.'],
      [{ op: 'set-proposal-kinds', kinds: ['context-policy', 'skill'] }, child => child.proposal.kinds, ['context-policy', 'skill']],
      [{ op: 'set-proposal-brief', kind: 'skill', template: 'Build a {{kind}} for job {{jobId}}.' }, child => child.proposal.briefs.skill, 'Build a {{kind}} for job {{jobId}}.'],
      [{ op: 'set-comparison-param', param: 'selectionCases', value: 4 }, child => child.comparison.selectionCases, 4],
      [{ op: 'set-comparison-param', param: 'repeats', value: 3 }, child => child.comparison.repeats, 3],
      [{ op: 'set-comparison-param', param: 'selection', value: 'recency' }, child => child.comparison.selection, 'recency'],
    ]
    for (const [input, read, expected] of cases) {
      const check = checkImproverChange(IMPROVER_V0, input)
      expect(check.ok, JSON.stringify(input)).toBe(true)
      if (!check.ok) continue
      expect(read(check.child)).toEqual(expected)
      expect(applyImproverChange(IMPROVER_V0, check.change)).toEqual(check.child)
      expect(improverProblems(check.child)).toEqual([])
    }
    // the parent is never mutated
    expect(isImproverV0(IMPROVER_V0)).toBe(true)
  })

  it('refuses evaluator fields, out-of-bounds values, more than one change and no-ops', () => {
    const refused: [unknown, string][] = [
      [{ op: 'set-comparison-param', param: 'costRatioCap', value: 5 }, 'evaluator-field'],
      [{ op: 'set-comparison-param', param: 'guardCases', value: 0 }, 'evaluator-field'],
      [{ op: 'set-proposal-brief', kind: 'skill', template: 'x', reviewer: { model: 'm' } }, 'evaluator-field'],
      [{ op: 'set-comparison-param', param: 'selectionCases', value: 5 }, 'out-of-bounds'],
      [{ op: 'set-comparison-param', param: 'selectionCases', value: 1 }, 'out-of-bounds'],
      [{ op: 'set-comparison-param', param: 'repeats', value: 4 }, 'out-of-bounds'],
      [{ op: 'set-comparison-param', param: 'selection', value: 'random' }, 'out-of-bounds'],
      [{ op: 'set-diagnosis-paragraph', index: 9, text: 'gap' }, 'out-of-bounds'],
      [[{ op: 'set-proposal-kinds', kinds: ['skill'] }, { op: 'set-comparison-param', param: 'repeats', value: 3 }], 'not-one-change'],
      [{ op: 'set-proposal-kinds', kinds: ['skill'], param: 'repeats', value: 3 }, 'not-one-change'],
      [{ op: 'set-proposal-kinds', kinds: ['plugin'] }, 'invalid'],
      [{ op: 'set-proposal-brief', kind: 'plugin', template: 'x' }, 'invalid'],
      [{ op: 'set-proposal-brief', kind: 'skill', template: 'uses {{nothing}}' }, 'invalid'],
      [{ op: 'set-diagnosis-paragraph', index: 0, text: '' }, 'invalid'],
      [{ op: 'rewrite-code', code: 'x' }, 'invalid'],
      [{ op: 'set-comparison-param', param: 'repeats', value: 2 }, 'no-op'],
      ['set repeats to 3', 'invalid'],
    ]
    for (const [input, refusal] of refused) {
      const check = checkImproverChange(IMPROVER_V0, input)
      expect(check, JSON.stringify(input)).toMatchObject({ ok: false, refusal })
    }
    expect(EVALUATOR_FIELDS).toEqual(expect.arrayContaining(['costRatioCap', 'costApprovalRatio', 'guardCases', 'reviewer', 'autoImprove', 'improvement']))
  })

  it('the propose tool takes one change object and its schema is valid', () => {
    const schema = IMPROVE_PROPOSE_CHANGE_TOOL.inputSchema
    expect(validateJsonSchema({ change: { op: 'set-comparison-param', param: 'repeats', value: 3 }, rationale: '重复次数不够' }, schema)).toBeUndefined()
    expect(validateJsonSchema({ change: { op: 'set-proposal-kinds', kinds: ['skill'] }, rationale: 'r' }, schema)).toBeUndefined()
    expect(validateJsonSchema({ change: { op: 'rewrite-code' }, rationale: 'r' }, schema)).toBeDefined()
    expect(validateJsonSchema({ change: { op: 'set-proposal-kinds', kinds: ['skill'] } }, schema)).toMatch(/required/)
    for (const tool of [...META_DIAGNOSIS_TOOLS, ...META_PROPOSE_TOOLS]) {
      expect(tool.inputSchema, tool.name).toMatchObject({ type: 'object' })
      expect(tool.effects).toEqual(['read'])
      expect(tool.approval).toBe('never')
      expect(MEMBER_DENIED_TOOLS).toContain(tool.name)
    }
    // meta sessions get no file, command or capability tool
    expect([...META_DIAGNOSIS_TOOLS, ...META_PROPOSE_TOOLS].every(tool => tool.name.startsWith('improve_'))).toBe(true)
    expect(META_PROPOSE_TOOLS.map(tool => tool.name)).not.toContain('improve_report_diagnosis')
  })
})

describe('step-6 improver activation chain', () => {
  const adopt: ImproverRevision = { format: 1, revision: 1, previous: null, from: 'v0', version: SHA('b'), type: 'adopt', trigger: 'meta-job', jobId: '00000000-0000-4000-8000-000000000001', committedAt: TS }
  it('starts at v0 and follows compare-and-publish', () => {
    expect(INITIAL_IMPROVER_ACTIVATION).toEqual({ revision: 0, digest: null, version: 'v0' })
    expect(isNextImproverRevision(INITIAL_IMPROVER_ACTIVATION, adopt)).toBe(true)
    expect(isNextImproverRevision(INITIAL_IMPROVER_ACTIVATION, { ...adopt, revision: 2 })).toBe(false)
    expect(isNextImproverRevision(INITIAL_IMPROVER_ACTIVATION, { ...adopt, version: 'v0' })).toBe(false)
    expect(isNextImproverRevision(INITIAL_IMPROVER_ACTIVATION, { ...adopt, trigger: 'manual' })).toBe(false)
    const { jobId: _jobId, ...noJob } = adopt
    expect(isNextImproverRevision(INITIAL_IMPROVER_ACTIVATION, noJob)).toBe(false)
    const state = { revision: 1, digest: SHA('c'), version: SHA('b') }
    const rollback: ImproverRevision = { format: 1, revision: 2, previous: SHA('c'), from: SHA('b'), version: 'v0', type: 'rollback', trigger: 'manual', reason: '子改进器更差', committedAt: TS }
    expect(isNextImproverRevision(state, rollback)).toBe(true)
    expect(isNextImproverRevision(state, { ...rollback, trigger: 'meta-job' })).toBe(false)
    expect(isNextImproverRevision(state, { ...rollback, previous: SHA('d') })).toBe(false)
  })
})

describe('step-6 evaluator epoch', () => {
  it('is the canonical text of the evaluator settings and changes with any of them', () => {
    const base = evaluatorSettings(DEFAULT_CAPABILITIES_CONFIG)
    expect(base).toEqual({ formatVersion: 1, rules: 'adr-0008', costRatioCap: 1.2, costApprovalRatio: 2, guardCases: 1, reviewer: { model: 'claude-sonnet-5-5', thinking: 'on' } })
    const text = canonicalEvaluatorText(base)
    // selection counts and repeats belong to the improver, not the epoch
    const moreCases = { ...DEFAULT_CAPABILITIES_CONFIG, selectionCases: 4, repeats: 3 }
    expect(canonicalEvaluatorText(evaluatorSettings(moreCases))).toBe(text)
    for (const change of [{ costRatioCap: 1.5 }, { costApprovalRatio: 3 }, { guardCases: 2 }, { reviewer: { model: 'claude-opus-5-5', thinking: 'on' as const } }]) {
      expect(canonicalEvaluatorText(evaluatorSettings({ ...DEFAULT_CAPABILITIES_CONFIG, ...change }))).not.toBe(text)
    }
    expectTypeOf<TrialPlan['epoch']>().toEqualTypeOf<string | undefined>()
  })
})

describe('step-6 parent / child comparison', () => {
  const origin: ComparisonOrigin = { sourceJobId: '00000000-0000-4000-8000-000000000009', tree: SHA('a'), feedbackIds: ['f1', 'f2'], capabilityVersion: 'baseline', epoch: SHA('e') }
  const verdict = (candidate: number): TrialVerdict => ({ outcome: 'adopt', reason: 'quality-up', passRate: { candidate, baseline: 0.5 }, costRatio: 1.1, costBasis: 'usd', decidedByReview: false })
  const arm = (side: 'parent' | 'child', over: Partial<ComparisonArmResult> = {}): ComparisonArmResult => ({
    arm: side,
    improverVersion: side === 'parent' ? 'v0' : SHA('b'),
    origin: { ...origin, feedbackIds: [...origin.feedbackIds].reverse() },
    jobId: side === 'parent' ? '00000000-0000-4000-8000-000000000011' : '00000000-0000-4000-8000-000000000012',
    status: 'adopted',
    candidateId: side === 'parent' ? '00000000-0000-4000-8000-000000000021' : '00000000-0000-4000-8000-000000000022',
    verdict: verdict(1),
    cost: { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }, requestCount: 3, estimatedUsd: 1 },
    ...over,
  })
  const rejected = (over: Partial<ComparisonArmResult> = {}) => ({ status: 'rejected' as const, verdict: { ...verdict(0.5), outcome: 'reject' as const, reason: 'no-improvement' as const }, ...over })

  it('compares only arms with the same origin and epoch', () => {
    expect(decideImprover(origin, arm('parent'), arm('child', { origin: { ...origin, epoch: SHA('f') } }))).toMatchObject({ outcome: 'reject', reason: 'epoch-mismatch' })
    expect(decideImprover(origin, arm('parent'), arm('child', { origin: { ...origin, tree: SHA('c') } }))).toMatchObject({ outcome: 'reject', reason: 'origin-mismatch' })
    expect(decideImprover(origin, arm('parent', { origin: { ...origin, feedbackIds: ['f1'] } }), arm('child'))).toMatchObject({ reason: 'origin-mismatch' })
  })

  it('rejects on any unknown arm, then on a child without offspring', () => {
    for (const over of [{ status: 'interrupted' as const }, { status: 'trialing' as const }, { status: 'budget-exhausted' as const }, { status: 'failed' as const, error: { name: 'NexgentError', code: 'llm/request-failed' as const, message: '500' } }, { cost: { usage: UNKNOWN_USAGE, requestCount: 1, estimatedUsd: 'unknown' as const } }, rejected({ verdict: { ...verdict(0.5), outcome: 'reject', reason: 'unknown-runs' } })]) {
      expect(decideImprover(origin, arm('parent'), arm('child', over)), JSON.stringify(over)).toMatchObject({ outcome: 'reject', reason: 'unknown-arm' })
      expect(decideImprover(origin, arm('parent', over), arm('child')), JSON.stringify(over)).toMatchObject({ outcome: 'reject', reason: 'unknown-arm' })
    }
    // the improver's own failures are results, not unknowns: no offspring
    const { candidateId: _c, verdict: _v, ...bare } = arm('child')
    expect(decideImprover(origin, arm('parent'), { ...bare, status: 'failed' })).toMatchObject({ outcome: 'reject', reason: 'no-offspring' })
    expect(decideImprover(origin, arm('parent'), { ...bare, status: 'failed', error: { name: 'NexgentError', code: 'improvement/invalid-diagnosis', message: 'x' } })).toMatchObject({ reason: 'no-offspring' })
    expect(decideImprover(origin, arm('parent'), { ...bare, status: 'no-proposal' })).toMatchObject({ reason: 'no-offspring' })
    const { candidateId: _pc, verdict: _pv, ...parentBare } = arm('parent')
    expect(decideImprover(origin, { ...parentBare, status: 'no-proposal' }, { ...bare, status: 'no-proposal' })).toMatchObject({ outcome: 'reject', reason: 'no-offspring' })
  })

  it('adopts when only the child passes its gate, whatever quality and cost say', () => {
    expect(decideImprover(origin, arm('parent', rejected()), arm('child', { cost: { ...arm('child').cost, estimatedUsd: 5 } }))).toMatchObject({ outcome: 'adopt', reason: 'gate-passed' })
    const { candidateId: _c, verdict: _v, ...parentBare } = arm('parent')
    expect(decideImprover(origin, { ...parentBare, status: 'no-proposal' }, arm('child'))).toMatchObject({ outcome: 'adopt', reason: 'gate-passed' })
    // quality and cost decide only when both passed
    expect(decideImprover(origin, arm('parent'), arm('child', rejected({ cost: { ...arm('child').cost, estimatedUsd: 0.1 } })))).toMatchObject({ outcome: 'reject', reason: 'no-improvement' })
    expect(decideImprover(origin, arm('parent', rejected()), arm('child', rejected({ cost: { ...arm('child').cost, estimatedUsd: 0.1 } })))).toMatchObject({ outcome: 'reject', reason: 'no-improvement' })
  })

  it('both passed: higher quality adopts; equal quality needs at least 10% lower cost (exactly 10% counts)', () => {
    expect(decideImprover(origin, arm('parent', { verdict: verdict(0.75) }), arm('child', { cost: { ...arm('child').cost, estimatedUsd: 3 } }))).toMatchObject({ outcome: 'adopt', reason: 'quality-up', quality: { parent: 0.75, child: 1 } })
    expect(decideImprover(origin, arm('parent'), arm('child', { verdict: verdict(0.75), cost: { ...arm('child').cost, estimatedUsd: 0.1 } }))).toMatchObject({ outcome: 'reject', reason: 'no-improvement' })
    const cost = (usd: number) => ({ cost: { ...arm('child').cost, estimatedUsd: usd } })
    expect(decideImprover(origin, arm('parent', cost(1)), arm('child', cost(0.9)))).toMatchObject({ outcome: 'adopt', reason: 'cost-down', costRatio: 0.9 })
    expect(decideImprover(origin, arm('parent', cost(0.5)), arm('child', cost(0.45)))).toMatchObject({ outcome: 'adopt', reason: 'cost-down' })
    expect(decideImprover(origin, arm('parent', cost(1)), arm('child', cost(0.95)))).toMatchObject({ outcome: 'reject', reason: 'no-improvement' })
    expect(decideImprover(origin, arm('parent', cost(0)), arm('child', cost(0)))).toMatchObject({ outcome: 'reject', reason: 'no-improvement' })
  })
})

describe('step-6 meta jobs', () => {
  const finished = (id: string, status: ImprovementJob['status'], extra: Partial<ImprovementJob> = {}) => ({ id, status, ...extra })

  it('counts finished capability jobs once and starts a meta job every K', () => {
    let queue = emptyImprovementQueue(TS)
    const counted: string[] = []
    for (const job of [
      finished('j1', 'adopted'), finished('j1', 'adopted'), finished('j2', 'cancelled'), finished('j3', 'interrupted'), finished('j4', 'budget-exhausted'),
      finished('j5', 'rejected'), finished('m1', 'adopted', { kind: 'meta' }), finished('a1', 'adopted', { arm: { metaJobId: 'm1', arm: 'child' } }),
      finished('j6', 'trialing'),
    ]) {
      const result = countFinishedJob(queue, job)
      queue = result.queue
      if (result.counted) counted.push(job.id)
    }
    expect(counted).toEqual(['j1', 'j5'])
    expect(META_COUNTED_STATUSES).toEqual(['adopted', 'rejected', 'no-proposal', 'failed'])
    expect(takeMetaBatch(queue, 3).batch).toBeUndefined()
    queue = countFinishedJob(queue, finished('j7', 'no-proposal')).queue
    expect(takeMetaBatch({ ...queue, activeJobId: 'x' }, 3).batch).toBeUndefined()
    const taken = takeMetaBatch(queue, 3)
    expect(taken.batch).toEqual(['j1', 'j5', 'j7'])
    expect(taken.queue.metaPending).toEqual([])
    expect(taken.queue.metaCounted).toEqual(['j1', 'j5', 'j7'])
    // an explicit meta job takes whatever is pending, even nothing
    expect(takeMetaBatch(taken.queue, 0).batch).toEqual([])
  })

  it('meta statuses hold the slot and only meta jobs reach them', () => {
    expect(IMPROVEMENT_ACTIVE_STATUSES).toEqual(expect.arrayContaining(['meta-diagnosing', 'meta-proposing', 'comparing']))
    expect(Object.keys(IMPROVEMENT_TRANSITIONS).sort()).toEqual([...IMPROVEMENT_STATUSES].sort())
    expect(canMoveJob('meta', 'queued', 'meta-diagnosing')).toBe(true)
    expect(canMoveJob('meta', 'meta-diagnosing', 'no-proposal')).toBe(true)
    expect(canMoveJob('meta', 'meta-proposing', 'comparing')).toBe(true)
    expect(canMoveJob('meta', 'comparing', 'adopted')).toBe(true)
    expect(canMoveJob('meta', 'queued', 'diagnosing')).toBe(false)
    expect(canMoveJob('meta', 'comparing', 'awaiting-approval')).toBe(false)
    expect(canMoveJob(undefined, 'queued', 'meta-diagnosing')).toBe(false)
    expect(canMoveJob('capability', 'queued', 'diagnosing')).toBe(true)
    expect(statusesOfKind('meta')).toEqual(META_JOB_STATUSES)
    expect(statusesOfKind('capability')).not.toContain('comparing')
    expect(IMPROVEMENT_TRIGGERS).toContain('job-count')
    expect(IMPROVEMENT_COST_PHASES).toEqual(['diagnose', 'propose', 'trial', 'meta-diagnose', 'meta-propose', 'compare'])
    expect(IMPROVEMENT_FILES).toMatchObject({ metaDiagnosis: 'meta-diagnosis.json', change: 'change.json', comparison: 'comparison.json' })
  })

  it('derives the SDK view\'s feedback ids and phase times from the job', () => {
    const job = {
      items: [
        { kind: 'feedback' as const, feedbackId: 'f1', sessionId: 's', deliverableId: 'd', at: TS },
        { kind: 'check-failure' as const, taskId: 't', sessionId: 's', turn: 1, at: TS },
        { kind: 'feedback' as const, feedbackId: 'f2', sessionId: 's', deliverableId: 'd', at: TS },
      ],
      history: [
        { status: 'queued' as const, at: '2026-10-13T00:00:00.000Z' },
        { status: 'diagnosing' as const, at: '2026-10-13T00:01:00.000Z' },
        { status: 'proposing' as const, at: '2026-10-13T00:02:00.000Z' },
        { status: 'trialing' as const, at: '2026-10-13T00:03:00.000Z' },
        { status: 'waiting-history' as const, at: '2026-10-13T00:04:00.000Z' },
        { status: 'trialing' as const, at: '2026-10-13T00:05:00.000Z' },
      ],
    }
    expect(jobFeedbackIds(job)).toEqual(['f1', 'f2'])
    expect(jobPhaseTimes(job)).toEqual({
      diagnose: { startedAt: '2026-10-13T00:01:00.000Z', endedAt: '2026-10-13T00:02:00.000Z' },
      propose: { startedAt: '2026-10-13T00:02:00.000Z', endedAt: '2026-10-13T00:03:00.000Z' },
      trial: { startedAt: '2026-10-13T00:03:00.000Z' },
    })
  })

  it('meta settings are off by default, validated and guarded with improvement', () => {
    expect(DEFAULT_IMPROVEMENT_CONFIG.meta).toEqual({ enabled: false, everyJobs: 3, budget: { maxTokens: 6_000_000, windowDays: 30 }, model: 'claude-sonnet-5-5' })
    expect(resolveImprovementConfig({ meta: { enabled: true, budget: { windowDays: 7 } } }).meta).toEqual({ enabled: true, everyJobs: 3, budget: { maxTokens: 6_000_000, windowDays: 7 }, model: 'claude-sonnet-5-5' })
    expect(() => assertImprovementConfig({ meta: { enabled: true, everyJobs: 5, budget: { maxTokens: 10 }, model: 'claude-opus-5-5' } })).not.toThrow()
    for (const bad of [{ meta: [] }, { meta: { enabled: 'yes' } }, { meta: { everyJobs: 0 } }, { meta: { everyJobs: 21 } }, { meta: { budget: { windowDays: 0 } } }, { meta: { model: '' } }, { meta: { k: 3 } }]) {
      expect(() => assertImprovementConfig(bad), JSON.stringify(bad)).toThrow(expect.objectContaining({ code: 'config/invalid' }))
    }
  })

  it('types: phases, ledger and session fields', () => {
    expectTypeOf<ImprovementPhase>().toEqualTypeOf<'diagnose' | 'propose' | 'trial' | 'meta-diagnose' | 'meta-propose'>()
    expectTypeOf<keyof ImprovementJob['phases']>().toEqualTypeOf<'diagnose' | 'propose' | 'trial' | 'meta-diagnose' | 'meta-propose' | 'compare'>()
    expectTypeOf<ImprovementJob['kind']>().toEqualTypeOf<'capability' | 'meta' | undefined>()
    expectTypeOf<ImprovementJob['trigger']>().toEqualTypeOf<'feedback-count' | 'explicit' | 'check-failure' | 'job-count'>()
    expectTypeOf<LedgerAttribution['comparisonArm']>().toEqualTypeOf<'parent' | 'child' | undefined>()
    expectTypeOf<LedgerAttribution['improverVersion']>().toEqualTypeOf<string | undefined>()
    expectTypeOf<ImprovementEndRecord['kind']>().toEqualTypeOf<'capability' | 'meta' | undefined>()
    expectTypeOf<SessionImprovement['phase']>().toEqualTypeOf<'diagnose' | 'propose' | 'meta-diagnose' | 'meta-propose'>()
  })
})
