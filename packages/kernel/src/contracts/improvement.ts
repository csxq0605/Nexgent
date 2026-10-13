/**
 * The step-5 improvement contract (`@nexgent/evolve`): what starts an
 * improvement job (counted feedback, an explicit "improve", failed checks),
 * the persistent trigger queue, the job record and its states, the
 * diagnosis an improvement session reports, the read-only tools that
 * session gets, and the project's `improvement` settings. Step 6 adds meta
 * jobs (`kind: 'meta'`: improving the improver, `improver.ts`), their
 * statuses, phases and trigger, the job's pinned `improverVersion`, the
 * comparison arms run in project copies, and the `improvement.meta`
 * settings.
 *
 * Normative text: `docs/adr/0006-improvement-jobs.md` and
 * `docs/adr/0008-improver-versions.md` (decisions),
 * `docs/spec/data-formats.md` §改进作业 (formats) and
 * `docs/spec/permissions.md` §改进会话与改进预算 (what an improvement
 * session may do, who may change the settings). JSON Schemas of the files
 * live in `@nexgent/session` (`improvement.v1.schema.json`). Types and pure
 * helpers only: queue locking, the job process and the sessions belong to
 * `@nexgent/evolve`.
 */
import {
  CAPABILITY_COMPONENT_KINDS,
  type CapabilityComponentKind,
  type CapabilityComponentRef,
  type CapabilityVersion,
} from './capabilities.js'
import { NexgentError, type ErrorInfo } from './errors.js'
import type { JsonSchema } from './json.js'
import type { MemberCost } from './ledger.js'
import type { LLMUsage, ThinkingMode } from './llm.js'
import type { Step2ToolSpec } from './step2-tools.js'
import type { FeedbackEntry, FeedbackRating } from './tasking.js'
import type { ImproverVersion } from './improver.js'

// ---------------------------------------------------------------------------
// Layout and limits
// ---------------------------------------------------------------------------

/** `.nexgent/improvements/` (host-written; the model's file tools can read and write none of it). */
export const IMPROVEMENTS_DIR = 'improvements'

/** Files below `.nexgent/improvements/`. */
export const IMPROVEMENT_FILES = {
  /** `queue.json`: the trigger queue ({@link ImprovementQueue}). */
  queue: 'queue.json',
  /** `queue.lock`: exclusive-create lock held while the queue is read-modified-written (process id inside). */
  queueLock: 'queue.lock',
  /** `<jobId>/job.json`: the job record ({@link ImprovementJob}), replaced atomically on every change. */
  job: 'job.json',
  /** `<jobId>/job.json.lock`: exclusive-create lock held while `job.json` is read-modified-written. */
  jobFileLock: 'job.json.lock',
  /** `<jobId>/diagnosis.json`: the accepted diagnosis ({@link Diagnosis}), written once. */
  diagnosis: 'diagnosis.json',
  /** `<jobId>/job.lock`: the job process id while it runs. */
  jobLock: 'job.lock',
  /** `<jobId>/job.log`: the job process's stdout / stderr (diagnostics, never read back as data). */
  jobLog: 'job.log',
  /** Step 6, meta jobs: `<jobId>/meta-diagnosis.json` ({@link import('./improver.js').MetaDiagnosis}), written once. */
  metaDiagnosis: 'meta-diagnosis.json',
  /** Step 6, meta jobs: `<jobId>/change.json` ({@link import('./improver.js').ImproverChangeRecord}), written once. */
  change: 'change.json',
  /** Step 6, meta jobs: `<jobId>/comparison.json` ({@link import('./improver.js').ImproverComparison}), written once. */
  comparison: 'comparison.json',
} as const

/** Bounds every writer and reader enforces. */
export const IMPROVEMENT_LIMITS = {
  /** Diagnosis reports a job asks for before it fails (decision: rewrite at most 3 times in total). */
  maxDiagnosisAttempts: 3,
  /** Default and maximum bytes one read-only query returns. */
  defaultSliceBytes: 65_536,
  maxSliceBytes: 262_144,
  /** Failure types in one diagnosis, evidence refs per type. */
  maxFailureTypes: 8,
  maxEvidence: 16,
  /** Characters of a failure label, the hypothesis, a status detail, the user's note on an explicit request. */
  maxLabelChars: 200,
  maxHypothesisChars: 500,
  maxDetailChars: 2000,
  /** Pending signals kept in the queue (older ones beyond this are dropped from `pending`, never from `counted`). */
  maxPendingSignals: 64,
} as const

// ---------------------------------------------------------------------------
// Triggers and the queue
// ---------------------------------------------------------------------------

/**
 * Why a job started (plan 4.5): counted signals reached the threshold
 * (`feedback-count`; `check-failure` when every signal of the batch was a
 * failed check), or the user asked (`explicit`, regardless of the count and
 * of `autoImprove`, but within the budget). Step 6: a meta job starts on
 * `job-count` (every `improvement.meta.everyJobs` finished jobs, only when
 * `improvement.meta.enabled`) or `explicit` (`improvements.runMeta`).
 */
export type ImprovementTrigger = 'feedback-count' | 'explicit' | 'check-failure' | 'job-count'

