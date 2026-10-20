/**
 * The close protocol (W5): quitting while a turn runs asks the user first;
 * once confirmed, every running turn is cancelled, the app waits for each
 * `turn.end` (`turns.cancel` resolves after it is written), disposes the SDK
 * (releasing session locks) and only then lets the process exit.
 *
 * Running turns are tracked from the SDK's own event stream (`turn.start` /
 * `turn.end`), so the coordinator needs no extra SDK method.
 */
import type { NexgentSdk, SdkEvent } from '@nexgent/sdk'
import type { Logger } from './logger.js'

/** A session with a turn in flight. */
export interface RunningTurn {
  readonly projectId: string
  readonly sessionId: string
  readonly turn: number
}

/** Options of {@link ShutdownCoordinator}. */
export interface ShutdownOptions {
  readonly sdk: Pick<NexgentSdk, 'call' | 'dispose'>
  /** Ask the user whether to stop `running` turns and quit; `true` to go ahead. */
  readonly confirm: (running: readonly RunningTurn[]) => Promise<boolean>
  readonly log: Logger
  /** Upper bound on waiting for cancellation and disposal before exiting anyway. Default 60 000 ms. */
  readonly timeoutMs?: number
}

/** Outcome of {@link ShutdownCoordinator.requestQuit}. */
export type QuitDecision = 'quit' | 'stay'

export class ShutdownCoordinator {
  readonly #options: ShutdownOptions
  readonly #running = new Map<string, RunningTurn>()
  #pending: Promise<QuitDecision> | undefined
  #closing: Promise<'quit'> | undefined
  #asking = false
  #done = false

  constructor(options: ShutdownOptions) {
    this.#options = options
  }

  /** Feed every SDK event through here. */
  observe(event: SdkEvent): void {
    const key = `${event.projectId}\0${event.sessionId}`
    if (event.type === 'turn.start') this.#running.set(key, { projectId: event.projectId, sessionId: event.sessionId, turn: event.turn })
    else if (event.type === 'turn.end') this.#running.delete(key)
  }

  /** Turns in flight right now. */
  get running(): readonly RunningTurn[] {
    return [...this.#running.values()]
  }

  /** Whether the user is being asked right now (the confirmation is open). */
  get asking(): boolean {
    return this.#asking
  }

  /** Whether shutdown completed and the process may exit. */
  get done(): boolean {
    return this.#done
  }

  /**
   * Run the close protocol once; concurrent calls share the same outcome.
   * @returns `'quit'` when the caller should exit now, `'stay'` when the user kept the app open.
   */
  requestQuit(): Promise<QuitDecision> {
    if (this.#done) return Promise.resolve('quit')
    this.#pending ??= this.#run().finally(() => {
      this.#pending = undefined
    })
    return this.#pending
  }

  /**
   * Shut down without asking: for a quit the user cannot answer (a termination
   * signal). It does not wait for an open confirmation; running turns are
   * cancelled and the SDK disposed as on a confirmed quit.
   */
  forceQuit(): Promise<'quit'> {
    if (this.#done) return Promise.resolve('quit')
    return this.#close(this.running)
  }

  async #run(): Promise<QuitDecision> {
    const { log } = this.#options
    const running = this.running
    if (running.length > 0) {
      this.#asking = true
      let confirmed: boolean
      try {
        confirmed = await this.#options.confirm(running)
      } finally {
        this.#asking = false
      }
      if (this.#closing !== undefined) return this.#closing
      if (!confirmed) {
        log.info(`quit cancelled by user; ${running.length} turn(s) keep running`)
        return 'stay'
      }
      log.info(`quit confirmed; cancelling ${running.length} running turn(s)`)
    }
    return this.#close(running)
  }

  /** Cancel, dispose and mark done, once. */
  #close(running: readonly RunningTurn[]): Promise<'quit'> {
    this.#closing ??= this.#shutDown(running)
    return this.#closing
  }

  async #shutDown(running: readonly RunningTurn[]): Promise<'quit'> {
    const { sdk, log } = this.#options
    const work = (async () => {
      await Promise.all(
        running.map(async ({ projectId, sessionId }) => {
          try {
            await sdk.call('turns.cancel', { projectId, sessionId })
          } catch (error) {
            log.error(`cancel on quit failed session=${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
          }
        }),
      )
      await sdk.dispose()
    })()
    const timeoutMs = this.#options.timeoutMs ?? 60_000
    let timer: NodeJS.Timeout | undefined
    const timedOut = await Promise.race([
      work.then(
        () => false,
        (error: unknown) => {
          log.error(`sdk dispose failed: ${error instanceof Error ? error.message : String(error)}`)
          return false
        },
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), timeoutMs)
      }),
    ])
    clearTimeout(timer)
    if (timedOut) log.warn(`shutdown did not finish within ${timeoutMs} ms; exiting anyway (sessions recover on next start)`)
    this.#done = true
    log.info('shutdown complete')
    return 'quit'
  }
}
