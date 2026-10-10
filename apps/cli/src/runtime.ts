/**
 * THE ADAPTER SEAM between the CLI and the runtime packages.
 *
 * Everything the CLI needs from kernel / llm / session / workspace goes
 * through {@link CliRuntime}; nothing else in the CLI imports those
 * packages' runtime code. {@link loadRuntime} wires it:
 *
 * 1. `createApp()` on the kernel's default profile with `@nexgent/llm`
 *    (endpoint from the profile, overridable by `NEXGENT_API_BASE_URL` in the
 *    CLI's `env`), `@nexgent/session` and `@nexgent/workspace` registered;
 *    patches point the workspace row at the project root and the credentials
 *    row at `NEXGENT_HOME`;
 * 2. `open()`: `ctx.credentials.describe(NEXGENT_API_KEY)` (with the llm
 *    route's `ANTHROPIC_API_KEY` fallback), `ctx.approvals.setResponder`,
 *    the project grant writer (`appendProjectGrant` on `config.json`), then
 *    `agents.create` (new uuid v4) or `agents.resume` (which takes the lock
 *    and closes a turn the dead process left open);
 * 3. `runTurn()`: `agent.run()` for one user message, `AgentEvent` mapped
 *    onto {@link CliEvent} (table in {@link mapAgentEvent}); the CLI's abort
 *    signal becomes `agent.cancel(reason)` so `shutdown` keeps its cause;
 * 4. `recordOutcome()`: the kernel's `agent.close()` writes the one
 *    `task.outcome` per run; the CLI passes its status through
 *    `close({ status })` instead of appending a second record;
 * 5. `close()`: close the agent (releases the lock) and dispose the app.
 */
import { randomUUID } from 'node:crypto'
import {
  appendProjectGrant,
  createApp,
  KERNEL_PLUGIN_NAMES,
  LocalCredentials,
  NEXGENT_API_KEY,
  NexgentError,
  nexgentHome,
  toErrorInfo,
  type AgentEvent,
  type ApprovalResponder,
  type Context,
  type NexgentApp,
  type SandboxMode,
  type TurnCancelCause,
  type WorkspaceLayout,
} from '@nexgent/kernel'
import { ANTHROPIC_API_KEY, AnthropicProvider, LLMPlugin, providerOptionsFromConfig, type LLMPluginConfig } from '@nexgent/llm'
import { SessionPlugin } from '@nexgent/session'
import { WorkspacePlugin } from '@nexgent/workspace'
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

/** `--json` error code of a build whose runtime is not wired; `scripts/accept-step1.mjs` keys on it. */
export const RUNTIME_NOT_WIRED_CODE = 'cli/runtime-not-wired'

/** Printed (exit 2) when {@link loadRuntime} returns `undefined`. */
export const RUNTIME_NOT_WIRED_MESSAGE = 'runtime not wired yet: this build has the CLI skeleton only (step 1 integration pending)'

/** Load the runtime, or `undefined` while it is not wired. */
export async function loadRuntime(): Promise<CliRuntime | undefined> {
  return { open: openSession }
}

// ---------------------------------------------------------------------------
// event mapping
// ---------------------------------------------------------------------------

/**
 * Map one kernel `AgentEvent` onto the CLI events it corresponds to.
 *
 * | `AgentEvent` | `CliEvent` |
 * | --- | --- |
 * | `turn.start` | `turn.start` |
 * | `request.start` | `step.start` (one per model request) |
 * | `text.delta` / `reasoning.delta` / `tool-call.start` | forwarded verbatim |
 * | `assistant.message` | `tool-call.end` per completed call, then `usage` (the loop reports usage per step, never a bare `usage` event) |
 * | `tool.start` | `tool.start { callId, name, arguments }` |
 * | `tool.result` | `tool.end` |
 * | `approval.request` / `approval.decision` | forwarded |
 * | `error` | `run.error` (budget exhausted, ledger write failure, ...) |
 * | `turn.end` | `turn.end` |
 * | `record` / `closed` | dropped |
 */
