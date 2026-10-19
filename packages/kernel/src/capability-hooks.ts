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
 * - `ctx.improve` (step 5) is provided by `@nexgent/evolve`. The kernel
 *   signals a root turn whose checks failed, and (ADR 0018, optional) every
 *   root turn that ended, so the host can learn from the task.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { CapabilityComponentRef, CapabilityVersion, TaskCheckSpec } from './contracts/capabilities.js'
import type { MemberIdentity, WorkdirMerge } from './contracts/collaboration.js'
import type { ComparisonArm, ImprovementPhase } from './contracts/improvement.js'
import type { ImproverScope, ImproverVersion } from './contracts/improver.js'
import type { JsonValue } from './contracts/json.js'
import type { TaskCheck } from './contracts/ledger.js'
import type { TurnEndReason } from './contracts/session.js'
import type { SandboxMode } from './contracts/workspace.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** `@nexgent/capabilities` (step 4, optional): adopted versions and per-session component loading. */
    capabilityHost: CapabilityHost
    /** `@nexgent/tasking` (step 4, optional): task-start snapshots and task-end checks. */
    taskRecorder: TaskRecorder
    /** `@nexgent/evolve` (step 5, optional): the improvement queue the kernel signals failed checks to. */
    improve: ImprovementSignals
    /** `@nexgent/tasking` (rework K4 D4, optional): members' own copies of the project. */
    workdirs: MemberWorkdirs
  }
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
   */
  open(input: { readonly sessionId: string; readonly sandboxMode: SandboxMode }): Promise<MemberWorkdir | undefined>
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
 * Step 5: the improvement job a session works for. `diagnose` and
 * `propose` sessions are improvement sessions (`session.start.purpose:
 * improvement`); `trial` marks an ordinary task session the gate runs for
 * the job. Every ledger record of the session carries `improvementId` and
 * `improvementPhase`.
 *
 * Step 6 (ADR 0008 decision 6): `meta-diagnose` and `meta-propose` are a
 * meta job's own improvement sessions (read-only tool sets, no
 * components). `improverVersion` is the improver the job pinned; a
 * comparison arm's job also names its `metaJobId` and `comparisonArm`
 * (both or neither, never on a meta phase). All three are stamped on every
 * ledger record next to `improvementId` / `improvementPhase` and kept in
 * the improvement session's header.
 */
export interface ImprovementRun {
  readonly jobId: string
  readonly phase: ImprovementPhase
  readonly improverVersion?: ImproverVersion
  /** ADR 0012: where `improverVersion` lives (`user` from the rework on). */
  readonly improverScope?: ImproverScope
  readonly metaJobId?: string
  readonly comparisonArm?: ComparisonArm
}

/** A root turn whose checks had a failing item (step 5: counts as one `check-failure` signal). */
export interface CheckFailureSignal {
  readonly taskId: string
  readonly sessionId: string
  readonly turn: number
  /** The turn's check results (the host counts the failing ones). */
  readonly checks: readonly TaskCheck[]
  readonly at?: Date
}

/**
 * `ctx.improve`, as far as the kernel uses it: after a root turn of a task
 * session whose checks failed, the kernel calls `noteCheckFailure` once.
 * Counting, the threshold and `autoImprove` are the host's
 * (`data-formats.md` §改进作业).
 */
export interface ImprovementSignals {
  noteCheckFailure(input: CheckFailureSignal): Promise<unknown>
  /**
   * ADR 0018 (optional): a root turn of a task session ended (`turn.end` is
   * written). The host queues the task for background learning and returns
   * at once; it never holds the next turn up.
   */
  noteTurnEnd?(input: TurnEndSignal): Promise<unknown>
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
