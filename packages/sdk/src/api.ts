/**
 * The public surface of `@nexgent/sdk` (step 2): an in-process TypeScript
 * API over the kernel that the CLI and the desktop app share. Types only —
 * `@nexgent/sdk` implements it in round 3 (W4); the desktop main process
 * holds one instance and the renderer reaches it over IPC through
 * {@link SdkMethods} (whitelist and token rules: `docs/spec/permissions.md`
 * §本地 IPC 与访问令牌).
 *
 * Rules every implementation keeps:
 * - Nothing here imports Electron; the SDK runs in plain Node.
 * - Every argument and result is JSON-safe (structured-clone safe), so the
 *   same shapes cross IPC unchanged. Errors reject with a `NexgentError`
 *   whose `toErrorInfo` projection is what crosses IPC.
 * - No method ever returns a secret value; credentials are reported only as
 *   `CredentialInfo` (`configured`, `source`).
 * - Every turn's event stream ends with exactly one `turn.end`, also on
 *   cancel, approval timeout and crash recovery.
 * - Step 3: child sessions (members) started by tools are tracked like any
 *   other session: their events carry `parentSessionId`, `turns.cancel` on
 *   the parent cancels them (cause `parent`), and their approvals arrive as
 *   ordinary `approval.request` events whose request names the member.
 * - Step 4: capability versions, candidates and trials are project-level;
 *   their events carry no `sessionId` (`capability.version`,
 *   `capability.candidate`, `capability.trial`), and plugin adoption is
 *   approved through `capabilities.approve`, not `approvals.respond`.
 * - Step 5: improvement jobs are project-level too; `improvement.job`
 *   events carry no `sessionId`. Improvement sessions
 *   (`session.start.purpose: improvement`) never appear in `sessions.list`;
 *   they are reached through `improvements.show`. The job, the candidate it
 *   produced and the gate's decision are linked by id, so the desktop can
 *   show feedback → diagnosis → candidate → trial → decision → first use.
 * - Step 6 (API 6): improver versions are project-level (`improvers.*`,
 *   `improver.version` events without `sessionId`); a meta job is an
 *   improvement job with `kind: 'meta'` and travels the same
 *   `improvements.*` methods and `improvement.job` events, its meta
 *   diagnosis, change and comparison linked from `improvements.show`.
 * - Step 6 rework (API 7, ADR 0012): the improver is user-level, shared by
 *   every project: `improvers.*` take no project (a `projectId` is ignored)
 *   and `improver.version` is an application-level event (no `projectId`,
 *   no `sessionId`). Meta-job settings are user settings
 *   (`userSettings.get / update`); a project keeps only
 *   `improvement.shareImproverEvidence`. Gate verdicts may carry the
 *   ADR 0013 reasons `similar-regression`, `no-similar-cases` and
 *   `instance-literal` (with the values found on the decision).
 */
import type {
  ActivationRevision,
  ActivationTrigger,
  ApprovalDecision,
  CandidateRecord,
  CandidateStatus,
  CommandSandboxStatus,
  CapabilityComponentRef,
  CapabilityDecision,
  CapabilityVersion,
  DecisionOutcome,
  DecisionReason,
  Diagnosis,
  ImprovementConfig,
  ImprovementConfigInput,
  ImprovementCostPhase,
  ImprovementJob,
  ImprovementJobKind,
  ImprovementStatus,
  ImprovementTrigger,
  ImproverActivationTrigger,
  ImproverBundle,
  ImproverChangeRecord,
  ImproverComparison,
  ImproverDecisionReason,
  ImproverRevision,
  ImproverScope,
  ImproverVersion,
  MetaImprovementConfig,
  MetaImprovementConfigInput,
  MetaDiagnosis,
  PhaseTimes,
  PluginApprovalInfo,
  TrialReceipt,
  TrialStatus,
  ApprovalRequest,
  CredentialInfo,
  DelegationMode,
  DeliverableDiff,
  DeliverableSummary,
  DeliverableVersion,
  DeliverableVersionRef,
  Effort,
  ErrorInfo,
  FeedbackListing,
  FileChange,
  FinishReason,
  Goal,
  GoalStatus,
  LLMUsage,
  CostCaps,
  CostCapLevel,
  CostCapScope,
  DollarBudget,
  HandbookEntry,
  HandbookOp,
  HandbookScope,
  LearningConfig,
  LearningConfigInput,
  LearningPhase,
  PracticeCase,
  PracticeSplit,
  OfflineAppliedProfile,
  OfflineCandidate,
  OfflineRunResult,
  OfflineRunState,
  OfflineRunStatus,
  ScorerReliability,
  UserLearningSettings,
  MaterialMetadata,
  MemberExecutionForm,
  MemberIdentity,
  MemberResultStatus,
  SandboxMode,
  SubmitFeedbackInput,
  TeamMember,
  TeamMessage,
  TeamTask,
  ThinkingMode,
  ToolCall,
  TurnEndReason,
  UserMessageSource,
  WorkflowStatus,
  OrganizationName,
  OrganizationRole,
} from '@nexgent/kernel'

/** API version; bumped only by a contract-change PR. */
export const SDK_API_VERSION = 8

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

/** One entry of the recent-projects list (`~/.nexgent/recent-projects.json`, newest first, at most 20). */
export interface ProjectInfo {
  /** Opaque handle for the open project; stable while the SDK instance lives. */
  readonly projectId: string
  /** Absolute project root. */
  readonly root: string
  /** Display name: the root's base name. */
  readonly name: string
  /** ISO-8601 instant it was last opened. */
  readonly lastOpenedAt: string
  /** Whether the root still exists (recent entries may be stale). */
  readonly exists: boolean
}

/** Options of `projects.open`. */
export interface OpenProjectInput {
  /** Absolute directory. `create: true` makes it (and `.nexgent/` with a default `config.json`) when missing. */
  readonly root: string
  readonly create?: boolean
}

// ---------------------------------------------------------------------------
// Sessions and history
// ---------------------------------------------------------------------------

/** One session in a project's list. */
export interface SessionSummary {
  readonly sessionId: string
  readonly title?: string
  /** The first prompt the user typed (`user.message` with `source: 'user'`, trimmed, at most 200 characters); lists fall back to it when there is no title. */
  readonly firstMessage?: string
  readonly createdAt: string
  /** `ts` of the last record. */
  readonly updatedAt: string
  readonly lastTurn: number
  /** A turn is running in this SDK instance. */
  readonly running: boolean
  /** The last turn was closed by crash recovery (`interrupted`) and nothing ran since. */
  readonly interrupted: boolean
  readonly goal?: Goal
  /** Step 3: set for a child session (member). */
  readonly parentSessionId?: string
  /** Step 3: set for a child session (member). */
  readonly member?: MemberIdentity
  /** Step 3: child sessions this session started (absent until the SDK counts them). */
  readonly childCount?: number
}

