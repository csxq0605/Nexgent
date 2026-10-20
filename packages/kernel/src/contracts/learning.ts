/**
 * ADR 0017 decision 3, ADR 0018 decisions 2, 3, 8, 10 and ADR 0019: the
 * shared ruler of background learning. Every root task gets a
 * self-evaluation (deterministic checks first, then a frozen rubric scored by
 * the execution model, the user's own rating weighing most); learning spends
 * from a per-project dollar budget, after the user was told once.
 *
 * Pure: shapes, defaults and the decision helpers. `@nexgent/capabilities`
 * writes evaluations; `@nexgent/evolve` spends the budget.
 *
 * Normative text: `docs/spec/data-formats.md` §自评, §项目配置文件;
 * `docs/spec/permissions.md` §学习与学习预算.
 */
import { NexgentError } from './errors.js'
import type { LLMUsage, ThinkingMode } from './llm.js'
import type { TaskCheck } from './ledger.js'

// ---------------------------------------------------------------------------
// Rules id
// ---------------------------------------------------------------------------

/**
 * ADR 0019 decision 7: the evaluation rules this file fixes (score
 * combination, outcome thresholds, reliability threshold); a
 * self-evaluation records it so evaluations under different rules are never
 * mixed.
 */
export const LEARNING_RULES = 'adr-0019'

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** A dollar budget over a rolling window. */
export interface DollarBudget {
  /** Estimated USD (price table, cache included); 0 means nothing may be spent. */
  readonly maxUsd: number
  /** Rolling window in days, by ledger `ts`; 1–365. */
  readonly windowDays: number
}

/**
 * `.nexgent/config.json` `learning` (project-level). Changing it always
 * needs approval (`GUARDED_PROJECT_CONFIG_FIELDS`).
 */
export interface LearningConfig {
  /**
   * Whether this project self-evaluates and learns in the background
   * (ADR 0017 decision 3); default `true`.
   */
  readonly enabled: boolean
  /** Background learning, self-evaluation included (ADR 0018 decision 10); default 3 USD per 30 days. */
  readonly budget: DollarBudget
  /** Ceiling of one task's self-evaluation (ADR 0018 decision 2); default 0.05 USD. */
  readonly selfEvalMaxUsd: number
  /** ADR 0018 decision 8: use the user's shared handbook entries; default `true`. */
  readonly useShared: boolean
  /**
   * ADR 0018 decision 8: contribute this project's handbook entries to the
   * user level; default `true`.
   */
  readonly contribute: boolean
  /** Model of the background requests (reflection); default `claude-sonnet-5-5`. */
  readonly model: string
  /** Thinking of those requests; default `'on'`. */
  readonly thinking: ThinkingMode
}

/** Defaults of {@link LearningConfig}. */
export const DEFAULT_LEARNING_CONFIG: LearningConfig = Object.freeze({
  enabled: true,
  budget: Object.freeze({ maxUsd: 3, windowDays: 30 }),
  selfEvalMaxUsd: 0.05,
  useShared: true,
  contribute: true,
  model: 'claude-sonnet-5-5',
  thinking: 'on' as ThinkingMode,
}) as LearningConfig

/** Bounds the validator enforces. */
export const LEARNING_LIMITS = {
  maxBudgetUsd: 1000,
  maxWindowDays: 365,
  maxSelfEvalUsd: 5,
} as const

/** A partial `learning` object as written in the config file. */
export interface LearningConfigInput {
  readonly enabled?: boolean
  readonly budget?: Partial<DollarBudget>
  readonly selfEvalMaxUsd?: number
  readonly useShared?: boolean
  readonly contribute?: boolean
  readonly model?: string
  readonly thinking?: ThinkingMode
}

