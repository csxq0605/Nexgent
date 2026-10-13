/**
 * `@nexgent/evolve`: the default feedback-improvement flow (step 5) —
 * counting feedback and check failures, the three triggers, improvement
 * jobs and their state machine, the job host (detached processes, locks,
 * recovery) and the improvement budget. Diagnosis and proposal come in
 * round 2; until then {@link PENDING_STAGES} ends every job `failed`.
 */
export * from './types.js'
export { improvementsDir } from './paths.js'
export { breakStaleLock, lockHeld, processAlive, readLockPid, tryCreateLock, withFileLock, writeJsonAtomic, type FileLockOptions } from './lock.js'
export { createJob, jobAlive, jobPaths, listJobs, readJob, START_GRACE_MS, transitionJob, updateJob, type CreateJobInput, type JobPatch, type JobPaths } from './jobs.js'
export {
  admitItems,
  ensureQueue,
  QUEUE_FILE,
  QUEUE_LOCK,
  readQueue,
  reconcileQueue,
  releaseSlot,
  startExplicitJob,
  type AdmitOptions,
  type AdmitResult,
} from './queue.js'
export { billedTokens, budgetStatus, type BudgetStatus } from './budget.js'
export {
  PENDING_STAGES,
  runImprovementJob,
  type DiagnoseResult,
  type ImprovementStages,
  type PhaseSpend,
  type ProposeResult,
  type RunJobOptions,
  type RunJobResult,
  type StageInput,
  type TrialResult,
} from './runner.js'
export {
  countsTowardImprovement,
  feedbackItem,
  ImprovementHost,
  type CheckFailureInput,
  type ImprovementHostConfig,
  type StartedJob,
} from './host.js'
export { apply, EvolvePlugin, feedbackCounter, name, type EvolvePluginConfig } from './plugin.js'
