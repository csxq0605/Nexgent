/**
 * `@nexgent/evolve`. ADR 0018 (rework E1): layer-1 learning after every
 * task — the learning queue in the app process, reflection, deterministic
 * curation, the handbook logs and their lexical retrieval, the dollar
 * learning budget ({@link LearningHost}). The step-5/6 job machinery below
 * stays for explicit runs and for reading old jobs; its counting path is
 * retired (`legacyCounting`).
 *
 * Step 5/6: the feedback-improvement flow —
 * counting feedback and check failures, the three triggers, improvement
 * jobs and their state machine, the job host (detached processes, locks,
 * recovery), the improvement budget, the diagnose session with its four
 * read-only tools, the propose phase (redo the feedback task in a snapshot
 * copy, one candidate with `origin: improvement`), the hand-off to the gate
 * and the first-use record. The host entry supplies the session runner and
 * the gate ({@link createImprovementStages}); without them
 * {@link PENDING_STAGES} ends every job `failed`. Step 6: every job runs on
 * the improver it pinned when it started ({@link ImproverSource}); meta jobs
 * ({@link createMetaStages}) improve the improver. ADR 0012: the improver,
 * the meta queue, the meta settings and the meta budget are the user's
 * (below the Nexgent home, `user.ts`).
 */
export * from './types.js'
export { improvementsDir } from './paths.js'
export { breakStaleLock, isTransientFsError, lockHeld, processAlive, readLockPid, retryTransient, TRANSIENT_FS_CODES, TRANSIENT_RETRY_DELAYS_MS, transientFsCodes, tryCreateLock, withFileLock, writeJsonAtomic, type AtomicWriteIo, type FileLockOptions, type LockIo } from './lock.js'
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
  LEGACY_COUNTING_ENV,
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
export { adoptedCapabilities, adoptedSection, type AdoptedCapabilities, type AdoptedComponent } from './adopted.js'
export { createImprovementStages, type ImprovementStagesOptions } from './stages.js'
export { jobImproverVersion, pinnedSource, PROJECT_IMPROVERS, trialComparison, type ImproverSource, type PinnedImprover } from './improver.js'
export {
  countFinishedJobForUser,
  ensureUserQueue,
  homeOf,
  metaProjects,
  projectJobs,
  projectShares,
  readUserConfig,
  readUserQueue,
  reconcileUserQueue,
  releaseUserMeta,
  startExplicitUserMetaJob,
  userImprovementsDir,
  userImprovers,
  userImproversDir,
  userMetaBudgetStatus,
  userMetaJobs,
  userProjectId,
  type MetaProject,
  type ProjectJob,
  type UserCountOptions,
} from './user.js'
export { literalEvidence, MAX_FILE_BYTES, type LiteralEvidence } from './literals.js'
export {
  createMetaStages,
  fixedImprover,
  metaDiagnosisPrompt,
  metaProposePrompt,
  chooseOrigin,
  chooseOriginIn,
  feedbackTaskVersion,
  jobStartVersion,
  originOf,
  sourceJob,
  type OriginChoice,
  type OriginProject,
  type ArmJobRunner,
  type CompareResult,
  type MetaDiagnoseResult,
  type MetaProposeResult,
  type MetaStageInput,
  type MetaStages,
  type MetaStagesOptions,
} from './meta.js'
export { finishedStatusCounts, metaDiagnosisTools, metaProposeTools, type MetaChangeState, type MetaDiagnosisState } from './meta-tools.js'
export { LearningHost, learnsFrom, REFLECTION_RESERVE_USD, type LearningHostOptions, type LearningStatus, type TurnEndInput } from './learning/host.js'
export { learningBudgetStatus, recordUsd, type LearningBudgetStatus } from './learning/budget.js'
export { COPIED_REQUEST_CHARS, curateReflection, DUPLICATE_SIMILARITY, MAX_ADDS_PER_REFLECTION, MAX_EDITS_PER_ENTRY, MAX_ENTRY_CHARS, MAX_OPS_PER_REFLECTION, projectNames, quotedRequests, reflectionEdits, statusReason, votesFromTask, type CurationContext, type CurationRejection, type CurationResult } from './learning/curate.js'
export { COMMENT_SCORE, NEGATIVE_RATING, REVERTED_OUTCOME, revertedTasks, taskOutcome, type TaskFiles, type TaskOutcome, type TaskOutcomeInput } from './learning/outcome.js'
export { parseReflection, REFLECTION_MAX_TOKENS, REFLECTION_PROMPT_VERSION, reflectionSystemPrompt, reflectionUserMessage, type ContrastTask, type ParsedReflection, type ProposedOp, type ReflectionEvaluation, type ReflectionInput } from './learning/reflect.js'
export { readTaskRun, renderTaskRun, RUN_RECORD_LIMITS, taskRunOf, type TaskRun } from './learning/run-record.js'
export { enqueueItem, learningPaths, LEARNING_DIR, MAX_ATTEMPTS, MAX_HISTORY, MAX_PENDING, readLearningQueue, updateLearningQueue, type LearnedStatus, type LearnedTask, type LearningItem, type LearningItemStatus, type LearningQueueFile } from './learning/queue.js'
export { detectLanguage, keywordsOf, languageName, longestSharedRun, similarity, tokenize, type LearningLanguage } from './learning/text.js'