/** Every trigger. */
export const IMPROVEMENT_TRIGGERS: readonly ImprovementTrigger[] = ['feedback-count', 'explicit', 'check-failure', 'job-count']

/**
 * One counted signal. `feedback` is a counted feedback entry
 * ({@link isCountedFeedback}); `check-failure` is a root task turn whose
 * `task.outcome.checks` had a failing item (decision 2: counts as one).
 */
export type ImprovementSignal =
  | {
      readonly kind: 'feedback'
      readonly feedbackId: string
      readonly sessionId: string
      readonly deliverableId: string
      readonly version?: number
      /** Absent: a comment without a rating. */
      readonly rating?: FeedbackRating
      /** ISO-8601 UTC when it happened (the feedback's `submittedAt`). */
      readonly at: string
    }
  | {
      readonly kind: 'check-failure'
      readonly taskId: string
      readonly sessionId: string
      readonly turn: number
      /** Names of the failed checks. */
      readonly failedChecks?: readonly string[]
      /** ISO-8601 UTC when the turn's checks ran. */
      readonly at: string
    }

/** Signal kinds. */
export const IMPROVEMENT_SIGNAL_KINDS = ['feedback', 'check-failure'] as const

/** The key that makes a signal count once: `feedback:<id>` or `check:<taskId>:<turn>`. */
export function signalKey(signal: ImprovementSignal): string {
  return signal.kind === 'feedback' ? `feedback:${signal.feedbackId}` : `check:${signal.taskId}:${signal.turn}`
}

/**
 * Whether a feedback entry counts toward the threshold (decision 2): a
 * rating of 3 or less, or a comment without a rating. Ratings 4–5 are kept
 * in the session but never counted.
 */
export function isCountedFeedback(entry: Pick<FeedbackEntry, 'rating'>): boolean {
  return entry.rating === undefined || entry.rating <= 3
}

/**
 * `.nexgent/improvements/queue.json`. Updated only under `queue.lock`
 * (exclusive create), read-modify-written with a temp file and rename, so two
 * processes submitting feedback at once never count twice or lose a signal.
 */
export interface ImprovementQueue {
  readonly formatVersion: 1
  /** ISO-8601 UTC when counting began in this project; signals that happened earlier are never counted. */
  readonly since: string
  /** Keys of every signal ever counted ({@link signalKey}); a key here is never counted again. */
  readonly counted: readonly string[]
  /** Counted signals not yet given to a job (the next batch), oldest first. */
  readonly pending: readonly ImprovementSignal[]
  /** The job holding the project's single job slot (a status in {@link IMPROVEMENT_ACTIVE_STATUSES}); meta jobs share it. */
  readonly activeJobId?: string
  /** Step 6: ids of every finished job ever counted toward a meta job ({@link countFinishedJob}); absent before step 6. */
  readonly metaCounted?: readonly string[]
  /** Step 6: counted finished jobs not yet given to a meta job, oldest first; absent before step 6. */
  readonly metaPending?: readonly string[]
}

/** The queue of a project that starts counting at `since`. */
export function emptyImprovementQueue(since: string): ImprovementQueue {
  return { formatVersion: 1, since, counted: [], pending: [] }
}

/**
 * Count one signal (pure). Nothing changes for a key already in `counted`
 * or a signal that happened before `since`. Counting never starts a job:
 * the caller then calls {@link takeBatch} in the same locked update.
 */
export function countSignal(queue: ImprovementQueue, signal: ImprovementSignal): { readonly queue: ImprovementQueue; readonly counted: boolean } {
  const key = signalKey(signal)
  if (queue.counted.includes(key) || signal.at < queue.since) return { queue, counted: false }
  return {
    queue: { ...queue, counted: [...queue.counted, key], pending: [...queue.pending, signal].slice(-IMPROVEMENT_LIMITS.maxPendingSignals) },
    counted: true,
  }
}

/**
 * Take the pending signals as the batch of a new job (pure) when the slot
 * is free and at least `threshold` are pending; `pending` empties. The
 * caller creates the job and sets `activeJobId` in the same locked update.
 * While a job holds the slot, signals wait for the next batch (decision 8).
 * Only call it for `feedback-count` when `autoImprove` is on; an explicit
 * "improve" takes whatever is pending with `threshold` 0.
 */
export function takeBatch(queue: ImprovementQueue, threshold: number): { readonly queue: ImprovementQueue; readonly batch?: readonly ImprovementSignal[] } {
  if (queue.activeJobId !== undefined || queue.pending.length < threshold) return { queue }
  return { queue: { ...queue, pending: [] }, batch: queue.pending }
}

/** Free the job slot held by `jobId` (pure); another job id leaves the queue unchanged. */
export function releaseJobSlot(queue: ImprovementQueue, jobId: string): ImprovementQueue {
  if (queue.activeJobId !== jobId) return queue
  const { activeJobId: _released, ...rest } = queue
  return rest
}

/**
 * Step 6 (ADR 0008 decision 3): final statuses that count toward a meta
 * job: adopted, rejected, no proposal and failed. Cancelled, interrupted and
 * budget-exhausted jobs, meta jobs and comparison arms never count.
 */
