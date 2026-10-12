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
 */
import type {
  ActivationRevision,
  ActivationTrigger,
  ApprovalDecision,
  CandidateRecord,
  CandidateStatus,
  CapabilityComponentRef,
  CapabilityDecision,
  CapabilityVersion,
  DecisionOutcome,
  DecisionReason,
  PluginApprovalInfo,
  TrialReceipt,
  TrialStatus,
  ApprovalRequest,
  CostCap,
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
} from '@nexgent/kernel'

/** API version; bumped only by a contract-change PR. */
export const SDK_API_VERSION = 4

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

/** Who worked on a root session's task tree (`sessions.collaboration`). */
export interface CollaborationView {
  readonly sessionId: string
  /** Every member run, in start order. */
  readonly runs: readonly MemberRunView[]
  readonly workflows: readonly WorkflowView[]
  /** Present once a teammate was spawned: latest roster, board and every message (latest state per id). */
  readonly team?: { readonly members: readonly TeamMember[]; readonly tasks: readonly TeamTask[]; readonly messages: readonly TeamMessage[] }
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
  | { readonly kind: 'team.message'; readonly turn?: number; readonly message: TeamMessage }
  | { readonly kind: 'turn.end'; readonly turn: number; readonly reason: TurnEndReason }
  | { readonly kind: 'error'; readonly turn?: number; readonly error: ErrorInfo }

/** A whole session as the UI shows it. */
export interface SessionView {
  readonly summary: SessionSummary
  readonly sandboxMode: SandboxMode
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
  | EventBase & { readonly type: 'turn.end'; readonly turn: number; readonly reason: TurnEndReason; readonly usage: LLMUsage }
  /** Step 3, emitted on the parent session: a member run started / settled. */
  | EventBase & { readonly type: 'member.start'; readonly turn: number; readonly run: MemberRunView }
  | EventBase & { readonly type: 'member.end'; readonly turn: number; readonly run: MemberRunView }
  /** Step 3, emitted on the parent session. */
  | EventBase & { readonly type: 'workflow.phase'; readonly turn: number; readonly workflowId: string; readonly phase: string }
  /** Step 3, emitted on the Lead session for both the queued and the delivered state. */
  | EventBase & { readonly type: 'team.message'; readonly turn?: number; readonly message: TeamMessage }
  /** Step 4: the adopted version changed (adoption, approval, rollback). */
  | CapabilityEventBase & { readonly type: 'capability.version'; readonly current: CapabilityVersionView }
  /** Step 4: a candidate was proposed or changed status. */
  | CapabilityEventBase & { readonly type: 'capability.candidate'; readonly candidate: CandidateView }
  /** Step 4: a trial made progress (one event per receipt line, without plan details). */
  | CapabilityEventBase & { readonly type: 'capability.trial'; readonly candidateId: string; readonly trialId: string; readonly receipt: TrialReceipt['type']; readonly runsDone: number; readonly runsTotal: number; readonly status?: TrialStatus }

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
// Settings
// ---------------------------------------------------------------------------

/** The editable part of `.nexgent/config.json` plus value-free credential facts. */
export interface ProjectSettings {
  readonly model: string
  readonly thinking: ThinkingMode
  readonly effort: Effort
  readonly sandboxMode: SandboxMode
  readonly costCaps: { readonly perTask?: CostCap; readonly perProject?: CostCap }
  /** The model API key: configured or not, and from where. Never the value. */
  readonly apiKey: CredentialInfo
}

/** A settings change; absent fields stay. `costCaps` replaces both objects as given. Changing `sandboxMode` or `costCaps` counts as a user action (no approval prompt), as it comes from the settings page. */
export type SettingsPatch = Partial<Omit<ProjectSettings, 'apiKey'>>

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

/**
 * Every SDK operation, keyed by its IPC method name. Each entry is
 * `(input) => Promise<result>`; the desktop preload exposes exactly these
 * names (plus event subscription) and nothing else.
 */
export interface SdkMethods {
  'app.info': (input: Record<string, never>) => Promise<{ readonly sdkVersion: number; readonly appVersion: string; readonly platform: string }>

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
  /** Reads one snapshot file as text (UTF-8, at most 1 MiB; larger or binary files reject with `tool/invalid-input`). */
  'deliverables.readText': (input: { readonly projectId: string; readonly deliverableId: string; readonly version: number; readonly path: string }) => Promise<string>
  /** Shows the snapshot file in the system file manager (desktop only; the CLI rejects with `internal`). */
  'deliverables.reveal': (input: { readonly projectId: string; readonly deliverableId: string; readonly version: number; readonly path: string }) => Promise<void>

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
  'feedback.submit',
  'feedback.list',
  'goals.get',
  'goals.set',
  'goals.update',
  'settings.get',
  'settings.update',
  'settings.setApiKey',
  'capabilities.current',
  'capabilities.list',
  'capabilities.show',
  'capabilities.trial',
  'capabilities.approve',
  'capabilities.rollback',
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
}
