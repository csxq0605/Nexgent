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

  async #run(): Promise<QuitDecision> {
    const { sdk, log } = this.#options
    const running = this.running
    if (running.length > 0) {
      const confirmed = await this.#options.confirm(running)
      if (!confirmed) {
        log.info(`quit cancelled by user; ${running.length} turn(s) keep running`)
        return 'stay'
      }
      log.info(`quit confirmed; cancelling ${running.length} running turn(s)`)
    }
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
