/**
 * The layer-1 learning queue of a project (ADR 0018 decision 10: reflection
 * and curation run one at a time per project): `<project data>/learning/
 * queue.json`, rewritten atomically under `queue.lock`. It holds the tasks
 * waiting to be learned from and a bounded history of the tasks learned from
 * (which reflection searches for a similar task with a different outcome).
 *
 * A turn of a task already in the queue replaces its pending item (the
 * reflection then covers every turn since the last one learned from). Items
 * that were running when the app exited go back to pending on the next start.
 */
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SelfEvalOutcome, TaskCheck } from '@nexgent/kernel'
import { withFileLock, writeJsonAtomic } from '../lock.js'

/** `<project data>/learning`. */
export const LEARNING_DIR = 'learning'
export const LEARNING_QUEUE_FILE = 'queue.json'
export const LEARNING_QUEUE_LOCK = 'queue.lock'
/** Held by the process that works the queue. */
export const LEARNING_WORKER_LOCK = 'worker.lock'

/** Pending items kept; older ones are dropped first. */
export const MAX_PENDING = 50
/** History entries kept; older ones are dropped first. */
export const MAX_HISTORY = 500
/** Attempts before an item is given up. */
export const MAX_ATTEMPTS = 3

/** Where an item stands. */
export type LearningItemStatus = 'pending' | 'running' | 'waiting-budget'

/** One task waiting to be learned from. */
export interface LearningItem {
  readonly taskId: string
  readonly sessionId: string
  /** First root turn not yet learned from. */
  readonly fromTurn: number
  /** Last root turn to learn from. */
  readonly turn: number
  /** That turn's deterministic checks. */
  readonly checks: readonly TaskCheck[]
  readonly enqueuedAt: string
  readonly status: LearningItemStatus
  readonly attempts: number
  readonly detail?: string
}

/** How learning from a task ended. */
export type LearnedStatus = 'done' | 'skipped' | 'failed'

/** One task learned from. */
export interface LearnedTask {
  readonly taskId: string
  readonly sessionId: string
  readonly fromTurn: number
  readonly throughTurn: number
  readonly finishedAt: string
  readonly status: LearnedStatus
  readonly outcome: SelfEvalOutcome
  /** The task's first message, at most 500 characters. */
  readonly task: string
  readonly keywords: readonly string[]
  /** What the run did, at most 600 characters (for a later contrast). */
  readonly approach: string
  /** Operations written, by kind. */
  readonly ops: Readonly<Record<string, number>>
  /** Operations curation dropped, by reason. */
  readonly rejected: Readonly<Record<string, number>>
  /** Ids of entries this task added. */
  readonly added: readonly string[]
  /** Estimated dollars of the reflection request. */
  readonly usd?: number
  readonly detail?: string
  /** Project-relative files the task presented as its result and did not delete itself (ADR 0023 revert signal). */
  readonly outputs?: readonly string[]
  /** Project-relative files the task's turns deleted. */
  readonly deleted?: readonly string[]
  /** The user removed every presented file; its outcome was recorded as a revert. */
  readonly reverted?: boolean
  /** ADR 0023 outcome score (0–1) from the user, the checks or the external review, when there was one. */
  readonly externalScore?: number
}

/** `queue.json`. */
export interface LearningQueueFile {
  readonly formatVersion: 1
  readonly items: readonly LearningItem[]
  readonly history: readonly LearnedTask[]
}

const EMPTY: LearningQueueFile = { formatVersion: 1, items: [], history: [] }

/** The paths of a project's learning directory. */
export function learningPaths(projectDataDir: string): { readonly directory: string; readonly queue: string; readonly lock: string; readonly worker: string } {
  const directory = join(projectDataDir, LEARNING_DIR)
  return { directory, queue: join(directory, LEARNING_QUEUE_FILE), lock: join(directory, LEARNING_QUEUE_LOCK), worker: join(directory, LEARNING_WORKER_LOCK) }
}

/** Read the queue (missing or unreadable: empty). */
export async function readLearningQueue(projectDataDir: string): Promise<LearningQueueFile> {
  try {
    const value = JSON.parse(await readFile(learningPaths(projectDataDir).queue, 'utf8')) as LearningQueueFile
    if (value?.formatVersion !== 1 || !Array.isArray(value.items) || !Array.isArray(value.history)) return EMPTY
    return value
  } catch {
    return EMPTY
  }
}

/** Change the queue under its lock. */
export async function updateLearningQueue<T>(projectDataDir: string, change: (queue: LearningQueueFile) => { readonly queue: LearningQueueFile; readonly result: T }): Promise<T> {
  const paths = learningPaths(projectDataDir)
  await mkdir(paths.directory, { recursive: true })
  return withFileLock(paths.lock, async () => {
    const { queue, result } = change(await readLearningQueue(projectDataDir))
    await writeJsonAtomic(paths.queue, {
      formatVersion: 1,
      items: queue.items.slice(-MAX_PENDING),
      history: queue.history.slice(-MAX_HISTORY),
    } satisfies LearningQueueFile)
    return result
  })
}

/** Add (or replace) the item of a task (pure). The first turn not yet learned from comes from the history. */
export function enqueueItem(queue: LearningQueueFile, input: Omit<LearningItem, 'fromTurn' | 'status' | 'attempts'>): LearningQueueFile {
  const learned = queue.history.filter(entry => entry.taskId === input.taskId).reduce((max, entry) => Math.max(max, entry.throughTurn), 0)
  if (input.turn <= learned) return queue
  const running = queue.items.find(item => item.taskId === input.taskId && item.status === 'running')
  const waiting = queue.items.find(item => item.taskId === input.taskId && item.status !== 'running')
  // A running reflection covers up to its own turn; the next one starts after it.
  const fromTurn = waiting?.fromTurn ?? (running === undefined ? learned + 1 : running.turn + 1)
  if (input.turn < fromTurn) return queue
  const item: LearningItem = { ...input, fromTurn, status: 'pending', attempts: 0 }
  return { ...queue, items: [...queue.items.filter(other => other !== waiting), item] }
}
