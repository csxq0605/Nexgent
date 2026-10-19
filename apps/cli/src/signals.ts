/**
 * Ctrl+C / termination handling for one run.
 *
 * - First SIGINT while a turn runs: abort the turn with cause `user`; the
 *   turn closes normally (text already streamed is kept, `turn.end
 *   cancelled`), and the run exits with {@link EXIT.CANCELLED}.
 * - Second SIGINT (the turn is already cancelling), or SIGINT with no turn
 *   running: exit at once with {@link EXIT.CANCELLED}; the session lock left
 *   behind is reclaimed by the stale-lock rule.
 * - SIGTERM / SIGHUP / SIGBREAK: abort with cause `shutdown`; a repeat
 *   exits at once with {@link EXIT.TERMINATED}.
 *
 * The decision is the pure {@link nextInterruptAction}; {@link InterruptController}
 * applies it, and {@link installSignalHandlers} binds it to a process.
 */
import type { TurnCancelCause } from '@nexgent/kernel'
import { EXIT, type ExitCode } from './exit-codes.js'

/** Where the run is. */
export type InterruptPhase = 'idle' | 'turn' | 'cancelling'

/** The signals the CLI handles. */
export type HandledSignal = 'SIGINT' | 'SIGTERM' | 'SIGHUP' | 'SIGBREAK'

/** What to do about one signal. */
export type InterruptAction =
  | { readonly kind: 'cancel-turn'; readonly cause: Extract<TurnCancelCause, 'user' | 'shutdown'> }
  | { readonly kind: 'exit'; readonly code: ExitCode }

/** The exit code a signal maps to. */
export function signalExitCode(signal: HandledSignal): ExitCode {
  return signal === 'SIGINT' ? EXIT.CANCELLED : EXIT.TERMINATED
}

/** Pure transition: given the phase and a signal, the action and the next phase. */
export function nextInterruptAction(phase: InterruptPhase, signal: HandledSignal): { action: InterruptAction; phase: InterruptPhase } {
  if (phase === 'turn') {
    return { action: { kind: 'cancel-turn', cause: signal === 'SIGINT' ? 'user' : 'shutdown' }, phase: 'cancelling' }
  }
  return { action: { kind: 'exit', code: signalExitCode(signal) }, phase }
}

/** Side effects the controller performs. */
export interface InterruptEffects {
  /** Exit the process now. */
  exit(code: ExitCode): void
  /** Tell the user what happened (one line, no newline). */
  notify(message: string): void
}

/** Applies {@link nextInterruptAction} to the turn in flight. */
export class InterruptController {
  private phase: InterruptPhase = 'idle'
  private turn: AbortController | undefined
  private cancelCause: TurnCancelCause | undefined

  constructor(private readonly effects: InterruptEffects) {}

  /** Start a turn; its signal aborts with the {@link TurnCancelCause} as `reason`. */
  beginTurn(): AbortSignal {
    this.turn = new AbortController()
    this.phase = 'turn'
    this.cancelCause = undefined
    return this.turn.signal
  }

  /** The turn closed (any reason). */
  endTurn(): void {
    this.turn = undefined
    this.phase = 'idle'
  }

  /** The cause the current / last turn was cancelled with, if any. */
  get cancelledBy(): TurnCancelCause | undefined {
    return this.cancelCause
  }

  /** Current phase (for tests). */
  get state(): InterruptPhase {
    return this.phase
  }

  /** Handle one delivered signal. */
  handle(signal: HandledSignal): InterruptAction {
    const { action, phase } = nextInterruptAction(this.phase, signal)
    this.phase = phase
    if (action.kind === 'cancel-turn') {
      this.cancelCause = action.cause
      this.effects.notify(signal === 'SIGINT'
        ? 'nexgent: cancelling the turn; press Ctrl+C again to exit now'
        : `nexgent: ${signal} received; closing the turn`)
      this.turn?.abort(action.cause)
    } else {
      this.effects.exit(action.code)
    }
    return action
  }
}

/** The subset of `process` the binding needs. */
export interface SignalSource {
  on(signal: HandledSignal, listener: () => void): unknown
  off(signal: HandledSignal, listener: () => void): unknown
  readonly platform: NodeJS.Platform
}

/**
 * Bind a controller to process signals. SIGBREAK (Ctrl+Break) only on
 * Windows; SIGHUP elsewhere.
 * @returns the function that removes the handlers.
 */
export function installSignalHandlers(source: SignalSource, controller: InterruptController): () => void {
  const signals: HandledSignal[] = ['SIGINT', 'SIGTERM', source.platform === 'win32' ? 'SIGBREAK' : 'SIGHUP']
  const listeners = signals.map(signal => [signal, () => { controller.handle(signal) }] as const)
  for (const [signal, listener] of listeners) source.on(signal, listener)
  return () => {
    for (const [signal, listener] of listeners) source.off(signal, listener)
  }
}
