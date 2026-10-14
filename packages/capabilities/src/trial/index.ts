/**
 * The gate `capability_trial` (W3): replay sets, paired runs in snapshot
 * copies, receipts, the verdict and its decision, the usage-regression
 * watch, interrupted-trial recovery and the host side that starts trials.
 */
import type { CapabilityDecision, Context, LedgerRecordInput } from '@nexgent/kernel'
import type { GateHost } from './host.js'

export { runCheckSpecs, type RunChecksOptions } from './checks.js'
export {
  bothOrders,
  OUTPUT_CHARS,
  OUTPUT_FILES,
  OUTPUT_PATHS,
  runGate,
  runOutput,
  type GateOptions,
  type GateResult,
  type ReplayRunRequest,
  type ReplayRunResult,
  type ReviewInput,
  type ReviewResult,
  type RunOutput,
  type TrialReviewer,
  type TrialRunner,
} from './gate.js'
export { GateHost, type GateHostConfig, type StartedGate } from './host.js'
export { processReplayRunner, REPLAY_RESULT_PREFIX, type ProcessRunnerOptions } from './process-runner.js'
export {
  claimAttempt,
  listTrials,
  readTrialReceipts,
  releaseTrialLock,
  trialRunning,
  TrialReceiptWriter,
  TRIALS_DIR,
  wasAttempted,
  writeTrialLock,
  type ReceiptInput,
  type TrialSummary,
} from './receipts.js'
export { candidateRunAttribution, jobRunAttribution, readImprovementJob, selectionAnchor, type FeedbackCheckInput, type FeedbackCheckResult, type JobRunAttribution, type SelectionAnchor } from './feedback.js'
export { assertSameEpoch, evaluatorEpoch, projectEpoch, trialEpoch } from './epoch.js'
export { contentSimilarity, FUNCTION_WORDS, isSimilarTask, SIMILAR_CASE_MIN } from './similar.js'
export { candidateComponentTexts, candidateInstanceLiterals, jobLiteralSources, LITERAL_TEXT_LIMIT, projectTaskMessages } from './literals.js'
export { recoverInterruptedTrials } from './recover.js'
export { prepareReplayProject, writeSnapshotTree, type ReplayProject, type ReplayProjectInput } from './replay-project.js'
export { directoryBytes, KEEP_COPY_MAX_BYTES, prepareProjectCopy, type CopyRelease, type ProjectCopy, type ProjectCopyInput } from './project-copy.js'
export { assertDisjoint, buildReplaySet, listReplayCases, similarity, type CaseFeedback, type ReplayCase, type ReplayMessage, type ReplaySetResult } from './replay-set.js'
export { checkUsageRegression, type PendingOutcome, type UsageWatchOptions } from './usage.js'

/** The ledger's `capability.decision` line for a decision. */
export function decisionLedgerRecord(decision: CapabilityDecision): LedgerRecordInput {
  return {
    type: 'capability.decision',
    decisionId: decision.id,
    outcome: decision.outcome,
    reason: decision.reason,
    trigger: decision.trigger,
    fromVersion: decision.fromVersion,
    toVersion: decision.toVersion,
    ...(decision.candidateId === undefined ? {} : { candidateId: decision.candidateId }),
    ...(decision.revision === undefined ? {} : { revision: decision.revision }),
  }
}

/** `ctx.capabilityGate` when `@nexgent/capabilities` is loaded. */
export function gateOf(ctx: Context): GateHost | undefined {
  return (ctx as unknown as { get(name: string): unknown }).get('capabilityGate') as GateHost | undefined
}
