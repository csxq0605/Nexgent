import * as nodePath from 'node:path'
import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  applyTextEdits,
  assertLearningConfig,
  assertUserConfig,
  checkCostCaps,
  combineScore,
  COST_WARNING_RATIO,
  costCapLevel,
  DEFAULT_LEARNING_CONFIG,
  DEFAULT_PROJECT_CONFIG,
  editsOf,
  EVALUATOR_RULES,
  foldHandbook,
  GUARDED_PROJECT_CONFIG_FIELDS,
  HANDBOOK_MARK_TOOL,
  isConcurrentTool,
  isProjectId,
  isRetrievable,
  isVisibleToLearners,
  LEARNING_RULES,
  mayLearn,
  mayWriteFile,
  NexgentError,
  nextHandbookStatus,
  numberLines,
  parseProjectConfig,
  practiceSplit,
  projectGitignoreText,
  resolveDataLocation,
  resolveLearningConfig,
  resolveProjectConfig,
  resolveProjectDataLayout,
  resolveUserConfig,
  resolveUserDataLayout,
  scheduleToolCalls,
  scoreBand,
  scorerReliability,
  selfEvalOutcome,
  selfEvalSample,
  SHARED_PROJECT_ENTRIES,
  STR_REPLACE_INPUT_SCHEMA,
  type CostCap,
  type HandbookOp,
  type LedgerRecord,
  type ProjectConfig,
  type TurnStartRecord,
} from '../../src/index.js'

/**
 * Rework C1 (ADR 0017–0019): the pure helpers and defaults of the new
 * contracts, and that data written before them still reads (token caps,
 * the retired `autoImprove` and `shareImproverEvidence`, a project whose
 * data has not been migrated).
 */
const SHA = (c: string) => c.repeat(64)
const P1 = SHA('a')
const TS = '2026-10-16T08:00:00.000Z'
const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

describe('data layout (ADR 0017 decision 4)', () => {
  it('puts project data under <home>/projects/<projectId>/ and keeps shareable files in the project', () => {
    const home = nodePath.resolve('/home/u/.nexgent')
    const user = resolveUserDataLayout(home)
    expect(user.projects).toBe(nodePath.join(home, 'projects'))
    expect(user.handbook).toBe(nodePath.join(home, 'handbook'))
    expect(user.practice).toBe(nodePath.join(home, 'practice'))
    const data = resolveProjectDataLayout(home, P1)
    expect(data.dataDir).toBe(nodePath.join(home, 'projects', P1))
    expect(data.sessions).toBe(nodePath.join(data.dataDir, 'sessions'))
    expect(data.grantsFile).toBe(nodePath.join(data.dataDir, 'grants.json'))
    expect(data.evaluations).toBe(nodePath.join(data.dataDir, 'evaluations'))
    expect(() => resolveProjectDataLayout(home, 'not-an-id')).toThrow(TypeError)
    expect(() => resolveUserDataLayout('relative/home')).toThrow(TypeError)
    expect(isProjectId(P1)).toBe(true)
    expect(isProjectId(SHA('A'))).toBe(false)
  })

  it('works with Windows paths', () => {
    const data = resolveProjectDataLayout('C:\\Users\\u\\.nexgent', P1, nodePath.win32)
    expect(data.ledgers).toBe(`C:\\Users\\u\\.nexgent\\projects\\${P1}\\ledgers`)
  })

  it('the .gitignore tracks exactly the shared entries', () => {
    const text = projectGitignoreText()
    const lines = text.trimEnd().split('\n').filter(line => !line.startsWith('#'))
    expect(lines[0]).toBe('*')
    expect(lines).toContain('!.gitignore')
    for (const entry of SHARED_PROJECT_ENTRIES) expect(lines.some(line => line === `!${entry}` || line === `!${entry}/`)).toBe(true)
    expect(lines.filter(line => line.startsWith('!')).join(' ')).not.toMatch(/sessions|ledgers|snapshots|grants/)
    expect(text.endsWith('\n')).toBe(true)
  })

  it('an unmigrated project keeps reading its old .nexgent/ until a migration is done', () => {
    expect(resolveDataLocation(true)).toBe('project')
    expect(resolveDataLocation(true, { status: 'copying' })).toBe('project')
    expect(resolveDataLocation(true, { status: 'failed' })).toBe('project')
    expect(resolveDataLocation(true, { status: 'done' })).toBe('user-data')
    expect(resolveDataLocation(false)).toBe('user-data')
  })
})

