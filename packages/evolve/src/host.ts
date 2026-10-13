/**
 * The improvement flow inside a running app (`ctx.improve`): counting,
 * the three triggers, launching job processes, recovery, cancel, resuming
 * jobs that wait for history, and recording the first use of an adopted
 * component.
 *
 * - Feedback counts when it has a rating of 3 or less, or no rating
 *   (decision 2, `isCountedFeedback`); 4–5 stay in the session but do not
 *   count. {@link ImprovementHost.syncFeedback} reads a session's feedback
 *   and counts the new keys, so calling it again (or from another process)
 *   never double-counts.
 * - A root task turn whose checks failed counts once
 *   ({@link ImprovementHost.noteCheckFailure}; the kernel signals it).
 * - Explicit "改进": {@link ImprovementHost.run} starts at once, whatever the
 *   count and whatever `autoImprove` says, within the budget.
 *
 * Counted signals start a job only when `autoImprove` is on and a job can be
 * launched (a host entry or launcher is configured); otherwise they wait in
 * the batch. The threshold, budget, model and thinking are the project's
 * `improvement` settings. A job runs in its own detached OS process — the
 * host entry's `improve <projectRoot> <jobId>` mode, which calls
 * {@link runImprovementJob} — so it outlives a CLI run, as the step-4 gate
 * does. On start the host marks jobs whose process is gone `interrupted`
 * (they are not re-run) and frees the project's job slot.
 */
import { spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import {
  isCountedFeedback,
  NexgentError,
  readProjectConfig,
  type FeedbackEntry,
  type FeedbackListing,
  type FeedbackStore,
  type ImprovementConfig,
  type TaskCheck,
  type WorkspaceLayout,
} from '@nexgent/kernel'
import { buildReplaySet, listReplayCases, readCandidate } from '@nexgent/capabilities'
import { budgetStatus, type BudgetStatus } from './budget.js'
import { sweepAdoptedJobs } from './first-use.js'
import { jobImproverVersion, PROJECT_IMPROVERS, trialComparison, type ImproverSource } from './improver.js'
import { jobAlive, jobPaths, listJobs, readJob, transitionJob } from './jobs.js'
import { processAlive, readLockPid, tryCreateLock } from './lock.js'
import { improvementsDir } from './paths.js'
import { admitItems, ensureQueue, readQueue, reconcileQueue, retakeSlot, startExplicitJob, type AdmitResult } from './queue.js'
import { RUNNING_STATUSES, type ImprovementJob, type ImprovementQueue, type ImprovementRequest, type QueueItem } from './types.js'

/**
 * Whether a feedback entry counts toward the threshold (decision 2; the
 * contract's `isCountedFeedback`), except that an entry with neither a
 * rating nor a non-blank comment is no feedback at all. Pure.
 */
export function countsTowardImprovement(entry: Pick<FeedbackEntry, 'rating'> & Partial<Pick<FeedbackEntry, 'comment'>>): boolean {
  if (entry.rating === undefined && entry.comment !== undefined && entry.comment.trim() === '') return false
  return isCountedFeedback(entry)
}

/** The signal of a feedback listing. Pure. */
export function feedbackItem(listing: FeedbackListing): QueueItem {
  return {
    kind: 'feedback',
    feedbackId: listing.id,
    sessionId: listing.sessionId,
    deliverableId: listing.deliverableId,
    version: listing.version,
    ...(listing.rating === undefined ? {} : { rating: listing.rating }),
    at: listing.submittedAt,
  }
}

/** A root task turn's checks as the kernel reports them. */
export interface CheckFailureInput {
  readonly taskId: string
  readonly sessionId: string
  /** The turn whose checks these are (several turns of one task may each fail once). */
  readonly turn: number
  readonly checks: readonly TaskCheck[]
  readonly at?: Date
}

/** One started job process. */
export interface StartedJob {
  readonly jobId: string
  readonly pid: number | undefined
  /** Settles with the exit code when the process exits. */
  readonly exited: Promise<number | null>
}

/** Plugin-row config of the improvement flow (process wiring only; the settings live in the project config). */
export interface ImprovementHostConfig {
  /** Absolute path of the host's entry script (it handles `improve <projectRoot> <jobId>`); absent: jobs are never started. */
  readonly entry?: string
  /** Extra environment for the job process (non-secret settings); it inherits the rest. */
  readonly env?: Readonly<Record<string, string>>
  /** Start a job some other way than a process of `entry` (tests, embedding hosts). */
  readonly launch?: (layout: WorkspaceLayout, jobId: string) => StartedJob
  /** Where a waiting job's pinned improver is read (its comparison counts decide when history suffices); default the project's store. */
  readonly improvers?: ImproverSource
}

/** The improvement flow of one project. */
export class ImprovementHost {
  readonly layout: WorkspaceLayout
  readonly directory: string
  readonly #config: ImprovementHostConfig
  readonly #feedback: () => FeedbackStore | undefined
  readonly #started = new Map<string, StartedJob>()
  readonly #live = new Set<string>()

  constructor(layout: WorkspaceLayout, config: ImprovementHostConfig = {}, feedback: () => FeedbackStore | undefined = () => undefined) {
    this.layout = layout
    this.directory = improvementsDir(layout)
    this.#config = config
    this.#feedback = feedback
  }

  /** Whether this host can start a job process. */
  get canLaunch(): boolean {
    return this.#config.launch !== undefined || this.#config.entry !== undefined
  }

  /** Job processes this host started, by job id. */
  get started(): ReadonlyMap<string, StartedJob> {
    return this.#started
  }

  /** The project's `autoImprove` and `improvement` settings. */
  async settings(): Promise<{ readonly autoImprove: boolean; readonly improvement: ImprovementConfig }> {
    const { config } = await readProjectConfig(this.layout.configFile)
    return { autoImprove: config.autoImprove, improvement: config.improvement }
  }

  /** Begin counting in this project (idempotent), recover interrupted jobs, resume jobs whose history is now enough, record first uses. */
  async start(): Promise<void> {
    await ensureQueue(this.directory)
    await this.recover()
    await this.resumeWaiting().catch(() => undefined)
    await sweepAdoptedJobs(this.layout).catch(() => undefined)
  }

  /** The queue, if counting has begun. */
  queue(): Promise<ImprovementQueue | undefined> {
    return readQueue(this.directory)
  }

  /**
   * Every job, oldest first. Adopted jobs get their `firstUse` / `rolledBack`
   * recorded first (best effort), so a reader sees the first use as soon as
   * that task's `task.outcome` is in the ledger, without waiting for a turn.
   */
  async list(): Promise<ImprovementJob[]> {
    await this.sweepAdopted().catch(() => undefined)
    return listJobs(this.directory)
  }

  /**
   * One job.
   * @throws `improvement/not-found` when there is no such job.
   */
  async show(jobId: string): Promise<ImprovementJob> {
    await this.sweepAdopted().catch(() => undefined)
    return this.#read(jobId)
  }

  async #read(jobId: string): Promise<ImprovementJob> {
    try {
      return await readJob(this.directory, jobId)
    } catch (error) {
      if (error instanceof NexgentError && error.code === 'session/not-found') throw new NexgentError('improvement/not-found', `no improvement job ${jobId}`)
      throw error
    }
  }

  /** What the budget window has spent. */
  async budgetStatus(now: Date = new Date()): Promise<BudgetStatus> {
    return budgetStatus(await listJobs(this.directory), (await this.settings()).improvement.budget, now)
  }

  /** Count signals and start a job when the batch is full. */
  async admit(items: readonly QueueItem[], now: Date = new Date()): Promise<AdmitResult> {
    const settings = await this.settings()
    const autoStart = this.canLaunch && settings.autoImprove
    const result = await admitItems(this.directory, items, { autoStart, threshold: settings.improvement.feedbackThreshold, now })
    if (result.started !== undefined) this.#launch(result.started.id)
    return result
  }

  /** Count the listed feedback that counts (decision 2). */
  noteFeedback(listings: readonly FeedbackListing[], now: Date = new Date()): Promise<AdmitResult> {
    return this.admit(listings.filter(entry => countsTowardImprovement(entry)).map(feedbackItem), now)
  }

  /** Read feedback (of one session, or all) and count the new entries. */
  async syncFeedback(sessionId?: string, now: Date = new Date()): Promise<AdmitResult> {
    const store = this.#feedback()
    if (store === undefined) return { added: [], pending: (await this.queue())?.pending.length ?? 0 }
    return this.noteFeedback(await store.list(sessionId === undefined ? undefined : { sessionId }), now)
  }

  /** Count a root task turn whose checks failed (once per task and turn); passing checks count nothing. */
  async noteCheckFailure(input: CheckFailureInput): Promise<AdmitResult> {
    const failed = input.checks.filter(check => !check.passed)
    const now = input.at ?? new Date()
    if (failed.length === 0) return { added: [], pending: (await this.queue())?.pending.length ?? 0 }
    return this.admit([{
      kind: 'check-failure',
      taskId: input.taskId,
      sessionId: input.sessionId,
      turn: input.turn,
      failedChecks: failed.map(check => check.target ?? check.name),
      at: now.toISOString(),
    }], now)
  }

  /**
   * Explicit "改进": start a job now (it takes the pending batch too).
   * @throws `improvement/busy` when a job is already running in the project;
   *   `improvement/budget-exhausted` when the budget window is spent;
   *   `internal` when no entry or launcher is configured (nothing is created).
   */
  async run(request: ImprovementRequest = {}, now: Date = new Date()): Promise<ImprovementJob> {
    if (!this.canLaunch) throw new NexgentError('internal', 'no improvement entry is configured for @nexgent/evolve')
    const budget = await this.budgetStatus(now)
    if (budget.exhausted) {
      throw new NexgentError('improvement/budget-exhausted', `the improvement budget is spent (${budget.used} of ${budget.limit} tokens since ${budget.windowStart})`, { details: { used: budget.used, limit: budget.limit } })
    }
    const job = await startExplicitJob(this.directory, request, now)
    this.#launch(job.id)
    return job
  }

  /**
   * Cancel a running or waiting job: it moves to `cancelled` (the job
   * process stops before its next phase; a running phase's session is not
   * interrupted mid-request) and its process is sent SIGTERM.
   * @throws `improvement/not-found`; `tool/invalid-input` when the job already ended or awaits approval.
   */
  async cancel(jobId: string, now: Date = new Date()): Promise<ImprovementJob> {
    const job = await this.#read(jobId)
    const cancellable = [...RUNNING_STATUSES, 'waiting-history' as const]
    if (!cancellable.includes(job.status)) throw new NexgentError('tool/invalid-input', `improvement job ${jobId} is ${job.status}; only running or waiting jobs can be cancelled`)
    const written = await transitionJob(this.directory, jobId, 'cancelled', { expect: cancellable, now, detail: 'Cancelled by the user.' })
    if (written === undefined) return this.#read(jobId)
    const pid = await readLockPid(jobPaths(this.directory, jobId).lock)
    if (pid !== undefined && pid !== process.pid && processAlive(pid)) {
      try {
        process.kill(pid, 'SIGTERM')
      } catch {
        // Already gone.
      }
    }
    await reconcileQueue(this.directory, now)
    return written
  }

  /** Mark running jobs whose process is gone `interrupted` (never re-run) and free the slot. */
  async recover(now: Date = new Date()): Promise<ImprovementJob[]> {
    const marked: ImprovementJob[] = []
    for (const job of await listJobs(this.directory)) {
      if (!RUNNING_STATUSES.has(job.status) || this.#live.has(job.id) || await jobAlive(this.directory, job, now)) continue
      const written = await transitionJob(this.directory, job.id, 'interrupted', {
        expect: [...RUNNING_STATUSES],
        now,
        detail: `The job process is gone; the job stopped while ${job.status} and is not re-run. Start a new one with "改进".`,
      })
      if (written !== undefined) marked.push(written)
      await rm(jobPaths(this.directory, job.id).lock, { force: true })
    }
    await reconcileQueue(this.directory, now)
    return marked
  }

  /**
   * Resume `waiting-history` jobs whose candidate now has enough past tasks
   * for the gate (plan 4.5: wait, never lower the bar): take the slot again
   * and launch the job process, which runs only the trial.
   * @returns the jobs resumed.
   */
  async resumeWaiting(now: Date = new Date()): Promise<string[]> {
    if (!this.canLaunch) return []
    const waiting = (await listJobs(this.directory)).filter(job => job.status === 'waiting-history' && job.candidateId !== undefined)
    if (waiting.length === 0) return []
    const settings = (await readProjectConfig(this.layout.configFile)).config.capabilities
    const cases = await listReplayCases(this.layout)
    const resumed: string[] = []
    for (const job of waiting) {
      const candidate = await readCandidate(this.layout.capabilities, job.candidateId!).catch(() => undefined)
      if (candidate === undefined) continue
      const improver = await (this.#config.improvers ?? PROJECT_IMPROVERS).load(this.layout, jobImproverVersion(job)).catch(() => undefined)
      const selection = improver === undefined ? settings.selectionCases : trialComparison(settings, improver).selectionCases
      if (buildReplaySet(cases, candidate.taskId, { selection, guard: settings.guardCases }).status !== 'ready') continue
      if (!(await retakeSlot(this.directory, job.id, now))) break
      this.#launch(job.id)
      resumed.push(job.id)
      break
    }
    return resumed
  }

  /** Record first uses and rollbacks of adopted jobs (after a task ended). */
  sweepAdopted(now: Date = new Date()): Promise<ImprovementJob[]> {
    return sweepAdoptedJobs(this.layout, now)
  }

  /** Wait until every job process this host started has exited. */
  async settled(): Promise<void> {
    await Promise.all([...this.#started.values()].map(job => job.exited))
  }

  #launch(jobId: string): StartedJob {
    const started = this.#config.launch !== undefined ? this.#config.launch(this.layout, jobId) : this.#spawn(jobId)
    this.#started.set(jobId, started)
    this.#live.add(jobId)
    void started.exited.then(() => this.#live.delete(jobId))
    return started
  }

  #spawn(jobId: string): StartedJob {
    const entry = this.#config.entry
    if (entry === undefined) throw new NexgentError('internal', 'no improvement entry is configured for @nexgent/evolve')
    const paths = jobPaths(this.directory, jobId)
    mkdirSync(paths.directory, { recursive: true })
    const log = openSync(paths.log, 'a')
    let child
    try {
      child = spawn(process.execPath, [entry, 'improve', this.layout.root, jobId], {
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
      child.on('error', error => {
        // The process never ran: end the queued job now instead of leaving it for recovery.
        void transitionJob(this.directory, jobId, 'failed', { expect: ['queued', 'waiting-history'], detail: `The job process could not start: ${error.message}` })
          .catch(() => undefined)
          .then(() => reconcileQueue(this.directory))
          .catch(() => undefined)
          .finally(() => resolve(null))
      })
      child.on('exit', code => resolve(code))
    })
    child.unref()
    // Name the child in the job lock at once, so a recovery in another process sees the job as running.
    if (child.pid !== undefined) void tryCreateLock(paths.lock, child.pid).catch(() => undefined)
    return { jobId, pid: child.pid, exited }
  }
}
