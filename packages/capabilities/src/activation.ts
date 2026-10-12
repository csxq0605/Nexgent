// Adapted from Nexgent PR #4 runtime/packages/bundle/nexgent-app/src/architecture-activation.ts (archive/python-host)
/**
 * The activation chain `.nexgent/capabilities/activation/<n>.json`
 * (`data-formats.md` §采用历史): an append-only list of immutable revisions,
 * each `adopt` (make a stored bundle current) or `rollback` (return to the
 * version in force before the last adoption still in effect). The adopted
 * version is the chain's tail; revision zero is the baseline.
 *
 * Reading walks the chain from revision 1 and checks each file against the
 * state before it (`isNextRevision`, the schema, and the rollback target).
 * At the first missing, malformed or divergent revision it stops at the last
 * valid one and reports the problem instead of guessing; a damaged chain
 * accepts no further revisions until a person repairs it.
 *
 * A revision is published with exclusive-create semantics (temporary file,
 * fsync, hard link to `<n>.json`, which fails if the name exists) and only
 * when the caller's observed tail is still the tail (compare-and-publish), so
 * of two processes publishing the same revision number exactly one succeeds.
 *
 * Changes from PR #4: one chain per project; versions may be `baseline`; the
 * revision names a trigger and a decision record instead of carrying
 * evidence and a compiled-script digest; rollback targets are derived from
 * the chain and checked on read; ISO timestamps; async I/O; selection
 * reservations belong to the gate (W3).
 */
import { randomUUID } from 'node:crypto'
import { link, mkdir, open, readdir, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import {
  ACTIVATION_TRIGGERS,
  CAPABILITY_DIRS,
  fsyncDirectory,
  INITIAL_ACTIVATION,
  isNextRevision,
  NexgentError,
  type ActivationRevision,
  type ActivationState,
  type ActivationTrigger,
} from '@nexgent/kernel'
import { validateCapabilityFile } from '@nexgent/session'
import { BASELINE_VERSION, isBundleVersion, sha256 } from './manifest.js'

/** Directory name of the chain inside `.nexgent/capabilities/`. */
export const ACTIVATION_DIR = CAPABILITY_DIRS.activation

/** The chain's tail plus what a rollback would return to. */
export interface Activation extends ActivationState {
  /**
   * Versions in force, oldest first, ending with {@link ActivationState.version}:
   * `baseline`, then each adoption not yet rolled back. A rollback returns to
   * the entry before the last.
   */
  readonly stack: readonly string[]
}

/** Why a chain stopped before its last file. */
export interface ActivationProblem {
  /** The first file that could not be accepted. */
  readonly file: string
  readonly message: string
}

/** A read of the whole chain. */
export interface ActivationChain {
  /** Valid revisions, oldest first. */
  readonly revisions: readonly ActivationRevision[]
  /** State after the last valid revision. */
  readonly activation: Activation
  /** Set when a revision file after the last valid one was rejected. */
  readonly problem?: ActivationProblem
}

/** The chain refuses a change (`session/corrupt` for a damaged chain, `config/invalid` for an invalid change). */
export class CapabilityActivationError extends NexgentError {
  constructor(code: 'session/corrupt' | 'config/invalid', message: string, details?: Record<string, unknown>) {
    super(code, message, details === undefined ? {} : { details })
    this.name = 'CapabilityActivationError'
  }
}

/** The tail before any revision. */
export const BASELINE_ACTIVATION: Activation = Object.freeze({ ...INITIAL_ACTIVATION, stack: Object.freeze([BASELINE_VERSION]) })

const REVISION_FILE = /^([1-9][0-9]*)\.json$/

function alreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'EEXIST'
}

/**
 * Publish `name` in `directory` with `content` unless the name already
 * exists. The complete, fsynced file appears under its final name at once.
 * @returns `false` when another writer owns the name.
 */
export async function publishExclusive(directory: string, name: string, content: string): Promise<boolean> {
  await mkdir(directory, { recursive: true })
  const temporary = join(directory, `.${randomUUID()}.tmp`)
  const handle = await open(temporary, 'wx', 0o600)
  try {
    try {
      await handle.writeFile(content)
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await link(temporary, join(directory, name))
    } catch (error) {
      if (alreadyExists(error)) return false
      throw error
    }
    await fsyncDirectory(directory)
    return true
  } finally {
    await unlink(temporary).catch(() => {})
  }
}