export const META_COUNTED_STATUSES: readonly ImprovementStatus[] = ['adopted', 'rejected', 'no-proposal', 'failed']

/**
 * Count one finished capability job toward the next meta job (pure). Nothing
 * changes for a job already counted, a meta job, a comparison arm, or a
 * status outside {@link META_COUNTED_STATUSES}.
 */
export function countFinishedJob(queue: ImprovementQueue, job: Pick<ImprovementJob, 'id' | 'status' | 'kind' | 'arm'>): { readonly queue: ImprovementQueue; readonly counted: boolean } {
  const counted = queue.metaCounted ?? []
  if (job.kind === 'meta' || job.arm !== undefined || !META_COUNTED_STATUSES.includes(job.status) || counted.includes(job.id)) return { queue, counted: false }
  return { queue: { ...queue, metaCounted: [...counted, job.id], metaPending: [...(queue.metaPending ?? []), job.id] }, counted: true }
}

/**
 * Take the counted finished jobs as the basis of a meta job (pure) when the
 * slot is free and at least `everyJobs` are pending; `metaPending` empties.
 * Only call it when `improvement.meta.enabled` is on; an explicit meta job
 * takes whatever is pending with `everyJobs` 0.
 */
export function takeMetaBatch(queue: ImprovementQueue, everyJobs: number): { readonly queue: ImprovementQueue; readonly batch?: readonly string[] } {
  const pending = queue.metaPending ?? []
  if (queue.activeJobId !== undefined || pending.length < everyJobs) return { queue }
  return { queue: { ...queue, metaPending: [] }, batch: pending }
}

