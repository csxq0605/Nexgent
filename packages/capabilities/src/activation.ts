// Adapted from Nexgent PR #4 runtime/packages/bundle/nexgent-app/src/architecture-activation.ts (archive/python-host)
/**
 * The activation chain `.nexgent/capabilities/activation/<n>.json`: an
 * append-only list of immutable revisions, each either `adopt` (make a
 * stored bundle current) or `rollback` (return to the version that was
 * current before the last adoption still in force). The adopted version is
 * the chain's tail; revision zero is the baseline.
 *
 * Every revision names the digest of the raw previous revision, the version
 * it replaces and the new version, so the chain is re-validated in full on
 * every read and a missing, malformed or divergent revision rejects it
 * rather than falling back. A revision is published with exclusive-create
 * semantics (temporary file, fsync, hard link to `<n>.json`, which fails if
 * the name exists) and only when the caller's observed tail is still the
 * tail (compare-and-publish), so of two processes publishing the same
 * revision number exactly one succeeds.
 *
 * Changes from PR #4: one chain per project instead of one per frozen
 * policy digest; versions may be `baseline`; no compiled-script digest (the
 * bundle version already covers every file); rollback targets are derived
 * from the chain and checked on read; ISO timestamps; async I/O; selection
 * reservations moved to the gate (W3).
 */
import { randomUUID } from 'node:crypto'
import { link, mkdir, open, readdir, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { fsyncDirectory, isJsonValue, type JsonObject } from '@nexgent/kernel'
import { BASELINE_VERSION, isBundleVersion, isCapabilityVersion, sha256 } from './manifest.js'

/** Directory name of the chain inside `.nexgent/capabilities/`. */
export const ACTIVATION_DIR = 'activation'

/** Revision format written by this package. */
export const ACTIVATION_FORMAT = 1

/** Kind of change a revision makes. */
export type ActivationType = 'adopt' | 'rollback'

/** One `<n>.json` file. */
export interface ActivationRevision {
  readonly format: typeof ACTIVATION_FORMAT
  /** 1-based; equals the file name. */
  readonly revision: number
  /** SHA-256 of the raw bytes of revision `n - 1`, `null` for revision 1. */
  readonly previous: string | null
  /** Version current before this revision. */
  readonly from: string
  /** Version current after this revision. */
  readonly version: string
  readonly type: ActivationType
  /** Why: candidate, trial or decision ids, rollback trigger and its evidence. */
  readonly evidence: JsonObject
  /** ISO 8601. */
  readonly committedAt: string
}

/** The chain's tail: what compare-and-publish compares. */
export interface Activation {
  /** Last committed revision, 0 before any. */
  readonly revision: number
  /** SHA-256 of that revision's raw bytes, `null` at revision 0. */
  readonly digest: string | null
  /** Adopted version (`baseline` at revision 0). */
  readonly version: string
  /**
   * Versions in force, oldest first, ending with {@link version}: `baseline`,
   * then each adoption not yet rolled back. A rollback returns to the entry
   * before the last.
   */
  readonly stack: readonly string[]
}

/** The chain on disk breaks the format or its invariants. */
export class CapabilityActivationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'CapabilityActivationError'
  }
}

/** The tail before any revision. */
export const BASELINE_ACTIVATION: Activation = Object.freeze({
  revision: 0,
  digest: null,
  version: BASELINE_VERSION,
  stack: Object.freeze([BASELINE_VERSION]),
})

const REVISION_FILE = /^([1-9][0-9]*)\.json$/
const KEYS = ['format', 'revision', 'previous', 'from', 'version', 'type', 'evidence', 'committedAt']

function alreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'EEXIST'
}

/**
 * Publish `name` in `directory` with `content` unless the name already
 * exists. The complete, fsynced file appears under its final name at once.
 * @returns `false` when another writer owns the name.
 */
