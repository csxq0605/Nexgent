/**
 * Improver versions `.nexgent/improvers/` (`data-formats.md` §改进器版本,
 * ADR 0008 decision 1): a project-level version line of its own, adopted
 * and rolled back apart from capability bundles.
 *
 * - `bundles/<version>.json`: an improver's canonical text, written once
 *   with exclusive create and never changed or deleted. `v0` is built in
 *   and never stored; a bundle equal to `v0` by content is `v0`.
 * - `activation/<n>.json`: the revision chain, published the way the
 *   capability chain is (`activation.ts`: temporary file, hard link to the
 *   final name only while revision `n - 1` is still the tail). Its tail is
 *   the improver in force; with no revision it is `v0`.
 *
 * Reading walks the chain and stops at the first file that does not follow
 * (`isNextImproverRevision`, the schema, the file name), reporting the
 * problem and accepting no further revision until a person repairs it.
 * Loading an improver checks its schema, bounds and placeholders
 * (`assertImproverBundle`) and that its content hashes to its version; when
 * the improver in force fails, {@link ImproverStore.resolve} writes a
 * `load-failure` rollback and tries the previous one, down to `v0`, as the
 * capability store does for bundles.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  assertImproverBundle,
  canonicalImproverText,
  IMPROVER_DIRS,
  IMPROVER_LIMITS,
  IMPROVER_V0,
  IMPROVER_V0_VERSION,
  IMPROVER_VERSION_PATTERN,
  IMPROVERS_DIR,
  INITIAL_IMPROVER_ACTIVATION,
  isImproverV0,
  isNextImproverRevision,
  NexgentError,
  type ImproverActivationState,
  type ImproverBundle,
  type ImproverRevision,
  type ImproverVersion,
  type WorkspaceLayout,
} from '@nexgent/kernel'
import { validateImprovementFile } from '@nexgent/session'
import { publishExclusive } from './activation.js'
import { retryTransient } from './fs-retry.js'
import { sha256 } from './manifest.js'

/** `.nexgent/improvers` of a project. */
export function improversDir(layout: Pick<WorkspaceLayout, 'dataDir'>): string {
  return join(layout.dataDir, IMPROVERS_DIR)
}

/** The version of an improver: `v0` when it equals the built-in one by content, else the SHA-256 of its canonical text. */
export function improverVersionOf(bundle: ImproverBundle): ImproverVersion {
  return isImproverV0(bundle) ? IMPROVER_V0_VERSION : sha256(canonicalImproverText(bundle))
}

/** The chain's tail plus what a rollback without a target returns to. */
export interface ImproverActivation extends ImproverActivationState {
  /**
   * Improvers in force, oldest first, ending with the current one: `v0`,
   * then each adoption not rolled back since. A rollback returns to the
   * entry before the last (without a target) or truncates to its target; a
   * target rolled away from earlier, no longer on the stack, is pushed.
   */
  readonly stack: readonly ImproverVersion[]
}

/** A read of the whole improver chain. */
export interface ImproverChain {
  /** Valid revisions, oldest first. */
  readonly revisions: readonly ImproverRevision[]
  /** State after the last valid revision. */
  readonly activation: ImproverActivation
  /** Set when a file after the last valid revision was rejected. */
  readonly problem?: { readonly file: string; readonly message: string }
}

/** A committed revision. */
export interface ImproverCommit {
  readonly revision: ImproverRevision
  readonly activation: ImproverActivation
}

/** A `load-failure` rollback written while resolving the improver in force. */
export interface ImproverLoadRollback {
  /** The improver that failed. */
  readonly version: ImproverVersion
  readonly error: NexgentError
  readonly revision: ImproverRevision
}

