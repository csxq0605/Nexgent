import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  assertImprovementConfig,
  assertUserConfig,
  countUserFinishedJob,
  DECISION_REASONS,
  decideTrial,
  DEFAULT_IMPROVEMENT_CONFIG,
  DEFAULT_USER_CONFIG,
  emptyUserMetaQueue,
  EVALUATOR_RULES,
  findInstanceLiterals,
  GUARDED_USER_CONFIG_FIELDS,
  IMPROVE_LIST_JOBS_TOOL,
  IMPROVE_READ_JOB_TOOL,
  IMPROVER_SCOPES,
  improverChangeTexts,
  isNexgentError,
  literalTokens,
  META_DIAGNOSIS_TOOLS,
  META_READ_LEDGER_TOOL,
  META_READ_SESSION_TOOL,
  NexgentError,
  releaseUserMetaSlot,
  resolveImprovementConfig,
  resolveUserConfig,
  takeUserMetaBatch,
  USER_PROJECT_ID_PATTERN,
  userMetaKey,
  type ArmTally,
  type ComparisonOrigin,
  type ImprovementJob,
  type ImproverScope,
  type InstanceLiteralSource,
  type LedgerRecordBase,
  type MetaJobState,
  type ProjectTaskMessage,
  type SessionImprovement,
  type TrialTally,
  type TrialVerdict,
  type UserMetaQueue,
} from '@nexgent/kernel'

/**
 * Step 6 rework contracts (ADR 0012 shared improver, ADR 0013 gate rules):
 * the instance-literal check, the similar-cases rule of `decideTrial`, the
 * user-level meta queue and config, the improver scope fields, the meta
 * tools' `projectId`. Every rule here is about values, counts and projects,
 * never about a kind of task.
 */
const SHA = (c: string) => c.repeat(64)
const TS = '2026-10-14T00:00:00.000Z'
const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

describe('literal tokens', () => {
  it('reads decimals, integers of 3+ digits, dates and year-months', () => {
    expect(literalTokens('East=4/2384.13 and North=5, 2026-10 report, due 2026-10-05, 120 rows, 42 cols')).toEqual([
      { value: '2384.13', kind: 'decimal' },
      { value: '2026-10', kind: 'date' },
      { value: '2026-10-05', kind: 'date' },
      { value: '120', kind: 'integer' },
    ])
    expect(literalTokens('total 2,384.13 USD; 1,000,000 units').map(t => t.value)).toEqual(['2384.13', '1000000'])
    expect(literalTokens('2384.13USD and 2026-10-05T08:00').map(t => t.value)).toEqual(['2384.13', '2026-10-05'])
    expect(literalTokens('again 2384.13, 2384.13.').map(t => t.value)).toEqual(['2384.13'])
  })

  it('ignores identifiers, versions and short integers', () => {
    expect(literalTokens('sha256 v1.2.3 x86_64 utf-8 h264 col_100 q3 id42 1.2.3 10 99')).toEqual([])
    expect(literalTokens('build.2024 file2024.csv 2024_report')).toEqual([])
  })
})

