/**
 * ADR 0023 decision 2: the outcome of a root task for the randomized
 * exposure comparison. Only the user's signals, the deterministic checks
 * and the external review on a calibration sample count; the same model's
 * self-evaluation (its rubric scores and the outcome derived from them) is
 * never used. The host hands the outcome to `Handbook.recordOutcome`
 * (`@nexgent/capabilities`), which writes it where the task's session was
 * drawn; a later outcome for the same session replaces an earlier one.
 *
 * The user's signals, strongest first:
 * - **Revert** ({@link revertedTasks}): every file a task presented as its
 *   result is gone from the project, and no Nexgent turn deleted it. Score
 *   0, a negative signal.
 * - **Rating**: the latest rating, `(rating − 1) / 4`, negative at
 *   {@link NEGATIVE_RATING} or below.
 * - **Comment without a rating**: the latest feedback asks for a change
 *   without rating the result. Counted like a middle rating
 *   ({@link COMMENT_SCORE}), the same as the feedback the improvement flow
 *   counts (`isCountedFeedback`); not a negative signal, since a comment can
 *   ask for a small change to a good result.
 * - Without a user signal: the mean of the check pass rate and the
 *   external review score, either alone when the other is missing.
 */
import type { HandbookOutcomeEvidence, HandbookUsageOutcome, SelfEvalCalibration, TaskCheck } from '@nexgent/kernel'

/** A user rating at or below this is an explicit negative signal. */
export const NEGATIVE_RATING = 2
/** The score of feedback that comments without rating (a middle rating, 3 of 5). */
export const COMMENT_SCORE = 0.5

/** What a task's outcome is computed from. */
export interface TaskOutcomeInput {
  readonly checks: readonly Pick<TaskCheck, 'passed'>[]
  /** The user's latest rating of the task's deliverables (1–5). */
  readonly rating?: number
  /** The latest feedback is a comment without a rating. */
  readonly commentOnly?: boolean
  /** The external reviewer's score on a calibration sample. */
  readonly calibration?: Pick<SelfEvalCalibration, 'score'>
}

/** The outcome fields of a task. */
export type TaskOutcome = Pick<HandbookUsageOutcome, 'score' | 'evidence' | 'userNegative'>

/** The outcome of a reverted task. */
export const REVERTED_OUTCOME: TaskOutcome = { score: 0, evidence: ['user-revert'], userNegative: true }

/** Pure: the task's outcome, or `undefined` when no counted evidence exists. */
export function taskOutcome(input: TaskOutcomeInput): TaskOutcome | undefined {
  const review = input.calibration?.score !== undefined && Number.isFinite(input.calibration.score) ? Math.min(1, Math.max(0, input.calibration.score)) : undefined
  const context: HandbookOutcomeEvidence[] = [...(input.checks.length > 0 ? ['check' as const] : []), ...(review === undefined ? [] : ['external-review' as const])]
  const rating = input.rating
  if (input.commentOnly === true) return { score: COMMENT_SCORE, evidence: ['user-comment', ...context], userNegative: false }
  if (rating !== undefined && Number.isFinite(rating) && rating >= 1 && rating <= 5) {
    return { score: (rating - 1) / 4, evidence: ['user-rating', ...context], userNegative: rating <= NEGATIVE_RATING }
  }
  const parts: number[] = []
  if (input.checks.length > 0) parts.push(input.checks.filter(check => check.passed).length / input.checks.length)
  if (review !== undefined) parts.push(review)
  if (parts.length === 0) return undefined
  return { score: parts.reduce((a, b) => a + b, 0) / parts.length, evidence: context }
}

/** What a learned task left in the project, as far as reverting goes. */
export interface TaskFiles {
  readonly taskId: string
  /** Project-relative files the task presented as its result and did not delete itself. */
  readonly outputs?: readonly string[]
  /** Project-relative files the task's turns deleted. */
  readonly deleted?: readonly string[]
  readonly reverted?: boolean
}

/**
 * Pure: the tasks, oldest first, whose presented files are all gone while
 * no later task deleted any of them (only each task's latest entry counts). `exists` says whether a
 * project-relative path is still there; `tasks` is the project's learned
 * history in order.
 */
export function revertedTasks<T extends TaskFiles>(tasks: readonly T[], exists: (path: string) => boolean): T[] {
  const out: T[] = []
  const latest = new Map(tasks.map((task, index) => [task.taskId, index]))
  tasks.forEach((task, index) => {
    // A task learned over several turns: its latest entry describes it.
    if (latest.get(task.taskId) !== index) return
    if (task.reverted === true || task.outputs === undefined || task.outputs.length === 0) return
    const laterDeleted = new Set(tasks.slice(index + 1).flatMap(later => later.deleted ?? []))
    if (task.outputs.every(path => !exists(path) && !laterDeleted.has(path))) out.push(task)
  })
  return out
}
