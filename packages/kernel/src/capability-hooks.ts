/**
 * Step 4 host seams of the agent loop (kernel interfaces, not contracts;
 * `agent-hooks.md` §步骤 4). Both services are optional: without them the
 * loop behaves as in step 3 (no `capabilityVersion`, no snapshots or checks).
 *
 * - `ctx.capabilityHost` is provided by `@nexgent/capabilities`. The kernel
 *   asks it for the adopted version when a root session opens, checks a
 *   recorded version on resume, and hands it every opened agent's scoped
 *   context so the bundle's components (and the session's tried drafts) are
 *   registered there and released when the agent closes.
 * - `ctx.taskRecorder` is provided by `@nexgent/tasking`. The kernel calls it
 *   when a root turn starts (workspace snapshot) and when it ends
 *   (deterministic checks); step 5 keeps one record of each per turn.
 * - `ctx.learning` is provided by `@nexgent/evolve`. The kernel signals
 *   every root turn that ended, so the host can learn from the task.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { CapabilityComponentRef, CapabilityVersion, TaskCheckSpec } from './contracts/capabilities.js'
import type { MemberIdentity, WorkdirMerge } from './contracts/collaboration.js'
import type { JsonValue } from './contracts/json.js'
import type { TaskCheck } from './contracts/ledger.js'
import type { FileChange } from './contracts/tasking.js'
import type { TurnEndReason } from './contracts/session.js'
import type { SandboxMode } from './contracts/workspace.js'
import type { OrganizationProfile, OrganizationChange, OrganizationChangeNote, OrganizationClassSummary, OrganizationDecision, OrganizationLevel, OrganizationName, OrganizationRole, OrganizationRun, OrganizationShape, OrganizationUse } from './contracts/organization.js'
import type { SessionRecord } from './contracts/session.js'
import type { ThreadHost } from './contracts/threads.js'
import type { SystemPromptSection } from './contracts/context.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** `@nexgent/capabilities` (step 4, optional): adopted versions and per-session component loading. */
    capabilityHost: CapabilityHost
    /** `@nexgent/tasking` (step 4, optional): task-start snapshots and task-end checks. */
    taskRecorder: TaskRecorder
    /** `@nexgent/evolve` (optional): background learning, told when a root task turn ends. */
    learning: LearningSignals
    /** `@nexgent/tasking` (rework K4 D4, optional): members' own copies of the project. */
    workdirs: MemberWorkdirs
    /** New direction step 2 (optional): whether members help with a root turn. */
    organizer: TurnOrganizer
    /** New direction step 3 (optional): what worked on similar tasks. */
    organizations: OrganizationMemory
    /** Coordinator step two (optional, the host): the coordinator conversation's threads. */
    threads: ThreadHost
  }
}

/** What {@link TurnOrganizer.decide} gets: a root session's user or feedback turn. */
export interface TurnOrganizerInput {
  readonly sessionId: string
  readonly turn: number
  readonly text: string
  readonly source: 'user' | 'feedback'
  readonly materialIds: readonly string[]
  /** A feedback turn's rating (1–5), when it has one. */
  readonly rating?: number
  /** Absolute project root (the library places a task whose words match no class by the project's earlier runs). */
  readonly projectRoot?: string
  /**
   * The project's coordinator conversation: it hands every part of the work
   * to threads (a thread organizes its own members), so its sections say so
   * and its turns are coordinator-level runs in the organization library.
   */
  readonly coordinator?: boolean
  /** A thread's turn the coordinator gave it: one part of a larger task, so the thread judges from the part whether members are worth it. */
  readonly thread?: boolean
}