describe('findInstanceLiterals (ADR 0013 decision 2)', () => {
  const feedback: InstanceLiteralSource = { kind: 'feedback', ref: 'feedback:f1', text: 'East should be 4 with total 2384.13 for 2026-10; threshold 500 as always.' }
  const deliverable: InstanceLiteralSource = { kind: 'deliverable', ref: 'deliverable:d1/v2/report.md', text: '| region | orders | total |\n| East | 4 | 2384.13 |\n| North | 5 | 1999.50 |\nPeriod 2026-10' }
  const history: ProjectTaskMessage[] = [
    { taskId: 't1', text: 'Make the monthly report; flag orders above 500.' },
    { taskId: 't2', text: 'Same report for the next month, still flag above 500.' },
    { taskId: 't3', text: 'Report for 2026-10 please.' },
  ]

  it('counts the task values: 2384.13 and 2026-10', () => {
    const hits = findInstanceLiterals([{ path: 'context-policy.md', text: 'Before finishing, self-check East=4/2384.13 and North=5 for 2026-10.' }], [feedback, deliverable], history)
    expect(hits).toEqual([
      { value: '2384.13', kind: 'decimal', path: 'context-policy.md', source: 'feedback:f1' },
      { value: '2026-10', kind: 'date', path: 'context-policy.md', source: 'feedback:f1' },
    ])
  })

  it('a deliverable value counts too, reported with its first source', () => {
    expect(findInstanceLiterals([{ path: 'SKILL.md', text: 'North total must read 1999.50.' }], [feedback, deliverable], history)).toEqual([
      { value: '1999.50', kind: 'decimal', path: 'SKILL.md', source: 'deliverable:d1/v2/report.md' },
    ])
  })

  it('a project constant in the user messages of 2 tasks does not count; in 1 task it does', () => {
    const component = [{ path: 'SKILL.md', text: 'Flag every order above 500.' }]
    expect(findInstanceLiterals(component, [feedback], history)).toEqual([])
    expect(findInstanceLiterals(component, [feedback], history.slice(0, 1))).toEqual([{ value: '500', kind: 'integer', path: 'SKILL.md', source: 'feedback:f1' }])
    // Two messages of the same task are one task.
    expect(findInstanceLiterals(component, [feedback], [history[0]!, { ...history[1]!, taskId: 't1' }])).toHaveLength(1)
  })

  it('column names, conventions and values not in any source do not count', () => {
    const texts = [
      { path: 'SKILL.md', text: 'Keep the columns region, orders, total; name the file report-<yyyy-mm>.md; round to 2 decimals.' },
      { path: 'tools/check.js', text: 'const MAX_ROWS = 10000; const ratio = 0.95' },
    ]
    expect(findInstanceLiterals(texts, [feedback, deliverable], history)).toEqual([])
  })

  it('values are compared as written, one hit per value and path', () => {
    expect(findInstanceLiterals([{ path: 'a', text: '2384.1 and 2384.130' }], [feedback], [])).toEqual([])
    const hits = findInstanceLiterals([{ path: 'a', text: '2384.13 then 2384.13' }, { path: 'b', text: '2,384.13' }], [feedback], [])
    expect(hits.map(hit => `${hit.path}:${hit.value}`)).toEqual(['a:2384.13', 'b:2384.13'])
  })

  it('with projectId, a constant counts only within its own project', () => {
    const p1 = SHA('1')
    const p2 = SHA('2')
    const component = [{ path: 'diagnosis.paragraphs[2]', text: 'Check the threshold 500.' }]
    const messages: ProjectTaskMessage[] = [
      { taskId: 't1', text: 'flag above 500', projectId: p2 },
      { taskId: 't2', text: 'flag above 500', projectId: p2 },
    ]
    expect(findInstanceLiterals(component, [{ ...feedback, projectId: p2 }], messages)).toEqual([])
    expect(findInstanceLiterals(component, [{ ...feedback, projectId: p1 }], messages)).toEqual([{ value: '500', kind: 'integer', path: 'diagnosis.paragraphs[2]', source: 'feedback:f1' }])
  })

  it('improver changes give their texts to the same check', () => {
    expect(improverChangeTexts({ op: 'set-diagnosis-paragraph', index: 3, text: 'x 2384.13' })).toEqual([{ path: 'diagnosis.paragraphs[3]', text: 'x 2384.13' }])
    expect(improverChangeTexts({ op: 'set-proposal-brief', kind: 'skill', template: 'y' })).toEqual([{ path: 'proposal.briefs.skill', text: 'y' }])
    expect(improverChangeTexts({ op: 'set-proposal-kinds', kinds: ['skill'] })).toEqual([])
    expect(improverChangeTexts({ op: 'set-comparison-param', param: 'repeats', value: 3 })).toEqual([])
    expect(findInstanceLiterals(improverChangeTexts({ op: 'set-diagnosis-paragraph', index: 0, text: 'Totals like 2384.13 are often wrong.' }), [feedback], history)).toHaveLength(1)
  })
})