/** The trigger of a counted batch: `check-failure` when every signal is one, else `feedback-count`. */
export function batchTrigger(signals: readonly ImprovementSignal[]): 'feedback-count' | 'check-failure' {
  return signals.length > 0 && signals.every(signal => signal.kind === 'check-failure') ? 'check-failure' : 'feedback-count'
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

/**
 * Where a job stands: active statuses hold the project's job slot, parked
 * ones wait for something outside the job and free it, final ones never
 * change. Step 6 adds the three active statuses of a meta job
 * (`meta-diagnosing`, `meta-proposing`, `comparing`).
 */
export type ImprovementStatus =
  | 'queued'
  | 'diagnosing'
  | 'proposing'
  | 'trialing'
  | 'meta-diagnosing'
  | 'meta-proposing'
  | 'comparing'
  | 'waiting-history'
  | 'awaiting-approval'
  | 'adopted'
  | 'rejected'
  | 'no-proposal'
  | 'budget-exhausted'
  | 'failed'
  | 'interrupted'
  | 'cancelled'

/** Every status, in lifecycle order. */
export const IMPROVEMENT_STATUSES: readonly ImprovementStatus[] = [
  'queued', 'diagnosing', 'proposing', 'trialing', 'meta-diagnosing', 'meta-proposing', 'comparing', 'waiting-history', 'awaiting-approval',
  'adopted', 'rejected', 'no-proposal', 'budget-exhausted', 'failed', 'interrupted', 'cancelled',
]

/** Statuses in which a process works (or is about to work) on the job; they hold the job slot (`activeJobId`). */
export const IMPROVEMENT_ACTIVE_STATUSES: readonly ImprovementStatus[] = ['queued', 'diagnosing', 'proposing', 'trialing', 'meta-diagnosing', 'meta-proposing', 'comparing']

/**
 * Statuses that wait outside the job and free the slot: `waiting-history`
 * resumes its trial once the project has enough past tasks (plan 4.5: wait,
 * never lower the bar) and takes the slot again; `awaiting-approval` follows
 * the candidate's plugin approval (`capabilities.approve`) to `adopted` or
 * `rejected`.
 */
export const IMPROVEMENT_PARKED_STATUSES: readonly ImprovementStatus[] = ['waiting-history', 'awaiting-approval']

/** Statuses after which the job never changes. */
export const IMPROVEMENT_FINAL_STATUSES: readonly ImprovementStatus[] = ['adopted', 'rejected', 'no-proposal', 'budget-exhausted', 'failed', 'interrupted', 'cancelled']

/** Whether a status is final. */
export function isFinalImprovementStatus(status: ImprovementStatus): boolean {
  return IMPROVEMENT_FINAL_STATUSES.includes(status)
}

/**
 * The phase a ledger record and an improvement session carry
 * (`improvementPhase`): the three of a capability job and, step 6, the two
 * a meta job runs itself (`meta-diagnose`, `meta-propose`).
 */
export type ImprovementPhase = 'diagnose' | 'propose' | 'trial' | 'meta-diagnose' | 'meta-propose'

/** Every phase. */
export const IMPROVEMENT_PHASES: readonly ImprovementPhase[] = ['diagnose', 'propose', 'trial', 'meta-diagnose', 'meta-propose']

/**
 * The keys of a job's `phases`: every {@link ImprovementPhase} plus, on a
 * meta job, `compare` (both comparison arms together; their own records
 * carry the arm job's id and phase, plus `metaJobId`). `compare` never
 * appears on a ledger record.
 */
export type ImprovementCostPhase = ImprovementPhase | 'compare'

/** Every cost phase. */
export const IMPROVEMENT_COST_PHASES: readonly ImprovementCostPhase[] = [...IMPROVEMENT_PHASES, 'compare']

/** What a job improves: the project's capabilities (step 5; absent `kind`) or, step 6, its improver. */
export type ImprovementJobKind = 'capability' | 'meta'

/** Every job kind. */
export const IMPROVEMENT_JOB_KINDS: readonly ImprovementJobKind[] = ['capability', 'meta']

/** Step 6: the two sides of an improver comparison (ADR 0008 decision 4). */
export type ComparisonArm = 'parent' | 'child'

/** Every comparison arm. */
export const COMPARISON_ARMS: readonly ComparisonArm[] = ['parent', 'child']

/** What one phase spent (no dollars: estimates are computed for display only). */
export interface PhaseCost {
  /** Summed usage of the phase's requests (`addUsage`); a field is `'unknown'` once any request did not report it. */
  readonly usage: LLMUsage
  readonly requestCount: number
}

/** One status change of a job. */
export interface ImprovementStatusChange {
  readonly status: ImprovementStatus
  /** ISO-8601 UTC. */
  readonly at: string
  /** Short reason (e.g. why `failed`, which history was missing); at most {@link IMPROVEMENT_LIMITS.maxDetailChars} characters. */
  readonly detail?: string
}

/** What an explicit "improve" pointed at ("improve" on a deliverable card, `nexgent improve run`). */
export interface ImprovementRequest {
  readonly sessionId?: string
  readonly deliverableId?: string
  readonly version?: number
  readonly taskId?: string
  /** The user's words, at most {@link IMPROVEMENT_LIMITS.maxDetailChars} characters. */
  readonly note?: string
}

/**
 * Step 6: what a meta job ({@link ImprovementJob.kind} `meta`) records
 * beyond the common fields; the reports themselves are `meta-diagnosis.json`,
 * `change.json` and `comparison.json` in the job directory.
 */
export interface MetaJobState {
  /** The finished jobs it was started on (its batch, oldest first; may be empty for an explicit meta job). */
  readonly basis: readonly string[]
  /** The improver in force when it started (equals the job's `improverVersion`). */
  readonly parentVersion: ImproverVersion
  /** Set once `change.json` is written: the proposed improver (stored under `.nexgent/improvers/bundles/`). */
  readonly childVersion?: ImproverVersion
  /** Experiments only (`improvements.runMeta` `keepCopies`): keep both comparison copies after the decision. */
  readonly keepCopies?: boolean
  /** Set once `meta-diagnosis.json` is written. */
  readonly diagnosed?: { readonly at: string; readonly attempts: number; readonly proposal: 'change' | 'none' }
  /** Set once `comparison.json` is written: `decideImprover`'s verdict. */
  readonly compared?: { readonly at: string; readonly outcome: 'adopt' | 'reject'; readonly reason: string }
  /** The improver activation revision written when the child was adopted. */
  readonly revision?: number
}

/**
 * Step 6: on a job that runs as one arm of an improver comparison, inside a
 * project copy (its `job.json` lives in the copy). Arms never count toward
 * a meta job and never change the real project.
 */
export interface ComparisonArmRef {
  readonly metaJobId: string
  readonly arm: ComparisonArm
}

/**
 * `.nexgent/improvements/<jobId>/job.json`. Changed only under
 * `job.json.lock` (temp file + rename); candidates, trials and decisions stay
 * under `.nexgent/capabilities/` and the job only references them.
 */
export interface ImprovementJob {
  readonly formatVersion: 1
  /** Lowercase uuid v4; also the directory name and the ledger's `improvementId`. */
  readonly id: string
  /** Step 6: `meta` for a meta job; absent means `capability` (every step-5 job). */
  readonly kind?: ImprovementJobKind
  /**
   * Step 6: the improver version pinned when the job started (ADR 0008
   * decision 1); an improver adopted while it runs does not affect it.
   * Absent in step-5 jobs, which ran on `v0`.
   */
  readonly improverVersion?: ImproverVersion
  /** Step 6: set on a comparison arm's job (in the arm's project copy). */
  readonly arm?: ComparisonArmRef
  /** ISO-8601 UTC. */
  readonly createdAt: string
  readonly updatedAt: string
  readonly trigger: ImprovementTrigger
  readonly status: ImprovementStatus
  /** The counted signals this job answers (its batch), oldest first; an explicit job takes whatever was pending. */
  readonly items: readonly ImprovementSignal[]
  /** `explicit` only: what the user pointed at. */
  readonly request?: ImprovementRequest
  /** Every change, oldest first; the last equals {@link status}. */
  readonly history: readonly ImprovementStatusChange[]
  /**
   * Spend per phase, summed from the ledger records carrying this job's
   * `improvementId`; a phase that never ran is absent. A meta job's
   * `compare` sums the records carrying its id as `metaJobId` (both arms).
   */
  readonly phases: Readonly<Partial<Record<ImprovementCostPhase, PhaseCost>>>
  /** Adopted capability version when diagnosis started. */
  readonly baseVersion?: CapabilityVersion
  /** The improvement sessions it opened, by phase (`session.start.purpose: improvement`); step 6 adds the meta phases. */
  readonly sessions?: { readonly diagnose?: string; readonly propose?: string; readonly 'meta-diagnose'?: string; readonly 'meta-propose'?: string }
  /** Set once `diagnosis.json` is written. */
  readonly diagnosed?: { readonly at: string; readonly proposalKind: CapabilityComponentKind | 'none'; readonly attempts: number }
  /** The candidate the propose phase produced (`origin: improvement`, `jobId` = this id). */
  readonly candidateId?: string
  readonly trialId?: string
  /** The gate's (or the approval's) decision. */
  readonly decisionId?: string
  /** First root task that ran on the adopted version and used the new component (`componentsUsed`). */
  readonly firstUse?: { readonly taskId: string; readonly sessionId: string; readonly at: string; readonly version: CapabilityVersion }
  /** Set when the adopted version was later rolled back. */
  readonly rolledBack?: { readonly decisionId: string; readonly at: string }
  /** Why the job ended where it did (failure, rejection, no proposal, budget); at most {@link IMPROVEMENT_LIMITS.maxDetailChars} characters. */
  readonly detail?: string
  /** The error of a `failed` / `interrupted` job. */
  readonly error?: ErrorInfo
  /** Step 6: set on a meta job. */
  readonly meta?: MetaJobState
}

const EXITS: readonly ImprovementStatus[] = ['budget-exhausted', 'failed', 'interrupted', 'cancelled']

/** Allowed status moves; {@link canMoveImprovement} checks against it ({@link canMoveJob} also checks the job's kind). */
export const IMPROVEMENT_TRANSITIONS: Readonly<Record<ImprovementStatus, readonly ImprovementStatus[]>> = {
  queued: ['diagnosing', 'meta-diagnosing', ...EXITS],
  diagnosing: ['proposing', 'no-proposal', ...EXITS],
  proposing: ['trialing', 'no-proposal', ...EXITS],
  trialing: ['adopted', 'rejected', 'awaiting-approval', 'waiting-history', ...EXITS],
  'meta-diagnosing': ['meta-proposing', 'no-proposal', ...EXITS],
  'meta-proposing': ['comparing', ...EXITS],
  comparing: ['adopted', 'rejected', ...EXITS],
  'waiting-history': ['trialing', 'failed', 'interrupted', 'cancelled'],
  'awaiting-approval': ['adopted', 'rejected'],
  adopted: [],
  rejected: [],
  'no-proposal': [],
  'budget-exhausted': [],
  failed: [],
  interrupted: [],
  cancelled: [],
}

/** Whether a job may move from `from` to `to`. */
export function canMoveImprovement(from: ImprovementStatus, to: ImprovementStatus): boolean {
  return IMPROVEMENT_TRANSITIONS[from].includes(to)
}

/** Step 6: the statuses a meta job can have; a capability job has every other one plus the shared ones. */
export const META_JOB_STATUSES: readonly ImprovementStatus[] = [
  'queued', 'meta-diagnosing', 'meta-proposing', 'comparing', 'adopted', 'rejected', 'no-proposal', 'budget-exhausted', 'failed', 'interrupted', 'cancelled',
]

const META_ONLY: readonly ImprovementStatus[] = ['meta-diagnosing', 'meta-proposing', 'comparing']

/** The statuses a job of `kind` can have. */
export function statusesOfKind(kind: ImprovementJobKind): readonly ImprovementStatus[] {
  return kind === 'meta' ? META_JOB_STATUSES : IMPROVEMENT_STATUSES.filter(status => !META_ONLY.includes(status))
}

/** Whether a job of `kind` (absent: `capability`) may move from `from` to `to`. */
export function canMoveJob(kind: ImprovementJobKind | undefined, from: ImprovementStatus, to: ImprovementStatus): boolean {
  const allowed = statusesOfKind(kind ?? 'capability')
  return allowed.includes(from) && allowed.includes(to) && canMoveImprovement(from, to)
}

/** The status in which each cost phase runs. */
export const PHASE_STATUS: Readonly<Record<ImprovementCostPhase, ImprovementStatus>> = {
  diagnose: 'diagnosing',
  propose: 'proposing',
  trial: 'trialing',
  'meta-diagnose': 'meta-diagnosing',
  'meta-propose': 'meta-proposing',
  compare: 'comparing',
}

/** When a phase ran: first entry into its status, and the next change after its last stint (absent while it runs). */
export interface PhaseTimes {
  readonly startedAt: string
  readonly endedAt?: string
}

/** Step 6 (the SDK's per-phase timestamps): each phase's times, from the job's `history` (pure). */
export function jobPhaseTimes(job: Pick<ImprovementJob, 'history'>): Readonly<Partial<Record<ImprovementCostPhase, PhaseTimes>>> {
  const out: Partial<Record<ImprovementCostPhase, PhaseTimes>> = {}
  for (const phase of IMPROVEMENT_COST_PHASES) {
    const status = PHASE_STATUS[phase]
    const first = job.history.findIndex(change => change.status === status)
    if (first < 0) continue
    let last = first
    for (let index = first; index < job.history.length; index += 1) if (job.history[index]?.status === status) last = index
    const next = job.history[last + 1]
    out[phase] = { startedAt: job.history[first]!.at, ...(next === undefined ? {} : { endedAt: next.at }) }
  }
  return out
}

/** Ids of the feedback entries among a job's signals, in order. */
export function jobFeedbackIds(job: Pick<ImprovementJob, 'items'>): string[] {
  return job.items.flatMap(item => (item.kind === 'feedback' ? [item.feedbackId] : []))
}

// ---------------------------------------------------------------------------
// Diagnosis
// ---------------------------------------------------------------------------

/**
 * The three MAST failure categories (Multi-Agent System failure Taxonomy):
 * specification and system design, inter-agent misalignment, task
 * verification and termination.
 */
export type FailureCategory = 'system-design' | 'inter-agent-misalignment' | 'task-verification'

/** Every category. */
export const FAILURE_CATEGORIES: readonly FailureCategory[] = ['system-design', 'inter-agent-misalignment', 'task-verification']

/** A pointer into a session the diagnosis cites; the host checks the record exists. */
export interface EvidenceRef {
  readonly sessionId: string
  /** `seq` of the cited record. */
  readonly seq: number
  readonly turn?: number
}

/** One labelled failure. */
export interface DiagnosedFailure {
  readonly category: FailureCategory
  /** Short label, e.g. "missed the region column the user asked for". */
  readonly label: string
  /** At least one record. */
  readonly evidence: readonly EvidenceRef[]
}

/** What the diagnosis says was involved. */
export interface DiagnosisInvolved {
  /** Member names (`main` for the root conversation). */
  readonly members: readonly string[]
  readonly tools: readonly string[]
  readonly skills: readonly string[]
  readonly components: readonly CapabilityComponentRef[]
}

/** Input of `improve_report_diagnosis`: what the model reports. */
export interface DiagnosisReport {
  readonly failureTypes: readonly DiagnosedFailure[]
  readonly involved: DiagnosisInvolved
  /** One sentence: which missing capability led to the feedback. */
  readonly hypothesis: string
  /** Suggested component kind, or `none` (not a capability problem, e.g. a changed requirement); `none` ends the job `no-proposal`. */
  readonly proposalKind: CapabilityComponentKind | 'none'
}

/**
 * `.nexgent/improvements/<jobId>/diagnosis.json`: the accepted report plus
 * what the host adds. `memberCosts` is summed by the host from the ledger
 * (the model can only cite it, never write it).
 */
export interface Diagnosis extends DiagnosisReport {
  readonly formatVersion: 1
  readonly jobId: string
  /** ISO-8601 UTC. */
  readonly createdAt: string
  /** The improvement session that reported it. */
  readonly sessionId: string
  /** Reports asked for, 1 … {@link IMPROVEMENT_LIMITS.maxDiagnosisAttempts}. */
  readonly attempts: number
  /** Per-member usage of the diagnosed tasks (root included as `main`). */
  readonly memberCosts: readonly MemberCost[]
}

// ---------------------------------------------------------------------------
// Improvement-session tools
// ---------------------------------------------------------------------------

/** Fixed facts of an improvement-session tool (same shape as step 2's). */
export type ImprovementToolSpec = Step2ToolSpec

const id: JsonSchema = { type: 'string', minLength: 1 }
const maxBytes: JsonSchema = { type: 'integer', minimum: 1, maximum: IMPROVEMENT_LIMITS.maxSliceBytes, description: `Byte cap of the result (default ${IMPROVEMENT_LIMITS.defaultSliceBytes}); a longer slice is cut and marked truncated.` }

/** `improve_read_session`: a read-only slice of one session's records (by turn range and record type). */
export const IMPROVE_READ_SESSION_TOOL: ImprovementToolSpec = {
  name: 'improve_read_session',
  effects: ['read'],
  approval: 'never',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['sessionId'],
    properties: {
      sessionId: id,
      fromTurn: { type: 'integer', minimum: 1 },
      toTurn: { type: 'integer', minimum: 1 },
      types: { type: 'array', items: { type: 'string', minLength: 1 }, description: 'Record types to keep, e.g. user.message, tool.result.' },
      maxBytes,
    },
  },
}