/** The parsed revision when `raw` can follow `state`, else why it cannot. */
function rejectRevision(raw: string, file: string, state: Activation): string | ActivationRevision {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return 'not JSON'
  }
  const issues = validateCapabilityFile('activationRevision', value)
  if (issues.length > 0) return `schema: ${issues[0]!.path} ${issues[0]!.message}`
  const revision = value as ActivationRevision
  if (file !== `${state.revision + 1}.json`) return 'revisions are not consecutive'
  if (!isNextRevision(state, revision)) return 'does not follow the previous revision (number, previous digest or from)'
  if (revision.type === 'adopt' && !isBundleVersion(revision.version)) return 'only a stored bundle can be adopted'
  if (revision.type === 'rollback' && revision.version !== state.stack[state.stack.length - 2]) return 'rollback does not return to the previous version'
  if (!ACTIVATION_TRIGGERS.includes(revision.trigger)) return 'unknown trigger'
  return revision
}

function advance(state: Activation, revision: ActivationRevision, raw: string): Activation {
  const stack = revision.type === 'adopt' ? [...state.stack, revision.version] : state.stack.slice(0, -1)
  return { revision: revision.revision, digest: sha256(raw), version: revision.version, stack }
}

async function revisionFiles(directory: string): Promise<string[]> {
  let names: string[]
  try {
    names = await readdir(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return []
    throw error
  }
  return names.filter(name => REVISION_FILE.test(name)).sort((left, right) => Number.parseInt(left, 10) - Number.parseInt(right, 10))
}

/**
 * Read the chain up to its last valid revision.
 * @param directory - `.nexgent/capabilities/activation`.
 */
export async function readActivationChain(directory: string): Promise<ActivationChain> {
  let state: Activation = BASELINE_ACTIVATION
  const revisions: ActivationRevision[] = []
  for (const file of await revisionFiles(directory)) {
    let raw: string
    try {
      raw = await readFile(join(directory, file), 'utf8')
    } catch (error) {
      return { revisions, activation: state, problem: { file, message: `cannot read: ${(error as Error).message}` } }
    }
    const result = rejectRevision(raw, file, state)
    if (typeof result === 'string') return { revisions, activation: state, problem: { file, message: result } }
    revisions.push(result)
    state = advance(state, result, raw)
  }
  return { revisions, activation: state }
}

/** The tail of the valid part of the chain; see {@link readActivationChain}. */
export async function readActivation(directory: string): Promise<Activation> {
  return (await readActivationChain(directory)).activation
}

/** A change to publish. A rollback's target is derived from the chain. */
export type ActivationChange = ({ readonly type: 'adopt'; readonly version: string } | { readonly type: 'rollback' }) & {
  readonly trigger: ActivationTrigger
  /** The decision record (already written or about to be) that justifies the revision. */
  readonly decisionId: string
}

/** The version a change would make current, validated against `current`. */
export function targetVersion(current: Activation, change: ActivationChange): string {
  if (change.type === 'adopt') {
    if (!isBundleVersion(change.version)) throw new CapabilityActivationError('config/invalid', `cannot adopt ${JSON.stringify(change.version)}: not a bundle version`)
    if (change.version === current.version) throw new CapabilityActivationError('config/invalid', `${change.version} is already the adopted version`)
    return change.version
  }
  const target = current.stack[current.stack.length - 2]
  if (target === undefined) throw new CapabilityActivationError('config/invalid', 'nothing to roll back: the baseline is in force')
  return target
}

/**
 * Publish one revision only if `observed` is still the tail. Does not check
 * that an adopted bundle verifies or that the decision exists; the store
 * does both.
 * @param directory - `.nexgent/capabilities/activation`.
 * @param observed - Tail read before the caller decided on this change.
 * @returns the new tail, or `null` when another writer moved the tail first.
 * @throws {@link CapabilityActivationError} for an invalid change or a damaged chain.
 */
export async function commitActivation(directory: string, observed: ActivationState, change: ActivationChange,
  now: () => Date = () => new Date()): Promise<Activation | null> {
  const chain = await readActivationChain(directory)
  if (chain.problem !== undefined) {
    throw new CapabilityActivationError('session/corrupt', `activation chain is damaged at ${chain.problem.file} (${chain.problem.message}); no revision can be added until it is repaired`, { ...chain.problem })
  }
  const current = chain.activation
  if (current.digest !== observed.digest) return null
  const record: ActivationRevision = {
    format: 1,
    revision: current.revision + 1,
    previous: current.digest,
    from: current.version,
    version: targetVersion(current, change),
    type: change.type,
    trigger: change.trigger,
    decisionId: change.decisionId,
    committedAt: now().toISOString(),
  }
  const issues = validateCapabilityFile('activationRevision', record)
  if (issues.length > 0) throw new CapabilityActivationError('config/invalid', `invalid revision: ${issues[0]!.path} ${issues[0]!.message}`)
  const raw = `${JSON.stringify(record)}\n`
  if (!(await publishExclusive(directory, `${record.revision}.json`, raw))) return null
  return advance(current, record, raw)
}
