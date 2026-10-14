/**
 * Step 6 (W5), API 7 (ADR 0012): the SDK's `improvers.*` methods over the
 * user's improver version line (`@nexgent/capabilities` `ImproverStore`,
 * `<NEXGENT_HOME>/improvers/`), shared by every project. The improver in
 * force is what `resolve()` reads, so a version that fails to load is rolled
 * back (`load-failure`) here as in a job, and the view names the problem.
 * The change that produced a version is read from the meta job whose
 * `change.json` names it as the child; meta jobs live in the projects that
 * hosted them, found through the user meta queue and the recent projects.
 */
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { ImproverStore, type ImproverActivation, type ResolvedImprover } from '@nexgent/capabilities'
import { improvementsDir, jobPaths, listJobs, readUserQueue, type ImprovementJob } from '@nexgent/evolve'
import { IMPROVER_V0_VERSION, NexgentError, resolveWorkspaceLayout, type ImproverChangeRecord, type ImproverRevision, type ImproverVersion } from '@nexgent/kernel'
import type { ImproverDetail, ImproverListing, ImproverVersionView } from './api.js'

/** At most this many projects in `ImproverListing.usedBy`. */
export const USED_BY_LIMIT = 20

/** The user's improver store below the Nexgent home. */
export function storeOf(home: string): ImproverStore {
  return ImproverStore.user({ home })
}

function problemOf(resolved: ResolvedImprover): string | undefined {
  const parts: string[] = []
  for (const rollback of resolved.rollbacks) parts.push(`Improver ${rollback.version.slice(0, 12)} failed to load and was rolled back: ${rollback.error.message}`)
  if (resolved.problem !== undefined) parts.push(`The improver history is damaged (${resolved.problem.file}): ${resolved.problem.message}`)
  if (resolved.fallback !== undefined) parts.push(`Improver ${resolved.fallback.version.slice(0, 12)} failed to load; v0 is used: ${resolved.fallback.error.message}`)
  return parts.length === 0 ? undefined : parts.join(' ')
}

/** The view of an activation tail, with the revision that made it. */
function viewOf(activation: ImproverActivation, revisions: readonly ImproverRevision[], problem?: string): ImproverVersionView {
  const tail = revisions.find(revision => revision.revision === activation.revision)
  return {
    version: activation.version,
    revision: activation.revision,
    ...(tail === undefined ? {} : { since: tail.committedAt, trigger: tail.trigger }),
    ...(tail?.jobId === undefined ? {} : { jobId: tail.jobId }),
    ...(problem === undefined ? {} : { problem }),
  }
}

/** The improver in force (rolling back one that fails to load); `changed` when this read wrote a revision. */
export async function current(store: ImproverStore): Promise<{ readonly view: ImproverVersionView; readonly changed: boolean }> {
  const resolved = await store.resolve()
  const chain = await store.chain()
  // A fallback without a revision keeps the damaged tail in the chain; the improver used is the fallback's.
  const activation = resolved.fallback === undefined ? resolved.activation : { ...resolved.activation, version: resolved.version }
  return { view: viewOf(activation, chain.revisions, problemOf(resolved)), changed: resolved.rollbacks.length > 0 }
}

/**
 * Project roots the user's improvement records point at: the user meta
 * queue's entries (counted jobs, meta jobs, the active one) and `extra`
 * (the recent and open projects), each once.
 */
export async function knownRoots(home: string, extra: readonly string[] = []): Promise<string[]> {
  const queue = await readUserQueue(home).catch(() => undefined)
  const roots = [
    ...extra,
    ...(queue?.active === undefined ? [] : [queue.active.root]),
    ...[...(queue?.metaJobs ?? [])].reverse().map(ref => ref.root),
    ...[...(queue?.pending ?? [])].reverse().map(entry => entry.root),
  ]
  return [...new Set(roots)]
}

async function jobsOf(root: string): Promise<ImprovementJob[]> {
  return listJobs(improvementsDir(resolveWorkspaceLayout(root))).catch(() => [])
}

/**
 * The projects whose jobs ran on `version` of the user line (`improverScope:
 * user`), most recent first: a rollback affects them all (ADR 0012).
 */
export async function usedBy(roots: readonly string[], version: ImproverVersion): Promise<NonNullable<ImproverListing['usedBy']>> {
  const found: { root: string; name: string; lastJobAt: string }[] = []
  for (const root of roots) {
    let last: string | undefined
    for (const job of await jobsOf(root)) {
      if (job.improverScope !== 'user' || (job.improverVersion ?? IMPROVER_V0_VERSION) !== version) continue
      if (last === undefined || job.createdAt > last) last = job.createdAt
    }
    if (last !== undefined) found.push({ root, name: basename(root) || root, lastJobAt: last })
  }
  return found.sort((a, b) => b.lastJobAt.localeCompare(a.lastJobAt)).slice(0, USED_BY_LIMIT)
}

/** `improvers.list`: the user line, and the projects that ran on the improver in force. */
export async function list(store: ImproverStore, roots: readonly string[]): Promise<{ readonly listing: ImproverListing; readonly changed: boolean }> {
  const { view, changed } = await current(store)
  const [chain, users] = await Promise.all([store.chain(), usedBy(roots, view.version)])
  return { listing: { current: view, history: chain.revisions, usedBy: users }, changed }
}

function version(value: unknown, name: string): ImproverVersion {
  if (typeof value !== 'string' || value === '') throw new NexgentError('tool/invalid-input', `${name} must be a non-empty string`)
  return value
}

/** The accepted change whose child is `version`, from the meta jobs' `change.json` in the known projects. */
async function changeOf(roots: readonly string[], version: ImproverVersion): Promise<ImproverChangeRecord | undefined> {
  if (version === IMPROVER_V0_VERSION) return undefined
  for (const root of roots) {
    const directory = improvementsDir(resolveWorkspaceLayout(root))
    for (const job of [...await jobsOf(root)].reverse()) {
      if (job.kind !== 'meta' || job.meta?.childVersion !== version) continue
      try {
        return JSON.parse(await readFile(jobPaths(directory, job.id).change, 'utf8')) as ImproverChangeRecord
      } catch {
        // not written (or unreadable): look further
      }
    }
  }
  return undefined
}

/** `improvers.show`. */
export async function show(store: ImproverStore, roots: readonly string[], input: unknown): Promise<ImproverDetail> {
  const wanted = version(input, 'version')
  const [bundle, activation, change] = await Promise.all([store.load(wanted), store.activation(), changeOf(roots, wanted)])
  return { version: wanted, bundle, ...(change === undefined ? {} : { change }), current: activation.version === wanted }
}

/** `improvers.rollback`: a `manual` revision back to the previous improver (or `toVersion`). */
export async function rollback(store: ImproverStore, input: { readonly toVersion?: unknown; readonly reason?: unknown }): Promise<ImproverVersionView> {
  if (input.reason !== undefined && typeof input.reason !== 'string') throw new NexgentError('tool/invalid-input', 'reason must be a string')
  const toVersion = input.toVersion === undefined ? undefined : version(input.toVersion, 'toVersion')
  const commit = await store.rollback({
    trigger: 'manual',
    ...(toVersion === undefined ? {} : { toVersion }),
    ...(input.reason === undefined || input.reason === '' ? {} : { reason: input.reason as string }),
  })
  if (commit === null) throw new NexgentError('improver/activation', 'the improver changed while rolling back; try again')
  return (await current(store)).view
}