async function publishExclusive(directory: string, name: string, content: string): Promise<boolean> {
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

function parseRevision(raw: string, file: string, state: Activation): ActivationRevision {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (error) {
    throw new CapabilityActivationError(`activation ${file} is not JSON`, { cause: error })
  }
  const invalid = (why: string): never => {
    throw new CapabilityActivationError(`invalid activation chain at ${file}: ${why}`)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid('not an object')
  const record = value as Record<string, unknown>
  if (Object.keys(record).some(key => !KEYS.includes(key))) invalid('unknown fields')
  if (record.format !== ACTIVATION_FORMAT) invalid('unsupported format')
  if (record.revision !== state.revision + 1 || file !== `${state.revision + 1}.json`) invalid('revisions are not consecutive')
  if (record.previous !== state.digest) invalid('previous digest does not match')
  if (record.from !== state.version) invalid('from does not match the current version')
  if (!isCapabilityVersion(record.version)) invalid('version is neither a bundle version nor baseline')
  if (record.type === 'adopt') {
    if (!isBundleVersion(record.version)) invalid('only a stored bundle can be adopted')
    if (record.version === state.version) invalid('adopts the version already in force')
  } else if (record.type === 'rollback') {
    if (state.stack.length < 2) invalid('rollback with nothing to roll back')
    if (record.version !== state.stack[state.stack.length - 2]) invalid('rollback does not return to the previous version')
  } else {
    invalid('type must be adopt or rollback')
  }
  const evidence = record.evidence
  if (evidence === null || typeof evidence !== 'object' || Array.isArray(evidence) || !isJsonValue(evidence)) invalid('evidence must be a JSON object')
  if (typeof record.committedAt !== 'string' || Number.isNaN(Date.parse(record.committedAt))) invalid('committedAt must be an ISO timestamp')
  return record as unknown as ActivationRevision
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
 * Read and validate the whole chain.
 * @param directory - `.nexgent/capabilities/activation`.
 * @returns every revision in order and the resulting tail.
 * @throws {@link CapabilityActivationError} for a malformed, missing or divergent revision; never a fallback.
 */
export async function readActivationChain(directory: string): Promise<{ readonly revisions: readonly ActivationRevision[]; readonly activation: Activation }> {
  let state: Activation = BASELINE_ACTIVATION
  const revisions: ActivationRevision[] = []
  for (const file of await revisionFiles(directory)) {
    const raw = await readFile(join(directory, file), 'utf8')
    const revision = parseRevision(raw, file, state)
    revisions.push(revision)
    state = advance(state, revision, raw)
  }
  return { revisions, activation: state }
}

/** The chain's tail; see {@link readActivationChain}. */
export async function readActivation(directory: string): Promise<Activation> {
  return (await readActivationChain(directory)).activation
}

/** A change to publish. A rollback's target is derived from the chain. */
export type ActivationChange =
  | { readonly type: 'adopt'; readonly version: string }
  | { readonly type: 'rollback' }

/**
 * Publish one revision only if `observed` is still the tail. Does not check
 * that an adopted bundle exists or verifies; the store does that first.
 * @param directory - `.nexgent/capabilities/activation`.
 * @param observed - Tail read before the caller decided on this change.
 * @param change - Adoption of a bundle version, or rollback to the previous version.
 * @param evidence - JSON object recorded with the revision.
 * @returns the new tail, or `null` when another writer moved the tail first.
 * @throws {@link CapabilityActivationError} for an invalid change (nothing to roll back, not a bundle version).
 */
export async function commitActivation(directory: string, observed: Activation, change: ActivationChange,
  evidence: JsonObject, now: () => Date = () => new Date()): Promise<Activation | null> {
  if (!isJsonValue(evidence) || evidence === null || typeof evidence !== 'object' || Array.isArray(evidence)) {
    throw new CapabilityActivationError('evidence must be a JSON object')
  }
  const current = await readActivation(directory)
  if (current.digest !== observed.digest) return null
  let version: string
  if (change.type === 'adopt') {
    if (!isBundleVersion(change.version)) throw new CapabilityActivationError(`cannot adopt ${JSON.stringify(change.version)}: not a bundle version`)
    if (change.version === current.version) throw new CapabilityActivationError(`${change.version} is already the adopted version`)
    version = change.version
  } else {
    const target = current.stack[current.stack.length - 2]
    if (target === undefined) throw new CapabilityActivationError('nothing to roll back: the baseline is in force')
    version = target
  }
  const record: ActivationRevision = {
    format: ACTIVATION_FORMAT,
    revision: current.revision + 1,
    previous: current.digest,
    from: current.version,
    version,
    type: change.type,
    evidence,
    committedAt: now().toISOString(),
  }
  const raw = `${JSON.stringify(record)}\n`
  if (!(await publishExclusive(directory, `${record.revision}.json`, raw))) return null
  return advance(current, record, raw)
}
