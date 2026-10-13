/**
 * Shapes of the improvement flow's files (`docs/plan/step-5-work-partition.md`
 * §触发与作业). Provisional: the step-5 contract (`improvement.ts` in
 * `@nexgent/kernel`, work package W0) is written at the same time; once it
 * lands these types are replaced by imports from the kernel and the field
 * names follow it.
 *
 * Layout under `.nexgent/improvements/`:
 *
 * ```text
 * queue.json            counted item ids, the pending batch, the active job
 * queue.lock            pid of the process updating queue.json (held for milliseconds)
 * <jobId>/job.json      one improvement job
 * <jobId>/job.lock      pid of the process running the job
 * <jobId>/job.log       diagnostics of the job process (host data)
 * ```
 */
import type { FeedbackRating, LLMUsage } from '@nexgent/kernel'

/** Directory name inside `.nexgent/`. */
export const IMPROVEMENTS_DIR = 'improvements'

/** Counted items needed to start a job (plan 4.9 #7). */
export const DEFAULT_THRESHOLD = 3

/** Why a job started. */
export type ImprovementTrigger = 'feedback-count' | 'explicit' | 'check-failure'

/** Where a counted item came from. */
export type QueueItemSource = 'feedback' | 'check-failure'

/** One counted item: a feedback entry or a root task whose checks failed. */
export interface QueueItem {
  /** The feedback id, or `check:<taskId>:<turn>` for a check failure. */
  readonly id: string
  readonly source: QueueItemSource
  readonly sessionId: string
  /** ISO-8601 instant the item happened (feedback `submittedAt`, check time). */
  readonly at: string
  readonly deliverableId?: string
  readonly version?: number
  readonly rating?: FeedbackRating
  readonly taskId?: string
  readonly turn?: number
  /** Names of the failed checks (check failures only). */
  readonly failedChecks?: readonly string[]
}

/** `.nexgent/improvements/queue.json`. */
export interface ImprovementQueue {
  readonly formatVersion: 1
  /** When counting began in this project; earlier feedback is never counted. */
  readonly since: string
  /** Every item id ever counted (so a repeat, another process or a restart never counts it twice). */
  readonly counted: readonly string[]
  /** Counted items not yet handed to a job, oldest first (the next batch). */
  readonly pending: readonly QueueItem[]
  /** The job holding the project's single job slot. */
  readonly activeJobId?: string
}

/** Job states (the partition's state list). */
export type ImprovementJobStatus =
  | 'queued'
  | 'diagnosing'
  | 'proposing'
  | 'trialing'
  | 'adopted'
  | 'rejected'
  | 'awaiting-approval'
  | 'no-proposal'
  | 'waiting-history'
  | 'budget-exhausted'
  | 'failed'
  | 'interrupted'

/** States in which a process is (or is about to be) working on the job; they hold the project's job slot. */
export const RUNNING_STATUSES: ReadonlySet<ImprovementJobStatus> = new Set(['queued', 'diagnosing', 'proposing', 'trialing'])

/** States that wait for something outside the job (history, the user); the slot is free. */
export const PARKED_STATUSES: ReadonlySet<ImprovementJobStatus> = new Set(['waiting-history', 'awaiting-approval'])

/** Final states. */
export const TERMINAL_STATUSES: ReadonlySet<ImprovementJobStatus> = new Set(['adopted', 'rejected', 'no-proposal', 'budget-exhausted', 'failed', 'interrupted'])

/** Allowed moves of the state machine. */
export const JOB_TRANSITIONS: Readonly<Record<ImprovementJobStatus, readonly ImprovementJobStatus[]>> = {
  queued: ['diagnosing', 'budget-exhausted', 'failed', 'interrupted'],
  diagnosing: ['proposing', 'no-proposal', 'budget-exhausted', 'failed', 'interrupted'],
  proposing: ['trialing', 'no-proposal', 'budget-exhausted', 'failed', 'interrupted'],
  trialing: ['adopted', 'rejected', 'awaiting-approval', 'waiting-history', 'budget-exhausted', 'failed', 'interrupted'],
  'waiting-history': ['trialing', 'failed', 'interrupted'],
  'awaiting-approval': ['adopted', 'rejected'],
  adopted: [],
  rejected: [],
  'no-proposal': [],
  'budget-exhausted': [],
  failed: [],
  interrupted: [],
}

/** The three phases a job spends on. */
export type ImprovementPhase = 'diagnose' | 'propose' | 'trial'

/** What one phase spent. */
export interface PhaseCost {
  /** Summed usage of the phase's requests; a field is `'unknown'` once any request did not report it. */
  readonly usage: LLMUsage
  readonly requestCount: number
}

/** What an explicit "改进" names. */
export interface ImprovementRequest {
  readonly sessionId?: string
  readonly deliverableId?: string
  readonly version?: number
  readonly taskId?: string
  /** The user's words, if any. */
  readonly note?: string
}

/** One state change. */
export interface JobHistoryEntry {
  readonly status: ImprovementJobStatus
  readonly at: string
  readonly detail?: string
}

/** `.nexgent/improvements/<jobId>/job.json`. */
export interface ImprovementJob {
  readonly formatVersion: 1
  /** Lowercase UUID v4; also the directory name. */
  readonly id: string
  readonly trigger: ImprovementTrigger
  readonly status: ImprovementJobStatus
  readonly createdAt: string
  readonly updatedAt: string
  /** The counted items this job answers (the batch), oldest first. */
  readonly items: readonly QueueItem[]
  /** What the user named, for an explicit job. */
  readonly request?: ImprovementRequest
  /** Spend per phase; a phase that never ran is absent. */
  readonly phases: Partial<Record<ImprovementPhase, PhaseCost>>
  /** References into `.nexgent/capabilities/` (the job only stores ids). */
  readonly candidateId?: string
  readonly trialId?: string
  readonly decisionId?: string
  /** Why the job ended where it did (failure, rejection, no proposal, budget). */
  readonly detail?: string
  /** Every state, oldest first; the last entry equals `status`. */
  readonly history: readonly JobHistoryEntry[]
}

/** Budget of the improvement flow: tokens per project per rolling window (decision 6). */
export interface ImprovementBudget {
  /** Token limit over the window, covering diagnosis, proposal and trial. */
  readonly tokens: number
  /** Window length in days. */
  readonly windowDays: number
}

/**
 * Default budget until the contract's config field lands. Decision 6 asks
 * for "about 3 USD per project per 30 days"; at the step-1 price basis
 * (2 / 10 / 0.2 / 2.5 USD per million input / output / cache-read /
 * cache-write tokens) and the step-4 mix of mostly cached input, one
 * million tokens is in that range. W0 fixes the real default.
 */
export const DEFAULT_BUDGET: ImprovementBudget = Object.freeze({ tokens: 1_000_000, windowDays: 30 })