describe('decideTrial: the similar-cases rule (ADR 0013 decision 1)', () => {
  const arm = (passed: number, failed: number, unknown = 0): ArmTally => ({ passed, failed, unknown })
  const tally = (overrides: Partial<TrialTally> = {}): TrialTally => ({
    selection: { candidate: arm(4, 0), baseline: arm(2, 2) },
    guard: { candidate: arm(2, 0), baseline: arm(2, 0) },
    review: { candidate: 0, baseline: 0, tie: 0 },
    tokens: { candidate: 1000, baseline: 1000 },
    budgetExhausted: false,
    requiresApproval: false,
    ...overrides,
  })
  const tie = { selection: { candidate: arm(2, 2), baseline: arm(2, 2) } }
  const similar = (candidate: ArmTally, baseline: ArmTally) => ({ similar: { candidate, baseline } })

  const rows: readonly { readonly name: string; readonly tally: TrialTally; readonly expected: Partial<TrialVerdict> }[] = [
    { name: 'user-task candidate: unchanged', tally: tally(), expected: { outcome: 'adopt', reason: 'quality-up' } },
    { name: 'similar equal: adopts as before', tally: tally(similar(arm(2, 0), arm(2, 0))), expected: { outcome: 'adopt', reason: 'quality-up', similarPassRate: { candidate: 1, baseline: 1 } } },
    { name: 'similar better: adopts', tally: tally(similar(arm(2, 0), arm(1, 1))), expected: { outcome: 'adopt', reason: 'quality-up' } },
    { name: 'similar worse: rejects quality-up', tally: tally(similar(arm(1, 1), arm(2, 0))), expected: { outcome: 'reject', reason: 'similar-regression', similarPassRate: { candidate: 0.5, baseline: 1 } } },
    { name: 'similar worse: rejects cost-down', tally: tally({ ...tie, tokens: { candidate: 900, baseline: 1000 }, ...similar(arm(1, 1), arm(2, 0)) }), expected: { outcome: 'reject', reason: 'similar-regression' } },
    { name: 'similar worse: rejects review-preferred', tally: tally({ ...tie, review: { candidate: 3, baseline: 1, tie: 0 }, ...similar(arm(1, 1), arm(2, 0)) }), expected: { outcome: 'reject', reason: 'similar-regression', decidedByReview: false } },
    { name: 'similar worse: rejects an over-ratio await', tally: tally({ tokens: { candidate: 3000, baseline: 1000 }, ...similar(arm(0, 2), arm(2, 0)) }), expected: { outcome: 'reject', reason: 'similar-regression' } },
    { name: 'similar worse: plugin candidate rejects too', tally: tally({ requiresApproval: true, ...similar(arm(1, 1), arm(2, 0)) }), expected: { outcome: 'reject', reason: 'similar-regression' } },
    { name: 'no similar case: waits for the user', tally: tally({ similar: 'none' }), expected: { outcome: 'await-approval', reason: 'no-similar-cases' } },
    { name: 'no similar case, review tie-break: waits, still by review', tally: tally({ ...tie, review: { candidate: 3, baseline: 1, tie: 0 }, similar: 'none' }), expected: { outcome: 'await-approval', reason: 'no-similar-cases', decidedByReview: true } },
    { name: 'rejection stays as it was', tally: tally({ selection: { candidate: arm(1, 3), baseline: arm(2, 2) }, ...similar(arm(1, 1), arm(2, 0)) }), expected: { outcome: 'reject', reason: 'quality-down' } },
    { name: 'no similar case does not rescue a rejection', tally: tally({ ...tie, similar: 'none' }), expected: { outcome: 'reject', reason: 'no-improvement' } },
    { name: 'unknown similar runs are unknown runs', tally: tally({ selection: { candidate: arm(3, 0, 1), baseline: arm(2, 2) }, ...similar(arm(1, 0, 1), arm(2, 0)) }), expected: { outcome: 'reject', reason: 'unknown-runs' } },
  ]

  for (const row of rows) {
    it(row.name, () => {
      expect(decideTrial(row.tally, 1.2)).toMatchObject(row.expected)
    })
  }

  it('a user-task candidate gets no similarPassRate; none gets none either', () => {
    expect(decideTrial(tally(), 1.2)).not.toHaveProperty('similarPassRate')
    expect(decideTrial(tally({ similar: 'none' }), 1.2)).not.toHaveProperty('similarPassRate')
  })

  it('the reasons and the rules id', () => {
    for (const reason of ['similar-regression', 'no-similar-cases', 'instance-literal'] as const) expect(DECISION_REASONS).toContain(reason)
    // ADR 0014 replaced adr-0013 (a new epoch).
    expect(EVALUATOR_RULES).toBe('adr-0015')
    for (const code of ['capability/instance-literal', 'improver/instance-literal'] as const) expect(new NexgentError(code, 'found task values').code).toBe(code)
  })
})