/** A member run as the parent's history shows it (from `subagent.start` / `subagent.end`). */
export interface MemberRunView {
  readonly childSessionId: string
  readonly childTurn: number
  readonly name: string
  readonly executionForm: MemberExecutionForm
  readonly mode?: DelegationMode
  readonly preset?: string
  readonly workflowId?: string
  /** `running` until `subagent.end` (a run left open by a crash reads `interrupted` after recovery). */
  readonly status: 'running' | MemberResultStatus
  readonly deliverables: readonly DeliverableVersionRef[]
  readonly usage?: LLMUsage
  readonly error?: ErrorInfo
  /** A completed member whose report names a blocker (its `Blockers:` line): it ran to the end but is stuck. */
  readonly blocker?: string
}

/** A workflow as the parent's history shows it (from `workflow.*`). */
export interface WorkflowView {
  readonly workflowId: string
  readonly kind: 'script' | 'graph'
  readonly title?: string
  readonly architecture?: string
  readonly phases: readonly string[]
  readonly status: 'running' | WorkflowStatus
  readonly members: number
  readonly error?: ErrorInfo
}

/** New direction step 2: an organization a turn ran (`organization` record). */
export interface OrganizationView {
  readonly organizationId: string
  readonly name: OrganizationName
  readonly roles: readonly OrganizationRole[]
  readonly workflowId: string
  /** The organization of the same turn it replaced, and why. */
  readonly replaces?: string
  readonly reason?: string
}

/** Who worked on a root session's task tree (`sessions.collaboration`). */
export interface CollaborationView {
  readonly sessionId: string
  /** Every member run, in start order. */
  readonly runs: readonly MemberRunView[]
  readonly workflows: readonly WorkflowView[]
  /** Present once a teammate was spawned: latest roster, board and every message (latest state per id). */
  readonly team?: { readonly members: readonly TeamMember[]; readonly tasks: readonly TeamTask[]; readonly messages: readonly TeamMessage[] }
}

/** Rework D3: a conversation turn's estimated dollars (members included); `estimated` when some usage or price was unknown, so `usd` may be low. */
export interface TurnCost {
  readonly usd: number
  readonly estimated: boolean
}

/** One item of a session's display history, derived from the records (not from the compacted model history). */
export type HistoryItem =
  | { readonly kind: 'user'; readonly turn: number; readonly text: string; readonly source: Exclude<UserMessageSource, 'inject'>; readonly materials: readonly string[] }
  | { readonly kind: 'assistant'; readonly turn: number; readonly step: number; readonly text: string; readonly finishReason: FinishReason; readonly interrupted: boolean }
  | { readonly kind: 'tool'; readonly turn: number; readonly step: number; readonly call: ToolCall; readonly content: string; readonly isError: boolean; readonly durationMs: number }
  | { readonly kind: 'approval'; readonly turn: number; readonly request: ApprovalRequest; readonly decision?: ApprovalDecision }
  | { readonly kind: 'deliverable'; readonly turn: number; readonly deliverable: DeliverableVersionRef }
  | { readonly kind: 'files'; readonly turn: number; readonly changes: readonly FileChange[] }
  | { readonly kind: 'feedback'; readonly turn: number; readonly deliverableId: string; readonly version: number; readonly rating?: number; readonly comment: string }
  | { readonly kind: 'compaction'; readonly turn: number }
  | { readonly kind: 'member'; readonly turn: number; readonly run: MemberRunView }
  | { readonly kind: 'workflow'; readonly turn: number; readonly workflow: WorkflowView }
  | { readonly kind: 'organization'; readonly turn: number; readonly organization: OrganizationView }
  | { readonly kind: 'team.message'; readonly turn?: number; readonly message: TeamMessage }
  | { readonly kind: 'turn.end'; readonly turn: number; readonly reason: TurnEndReason; readonly cost?: TurnCost }
  | { readonly kind: 'error'; readonly turn?: number; readonly error: ErrorInfo }
  /** Redesign 3.2: the turn's checks failed and the model was sent back to fix them. */
  | { readonly kind: 'check.retry'; readonly turn: number; readonly retry: CheckRetryView }
  /** Redesign 3.1: files went back to how they were before `toTurn` (between turns). */
  | { readonly kind: 'rewind'; readonly turn?: undefined; readonly rewind: RewindRecordView }

/** One failed check named in a check-retry note (`other` when the line does not parse). */
export interface CheckFailureView {
  readonly check: 'test-command' | 'check-command' | 'parses' | 'exists' | 'other'
  /** The command, the file path, or (for `other`) the whole line. */
  readonly target: string
  /** For `parses`: the format the file should parse as. */
  readonly format?: string
  readonly detail?: string
}

/** Redesign 3.2: one automatic retry after failed checks (`attempt` of `max`). */
export interface CheckRetryView {
  readonly attempt: number
  readonly max: number
  readonly failed: readonly CheckFailureView[]
}

/** Redesign 3.1: a `turn.rewind` record. */
export interface RewindRecordView {
  readonly toTurn: number
  readonly restored: readonly string[]
  readonly deleted: readonly string[]
}

/** A whole session as the UI shows it. */
export interface SessionView {
  readonly summary: SessionSummary
  /** The mode the session executes in (once plan mode is off). */
  readonly sandboxMode: SandboxMode
  /** ADR 0022: plan mode is on (tools act as in read-only until the user approves a plan). */
  readonly plan: boolean
  /** ADR 0022: whether this session's commands run in an OS sandbox, from `session.start`; absent in sessions written before it. */
  readonly commandSandbox?: CommandSandboxStatus
  readonly model: string
  readonly items: readonly HistoryItem[]
  readonly totalUsage: LLMUsage
}

/** Options of `sessions.create`. */
export interface CreateSessionInput {
  readonly projectId: string
  readonly title?: string
  /** Overrides `config.json.sandboxMode` for this session. */
  readonly sandboxMode?: SandboxMode
  /** ADR 0022: start in plan mode; `sandboxMode` applies once the user approves a plan. */
  readonly plan?: boolean
}

// ---------------------------------------------------------------------------
// Turns and events
// ---------------------------------------------------------------------------

/** Options of `turns.send`. */
export interface SendMessageInput {
  readonly projectId: string
  readonly sessionId: string
  readonly text: string
  /** Materials to reference in this message (`@` mentions and materials added since the last turn). */
  readonly materialIds?: readonly string[]
}

/** What `turns.send` and `feedback.submit` return at once; the turn runs on and reports through events. */
export interface TurnHandle {
  readonly sessionId: string
  readonly turn: number
  /** `turns.send` only: the message joined the turn already running (`turn`), whose next model request carries it. */
  readonly steered?: true
}

/** Fields every event carries. */
interface EventBase {
  readonly projectId: string
  readonly sessionId: string
  /** Per-session counter starting at 1, so a reconnecting renderer can detect gaps. */
  readonly eventSeq: number
  /** Step 3: set on every event of a child session. */
  readonly parentSessionId?: string
}

/** Fields every step-4 capability event carries (project-level: no session). */
interface CapabilityEventBase {
  readonly projectId: string
  /** Per-project counter of capability events starting at 1. */
  readonly eventSeq: number
  readonly sessionId?: undefined
  readonly parentSessionId?: undefined
}