/** What {@link TurnOrganizer.noteTurnEnd} gets after a root turn the organizer decided. */
export interface TurnOrganizationEnd {
  readonly sessionId: string
  readonly turn: number
  readonly reason: TurnEndReason
  readonly checks?: readonly TaskCheck[]
  readonly use: OrganizationUse
  /** The last organization the turn ran. */
  readonly organization?: OrganizationShape
  /** The turn's cost in USD over the task tree. */
  readonly usd: number
  /** Absolute project root. */
  readonly projectRoot: string
  /** Tools the root session called this turn, sorted. */
  readonly tools: readonly string[]
  /** Files the turn changed (project-relative, at most 200). */
  readonly changes: readonly FileChange[]
  /** Files the turn presented as its result (project-relative, at most 50). */
  readonly presented: readonly string[]
  /** Coordinator: automatic check retries the turn made. */
  readonly checkRetries?: number
  /** Coordinator: read a session's records (the root's, and its members' child sessions) to measure the organization. */
  readonly readSession?: (sessionId: string) => Promise<readonly SessionRecord[]>
}

/**
 * New direction step 2: `ctx.organizer`. Asked before a root turn's
 * `turn.start`; the kernel records the decision as `turn.start.organization`
 * and adds `section` to the system prompt of every request of the turn.
 * Throwing or `undefined` leaves the turn undecided (no section, no field).
 */
export interface TurnOrganizer {
  decide(input: TurnOrganizerInput): Promise<{ readonly decision: OrganizationDecision; readonly section: SystemPromptSection } | undefined>
  /** Step 3 (optional): after `turn.end` of a turn it decided; failures are ignored. */
  noteTurnEnd?(input: TurnOrganizationEnd): Promise<void>
}

/** Step 3: what the library proposes for a task. */
export interface OrganizationSuggestion {
  readonly classId: string
  readonly key: readonly string[]
  /** Runs recorded for the class so far. */
  readonly runs: number
  readonly decision: OrganizationDecision['decision']
  /** This turn is the comparison side (alone while teams are preferred, or the reverse). */
  readonly control: boolean
  /** The organization to start from, with the roles of its best run when there is one. */
  readonly organization?: { readonly name: OrganizationName; readonly roles?: readonly OrganizationRole[] }
  /** Coordinator (team only): the change the class tries now, found by reflecting on the last similar task. */
  readonly change?: OrganizationChange
  /** Coordinator (team only): changes the class kept, newest first (at most 3). */
  readonly kept?: readonly OrganizationChange[]
  /** Coordinator (team only): the line for the team card. */
  readonly note?: OrganizationChangeNote
}

/**
 * New direction step 3: `ctx.organizations`, the user's organization
 * library. Classes similar tasks by their words, compares organizations and
 * working alone inside each class by the checks, corrections, rework and
 * cost, and proposes what to use next. Coordinator: `record` also reflects
 * on the run's organization profile (hottest part, one change, keep or
 * revert on the next similar tasks). No model requests.
 */
export interface OrganizationMemory {
  /**
   * `projectRoot`: words that match no class fall back to the class the
   * project's latest run's traits place it in, the same rule `record` uses,
   * so the run gets the advice of the class it is recorded in.
   */
  suggest(input: { readonly text: string; readonly random?: () => number; readonly projectRoot?: string; readonly level?: OrganizationLevel }): Promise<OrganizationSuggestion>
  record(run: Omit<OrganizationRun, 'id' | 'at'>): Promise<void>
  /** The user asked for changes to what a session's last recorded turn produced. */
  noteRework(input: { readonly sessionId: string }): Promise<void>
  /** Mark the recorded turns of a project whose presented files are all gone (deleted outside Nexgent) as reworked. */
  noteReverts(input: { readonly projectRoot: string }): Promise<void>
  summary(): Promise<OrganizationClassSummary[]>
  /**
   * Coordinator step two: the measured organization of a recorded turn once
   * the threads it started have all ended (the turn's own profile was taken
   * before they did); replaces that run's profile, adds the threads' cost
   * (`addUsd`) to the run's and reflects on its class. Only a run recorded
   * as `waiting` takes it.
   */
  noteProfile?(input: { readonly sessionId: string; readonly turn: number; readonly profile: OrganizationProfile; readonly addUsd?: number }): Promise<void>
}