/** The improver in force, loaded. */
export interface ResolvedImprover {
  readonly activation: ImproverActivation
  readonly version: ImproverVersion
  readonly bundle: ImproverBundle
  /** Rollbacks written because the improver in force failed to load, oldest first. */
  readonly rollbacks: readonly ImproverLoadRollback[]
  /** The chain is damaged: nothing was written, the last valid revision is in force. */
  readonly problem?: ImproverChain['problem']
  /** Set when the improver the damaged chain names failed to load and `v0` is used without a revision. */
  readonly fallback?: { readonly version: ImproverVersion; readonly error: NexgentError }
}

/** The tail before any revision. */
export const V0_IMPROVER_ACTIVATION: ImproverActivation = Object.freeze({ ...INITIAL_IMPROVER_ACTIVATION, stack: Object.freeze([IMPROVER_V0_VERSION]) })

const REVISION_FILE = /^([1-9][0-9]*)\.json$/
const MAX_ATTEMPTS = 16

function notFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

function clip(text: string): string {
  return text.length > IMPROVER_LIMITS.maxReasonChars ? `${text.slice(0, IMPROVER_LIMITS.maxReasonChars - 1)}…` : text
}

function advance(state: ImproverActivation, revision: ImproverRevision, raw: string): ImproverActivation {
  let stack: ImproverVersion[]
  if (revision.type === 'adopt') {
    stack = [...state.stack, revision.version]
  } else {
    const at = state.stack.slice(0, -1).lastIndexOf(revision.version)
    stack = at >= 0 ? state.stack.slice(0, at + 1) : [...state.stack, revision.version]
  }
  return { revision: revision.revision, digest: sha256(raw), version: revision.version, stack }
}

/** The parsed revision when `raw` can follow `state`, else why it cannot. */
function rejectRevision(raw: string, file: string, state: ImproverActivation, seen: ReadonlySet<ImproverVersion>): string | ImproverRevision {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return 'not JSON'
  }
  const issues = validateImprovementFile('improverRevision', value)
  if (issues.length > 0) return `schema: ${issues[0]!.path} ${issues[0]!.message}`
  const revision = value as ImproverRevision
  if (file !== `${state.revision + 1}.json`) return 'revisions are not consecutive'
  if (!isNextImproverRevision(state, revision)) return 'does not follow the previous revision (number, previous digest, from, version or trigger)'
  if (revision.type === 'rollback' && !seen.has(revision.version)) return 'a rollback can only return to an improver that was in force earlier'
  return revision
}

/**
 * The improver version line of one project.
 * @param directory - `.nexgent/improvers` ({@link improversDir}).
 */
export class ImproverStore {
  readonly directory: string
  readonly bundlesDirectory: string
  readonly activationDirectory: string
  readonly #now: () => Date

  constructor(directory: string, options: { readonly now?: () => Date } = {}) {
    this.directory = directory
    this.bundlesDirectory = join(directory, IMPROVER_DIRS.bundles)
    this.activationDirectory = join(directory, IMPROVER_DIRS.activation)
    this.#now = options.now ?? (() => new Date())
  }

  /**
   * Store an improver (`v0` is never written). The same content always gives
   * the same version; an existing file is left as it is.
   * @throws `improver/invalid` for a bundle that breaks the schema or the bounds.
   */
  async write(bundle: ImproverBundle): Promise<{ readonly version: ImproverVersion; readonly created: boolean }> {
    assertImproverBundle(bundle)
    const issues = validateImprovementFile('improver', bundle)
    if (issues.length > 0) throw new NexgentError('improver/invalid', `improver: ${issues[0]!.path} ${issues[0]!.message}`)
    const version = improverVersionOf(bundle)
    if (version === IMPROVER_V0_VERSION) return { version, created: false }
    const created = await retryTransient(() => publishExclusive(this.bundlesDirectory, `${version}.json`, canonicalImproverText(bundle)))
    return { version, created }
  }

