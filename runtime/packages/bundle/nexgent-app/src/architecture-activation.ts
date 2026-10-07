/** Immutable activation revisions and bounded, non-replayable output-selection attempts. */
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Snapshot used for compare-and-publish; revision zero is the frozen baseline. */
export interface Activation {
  /** Last committed revision, or zero before any adoption. */
  revision: number
  /** Digest of that revision, or null for the baseline. */
  digest: string | null
  /** Definition selected for subsequent output-only execution. */
  version: string
  /** Exact approved compiled script digest; null only for revision zero. */
  compiledDigest: string | null
}

function hash(value: string): string { return createHash('sha256').update(value).digest('hex') }
function exists(error: unknown): boolean { return error instanceof Error && 'code' in error && error.code === 'EEXIST' }
function publish(directory: string, name: string, value: object): boolean {
  mkdirSync(directory, { recursive: true })
  const temporary = join(directory, `.${randomUUID()}.tmp`)
  const file = openSync(temporary, 'wx', 0o600)
  try {
    try {
      writeFileSync(file, JSON.stringify(value) + '\n')
      fsyncSync(file)
    } finally { closeSync(file) }
    try { linkSync(temporary, join(directory, name)); return true }
    catch (error: unknown) { if (exists(error)) return false; throw error }
  } finally { unlinkSync(temporary) }
}

/**
 * Read the complete committed chain; malformed, missing or divergent revisions reject execution.
 * @param directory - Private directory for one frozen policy digest.
 * @param baseline - Frozen baseline definition digest.
 * @returns the last committed activation, never a fallback for corrupt storage.
 */
export function readActivation(directory: string, baseline: string): Activation {
  mkdirSync(directory, { recursive: true })
  const files = readdirSync(directory).filter(file => /^\d+\.json$/.test(file)).sort((a, b) => Number.parseInt(a) - Number.parseInt(b))
  let state: Activation = { revision: 0, digest: null, version: baseline, compiledDigest: null }
  for (const file of files) {
    const raw = readFileSync(join(directory, file), 'utf8')
    const value: unknown = JSON.parse(raw)
    if (value === null || typeof value !== 'object' || Array.isArray(value)
      || !('format' in value) || value.format !== 1 || !('revision' in value) || value.revision !== state.revision + 1
      || file !== `${value.revision}.json` || !('previous' in value) || value.previous !== state.digest
      || !('from' in value) || value.from !== state.version || !('version' in value) || typeof value.version !== 'string'
      || !/^[a-f0-9]{64}$/.test(value.version) || !('type' in value) || !['adopt', 'rollback'].includes(String(value.type))) {
      throw new Error('invalid architecture activation chain')
    }
    if (!('compiledDigest' in value) || typeof value.compiledDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.compiledDigest)) {
      throw new Error('invalid approved architecture compilation')
    }
    state = { revision: value.revision, digest: hash(raw), version: value.version, compiledDigest: value.compiledDigest }
  }
  return state
}

/**
 * Publish a synchronized immutable revision only if the observed revision remains current.
 * @param directory - Private directory for one frozen policy digest.
 * @param baseline - Frozen baseline definition digest.
 * @param observed - Version snapshot taken before the owned operation started.
 * @param version - New active definition digest.
 * @param type - Adoption or rollback decision.
 * @param evidence - Host decision evidence, including native trial or task identity.
 * @param compiledDigest - Approved output-only compiled script digest; definition identity alone is insufficient.
 * @returns the committed snapshot, or null when another operation changed the active revision.
 */
export function commitActivation(directory: string, baseline: string, observed: Activation, version: string,
  type: 'adopt' | 'rollback', evidence: Record<string, unknown>, compiledDigest: string): Activation | null {
  const current = readActivation(directory, baseline)
  if (current.digest !== observed.digest) return null
  const record = { format: 1, revision: current.revision + 1, previous: current.digest, from: current.version,
    version, type, evidence, compiledDigest, committedAt: Date.now() }
  if (!publish(directory, `${record.revision}.json`, record)) return null
  return { revision: record.revision, version, digest: hash(JSON.stringify(record) + '\n'), compiledDigest }
}

/**
 * Consume one policy slot and reserve a candidate once across processes, before any evaluation.
 * @param directory - Private directory for one frozen policy digest.
 * @param candidate - Candidate definition digest; repeated candidates are never resampled.
 * @param maximum - Frozen maximum number of selection attempts, including unknown and crashed attempts.
 * @returns the attempt directory for terminal host receipts; throws for repetition or exhausted slots.
 */
export function reserveSelection(directory: string, candidate: string, maximum: number): string {
  const attempts = join(directory, 'attempts')
  if (!publish(attempts, `${candidate}.json`, { format: 1, candidate, startedAt: Date.now() })) {
    throw new Error('architecture candidate already attempted; unknown and interrupted attempts cannot replay')
  }
  for (let slot = 1; slot <= maximum; slot++) {
    if (publish(join(attempts, 'slots'), `${slot}.json`, { format: 1, candidate })) return attempts
  }
  throw new Error('architecture selection budget exhausted')
}

/**
 * Persist one complete host decision; storage failure cannot be returned as a successful decision.
 * @param directory - Attempt directory returned by reservation.
 * @param candidate - Reserved candidate definition digest.
 * @param result - Terminal decision, including any committed activation identity.
 */
export function finishSelection(directory: string, candidate: string, result: object): void {
  if (!publish(directory, `${candidate}.result.json`, result)) throw new Error('architecture selection already settled')
}
