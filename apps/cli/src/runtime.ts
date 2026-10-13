/**
 * THE ADAPTER SEAM between the CLI and the runtime: since step 2 the CLI goes
 * through `@nexgent/sdk`, the same in-process API the desktop app uses.
 *
 * Everything the CLI needs at run time goes through {@link CliRuntime};
 * {@link loadRuntime} wires it over one SDK instance per `open`:
 *
 * 1. `createSdk({ env, home, approvalResponder })`: the SDK boots the
 *    project's application (kernel default profile + llm, session,
 *    workspace, context, skill, tasking) with the CLI's `env` (API base URL
 *    override, `NEXGENT_HOME`) and registers the CLI's TTY approval prompt
 *    as the responder;
 * 2. `open()`: `projects.open`, the API-key facts (`settings.get`: no key →
 *    `credentials/missing`), then `createSession` (model / sandbox
 *    overrides) or `openSession` (takes the lock and closes a turn the dead
 *    process left open; the SDK reports it as a `turn.end { interrupted }`
 *    event, which `runTurn` replays first);
 * 3. `runTurn()`: `startTurn` for one user message; the SDK's raw kernel
 *    events (`onAgentEvent`) are mapped onto {@link CliEvent} (table in
 *    {@link mapAgentEvent}); the CLI's abort signal becomes
 *    `cancelTurn({ cause })` so `shutdown` keeps its cause; the session's
 *    `member.start` / `member.end` SDK events (step 3: delegates, teammates,
 *    workflow members) become {@link MemberStartEvent} / {@link MemberEndEvent}
 *    (the members' own streams are not shown);
 * 4. `recordOutcome()`: nothing to write — the SDK appends one
 *    `task.outcome` per turn (a `run` / `resume` is one turn) with the same
 *    status mapping as the CLI's tally;
 * 5. `close()`: close the session (releases the lock) and dispose the SDK.
 */
import {
  NexgentError,
  toErrorInfo,
  type AgentEvent,
  type ApprovalResponder,
  type SandboxMode,
  type TurnCancelCause,
  type WorkspaceLayout,
} from '@nexgent/kernel'
import { createSdk, type ImprovementJobView, type LocalNexgentSdk, type MemberRunView, type ProjectAgentEvent, type SdkEvent } from '@nexgent/sdk'
import { packageVersion } from './version.js'
import type { CliEvent, MemberEndEvent, MemberStartEvent, SessionOpenEvent } from './events.js'
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
  /**
   * Improvement jobs that appeared or changed status since the session opened
   * (newest first); empty when none did or the listing is unavailable. Call
   * after the turn, before `close()`.
   */
  improvementChanges?(): Promise<readonly ImprovementJobView[]>
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

