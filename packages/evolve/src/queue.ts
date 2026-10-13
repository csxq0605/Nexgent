/**
 * The trigger queue: `.nexgent/improvements/queue.json`, changed only under
 * `queue.lock` (`data-formats.md` §改进作业). It keeps the keys of every
 * signal ever counted (`signalKey`), not a number, so a repeated submission,
 * a second process (desktop and CLI on one project) or a restart never counts
 * a signal twice, and a signal is never lost between reading and writing.
 *
 * Starting a job happens inside the same locked update: when the batch
 * reaches the threshold and the project's single job slot is free, the job
 * is created `queued`, the batch moves into it, and the slot is taken.
 * Signals counted while a job holds the slot form the next batch
 * (decision 8). The counting itself is the contract's pure `countSignal`,
 * `takeBatch` and `releaseJobSlot`.
 */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  batchTrigger,
  countSignal,
  emptyImprovementQueue,
  IMPROVEMENT_FILES,
  NexgentError,
  releaseJobSlot,
  takeBatch,
} from '@nexgent/kernel'
import { validateImprovementFile } from '@nexgent/session'
import { createJob, jobAlive, readJob, transitionJob } from './jobs.js'
import { readJson, withFileLock, writeJsonAtomic } from './lock.js'
import {
  DEFAULT_THRESHOLD,
  RUNNING_STATUSES,
  type ImprovementJob,
  type ImprovementQueue,
  type ImprovementRequest,
  type QueueItem,
} from './types.js'

/** File names inside `.nexgent/improvements/`. */
export const QUEUE_FILE = IMPROVEMENT_FILES.queue
export const QUEUE_LOCK = IMPROVEMENT_FILES.queueLock

/**
 * Read the queue.
 * @returns `undefined` when counting has not started in this project.
 * @throws `session/corrupt` when the file is not a queue.
 */
export async function readQueue(improvementsDir: string): Promise<ImprovementQueue | undefined> {
  let value: unknown
  try {
    value = await readJson(join(improvementsDir, QUEUE_FILE))
  } catch (cause) {
    throw new NexgentError('session/corrupt', 'improvements/queue.json is not valid JSON', { cause })
  }
  if (value === undefined) return undefined
  if (validateImprovementFile('queue', value).length > 0) throw new NexgentError('session/corrupt', 'improvements/queue.json is malformed')
  return value as ImprovementQueue
}

/**
 * Run `change` on the queue under its lock and write the result.
 * A missing queue starts empty, with `since` = now.
 */
async function updateQueue<T>(improvementsDir: string, now: Date, change: (queue: ImprovementQueue) => Promise<{ queue: ImprovementQueue; result: T }>): Promise<T> {
  await mkdir(improvementsDir, { recursive: true })
  return withFileLock(join(improvementsDir, QUEUE_LOCK), async () => {
    const existing = await readQueue(improvementsDir)
    const current = existing ?? emptyImprovementQueue(now.toISOString())
    const { queue, result } = await change(current)
    if (existing === undefined || queue !== current) await writeJsonAtomic(join(improvementsDir, QUEUE_FILE), queue)
    return result
  })
}

/** Make sure the queue exists (its `since` marks when counting began). */
export async function ensureQueue(improvementsDir: string, now: Date = new Date()): Promise<ImprovementQueue> {
  return updateQueue(improvementsDir, now, async queue => ({ queue, result: queue }))
}

/**
 * Free the slot when its job no longer runs: finished or parked jobs just
 * let go of it; a running job whose process is gone is marked `interrupted`
 * (it is not re-run).
 */
async function reconcileSlot(improvementsDir: string, queue: ImprovementQueue, now: Date): Promise<{ queue: ImprovementQueue; active?: ImprovementJob }> {
  const id = queue.activeJobId
  if (id === undefined) return { queue }
  const job = await readJob(improvementsDir, id).catch(() => undefined)
  if (job !== undefined && await jobAlive(improvementsDir, job, now)) return { queue, active: job }
  if (job !== undefined && RUNNING_STATUSES.has(job.status)) {
    await transitionJob(improvementsDir, id, 'interrupted', { expect: [...RUNNING_STATUSES], now, detail: 'The job process is gone; the job stopped before it finished and is not re-run.' })
  }
  return { queue: releaseJobSlot(queue, id) }
}

/** Start the next batch's job in this locked update, when the batch is full and the slot free. */
async function startBatch(improvementsDir: string, queue: ImprovementQueue, threshold: number, now: Date): Promise<{ queue: ImprovementQueue; started?: ImprovementJob }> {
  const taken = takeBatch(queue, threshold)
  if (taken.batch === undefined) return { queue }
  const started = await createJob(improvementsDir, { trigger: batchTrigger(taken.batch), items: taken.batch, now })
  return { queue: { ...taken.queue, activeJobId: started.id }, started }
}

