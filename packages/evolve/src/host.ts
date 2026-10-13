/**
 * The improvement flow inside a running app (`ctx.improve`): counting,
 * the three triggers, launching job processes and recovery.
 *
 * - Feedback: an entry counts when it has a rating of 3 or less, or a
 *   comment and no rating (decision 2); 4–5 stay in the session but do not
 *   count. {@link ImprovementHost.syncFeedback} reads a session's feedback
 *   and counts the new ids, so calling it again (or from another process)
 *   never double-counts.
 * - Check failure: a root task whose checks failed counts once per task and
 *   turn ({@link ImprovementHost.noteCheckFailure}; the kernel signals it).
 * - Explicit "改进": {@link ImprovementHost.run} starts at once, whatever the
 *   count and whatever `autoImprove` says (the budget still applies).
 *
 * Counted items start a job only when `autoImprove` is on and a job can be
 * launched (a host entry or launcher is configured); otherwise they wait in
 * the batch. A job runs in its own detached OS process — the host entry's
 * `improve <projectRoot> <jobId>` mode, which calls
 * {@link runImprovementJob} — so it outlives a CLI run, as the step-4 gate
 * does. On start the host marks jobs whose process is gone `interrupted`
 * (they are not re-run) and frees the project's job slot.
 */
import { spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { NexgentError, readProjectConfig, type FeedbackEntry, type FeedbackListing, type FeedbackStore, type TaskCheck, type WorkspaceLayout } from '@nexgent/kernel'
import { budgetStatus, type BudgetStatus } from './budget.js'
import { jobAlive, jobPaths, listJobs, readJob, transitionJob } from './jobs.js'
import { tryCreateLock } from './lock.js'
import { improvementsDir } from './paths.js'
import { admitItems, ensureQueue, readQueue, reconcileQueue, startExplicitJob, type AdmitResult } from './queue.js'
import { DEFAULT_BUDGET, DEFAULT_THRESHOLD, RUNNING_STATUSES, type ImprovementBudget, type ImprovementJob, type ImprovementQueue, type ImprovementRequest, type QueueItem } from './types.js'

/** Whether a feedback entry counts toward the threshold (decision 2). Pure. */
export function countsTowardImprovement(entry: Pick<FeedbackEntry, 'rating' | 'comment'>): boolean {
  if (entry.rating !== undefined) return entry.rating <= 3
  return entry.comment.trim() !== ''
}

/** The counted item of a feedback listing. Pure. */
export function feedbackItem(listing: FeedbackListing): QueueItem {
  return {
    id: listing.id,
    source: 'feedback',
    sessionId: listing.sessionId,
    at: listing.submittedAt,
    deliverableId: listing.deliverableId,
    version: listing.version,
    turn: listing.turn,
    ...(listing.rating === undefined ? {} : { rating: listing.rating }),
  }
}

/** A root task's checks as the kernel reports them. */
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

/** Plugin-row config of the improvement flow. */
export interface ImprovementHostConfig {
  /** Absolute path of the host's entry script (it handles `improve <projectRoot> <jobId>`); absent: jobs are never started automatically. */
  readonly entry?: string
  /** Extra environment for the job process (non-secret settings); it inherits the rest. */
  readonly env?: Readonly<Record<string, string>>
  /** Counted items that start a job (default 3). */
  readonly threshold?: number
  /** Improvement budget until the project config carries one (default {@link DEFAULT_BUDGET}). */
  readonly budget?: ImprovementBudget
  /** Start a job some other way than a process of `entry` (tests, embedding hosts). */
  readonly launch?: (layout: WorkspaceLayout, jobId: string) => StartedJob
}

/** The improvement flow of one project. */
export class ImprovementHost {
  readonly layout: WorkspaceLayout
  readonly directory: string
  readonly #config: ImprovementHostConfig
  readonly #feedback: () => FeedbackStore | undefined
  readonly #started = new Map<string, StartedJob>()

  constructor(layout: WorkspaceLayout, config: ImprovementHostConfig = {}, feedback: () => FeedbackStore | undefined = () => undefined) {
    this.layout = layout
    this.directory = improvementsDir(layout)
    this.#config = config
    this.#feedback = feedback
  }

  /** Counted items that start a job. */
  get threshold(): number {
    return this.#config.threshold ?? DEFAULT_THRESHOLD
  }

  /** The budget in force. */
  get budget(): ImprovementBudget {
    return this.#config.budget ?? DEFAULT_BUDGET
  }

  /** Whether this host can start a job process. */
  get canLaunch(): boolean {
    return this.#config.launch !== undefined || this.#config.entry !== undefined
  }

  /** Job processes this host started, by job id. */
  get started(): ReadonlyMap<string, StartedJob> {
    return this.#started
  }

  /** The project's `autoImprove` setting (a missing or unreadable config means the default). */
  async autoImprove(): Promise<boolean> {
    return (await readProjectConfig(this.layout.configFile)).config.autoImprove
  }

  /** Begin counting in this project (idempotent) and recover interrupted jobs. */
  async start(): Promise<void> {
    await ensureQueue(this.directory)
    await this.recover()
  }

  /** The counter, if counting has begun. */
  queue(): Promise<ImprovementQueue | undefined> {
    return readQueue(this.directory)
  }

  /** Every job, oldest first. */
  list(): Promise<ImprovementJob[]> {
    return listJobs(this.directory)
  }

  /**
   * One job.
   * @throws `session/not-found` when there is no such job.
   */
  show(jobId: string): Promise<ImprovementJob> {
    return readJob(this.directory, jobId)
  }

  /** What the budget window has spent. */
  async budgetStatus(now: Date = new Date()): Promise<BudgetStatus> {
    return budgetStatus(await this.list(), this.budget, now)
  }

  /** Count items and start a job when the batch is full. */
  async admit(items: readonly QueueItem[], now: Date = new Date()): Promise<AdmitResult> {
    const autoStart = this.canLaunch && await this.autoImprove()
    const result = await admitItems(this.directory, items, { autoStart, threshold: this.threshold, now })
    if (result.started !== undefined) this.#launch(result.started.id)
    return result
  }

  /** Count the listed feedback that counts (decision 2). */
  noteFeedback(listings: readonly FeedbackListing[], now: Date = new Date()): Promise<AdmitResult> {
    return this.admit(listings.filter(countsTowardImprovement).map(feedbackItem), now)
  }

  /** Read feedback (of one session, or all) and count the new entries. */
  async syncFeedback(sessionId?: string, now: Date = new Date()): Promise<AdmitResult> {
    const store = this.#feedback()
    if (store === undefined) return { added: [], pending: (await this.queue())?.pending.length ?? 0 }
    return this.noteFeedback(await store.list(sessionId === undefined ? undefined : { sessionId }), now)
  }

  /** Count a root task whose checks failed (once per task and turn); passing checks count nothing. */
  async noteCheckFailure(input: CheckFailureInput): Promise<AdmitResult> {
    const failed = input.checks.filter(check => !check.passed)
    const now = input.at ?? new Date()
    if (failed.length === 0) return { added: [], pending: (await this.queue())?.pending.length ?? 0 }
    return this.admit([{
      id: `check:${input.taskId}:${input.turn}`,
      source: 'check-failure',
      sessionId: input.sessionId,
      at: now.toISOString(),
      taskId: input.taskId,
      turn: input.turn,
      failedChecks: failed.map(check => check.target ?? check.name),
    }], now)
  }

  /**
   * Explicit "改进": start a job now (it takes the pending batch too).
   * @throws `tool/invalid-input` when a job is already running in the project;
   *   `internal` when no entry or launcher is configured (nothing is created).
   */
  async run(request: ImprovementRequest = {}, now: Date = new Date()): Promise<ImprovementJob> {
    if (!this.canLaunch) throw new NexgentError('internal', 'no improvement entry is configured for @nexgent/evolve')
    const job = await startExplicitJob(this.directory, request, now)
    this.#launch(job.id)
    return job
  }

  /** Mark running jobs whose process is gone `interrupted` (never re-run) and free the slot. */
  async recover(now: Date = new Date()): Promise<ImprovementJob[]> {
    const marked: ImprovementJob[] = []
    for (const job of await this.list()) {
      if (!RUNNING_STATUSES.has(job.status) || this.#running(job.id) || await jobAlive(this.directory, job, now)) continue
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

  /** Wait until every job process this host started has exited. */
  async settled(): Promise<void> {
    await Promise.all([...this.#started.values()].map(job => job.exited))
  }

  #running(jobId: string): boolean {
    return this.#started.has(jobId) && this.#live.has(jobId)
  }

  readonly #live = new Set<string>()

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
        void transitionJob(this.directory, jobId, 'failed', { expect: ['queued'], detail: `The job process could not start: ${error.message}` })
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
