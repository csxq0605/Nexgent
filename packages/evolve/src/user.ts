/**
 * The user-level side of the improvement flow (ADR 0012, `data-formats.md`
 * §改进器版本 and §元改进作业): one improver version line for every project
 * of the user, and meta jobs counted, slotted and budgeted per user.
 *
 * - The improver lives below the Nexgent home (`<home>/improvers/`, written
 *   by `@nexgent/capabilities`' `ImproverStore`); {@link userImprovers} is
 *   the source every new job reads. A project's own `.nexgent/improvers/`
 *   is read-only history ({@link PROJECT_IMPROVERS}).
 * - The meta queue is `<home>/improvements/queue.json`, changed only under
 *   `queue.lock` like a project queue. A finished capability job of a
 *   project that shares its evidence (`improvement.shareImproverEvidence`)
 *   is counted with `(projectId, jobId)` ({@link countFinishedJobForUser});
 *   every `everyJobs` counted jobs start one meta job, in the project of the
 *   job that completed the batch, holding the user's single meta slot. An
 *   explicit meta job ({@link startExplicitUserMetaJob}) lives in the
 *   project it was asked from.
 * - The meta settings and budget come from the user config
 *   (`<home>/config.json`, {@link readUserConfig}); the budget sums the meta
 *   jobs the queue lists ({@link userMetaBudgetStatus}).
 * - A meta job reads only the projects of its batch ({@link metaProjects}).
 */
import { createHash } from 'node:crypto'
import { mkdir, realpath } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import {
  assertUserConfig,
  countUserFinishedJob,
  emptyUserMetaQueue,
  IMPROVEMENT_FILES,
  nexgentHome,
  NexgentError,
  readProjectConfig,
  releaseUserMetaSlot,
  resolveUserConfig,
  resolveProjectLayout,
  takeUserMetaBatch,
  USER_CONFIG_FILE_NAME,
  USER_IMPROVEMENTS_DIR,
  type ImprovementBudget,
  type ImproverVersion,
  type UserConfig,
  type UserMetaJobRef,
  type UserMetaQueue,
  type UserMetaQueueEntry,
  type WorkspaceLayout,
} from '@nexgent/kernel'
import { ImproverStore, userImproversDir } from '@nexgent/capabilities'
import { validateImprovementFile } from '@nexgent/session'
import { budgetStatus, type BudgetStatus } from './budget.js'
import type { ImproverSource } from './improver.js'
import { createJob, jobAlive, listJobs, readJob, transitionJob } from './jobs.js'
import { readJson, withFileLock, writeJsonAtomic } from './lock.js'
import { improvementsDir } from './paths.js'
import { RUNNING_STATUSES, type ImprovementJob } from './types.js'

/** The Nexgent home a caller names, else `NEXGENT_HOME` / `~/.nexgent`. */
export function homeOf(home: string | undefined): string {
  return home ?? nexgentHome()
}

/** `<home>/improvers`: the user's improver version line (`@nexgent/capabilities`). */
export { userImproversDir }

/** `<home>/improvements`: the user's meta queue. */
export function userImprovementsDir(home: string): string {
  return join(home, USER_IMPROVEMENTS_DIR)
}

/** The user's improver line (`ImproverStore` below the home): what every new job reads. */
export function userImprovers(home: string): ImproverSource {
  const store = () => new ImproverStore(userImproversDir(home))
  return {
    async current() {
      const resolved = await store().resolve()
      return { version: resolved.version, bundle: resolved.bundle }
    },
    load(_layout, version) {
      return store().load(version)
    },
  }
}

/**
 * A project's id in user-level records (ADR 0012): the lowercase hex
 * SHA-256 of its root's realpath, `\` turned into `/`, lowercased on Windows.
 */
export async function userProjectId(root: string, platform: NodeJS.Platform = process.platform): Promise<string> {
  let path = await realpath(root).catch(() => resolve(root))
  path = path.replace(/\\/g, '/')
  if (platform === 'win32') path = path.toLowerCase()
  return createHash('sha256').update(path, 'utf8').digest('hex')
}

