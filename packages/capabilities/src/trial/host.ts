/**
 * The gate inside a running app (`@nexgent/capabilities` plugin):
 *
 * - After every root turn it runs the usage-regression watch (with that
 *   turn's own outcome) and, when the session proposed candidates that were
 *   never tried and `capabilities.autoTrial` is on, starts the gate for each
 *   in a separate OS process (decision 3): the host's trial entry
 *   (`gate <projectRoot> <candidateId>`), detached so it outlives a CLI run.
 * - Before a root session resolves its version it runs the watch again, so
 *   a regression is rolled back before the next task starts.
 * - When the app starts it closes trials a killed gate left open
 *   (`recoverInterruptedTrials`).
 *
 * Without a configured entry nothing is started and candidates stay
 * `proposed` (the SDK's `capabilities.trial` can start them later).
 */
import { spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync } from 'node:fs'
import { join } from 'node:path'
import {
  NexgentError,
  readProjectConfig,
  type Agent,
  type CapabilitiesConfig,
  type Context,
  type WorkspaceLayout,
} from '@nexgent/kernel'
import { listCandidates } from '../candidates.js'
import type { CapabilityStore } from '../capability-store.js'
import { listTrials, TRIALS_DIR, wasAttempted } from './receipts.js'
import { recoverInterruptedTrials } from './recover.js'
import { buildReplaySet, listReplayCases } from './replay-set.js'
import { checkUsageRegression, type PendingOutcome } from './usage.js'

/** Plugin-row config of the gate (`@nexgent/capabilities` `trial`). */
export interface GateHostConfig {
  /** Absolute path of the host's trial entry script (the SDK's); absent: no automatic trials. */
  readonly entry?: string
  /** Extra environment for the gate process (non-secret settings such as the API base URL); the process inherits the rest. */
  readonly env?: Readonly<Record<string, string>>
}

/** What the gate reads of a root agent (structural: the agent class may come from another build of the kernel). */
export type FollowedAgent = Pick<Agent, 'sessionId' | 'subscribe' | 'turnOutcome' | 'ledgerAttribution' | 'capabilityVersion'>

/** One started gate process. */
export interface StartedGate {
  readonly candidateId: string
  readonly pid: number | undefined
  /** Settles with the exit code when the process exits. */
  readonly exited: Promise<number | null>
}

/** The gate's host side for one project. */
export class GateHost {
  readonly #ctx: Context
  readonly #layout: WorkspaceLayout
  readonly #store: CapabilityStore
  readonly #config: GateHostConfig
  readonly #started = new Map<string, StartedGate>()
  /** Candidates whose gate process has not exited yet. */
  readonly #running = new Set<string>()
  #watch: Promise<unknown> = Promise.resolve()

  constructor(ctx: Context, layout: WorkspaceLayout, store: CapabilityStore, config: GateHostConfig = {}) {
    this.#ctx = ctx
    this.#layout = layout
    this.#store = store
    this.#config = config
  }

  /** Gate processes this host started, by candidate id (the latest per candidate). */
  get started(): ReadonlyMap<string, StartedGate> {
    return this.#started
  }

