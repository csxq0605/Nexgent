/**
 * The feedback side of the gate (ADR 0006 decision 6, `data-formats.md`
 * §候选与门控 `trial.feedback`). A candidate an improvement job proposed is
 * judged on the job's feedback task: that task goes first in the selection
 * set (the candidate's own `taskId` is the propose session's), it replays up
 * to the turn before its first feedback, and each run of it gets a feedback
 * check: the reviewer model reads the run's output and the feedback text and
 * says whether the problem the feedback names is solved.
 *
 * Which task: the job's first feedback signal's session, else the explicit
 * request's session or task, else the first failed check's task (the same
 * order the job's propose phase used). Which feedback: the job's feedback
 * signals in that session. A job without feedback (only failed checks) gets
 * its task in the selection set and no feedback checks.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { IMPROVEMENT_FILES, IMPROVEMENTS_DIR, type CandidateRecord, type FeedbackEntry, type ImprovementJob, type LLMUsage, type WorkspaceLayout } from '@nexgent/kernel'
import type { ReplayCase, ReplayMessage } from './replay-set.js'

/** Where the gate anchors a candidate's selection set. */
export type SelectionAnchor =
  /** A user task's own candidate (step 4): the proposing task. */
  | { readonly kind: 'task'; readonly caseId: string }
  /** An improvement job's candidate: its feedback task, with the feedback to check (possibly none). */
  | { readonly kind: 'job'; readonly caseId: string; readonly feedback: readonly FeedbackEntry[] }
  /** An improvement job's candidate whose task cannot be replayed: the gate does not run. */
  | { readonly kind: 'missing'; readonly detail: string }

async function readJob(layout: WorkspaceLayout, jobId: string): Promise<ImprovementJob | undefined> {
  try {
    return JSON.parse(await readFile(join(layout.dataDir, IMPROVEMENTS_DIR, jobId, IMPROVEMENT_FILES.job), 'utf8')) as ImprovementJob
  } catch {
    return undefined
  }
}

/** Find the case a candidate's selection set starts with. */
export async function selectionAnchor(layout: WorkspaceLayout, candidate: CandidateRecord, cases: readonly ReplayCase[]): Promise<SelectionAnchor> {
  if (candidate.origin !== 'improvement' || candidate.jobId === undefined) return { kind: 'task', caseId: candidate.taskId }
  const job = await readJob(layout, candidate.jobId)
  if (job === undefined) return { kind: 'missing', detail: `improvement job ${candidate.jobId} of candidate ${candidate.id} cannot be read` }
  const firstFeedback = job.items.find(item => item.kind === 'feedback')
  const failedCheck = job.items.find(item => item.kind === 'check-failure')
  const sessionId = firstFeedback?.sessionId ?? job.request?.sessionId ?? failedCheck?.sessionId
  const taskId = job.request?.taskId ?? failedCheck?.taskId
  const replay = cases.find(item => (sessionId !== undefined && item.sessionId === sessionId) || (taskId !== undefined && item.caseId === taskId))
  if (replay === undefined) {
    return { kind: 'missing', detail: `the task improvement job ${job.id} answers (session ${sessionId ?? taskId ?? '?'}) has no snapshot and per-turn checks before its first feedback, so it cannot be replayed` }
  }
  const ids = new Set(job.items.flatMap(item => (item.kind === 'feedback' && item.sessionId === replay.sessionId ? [item.feedbackId] : [])))
  const feedback = replay.feedback.filter(item => ids.has(item.entry.id)).map(item => item.entry)
  return { kind: 'job', caseId: replay.caseId, feedback }
}

/** One feedback check question. */
export interface FeedbackCheckInput {
  readonly trialId: string
  readonly caseId: string
  readonly arm: 'candidate' | 'baseline'
  readonly repeat: number
  /** The replayed user messages (the task as given). */
  readonly messages: readonly ReplayMessage[]
  /** The feedback the user gave on the original output. */
  readonly feedback: readonly FeedbackEntry[]
  /** What the run created or changed. */
  readonly output: { readonly files: readonly { readonly path: string; readonly text: string }[] }
}

/** The reviewer's answer to a feedback check. */
export interface FeedbackCheckResult {
  /** `pass`: the problem the feedback names is solved; `unknown`: no usable answer. */
  readonly status: 'pass' | 'fail' | 'unknown'
  readonly reason: string
  readonly usage: LLMUsage
  readonly requestCount: number
  /** Display only (`@nexgent/llm` price table); absent counts as `unknown`. */
  readonly estimatedUsd?: number | 'unknown'
}
