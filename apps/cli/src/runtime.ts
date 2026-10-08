/**
 * THE ADAPTER SEAM between the CLI and the runtime packages.
 *
 * Everything the CLI needs from kernel / llm / session / workspace goes
 * through {@link CliRuntime}. This phase ships the interface only:
 * {@link loadRuntime} returns `undefined`, and `nexgent run` / `resume` exit
 * with {@link EXIT.USAGE} and {@link RUNTIME_NOT_WIRED_MESSAGE}.
 *
 * WIRE(step-1, week 4) — the integrator implements `loadRuntime()` here:
 * 1. `createApp()` from the YAML profile (kernel), with `@nexgent/llm`
 *    (endpoint from config, overridable by `NEXGENT_API_BASE_URL`),
 *    `@nexgent/session`, `@nexgent/workspace` loaded;
 * 2. `open()`: `ctx.workspace.ensureLayout()` (replaces `layout.ts`),
 *    `ctx.credentials.describe(NEXGENT_API_KEY)` (replaces `credentials.ts`),
 *    `ctx.approvals.setResponder(options.approvals)`, then create a session
 *    (new uuid v4) or `resume(resumeSessionId)` + `lock`;
 * 3. `runTurn()`: drive `ctx.agents` for one user message and map the loop's
 *    events onto {@link CliEvent} (see `events.ts` for the ordering rules);
 * 4. `recordOutcome()`: `ctx.ledger.append(outcome)`;
 * 5. `close()`: release the session lock, dispose the app.
 */
import type { ApprovalResponder, SandboxMode, WorkspaceLayout } from '@nexgent/kernel'
import type { CliEvent, SessionOpenEvent } from './events.js'
import type { TaskOutcomeInput } from './outcome.js'

/** What the CLI hands the runtime when opening a session. */
export interface RuntimeOpenOptions {
  /** The project's resolved layout (already created by the CLI). */
  readonly layout: WorkspaceLayout
  /** Present for `nexgent resume`: the session to reopen and lock. */
  readonly resumeSessionId?: string
  /** `--model`; absent means `config.json`, then the default. Only for new sessions. */
  readonly model?: string
  /**
   * `--sandbox`; absent means: new session → `config.json`, then
   * `workspace-write`; resume → the mode in the session header.
   */
  readonly sandboxMode?: SandboxMode
  /** The host's approval responder, to register with `ctx.approvals`. */
  readonly approvals: ApprovalResponder
  /** Process environment (API base URL override, `NEXGENT_HOME`). */
  readonly env: Readonly<Record<string, string | undefined>>
}

/** One open, locked session. */
export interface RuntimeSession {
  /** Facts for the opening `session` event (`resumed` mirrors `resumeSessionId`). */
  readonly info: SessionOpenEvent
  /**
   * Run one user turn. Contract:
   * - on resume, a `turn.end { kind: 'interrupted' }` for a turn the previous
   *   process left open may come first;
   * - then `turn.start`, `step.start` before each model request, forwarded
   *   LLM events, `tool.start` / `tool.end` per tool call, approvals;
   * - exactly one `turn.end` for the new turn, last;
   * - `signal` aborting (its `reason` is a `TurnCancelCause`: `user` or
   *   `shutdown`) ends the turn with `turn.end { kind: 'cancelled', cause }`
   *   promptly; text already streamed stays recorded;
   * - request-level failures end the turn with `{ kind: 'error' }`; the
   *   iterator only throws for programmer errors.
   */
  runTurn(task: string, signal: AbortSignal): AsyncIterable<CliEvent>
  /** Append the `task.outcome` ledger record. */
  recordOutcome(outcome: TaskOutcomeInput): Promise<void>
  /** Release the lock and dispose the application. Idempotent. */
  close(): Promise<void>
}

/** The wired runtime. */
export interface CliRuntime {
  /**
   * Open (create or resume) a session. Rejects with a `NexgentError`:
   * `session/not-found`, `session/locked`, `config/invalid`,
   * `credentials/missing`, `workspace/not-found`.
   */
  open(options: RuntimeOpenOptions): Promise<RuntimeSession>
}

/** `--json` error code while the runtime is not wired; `scripts/accept-step1.mjs` keys on it. */
export const RUNTIME_NOT_WIRED_CODE = 'cli/runtime-not-wired'

/** Printed (exit 2) while {@link loadRuntime} returns `undefined`. */
export const RUNTIME_NOT_WIRED_MESSAGE = 'runtime not wired yet: this build has the CLI skeleton only (step 1 integration pending)'

/** Load the runtime, or `undefined` while it is not wired. WIRE(step-1, week 4). */
export async function loadRuntime(): Promise<CliRuntime | undefined> {
  return undefined
}
