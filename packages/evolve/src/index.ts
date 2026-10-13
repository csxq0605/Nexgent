/**
 * `@nexgent/evolve`: the default feedback-improvement flow (step 5) —
 * counting feedback and check failures, the three triggers, improvement
 * jobs and their state machine, the job host (detached processes, locks,
 * recovery), the improvement budget, the diagnose session with its four
 * read-only tools, the propose phase (redo the feedback task in a snapshot
 * copy, one candidate with `origin: improvement`), the hand-off to the gate
 * and the first-use record. The host entry supplies the session runner and
 * the gate ({@link createImprovementStages}); without them
 * {@link PENDING_STAGES} ends every job `failed`.
 */
export * from './types.js'
export { improvementsDir } from './paths.js'
export { breakStaleLock, isTransientFsError, lockHeld, processAlive, readLockPid, retryTransient, TRANSIENT_FS_CODES, TRANSIENT_RETRY_DELAYS_MS, tryCreateLock, withFileLock, writeJsonAtomic, type AtomicWriteIo, type FileLockOptions, type LockIo } from './lock.js'
export { clip, createJob, jobAlive, jobPaths, listJobs, readJob, START_GRACE_MS, transitionJob, updateJob, type CreateJobInput, type JobPatch, type JobPaths } from './jobs.js'
export {
  admitItems,
  ensureQueue,
  QUEUE_FILE,
  QUEUE_LOCK,
  readQueue,
  reconcileQueue,
  releaseSlot,
  retakeSlot,
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
export type { ImprovementSession, ImprovementSessionRequest, ImprovementSessionRunner, ImprovementTurnResult } from './session-runner.js'
export {
  checkReport,
  diagnosisNudge,
  diagnosisPrompt,
  diagnosisTools,
  memberCostsFor,
  selectLedger,
  selectRecords,
  sliceLines,
  sumTurns,
  type DiagnosisState,
  type DiagnosisSubject,
  type DiagnosisToolsInput,
} from './diagnosis.js'
export {
  collectCandidate,
  contextPolicyCheckText,
  contextPolicyProposeText,
  pendingContextPolicies,
  proposeRecords,
  findFeedbackTask,
  newSessionId,
  prepareProposalCopy,
  proposalBrief,
  targetSession,
  type FeedbackTask,
  type ProposalOutcome,
} from './propose.js'
export { trialSpend, trialStatus, type GateOutcome, type TrialStarter } from './trial.js'
export { sweepAdoptedJobs } from './first-use.js'
export { createImprovementStages, type ImprovementStagesOptions } from './stages.js'