/** What {@link CapabilityHost.attach} gets for one opened agent. */
export interface CapabilityAttachInput {
  /**
   * The agent's scoped context (tool scope of this session). Tools and
   * effects registered on it are private to the agent and released when it
   * closes.
   */
  readonly ctx: Context
  readonly sessionId: string
  /** The version this session runs on. */
  readonly version: CapabilityVersion
  /** Set for a member; members run on their root's version. */
  readonly member?: MemberIdentity
  readonly parentSessionId?: string
  /** Whether the session was resumed rather than created. */
  readonly resumed: boolean
}

/** One component loaded into a session, as the kernel counts its use. */
export interface AttachedComponent extends CapabilityComponentRef {
  /** Model tools the component added (function modules, plugins); their calls count as its use. */
  readonly tools?: readonly string[]
  /** A draft the session tried before it was resumed (its use counts as `draft`). */
  readonly draft?: true
}

/** What {@link CapabilityHost.attach} loaded. */
export interface CapabilityAttachment {
  readonly components: readonly AttachedComponent[]
}

/** One finished tool call, for {@link CapabilityHost.componentOf}. */
export interface ComponentCallInput {
  readonly sessionId: string
  readonly name: string
  readonly input: JsonValue
  readonly isError: boolean
}

/** A component a call used, and where it came from. */
export interface ComponentUseRef extends CapabilityComponentRef {
  readonly version: CapabilityVersion | 'draft'
}

/** Version check result of {@link CapabilityHost.verify}. */
export type CapabilityVerification = { readonly ok: true } | { readonly ok: false; readonly detail: string }

/** `ctx.capabilityHost`. */
export interface CapabilityHost {
  /**
   * The version a new root session runs on: the adopted chain tail (the host
   * rolls back a bundle that fails verification before answering).
   */
  current(): Promise<CapabilityVersion>
  /** Whether a recorded version can still be loaded (on resume). `baseline` is always ok. */
  verify(version: CapabilityVersion): Promise<CapabilityVerification>
  /**
   * Load `version`'s components into one agent's scope. Throwing means the
   * load failed: the kernel writes `capability.version { reason:
   * 'load-failure' }` and attaches `baseline` instead.
   */
  attach(input: CapabilityAttachInput): Promise<CapabilityAttachment>
  /**
   * Optional: the component a call used when the kernel's own rules (an
   * attached or tried component's tools, `load_skill`, a collaboration
   * tool's `preset`) do not name one, e.g. a team template or an
   * architecture.
   */
  componentOf?(call: ComponentCallInput): ComponentUseRef | undefined
  /**
   * Optional (ADR 0018 decision 4): the handbook entries a root task's user
   * turn is given, asked before `turn.start` is written. The kernel records
   * `ids` as `turn.start.handbook` and `text` as `user.message { source:
   * 'inject' }` right before the turn's user message (never in the system
   * prompt). Throwing or `undefined` gives the turn nothing.
   */
  handbookForTurn?(input: HandbookTurnInput): Promise<HandbookTurnSelection | undefined>
}

/** What {@link CapabilityHost.handbookForTurn} gets: a root session's user turn. */
export interface HandbookTurnInput {
  readonly sessionId: string
  readonly turn: number
  /** The user's text of the turn. */
  readonly text: string
}

/** What a turn is given from the handbook. */
export interface HandbookTurnSelection {
  /** Entry ids, retrieval order (at most `HANDBOOK_TOP_K`); may be empty when `text` carries only other practices. */
  readonly ids: readonly string[]
  /** The injected message. */
  readonly text: string
}

/** A root turn starts (step 4: the task's first turn; step 5: every root turn). */
export interface TaskBeginInput {
  readonly taskId: string
  readonly sessionId: string
  readonly capabilityVersion: CapabilityVersion
  /** Step 5: the root turn; the snapshot goes to `tasks/<taskId>.t<turn>.json` too. */
  readonly turn?: number
}