describe('cost caps in USD (ADR 0017 decision 5)', () => {
  const fail = (field: string, message: string): never => {
    throw new NexgentError('config/invalid', message, { details: { field } })
  }

  it('accepts USD, per-conversation and the old token caps', () => {
    for (const caps of [
      { perTask: { maxUsd: 2 }, perConversation: { maxUsd: 10, maxRequests: 400 }, perProject: { maxUsd: 50, windowDays: 30 } },
      { perTask: { maxTokens: 2_000_000, maxRequests: 200 }, perProject: { maxTokens: 50_000_000, windowDays: 30 } },
      {},
    ]) {
      expect(() => checkCostCaps(caps, fail)).not.toThrow()
    }
  })

  it('rejects unknown scopes and fields, negative or non-integer counts, windowDays outside perProject', () => {
    for (const [caps, field] of [
      [{ perWeek: {} }, 'costCaps.perWeek'],
      [{ perTask: { maxUsd: -1 } }, 'costCaps.perTask.maxUsd'],
      [{ perTask: { maxUsd: '2' } }, 'costCaps.perTask.maxUsd'],
      [{ perTask: { maxTokens: 1.5 } }, 'costCaps.perTask.maxTokens'],
      [{ perConversation: { windowDays: 7 } }, 'costCaps.perConversation.windowDays'],
      [{ perTask: { maxDollars: 1 } }, 'costCaps.perTask.maxDollars'],
      [{ perTask: [] }, 'costCaps.perTask'],
    ] as const) {
      expect(() => checkCostCaps(caps, fail), field).toThrow(expect.objectContaining({ details: { field } }))
    }
    expect(() => checkCostCaps([], fail)).toThrow(expect.objectContaining({ details: { field: 'costCaps' } }))
  })

  it('warns at 80% of any limit and is reached at 100%', () => {
    const cap: CostCap = { maxUsd: 10, maxRequests: 100 }
    expect(COST_WARNING_RATIO).toBe(0.8)
    expect(costCapLevel(cap, { usd: 7.99, tokens: 0, requests: 10 })).toBe('ok')
    expect(costCapLevel(cap, { usd: 8, tokens: 0, requests: 10 })).toBe('warning')
    expect(costCapLevel(cap, { usd: 1, tokens: 0, requests: 80 })).toBe('warning')
    expect(costCapLevel(cap, { usd: 10, tokens: 0, requests: 10 })).toBe('reached')
    expect(costCapLevel(cap, { usd: 1, tokens: 0, requests: 100 })).toBe('reached')
    expect(costCapLevel({ maxUsd: 0 }, { usd: 0, tokens: 0, requests: 0 })).toBe('reached')
    expect(costCapLevel({}, { usd: 1e9, tokens: 1e9, requests: 1e9 })).toBe('ok')
  })

  it('the ledger records warnings, estimated usage and retry attempts', () => {
    expectTypeOf<Extract<LedgerRecord, { type: 'cost.warning' }>['scope']>().toEqualTypeOf<'perTask' | 'perConversation' | 'perProject'>()
    expectTypeOf<Extract<LedgerRecord, { type: 'llm.request.end' }>['usageEstimated']>().toEqualTypeOf<true | undefined>()
    expectTypeOf<Extract<LedgerRecord, { type: 'llm.request.start' }>['attempt']>().toEqualTypeOf<number | undefined>()
    expectTypeOf<ProjectConfig['costCaps']>().toHaveProperty('perConversation')
  })
})