  async #settings(): Promise<CapabilitiesConfig> {
    return (await readProjectConfig(this.#layout.configFile)).config.capabilities
  }

  /** Run the usage-regression watch (serialized; errors are swallowed: a watch failure never stops a task). */
  watchUsage(pending?: PendingOutcome): Promise<void> {
    const run = this.#watch.then(async () => {
      const ledger = this.#ctx.get('ledger')
      if (ledger === undefined) return
      const rule = (await this.#settings()).rollback
      await checkUsageRegression({ store: this.#store, ledger, rule, ...(pending === undefined ? {} : { pending }) })
    })
    this.#watch = run.catch(() => undefined)
    return this.#watch.then(() => undefined)
  }

  /** Follow a root agent's turns (called once the kernel registered it). */
  follow(agent: FollowedAgent): () => void {
    return agent.subscribe(event => {
      if (event.type !== 'turn.end') return
      void this.afterTurn(agent).catch(() => undefined)
    })
  }

  /** Follow the root session `sessionId` as soon as its agent is registered (the kernel attaches before it registers). */
  followWhenOpen(sessionId: string, attempts = 50): void {
    const look = (left: number) => {
      const agent = this.#ctx.get('agents')?.get(sessionId)
      if (agent !== undefined) {
        const stop = this.follow(agent)
        agent.ctx.effect(() => stop, 'capabilities.gate.follow')
      } else if (left > 0) {
        setTimeout(() => look(left - 1), 10).unref?.()
      }
    }
    setImmediate(() => look(attempts))
  }

  /** What runs after a root turn: the usage watch, then automatic trials of this session's new candidates. */
  async afterTurn(agent: FollowedAgent): Promise<void> {
    const outcome = agent.turnOutcome()
    const taskId = agent.ledgerAttribution().taskId
    if (taskId !== undefined && agent.capabilityVersion !== undefined) {
      await this.watchUsage({
        taskId,
        capabilityVersion: agent.capabilityVersion,
        ...(outcome.checks === undefined ? {} : { checks: outcome.checks }),
        ...(outcome.componentsUsed === undefined ? {} : { componentsUsed: outcome.componentsUsed }),
      })
    }
    await this.startPending(agent.sessionId)
  }

  /** Start the gate for every untried, undecided candidate a session proposed (when `autoTrial` is on). */
  async startPending(sessionId: string): Promise<StartedGate[]> {
    if (this.#config.entry === undefined || !(await this.#settings()).autoTrial) return []
    const decided = new Set((await this.#store.decisions()).flatMap(decision => (decision.candidateId === undefined ? [] : [decision.candidateId])))
    const started: StartedGate[] = []
    for (const candidate of await listCandidates(this.#store.directory)) {
      if (candidate.sessionId !== sessionId || decided.has(candidate.id) || this.#running.has(candidate.id)) continue
      if (await wasAttempted(this.#store.directory, candidate.id)) continue
      started.push(this.start(candidate.id))
    }
    return started
  }

  /**
   * Start the gate process for one candidate (no checks: the gate itself
   * refuses a candidate that was tried or decided). While an earlier process
   * for it still runs, that one is returned; once it has exited (say, it
   * found too little history and waited) a new one is started.
   * @throws `internal` when no trial entry is configured.
   */
  start(candidateId: string): StartedGate {
    const existing = this.#started.get(candidateId)
    if (existing !== undefined && this.#running.has(candidateId)) return existing
    const entry = this.#config.entry
    if (entry === undefined) throw new Error('no trial entry is configured for @nexgent/capabilities')
    const directory = join(this.#store.directory, TRIALS_DIR)
    mkdirSync(directory, { recursive: true })
    // Diagnostics of the gate process (host data; the model's file tools cannot read it).
    const log = openSync(join(directory, `${candidateId}.log`), 'a')
    let child
    try {
      child = spawn(process.execPath, [entry, 'gate', this.#layout.root, candidateId], {
        detached: true,
        stdio: ['ignore', log, log],
        // Under Electron `process.execPath` is the app binary: run it as plain Node.
        env: { ...process.env, ...this.#config.env, ...(process.versions.electron === undefined ? {} : { ELECTRON_RUN_AS_NODE: '1' }) },
        windowsHide: true,
      })
    } finally {
      closeSync(log)
    }
    const exited = new Promise<number | null>(resolve => {
      child.on('error', () => resolve(null))
      child.on('exit', code => resolve(code))
    })
    child.unref()
    const started: StartedGate = { candidateId, pid: child.pid, exited }
    this.#started.set(candidateId, started)
    this.#running.add(candidateId)
    void exited.then(() => {
      if (this.#started.get(candidateId) === started) this.#running.delete(candidateId)
    })
    return started
  }

  /**
   * Start the gate for one candidate on request (`capabilities.trial`) and
   * resolve once its trial is under way (`trial.start` written) or the
   * process has exited.
   * @throws `tool/invalid-input` when the candidate was tried or decided, or
   *   the project has too little replayable history (nothing is started);
   *   `internal` when no trial entry is configured.
   */
  async trial(candidateId: string, waitMs = 30_000): Promise<StartedGate> {
    if (this.#config.entry === undefined) throw new NexgentError('internal', 'no trial entry is configured for @nexgent/capabilities')
    const candidate = (await listCandidates(this.#store.directory)).find(item => item.id === candidateId)
    if (candidate === undefined) throw new NexgentError('tool/invalid-input', `no candidate ${candidateId}`)
    if ((await this.#store.decisions()).some(decision => decision.candidateId === candidateId)) throw new NexgentError('tool/invalid-input', `candidate ${candidateId} already has a decision`)
    if (!this.#running.has(candidateId) && await wasAttempted(this.#store.directory, candidateId)) throw new NexgentError('tool/invalid-input', `candidate ${candidateId} was tried before; a candidate is tried once`)
    const settings = await this.#settings()
    const set = buildReplaySet(await listReplayCases(this.#layout), candidate.taskId, { selection: settings.selectionCases, guard: settings.guardCases })
    if (set.status === 'waiting') throw new NexgentError('tool/invalid-input', `the gate cannot run yet: ${set.detail}`)
    const started = this.start(candidateId)
    let exited = false
    void started.exited.then(() => { exited = true })
    const deadline = Date.now() + waitMs
    while (!exited && Date.now() < deadline && (await listTrials(this.#store.directory, candidateId)).length === 0) {
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    return started
  }

  /** Wait until every gate process this host started has exited. */
  async settled(): Promise<void> {
    await Promise.all([...this.#started.values()].map(gate => gate.exited))
  }

  /** Close trials a killed gate left open. */
  async recover(): Promise<void> {
    await recoverInterruptedTrials(this.#store)
  }
}
