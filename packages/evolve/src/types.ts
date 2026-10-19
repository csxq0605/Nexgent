/**
 * The improvement flow's shapes come from the step-5 contract
 * (`@nexgent/kernel` `improvement.ts`); this module re-exports what the
 * package uses and keeps the round-1 names (`JOB_TRANSITIONS`,
 * `RUNNING_STATUSES`, `PARKED_STATUSES`, `TERMINAL_STATUSES`) as aliases of
 * the contract's, so readers of round 1 keep working.
 */
import {
  DEFAULT_IMPROVEMENT_CONFIG,
  IMPROVEMENT_ACTIVE_STATUSES,
  IMPROVEMENT_FINAL_STATUSES,
  IMPROVEMENT_PARKED_STATUSES,
  IMPROVEMENT_TRANSITIONS,
  type ImprovementSignal,
  type ImprovementStatus,
} from '@nexgent/kernel'

export {
  IMPROVEMENT_FILES,
  IMPROVEMENT_LIMITS,
  IMPROVEMENTS_DIR,
  type Diagnosis,
  type DiagnosisReport,
  type ImprovementBudget,
  type ImprovementConfig,
  type ImprovementJob,
  type ImprovementPhase,
  type ImprovementQueue,
  type ImprovementRequest,
  type ImprovementSignal,
  type ImprovementStatus,
  type ImprovementStatusChange,
  type ImprovementTrigger,
  type PhaseCost,
} from '@nexgent/kernel'

/** A counted signal (round-1 name). */
export type QueueItem = ImprovementSignal

/** Round-1 name of {@link ImprovementStatus}. */
export type ImprovementJobStatus = ImprovementStatus

/** Default counted signals that start a job (`improvement.feedbackThreshold`). */
export const DEFAULT_THRESHOLD: number = DEFAULT_IMPROVEMENT_CONFIG.feedbackThreshold

/** Allowed status moves (the contract's `IMPROVEMENT_TRANSITIONS`). */
export const JOB_TRANSITIONS = IMPROVEMENT_TRANSITIONS

/** Statuses that hold the project's job slot. */
export const RUNNING_STATUSES: ReadonlySet<ImprovementStatus> = new Set(IMPROVEMENT_ACTIVE_STATUSES)

/** Statuses that wait outside the job; the slot is free. */
export const PARKED_STATUSES: ReadonlySet<ImprovementStatus> = new Set(IMPROVEMENT_PARKED_STATUSES)

/** Final statuses. */
export const TERMINAL_STATUSES: ReadonlySet<ImprovementStatus> = new Set(IMPROVEMENT_FINAL_STATUSES)