describe('learning settings (ADR 0017 decision 3, ADR 0018 decisions 8 and 10)', () => {
  it('defaults: on, 3 USD per 30 days, 0.05 USD per self-evaluation, shared both ways; guarded', () => {
    expect(DEFAULT_LEARNING_CONFIG).toEqual({ enabled: true, budget: { maxUsd: 3, windowDays: 30 }, selfEvalMaxUsd: 0.05, useShared: true, contribute: true })
    expect(DEFAULT_PROJECT_CONFIG.learning).toEqual(DEFAULT_LEARNING_CONFIG)
    expect(GUARDED_PROJECT_CONFIG_FIELDS).toContain('learning')
  })

  it('an old config without learning reads autoImprove and shareImproverEvidence as defaults', () => {
    expect(resolveProjectConfig({ autoImprove: false }).learning.enabled).toBe(false)
    expect(resolveProjectConfig({ improvement: { shareImproverEvidence: false } }).learning.contribute).toBe(false)
    expect(resolveProjectConfig({ autoImprove: false, learning: { enabled: true } }).learning.enabled).toBe(true)
    expect(resolveLearningConfig({ budget: { maxUsd: 1 } })).toMatchObject({ budget: { maxUsd: 1, windowDays: 30 } })
  })

  it('validates the learning object', () => {
    expect(() => assertLearningConfig({ enabled: false, budget: { maxUsd: 0, windowDays: 7 }, selfEvalMaxUsd: 0, useShared: false, contribute: false })).not.toThrow()
    for (const [bad, field] of [
      [{ budget: { maxUsd: -1 } }, 'learning.budget.maxUsd'],
      [{ budget: { windowDays: 0 } }, 'learning.budget.windowDays'],
      [{ selfEvalMaxUsd: 6 }, 'learning.selfEvalMaxUsd'],
      [{ useShared: 'yes' }, 'learning.useShared'],
      [{ autoImprove: true }, 'learning.autoImprove'],
    ] as const) {
      expect(() => assertLearningConfig(bad), field).toThrow(expect.objectContaining({ code: 'config/invalid', details: { field } }))
    }
  })

  it('learning waits for the user to acknowledge the notice (user config)', () => {
    expect(resolveUserConfig({}).learning).toEqual({})
    expect(resolveUserConfig({ learning: { noticeAcknowledgedAt: TS } }).learning).toEqual({ noticeAcknowledgedAt: TS })
    expect(() => assertUserConfig({ version: 1, learning: { noticeAcknowledgedAt: TS } })).not.toThrow()
    expect(() => assertUserConfig({ learning: { noticeAcknowledgedAt: 'yesterday' } })).toThrow(expect.objectContaining({ details: { field: 'learning.noticeAcknowledgedAt' } }))
    expect(() => assertUserConfig({ learning: { enabled: true } })).toThrow(expect.objectContaining({ details: { field: 'learning.enabled' } }))
    expect(mayLearn({ enabled: true }, {})).toBe(false)
    expect(mayLearn({ enabled: true }, { noticeAcknowledgedAt: TS })).toBe(true)
    expect(mayLearn({ enabled: false }, { noticeAcknowledgedAt: TS })).toBe(false)
  })

  it('the project config reader accepts the new fields and every old file', () => {
    const loaded = parseProjectConfig({ costCaps: { perTask: { maxUsd: 2 }, perConversation: { maxUsd: 8 } }, learning: { budget: { maxUsd: 5 } } })
    expect(loaded.config.costCaps).toEqual({ perTask: { maxUsd: 2 }, perConversation: { maxUsd: 8 } })
    expect(loaded.config.learning.budget).toEqual({ maxUsd: 5, windowDays: 30 })
    const old = parseProjectConfig({ version: 1, costCaps: { perTask: { maxTokens: 100 }, perProject: { maxRequests: 10, windowDays: 7 } }, autoImprove: false })
    expect(old.config.costCaps.perProject).toEqual({ maxRequests: 10, windowDays: 7 })
    expect(old.config.learning.enabled).toBe(false)
    expect(() => parseProjectConfig({ learning: { budget: { maxUsd: 'lots' } } }, 'config.json')).toThrow(expect.objectContaining({ code: 'config/invalid' }))
    expect(() => parseProjectConfig({ costCaps: { perTask: { maxUsd: -2 } } }, 'config.json')).toThrow(/costCaps\.perTask\.maxUsd/)
  })
})