/** `improve_read_ledger`: a read-only slice of the project ledger, narrowed by attribution. */
export const IMPROVE_READ_LEDGER_TOOL: ImprovementToolSpec = {
  name: 'improve_read_ledger',
  effects: ['read'],
  approval: 'never',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      taskId: id,
      sessionId: id,
      memberId: id,
      capabilityVersion: id,
      types: { type: 'array', items: { type: 'string', minLength: 1 } },
      maxBytes,
    },
  },
}

/** `improve_list_feedback`: the project's feedback entries with where they were recorded. */
export const IMPROVE_LIST_FEEDBACK_TOOL: ImprovementToolSpec = {
  name: 'improve_list_feedback',
  effects: ['read'],
  approval: 'never',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { sessionId: id, deliverableId: id },
  },
}

const componentKindOrNone: JsonSchema = { enum: [...CAPABILITY_COMPONENT_KINDS, 'none'] }
const names: JsonSchema = { type: 'array', items: { type: 'string', minLength: 1 } }

/**
 * `improve_report_diagnosis`: submit the structured diagnosis. The host
 * validates it (schema, evidence records exist); on failure the result says
 * what to fix and the model may report again, up to
 * {@link IMPROVEMENT_LIMITS.maxDiagnosisAttempts} reports in total.
 */