/** Fill a validated partial `learning` with defaults (pure). */
export function resolveLearningConfig(input: LearningConfigInput = {}): LearningConfig {
  const d = DEFAULT_LEARNING_CONFIG
  return {
    enabled: input.enabled ?? d.enabled,
    budget: { maxUsd: input.budget?.maxUsd ?? d.budget.maxUsd, windowDays: input.budget?.windowDays ?? d.budget.windowDays },
    selfEvalMaxUsd: input.selfEvalMaxUsd ?? d.selfEvalMaxUsd,
    useShared: input.useShared ?? d.useShared,
    contribute: input.contribute ?? d.contribute,
    model: input.model ?? d.model,
    thinking: input.thinking ?? d.thinking,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** A finite number within `[min, max]`. */
function inRange(value: unknown, min: number, max: number): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
}

/**
 * Validate a `learning` object as read from disk (pure).
 * @throws `config/invalid` with `details.field` naming the field path (`learning.…`).
 */
export function assertLearningConfig(value: unknown): asserts value is LearningConfigInput {
  const fail = (field: string, message: string): never => {
    throw new NexgentError('config/invalid', `.nexgent/config.json: learning.${field} ${message}`, { details: { field: `learning.${field}` } })
  }
  if (!isRecord(value)) {
    throw new NexgentError('config/invalid', '.nexgent/config.json: learning must be an object', { details: { field: 'learning' } })
  }
  // `skills` switched the removed skill library; older files may still carry it and it is ignored.
  for (const key of Object.keys(value)) if (!['enabled', 'budget', 'selfEvalMaxUsd', 'useShared', 'contribute', 'model', 'thinking', 'skills'].includes(key)) fail(key, 'is not a known field')
  for (const key of ['enabled', 'useShared', 'contribute'] as const) {
    if (value[key] !== undefined && typeof value[key] !== 'boolean') fail(key, 'must be a boolean')
  }
  if (value.model !== undefined && (typeof value.model !== 'string' || value.model === '')) fail('model', 'must be a non-empty string')
  if (value.thinking !== undefined && value.thinking !== 'on' && value.thinking !== 'off') fail('thinking', 'must be "on" or "off"')
  if (value.selfEvalMaxUsd !== undefined && !inRange(value.selfEvalMaxUsd, 0, LEARNING_LIMITS.maxSelfEvalUsd)) fail('selfEvalMaxUsd', `must be a number from 0 to ${LEARNING_LIMITS.maxSelfEvalUsd}`)
  if (value.budget !== undefined) checkDollarBudget(value.budget, (field, message) => fail(`budget${field === '' ? '' : `.${field}`}`, message))
}

/** Validate a {@link DollarBudget} input; `fail` receives the sub-field ('' for the object itself). */
export function checkDollarBudget(value: unknown, fail: (field: string, message: string) => never): asserts value is Partial<DollarBudget> {
  if (!isRecord(value)) fail('', 'must be an object')
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) if (key !== 'maxUsd' && key !== 'windowDays') fail(key, 'is not a known field')
  if (record.maxUsd !== undefined && !inRange(record.maxUsd, 0, LEARNING_LIMITS.maxBudgetUsd)) fail('maxUsd', `must be a number from 0 to ${LEARNING_LIMITS.maxBudgetUsd}`)
  if (record.windowDays !== undefined && !(Number.isInteger(record.windowDays) && inRange(record.windowDays, 1, LEARNING_LIMITS.maxWindowDays))) {
    fail('windowDays', `must be an integer from 1 to ${LEARNING_LIMITS.maxWindowDays}`)
  }
}

/**
 * `<NEXGENT_HOME>/config.json` `learning` (user-level, ADR 0017 decision 3):
 * the one-time notice. No learning spend happens on this machine before
 * `noticeAcknowledgedAt` is set.
 */
export interface UserLearningSettings {
  /** ISO-8601 UTC when the user acknowledged the learning notice; absent = not yet. */
  readonly noticeAcknowledgedAt?: string
}

/** Whether background learning may spend for a project (pure): enabled there and the notice acknowledged. */
export function mayLearn(project: Pick<LearningConfig, 'enabled'>, user: UserLearningSettings): boolean {
  return project.enabled && user.noticeAcknowledgedAt !== undefined
}

// ---------------------------------------------------------------------------
// Spend attribution
// ---------------------------------------------------------------------------

/** What a learning request was for (ledger `learningPhase`). */
export type LearningPhase = 'self-eval' | 'calibrate' | 'reflect' | 'curate'

/** Every {@link LearningPhase}. */
export const LEARNING_PHASES: readonly LearningPhase[] = ['self-eval', 'calibrate', 'reflect', 'curate']

/** Spend of a learning step: summed usage, request count and display dollars. */
export interface LearningCost {
  readonly usage: LLMUsage
  readonly requestCount: number
  /** From the price table; `unknown` when any usage or price is. */
  readonly estimatedUsd: number | 'unknown'
}

// ---------------------------------------------------------------------------
// Self-evaluation (ADR 0018 decision 2)
// ---------------------------------------------------------------------------

/** One rubric item: a checkable property of a good result for this task. */
export interface RubricItem {
  /** `r1`, `r2`, … in order. */
  readonly id: string
  /** At most {@link SELF_EVAL_LIMITS.maxRubricItemChars} characters, in the task's language. */
  readonly text: string
  /** 1–3, default 1. */
  readonly weight?: number
}

/**
 * A rubric, generated once at task end from the task text and its inputs
 * and frozen: neither the host nor any learner rewrites it (ADR 0019
 * decision 7).
 */
export interface Rubric {
  readonly items: readonly RubricItem[]
  /** Model that wrote it (default the execution model). */
  readonly model: string
  /** ISO-8601 UTC. */
  readonly createdAt: string
  /** Version of the generation instructions (the improver's learnable part, ADR 0018 decision 7; `v0` until C2). */
  readonly generator: string
}