/** Fields of an application-level event (API 7): no project, no session. */
interface AppEventBase {
  /** Absent; an API-6 host still set it. */
  readonly projectId?: string
  /** Per-application counter of application events starting at 1. */
  readonly eventSeq: number
  readonly sessionId?: undefined
  readonly parentSessionId?: undefined
}

/** Everything the SDK pushes to a subscriber (desktop: over the `nexgent:event` channel). */
export type SdkEvent =
  | EventBase & { readonly type: 'turn.start'; readonly turn: number; readonly source: Exclude<UserMessageSource, 'inject'> }
  | EventBase & { readonly type: 'text.delta'; readonly turn: number; readonly step: number; readonly text: string }
  | EventBase & { readonly type: 'reasoning.delta'; readonly turn: number; readonly step: number; readonly text: string }
  | EventBase & { readonly type: 'tool.start'; readonly turn: number; readonly step: number; readonly call: ToolCall }
  | EventBase & { readonly type: 'tool.result'; readonly turn: number; readonly step: number; readonly callId: string; readonly name: string; readonly content: string; readonly isError: boolean; readonly durationMs: number }
  | EventBase & { readonly type: 'approval.request'; readonly turn: number; readonly request: ApprovalRequest }
  | EventBase & { readonly type: 'approval.decision'; readonly turn: number; readonly decision: ApprovalDecision }
  | EventBase & { readonly type: 'assistant.message'; readonly turn: number; readonly step: number; readonly text: string; readonly finishReason: FinishReason; readonly interrupted: boolean; readonly usage: LLMUsage }
  | EventBase & { readonly type: 'deliverable.presented'; readonly turn: number; readonly deliverable: DeliverableVersionRef }
  | EventBase & { readonly type: 'turn.files'; readonly turn: number; readonly changes: readonly FileChange[] }
  | EventBase & { readonly type: 'compaction'; readonly turn: number; readonly compactedMessages: number }
  | EventBase & { readonly type: 'goal'; readonly goal: Goal }
  | EventBase & { readonly type: 'material.added'; readonly material: MaterialMetadata }
  | EventBase & { readonly type: 'error'; readonly turn?: number; readonly error: ErrorInfo; readonly fatal: boolean }
  | EventBase & { readonly type: 'turn.end'; readonly turn: number; readonly reason: TurnEndReason; readonly usage: LLMUsage; readonly cost?: TurnCost }
  /** Redesign 3.2: the turn's checks failed; the model goes back to fix them in the same turn. */
  | EventBase & { readonly type: 'check.retry'; readonly turn: number; readonly retry: CheckRetryView }
  /** Redesign 3.1: `sessions.rewind` put files back. */
  | EventBase & { readonly type: 'turn.rewind'; readonly rewind: RewindRecordView }
  /** Rework D2: the conversation got a title (`sessions.rename`, or the one named after its first turn). */
  | EventBase & { readonly type: 'session.title'; readonly title: string }
  /** Step 3, emitted on the parent session: a member run started / settled. */
  | EventBase & { readonly type: 'member.start'; readonly turn: number; readonly run: MemberRunView }
  | EventBase & { readonly type: 'member.end'; readonly turn: number; readonly run: MemberRunView }
  /** Step 3, emitted on the parent session. */
  | EventBase & { readonly type: 'workflow.phase'; readonly turn: number; readonly workflowId: string; readonly phase: string }
  /** New direction step 2, emitted on the parent session: the turn started (or changed to) an organization of members. */
  | EventBase & { readonly type: 'organization'; readonly turn: number; readonly organization: OrganizationView }
  /** Step 3, emitted on the Lead session for both the queued and the delivered state. */
  | EventBase & { readonly type: 'team.message'; readonly turn?: number; readonly message: TeamMessage }
  /** Step 4: the adopted version changed (adoption, approval, rollback). */
  | CapabilityEventBase & { readonly type: 'capability.version'; readonly current: CapabilityVersionView }
  /** Step 4: a candidate was proposed or changed status. */
  | CapabilityEventBase & { readonly type: 'capability.candidate'; readonly candidate: CandidateView }
  /** Step 4: a trial made progress (one event per receipt line, without plan details). */
  | CapabilityEventBase & { readonly type: 'capability.trial'; readonly candidateId: string; readonly trialId: string; readonly receipt: TrialReceipt['type']; readonly runsDone: number; readonly runsTotal: number; readonly status?: TrialStatus }
  /** Step 5: an improvement job was created or changed status (one event per status change); step 6: meta jobs too. */
  | CapabilityEventBase & { readonly type: 'improvement.job'; readonly job: ImprovementJobView }
  /** Step 6: the improver in force changed (a meta job adopted a child, a rollback); API 7: application-level (the improver is the user's). */
  | AppEventBase & { readonly type: 'improver.version'; readonly current: ImproverVersionView }
  /**
   * API 8 (ADR 0017 decision 5): spending crossed 80% of a cap (`warning`,
   * once per cap instance) or met it (`reached`). Project-level, so a
   * `perProject` warning reaches the window without an open session;
   * `sessionId` of the triggering session is in `triggerSessionId`.
   */
  | CapabilityEventBase & { readonly type: 'cost.warning'; readonly warning: CostWarningView }

/** The `type` vocabulary of {@link SdkEvent}. */
export type SdkEventType = SdkEvent['type']

/** Unsubscribe handle. */
export type Unsubscribe = () => void

// ---------------------------------------------------------------------------
// Capabilities (step 4)
// ---------------------------------------------------------------------------

/** The adopted capability version of a project. */
export interface CapabilityVersionView {
  readonly version: CapabilityVersion
  /** Activation revision (0 = baseline, never adopted). */
  readonly revision: number
  /** When the tail revision was committed; absent at revision 0. */
  readonly since?: string
  readonly trigger?: ActivationTrigger
  /** Components of the adopted bundle. */
  readonly components: readonly CapabilityComponentRef[]
  /** Set when the adopted bundle failed verification and the host fell back (`load-failure`). */
  readonly problem?: string
}

/** One candidate as lists show it. */
export interface CandidateView {
  readonly id: string
  readonly status: CandidateStatus
  readonly proposedAt: string
  readonly sessionId: string
  readonly components: readonly CapabilityComponentRef[]
  readonly requiresApproval: boolean
  readonly summary?: string
  /** Latest trial, when one started. */
  readonly trialId?: string
  /** Latest decision, when one was written. */
  readonly decision?: { readonly id: string; readonly outcome: DecisionOutcome; readonly reason: DecisionReason; readonly detail: string }
}

/** Everything recorded about one candidate. */
export interface CandidateDetail {
  readonly view: CandidateView
  readonly record: CandidateRecord
  /** Receipts of every trial of this candidate, in file order. */
  readonly receipts: readonly TrialReceipt[]
  readonly decisions: readonly CapabilityDecision[]
  /**
   * One entry per `plugin` component of the record, in component order,
   * built with `pluginApprovalInfo` from the candidate's copy of
   * `plugins/<name>/plugin.json`. Present whenever the record has a plugin
   * component; absent otherwise. When a plugin's `plugin.json` cannot be read
   * or fails validation, its entry is missing, and the approval dialog must
   * not offer `allow` for the candidate.
   */
  readonly plugins?: readonly PluginApprovalInfo[]
}