describe('user-level meta queue (ADR 0012 decision 3)', () => {
  const p1 = { projectId: SHA('1'), root: '/work/a', shares: true }
  const p2 = { projectId: SHA('2'), root: '/work/b', shares: true }
  const job = (n: number, over: Partial<ImprovementJob> = {}): Pick<ImprovementJob, 'id' | 'status' | 'kind' | 'arm' | 'updatedAt'> => ({ id: UUID(n), status: 'rejected', updatedAt: TS, ...over })

  it('counts finished jobs of every sharing project once', () => {
    let queue: UserMetaQueue = emptyUserMetaQueue(TS)
    let step = countUserFinishedJob(queue, p1, job(1), TS)
    expect(step.counted).toBe(true)
    queue = step.queue
    expect(countUserFinishedJob(queue, p1, job(1), TS).counted).toBe(false)
    // The same job id in another project is another job.
    step = countUserFinishedJob(queue, p2, job(1), TS)
    expect(step.counted).toBe(true)
    queue = step.queue
    expect(queue.counted).toEqual([userMetaKey(p1.projectId, UUID(1)), userMetaKey(p2.projectId, UUID(1))])
    for (const [project, finished] of [
      [{ ...p1, shares: false }, job(3)],
      [p1, job(4, { kind: 'meta' })],
      [p1, job(5, { arm: { metaJobId: UUID(9), arm: 'child' } })],
      [p1, job(6, { status: 'diagnosing' })],
      [p1, job(7, { updatedAt: '2026-10-13T00:00:00.000Z' })],
    ] as const) {
      expect(countUserFinishedJob(queue, project, finished, TS).counted).toBe(false)
    }
  })

  it('takes a batch only with a free slot and enough jobs, dropping projects that stopped sharing', () => {
    let queue = emptyUserMetaQueue(TS)
    for (const [project, n] of [[p1, 1], [p2, 2], [p1, 3]] as const) queue = countUserFinishedJob(queue, project, job(n), TS).queue
    expect(takeUserMetaBatch(queue, 4).batch).toBeUndefined()
    const taken = takeUserMetaBatch(queue, 3)
    expect(taken.batch?.map(entry => entry.jobId)).toEqual([UUID(1), UUID(2), UUID(3)])
    expect(taken.queue.pending).toEqual([])
    const withoutP2 = takeUserMetaBatch(queue, 3, projectId => projectId !== p2.projectId)
    expect(withoutP2.batch).toBeUndefined()
    expect(withoutP2.queue.pending.map(entry => entry.jobId)).toEqual([UUID(1), UUID(3)])
    const busy: UserMetaQueue = { ...queue, active: { projectId: p1.projectId, root: p1.root, jobId: UUID(9), createdAt: TS } }
    expect(takeUserMetaBatch(busy, 0).batch).toBeUndefined()
    expect(releaseUserMetaSlot(busy, UUID(8))).toBe(busy)
    expect(releaseUserMetaSlot(busy, UUID(9))).not.toHaveProperty('active')
    // An explicit meta job passes 0 and may start on an empty batch.
    expect(takeUserMetaBatch(emptyUserMetaQueue(TS), 0).batch).toEqual([])
  })

  it('project ids are 64 hex', () => {
    expect(USER_PROJECT_ID_PATTERN.test(SHA('a'))).toBe(true)
    expect(USER_PROJECT_ID_PATTERN.test('p1')).toBe(false)
  })
})

