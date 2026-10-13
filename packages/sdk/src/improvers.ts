/**
 * Step 6 (W5): the SDK's `improvers.*` methods over one project's improver
 * version line (`@nexgent/capabilities` `ImproverStore`, `.nexgent/improvers/`).
 * The improver in force is what `resolve()` reads, so a version that fails to
 * load is rolled back (`load-failure`) here as in a job, and the view names
 * the problem. The change that produced a version is read from the meta job
 * whose `change.json` names it as the child.
 */
import { readFile } from 'node:fs/promises'
import { ImproverStore, improversDir, type ImproverActivation, type ResolvedImprover } from '@nexgent/capabilities'
import { jobPaths, listJobs } from '@nexgent/evolve'
import { IMPROVER_V0_VERSION, NexgentError, type ImproverChangeRecord, type ImproverRevision, type ImproverVersion, type WorkspaceLayout } from '@nexgent/kernel'
import type { ImproverDetail, ImproverListing, ImproverVersionView } from './api.js'

/** The project's improver store. */
export function storeOf(layout: Pick<WorkspaceLayout, 'dataDir'>): ImproverStore {
  return new ImproverStore(improversDir(layout))
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

/** `improvers.list`. */
export async function list(store: ImproverStore): Promise<{ readonly listing: ImproverListing; readonly changed: boolean }> {
  const { view, changed } = await current(store)
  const chain = await store.chain()
  return { listing: { current: view, history: chain.revisions }, changed }
}

function version(value: unknown, name: string): ImproverVersion {
  if (typeof value !== 'string' || value === '') throw new NexgentError('tool/invalid-input', `${name} must be a non-empty string`)
  return value
}

/** The accepted change whose child is `version`, from the meta jobs' `change.json`. */
async function changeOf(improvementsDir: string, version: ImproverVersion): Promise<ImproverChangeRecord | undefined> {
  if (version === IMPROVER_V0_VERSION) return undefined
  const jobs = await listJobs(improvementsDir).catch(() => [])
  for (const job of [...jobs].reverse()) {
    if (job.kind !== 'meta' || job.meta?.childVersion !== version) continue
    try {
      return JSON.parse(await readFile(jobPaths(improvementsDir, job.id).change, 'utf8')) as ImproverChangeRecord
    } catch {
      // not written (or unreadable): look further
    }
  }
  return undefined
}

/** `improvers.show`. */
export async function show(store: ImproverStore, improvementsDir: string, input: unknown): Promise<ImproverDetail> {
  const wanted = version(input, 'version')
  const [bundle, activation, change] = await Promise.all([store.load(wanted), store.activation(), changeOf(improvementsDir, wanted)])
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