export const IMPROVE_REPORT_DIAGNOSIS_TOOL: ImprovementToolSpec = {
  name: 'improve_report_diagnosis',
  effects: ['read'],
  approval: 'never',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['failureTypes', 'involved', 'hypothesis', 'proposalKind'],
    properties: {
      failureTypes: {
        type: 'array',
        maxItems: IMPROVEMENT_LIMITS.maxFailureTypes,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['category', 'label', 'evidence'],
          properties: {
            category: { enum: [...FAILURE_CATEGORIES] },
            label: { type: 'string', minLength: 1, maxLength: IMPROVEMENT_LIMITS.maxLabelChars },
            evidence: {
              type: 'array',
              minItems: 1,
              maxItems: IMPROVEMENT_LIMITS.maxEvidence,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['sessionId', 'seq'],
                properties: { sessionId: id, seq: { type: 'integer', minimum: 1 }, turn: { type: 'integer', minimum: 1 } },
              },
            },
          },
        },
      },
      involved: {
        type: 'object',
        additionalProperties: false,
        required: ['members', 'tools', 'skills', 'components'],
        properties: {
          members: names,
          tools: names,
          skills: names,
          components: {
            type: 'array',
            items: { type: 'object', additionalProperties: false, required: ['kind', 'name'], properties: { kind: { enum: [...CAPABILITY_COMPONENT_KINDS] }, name: id } },
          },
        },
      },
      hypothesis: { type: 'string', minLength: 1, maxLength: IMPROVEMENT_LIMITS.maxHypothesisChars },
      proposalKind: componentKindOrNone,
    },
  },
}

