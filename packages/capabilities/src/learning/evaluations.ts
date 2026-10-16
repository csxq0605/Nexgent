/**
 * Self-evaluation records (`data-formats.md` §自评, ADR 0018 decision 2):
 * `<projectdata>/evaluations/<taskId>.json`, one per root task of epoch
 * `adr-0019`. The checks, rubric and scores are written once; only the
 * user's feedback, the outcome it decides and a calibration are added later.
 */
import { readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  LEARNING_RULES,
  resolveUserDataLayout,
  rubricScore,
  scorerReliability,
  selfEvalOutcome,
  type ScorerReliability,
  type SelfEvaluation,
  type WorkspaceLayout,
} from '@nexgent/kernel'
import { validateLearningFile } from '@nexgent/session'
import { publishExclusive } from '../activation.js'

/** `evaluations/` of a project's data directory. */
export const EVALUATIONS_DIR = 'evaluations'

/** Where a project's self-evaluations are (`<projectdata>/evaluations/`; before migration `.nexgent/evaluations/`). */
export function evaluationsDirectory(layout: Pick<WorkspaceLayout, 'dataDir'>): string {
  return join(layout.dataDir, EVALUATIONS_DIR)
}

function fileName(taskId: string): string {
  if (!/^[A-Za-z0-9_.-]{1,200}$/.test(taskId) || taskId.startsWith('.')) throw new TypeError(`not a task id: ${taskId}`)
  return `${taskId}.json`
}

function parse(text: string, taskId?: string): SelfEvaluation | undefined {
  try {
    const value = JSON.parse(text) as unknown
    if (validateLearningFile('selfEvaluation', value).length > 0) return undefined
    const evaluation = value as SelfEvaluation
    return taskId === undefined || evaluation.taskId === taskId ? evaluation : undefined
  } catch {
    return undefined
  }
}

/** A task's self-evaluation of the current rules, or `undefined` (none, unreadable, other epoch). */
export async function readEvaluation(directory: string, taskId: string): Promise<SelfEvaluation | undefined> {
  const text = await readFile(join(directory, fileName(taskId)), 'utf8').catch(() => undefined)
  return text === undefined ? undefined : parse(text, taskId)
}

/** Every readable self-evaluation of a directory (current rules only), by `createdAt`. */
export async function listEvaluations(directory: string): Promise<SelfEvaluation[]> {
  let names: string[]
  try {
    names = (await readdir(directory)).filter(name => name.endsWith('.json') && !name.startsWith('.'))
  } catch {
    return []
  }
  const found: SelfEvaluation[] = []
  for (const name of names) {
    const text = await readFile(join(directory, name), 'utf8').catch(() => undefined)
    const evaluation = text === undefined ? undefined : parse(text, name.slice(0, -'.json'.length))
    if (evaluation !== undefined && evaluation.rules === LEARNING_RULES) found.push(evaluation)
  }
  return found.sort((left, right) => (left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : left.taskId < right.taskId ? -1 : 1))
}

/**
 * Write a new evaluation; the first writer wins.
 * @returns the stored evaluation (the given one, or the one already there).
 */
export async function writeEvaluation(directory: string, evaluation: SelfEvaluation): Promise<SelfEvaluation> {
  const issues = validateLearningFile('selfEvaluation', evaluation)
  if (issues.length > 0) throw new TypeError(`invalid self-evaluation: ${issues.map(issue => `${issue.path} ${issue.message}`).join('; ')}`)
  if (await publishExclusive(directory, fileName(evaluation.taskId), `${JSON.stringify(evaluation, null, 2)}\n`)) return evaluation
  return (await readEvaluation(directory, evaluation.taskId)) ?? evaluation
}

async function replace(directory: string, evaluation: SelfEvaluation): Promise<void> {
  const issues = validateLearningFile('selfEvaluation', evaluation)
  if (issues.length > 0) throw new TypeError(`invalid self-evaluation: ${issues.map(issue => `${issue.path} ${issue.message}`).join('; ')}`)
  const temporary = join(directory, `.${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, `${JSON.stringify(evaluation, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    await rename(temporary, join(directory, fileName(evaluation.taskId)))
  } finally {
    await unlink(temporary).catch(() => {})
  }
}

/** The evaluation with `feedback` merged and its outcome recomputed; checks, rubric and scores unchanged. */
export function withFeedback(evaluation: SelfEvaluation, feedback: { readonly feedbackIds: readonly string[]; readonly rating?: 1 | 2 | 3 | 4 | 5 }): SelfEvaluation {
  const ids = [...(evaluation.feedback?.feedbackIds ?? [])]
  for (const id of feedback.feedbackIds) if (!ids.includes(id)) ids.push(id)
  const rating = feedback.rating ?? evaluation.feedback?.rating
  const graded = evaluation.rubric === undefined || evaluation.scores === undefined ? undefined : rubricScore(evaluation.rubric, evaluation.scores)
  const outcome = selfEvalOutcome({
    checks: evaluation.checks,
    rubricScored: graded !== undefined,
    ...(evaluation.score === undefined ? {} : { score: evaluation.score }),
    ...(graded === undefined ? {} : { rubricScore: graded }),
    ...(rating === undefined ? {} : { rating }),
  })
  return { ...evaluation, feedback: { feedbackIds: ids, ...(rating === undefined ? {} : { rating }) }, outcome }
}

/**
 * Merge the user's feedback on a task into its evaluation (a rating of 4–5 is
 * a success, 3 mixed, 1–2 a failure). Nothing else of the record changes.
 * @returns the updated evaluation, or `undefined` when the task has none.
 */
export async function recordEvaluationFeedback(directory: string, taskId: string, feedback: { readonly feedbackIds: readonly string[]; readonly rating?: 1 | 2 | 3 | 4 | 5 }): Promise<SelfEvaluation | undefined> {
  const current = await readEvaluation(directory, taskId)
  if (current === undefined) return undefined
  const next = withFeedback(current, feedback)
  if (JSON.stringify(next) !== JSON.stringify(current)) await replace(directory, next)
  return next
}

/** Add a calibration to an evaluation that has none. */
export async function recordCalibration(directory: string, evaluation: SelfEvaluation, calibration: NonNullable<SelfEvaluation['calibration']>): Promise<SelfEvaluation> {
  const current = (await readEvaluation(directory, evaluation.taskId)) ?? evaluation
  if (current.calibration !== undefined) return current
  const next = { ...current, calibration }
  await replace(directory, next)
  return next
}

/**
 * ADR 0019 decision 6: agreement of the self-scorer with the external
 * reviewer over the calibrated evaluations of the given directories (a
 * project's, or with `home` every project of the user).
 */
export async function scorerReliabilityOf(input: { readonly directories?: readonly string[]; readonly home?: string }): Promise<ScorerReliability> {
  const directories = [...(input.directories ?? [])]
  if (input.home !== undefined) {
    const projects = resolveUserDataLayout(input.home).projects
    for (const name of await readdir(projects).catch(() => [] as string[])) directories.push(join(projects, name, EVALUATIONS_DIR))
  }
  const seen = new Set<string>()
  const samples: { agree: boolean }[] = []
  for (const directory of directories) {
    for (const evaluation of await listEvaluations(directory)) {
      const key = `${evaluation.projectId}/${evaluation.taskId}`
      if (seen.has(key) || evaluation.calibration === undefined) continue
      seen.add(key)
      samples.push({ agree: evaluation.calibration.agree })
    }
  }
  return scorerReliability(samples)
}
