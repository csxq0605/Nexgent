/**
 * The counter: `.nexgent/improvements/queue.json`, changed only under
 * `queue.lock`. It keeps the ids of every item ever counted, not a number,
 * so a repeated submission, a second process (desktop and CLI on one
 * project) or a restart never counts an item twice, and an item is never
 * lost between reading and writing.
 *
 * Starting a job happens inside the same locked update: when the batch
 * reaches the threshold and the project's single job slot is free, the
 * job is created `queued`, the batch moves into it, and the slot is taken.
 * Items counted while a job holds the slot form the next batch
 * (decision 8).
 */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { NexgentError } from '@nexgent/kernel'
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
export const QUEUE_FILE = 'queue.json'
export const QUEUE_LOCK = 'queue.lock'

function isQueue(value: unknown): value is ImprovementQueue {
  const queue = value as Partial<ImprovementQueue> | undefined
  return typeof queue === 'object' && queue !== null && queue.formatVersion === 1 && typeof queue.since === 'string'
    && Array.isArray(queue.counted) && Array.isArray(queue.pending)
}

/**
 * Read the counter.
 * @returns `undefined` when counting has not started in this project.
 * @throws `session/corrupt` when the file is not a counter.
 */
export async function readQueue(improvementsDir: string): Promise<ImprovementQueue | undefined> {
  let value: unknown
  try {
    value = await readJson(join(improvementsDir, QUEUE_FILE))
  } catch (cause) {
    throw new NexgentError('session/corrupt', 'improvements/queue.json is not valid JSON', { cause })
  }
  if (value === undefined) return undefined
  if (!isQueue(value)) throw new NexgentError('session/corrupt', 'improvements/queue.json is malformed')
  return value
}

function emptyQueue(now: Date): ImprovementQueue {
  return { formatVersion: 1, since: now.toISOString(), counted: [], pending: [] }
}

/**
 * Run `change` on the counter under its lock and write the result.
 * A missing counter starts empty, with `since` = now.
 */
async function updateQueue<T>(improvementsDir: string, now: Date, change: (queue: ImprovementQueue) => Promise<{ queue: ImprovementQueue; result: T }>): Promise<T> {
  await mkdir(improvementsDir, { recursive: true })
  return withFileLock(join(improvementsDir, QUEUE_LOCK), async () => {
    const existing = await readQueue(improvementsDir)
    const current = existing ?? emptyQueue(now)
    const { queue, result } = await change(current)
    if (existing === undefined || queue !== current) await writeJsonAtomic(join(improvementsDir, QUEUE_FILE), queue)
    return result
  })
}

/** Make sure the counter exists (its `since` marks when counting began). */
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
  const { activeJobId: _released, ...rest } = queue
  return { queue: rest }
}

/** What {@link admitItems} decides. */
export interface AdmitOptions {
  /** Whether counted items may start a job (`autoImprove`, and a job can actually be launched). */
  readonly autoStart: boolean
  readonly threshold?: number
  readonly now?: Date
}

/** Result of {@link admitItems}. */
export interface AdmitResult {
  /** Items counted by this call (new ids only). */
  readonly added: readonly QueueItem[]
  /** Size of the pending batch after the call (0 when a job just took it). */
  readonly pending: number
  /** The job this call started, if any. */
  readonly started?: ImprovementJob
}

/**
 * Count items. An id seen before (in this or another process) is ignored;
 * items older than the counter's `since` are ignored. When the batch
 * reaches the threshold, auto-start is allowed and the slot is free, a
 * job is created and takes the batch.
 */
export async function admitItems(improvementsDir: string, items: readonly QueueItem[], options: AdmitOptions): Promise<AdmitResult> {
  const now = options.now ?? new Date()
  const threshold = options.threshold ?? DEFAULT_THRESHOLD
  return updateQueue<AdmitResult>(improvementsDir, now, async current => {
    const counted = new Set(current.counted)
    const added: QueueItem[] = []
    for (const item of items) {
      if (counted.has(item.id) || item.at < current.since) continue
      counted.add(item.id)
      added.push(item)
    }
    let queue: ImprovementQueue = added.length === 0 ? current : { ...current, counted: [...current.counted, ...added.map(item => item.id)], pending: [...current.pending, ...added] }
    if (!options.autoStart || queue.pending.length < threshold) return { queue, result: { added, pending: queue.pending.length } }
    const slot = await reconcileSlot(improvementsDir, queue, now)
    queue = slot.queue
    if (slot.active !== undefined) return { queue, result: { added, pending: queue.pending.length } }
    const batch = queue.pending
    const last = batch[batch.length - 1]
    const started = await createJob(improvementsDir, { trigger: last?.source === 'check-failure' ? 'check-failure' : 'feedback-count', items: batch, now })
    return { queue: { ...queue, pending: [], activeJobId: started.id }, result: { added, pending: 0, started } }
  })
}

/**
 * Start a job on request ("改进"), whatever the count: it takes the pending
 * batch too. `autoImprove` does not apply (the budget does, in the job).
 * @throws `tool/invalid-input` when another job holds the slot (one job per project).
 */
export async function startExplicitJob(improvementsDir: string, request: ImprovementRequest, now: Date = new Date()): Promise<ImprovementJob> {
  return updateQueue(improvementsDir, now, async current => {
    const slot = await reconcileSlot(improvementsDir, current, now)
    if (slot.active !== undefined) throw new NexgentError('tool/invalid-input', `improvement job ${slot.active.id} is still running in this project; one job runs at a time`)
    const started = await createJob(improvementsDir, { trigger: 'explicit', items: slot.queue.pending, request, now })
    return { queue: { ...slot.queue, pending: [], activeJobId: started.id }, result: started }
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
    let queue = current
    if (queue.activeJobId === jobId) {
      const { activeJobId: _released, ...rest } = queue
      queue = rest
    }
    if (!options.autoStart || queue.pending.length < threshold || queue.activeJobId !== undefined) return { queue, result: undefined }
    const batch = queue.pending
    const last = batch[batch.length - 1]
    const started = await createJob(improvementsDir, { trigger: last?.source === 'check-failure' ? 'check-failure' : 'feedback-count', items: batch, now })
    return { queue: { ...queue, pending: [], activeJobId: started.id }, result: started }
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