/**
 * The tools of a diagnose-phase improvement session, and nothing else: no
 * file, command, network, collaboration or capability tools. The
 * propose-phase session runs in a snapshot copy of the project with the
 * ordinary task tools plus `STEP4_TOOLS` and none of these
 * (`permissions.md` §改进会话与改进预算).
 */
export const IMPROVEMENT_DIAGNOSIS_TOOLS: readonly ImprovementToolSpec[] = [
  IMPROVE_READ_SESSION_TOOL,
  IMPROVE_READ_LEDGER_TOOL,
  IMPROVE_LIST_FEEDBACK_TOOL,
  IMPROVE_REPORT_DIAGNOSIS_TOOL,
]

// ---------------------------------------------------------------------------
// Project settings
// ---------------------------------------------------------------------------

/**
 * The improvement budget (decision 6): a rolling window per project. Unlike
 * cost caps it counts billed tokens, `inputTokens + cacheReadTokens +
 * cacheWriteTokens + outputTokens`, because long improvement sessions are
 * mostly cache reads; unknown usage fields count 0 (the total is then a
 * lower bound). It sums the `phases` of every job created inside the window
 * (diagnose, propose and the job's trial).
 */
export interface ImprovementBudget {
  /**
   * Billed tokens per window; default 3 000 000: at the ADR 0002 prices and a
   * cache-read-heavy mix one million tokens is about 1 USD, so about 3 USD
   * (display estimate only).
   */
  readonly maxTokens: number
  /** Window length in days; default 30. */
  readonly windowDays: number
}

/**
 * Step 6 (ADR 0008 decision 3): meta jobs. Off by default; on, every
 * `everyJobs` finished jobs ({@link META_COUNTED_STATUSES}) start one. Meta
 * jobs spend their own budget, counted like {@link ImprovementBudget} over
 * the `phases` of the meta jobs created in the window (both comparison arms
 * included); the capability budget then counts capability jobs only.
 */
export interface MetaImprovementConfig {
  /** Default `false`; an explicit meta job (`improvements.runMeta`) ignores it but not the budget. */
  readonly enabled: boolean
  /** Finished jobs that start a meta job; 1–20, default 3. */
  readonly everyJobs: number
  /** Default `{ maxTokens: 6 000 000, windowDays: 30 }` (about 6 USD, display estimate only). */
  readonly budget: ImprovementBudget
  /** Model of the meta-diagnose and meta-propose sessions; default `claude-sonnet-5-5`, may be `claude-opus-5-5`. Thinking follows `improvement.thinking`. */
  readonly model: string
}

/**
 * `.nexgent/config.json` `improvement`. Writing it (and `autoImprove`)
 * always needs approval; no capability component, improver or improvement
 * job can carry these fields.
 */
