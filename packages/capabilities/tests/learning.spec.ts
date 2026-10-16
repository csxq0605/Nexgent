/**
 * G1: the self-evaluator, the practice set and the epoch `adr-0019` rules,
 * with a scripted model (no key, no network).
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  perTurnFileName,
  practiceSplit,
  resolveLearningConfig,
  resolveWorkspaceLayout,
  ZERO_USAGE,
  type CapabilityDecision,
  type LLMProvider,
  type LLMUsage,
  type PracticeCase,
  type SelfEvaluation,
  type TaskCheck,
  type TrialVerdict,
  type WorkspaceLayout,
} from '@nexgent/kernel'
import { JsonlSessionStore } from '@nexgent/session'
import { LocalTaskRecorder } from '@nexgent/tasking'
import {
  CapabilityStore,
  epochVerdict,
  evaluationsDirectory,
  evolutionCount,
  genericChecks,
  listEvaluations,
  listPracticeCases,
  loadGenericPracticeCases,
  practiceCasesDirectory,
  providerSelfEvalModel,
  rejectsThinkingOff,
  recordEvaluationFeedback,
  referencedPaths,
  RUBRIC_GENERATOR,
  scorerReliabilityOf,
  selfEvaluate,
  similarityKey,
  totalsProblem,
  writeBundle,
  writeEvaluation,
  addPracticeCase,
  type SelfEvalModel,
  type SelfEvalRequest,
} from '../src/index.js'
import { sampleComponents, tempDir } from './helpers.js'

const LEARNING = resolveLearningConfig()
const ITEMS = [{ text: 'report.md lists every region of input.csv', weight: 3 }, { text: 'the total row equals the sum of the amounts', weight: 2 }, { text: 'the answer names the report file' }]

/** A scripted model: the rubric request gets {@link ITEMS}; scoring requests get `score` per item (per model). */
function scriptedModel(score: (request: SelfEvalRequest, id: string) => 0 | 0.5 | 1, usd = 0.004): SelfEvalModel & { requests: SelfEvalRequest[] } {
  const requests: SelfEvalRequest[] = []
  const usage: LLMUsage = { ...ZERO_USAGE, inputTokens: 1000, outputTokens: 200 }
  return {
    requests,
    async complete(request) {
      requests.push(request)
      if (request.system.includes('grading rubric')) return { text: JSON.stringify({ items: ITEMS }), usage, estimatedUsd: usd }
      const ids = [...request.user.matchAll(/^- (r\d+) \(weight/gm)].map(match => match[1]!)
      return { text: `Here you go:\n${JSON.stringify({ scores: ids.map(id => ({ id, score: score(request, id), note: 'checked' })) })}`, usage, estimatedUsd: usd }
    },
  }
}

interface TaskSetup {
  readonly layout: WorkspaceLayout
  readonly taskId: string
  readonly sessionId: string
}

/** A finished root task: input.csv at the start, report.md written, a recorded check per `checks`, optional rating. */
async function finishedTask(options: { readonly checks?: readonly boolean[]; readonly rating?: 1 | 2 | 3 | 4 | 5; readonly report?: string; readonly text?: string; readonly root?: string } = {}): Promise<TaskSetup> {
  const root = options.root ?? (await tempDir())
  const layout = resolveWorkspaceLayout(root)
  await mkdir(layout.dataDir, { recursive: true })
  await writeFile(join(root, 'input.csv'), 'region,amount\nnorth,10\nsouth,5\n')
  const sessionId = randomUUID()
  const taskId = randomUUID()
  const store = new JsonlSessionStore({ sessionsDir: layout.sessions })
  const lock = await store.create({ sessionId, projectRoot: root, model: 'claude-sonnet-5-5', sandboxMode: 'workspace-write', capabilityVersion: 'baseline' })
  await new LocalTaskRecorder(layout).begin({ taskId, sessionId, turn: 1, capabilityVersion: 'baseline' })
  await store.append(sessionId, { type: 'turn.start', turn: 1 })
  await store.append(sessionId, { type: 'user.message', turn: 1, content: options.text ?? 'Summarize `input.csv` by region into report.md with a total row.', source: 'user' })
  await writeFile(join(root, 'report.md'), options.report ?? '| region | amount |\n| --- | --- |\n| north | 10 |\n| south | 5 |\n| Total | 15 |\n')
  await store.append(sessionId, { type: 'assistant.message', turn: 1, step: 1, requestId: randomUUID(), content: 'Wrote `report.md`.', usage: ZERO_USAGE, finishReason: 'stop' })
  if (options.rating !== undefined) {
    await store.append(sessionId, { type: 'feedback', turn: 1, feedback: { id: randomUUID(), deliverableId: randomUUID(), version: 1, rating: options.rating, comment: 'rated' } })
  }
  await store.append(sessionId, { type: 'turn.end', turn: 1, reason: { kind: 'completed' } })
  await store.release(lock)
  const checks = options.checks ?? [true]
  await mkdir(join(layout.dataDir, 'snapshots', 'checks'), { recursive: true })
  await writeFile(join(layout.dataDir, 'snapshots', 'checks', perTurnFileName(taskId, 1)), JSON.stringify({
    formatVersion: 1,
    taskId,
    turn: 1,
    sessionId,
    checkedAt: new Date().toISOString(),
    specs: checks.map((_, index) => ({ id: `file-${index + 1}`, name: 'file-exists', path: 'report.md' })),
    results: checks.map((passed, index) => ({ name: 'file-exists', passed, target: `file-${index + 1}` })),
  }))
  return { layout, taskId, sessionId }
}

function evaluate(task: TaskSetup, model: SelfEvalModel, extra: Partial<Parameters<typeof selfEvaluate>[0]> = {}) {
  return selfEvaluate({
    layout: task.layout,
    sessionId: task.sessionId,
    turn: 1,
    taskId: task.taskId,
    model,
    executionModel: 'claude-sonnet-5-5',
    learning: LEARNING,
    mayLearn: true,
    budgetLeftUsd: 3,
    calibrationRate: 0,
    draw: () => 0.99,
    ...extra,
  })
}

describe('self-evaluation outcomes', () => {
  it('a failed deterministic check is a failure, whatever the rubric score', async () => {
    const task = await finishedTask({ checks: [true, false] })
    const model = scriptedModel(() => 1)
    // A tight budget: only prioritized tasks are scored.
    const evaluation = await evaluate(task, model, { budgetLeftUsd: 0.1 })
    expect(evaluation?.sample).toBe('check-failed')
    expect(evaluation?.outcome).toBe('failure')
    expect(evaluation?.scores).toHaveLength(3)
    expect(evaluation?.checks.filter(check => !check.passed)).toHaveLength(1)
  })

  it('a low rubric score is a failure, a high one a success', async () => {
    const low = await evaluate(await finishedTask(), scriptedModel(() => 0))
    expect(low?.sample).toBe('random')
    // Checks pass (1.0, incl. the generic ones), rubric 0: combined (1 + 0) / 2 = 0.5, but the rubric score decides the band.
    expect(low?.score).toBeCloseTo(0.5)
    expect(low?.outcome).toBe('failure')
    const half = await evaluate(await finishedTask(), scriptedModel(() => 0.5))
    expect(half?.score).toBeCloseTo(0.75)
    expect(half?.outcome).toBe('mixed')
    // Passing checks do not lift a result that misses a weighted item: rubric (1·3 + 0·2 + 1·1) / 6 ≈ 0.67 is mixed, though combined is ≈ 0.83.
    const missed = await evaluate(await finishedTask(), scriptedModel((_, id) => (id === 'r2' ? 0 : 1)))
    expect(missed?.score).toBeCloseTo(5 / 6)
    expect(missed?.outcome).toBe('mixed')
    const high = await evaluate(await finishedTask(), scriptedModel(() => 1))
    expect(high?.score).toBe(1)
    expect(high?.outcome).toBe('success')
    expect(high?.rubric?.generator).toBe(RUBRIC_GENERATOR)
    expect(high?.rubric?.items.map(item => item.id)).toEqual(['r1', 'r2', 'r3'])
    expect(high?.cost.requestCount).toBe(2)
    expect(high?.cost.estimatedUsd).toBeCloseTo(0.008)
  })

  it('a user rating of 5 is a success even with a low score; a later rating recomputes the outcome', async () => {
    const rated = await evaluate(await finishedTask({ rating: 5 }), scriptedModel(() => 0), { budgetLeftUsd: 0.1 })
    expect(rated?.sample).toBe('user-feedback')
    expect(rated?.feedback?.rating).toBe(5)
    expect(rated?.outcome).toBe('success')

    const task = await finishedTask()
    const first = await evaluate(task, scriptedModel(() => 0))
    expect(first?.outcome).toBe('failure')
    const updated = await recordEvaluationFeedback(evaluationsDirectory(task.layout), task.taskId, { feedbackIds: [randomUUID()], rating: 4 })
    expect(updated?.outcome).toBe('success')
    expect(updated?.scores).toEqual(first?.scores)
    expect(updated?.rubric).toEqual(first?.rubric)
  })

  it('with the budget exhausted nothing is asked; the checks are still recorded', async () => {
    const model = scriptedModel(() => 1)
    const evaluation = await evaluate(await finishedTask({ checks: [true, false] }), model, { budgetLeftUsd: 0.01 })
    expect(evaluation?.sample).toBe('budget-exhausted')
    expect(model.requests).toHaveLength(0)
    expect(evaluation?.rubric).toBeUndefined()
    expect(evaluation?.checks.length).toBeGreaterThan(0)
    expect(evaluation?.outcome).toBe('failure')
    expect(evaluation?.cost.requestCount).toBe(0)
  })

  it('a tight budget scores only a random share of tasks without priority', async () => {
    const skipped = await evaluate(await finishedTask(), scriptedModel(() => 1), { budgetLeftUsd: 0.1, draw: () => 0.9 })
    expect(skipped?.sample).toBe('not-sampled')
    expect(skipped?.outcome).toBe('unknown')
    const drawn = await evaluate(await finishedTask(), scriptedModel(() => 1), { budgetLeftUsd: 0.1, draw: () => 0.1 })
    expect(drawn?.sample).toBe('random')
  })

  it('learning off records the checks only', async () => {
    const model = scriptedModel(() => 1)
    const evaluation = await evaluate(await finishedTask(), model, { mayLearn: false })
    expect(evaluation?.sample).toBe('learning-off')
    expect(model.requests).toHaveLength(0)
  })

  it('never exceeds the per-task ceiling: a request whose worst case is over it is not sent', async () => {
    const model = scriptedModel(() => 1)
    const evaluation = await evaluate(await finishedTask(), model, { estimateUsd: () => 1 })
    expect(model.requests).toHaveLength(0)
    expect(evaluation?.rubric).toBeUndefined()
  })

  it('every request is a learning request of phase self-eval with the task id, thinking off by construction', async () => {
    const task = await finishedTask()
    const model = scriptedModel(() => 1)
    await evaluate(task, model)
    expect(model.requests.map(request => request.phase)).toEqual(['self-eval', 'self-eval'])
    expect(model.requests.every(request => request.taskId === task.taskId)).toBe(true)
    // The rubric request sees the task and its inputs, never the result.
    expect(model.requests[0]!.user).toContain('input.csv')
    expect(model.requests[0]!.user).not.toContain('report.md\n')
    expect(model.requests[0]!.user).not.toContain('Wrote `report.md`')
    expect(model.requests[1]!.user).toContain('## report.md')
  })
})

describe('the rubric is frozen', () => {
  it('a second evaluation returns the stored one without asking the model; new feedback only adds feedback', async () => {
    const task = await finishedTask()
    const first = await evaluate(task, scriptedModel(() => 1))
    const again = scriptedModel(() => 0)
    const second = await evaluate(task, again)
    expect(again.requests).toHaveLength(0)
    expect(second).toEqual(first)
    const store = new JsonlSessionStore({ sessionsDir: task.layout.sessions })
    const lock = await store.lock(task.sessionId)
    await store.append(task.sessionId, { type: 'feedback', turn: 1, feedback: { id: randomUUID(), deliverableId: randomUUID(), version: 1, rating: 1, comment: 'wrong' } })
    await store.release(lock)
    const third = await evaluate(task, again, { turn: 1 })
    expect(again.requests).toHaveLength(0)
    expect(third?.rubric).toEqual(first?.rubric)
    expect(third?.scores).toEqual(first?.scores)
    expect(third?.createdAt).toBe(first?.createdAt)
    expect(third?.outcome).toBe('failure')
    const stored = JSON.parse(await readFile(join(evaluationsDirectory(task.layout), `${task.taskId}.json`), 'utf8')) as SelfEvaluation
    expect(stored.rubric).toEqual(first?.rubric)
  })

  it('the first writer of an evaluation wins', async () => {
    const task = await finishedTask()
    const first = await evaluate(task, scriptedModel(() => 1))
    const kept = await writeEvaluation(evaluationsDirectory(task.layout), { ...first!, outcome: 'failure' })
    expect(kept.outcome).toBe('success')
  })
})

describe('skips', () => {
  it('a gate trial copy is not evaluated', async () => {
    const task = await finishedTask()
    const bundle = await writeBundle(task.layout.capabilities, sampleComponents())
    await new CapabilityStore(task.layout.capabilities).adopt(bundle.version, { trigger: 'manual', detail: 'replay copy for a gate trial' })
    const model = scriptedModel(() => 1)
    expect(await evaluate(task, model)).toBeUndefined()
    expect(model.requests).toHaveLength(0)
    expect(await listEvaluations(evaluationsDirectory(task.layout))).toEqual([])
  })
})

describe('calibration and scorer reliability', () => {
  it('the external reviewer scores the same rubric; agreement is by score band', async () => {
    const agreeing = scriptedModel(() => 1)
    const calibrated = await evaluate(await finishedTask(), agreeing, { calibrationRate: 1 })
    expect(agreeing.requests.map(request => `${request.phase}:${request.model}`)).toEqual(['self-eval:claude-sonnet-5-5', 'self-eval:claude-sonnet-5-5', 'calibrate:claude-opus-5-5'])
    expect(agreeing.requests[2]!.user).toBe(agreeing.requests[1]!.user)
    expect(calibrated?.calibration?.agree).toBe(true)
    expect(calibrated?.calibration?.cost.requestCount).toBe(1)

    const disagreeing = scriptedModel(request => (request.phase === 'calibrate' ? 0 : 1))
    const off = await evaluate(await finishedTask(), disagreeing, { calibrationRate: 1 })
    expect(off?.calibration?.agree).toBe(false)
    expect(off?.calibration?.score).toBeCloseTo(0.5)
  })

  it('calibration waits when the budget left is under one more per-task ceiling', async () => {
    const model = scriptedModel(() => 1)
    const evaluation = await evaluate(await finishedTask(), model, { calibrationRate: 1, budgetLeftUsd: 0.055 })
    expect(evaluation?.calibration).toBeUndefined()
    expect(model.requests.every(request => request.phase === 'self-eval')).toBe(true)
  })

  it('agreement under 80% over at least 10 calibrations is unreliable; the epoch rules then hold skills for the user', async () => {
    const root = await tempDir()
    const directory = join(root, 'evaluations')
    const write = async (agree: boolean) => {
      const base = await evaluate(await finishedTask(), scriptedModel(() => 1))
      await writeEvaluation(directory, { ...base!, taskId: randomUUID(), calibration: { model: 'claude-opus-5-5', score: agree ? 1 : 0.2, agree, at: new Date().toISOString(), cost: { usage: ZERO_USAGE, requestCount: 1, estimatedUsd: 0.01 } } })
    }
    for (let index = 0; index < 5; index += 1) await write(true)
    expect((await scorerReliabilityOf({ directories: [directory] })).status).toBe('insufficient')
    for (let index = 0; index < 2; index += 1) await write(true)
    for (let index = 0; index < 3; index += 1) await write(false)
    const unreliable = await scorerReliabilityOf({ directories: [directory] })
    expect(unreliable).toMatchObject({ sampled: 10, agreed: 7, status: 'unreliable' })

    const adopt: TrialVerdict = { outcome: 'adopt', reason: 'quality-up', passRate: { candidate: 1, baseline: 0.5 }, costRatio: 1, decidedByReview: false }
    expect(epochVerdict(adopt, { kind: 'skill', scorer: unreliable })).toMatchObject({ outcome: 'await-approval', reason: 'scorer-unreliable' })
    expect(epochVerdict(adopt, { kind: 'framework', scorer: unreliable })).toMatchObject({ outcome: 'reject', reason: 'scorer-unreliable' })
    expect(epochVerdict(adopt, { kind: 'user', scorer: unreliable })).toBe(adopt)

    for (let index = 0; index < 10; index += 1) await write(true)
    const reliable = await scorerReliabilityOf({ directories: [directory] })
    expect(reliable.status).toBe('reliable')
    expect(epochVerdict(adopt, { kind: 'skill', scorer: reliable })).toBe(adopt)
  })
})

describe('cost-optimized is not evolution', () => {
  it('a cheaper tie becomes cost-optimized and is counted as saving money only', () => {
    const cheaper: TrialVerdict = { outcome: 'adopt', reason: 'cost-down', passRate: { candidate: 1, baseline: 1 }, costRatio: 0.6, decidedByReview: false }
    expect(epochVerdict(cheaper, { kind: 'skill', scorer: { status: 'reliable' } }).reason).toBe('cost-optimized')
    expect(epochVerdict(cheaper, { kind: 'user', scorer: { status: 'reliable' } }).reason).toBe('cost-down')
    const decisions: Pick<CapabilityDecision, 'outcome' | 'reason'>[] = [
      { outcome: 'adopted', reason: 'quality-up' },
      { outcome: 'adopted', reason: 'cost-optimized' },
      { outcome: 'adopted', reason: 'cost-down' },
      { outcome: 'adopted', reason: 'review-preferred' },
      { outcome: 'rejected', reason: 'quality-down' },
      { outcome: 'adopted', reason: 'manual' },
    ]
    expect(evolutionCount(decisions)).toEqual({ evolutions: 2, costOptimizations: 2 })
  })
})

describe('practice set', () => {
  it('a scored task of a contributing project becomes one case; similar tasks share a cluster and a split', async () => {
    const home = await tempDir()
    const first = await finishedTask({ text: 'Summarize the june sales orders by region into a report with totals' })
    await evaluate(first, scriptedModel(() => 1), { home })
    await evaluate(first, scriptedModel(() => 1), { home })
    const second = await finishedTask({ text: 'Summarize the july sales orders by region into a report with totals' })
    await evaluate(second, scriptedModel(() => 1), { home })
    const other = await finishedTask({ text: 'Write unit tests for the date parser module and fix the failing edge case' })
    await evaluate(other, scriptedModel(() => 1), { home })
    const cases = await listPracticeCases(home, { audience: 'measure' })
    expect(cases).toHaveLength(3)
    const [june, july, tests] = cases
    expect(july!.clusterId).toBe(june!.clusterId)
    expect(july!.split).toBe(june!.split)
    expect(tests!.clusterId).not.toBe(june!.clusterId)
    expect(june!.rubric?.items).toHaveLength(3)
    expect(june!.input?.tree).toMatch(/^[0-9a-f]{64}$/)
    expect(june!.split).toBe(practiceSplit(june!.clusterId))

    const off = await tempDir()
    await evaluate(await finishedTask(), scriptedModel(() => 1), { home: off, learning: { ...LEARNING, contribute: false } })
    expect(await listPracticeCases(off, { audience: 'measure' })).toEqual([])
  })

  it('learners never see holdout or guard cases', async () => {
    const home = await tempDir()
    const evaluation = (await evaluate(await finishedTask(), scriptedModel(() => 1)))!
    const seen = new Set<string>()
    for (let index = 0; index < 40; index += 1) {
      const added = await addPracticeCase(home, { evaluation: { ...evaluation, taskId: randomUUID() }, messages: [`task number ${index} about topic ${randomUUID()}`], tree: 'a'.repeat(64) })
      seen.add(added!.split)
    }
    expect(seen).toEqual(new Set(['train', 'selection', 'holdout']))
    const learner = await listPracticeCases(home)
    const all = await listPracticeCases(home, { audience: 'measure' })
    expect(learner.length).toBeLessThan(all.length)
    expect(learner.every(item => item.split === 'train' || item.split === 'selection')).toBe(true)
    expect(all.some(item => item.split === 'holdout')).toBe(true)
  })

  it('loads the generic guard cases of the measurement once; anything else is refused', async () => {
    const home = await tempDir()
    const module = (await import(pathToFileURL(join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', 'scripts', 'experiment', 'rework', 'cases.mjs')).href)) as { guardPracticeCases: () => PracticeCase[] }
    const guard = module.guardPracticeCases()
    expect(guard.length).toBeGreaterThan(0)
    expect(await loadGenericPracticeCases(home, guard)).toBe(guard.length)
    expect(await loadGenericPracticeCases(home, guard)).toBe(0)
    expect(await listPracticeCases(home)).toEqual([])
    expect((await listPracticeCases(home, { audience: 'measure' })).every(item => item.split === 'guard')).toBe(true)
    await expect(loadGenericPracticeCases(home, [{ ...guard[0]!, id: randomUUID(), split: 'train' }])).rejects.toThrow(/generic guard/)
    await expect(loadGenericPracticeCases(home, [{ ...guard[0]!, source: 'task' }])).rejects.toThrow(/generic guard/)
    expect(practiceCasesDirectory(home)).toContain('practice')
  })

  it('the similarity key is the most frequent terms, lowercase, at most 16', () => {
    const key = similarityKey('Region totals. Region report for REGION sales, totals by month and week and day and year and quarter and team and city and store and product and channel and brand')
    expect(key[0]).toBe('region')
    expect(key.length).toBeLessThanOrEqual(16)
    expect(key.every(term => term === term.toLowerCase())).toBe(true)
  })
})

describe('generic checks', () => {
  it('references in the answer and in text results must exist', async () => {
    const root = await tempDir()
    await mkdir(join(root, 'docs'), { recursive: true })
    await writeFile(join(root, 'docs', 'a.md'), 'See [b](b.md) and `missing.csv`.')
    await writeFile(join(root, 'docs', 'b.md'), 'ok')
    const checks = await genericChecks(root, ['docs/a.md'], 'Wrote `docs/a.md`; see https://example.com/x.md and `npm test`.')
    expect(checks).toEqual([{ name: 'references-exist', passed: false, detail: '1 of 3 referenced files missing' }])
    expect(referencedPaths('`/etc/passwd` `../up.md` `a.b.c` `x.ts`')).toEqual(['a.b.c', 'x.ts'])
  })

  it('a total row must equal the sum of the rows above it', async () => {
    expect(totalsProblem([['k', 'v'], ['a', '1,000'], ['b', '2.5'], ['合计', '1,002.5']])).toEqual({ checked: 1, mismatched: 0 })
    expect(totalsProblem([['k', 'v', 'note'], ['a', '1', 'x'], ['b', '2', 'y'], ['Total', '4', '']])).toEqual({ checked: 1, mismatched: 1 })
    expect(totalsProblem([['k', 'v'], ['a', '1'], ['Subtotal', '1'], ['Total', '1']])).toBeUndefined()
    expect(totalsProblem([['k', 'v'], ['a', '1'], ['b', '2']])).toBeUndefined()
    const root = await tempDir()
    await writeFile(join(root, 'out.csv'), 'k,v\na,1\nb,2\nTotal,4\n')
    const checks: TaskCheck[] = await genericChecks(root, ['out.csv'], 'done')
    expect(checks).toEqual([{ name: 'totals-recompute', passed: false, detail: '1 of 1 total columns do not add up' }])
    expect(await genericChecks(root, [], 'no table, no reference')).toEqual([])
  })
})

describe('models without a no-reasoning mode', () => {
  it('a request refused for thinking off is asked again with thinking on, once', async () => {
    const sent: { thinking: string; effort?: string }[] = []
    const provider = {
      info: { id: 'scripted', endpoint: 'http://localhost', defaultModel: 'claude-opus-5-5' },
      async *complete(request: { thinking: string; effort?: string }) {
        sent.push({ thinking: request.thinking, ...(request.effort === undefined ? {} : { effort: request.effort }) })
        if (request.thinking === 'off') {
          yield { type: 'error', error: { code: 'llm/request-failed', message: 'HTTP 400: "thinking.type.between_tools" is not supported for this model.' }, httpStatus: 400 }
          return
        }
        yield { type: 'text.delta', text: '{"ok":true}' }
        yield { type: 'usage', usage: { ...ZERO_USAGE, inputTokens: 10, outputTokens: 5 } }
        yield { type: 'done', finishReason: 'stop' }
      },
    } as unknown as LLMProvider
    const model = providerSelfEvalModel({ providerFor: () => provider, estimateUsd: () => 0.001 })
    const reply = await model.complete({ phase: 'self-eval', model: 'claude-opus-5-5', system: 's', user: 'u', maxTokens: 100, thinking: 'off', taskId: 't' })
    expect(sent).toEqual([{ thinking: 'off' }, { thinking: 'on', effort: 'low' }])
    expect(reply.failure).toBeUndefined()
    expect(reply.text).toBe('{"ok":true}')
    expect(rejectsThinkingOff('llm/request-failed: HTTP 500: thinking')).toBe(false)
    expect(rejectsThinkingOff('llm/request-failed: HTTP 400: max_tokens too large')).toBe(false)
  })
})