/** `capabilities.list`. */
export interface CapabilityListing {
  readonly current: CapabilityVersionView
  /** The activation chain, oldest first. */
  readonly history: readonly ActivationRevision[]
  /** Newest first. */
  readonly candidates: readonly CandidateView[]
}

// ---------------------------------------------------------------------------
// Improvement jobs (step 5)
// ---------------------------------------------------------------------------

/** One improvement job as lists show it. */
export interface ImprovementJobView {
  readonly id: string
  /** Step 6: `meta` for a meta job; absent means `capability`. */
  readonly kind?: ImprovementJobKind
  /** Step 6: the improver version the job runs on (absent in step-5 jobs: `v0`). */
  readonly improverVersion?: ImproverVersion
  /** ADR 0012: where that improver lives (`user` from the rework on; absent: `project`). */
  readonly improverScope?: ImproverScope
  readonly trigger: ImprovementTrigger
  readonly status: ImprovementStatus
  readonly createdAt: string
  readonly updatedAt: string
  /** Counted signals it answers (feedback entries and failed checks). */
  readonly itemCount: number
  /** Step 6: ids of the feedback entries among them, in order (`jobFeedbackIds`). */
  readonly feedbackIds: readonly string[]
  /** Step 6: when each phase ran, from the job's history (`jobPhaseTimes`). */
  readonly phaseTimes: Readonly<Partial<Record<ImprovementCostPhase, PhaseTimes>>>
  /** Step 6, meta jobs: the proposed improver and the comparison's verdict, once known. */
  readonly meta?: { readonly childVersion?: ImproverVersion; readonly outcome?: 'adopt' | 'reject'; readonly reason?: ImproverDecisionReason }
  /** Present once diagnosed: the suggested component kind, or `none`. */
  readonly proposalKind?: Diagnosis['proposalKind']
  readonly candidateId?: string
  readonly trialId?: string
  readonly decisionId?: string
  /** Last status change's detail (why it failed, what history is missing). */
  readonly detail?: string
  /** Billed tokens per phase that ran (`unknown` when any request's usage is unknown); a meta job's `compare` covers both arms. */
  readonly tokens: Readonly<Partial<Record<ImprovementCostPhase, number | 'unknown'>>>
  /** Display only, from the `@nexgent/llm` price table. */
  readonly estimatedUsd: number | 'unknown'
}

/** Everything recorded about one job: the chain feedback → diagnosis → candidate → trial → decision → first use. */
export interface ImprovementDetail {
  readonly view: ImprovementJobView
  readonly job: ImprovementJob
  /** Absent until the diagnose phase reported an accepted diagnosis. */
  readonly diagnosis?: Diagnosis
  /** The produced candidate, its receipts and decisions (as `capabilities.show`). */
  readonly candidate?: CandidateDetail
  /** Step 6, meta jobs: `meta-diagnosis.json`, once written. */
  readonly metaDiagnosis?: MetaDiagnosis
  /** Step 6, meta jobs: `change.json` (the proposed change, parent and child versions), once written. */
  readonly change?: ImproverChangeRecord
  /** Step 6, meta jobs: `comparison.json` (both arms, the origin, the verdict), once written. */
  readonly comparison?: ImproverComparison
}

/** `improvements.list`. */
export interface ImprovementListing {
  /** Newest first. */
  readonly jobs: readonly ImprovementJobView[]
  /** The running job, when one is. */
  readonly activeJobId?: string
  /** Counted signals waiting for the next job, and how many start one. */
  readonly pending: number
  readonly threshold: number
  /** Billed tokens spent in the current budget window, and the cap. */
  readonly budget: { readonly usedTokens: number; readonly maxTokens: number; readonly windowDays: number }
  /** Step 6: whether counted signals start jobs on their own (the project's `autoImprove`). */
  readonly autoImprove: boolean
  /**
   * Step 6: meta jobs: whether they start on their own, finished jobs
   * counted toward the next one and how many start it, and the meta budget
   * window. API 7: all user-level (the user queue and `userSettings`), the
   * same in every project. Absent until the SDK reads meta jobs.
   */
  readonly meta?: {
    readonly enabled: boolean
    readonly pending: number
    readonly everyJobs: number
    readonly budget: { readonly usedTokens: number; readonly maxTokens: number; readonly windowDays: number }
  }
}

// ---------------------------------------------------------------------------
// Improvers (step 6)
// ---------------------------------------------------------------------------

/** The improver in force. */
export interface ImproverVersionView {
  readonly version: ImproverVersion
  /** Activation revision (0 = `v0`, never changed). */
  readonly revision: number
  /** When the tail revision was committed; absent at revision 0. */
  readonly since?: string
  readonly trigger?: ImproverActivationTrigger
  /** The meta job that adopted it, when one did. */
  readonly jobId?: string
  /** Set when the improver in force failed to load and the host fell back (`load-failure`). */
  readonly problem?: string
}

/** `improvers.list`. */
export interface ImproverListing {
  readonly current: ImproverVersionView
  /** The activation chain, oldest first (the user-level line, API 7). */
  readonly history: readonly ImproverRevision[]
  /**
   * API 7: projects whose jobs ran on the current improver, most recent
   * first (for the rollback confirmation: a rollback affects them all).
   */
  readonly usedBy?: readonly { readonly root: string; readonly name: string; readonly lastJobAt: string }[]
}

/** `improvers.show`: one stored improver. */
export interface ImproverDetail {
  readonly version: ImproverVersion
  readonly bundle: ImproverBundle
  /** The accepted change that produced it (absent for `v0`). */
  readonly change?: ImproverChangeRecord
  /** Whether it is the improver in force. */
  readonly current: boolean
}

// ---------------------------------------------------------------------------
// Costs and learning (API 8, ADR 0017–0019)
// ---------------------------------------------------------------------------

/** What a `cost.warning` event carries (the ledger `cost.warning` record without attribution). */
export interface CostWarningView {
  readonly scope: CostCapScope
  readonly level: Exclude<CostCapLevel, 'ok'>
  readonly limit: 'maxUsd' | 'maxTokens' | 'maxRequests'
  readonly used: number
  readonly cap: number
  /** `used` includes estimated usage. */
  readonly estimated: boolean
  /** The session whose spending crossed it, when there is one. */
  readonly triggerSessionId?: string
  readonly ts: string
}

/** One handbook entry as the settings and learning pages show it. */
export interface HandbookEntryView extends HandbookEntry {
  /** Whether a task may be given it now (`isRetrievable`). */
  readonly retrievable: boolean
  /** Redesign UI 1: how it fared when given or held back by lot (ADR 0023), and when a task last used it; absent when unknown. */
  readonly evidence?: HandbookEntryEvidence
}