/** What the root task did that its checks are derived from. */
export interface TaskEndInput {
  readonly taskId: string
  readonly sessionId: string
  /** Step 5: the root turn; the checks go to `checks/<taskId>.t<turn>.json` too. */
  readonly turn?: number
  /** Project-relative files of the deliverable versions the task tree presented, first presentation first. */
  readonly deliverableFiles: readonly string[]
  /**
   * Shell commands of the task tree run in the project root that exited with
   * a code, in call order. Step 5 keeps failing ones too (user decision
   * 2026-10-13, ADR 0006 decision 10); `exitCode` absent reads as 0 (step-4
   * callers).
   */
  readonly commands: readonly { readonly command: string; readonly shell: 'bash' | 'pwsh'; readonly exitCode?: number }[]
  /**
   * Redesign 3.2: the project's `checkCommands` the host ran for this check,
   * in config order. Each becomes a `test-command` check with id
   * `check-<n>`; it passes on exit code 0. `exitCode` absent: it could not
   * run (`detail` says why).
   */
  readonly checkRuns?: readonly CheckCommandRun[]
  readonly signal?: AbortSignal
}

/** Id prefix of the checks from the project's `checkCommands` (`check-1`, …); the model's test runs are `test-<n>`. */
export const CHECK_COMMAND_ID_PREFIX = 'check-'

/** One run of a project check command (redesign 3.2). */
export interface CheckCommandRun {
  readonly command: string
  readonly shell: 'bash' | 'pwsh'
  readonly exitCode?: number
  readonly detail?: string
}

/** What {@link TaskRecorder.end} wrote. */
export interface TaskEndResult {
  readonly specs: readonly TaskCheckSpec[]
  /** One per spec, same order; written into `task.outcome.checks`. */
  readonly results: readonly TaskCheck[]
}

/** `ctx.taskRecorder`. */
export interface TaskRecorder {
  /** Write `snapshots/tasks/<taskId>.t<turn>.json` (and the tree and objects); `<taskId>.json` keeps the first. */
  begin(input: TaskBeginInput): Promise<void>
  /** Derive check specs, run them, write `snapshots/checks/<taskId>.t<turn>.json` and `<taskId>.json`. */
  end(input: TaskEndInput): Promise<TaskEndResult>
}

/**
 * Rework K4 D4: `ctx.workdirs`. A member that may write gets its own copy
 * of the project, so members running at the same time never overwrite each
 * other's files; what it changed is merged back into the project at the end
 * of each of its turns, and files both sides changed differently are
 * reported as conflicts (the project keeps its version).
 */
export interface MemberWorkdirs {
  /**
   * Make the member's copy. `undefined`: the member works in the project
   * directory itself (read-only member, or the project is too large to copy).
   * `from`: the parent's own copy (a member of a thread): the member's copy
   * is made from it and merges back into it, not into the project.
   */
  open(input: { readonly sessionId: string; readonly sandboxMode: SandboxMode; readonly from?: MemberWorkdir }): Promise<MemberWorkdir | undefined>
}

/** One member's copy of the project. */
export interface MemberWorkdir {
  /** Absolute real path of the copy; the member's tools resolve paths against it. */
  readonly root: string
  /** Bring changes that reached the project since the last sync into files the member has not changed (start of a member turn). */
  refresh(): Promise<void>
  /** Merge what the member changed into the project, then refresh (end of a member turn). */
  merge(): Promise<WorkdirMerge>
  /** Remove the copy (the member closed); conflict copies stay. */
  close(): Promise<void>
}

/**
 * `ctx.learning`, as far as the kernel uses it (ADR 0018): a root turn of a
 * task session ended (`turn.end` is written). The host queues the task for
 * background learning and returns at once; it never holds the next turn up.
 */
export interface LearningSignals {
  noteTurnEnd(input: TurnEndSignal): Promise<unknown>
}

/** A root turn of a task session ended. */
export interface TurnEndSignal {
  readonly taskId: string
  readonly sessionId: string
  readonly turn: number
  readonly reason: TurnEndReason
  /** The turn's deterministic checks, when they ran. */
  readonly checks?: readonly TaskCheck[]
  readonly at?: Date
}