describe('self-evaluation (ADR 0018 decision 2, ADR 0019 decisions 1 and 6)', () => {
  const rubric = { items: [{ id: 'r1', text: 'a', weight: 2 }, { id: 'r2', text: 'b' }] }

  it('the rules id is the new epoch', () => {
    expect(LEARNING_RULES).toBe('adr-0019')
    expect(EVALUATOR_RULES).toBe(LEARNING_RULES)
  })

  it('combines checks and rubric as the mean, either alone when the other is missing', () => {
    const checks = [{ passed: true }, { passed: false }]
    expect(combineScore(checks, rubric, [{ itemId: 'r1', score: 1 }, { itemId: 'r2', score: 0.5 }])).toBeCloseTo((0.5 + 2.5 / 3) / 2)
    expect(combineScore(checks)).toBe(0.5)
    expect(combineScore([], rubric, [{ itemId: 'r2', score: 1 }])).toBe(1)
    expect(combineScore([])).toBeUndefined()
  })

  it('the user rating decides, then failed checks, and passing checks alone prove nothing', () => {
    expect(selfEvalOutcome({ checks: [{ passed: false }], rubricScored: true, score: 0.1, rating: 5 })).toBe('success')
    expect(selfEvalOutcome({ checks: [], rubricScored: false, rating: 3 })).toBe('mixed')
    expect(selfEvalOutcome({ checks: [{ passed: false }], rubricScored: true, score: 0.95 })).toBe('failure')
    expect(selfEvalOutcome({ checks: [{ passed: true }], rubricScored: false, score: 1 })).toBe('unknown')
    expect(selfEvalOutcome({ checks: [], rubricScored: true, score: 0.6 })).toBe('mixed')
    // The rubric score, when given, decides the band: passing checks do not lift a result that misses rubric items.
    expect(selfEvalOutcome({ checks: [{ passed: true }], rubricScored: true, score: 0.84, rubricScore: 0.68 })).toBe('mixed')
    expect(selfEvalOutcome({ checks: [{ passed: true }], rubricScored: true, score: 0.95, rubricScore: 0.9 })).toBe('success')
    expect([scoreBand(0.8), scoreBand(0.79), scoreBand(0.49)]).toEqual(['success', 'mixed', 'failure'])
  })

  it('samples by priority when the budget is tight', () => {
    const base = { learning: true, hasFeedback: false, checkFailed: false, perTaskMaxUsd: 0.05, draw: 0.9 }
    expect(selfEvalSample({ ...base, learning: false, budgetLeftUsd: 3 })).toBe('learning-off')
    expect(selfEvalSample({ ...base, budgetLeftUsd: 0.04 })).toBe('budget-exhausted')
    expect(selfEvalSample({ ...base, budgetLeftUsd: 3 })).toBe('random')
    expect(selfEvalSample({ ...base, budgetLeftUsd: 0.2, hasFeedback: true })).toBe('user-feedback')
    expect(selfEvalSample({ ...base, budgetLeftUsd: 0.2, checkFailed: true })).toBe('check-failed')
    expect(selfEvalSample({ ...base, budgetLeftUsd: 0.2 })).toBe('not-sampled')
    expect(selfEvalSample({ ...base, budgetLeftUsd: 0.2, draw: 0.1 })).toBe('random')
  })

  it('judges the scorer only after 10 calibrations, unreliable below 80% agreement', () => {
    const samples = (agree: number, total: number) => Array.from({ length: total }, (_, index) => ({ agree: index < agree }))
    expect(scorerReliability([])).toEqual({ sampled: 0, agreed: 0, status: 'insufficient' })
    expect(scorerReliability(samples(9, 9)).status).toBe('insufficient')
    expect(scorerReliability(samples(8, 10))).toEqual({ sampled: 10, agreed: 8, rate: 0.8, status: 'reliable' })
    expect(scorerReliability(samples(7, 10)).status).toBe('unreliable')
  })
})