/** Load the runtime. */
export async function loadRuntime(): Promise<CliRuntime> {
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

/** Map a `member.start` / `member.end` SDK event onto the CLI's member events. */
export function mapMemberEvent(event: Extract<SdkEvent, { type: 'member.start' | 'member.end' }>): MemberStartEvent | MemberEndEvent {
  const run: MemberRunView = event.run
  const who = {
    childSessionId: run.childSessionId,
    name: run.name,
    executionForm: run.executionForm,
  }
  if (event.type === 'member.start') return { type: 'member.start', ...who, ...(run.preset === undefined ? {} : { preset: run.preset }) }
  return {
    type: 'member.end',
    ...who,
    status: run.status,
    deliverables: run.deliverables.map(version => ({
      deliverableId: version.deliverableId,
      version: version.version,
      title: version.title,
      files: version.files.map(file => file.path),
    })),
    ...(run.usage === undefined ? {} : { usage: run.usage }),
    ...(run.error === undefined ? {} : { error: run.error }),
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
// open
// ---------------------------------------------------------------------------

async function openSession(options: RuntimeOpenOptions): Promise<RuntimeSession> {
  const sdk: LocalNexgentSdk = createSdk({
    appVersion: packageVersion(),
    env: options.env,
    approvalResponder: options.approvals,
  })
  try {
    const project = await sdk.call('projects.open', { root: options.layout.root })
    const { projectId } = project
    const settings = await sdk.call('settings.get', { projectId })
    if (!settings.apiKey.configured) {
      throw new NexgentError('credentials/missing', 'credential NEXGENT_API_KEY is not set (environment variable or credentials.json), nor is ANTHROPIC_API_KEY')
    }

    // A turn the previous process left open is closed while the session
    // opens; the SDK reports it as an event, replayed before the new turn.
    let interruptedTurn: number | undefined
    const resumeId = options.resumeSessionId
    const stopWatching = sdk.subscribe(event => {
      if (event.type === 'turn.end' && event.reason.kind === 'interrupted' && event.sessionId === resumeId) interruptedTurn = event.turn
    })
    let view
    try {
      view = resumeId === undefined
        ? await sdk.openSession({
          projectId,
          sessionId: (await sdk.createSession({
            projectId,
            ...(options.sandboxMode === undefined ? {} : { sandboxMode: options.sandboxMode }),
            ...(options.model === undefined ? {} : { model: options.model }),
          })).sessionId,
        })
        : await sdk.openSession({ projectId, sessionId: resumeId, ...(options.sandboxMode === undefined ? {} : { sandboxMode: options.sandboxMode }) })
    } finally {
      stopWatching()
    }
    const sessionId = view.summary.sessionId

    // Improvement jobs the run starts (or moves) are reported at the end.
    const jobsBefore = new Map<string, string>()
    const jobsSeen = new Map<string, ImprovementJobView>()
    const listJobs = async (): Promise<readonly ImprovementJobView[]> => {
      try {
        return (await sdk.call('improvements.list', { projectId })).jobs
      } catch {
        return []
      }
    }
    for (const job of await listJobs()) jobsBefore.set(job.id, job.status)
    sdk.subscribe(event => {
      if (event.type === 'improvement.job') jobsSeen.set(event.job.id, event.job)
    })

    const info: SessionOpenEvent = {
      type: 'session',
      sessionId,
      projectRoot: project.root,
      model: view.model,
      sandboxMode: view.sandboxMode,
      resumed: resumeId !== undefined,
    }
    let closing: Promise<void> | undefined
    const close = (): Promise<void> => {
      closing ??= (async () => {
        try {
          await sdk.call('sessions.close', { projectId, sessionId })
        } finally {
          await sdk.dispose()
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
        const queue = new EventQueue<ProjectAgentEvent | { type: 'member'; event: MemberStartEvent | MemberEndEvent } | { type: 'run.settled'; error?: unknown }>()
        const unsubscribeAgent = sdk.onAgentEvent(event => {
          if (event.projectId === projectId && event.sessionId === sessionId) queue.push(event)
        })
        const unsubscribeMembers = sdk.subscribe(event => {
          if (event.projectId !== projectId || event.sessionId !== sessionId) return
          if (event.type === 'member.start' || event.type === 'member.end') queue.push({ type: 'member', event: mapMemberEvent(event) })
        })
        const unsubscribe = () => {
          unsubscribeAgent()
          unsubscribeMembers()
        }
        const onAbort = () => void sdk.cancelTurn({ projectId, sessionId, cause: cancelCause(signal) })
        let turn: number | undefined
        try {
          const started = await sdk.startTurn({ projectId, sessionId, text: task })
          turn = started.turn
          started.done.then(() => queue.push({ type: 'run.settled' }), (error: unknown) => queue.push({ type: 'run.settled', error }))
          signal.addEventListener('abort', onAbort, { once: true })
          if (signal.aborted) onAbort()
          for (;;) {
            const event = await queue.next()
            if (event.type === 'run.settled') {
              // `done` settles only after `turn.end` was emitted; a rejection means no turn.end.
              if (event.error !== undefined) {
                yield { type: 'turn.end', turn, reason: { kind: 'error', error: toErrorInfo(event.error) } }
              }
              break
            }
            if (event.type === 'member') {
              yield event.event
              continue
            }
            for (const mapped of mapAgentEvent(event)) yield mapped
            if (event.type === 'turn.end' && event.turn === turn) {
              // let the SDK finish the turn's bookkeeping (task.outcome) before the caller closes
              await started.done.catch(() => undefined)
              break
            }
          }
        } finally {
          signal.removeEventListener('abort', onAbort)
          unsubscribe()
        }
      },
      async improvementChanges() {
        // Events can lag a job process's file writes; the listing is the ground truth.
        for (const job of await listJobs()) jobsSeen.set(job.id, job)
        return [...jobsSeen.values()]
          .filter(job => jobsBefore.get(job.id) !== job.status)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      },
      async recordOutcome() {
        // The SDK wrote the turn's `task.outcome` when the turn ended.
      },
      close,
    }
  } catch (error) {
    await sdk.dispose().catch(() => undefined)
    throw error
  }
}
