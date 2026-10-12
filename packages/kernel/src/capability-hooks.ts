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
 *   when a root task runs its first turn (workspace snapshot) and when the
 *   root task ends (deterministic checks).
 */
import type { Context } from '@deepseek-ai/cordis'
import type { CapabilityComponentRef, CapabilityVersion, TaskCheckSpec } from './contracts/capabilities.js'
import type { MemberIdentity } from './contracts/collaboration.js'
import type { JsonValue } from './contracts/json.js'
import type { TaskCheck } from './contracts/ledger.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** `@nexgent/capabilities` (step 4, optional): adopted versions and per-session component loading. */
    capabilityHost: CapabilityHost
    /** `@nexgent/tasking` (step 4, optional): task-start snapshots and task-end checks. */
    taskRecorder: TaskRecorder
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
}

/** Task start (first turn of a root task). */
export interface TaskBeginInput {
  readonly taskId: string
  readonly sessionId: string
  readonly capabilityVersion: CapabilityVersion
}

/** What the root task did that its checks are derived from. */
export interface TaskEndInput {
  readonly taskId: string
  readonly sessionId: string
  /** Project-relative files of the deliverable versions the task tree presented, first presentation first. */
  readonly deliverableFiles: readonly string[]
  /** Shell commands of the task tree that exited 0, in call order. */
  readonly commands: readonly { readonly command: string; readonly shell: 'bash' | 'pwsh' }[]
  readonly signal?: AbortSignal
}

/** What {@link TaskRecorder.end} wrote. */
export interface TaskEndResult {
  readonly specs: readonly TaskCheckSpec[]
  /** One per spec, same order; written into `task.outcome.checks`. */
  readonly results: readonly TaskCheck[]
}

/** `ctx.taskRecorder`. */
export interface TaskRecorder {
  /** Write `snapshots/tasks/<taskId>.json` (and the tree and objects). */
  begin(input: TaskBeginInput): Promise<void>
  /** Derive check specs, run them, write `snapshots/checks/<taskId>.json`. */
  end(input: TaskEndInput): Promise<TaskEndResult>
}