describe('practice set (ADR 0018 decision 3)', () => {
  it('splits by cluster, stably, about 60/20/20; generic cases are guards; learners never see holdout', () => {
    const counts = { train: 0, selection: 0, holdout: 0, guard: 0 }
    for (let index = 0; index < 2000; index += 1) counts[practiceSplit(`cluster-${index}`)] += 1
    expect(counts.guard).toBe(0)
    expect(counts.train / 2000).toBeGreaterThan(0.5)
    expect(counts.train / 2000).toBeLessThan(0.7)
    expect(counts.holdout / 2000).toBeGreaterThan(0.12)
    expect(practiceSplit('cluster-7')).toBe(practiceSplit('cluster-7'))
    expect(practiceSplit('cluster-7', 'generic')).toBe('guard')
    expect(['train', 'selection', 'holdout', 'guard'].map(split => isVisibleToLearners({ split: split as 'train' }))).toEqual([true, true, false, false])
  })
})

describe('handbook (ADR 0018 decision 4)', () => {
  const add = (seq: number, entryId: string, extra: Partial<HandbookOp> = {}): HandbookOp => ({ formatVersion: 1, seq, at: TS, entryId, actor: 'reflection', op: 'add', text: 't', keywords: [], scope: 'user', ...extra } as HandbookOp)
  const vote = (seq: number, op: 'upvote' | 'downvote'): HandbookOp => ({ formatVersion: 1, seq, at: TS, entryId: UUID(1), actor: 'execution', op })

  it('folds a log; a prefix is a rollback; votes alone do not change status', () => {
    const ops = [add(1, UUID(1)), vote(2, 'upvote'), vote(3, 'upvote'), { formatVersion: 1, seq: 4, at: TS, entryId: UUID(1), actor: 'host', op: 'status', status: 'active' } as HandbookOp]
    expect(foldHandbook(ops.slice(0, 3))[0]).toMatchObject({ status: 'trial', helpful: 2 })
    expect(foldHandbook(ops)[0]).toMatchObject({ status: 'active' })
    expect(foldHandbook(ops, 2)[0]).toMatchObject({ status: 'trial', helpful: 1 })
    expect(foldHandbook([vote(1, 'upvote')])).toEqual([])
  })

  it('status rule: two helpful votes activate, a margin of two harmful retires, retired stays retired', () => {
    expect(nextHandbookStatus({ status: 'trial', helpful: 2, harmful: 1 })).toBe('active')
    expect(nextHandbookStatus({ status: 'trial', helpful: 2, harmful: 2 })).toBe('trial')
    expect(nextHandbookStatus({ status: 'active', helpful: 1, harmful: 3 })).toBe('retired')
    expect(nextHandbookStatus({ status: 'retired', helpful: 9, harmful: 0 })).toBe('retired')
    expect(nextHandbookStatus({ status: 'active', helpful: 0, harmful: 0, supersededBy: UUID(2) })).toBe('retired')
    expect(isRetrievable({ status: 'trial' })).toBe(true)
    expect(isRetrievable({ status: 'retired' })).toBe(false)
  })

  it('handbook_mark is a concurrent, read-only bookkeeping tool', () => {
    expect(HANDBOOK_MARK_TOOL).toMatchObject({ name: 'handbook_mark', effects: ['read'], approval: 'never', concurrent: true })
    expectTypeOf<TurnStartRecord['handbook']>().toEqualTypeOf<readonly string[] | undefined>()
  })
})

