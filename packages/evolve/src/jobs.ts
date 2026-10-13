/**
 * Improvement jobs on disk: `.nexgent/improvements/<jobId>/job.json` and its
 * side files. Every change goes through {@link transitionJob} (or
 * {@link updateJob} for references and spend), under the job's own lock file,
 * so the state machine in {@link JOB_TRANSITIONS} is enforced whoever writes:
 * the job process, the host's recovery, or a later approval.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { canMoveImprovement, IMPROVEMENT_FILES, IMPROVEMENT_LIMITS, IMPROVEMENT_STATUSES, NexgentError } from '@nexgent/kernel'
import { validateImprovementFile } from '@nexgent/session'
import { lockHeld, readJson, readLockPid, withFileLock, writeJsonAtomic } from './lock.js'
import {
  RUNNING_STATUSES,
  type ImprovementJob,
  type ImprovementJobStatus,
  type ImprovementRequest,
  type ImprovementTrigger,
  type QueueItem,
} from './types.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** A queued job without a process lock younger than this is still being started, not interrupted. */
export const START_GRACE_MS = 60_000

/** Paths of one job. */
export interface JobPaths {
  readonly directory: string
  readonly file: string
  /** Pid of the process running the job. */
  readonly lock: string
  /** Serializes writes of `job.json`. */
  readonly writeLock: string
  readonly log: string
  /** The accepted diagnosis. */
  readonly diagnosis: string
}

/** Paths of job `jobId` under `improvementsDir`. */
export function jobPaths(improvementsDir: string, jobId: string): JobPaths {
  if (!UUID.test(jobId)) throw new NexgentError('session/not-found', `no improvement job ${JSON.stringify(jobId)}`)
  const directory = join(improvementsDir, jobId)
  return {
    directory,
    file: join(directory, IMPROVEMENT_FILES.job),
    lock: join(directory, IMPROVEMENT_FILES.jobLock),
    writeLock: join(directory, IMPROVEMENT_FILES.jobFileLock),
    log: join(directory, IMPROVEMENT_FILES.jobLog),
    diagnosis: join(directory, IMPROVEMENT_FILES.diagnosis),
  }
}

const STATUSES = new Set<string>(IMPROVEMENT_STATUSES)

/** Cut a detail to the contract's bound. */
export function clip(text: string, max: number = IMPROVEMENT_LIMITS.maxDetailChars): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/**
 * Validate and write a job record.
 * @throws `internal` when the record breaks the schema (nothing is written).
 */
async function writeJob(path: string, job: ImprovementJob): Promise<void> {
  const issues = validateImprovementFile('job', job)
  if (issues.length > 0) throw new NexgentError('internal', `invalid improvement job ${job.id}: ${issues[0]!.path} ${issues[0]!.message}`)
  await writeJsonAtomic(path, job)
}

function isJob(value: unknown, id: string): value is ImprovementJob {
  const job = value as Partial<ImprovementJob> | undefined
  return typeof job === 'object' && job !== null && job.formatVersion === 1 && job.id === id
    && typeof job.status === 'string' && STATUSES.has(job.status)
    && Array.isArray(job.items) && Array.isArray(job.history) && typeof job.phases === 'object' && job.phases !== null
}

/**
 * Read one job.
 * @throws `session/not-found` when it does not exist; `session/corrupt` when the file is not a job.
 */
export async function readJob(improvementsDir: string, jobId: string): Promise<ImprovementJob> {
  const paths = jobPaths(improvementsDir, jobId)
  let value: unknown
  try {
    value = await readJson(paths.file)
  } catch (cause) {
    throw new NexgentError('session/corrupt', `improvement job ${jobId} is not valid JSON`, { cause })
  }
  if (value === undefined) throw new NexgentError('session/not-found', `no improvement job ${jobId}`)
  if (!isJob(value, jobId)) throw new NexgentError('session/corrupt', `improvement job ${jobId} is malformed`)
  return value
}