/** One item's score. */
export interface RubricScore {
  readonly itemId: string
  /** 0 not met, 0.5 partly, 1 met. */
  readonly score: 0 | 0.5 | 1
  /** At most {@link SELF_EVAL_LIMITS.maxNoteChars} characters. */
  readonly note?: string
}

/** Why a task was (or was not) scored with its rubric (ADR 0018 decision 2 priorities). */
export type SelfEvalSample = 'user-feedback' | 'check-failed' | 'random' | 'not-sampled' | 'budget-exhausted' | 'learning-off'

/** Every {@link SelfEvalSample}. */
export const SELF_EVAL_SAMPLES: readonly SelfEvalSample[] = ['user-feedback', 'check-failed', 'random', 'not-sampled', 'budget-exhausted', 'learning-off']

/** What a self-evaluation concludes. */
export type SelfEvalOutcome = 'success' | 'mixed' | 'failure' | 'unknown'

/** Every {@link SelfEvalOutcome}. */
export const SELF_EVAL_OUTCOMES: readonly SelfEvalOutcome[] = ['success', 'mixed', 'failure', 'unknown']

/** One external-review calibration of a self-evaluation (ADR 0019 decision 6). */
export interface SelfEvalCalibration {
  /** The external reviewer (default `claude-opus-5-5`). */
  readonly model: string
  /** The reviewer's combined score with the same rubric and checks. */
  readonly score: number
  /** Whether both scorers lead to the same {@link selfEvalOutcome} (without a rating). */
  readonly agree: boolean
  readonly at: string
  readonly cost: LearningCost
}

/**
 * `<projectdata>/evaluations/<taskId>.json`: the self-evaluation of one root
 * task. The checks, rubric and scores are written once; `feedback`,
 * `outcome` and `calibration` may be added later (the user rated the task,
 * a calibration sample ran).
 */
export interface SelfEvaluation {
  readonly formatVersion: 1
  readonly rules: typeof LEARNING_RULES
  readonly projectId: string
  readonly taskId: string
  /** The root session. */
  readonly sessionId: string
  /** Last root turn evaluated. */
  readonly turn: number
  readonly createdAt: string
  /** Deterministic checks (no model spend; always run when learning is on). */
  readonly checks: readonly TaskCheck[]
  readonly sample: SelfEvalSample
  /** Present when scored. */
  readonly rubric?: Rubric
  readonly scores?: readonly RubricScore[]
  /** Model that scored (default the execution model). */
  readonly scorer?: string
  /** User feedback on the task's deliverables, latest rating last. */
  readonly feedback?: { readonly feedbackIds: readonly string[]; readonly rating?: 1 | 2 | 3 | 4 | 5 }
  /** {@link combineScore}; absent when neither checks nor scores exist. */
  readonly score?: number
  readonly outcome: SelfEvalOutcome
  /** Rubric generation and scoring spend (learning budget). */
  readonly cost: LearningCost
  readonly calibration?: SelfEvalCalibration
}

/** Bounds of self-evaluation records. */
export const SELF_EVAL_LIMITS = {
  maxRubricItems: 12,
  maxRubricItemChars: 300,
  maxNoteChars: 300,
} as const

/** Combined score at or above which a task without a rating counts as a success. */
export const SUCCESS_SCORE = 0.8
/** Combined score below which a task without a rating counts as a failure. */
export const FAILURE_SCORE = 0.5

/** Weighted rubric score (0–1), or `undefined` with no scored item. */
export function rubricScore(rubric: Pick<Rubric, 'items'>, scores: readonly RubricScore[]): number | undefined {
  let total = 0
  let weights = 0
  for (const item of rubric.items) {
    const scored = scores.find(score => score.itemId === item.id)
    if (scored === undefined) continue
    const weight = item.weight ?? 1
    total += scored.score * weight
    weights += weight
  }
  return weights === 0 ? undefined : total / weights
}

/**
 * ADR 0019 decision 1 (pure), fixed for epoch `adr-0019`: the mean of the
 * deterministic check pass rate and the weighted rubric score; either one
 * alone when the other is missing; `undefined` with neither.
 */
export function combineScore(checks: readonly Pick<TaskCheck, 'passed'>[], rubric?: Pick<Rubric, 'items'>, scores?: readonly RubricScore[]): number | undefined {
  const checkRate = checks.length === 0 ? undefined : checks.filter(check => check.passed).length / checks.length
  const graded = rubric === undefined || scores === undefined ? undefined : rubricScore(rubric, scores)
  if (checkRate !== undefined && graded !== undefined) return (checkRate + graded) / 2
  return checkRate ?? graded
}