export function mapAgentEvent(event: AgentEvent): CliEvent[] {
  switch (event.type) {
    case 'turn.start':
      return [{ type: 'turn.start', turn: event.turn }]
    case 'request.start':
      return [{ type: 'step.start', turn: event.turn, step: event.step, requestId: event.requestId }]
    case 'text.delta':
      return [{ type: 'text.delta', text: event.text }]
    case 'reasoning.delta':
      return [{ type: 'reasoning.delta', text: event.text }]
    case 'tool-call.start':
      return [{ type: 'tool-call.start', index: event.index, id: event.id, name: event.name }]
    case 'assistant.message':
      return [
        ...(event.toolCalls ?? []).map((call, index): CliEvent => ({ type: 'tool-call.end', index, call })),
        { type: 'usage', usage: event.usage },
      ]
    case 'tool.start':
      return [{ type: 'tool.start', callId: event.call.id, name: event.call.name, arguments: event.call.arguments }]
    case 'tool.result':
      return [{
        type: 'tool.end',
        callId: event.result.toolCallId,
        name: event.result.name,
        isError: event.result.isError,
        content: event.result.content,
        durationMs: event.durationMs,
      }]
    case 'approval.request':
      return [{ type: 'approval.request', request: event.request }]
    case 'approval.decision':
      return [{ type: 'approval.decision', decision: event.decision }]
    case 'error':
      return [{ type: 'run.error', error: event.error, fatal: event.fatal }]
    case 'turn.end':
      return [{ type: 'turn.end', turn: event.turn, reason: event.reason }]
    case 'record':
    case 'closed':
      return []
  }
}

/** The cancel cause carried by the CLI's abort signal; anything else counts as `user`. */
function cancelCause(signal: AbortSignal): Extract<TurnCancelCause, 'user' | 'shutdown'> {
  return signal.reason === 'shutdown' ? 'shutdown' : 'user'
}

/** An unbounded async queue fed by a synchronous listener. */
class EventQueue<T> {
  private readonly items: T[] = []
  private wake: (() => void) | undefined

  push(item: T): void {
    this.items.push(item)
    this.wake?.()
  }

  async next(): Promise<T> {
    while (this.items.length === 0) await new Promise<void>(resolve => { this.wake = resolve })
    this.wake = undefined
    return this.items.shift() as T
  }
}

// ---------------------------------------------------------------------------
// boot and open
// ---------------------------------------------------------------------------

/** Boot the app for one project: default profile, host plugins, root and home patches. */
async function bootApp(options: RuntimeOpenOptions): Promise<NexgentApp> {
  const env = options.env
  // The llm plugin reads `NEXGENT_API_BASE_URL` / `ANTHROPIC_API_KEY` from `process.env` by
  // default; the CLI hands it its own `env` so tests and the acceptance script stay hermetic.
  const llm = {
    ...LLMPlugin,
    apply(ctx: Context, config: LLMPluginConfig = {}): void {
      ctx.provide('llm', new AnthropicProvider({
        credentials: ctx.credentials,
        ledger: ctx.ledger,
        ...providerOptionsFromConfig(config),
        env,
      }))
    },
  }
  // Likewise the kernel's credentials service reads `process.env`; the CLI's `env`
  // (and its `NEXGENT_HOME`) is handed to the same `LocalCredentials` implementation.
  const credentials = {
    name: KERNEL_PLUGIN_NAMES.credentials,
    provide: 'credentials',
    apply(ctx: Context): void {
      ctx.provide('credentials', new LocalCredentials({ env: env as NodeJS.ProcessEnv, home: nexgentHome(env as NodeJS.ProcessEnv) }))
    },
  }
  return createApp({
    patches: [{ id: 'workspace', config: { root: options.layout.root } }],
    registry: {
      [KERNEL_PLUGIN_NAMES.credentials]: credentials,
      '@nexgent/llm': llm,
      '@nexgent/session': SessionPlugin,
      '@nexgent/workspace': WorkspacePlugin,
    },
  })
}