describe('edit tools (ADR 0017 decision 1)', () => {
  it('write_file may replace a file the session read, or any with overwrite', () => {
    expect(mayWriteFile({ exists: false, readInSession: false })).toBe(true)
    expect(mayWriteFile({ exists: true, readInSession: false })).toBe(false)
    expect(mayWriteFile({ exists: true, readInSession: true })).toBe(true)
    expect(mayWriteFile({ exists: true, readInSession: false, overwrite: true })).toBe(true)
  })

  it('str_replace: replace_all, several edits all or nothing, one form per call', () => {
    expect(applyTextEdits('a b a', [{ old_str: 'a', new_str: 'c' }])).toEqual({ ok: false, index: 0, failure: 'not-unique' })
    expect(applyTextEdits('a b a', [{ old_str: 'a', new_str: 'c', replace_all: true }])).toEqual({ ok: true, content: 'c b c', replacements: 2 })
    expect(applyTextEdits('x y', [{ old_str: 'x', new_str: 'y' }, { old_str: 'y y', new_str: 'z' }])).toEqual({ ok: true, content: 'z', replacements: 2 })
    expect(applyTextEdits('x y', [{ old_str: 'x', new_str: 'q' }, { old_str: 'missing', new_str: 'z' }])).toEqual({ ok: false, index: 1, failure: 'not-found' })
    expect(applyTextEdits('x', [{ old_str: '', new_str: 'z' }])).toEqual({ ok: false, index: 0, failure: 'empty' })
    expect(applyTextEdits('x', [])).toMatchObject({ ok: false, failure: 'invalid' })
    expect(editsOf({ path: 'f', old_str: 'a', new_str: 'b' })).toEqual([{ old_str: 'a', new_str: 'b' }])
    expect(editsOf({ path: 'f', edits: [{ old_str: 'a', new_str: 'b' }] })).toEqual([{ old_str: 'a', new_str: 'b' }])
    expect(editsOf({ path: 'f', old_str: 'a', new_str: 'b', edits: [] })).toBeUndefined()
    expect(editsOf({ path: 'f', old_str: 'a' })).toBeUndefined()
    expect(Object.keys((STR_REPLACE_INPUT_SCHEMA as { properties: object }).properties)).toEqual(['path', 'old_str', 'new_str', 'replace_all', 'edits'])
  })

  it('read_file numbers lines like cat -n', () => {
    expect(numberLines(['first', 'second'])).toBe('     1\tfirst\n     2\tsecond')
    expect(numberLines(['x'], 120)).toBe('   120\tx')
  })
})

describe('tool concurrency (ADR 0017 decision 5)', () => {
  it('read-only tools that never ask run together; approvals and writes stay in order', () => {
    expect(isConcurrentTool({ effects: ['read'], approval: 'never' })).toBe(true)
    expect(isConcurrentTool({ effects: ['read'], approval: 'never' }, true)).toBe(false)
    expect(isConcurrentTool({ effects: ['read', 'write'], approval: 'never' })).toBe(false)
    expect(isConcurrentTool({ effects: ['read'], approval: 'always' })).toBe(false)
    expect(isConcurrentTool({ effects: ['execute'], approval: 'never', concurrent: true })).toBe(true)
    expect(isConcurrentTool({ effects: [], approval: 'never' })).toBe(false)
  })

  it('batches consecutive concurrent calls, in call order', () => {
    expect(scheduleToolCalls([true, true, false, true, true, true])).toEqual([[0, 1], [2], [3, 4, 5]])
    expect(scheduleToolCalls([false, false])).toEqual([[0], [1]])
    expect(scheduleToolCalls([])).toEqual([])
  })
})
