/**
 * `@nexgent/evolve`. ADR 0018 (rework E1): layer-1 learning after every
 * task — the learning queue in the app process, reflection, deterministic
 * curation, the handbook logs and their lexical retrieval, the dollar
 * learning budget ({@link LearningHost}) — and the layer-2 skill induction.
 */
export { breakStaleLock, isTransientFsError, lockHeld, processAlive, readLockPid, retryTransient, TRANSIENT_FS_CODES, TRANSIENT_RETRY_DELAYS_MS, transientFsCodes, tryCreateLock, withFileLock, writeJsonAtomic, type AtomicWriteIo, type FileLockOptions, type LockIo } from './lock.js'
export { ImprovementHost, type ImprovementHostConfig } from './host.js'
export { apply, EvolvePlugin, name, type EvolvePluginConfig } from './plugin.js'
export { homeOf, readUserConfig } from './user-config.js'
export { LearningHost, learnsFrom, REFLECTION_RESERVE_USD, type LearningHostOptions, type LearningStatus, type TurnEndInput } from './learning/host.js'
export { learningBudgetStatus, recordUsd, type LearningBudgetStatus } from './learning/budget.js'
export { COPIED_REQUEST_CHARS, curateReflection, DUPLICATE_SIMILARITY, MAX_ADDS_PER_REFLECTION, MAX_EDITS_PER_ENTRY, MAX_ENTRY_CHARS, MAX_OPS_PER_REFLECTION, projectNames, quotedRequests, reflectionEdits, ruleStanding, statusReason, votesFromTask, withoutNames, type CurationContext, type CurationRejection, type CurationResult } from './learning/curate.js'
export { COMMENT_SCORE, NEGATIVE_RATING, REVERTED_OUTCOME, revertedTasks, taskOutcome, type TaskFiles, type TaskOutcome, type TaskOutcomeInput } from './learning/outcome.js'
export { parseReflection, REFLECTION_MAX_TOKENS, REFLECTION_PROMPT_VERSION, reflectionSystemPrompt, reflectionUserMessage, type ContrastTask, type ParsedReflection, type ProposedOp, type ReflectionEvaluation, type ReflectionInput } from './learning/reflect.js'
export { readTaskRun, renderTaskRun, RUN_RECORD_LIMITS, taskRunOf, type TaskRun } from './learning/run-record.js'
export { enqueueItem, learningPaths, LEARNING_DIR, MAX_ATTEMPTS, MAX_HISTORY, MAX_PENDING, readLearningQueue, updateLearningQueue, type LearnedStatus, type LearnedTask, type LearningItem, type LearningItemStatus, type LearningQueueFile } from './learning/queue.js'
export { detectLanguage, keywordsOf, languageName, longestSharedRun, similarity, tokenize, type LearningLanguage } from './learning/text.js'
export { EMPTY_INDUCTION_STATE, INDUCTION, inductionGroupFor, isSuccessfulTask, recordInduction, type InductionGroup, type InductionRun, type InductionState } from './skills/trigger.js'
export { INDUCTION_PROMPT_VERSION, inductionSystemPrompt, inductionUserMessage, parseInduction, type InductionInput, type InductionTask, type ParsedInduction, type ProposedSkill } from './skills/induce-prompt.js'
export { curateInduction, type InductionCurationContext, type InductionCurationResult } from './skills/induce-curate.js'
export { INDUCTION_STATE_FILE, induceSkills, inductionStatePath, readInductionState, writeInductionState, type InductionServices } from './skills/induce.js'