  /**
   * Load and check one improver.
   * @throws `improver/not-found` when it is not stored; `improver/invalid` when it does not parse, validate or match its version.
   */
  async load(version: ImproverVersion): Promise<ImproverBundle> {
    if (version === IMPROVER_V0_VERSION) return IMPROVER_V0
    if (!IMPROVER_VERSION_PATTERN.test(version)) throw new NexgentError('improver/not-found', `no improver ${JSON.stringify(version)}`)
    const path = join(this.bundlesDirectory, `${version}.json`)
    let raw: string
    try {
      raw = await retryTransient(() => readFile(path, 'utf8'))
    } catch (error) {
      if (notFound(error)) throw new NexgentError('improver/not-found', `no improver ${version}`, { details: { version } })
      throw error
    }
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch (error) {
      throw new NexgentError('improver/invalid', `improver ${version} is not JSON`, { cause: error, details: { version } })
    }
    const issues = validateImprovementFile('improver', value)
    if (issues.length > 0) throw new NexgentError('improver/invalid', `improver ${version}: ${issues[0]!.path} ${issues[0]!.message}`, { details: { version } })
    assertImproverBundle(value)
    if (improverVersionOf(value) !== version) throw new NexgentError('improver/invalid', `improver ${version}: its content does not match its version`, { details: { version } })
    return value
  }

  /** Stored versions (unchecked), sorted; `v0` is not among them. */
  async versions(): Promise<ImproverVersion[]> {
    let names: string[]
    try {
      names = await readdir(this.bundlesDirectory)
    } catch (error) {
      if (notFound(error)) return []
      throw error
    }
    return names.filter(name => /^[a-f0-9]{64}\.json$/.test(name)).map(name => name.slice(0, -5)).sort()
  }

  /** The whole chain, up to its last valid revision. */
  async chain(): Promise<ImproverChain> {
    let files: string[]
    try {
      files = (await readdir(this.activationDirectory)).filter(name => REVISION_FILE.test(name))
    } catch (error) {
      if (notFound(error)) files = []
      else throw error
    }
    files.sort((left, right) => Number.parseInt(left, 10) - Number.parseInt(right, 10))
    let state = V0_IMPROVER_ACTIVATION
    const seen = new Set<ImproverVersion>([IMPROVER_V0_VERSION])
    const revisions: ImproverRevision[] = []
    for (const file of files) {
      let raw: string
      try {
        raw = await retryTransient(() => readFile(join(this.activationDirectory, file), 'utf8'))
      } catch (error) {
        return { revisions, activation: state, problem: { file, message: `cannot read: ${(error as Error).message}` } }
      }
      const result = rejectRevision(raw, file, state, seen)
      if (typeof result === 'string') return { revisions, activation: state, problem: { file, message: result } }
      revisions.push(result)
      seen.add(result.version)
      state = advance(state, result, raw)
    }
    return { revisions, activation: state }
  }

  /** The tail of the valid part of the chain. */
  async activation(): Promise<ImproverActivation> {
    return (await this.chain()).activation
  }