export interface ImprovementConfig {
  /** Counted signals that start a job (4.9 #7); 1–20, default 3. */
  readonly feedbackThreshold: number
  readonly budget: ImprovementBudget
  /** Model of the diagnose and propose sessions; default `claude-sonnet-5-5` (decision 5), may be `claude-opus-5-5`. */
  readonly model: string
  /** Default `'on'`. */
  readonly thinking: ThinkingMode
  /** Step 6: meta jobs ({@link MetaImprovementConfig}). */
  readonly meta: MetaImprovementConfig
}

/** Defaults of {@link ImprovementConfig}. */
export const DEFAULT_IMPROVEMENT_CONFIG: ImprovementConfig = Object.freeze({
  feedbackThreshold: 3,
  budget: Object.freeze({ maxTokens: 3_000_000, windowDays: 30 }),
  model: 'claude-sonnet-5-5',
  thinking: 'on' as ThinkingMode,
  meta: Object.freeze({ enabled: false, everyJobs: 3, budget: Object.freeze({ maxTokens: 6_000_000, windowDays: 30 }), model: 'claude-sonnet-5-5' }),
}) as ImprovementConfig

/** A partial `improvement.meta` object as written in the config file. */
export interface MetaImprovementConfigInput {
  readonly enabled?: boolean
  readonly everyJobs?: number
  readonly budget?: Partial<ImprovementBudget>
  readonly model?: string
}

/** A partial `improvement` object as written in the config file. */
export interface ImprovementConfigInput {
  readonly feedbackThreshold?: number
  readonly budget?: Partial<ImprovementBudget>
  readonly model?: string
  readonly thinking?: ThinkingMode
  readonly meta?: MetaImprovementConfigInput
}

/** Fill a validated partial `improvement` object with defaults (pure). */
export function resolveImprovementConfig(input: ImprovementConfigInput = {}): ImprovementConfig {
  const d = DEFAULT_IMPROVEMENT_CONFIG
  const meta = input.meta
  return {
    feedbackThreshold: input.feedbackThreshold ?? d.feedbackThreshold,
    budget: { maxTokens: input.budget?.maxTokens ?? d.budget.maxTokens, windowDays: input.budget?.windowDays ?? d.budget.windowDays },
    model: input.model ?? d.model,
    thinking: input.thinking ?? d.thinking,
    meta: {
      enabled: meta?.enabled ?? d.meta.enabled,
      everyJobs: meta?.everyJobs ?? d.meta.everyJobs,
      budget: { maxTokens: meta?.budget?.maxTokens ?? d.meta.budget.maxTokens, windowDays: meta?.budget?.windowDays ?? d.meta.budget.windowDays },
      model: meta?.model ?? d.meta.model,
    },
  }
}

/**
 * Validate the `improvement` field of `.nexgent/config.json`.
 * @throws `config/invalid` naming the field.
 */
export function assertImprovementConfig(value: unknown): asserts value is ImprovementConfigInput {
  const fail = (field: string, message: string): never => {
    throw new NexgentError('config/invalid', `.nexgent/config.json: improvement.${field} ${message}`, { details: { field: `improvement.${field}` } })
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new NexgentError('config/invalid', '.nexgent/config.json: improvement must be an object', { details: { field: 'improvement' } })
  }
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) if (!['feedbackThreshold', 'budget', 'model', 'thinking', 'meta'].includes(key)) fail(key, 'is not a known field')
  const integer = (field: string, entry: unknown, min: number, max: number) => {
    if (entry === undefined) return
    if (typeof entry !== 'number' || !Number.isInteger(entry) || entry < min || entry > max) fail(field, `must be an integer in ${min}..${max}`)
  }
  const object = (field: string, entry: unknown): Record<string, unknown> => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) fail(field, 'must be an object')
    return entry as Record<string, unknown>
  }
  const budgetField = (field: string, entry: unknown) => {
    if (entry === undefined) return
    const budget = object(field, entry)
    for (const key of Object.keys(budget)) if (key !== 'maxTokens' && key !== 'windowDays') fail(`${field}.${key}`, 'is not a known field')
    integer(`${field}.maxTokens`, budget.maxTokens, 1, Number.MAX_SAFE_INTEGER)
    integer(`${field}.windowDays`, budget.windowDays, 1, 365)
  }
  const model = (field: string, entry: unknown) => {
    if (entry !== undefined && (typeof entry !== 'string' || entry.trim() === '')) fail(field, 'must be a non-empty string')
  }
  integer('feedbackThreshold', record.feedbackThreshold, 1, 20)
  budgetField('budget', record.budget)
  model('model', record.model)
  if (record.thinking !== undefined && record.thinking !== 'on' && record.thinking !== 'off') fail('thinking', 'must be "on" or "off"')
  if (record.meta !== undefined) {
    const meta = object('meta', record.meta)
    for (const key of Object.keys(meta)) if (!['enabled', 'everyJobs', 'budget', 'model'].includes(key)) fail(`meta.${key}`, 'is not a known field')
    if (meta.enabled !== undefined && typeof meta.enabled !== 'boolean') fail('meta.enabled', 'must be a boolean')
    integer('meta.everyJobs', meta.everyJobs, 1, 20)
    budgetField('meta.budget', meta.budget)
    model('meta.model', meta.model)
  }
}