/** Redesign UI 1: one entry's randomized evidence (`Handbook.evidence()`) and its last use (`Handbook.usage()`). */
export interface HandbookEntryEvidence {
  /** Tasks it was drawn and shown to, with a known outcome. */
  readonly shown: number
  /** Tasks it was drawn and held back from, with a known outcome. */
  readonly heldBack: number
  /** Mean outcome (0–1) of each arm; absent with no tasks in that arm. */
  readonly shownMean?: number
  readonly heldBackMean?: number
  /** When a task last said it used the entry. */
  readonly lastUsedAt?: string
}

/** What `handbook.list` returns: the entries this project sees (its own plus the user's shared ones when `useShared`). */
export interface HandbookListing {
  readonly entries: readonly HandbookEntryView[]
  /** Whether user-scope entries are included (the project's `learning.useShared`). */
  readonly sharedIncluded: boolean
}

/** What `handbook.show` returns: the entry and every operation on it, oldest first. */
export interface HandbookEntryDetail {
  readonly entry: HandbookEntryView
  readonly ops: readonly HandbookOp[]
}

/** Learning spend of one phase in the budget window. */
export interface LearningPhaseSpend {
  readonly phase: LearningPhase
  readonly usd: number
  readonly requestCount: number
}

/** What `learning.status` returns. */
export interface LearningStatus {
  /** The project's `learning` settings. */
  readonly config: LearningConfig
  /** Whether the user acknowledged the notice (user level). */
  readonly noticeAcknowledged: boolean
  /** `mayLearn`: enabled and acknowledged. */
  readonly active: boolean
  /** Rules id of self-evaluations (`LEARNING_RULES`). */
  readonly rules: string
  /** Spend in the rolling window, against `config.budget`. */
  readonly budget: DollarBudget & {
    readonly spentUsd: number
    readonly remainingUsd: number
    /** Window start, ISO-8601 UTC. */
    readonly windowStart: string
    /** Some of the spend was estimated (`usageEstimated`). */
    readonly estimated: boolean
    readonly phases: readonly LearningPhaseSpend[]
  }
  /** Self-evaluations recorded in the window. */
  readonly selfEvaluations: number
  /** Scorer reliability of this project (ADR 0019 decision 6). */
  readonly reliability: ScorerReliability
}

/** One practice case without its prompt and rubric (`practice.list`). */
export interface PracticeCaseSummary {
  readonly id: string
  readonly source: PracticeCase['source']
  readonly split: PracticeSplit
  readonly clusterId: string
  readonly createdAt: string
  readonly projectId?: string
  readonly taskId?: string
  /** First line of the prompt, at most 200 characters. */
  readonly title: string
  readonly score?: number
}

/** What `practice.list` returns (read-only in API 8). */
export interface PracticeListing {
  readonly cases: readonly PracticeCaseSummary[]
  readonly counts: Readonly<Record<PracticeSplit, number>>
}

/**
 * ADR 0026/0027: one offline improvement run (user level), as the
 * capability page shows it.
 */
export interface OfflineRunView {
  readonly runId: string
  readonly createdAt: string
  readonly status: OfflineRunStatus
  /** Whether a run process is working on it now. */
  readonly live: boolean
  /** The planned cap the user approves (exactly), and the estimate it comes from. */
  readonly capUsd: number
  readonly estimateUsd: number
  readonly approvedAt?: string
  readonly spentUsd: number
  readonly iteration: number
  readonly maxIterations: number
  /** Versions found so far (the start included). */
  readonly versions: number
  readonly cases: { readonly minibatch: number; readonly selection: number; readonly holdout: number; readonly guard: number }
  readonly stop?: OfflineRunState['stop']
  readonly result?: OfflineRunResult
  readonly decision?: OfflineRunState['decision']
  /** The version it started from. */
  readonly start: OfflineCandidate
  /** The recommended version (only with `result.verdict` `recommended`). */
  readonly best?: OfflineCandidate
  /** Whether `offline.resume` can continue it (stopped or interrupted, approved, not over its cap). */
  readonly resumable: boolean
}