/** What {@link admitItems} decides. */
export interface AdmitOptions {
  /** Whether counted signals may start a job (`autoImprove`, and a job can actually be launched). */
  readonly autoStart: boolean
  readonly threshold?: number
  readonly now?: Date
}

/** Result of {@link admitItems}. */
export interface AdmitResult {
  /** Signals counted by this call (new keys only). */
  readonly added: readonly QueueItem[]
  /** Size of the pending batch after the call (0 when a job just took it). */
  readonly pending: number
  /** The job this call started, if any. */
  readonly started?: ImprovementJob
}

/**
 * Count signals. A key seen before (in this or another process) and a signal
 * older than the queue's `since` are ignored. When the batch reaches the
 * threshold, auto-start is allowed and the slot is free, a job is created
 * and takes the batch.
 */
export async function admitItems(improvementsDir: string, items: readonly QueueItem[], options: AdmitOptions): Promise<AdmitResult> {
  const now = options.now ?? new Date()
  const threshold = options.threshold ?? DEFAULT_THRESHOLD
  return updateQueue<AdmitResult>(improvementsDir, now, async current => {
    let queue = current
    const added: QueueItem[] = []
    for (const item of items) {
      const step = countSignal(queue, item)
      if (step.counted) added.push(item)
      queue = step.queue
    }
    if (!options.autoStart || queue.pending.length < threshold) return { queue, result: { added, pending: queue.pending.length } }
    const slot = await reconcileSlot(improvementsDir, queue, now)
    if (slot.active !== undefined) return { queue: slot.queue, result: { added, pending: slot.queue.pending.length } }
    const next = await startBatch(improvementsDir, slot.queue, threshold, now)
    return { queue: next.queue, result: { added, pending: next.queue.pending.length, ...(next.started === undefined ? {} : { started: next.started }) } }
  })
}

/**
 * Start a job on request ("改进"), whatever the count: it takes the pending
 * batch too. `autoImprove` does not apply; the budget does (checked by the
 * caller before, and by the job before each phase).
 * @throws `improvement/busy` when another job holds the slot (one job per project).
 */
export async function startExplicitJob(improvementsDir: string, request: ImprovementRequest, now: Date = new Date()): Promise<ImprovementJob> {
  return updateQueue(improvementsDir, now, async current => {
    const slot = await reconcileSlot(improvementsDir, current, now)
    if (slot.active !== undefined) throw new NexgentError('improvement/busy', `improvement job ${slot.active.id} is still running in this project; one job runs at a time`, { details: { jobId: slot.active.id } })
    const taken = takeBatch(slot.queue, 0)
    const started = await createJob(improvementsDir, { trigger: 'explicit', items: taken.batch ?? [], request, now })
    return { queue: { ...taken.queue, activeJobId: started.id }, result: started }
  })
}

/**
 * Take the slot again for a parked job (`waiting-history` resuming its
 * trial). Fails quietly when another job holds it.
 * @returns whether the slot is now held by `jobId`.
 */
export async function retakeSlot(improvementsDir: string, jobId: string, now: Date = new Date()): Promise<boolean> {
  return updateQueue(improvementsDir, now, async current => {
    const slot = await reconcileSlot(improvementsDir, current, now)
    if (slot.active !== undefined) return { queue: slot.queue, result: slot.active.id === jobId }
    return { queue: { ...slot.queue, activeJobId: jobId }, result: true }
  })
}

/**
 * Release the slot held by `jobId` (its process is done with it), then, when
 * the next batch is already full and auto-start is allowed, take the slot
 * for a new job at once.
 * @returns the job started for the next batch, if any.
 */
export async function releaseSlot(improvementsDir: string, jobId: string, options: AdmitOptions): Promise<ImprovementJob | undefined> {
  const now = options.now ?? new Date()
  const threshold = options.threshold ?? DEFAULT_THRESHOLD
  return updateQueue(improvementsDir, now, async current => {
    const queue = releaseJobSlot(current, jobId)
    if (!options.autoStart) return { queue, result: undefined }
    const next = await startBatch(improvementsDir, queue, threshold, now)
    return { queue: next.queue, result: next.started }
  })
}

/** Free a slot whose job is no longer running (startup recovery). */
export async function reconcileQueue(improvementsDir: string, now: Date = new Date()): Promise<ImprovementQueue | undefined> {
  if ((await readQueue(improvementsDir)) === undefined) return undefined
  return updateQueue(improvementsDir, now, async current => {
    const slot = await reconcileSlot(improvementsDir, current, now)
    return { queue: slot.queue, result: slot.queue }
  })
}
