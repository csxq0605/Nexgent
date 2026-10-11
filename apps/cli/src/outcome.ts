/**
 * The task tally: folds the {@link CliEvent} stream of one `run` / `resume`
 * into the `task.outcome` ledger record the CLI writes at the end
 * (`data-formats.md` §账本记录), and maps the outcome to an exit code.
 */
import {
  addUsage,
  UNKNOWN_USAGE,
  type ErrorInfo,
  type LedgerRecordInput,
  type LLMUsage,
  type TaskOutcomeStatus,
  type TurnEndReason,
} from '@nexgent/kernel'
import type { CliEvent } from './events.js'
import { EXIT, type ExitCode } from './exit-codes.js'

/** The `task.outcome` record as the CLI hands it to the ledger (`ts` is stamped there). */
export type TaskOutcomeInput = Extract<LedgerRecordInput, { type: 'task.outcome' }>

/** Map a turn-end reason to the task status. */
export function taskStatus(reason: TurnEndReason): TaskOutcomeStatus {
  switch (reason.kind) {
    case 'completed':
      return 'completed'
    case 'cancelled':
      return 'cancelled'
    default:
      return 'failed'
  }
}

/** Map how the last turn ended to the process exit code (see {@link EXIT}). */
export function exitCodeFor(reason: TurnEndReason | undefined): ExitCode {
  if (reason === undefined) return EXIT.TASK_FAILED
  switch (reason.kind) {
    case 'completed':
      return EXIT.OK
    case 'cancelled':
      if (reason.cause === 'user') return EXIT.CANCELLED
      if (reason.cause === 'shutdown') return EXIT.TERMINATED
      return EXIT.TASK_FAILED
    default:
      return EXIT.TASK_FAILED
  }
}

/** Accumulates one task's events. Feed every event with {@link TaskTally.observe}. */
export class TaskTally {
  private sessionId: string | undefined
  private readonly stepUsage: LLMUsage[] = []
  private toolCalls = 0
  private readonly tools = new Set<string>()
  private readonly turns = new Set<number>()
  private lastReason: TurnEndReason | undefined
  private lastError: ErrorInfo | undefined
  /** Assistant text of the last turn, for `--json` `final` and summaries. */
  private text = ''

  /** Fold one event. */
  observe(event: CliEvent): void {
    switch (event.type) {
      case 'session':
        this.sessionId = event.sessionId
        return
      case 'turn.start':
        this.turns.add(event.turn)
        this.text = ''
        return
      case 'step.start':
        // A step that never reports usage stays all-unknown, never 0.
        this.stepUsage.push(UNKNOWN_USAGE)
        return
      case 'usage':
        if (this.stepUsage.length === 0) this.stepUsage.push(event.usage)
        else this.stepUsage[this.stepUsage.length - 1] = event.usage
        return
      case 'text.delta':
        this.text += event.text
        return
      case 'tool.end':
        this.toolCalls += 1
        this.tools.add(event.name)
        return
      case 'turn.end':
        this.lastReason = event.reason
        if (event.reason.kind === 'error') this.lastError = event.reason.error
        return
      case 'run.error':
        if (event.fatal) this.lastError = event.error
        return
      default:
        return
    }
  }

  /** Model requests seen (one per step, failed ones included). */
  get requestCount(): number {
    return this.stepUsage.length
  }

  /** Usage summed with `addUsage` semantics (`'unknown'` absorbs). */
  get totalUsage(): LLMUsage {
    return addUsage(...this.stepUsage)
  }

  /** The reason the last turn ended, if one ended. */
  get reason(): TurnEndReason | undefined {
    return this.lastReason
  }

  /** Assistant text streamed in the last turn. */
  get finalText(): string {
    return this.text
  }

  /** The exit code for the run so far. */
  get exitCode(): ExitCode {
    return exitCodeFor(this.lastReason)
  }

  /**
   * Build the `task.outcome` record.
   * @throws `Error` when no `session` event was observed.
   */
  outcome(): TaskOutcomeInput {
    if (this.sessionId === undefined) throw new Error('task tally saw no session event')
    const status: TaskOutcomeStatus = this.lastReason === undefined ? 'failed' : taskStatus(this.lastReason)
    return {
      type: 'task.outcome',
      sessionId: this.sessionId,
      status,
      ...(status !== 'completed' && this.lastError !== undefined ? { error: this.lastError } : {}),
      totalUsage: this.totalUsage,
      requestCount: this.requestCount,
      toolCallCount: this.toolCalls,
      turns: this.turns.size,
      toolsUsed: [...this.tools].sort(),
    }
  }
}
