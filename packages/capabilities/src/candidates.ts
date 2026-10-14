/**
 * Candidates `.nexgent/capabilities/candidates/<id>/` (`data-formats.md`
 * §候选与门控): `candidate.json` plus a copy of the proposed components'
 * files under `<kind-dir>/<name>/`. The directory is assembled under a
 * temporary name and renamed into place, so it appears complete or not at
 * all; it is never changed afterwards. The candidate's bundle (the base
 * bundle with the proposed components added or replaced) is stored at the
 * same time, so the gate can run it without rebuilding anything.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { renameRetrying } from './fs-retry.js'
import {
  CAPABILITY_DIRS,
  NexgentError,
  type CandidateOrigin,
  type CandidateRecord,
  type CapabilityComponent,
  type CapabilityComponentRef,
  type ComponentUseProof,
} from '@nexgent/kernel'
import { validateCapabilityFile } from '@nexgent/session'
import type { ComponentFiles } from './components.js'
import { fileEntries } from './drafts.js'
import { componentPath, readComponentFiles, writeBundle, type BundleComponentInput, type StoredBundle } from './store.js'

/** Directory name of candidates inside `.nexgent/capabilities/`. */
export const CANDIDATES_DIR = CAPABILITY_DIRS.candidates

/** File name of a candidate's record. */
export const CANDIDATE_FILE = 'candidate.json'

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** One proposed component with its files. */
export interface ProposedComponent extends CapabilityComponentRef {
  readonly files: ComponentFiles
}

/** What {@link writeCandidate} needs besides the components. */
export interface CandidateInput {
  readonly sessionId: string
  readonly taskId: string
  readonly turn: number
  /** The bundle the session runs on. */
  readonly base: StoredBundle
  readonly components: readonly ProposedComponent[]
  readonly proofs: readonly ComponentUseProof[]
  readonly summary?: string
  /** Step 5: `improvement` for a candidate of an improvement job's propose phase (with its `jobId`); absent means a user task's own. */
  readonly origin?: CandidateOrigin
  readonly jobId?: string
}

/**
 * Store the candidate's bundle, then publish the candidate directory. The
 * base's components are kept unless a proposed component replaces them: one
 * of the same kind and name, or for a context policy (at most one per
 * bundle) any proposed context policy.
 * @throws `config/invalid` when the resulting bundle breaks the manifest rules (too many components, …).
 */
export async function writeCandidate(capabilitiesDir: string, input: CandidateInput, now: () => Date = () => new Date()): Promise<{ readonly record: CandidateRecord; readonly bundle: StoredBundle }> {
  const key = (ref: CapabilityComponentRef) => `${ref.kind}/${ref.name}`
  const replaced = new Set(input.components.map(key))
  // A bundle holds at most one context policy: a proposed one replaces the base's, whatever its name.
  const newPolicy = input.components.some(component => component.kind === 'context-policy')
  const inputs: BundleComponentInput[] = []
  for (const component of input.base.manifest.components) {
    if (newPolicy && component.kind === 'context-policy') continue
    if (!replaced.has(key(component))) inputs.push({ kind: component.kind, name: component.name, files: await readComponentFiles(input.base, component) })
  }
  for (const component of input.components) {
    inputs.push({ kind: component.kind, name: component.name, files: [...component.files].map(([path, content]) => ({ path, content })) })
  }
  const bundle = await writeBundle(capabilitiesDir, inputs)

  const components: CapabilityComponent[] = input.components.map(component => ({ kind: component.kind, name: component.name, files: fileEntries(component.files) }))
  const record: CandidateRecord = {
    formatVersion: 1,
    id: randomUUID(),
    proposedAt: now().toISOString(),
    sessionId: input.sessionId,
    taskId: input.taskId,
    turn: input.turn,
    base: input.base.version,
    version: bundle.version,
    components,
    proofs: input.proofs,
    requiresApproval: input.components.some(component => component.kind === 'plugin'),
    ...(input.summary === undefined ? {} : { summary: input.summary }),
    ...(input.origin === undefined ? {} : { origin: input.origin }),
    ...(input.jobId === undefined ? {} : { jobId: input.jobId }),
  }
  const issues = validateCapabilityFile('candidate', record)
  if (issues.length > 0) throw new NexgentError('config/invalid', `invalid candidate record: ${issues[0]!.path} ${issues[0]!.message}`)

  const root = join(capabilitiesDir, CANDIDATES_DIR)
  const staging = join(root, `.staging-${randomUUID()}`)
  try {
    for (const component of input.components) {
      for (const [path, bytes] of component.files) {
        const target = join(componentPath(staging, component), ...path.split('/'))
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, bytes, { flag: 'wx' })
      }
    }
    await mkdir(staging, { recursive: true })
    await writeFile(join(staging, CANDIDATE_FILE), `${JSON.stringify(record)}\n`, { flag: 'wx' })
    await renameRetrying(staging, join(root, record.id))
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
  return { record, bundle }
}

/**
 * Read one candidate record.
 * @throws `session/not-found` when absent; `session/corrupt` when invalid.
 */
export async function readCandidate(capabilitiesDir: string, id: string): Promise<CandidateRecord> {
  if (!ID.test(id)) throw new NexgentError('session/not-found', `no candidate ${JSON.stringify(id)}`)
  let raw: string
  try {
    raw = await readFile(join(capabilitiesDir, CANDIDATES_DIR, id, CANDIDATE_FILE), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new NexgentError('session/not-found', `no candidate ${id}`)
    throw error
  }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (error) {
    throw new NexgentError('session/corrupt', `candidate ${id} is not JSON`, { cause: error })
  }
  if (validateCapabilityFile('candidate', value).length > 0 || (value as CandidateRecord).id !== id) throw new NexgentError('session/corrupt', `candidate ${id} is invalid`)
  return value as CandidateRecord
}

/** Every readable candidate, oldest first. */
export async function listCandidates(capabilitiesDir: string): Promise<CandidateRecord[]> {
  let names: string[]
  try {
    names = await readdir(join(capabilitiesDir, CANDIDATES_DIR))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const records: CandidateRecord[] = []
  for (const name of names.filter(entry => ID.test(entry))) {
    try {
      records.push(await readCandidate(capabilitiesDir, name))
    } catch {
      // Unreadable candidates are skipped here; `readCandidate` reports them when asked by id.
    }
  }
  return records.sort((left, right) => (left.proposedAt < right.proposedAt ? -1 : left.proposedAt > right.proposedAt ? 1 : 0))
}
