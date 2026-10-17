/**
 * ADR 0023 decision 2: the outcome of a root task for the randomized
 * exposure comparison. Only the user's rating, the deterministic checks and
 * the external review on a calibration sample count; the same model's
 * self-evaluation (its rubric scores and the outcome derived from them) is
 * never used. The host writes one `outcome` line per processed turn to
 * every handbook `usage.jsonl` holding a drawn `hit` for the task's root
 * session; a later line for the same session replaces an earlier one, so a
 * rating given after the checks updates it.
 */
import type { Handbook, HandbookUsageInput } from '@nexgent/capabilities'
import type { HandbookOutcomeEvidence, HandbookUsageOutcome, SelfEvalCalibration, TaskCheck } from '@nexgent/kernel'

/** A user rating at or below this is an explicit negative signal. */
export const NEGATIVE_RATING = 2

/** What a task's outcome is computed from. */
export interface TaskOutcomeInput {
  readonly checks: readonly Pick<TaskCheck, 'passed'>[]
  /** The user's latest rating of the task's deliverables (1–5). */
  readonly rating?: number
  /** The external reviewer's score on a calibration sample. */
  readonly calibration?: Pick<SelfEvalCalibration, 'score'>
}

/** The outcome fields of a task, or `undefined` when no counted evidence exists. */
export type TaskOutcome = Pick<HandbookUsageOutcome, 'score' | 'evidence' | 'userNegative'>

/**
 * Pure. The user's rating decides alone when there is one (it outranks the
 * other evidence, ADR 0023 grade 甲): `(rating − 1) / 4`, negative at
 * {@link NEGATIVE_RATING} or below. Otherwise the mean of the check pass
 * rate and the external review score, either alone when the other is
 * missing.
 */
export function taskOutcome(input: TaskOutcomeInput): TaskOutcome | undefined {
  const rating = input.rating
  if (rating !== undefined && Number.isFinite(rating) && rating >= 1 && rating <= 5) {
    const evidence: HandbookOutcomeEvidence[] = ['user-rating']
    if (input.checks.length > 0) evidence.push('check')
    if (input.calibration !== undefined) evidence.push('external-review')
    return { score: (rating - 1) / 4, evidence, userNegative: rating <= NEGATIVE_RATING }
  }
  const parts: number[] = []
  const evidence: HandbookOutcomeEvidence[] = []
  if (input.checks.length > 0) {
    parts.push(input.checks.filter(check => check.passed).length / input.checks.length)
    evidence.push('check')
  }
  const review = input.calibration?.score
  if (review !== undefined && Number.isFinite(review)) {
    parts.push(Math.min(1, Math.max(0, review)))
    evidence.push('external-review')
  }
  if (parts.length === 0) return undefined
  return { score: parts.reduce((a, b) => a + b, 0) / parts.length, evidence }
}

/**
 * Append the task's outcome to each handbook usage file that has a drawn
 * hit for `sessionId`; returns how many files were written. Files without
 * a draw for the session get nothing (no comparison to feed).
 */
export async function writeTaskOutcome(
  handbook: Pick<Handbook, 'projectId' | 'usageLogOf'>,
  input: { readonly sessionId: string; readonly taskId: string; readonly outcome: TaskOutcome },
): Promise<number> {
  let written = 0
  for (const scope of ['project', 'user'] as const) {
    const log = handbook.usageLogOf(scope)
    const records = await log.read()
    const drawn = records.some(record => record.kind === 'hit' && record.sessionId === input.sessionId && (record as { readonly draw?: unknown }).draw !== undefined)
    if (!drawn) continue
    const line: Omit<HandbookUsageOutcome, 'formatVersion' | 'at'> = {
      kind: 'outcome',
      projectId: handbook.projectId,
      sessionId: input.sessionId,
      taskId: input.taskId,
      score: input.outcome.score,
      evidence: input.outcome.evidence,
      ...(input.outcome.userNegative === true ? { userNegative: true } : {}),
    }
    // The capabilities log stamps and appends any line; its input type gains `outcome` with ADR 0023's storage change.
    await log.append([line as unknown as HandbookUsageInput])
    written += 1
  }
  return written
}
