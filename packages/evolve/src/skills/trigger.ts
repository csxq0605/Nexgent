/**
 * When layer 2 induces a skill (ADR 0018 decision 5, ADR 0025): after a
 * task was learned from, its group is the project's successful tasks
 * similar to it. A task is successful when its outcome from the user, the
 * checks or the external review (`taskOutcome`, never the same model's
 * self-evaluation) is at least {@link INDUCTION.minScore} and the user did
 * not remove its results. Induction runs when the group has at least
 * {@link INDUCTION.minTasks} tasks, the newest task was never used by an
 * induction, and no learned skill in force already matches the task.
 *
 * Pure; the state of past inductions is `<project data>/learning/skills.json`.
 */
import type { LearnedTask } from '../learning/queue.js'
import { similarity } from '../learning/text.js'

/** Layer-2 induction settings (ADR 0025). */
export const INDUCTION = {
  /** Successful similar tasks a group needs (ADR 0018 decision 5: at least two). */
  minTasks: 2,
  /** External outcome score a task needs to count as successful. */
  minScore: 0.8,
  /** Similarity of task texts that puts two tasks in one group (the practice set's cluster threshold). */
  minSimilarity: 0.25,
  /** Tasks shown to one induction (the newest first). */
  maxTasks: 4,
  /** Budget an induction needs left before it is sent. */
  reserveUsd: 0.1,
  /** Output tokens of the induction request (doubled with thinking). */
  maxTokens: 8000,
  /** Characters of each task's run shown. */
  maxRunChars: 6000,
  /** Refused candidates shown to the next induction. */
  rejectedShown: 10,
  /** Past runs kept in `skills.json`. */
  maxRuns: 50,
} as const

/** A task group to induce from: the task just learned and its similar successful tasks, newest first. */
export interface InductionGroup {
  readonly seed: LearnedTask
  readonly tasks: readonly LearnedTask[]
}

/** What `skills.json` remembers. */
export interface InductionState {
  readonly formatVersion: 1
  /** Task id → when an induction used it. */
  readonly used: Readonly<Record<string, string>>
  /** Past runs, oldest first (at most {@link INDUCTION.maxRuns}). */
  readonly runs: readonly InductionRun[]
}

/** One induction. */
export interface InductionRun {
  readonly at: string
  readonly seedTaskId: string
  readonly taskIds: readonly string[]
  readonly added: readonly string[]
  readonly rejected: Readonly<Record<string, number>>
  readonly usd?: number
  readonly detail?: string
}

/** An empty state. */
export const EMPTY_INDUCTION_STATE: InductionState = { formatVersion: 1, used: {}, runs: [] }

/** Whether a learned task counts as a success for induction. */
export function isSuccessfulTask(task: LearnedTask): boolean {
  return task.status === 'done' && task.reverted !== true && task.task !== '' && task.externalScore !== undefined && task.externalScore >= INDUCTION.minScore
}

function textOf(task: LearnedTask): string {
  return `${task.task} ${task.keywords.join(' ')}`
}

/**
 * The group of the task just learned, or `undefined` when induction should
 * not run for it. `history` is the project's learned tasks in order; only
 * each task's latest entry counts.
 */
export function inductionGroupFor(taskId: string, history: readonly LearnedTask[], state: InductionState): InductionGroup | undefined {
  const latest = new Map<string, LearnedTask>()
  for (const task of history) latest.set(task.taskId, task)
  const seed = latest.get(taskId)
  if (seed === undefined || !isSuccessfulTask(seed) || state.used[taskId] !== undefined) return undefined
  const similar = [...latest.values()]
    .filter(task => task.taskId !== taskId && isSuccessfulTask(task))
    .map(task => ({ task, score: similarity(textOf(seed), textOf(task)) }))
    .filter(candidate => candidate.score >= INDUCTION.minSimilarity)
    .sort((a, b) => (a.task.finishedAt < b.task.finishedAt ? 1 : a.task.finishedAt > b.task.finishedAt ? -1 : 0))
    .map(candidate => candidate.task)
  if (similar.length + 1 < INDUCTION.minTasks) return undefined
  return { seed, tasks: [seed, ...similar].slice(0, INDUCTION.maxTasks) }
}

/** The state after a run (pure). */
export function recordInduction(state: InductionState, run: InductionRun): InductionState {
  const used = { ...state.used }
  for (const id of run.taskIds) used[id] = run.at
  return { formatVersion: 1, used, runs: [...state.runs, run].slice(-INDUCTION.maxRuns) }
}