/** Every readable job, oldest first (unreadable directories are skipped). */
export async function listJobs(improvementsDir: string): Promise<ImprovementJob[]> {
  let names: string[]
  try {
    names = await readdir(improvementsDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const jobs: ImprovementJob[] = []
  for (const name of names) {
    if (!UUID.test(name)) continue
    const job = await readJob(improvementsDir, name).catch(() => undefined)
    if (job !== undefined) jobs.push(job)
  }
  return jobs.sort((left, right) => (left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : left.id < right.id ? -1 : 1))
}

/** What {@link createJob} takes. */
export interface CreateJobInput {
  readonly trigger: ImprovementTrigger
  readonly items: readonly QueueItem[]
  readonly request?: ImprovementRequest
  readonly now?: Date
  readonly id?: string
}

/** Write a new `queued` job (exclusive: a job id is never reused). */
export async function createJob(improvementsDir: string, input: CreateJobInput): Promise<ImprovementJob> {
  const id = input.id ?? randomUUID()
  const paths = jobPaths(improvementsDir, id)
  await mkdir(improvementsDir, { recursive: true })
  await mkdir(paths.directory)
  const at = (input.now ?? new Date()).toISOString()
  const job: ImprovementJob = {
    formatVersion: 1,
    id,
    trigger: input.trigger,
    status: 'queued',
    createdAt: at,
    updatedAt: at,
    items: [...input.items],
    ...(input.request === undefined ? {} : { request: input.request }),
    phases: {},
    history: [{ status: 'queued', at }],
  }
  await writeJob(paths.file, job)
  return job
}

/** Fields a writer may change besides the status. */
export type JobPatch = Partial<Omit<ImprovementJob, 'formatVersion' | 'id' | 'createdAt' | 'updatedAt' | 'trigger' | 'status' | 'items' | 'request' | 'history'>>

/**
 * Change a job's references or spend, keeping its status.
 * @returns the job as written.
 */
export async function updateJob(improvementsDir: string, jobId: string, patch: JobPatch | ((job: ImprovementJob) => JobPatch), now: Date = new Date()): Promise<ImprovementJob> {
  const paths = jobPaths(improvementsDir, jobId)
  return withFileLock(paths.writeLock, async () => {
    const job = await readJob(improvementsDir, jobId)
    const change = typeof patch === 'function' ? patch(job) : patch
    const next: ImprovementJob = { ...job, ...change, updatedAt: now.toISOString() }
    await writeJob(paths.file, next)
    return next
  })
}

/**
 * Move a job to `to`.
 * @param expect - only move when the current status is one of these (a recovery must not overwrite a job that just finished).
 * @returns the job as written, or `undefined` when `expect` did not match.
 * @throws `internal` when the state machine does not allow the move.
 */
export async function transitionJob(
  improvementsDir: string,
  jobId: string,
  to: ImprovementJobStatus,
  options: { readonly detail?: string; readonly patch?: JobPatch; readonly expect?: readonly ImprovementJobStatus[]; readonly now?: Date } = {},
): Promise<ImprovementJob | undefined> {
  const paths = jobPaths(improvementsDir, jobId)
  return withFileLock(paths.writeLock, async () => {
    const job = await readJob(improvementsDir, jobId)
    if (options.expect !== undefined && !options.expect.includes(job.status)) return undefined
    if (!canMoveImprovement(job.status, to)) throw new NexgentError('internal', `improvement job ${jobId} cannot move from ${job.status} to ${to}`)
    const at = (options.now ?? new Date()).toISOString()
    const detail = options.detail === undefined ? undefined : clip(options.detail)
    const next: ImprovementJob = {
      ...job,
      ...options.patch,
      status: to,
      updatedAt: at,
      ...(detail === undefined ? {} : { detail }),
      history: [...job.history, { status: to, at, ...(detail === undefined ? {} : { detail }) }],
    }
    await writeJob(paths.file, next)
    return next
  })
}

/**
 * Whether a process is working on the job (or about to): a running status
 * and a lock naming a live process, or a `queued` job younger than
 * {@link START_GRACE_MS} whose process has not taken its lock yet.
 */
export async function jobAlive(improvementsDir: string, job: ImprovementJob, now: Date = new Date()): Promise<boolean> {
  if (!RUNNING_STATUSES.has(job.status)) return false
  const paths = jobPaths(improvementsDir, job.id)
  if (await lockHeld(paths.lock)) return true
  if (job.status !== 'queued' || (await readLockPid(paths.lock)) !== undefined) return false
  const created = Date.parse(job.createdAt)
  if (now.getTime() - created >= START_GRACE_MS) return false
  // A lock-less queued job: a process may still be about to start it.
  return stat(paths.directory).then(() => true, () => false)
}