async function openSession(options: RuntimeOpenOptions): Promise<RuntimeSession> {
  const app = await bootApp(options)
  try {
    const { ctx } = app
    const key = await ctx.credentials.describe(NEXGENT_API_KEY)
    const fallback = options.env[ANTHROPIC_API_KEY]
    if (!key.configured && (fallback === undefined || fallback.trim() === '')) {
      throw new NexgentError('credentials/missing', `credential ${NEXGENT_API_KEY} is not set (environment variable or credentials.json), nor is ${ANTHROPIC_API_KEY}`)
    }
    ctx.approvals.setResponder(options.approvals)
    app.agents.setProjectGrantWriter(grant => appendProjectGrant(ctx.workspace.layout.configFile, grant))

    // A turn the previous process left open is closed by `agents.resume`
    // before the agent exists, so look first to report it as an event.
    let interruptedTurn: number | undefined
    const resumeId = options.resumeSessionId
    if (resumeId !== undefined) {
      const before = await ctx.session.resume(resumeId)
      interruptedTurn = before.metadata.openTurn
    }
    const sandbox = options.sandboxMode === undefined ? {} : { sandboxMode: options.sandboxMode }
    const agent = resumeId === undefined
      ? await app.agents.create({ sessionId: randomUUID(), ...sandbox, ...(options.model === undefined ? {} : { model: options.model }) })
      : await app.agents.resume(resumeId, sandbox)

    const info: SessionOpenEvent = {
      type: 'session',
      sessionId: agent.sessionId,
      projectRoot: ctx.workspace.root,
      model: agent.model,
      sandboxMode: agent.sandboxMode,
      resumed: resumeId !== undefined,
    }
    let closing: Promise<void> | undefined
    const close = (status?: TaskOutcomeInput['status']): Promise<void> => {
      closing ??= (async () => {
        try {
          await agent.close(status === undefined ? {} : { status })
        } finally {
          await app.dispose()
        }
      })()
      return closing
    }

    return {
      info,
      async *runTurn(task, signal) {
        if (interruptedTurn !== undefined) {
          yield { type: 'turn.end', turn: interruptedTurn, reason: { kind: 'interrupted' } }
          interruptedTurn = undefined
        }
        const queue = new EventQueue<AgentEvent | { type: 'run.settled'; error?: unknown }>()
        const unsubscribe = agent.subscribe(event => queue.push(event))
        const onAbort = () => agent.cancel(cancelCause(signal))
        signal.addEventListener('abort', onAbort, { once: true })
        try {
          if (signal.aborted) onAbort()
          const run = agent.run(task).then(() => queue.push({ type: 'run.settled' }), (error: unknown) => queue.push({ type: 'run.settled', error }))
          let turn: number | undefined
          for (;;) {
            const event = await queue.next()
            if (event.type === 'run.settled') {
              // `run` resolves only after `turn.end` was emitted; a rejection means no turn.end.
              if (event.error !== undefined) {
                yield { type: 'turn.end', turn: turn ?? agent.turn, reason: { kind: 'error', error: toErrorInfo(event.error) } }
              }
              break
            }
            if (event.type === 'turn.start') turn = event.turn
            for (const mapped of mapAgentEvent(event)) yield mapped
            if (event.type === 'turn.end') {
              await run
              break
            }
          }
        } finally {
          signal.removeEventListener('abort', onAbort)
          unsubscribe()
        }
      },
      async recordOutcome(outcome) {
        // The kernel writes the record on close with its own tallies (they
        // match the CLI's); only the CLI's status is passed through.
        await close(outcome.status)
      },
      close: () => close(),
    }
  } catch (error) {
    await app.dispose().catch(() => undefined)
    throw error
  }
}