  /**
   * Make a stored improver the one in force (a meta job's comparison adopted it).
   * @param observed - Tail the decision was based on; defaults to the tail read now.
   * @returns the revision, or `null` when another writer moved the tail since `observed`.
   * @throws `improver/not-found` / `improver/invalid` when it does not load; `improver/activation` for a damaged chain or when it is already in force.
   */
  async adopt(version: ImproverVersion, input: { readonly jobId: string }, observed?: ImproverActivation): Promise<ImproverCommit | null> {
    await this.load(version)
    return this.#commit(observed, current => {
      if (version === current.version) throw new NexgentError('improver/activation', `improver ${version} is already in force`)
      return { type: 'adopt', version, trigger: 'meta-job', jobId: input.jobId }
    })
  }

  /**
   * Return to an earlier improver: without `toVersion`, the one in force before
   * the current adoption; with it, any improver that was in force earlier
   * (`v0` included). Writes a new revision; nothing is deleted.
   * @returns the revision, or `null` when another writer moved the tail since `observed`.
   * @throws `improver/activation` when there is nothing to roll back to, the target was never in force, or the chain is damaged; `improver/not-found` / `improver/invalid` when the target does not load.
   */
  async rollback(input: { readonly trigger: 'manual' | 'load-failure'; readonly toVersion?: ImproverVersion; readonly reason?: string }, observed?: ImproverActivation): Promise<ImproverCommit | null> {
    const base = observed ?? (await this.activation())
    const target = input.toVersion ?? base.stack[base.stack.length - 2]
    if (target === undefined) throw new NexgentError('improver/activation', 'nothing to roll back: v0 is in force')
    if (target === base.version) throw new NexgentError('improver/activation', `improver ${target} is already in force`)
    if (input.toVersion !== undefined && input.toVersion !== IMPROVER_V0_VERSION) {
      const chain = await this.chain()
      if (!chain.revisions.some(revision => revision.version === input.toVersion)) throw new NexgentError('improver/activation', `improver ${input.toVersion} was never in force; only an earlier improver can be rolled back to`)
    }
    if (input.trigger === 'manual') await this.load(target)
    return this.#commit(base, () => ({
      type: 'rollback',
      version: target,
      trigger: input.trigger,
      ...(input.reason === undefined || input.reason === '' ? {} : { reason: clip(input.reason) }),
    }))
  }

  /**
   * The improver in force, loaded. One that fails to load is rolled back
   * (`load-failure`, the problem in `reason`) and the previous one tried,
   * down to `v0`. A damaged chain is reported in `problem` and not written to.
   */
  async resolve(): Promise<ResolvedImprover> {
    const rollbacks: ImproverLoadRollback[] = []
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const { activation, problem } = await this.chain()
      try {
        const bundle = await this.load(activation.version)
        return { activation, version: activation.version, bundle, rollbacks, ...(problem === undefined ? {} : { problem }) }
      } catch (error) {
        if (!(error instanceof NexgentError) || (error.code !== 'improver/not-found' && error.code !== 'improver/invalid')) throw error
        if (problem !== undefined) {
          return { activation, version: IMPROVER_V0_VERSION, bundle: IMPROVER_V0, rollbacks, problem, fallback: { version: activation.version, error } }
        }
        const committed = await this.rollback({ trigger: 'load-failure', reason: `${activation.version}: ${error.message}` }, activation)
        if (committed !== null) rollbacks.push({ version: activation.version, error, revision: committed.revision })
      }
    }
    throw new NexgentError('improver/activation', `improver chain kept moving; gave up after ${MAX_ATTEMPTS} attempts`)
  }

  async #commit(observed: ImproverActivation | undefined, change: (current: ImproverActivation) => Omit<ImproverRevision, 'format' | 'revision' | 'previous' | 'from' | 'committedAt'>): Promise<ImproverCommit | null> {
    const chain = await this.chain()
    if (chain.problem !== undefined) {
      throw new NexgentError('improver/activation', `improver chain is damaged at ${chain.problem.file} (${chain.problem.message}); no revision can be added until it is repaired`, { details: { ...chain.problem } })
    }
    const current = chain.activation
    if (observed !== undefined && observed.digest !== current.digest) return null
    const revision: ImproverRevision = {
      format: 1,
      revision: current.revision + 1,
      previous: current.digest,
      from: current.version,
      ...change(current),
      committedAt: this.#now().toISOString(),
    }
    const issues = validateImprovementFile('improverRevision', revision)
    if (issues.length > 0 || !isNextImproverRevision(current, revision)) {
      throw new NexgentError('improver/activation', `invalid improver revision${issues.length > 0 ? `: ${issues[0]!.path} ${issues[0]!.message}` : ''}`)
    }
    const raw = `${JSON.stringify(revision)}\n`
    if (!(await retryTransient(() => publishExclusive(this.activationDirectory, `${revision.revision}.json`, raw)))) return null
    return { revision, activation: advance(current, revision, raw) }
  }
}