describe('user config and the project switch', () => {
  it('defaults: meta off, every 3 jobs, its own budget', () => {
    expect(DEFAULT_USER_CONFIG).toEqual({ version: 1, improvement: { meta: { enabled: false, everyJobs: 3, budget: { maxTokens: 6_000_000, windowDays: 30 }, model: 'claude-sonnet-5-5' } } })
    expect(resolveUserConfig({ improvement: { meta: { enabled: true } } }).improvement.meta).toMatchObject({ enabled: true, everyJobs: 3 })
    expect(GUARDED_USER_CONFIG_FIELDS).toEqual(['improvement'])
  })

  it('validates like the project config', () => {
    expect(() => assertUserConfig({})).not.toThrow()
    expect(() => assertUserConfig({ version: 1, improvement: { meta: { enabled: true, everyJobs: 5, budget: { maxTokens: 1000, windowDays: 7 } } } })).not.toThrow()
    for (const [bad, field] of [
      [null, 'config'],
      [{ version: 2 }, 'version'],
      [{ theme: 'dark' }, 'theme'],
      [{ improvement: { autoImprove: true } }, 'improvement.autoImprove'],
      [{ improvement: { meta: { enabled: 'yes' } } }, 'improvement.meta.enabled'],
      [{ improvement: { meta: { everyJobs: 0 } } }, 'improvement.meta.everyJobs'],
    ] as const) {
      try {
        assertUserConfig(bad)
        expect.unreachable(JSON.stringify(bad))
      } catch (error) {
        expect(isNexgentError(error) && error.code).toBe('config/invalid')
        expect(isNexgentError(error) && error.details?.['field']).toBe(field)
      }
    }
  })

  it('project improvement.shareImproverEvidence defaults to true; old project files with meta still load', () => {
    expect(DEFAULT_IMPROVEMENT_CONFIG.shareImproverEvidence).toBe(true)
    expect(resolveImprovementConfig({ shareImproverEvidence: false }).shareImproverEvidence).toBe(false)
    expect(() => assertImprovementConfig({ shareImproverEvidence: false })).not.toThrow()
    expect(() => assertImprovementConfig({ shareImproverEvidence: 'no' })).toThrow()
    expect(() => assertImprovementConfig({ meta: { enabled: true, everyJobs: 3 } })).not.toThrow()
  })
})

describe('meta tools take a projectId of the batch (ADR 0012 decision 4)', () => {
  const props = (schema: unknown) => (schema as { properties: Record<string, { pattern?: string }>; required?: string[] })
  it('reads of sessions and ledgers require it; job tools accept it', () => {
    for (const tool of [META_READ_SESSION_TOOL, META_READ_LEDGER_TOOL]) {
      expect(props(tool.inputSchema).required).toContain('projectId')
      expect(props(tool.inputSchema).properties['projectId']?.pattern).toBe(USER_PROJECT_ID_PATTERN.source)
      expect(META_DIAGNOSIS_TOOLS).toContain(tool)
    }
    for (const tool of [IMPROVE_LIST_JOBS_TOOL, IMPROVE_READ_JOB_TOOL]) {
      expect(props(tool.inputSchema).properties['projectId']).toBeDefined()
      expect(props(tool.inputSchema).required ?? []).not.toContain('projectId')
    }
    expect(META_DIAGNOSIS_TOOLS.map(tool => tool.name)).toEqual(['improve_list_jobs', 'improve_read_job', 'improve_read_session', 'improve_read_ledger', 'improve_report_meta_diagnosis'])
  })
})

describe('improver scope fields (types)', () => {
  it('job, ledger and session start carry an optional scope; old data has none (project-level)', () => {
    expect(IMPROVER_SCOPES).toEqual(['user', 'project'])
    expectTypeOf<ImprovementJob['improverScope']>().toEqualTypeOf<ImproverScope | undefined>()
    expectTypeOf<LedgerRecordBase['improverScope']>().toEqualTypeOf<ImproverScope | undefined>()
    expectTypeOf<SessionImprovement['improverScope']>().toEqualTypeOf<ImproverScope | undefined>()
    expectTypeOf<ComparisonOrigin['projectId']>().toEqualTypeOf<string | undefined>()
    expectTypeOf<MetaJobState['batch']>().toEqualTypeOf<UserMetaQueue['pending'] | undefined>()
    expectTypeOf<TrialVerdict['similarPassRate']>().toEqualTypeOf<{ readonly candidate: number; readonly baseline: number } | undefined>()
  })
})