/**
 * The user config (`<home>/config.json`); a missing file is `{}`.
 * @throws `config/invalid` when the file is not a valid user config.
 */
export async function readUserConfig(home: string): Promise<UserConfig> {
  let value: unknown
  try {
    value = await readJson(join(home, USER_CONFIG_FILE_NAME))
  } catch (cause) {
    throw new NexgentError('config/invalid', `${USER_CONFIG_FILE_NAME} (Nexgent home) is not valid JSON`, { cause })
  }
  if (value === undefined) return resolveUserConfig()
  assertUserConfig(value)
  return resolveUserConfig(value)
}

/** `resolveProjectLayout` options for an optional home (default: `NEXGENT_HOME` / `~/.nexgent`). */
function homeOptions(home: string | undefined): { home?: string } {
  return home === undefined ? {} : { home }
}

/** Whether a project shares its improvement evidence (`improvement.shareImproverEvidence`); an unreadable project does not. */
export async function projectShares(root: string, home?: string): Promise<boolean> {
  try {
    return (await readProjectConfig(resolveProjectLayout(root, homeOptions(home)).configFile)).config.improvement.shareImproverEvidence
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// The user meta queue
// ---------------------------------------------------------------------------

/**
 * Read the user's meta queue.
 * @returns `undefined` when counting has not started for this home.
 * @throws `session/corrupt` when the file is not a user queue.
 */
export async function readUserQueue(home: string): Promise<UserMetaQueue | undefined> {
  const path = join(userImprovementsDir(home), IMPROVEMENT_FILES.queue)
  let value: unknown
  try {
    value = await readJson(path)
  } catch (cause) {
    throw new NexgentError('session/corrupt', `${path} is not valid JSON`, { cause })
  }
  if (value === undefined) return undefined
  if (validateImprovementFile('userQueue', value).length > 0) throw new NexgentError('session/corrupt', `${path} is malformed`)
  return value as UserMetaQueue
}

/** Run `change` on the user queue under its lock and write the result; a missing queue starts empty at `since`. */
async function updateUserQueue<T>(home: string, since: string, change: (queue: UserMetaQueue) => Promise<{ queue: UserMetaQueue; result: T }>): Promise<T> {
  const directory = userImprovementsDir(home)
  await mkdir(directory, { recursive: true })
  return withFileLock(join(directory, IMPROVEMENT_FILES.queueLock), async () => {
    const existing = await readUserQueue(home)
    const current = existing ?? emptyUserMetaQueue(since)
    const { queue, result } = await change(current)
    if (existing === undefined || queue !== current) await writeJsonAtomic(join(directory, IMPROVEMENT_FILES.queue), queue)
    return result
  })
}

/** Make sure the user queue exists (its `since` marks when counting began). */
export async function ensureUserQueue(home: string, now: Date = new Date()): Promise<UserMetaQueue> {
  return updateUserQueue(home, now.toISOString(), async queue => ({ queue, result: queue }))
}

/** The meta job of a queue reference, read from its project (`undefined` when gone). */
async function refJob(ref: Pick<UserMetaJobRef, 'root' | 'jobId'>, home: string): Promise<ImprovementJob | undefined> {
  return readJob(improvementsDir(resolveProjectLayout(ref.root, { home })), ref.jobId).catch(() => undefined)
}

/**
 * Free the user's meta slot when its job no longer runs; a running meta job
 * whose process is gone is marked `interrupted` (not re-run).
 */
async function reconcileUserSlot(queue: UserMetaQueue, now: Date, home: string): Promise<{ queue: UserMetaQueue; active?: ImprovementJob }> {
  const ref = queue.active
  if (ref === undefined) return { queue }
  const directory = improvementsDir(resolveProjectLayout(ref.root, { home }))
  const job = await refJob(ref, home)
  if (job !== undefined && await jobAlive(directory, job, now)) return { queue, active: job }
  if (job !== undefined && RUNNING_STATUSES.has(job.status)) {
    await transitionJob(directory, ref.jobId, 'interrupted', { expect: [...RUNNING_STATUSES], now, detail: 'The meta job process is gone; the job stopped before it finished and is not re-run.' }).catch(() => undefined)
  }
  return { queue: releaseUserMetaSlot(queue, ref.jobId) }
}

/** Which of the queue's projects still share their evidence (read once per project). */
async function sharingOf(entries: readonly UserMetaQueueEntry[], home: string): Promise<(projectId: string) => boolean> {
  const shares = new Map<string, boolean>()
  for (const entry of entries) if (!shares.has(entry.projectId)) shares.set(entry.projectId, await projectShares(entry.root, home))
  return projectId => shares.get(projectId) ?? false
}

/** Create a meta job in `layout` on a taken batch, and the queue holding it in the user's slot. */
async function startMeta(
  layout: WorkspaceLayout,
  queue: UserMetaQueue,
  batch: readonly UserMetaQueueEntry[],
  input: { readonly trigger: 'job-count' | 'explicit'; readonly parentVersion: ImproverVersion; readonly keepCopies?: boolean; readonly now: Date },
): Promise<{ queue: UserMetaQueue; started: ImprovementJob }> {
  const meta = { basis: batch.map(entry => entry.jobId), parentVersion: input.parentVersion, batch: [...batch], ...(input.keepCopies === true ? { keepCopies: true } : {}) }
  const started = await createJob(improvementsDir(layout), { trigger: input.trigger, items: [], kind: 'meta', meta, now: input.now })
  const ref: UserMetaJobRef = { projectId: await userProjectId(layout.root), root: layout.root, jobId: started.id, createdAt: started.createdAt }
  return { queue: { ...queue, active: ref, metaJobs: [...queue.metaJobs, ref] }, started }
}

/** What {@link countFinishedJobForUser} needs. */
export interface UserCountOptions {
  /** Start a meta job when the batch is full (the user config's `improvement.meta.enabled`, and an improver to start from). */
  readonly meta?: { readonly enabled: boolean; readonly everyJobs: number; readonly parentVersion: ImproverVersion }
  readonly now?: Date
}

/**
 * Count a finished job of `layout` toward the user's next meta job and, with
 * `meta.enabled`, a full batch and a free slot, create the meta job in this
 * project (in the same locked update). Arms, meta jobs, unfinished jobs and
 * projects that do not share are not counted (`countUserFinishedJob`).
 * @returns the meta job started, if any.
 */
export async function countFinishedJobForUser(home: string, layout: WorkspaceLayout, job: ImprovementJob, options: UserCountOptions = {}): Promise<ImprovementJob | undefined> {
  if (job.arm !== undefined || job.kind === 'meta') return undefined
  const now = options.now ?? new Date()
  const project = { projectId: await userProjectId(layout.root), root: layout.root, shares: await projectShares(layout.root, home) }
  // A queue first created here counts from the job's own start.
  return updateUserQueue(home, job.createdAt, async current => {
    const counted = countUserFinishedJob(current, project, job, now.toISOString())
    let queue = counted.queue
    const meta = options.meta
    if (meta?.enabled !== true) return { queue, result: undefined }
    const slot = await reconcileUserSlot(queue, now, home)
    queue = slot.queue
    if (slot.active !== undefined) return { queue, result: undefined }
    const taken = takeUserMetaBatch(queue, meta.everyJobs, await sharingOf(queue.pending, home))
    if (taken.batch === undefined) return { queue: taken.queue, result: undefined }
    const next = await startMeta(layout, taken.queue, taken.batch, { trigger: 'job-count', parentVersion: meta.parentVersion, now })
    return { queue: next.queue, result: next.started }
  })
}

/**
 * Start a meta job on request (`improvements.runMeta`) in `layout`, whatever
 * the switch and the count: it takes the user's pending batch (possibly
 * empty). The meta budget is checked by the caller and by the job.
 * @throws `improvement/busy` when another meta job holds the user's slot.
 */
export async function startExplicitUserMetaJob(
  home: string,
  layout: WorkspaceLayout,
  input: { readonly parentVersion: ImproverVersion; readonly keepCopies?: boolean },
  now: Date = new Date(),
): Promise<ImprovementJob> {
  return updateUserQueue(home, now.toISOString(), async current => {
    const slot = await reconcileUserSlot(current, now, home)
    if (slot.active !== undefined) {
      const root = slot.queue.active?.root
      throw new NexgentError('improvement/busy', `meta improvement job ${slot.active.id} is still running${root === undefined ? '' : ` (project ${root})`}; one meta job runs at a time`, { details: { jobId: slot.active.id } })
    }
    const taken = takeUserMetaBatch(slot.queue, 0, await sharingOf(slot.queue.pending, home))
    const next = await startMeta(layout, taken.queue, taken.batch ?? [], { trigger: 'explicit', parentVersion: input.parentVersion, ...(input.keepCopies === undefined ? {} : { keepCopies: input.keepCopies }), now })
    return { queue: next.queue, result: next.started }
  })
}

/** Free the user's meta slot held by `jobId` (its process is done with it). */
export async function releaseUserMeta(home: string, jobId: string, now: Date = new Date()): Promise<void> {
  if ((await readUserQueue(home)) === undefined) return
  await updateUserQueue(home, now.toISOString(), async current => ({ queue: releaseUserMetaSlot(current, jobId), result: undefined }))
}

/** Free the user's slot when its meta job no longer runs (startup recovery). */
export async function reconcileUserQueue(home: string, now: Date = new Date()): Promise<UserMetaQueue | undefined> {
  if ((await readUserQueue(home)) === undefined) return undefined
  return updateUserQueue(home, now.toISOString(), async current => {
    const slot = await reconcileUserSlot(current, now, home)
    return { queue: slot.queue, result: slot.queue }
  })
}

/** The meta jobs the user queue lists (unreadable ones are skipped). */
export async function userMetaJobs(home: string): Promise<ImprovementJob[]> {
  const queue = await readUserQueue(home)
  const jobs: ImprovementJob[] = []
  for (const ref of queue?.metaJobs ?? []) {
    const job = await refJob(ref, home)
    if (job !== undefined) jobs.push(job)
  }
  return jobs
}

/** What the user's meta budget window has spent (every meta job the queue lists, both comparison arms included). */
export async function userMetaBudgetStatus(home: string, budget: ImprovementBudget, now: Date = new Date()): Promise<BudgetStatus> {
  return budgetStatus(await userMetaJobs(home), budget, now)
}

// ---------------------------------------------------------------------------
// The projects a meta job reads
// ---------------------------------------------------------------------------

/** One project a meta job may read (ADR 0012 decision 4). */
export interface MetaProject {
  readonly projectId: string
  readonly layout: WorkspaceLayout
  /** The root's folder name (for the session's first message). */
  readonly name: string
}

/**
 * The projects of a meta job's batch that still share their evidence, in
 * batch order. A meta job without a batch entry (an explicit one on an
 * empty batch, or a project-level meta job from before ADR 0012) reads its
 * own project.
 */
export async function metaProjects(host: WorkspaceLayout, job: ImprovementJob, home?: string): Promise<MetaProject[]> {
  const batch = job.meta?.batch ?? []
  const projects: MetaProject[] = []
  for (const entry of batch) {
    if (projects.some(project => project.projectId === entry.projectId)) continue
    if (!(await projectShares(entry.root, home))) continue
    projects.push({ projectId: entry.projectId, layout: resolveProjectLayout(entry.root, homeOptions(home)), name: basename(entry.root) })
  }
  if (batch.length === 0) projects.push({ projectId: await userProjectId(host.root), layout: host, name: basename(host.root) })
  return projects
}

/** One job of a meta job's projects. */
export interface ProjectJob {
  readonly project: MetaProject
  readonly job: ImprovementJob
}

/** Every job of the given projects, oldest first. */
export async function projectJobs(projects: readonly MetaProject[]): Promise<ProjectJob[]> {
  const out: ProjectJob[] = []
  for (const project of projects) for (const job of await listJobs(improvementsDir(project.layout))) out.push({ project, job })
  return out.sort((left, right) => (left.job.createdAt < right.job.createdAt ? -1 : left.job.createdAt > right.job.createdAt ? 1 : 0))
}