/** `offline.list`. */
export interface OfflineListing {
  readonly runs: readonly OfflineRunView[]
  /** The version in force for every project, if the user applied one. */
  readonly applied?: OfflineAppliedProfile
  /** The product's defaults (in force without an applied version). */
  readonly defaults: OfflineCandidate
  /** Practice cases by split: a run needs train, selection and holdout cases. */
  readonly practice: Readonly<Record<PracticeSplit, number>>
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** The editable part of `.nexgent/config.json` plus value-free credential facts. */
export interface ProjectSettings {
  readonly model: string
  readonly thinking: ThinkingMode
  readonly effort: Effort
  readonly sandboxMode: SandboxMode
  /** API 8: `perConversation` and `maxUsd` added. */
  readonly costCaps: CostCaps
  /** Step 5: whether counted feedback and failed checks start improvement jobs on their own (default `true`). Superseded by `learning.enabled` (API 8). */
  readonly autoImprove: boolean
  /** Step 5: threshold, improvement budget, model and thinking of improvement jobs. */
  readonly improvement: ImprovementConfig
  /** API 8 (ADR 0017–0019): background learning switch, dollar budget, self-eval ceiling, sharing. */
  readonly learning: LearningConfig
  /** The model API key: configured or not, and from where. Never the value. */
  readonly apiKey: CredentialInfo
  /** Rework D3: where Nexgent keeps this project's conversations, ledger and snapshots (ADR 0017 decision 4); read-only. */
  readonly dataDir?: string
  /** Redesign 3.2: automatic retries when a check of the turn fails (0–`MAX_CHECK_RETRIES`, default `DEFAULT_CHECK_RETRIES`). */
  readonly checkRetries: number
  /** Redesign 3.2: the project's own check commands, run when a turn changed something (empty: none). */
  readonly checkCommands: readonly string[]
}

/**
 * A settings change; absent fields stay. `costCaps` and `improvement`
 * replace their objects as given (missing improvement fields take their
 * defaults). Changing `sandboxMode`, `costCaps`, `autoImprove` or
 * `improvement` counts as a user action (no approval prompt), as it comes
 * from the settings page; the model can change none of them without approval
 * (`GUARDED_PROJECT_CONFIG_FIELDS`).
 */
export type SettingsPatch = Partial<Omit<ProjectSettings, 'apiKey' | 'improvement' | 'learning' | 'dataDir'>> & {
  readonly improvement?: ImprovementConfigInput
  /** API 8: replaces the object as given; missing fields take their defaults. */
  readonly learning?: LearningConfigInput
}

/** API 7 (ADR 0012): `<NEXGENT_HOME>/config.json`, shared by every project. */
export interface UserSettings {
  /** Meta jobs over the shared improver: switch (default off), `everyJobs`, meta budget, model. */
  readonly improvement: { readonly meta: MetaImprovementConfig }
  /** API 8: whether the user acknowledged background learning (`learning.acknowledge`). */
  readonly learning: UserLearningSettings
  /** Rework D2: the interface language (BCP 47) learning writes in; absent: each task's language. */
  readonly language?: string
}

/** A user settings change from the settings page (a user action, no approval prompt); missing meta fields take their defaults. */
export interface UserSettingsPatch {
  readonly improvement?: { readonly meta?: MetaImprovementConfigInput }
  /** Rework D2: the interface language (BCP 47); `null` removes it (each task's language again). */
  readonly language?: string | null
}

// ---------------------------------------------------------------------------
// Project files
// ---------------------------------------------------------------------------

/** One file of the project tree (`files.list`). */
export interface ProjectFileEntry {
  /** Project-relative path, `/`-separated. */
  readonly path: string
  readonly size: number
  /** ISO-8601 instant of the last modification. */
  readonly modifiedAt: string
}

/** What `files.list` returns: regular files under the project root, sorted by path. */
export interface ProjectFileListing {
  readonly files: readonly ProjectFileEntry[]
  /** More than {@link PROJECT_FILES_LIMIT} files: the list stops there. */
  readonly truncated: boolean
}

/** Most files `files.list` returns. */
export const PROJECT_FILES_LIMIT = 5000

/** Directories `files.list` never enters (host data, VCS, dependencies). */
export const PROJECT_FILES_SKIPPED_DIRS = ['.nexgent', '.git', 'node_modules'] as const

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** What `sessions.export` produced: a directory (or the caller's choice of path) holding the minimal export bundle. */
export interface ExportResult {
  /** Absolute path of the bundle directory. */
  readonly path: string
  /** Bundle-relative files written: `session.jsonl`, `ledger.jsonl`, `materials.json`, `deliverables.json`, `manifest.json`. */
  readonly files: readonly string[]
}

// ---------------------------------------------------------------------------
// The SDK
// ---------------------------------------------------------------------------

/** What `app.info` reports. */
export interface AppInfo {
  readonly sdkVersion: number
  readonly appVersion: string
  readonly platform: string
  /**
   * The shell every command runs through, checked once at start-up. On
   * Windows it is PowerShell 7 (`pwsh`); `available: false` means no command
   * can run until it is installed.
   */
  readonly commandShell: { readonly shell: 'pwsh' | 'bash'; readonly required: boolean; readonly available: boolean }
}

/**
 * Every SDK operation, keyed by its IPC method name. Each entry is
 * `(input) => Promise<result>`; the desktop preload exposes exactly these
 * names (plus event subscription) and nothing else.
 */
/** What `sessions.rewind` found or did (redesign 3.1). */
export interface RewindView {
  readonly turn: number
  /** When the snapshot was taken (ISO-8601 UTC). */
  readonly takenAt: string
  /** Files that change (`restore`: old content back; `delete`: did not exist before the turn). */
  readonly changes: readonly { readonly path: string; readonly action: 'restore' | 'delete' }[]
  /** Files the session changed that are already as they were. */
  readonly unchanged: readonly string[]
  /** Whether the files were written (`apply: true` with something to change). */
  readonly applied: boolean
}

export interface SdkMethods {
  'app.info': (input: Record<string, never>) => Promise<AppInfo>

  'projects.recent': (input: Record<string, never>) => Promise<readonly ProjectInfo[]>
  'projects.open': (input: OpenProjectInput) => Promise<ProjectInfo>
  'projects.close': (input: { readonly projectId: string }) => Promise<void>
  'projects.forget': (input: { readonly root: string }) => Promise<void>

  /** Root sessions only, unless `includeChildren` (step 3). */
  'sessions.list': (input: { readonly projectId: string; readonly includeChildren?: boolean }) => Promise<readonly SessionSummary[]>
  /** Step 3: child sessions of one session, in creation order. */
  'sessions.children': (input: { readonly projectId: string; readonly sessionId: string }) => Promise<readonly SessionSummary[]>
  /** Step 3: read-only view of any session (a child included) without taking its lock. */
  'sessions.view': (input: { readonly projectId: string; readonly sessionId: string }) => Promise<SessionView>
  /** Step 3: member runs, workflows and team state recorded in a session. */
  'sessions.collaboration': (input: { readonly projectId: string; readonly sessionId: string }) => Promise<CollaborationView>
  'sessions.create': (input: CreateSessionInput) => Promise<SessionSummary>
  /** Takes the session lock (resuming and closing an interrupted turn when needed) and returns the view. */
  'sessions.open': (input: { readonly projectId: string; readonly sessionId: string }) => Promise<SessionView>
  /** Releases the lock; a running turn is cancelled first (cause `shutdown`). */
  'sessions.close': (input: { readonly projectId: string; readonly sessionId: string }) => Promise<void>
  'sessions.export': (input: { readonly projectId: string; readonly sessionId: string; readonly outDir: string }) => Promise<ExportResult>
  /** Writes `session.title` (the title is trimmed; empty rejects `tool/invalid-input`) and returns the updated summary. */
  'sessions.rename': (input: { readonly projectId: string; readonly sessionId: string; readonly title: string }) => Promise<SessionSummary>
  /**
   * ADR 0022 decision 4: the user switches the session's mode or plan mode
   * mid-session (`session.mode`, effective from the next tool call); takes
   * the session lock like `sessions.open`. Returns the updated view.
   */
  'sessions.setMode': (input: { readonly projectId: string; readonly sessionId: string; readonly sandboxMode?: SandboxMode; readonly plan?: boolean }) => Promise<SessionView>
  /**
   * Redesign 3.1: put the project files this session changed in `turn` and
   * later back to how they were before `turn` (from that turn's snapshot).
   * Without `apply` it only lists what would change, so the host can ask
   * first; with `apply: true` it writes the files and a `turn.rewind`
   * record. The conversation and its history stay. Root sessions only;
   * rejects `session/locked` while a turn runs and `session/not-found` when
   * that turn has no snapshot.
   */
  'sessions.rewind': (input: { readonly projectId: string; readonly sessionId: string; readonly turn: number; readonly apply?: boolean }) => Promise<RewindView>

  /** Lists the project's regular files (symbolic links are not followed; {@link PROJECT_FILES_SKIPPED_DIRS} are skipped). */
  'files.list': (input: { readonly projectId: string }) => Promise<ProjectFileListing>

  /** Desktop only: the native folder picker (opening a project). `null` when cancelled; the CLI rejects with `internal`. */
  'dialogs.pickDirectory': (input: Record<string, never>) => Promise<string | null>
  /** Desktop only: the native multi-file picker (adding materials). Empty when cancelled; the CLI rejects with `internal`. */
  'dialogs.pickFiles': (input: Record<string, never>) => Promise<readonly string[]>

  /** Starts a turn; rejects `session/locked` when one is already running in that session. */
  'turns.send': (input: SendMessageInput) => Promise<TurnHandle>
  /** Cancels the running turn (cause `user`); resolves after its `turn.end` was written. No-op when idle. */
  'turns.cancel': (input: { readonly projectId: string; readonly sessionId: string }) => Promise<void>
  /** Answers a pending approval; a late or repeated answer is ignored (resolves `false`). */
  'approvals.respond': (input: { readonly projectId: string; readonly sessionId: string; readonly decision: Omit<ApprovalDecision, 'decidedBy'> }) => Promise<boolean>

  /** Copies the file; the session (when given) gets a `material.added` record. */
  'materials.add': (input: { readonly projectId: string; readonly sourcePath: string; readonly sessionId?: string }) => Promise<MaterialMetadata>
  'materials.list': (input: { readonly projectId: string; readonly includeRemoved?: boolean }) => Promise<readonly MaterialMetadata[]>
  'materials.remove': (input: { readonly projectId: string; readonly materialId: string }) => Promise<MaterialMetadata>

  'deliverables.list': (input: { readonly projectId: string }) => Promise<readonly DeliverableSummary[]>
  'deliverables.get': (input: { readonly projectId: string; readonly deliverableId: string; readonly version: number }) => Promise<DeliverableVersion>
  'deliverables.diff': (input: { readonly projectId: string; readonly deliverableId: string; readonly from: number; readonly to: number }) => Promise<DeliverableDiff>
  /** Reads one snapshot file as text (UTF-8, at most 1 MiB; larger or binary files reject with `tool/invalid-input`). A `.xlsx`, `.docx` or `.pdf` (at most 20 MiB) comes back as its extracted text: each sheet as a `## Sheet:` heading and CSV rows, or the document's text. */
  'deliverables.readText': (input: { readonly projectId: string; readonly deliverableId: string; readonly version: number; readonly path: string }) => Promise<string>
  /** Shows the snapshot file in the system file manager (desktop only; the CLI rejects with `internal`). */
  'deliverables.reveal': (input: { readonly projectId: string; readonly deliverableId: string; readonly version: number; readonly path: string }) => Promise<void>
  /** Rework D3, desktop only: show the project's data directory ({@link ProjectSettings.dataDir}) in the OS file manager. */
  'projects.revealData': (input: { readonly projectId: string }) => Promise<void>

  /** Writes `feedback` and starts the feedback turn. */
  'feedback.submit': (input: SubmitFeedbackInput & { readonly projectId: string; readonly sessionId: string }) => Promise<TurnHandle>
  'feedback.list': (input: { readonly projectId: string; readonly sessionId?: string; readonly deliverableId?: string }) => Promise<readonly FeedbackListing[]>

  'goals.get': (input: { readonly projectId: string; readonly sessionId: string }) => Promise<Goal | null>
  'goals.set': (input: { readonly projectId: string; readonly sessionId: string; readonly text: string }) => Promise<Goal>
  'goals.update': (input: { readonly projectId: string; readonly sessionId: string; readonly status: GoalStatus; readonly text?: string; readonly note?: string }) => Promise<Goal>

  'settings.get': (input: { readonly projectId: string }) => Promise<ProjectSettings>
  'settings.update': (input: { readonly projectId: string; readonly patch: SettingsPatch }) => Promise<ProjectSettings>
  /** Stores the key in `~/.nexgent/credentials.json` (mode 0600); returns only the facts, never the value. An empty string removes it. */
  'settings.setApiKey': (input: { readonly value: string }) => Promise<CredentialInfo>
  /** API 7: the user-level settings (`<NEXGENT_HOME>/config.json`). */
  'userSettings.get': (input: Record<string, never>) => Promise<UserSettings>
  /** API 7: change the user-level settings; invalid values reject `config/invalid`. */
  'userSettings.update': (input: { readonly patch: UserSettingsPatch }) => Promise<UserSettings>

  /** Step 4: the adopted version (verified; falls back like a new session would). */
  'capabilities.current': (input: { readonly projectId: string }) => Promise<CapabilityVersionView>
  /** Step 4: adopted version, activation history and candidates. */
  'capabilities.list': (input: { readonly projectId: string }) => Promise<CapabilityListing>
  /** Step 4: one candidate with its receipts and decisions; unknown id rejects `tool/invalid-input`. */
  'capabilities.show': (input: { readonly projectId: string; readonly candidateId: string }) => Promise<CandidateDetail>
  /** Step 4: start the gate for a `proposed` candidate now (when `autoTrial` is off, or to retry after history grew). */
  'capabilities.trial': (input: { readonly projectId: string; readonly candidateId: string }) => Promise<CandidateView>
  /** Step 4: answer an `awaiting-approval` plugin candidate; `allow` writes the adoption revision, `deny` rejects it. */
  'capabilities.approve': (input: { readonly projectId: string; readonly candidateId: string; readonly decision: 'allow' | 'deny' }) => Promise<CandidateView>
  /** Step 4: roll back to the previous version (or `toVersion`, which must appear earlier in the chain); writes a `manual` revision. */
  'capabilities.rollback': (input: { readonly projectId: string; readonly toVersion?: CapabilityVersion; readonly reason?: string }) => Promise<CapabilityVersionView>

  /** Step 5: jobs (newest first), the queue and the budget window. */
  'improvements.list': (input: { readonly projectId: string }) => Promise<ImprovementListing>
  /** Step 5: one job with its diagnosis and candidate; unknown id rejects `improvement/not-found`. */
  'improvements.show': (input: { readonly projectId: string; readonly jobId: string }) => Promise<ImprovementDetail>
  /**
   * Step 5: the explicit "improve" (trigger `explicit`): starts a job now,
   * regardless of the count and of `autoImprove`, pointing at a session or a
   * deliverable when given. Rejects `improvement/busy` while a job runs and
   * `improvement/budget-exhausted` when the window's budget is spent.
   */
  'improvements.run': (input: { readonly projectId: string; readonly sessionId?: string; readonly deliverableId?: string }) => Promise<ImprovementJobView>
  /** Step 5: cancel a running job (status `cancelled`); a final job is returned unchanged. */
  'improvements.cancel': (input: { readonly projectId: string; readonly jobId: string }) => Promise<ImprovementJobView>
  /**
   * Step 6: start a meta job now (trigger `explicit`), whatever
   * `improvement.meta.enabled` says and whatever finished jobs are pending.
   * `keepCopies` (experiments only, not on the settings page) keeps both
   * comparison copies after the decision. Rejects `improvement/busy` while
   * a job runs and `improvement/budget-exhausted` when the meta budget is spent.
   */
  'improvements.runMeta': (input: { readonly projectId: string; readonly keepCopies?: boolean }) => Promise<ImprovementJobView>

  /** Step 6: the improver in force and the activation chain; API 7: the user-level line (`projectId` is ignored). */
  'improvers.list': (input: { readonly projectId?: string }) => Promise<ImproverListing>
  /** Step 6: one stored improver (`v0` included); an unknown version rejects `improver/not-found`. API 7: user-level. */
  'improvers.show': (input: { readonly projectId?: string; readonly version: ImproverVersion }) => Promise<ImproverDetail>
  /** Step 6: roll back to the previous improver (or `toVersion`, which must have been in force earlier, `v0` included); writes a `manual` revision. API 7: user-level, affects every project. */
  'improvers.rollback': (input: { readonly projectId?: string; readonly toVersion?: ImproverVersion; readonly reason?: string }) => Promise<ImproverVersionView>

  /** API 8: handbook entries this project sees; retired ones only with `includeRetired`; `scope` narrows. */
  'handbook.list': (input: { readonly projectId: string; readonly scope?: HandbookScope; readonly includeRetired?: boolean }) => Promise<HandbookListing>
  /** API 8: one entry with its operations; an unknown id rejects `handbook/not-found`. */
  'handbook.show': (input: { readonly projectId: string; readonly entryId: string }) => Promise<HandbookEntryDetail>
  /** Rework D2: the user stops (`retired`) or restores (`active`) an entry; returns it with its operations. An unknown id rejects `handbook/not-found`. */
  'handbook.setStatus': (input: { readonly projectId: string; readonly entryId: string; readonly status: 'active' | 'retired'; readonly reason?: string }) => Promise<HandbookEntryDetail>
  /** API 8: learning settings, spend in the window and scorer reliability. */
  'learning.status': (input: { readonly projectId: string }) => Promise<LearningStatus>
  /** API 8: the user acknowledged the background-learning notice (user level; idempotent, keeps the first time). */
  'learning.acknowledge': (input: Record<string, never>) => Promise<UserSettings>
  /** API 8: practice cases (user level), optionally of one project or split; read-only. */
  'practice.list': (input: { readonly projectId?: string; readonly split?: PracticeSplit }) => Promise<PracticeListing>
  /** API 8: one practice case; an unknown id rejects `practice/not-found`. */
  'practice.show': (input: { readonly caseId: string }) => Promise<PracticeCase>
  /** ADR 0027: offline improvement runs (user level, newest first), the applied version and the practice counts. */
  'offline.list': (input: Record<string, never>) => Promise<OfflineListing>
  /** ADR 0026: plan a run from the practice set (spends nothing); rejects `tool/invalid-input` with too few cases. */
  'offline.plan': (input: Record<string, never>) => Promise<OfflineRunView>
  /** ADR 0026: approve a planned run at exactly its planned cap and start it in a background process. */
  'offline.approve': (input: { readonly runId: string; readonly capUsd: number }) => Promise<OfflineRunView>
  /** Continue a stopped or interrupted run (same plan, same cap). */
  'offline.resume': (input: { readonly runId: string }) => Promise<OfflineRunView>
  /** Ask a running run to stop at its next stage boundary. */
  'offline.stop': (input: { readonly runId: string }) => Promise<OfflineRunView>
  /** ADR 0027: the user's answer to a finished run: `apply` puts its recommended version in force for every project. */
  'offline.decide': (input: { readonly runId: string; readonly answer: 'apply' | 'decline' }) => Promise<OfflineRunView>
  /** ADR 0027: stop using the applied version (back to the defaults). */
  'offline.revert': (input: Record<string, never>) => Promise<OfflineListing>
}

/** An IPC method name. */
export type SdkMethodName = keyof SdkMethods

/** The input of a method. */
export type SdkInput<M extends SdkMethodName> = Parameters<SdkMethods[M]>[0]

/** The resolved result of a method. */
export type SdkResult<M extends SdkMethodName> = Awaited<ReturnType<SdkMethods[M]>>

/**
 * The renderer whitelist (`permissions.md` §本地 IPC 与访问令牌): exactly the
 * keys of {@link SdkMethods}. A test keeps the two in sync.
 */
export const SDK_METHOD_NAMES = [
  'app.info',
  'projects.recent',
  'projects.open',
  'projects.close',
  'projects.forget',
  'sessions.list',
  'sessions.children',
  'sessions.view',
  'sessions.collaboration',
  'sessions.create',
  'sessions.open',
  'sessions.close',
  'sessions.export',
  'sessions.rename',
  'sessions.setMode',
  'sessions.rewind',
  'files.list',
  'dialogs.pickDirectory',
  'dialogs.pickFiles',
  'turns.send',
  'turns.cancel',
  'approvals.respond',
  'materials.add',
  'materials.list',
  'materials.remove',
  'deliverables.list',
  'deliverables.get',
  'deliverables.diff',
  'deliverables.readText',
  'deliverables.reveal',
  'projects.revealData',
  'feedback.submit',
  'feedback.list',
  'goals.get',
  'goals.set',
  'goals.update',
  'settings.get',
  'settings.update',
  'settings.setApiKey',
  'userSettings.get',
  'userSettings.update',
  'capabilities.current',
  'capabilities.list',
  'capabilities.show',
  'capabilities.trial',
  'capabilities.approve',
  'capabilities.rollback',
  'improvements.list',
  'improvements.show',
  'improvements.run',
  'improvements.cancel',
  'improvements.runMeta',
  'improvers.list',
  'improvers.show',
  'improvers.rollback',
  'handbook.list',
  'handbook.show',
  'handbook.setStatus',
  'learning.status',
  'learning.acknowledge',
  'practice.list',
  'practice.show',
  'offline.list',
  'offline.plan',
  'offline.approve',
  'offline.resume',
  'offline.stop',
  'offline.decide',
  'offline.revert',
] as const satisfies readonly SdkMethodName[]

/** The in-process SDK object (CLI and desktop main process). */
export interface NexgentSdk {
  readonly apiVersion: typeof SDK_API_VERSION
  /** Call any method by name; the IPC handler is a thin wrapper over this. */
  call<M extends SdkMethodName>(method: M, input: SdkInput<M>): Promise<SdkResult<M>>
  /** Receive events of every open session (filter by `sessionId` on the consumer side). */
  subscribe(listener: (event: SdkEvent) => void): Unsubscribe
  /** Cancel running turns (cause `shutdown`), wait for their `turn.end`, release every lock. */
  dispose(): Promise<void>
}

/** Options of the SDK factory (`createSdk` in W4). */
export interface CreateSdkOptions {
  /** Overrides `~/.nexgent` (recent projects, credentials, logs); also read from `NEXGENT_HOME`. */
  readonly home?: string
  /** Application version reported by `app.info`. */
  readonly appVersion: string
  /** Desktop only: reveal a file in the OS file manager. */
  readonly reveal?: (absolutePath: string) => Promise<void>
  /** Desktop only: the native folder picker behind `dialogs.pickDirectory` (`null` when cancelled). */
  readonly pickDirectory?: () => Promise<string | null>
  /** Desktop only: the native multi-file picker behind `dialogs.pickFiles` (empty when cancelled). */
  readonly pickFiles?: () => Promise<readonly string[]>
  /**
   * Rework D2: after a conversation's first turn completes and it has no
   * title, name it with one short request to the execution model (counted in
   * the ledger) and write `session.title` (default off; the desktop app turns
   * it on).
   */
  readonly autoTitle?: boolean
  /**
   * ADR 0026: how an approved offline run is started (default: a detached
   * `offline-entry.js run <runId>` process); tests pass a stub.
   */
  readonly offlineLauncher?: (home: string, runId: string) => void
}