/** The band of a combined score: the unit of agreement between scorers. */
export function scoreBand(score: number): Exclude<SelfEvalOutcome, 'unknown'> {
  return score >= SUCCESS_SCORE ? 'success' : score < FAILURE_SCORE ? 'failure' : 'mixed'
}

/**
 * The outcome of a task (pure). The user's rating decides when present
 * (4–5 success, 3 mixed, 1–2 failure); otherwise a failed deterministic
 * check is a failure, and a score decides by {@link scoreBand}: the rubric
 * score when given ({@link rubricScore}), else the combined score. Checks
 * that all passed say nothing about the rubric's items, so averaging them in
 * would let a result that misses a weighted requirement reach success.
 * Passing checks alone, without a rubric score, prove nothing: `unknown`.
 */
export function selfEvalOutcome(input: { readonly checks: readonly Pick<TaskCheck, 'passed'>[]; readonly rubricScored: boolean; readonly score?: number; readonly rubricScore?: number; readonly rating?: number }): SelfEvalOutcome {
  if (input.rating !== undefined) return input.rating >= 4 ? 'success' : input.rating <= 2 ? 'failure' : 'mixed'
  if (input.checks.some(check => !check.passed)) return 'failure'
  if (!input.rubricScored || input.score === undefined) return 'unknown'
  return scoreBand(input.rubricScore ?? input.score)
}

/** Remaining budget at or above this many per-task ceilings scores every task. */
export const SELF_EVAL_COMFORT_FACTOR = 10
/** Below the comfort level, the share of tasks without feedback or failed checks that are still scored. */
export const SELF_EVAL_RANDOM_RATE = 0.25

/**
 * ADR 0018 decision 2 (pure): whether to score a task with its rubric. With
 * a comfortable budget every task is scored (`random` stands for "no
 * priority"); with a tight one, tasks with user feedback, then tasks with a
 * failed check, then a {@link SELF_EVAL_RANDOM_RATE} share of the rest (by
 * `draw` in `[0, 1)`); below one per-task ceiling nothing is scored.
 * Deterministic checks run regardless.
 */
export function selfEvalSample(input: {
  readonly learning: boolean
  readonly hasFeedback: boolean
  readonly checkFailed: boolean
  readonly budgetLeftUsd: number
  readonly perTaskMaxUsd: number
  readonly draw: number
}): SelfEvalSample {
  if (!input.learning) return 'learning-off'
  if (input.budgetLeftUsd < input.perTaskMaxUsd) return 'budget-exhausted'
  if (input.hasFeedback) return 'user-feedback'
  if (input.checkFailed) return 'check-failed'
  if (input.budgetLeftUsd >= input.perTaskMaxUsd * SELF_EVAL_COMFORT_FACTOR || input.draw < SELF_EVAL_RANDOM_RATE) return 'random'
  return 'not-sampled'
}

// ---------------------------------------------------------------------------
// Scorer reliability (ADR 0019 decision 6)
// ---------------------------------------------------------------------------

/** Agreement rate below which the scorer is unreliable. */
export const SCORER_AGREEMENT_THRESHOLD = 0.8
/** Calibrations needed before the rate is judged. */
export const MIN_CALIBRATION_SAMPLES = 10
/** Default share of scored tasks that also get an external calibration. */
export const CALIBRATION_SAMPLE_RATE = 0.1
/**
 * Share of scored tasks with no other outcome signal (no test command ran,
 * no feedback) that get the external review: their outcome would otherwise
 * be unknown, so they are reviewed more often (organization library, ADR
 * 0023 outcomes). The review is the same calibration request.
 */
export const UNSIGNALLED_REVIEW_RATE = 0.3

/** How far the self-scorer can be trusted. */
export type ScorerReliabilityStatus = 'reliable' | 'unreliable' | 'insufficient'

/** Agreement of self-evaluation with the external reviewer over calibrated samples. */
export interface ScorerReliability {
  readonly sampled: number
  readonly agreed: number
  /** `agreed / sampled`; absent with no sample. */
  readonly rate?: number
  readonly status: ScorerReliabilityStatus
}

/**
 * ADR 0019 decision 6 (pure). `insufficient` below
 * {@link MIN_CALIBRATION_SAMPLES} samples.
 */
export function scorerReliability(samples: readonly Pick<SelfEvalCalibration, 'agree'>[]): ScorerReliability {
  const sampled = samples.length
  const agreed = samples.filter(sample => sample.agree).length
  if (sampled === 0) return { sampled, agreed, status: 'insufficient' }
  const rate = agreed / sampled
  const status: ScorerReliabilityStatus = sampled < MIN_CALIBRATION_SAMPLES ? 'insufficient' : rate >= SCORER_AGREEMENT_THRESHOLD ? 'reliable' : 'unreliable'
  return { sampled, agreed, rate, status }
}
