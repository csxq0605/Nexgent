/**
 * One project's capability versions: the bundle store plus its activation
 * chain, with the rules that join them. Adopting verifies the bundle before
 * publishing the revision; {@link CapabilityStore.resolveAdopted} verifies
 * the adopted bundle before anyone loads it and, when it fails, publishes
 * `rollback` revisions until a version verifies (the baseline always does),
 * so a damaged bundle never stops the app from starting.
 */
import { join } from 'node:path'
import type { JsonObject } from '@nexgent/kernel'
import {
  ACTIVATION_DIR,
  CapabilityActivationError,
  commitActivation,
  readActivation,
  readActivationChain,
  type Activation,
  type ActivationRevision,
} from './activation.js'
import {
  CapabilityIntegrityError,
  listBundleVersions,
  loadBundle,
  writeBundle,
  type BundleComponentInput,
  type StoredBundle,
} from './store.js'

/** A load-time rollback {@link CapabilityStore.resolveAdopted} performed. */
export interface LoadRollback {
  /** Version that failed verification. */
  readonly version: string
  readonly error: CapabilityIntegrityError
  /** Tail after the rollback revision. */
  readonly activation: Activation
}

/** What {@link CapabilityStore.resolveAdopted} settled on. */
export interface ResolvedCapabilities {
  readonly activation: Activation
  readonly bundle: StoredBundle
  /** Rollbacks published by this call, oldest first; empty when the adopted version verified. */
  readonly rollbacks: readonly LoadRollback[]
}

/** Upper bound on compare-and-publish retries when other processes keep moving the tail. */
const MAX_ATTEMPTS = 32

/** Options for {@link CapabilityStore}. */
export interface CapabilityStoreOptions {
  /** Clock for revision timestamps; tests pin it. */
  readonly now?: () => Date
}

/** The capability versions of one project (`.nexgent/capabilities/`). */
export class CapabilityStore {
  /** `.nexgent/capabilities`. */
  readonly directory: string
  /** `.nexgent/capabilities/activation`. */
  readonly activationDirectory: string
  readonly #now: () => Date

  /** @param capabilitiesDir - `WorkspaceLayout.capabilities`. */
  constructor(capabilitiesDir: string, options: CapabilityStoreOptions = {}) {
    this.directory = capabilitiesDir
    this.activationDirectory = join(capabilitiesDir, ACTIVATION_DIR)
    this.#now = options.now ?? (() => new Date())
  }

  /** Store a bundle (idempotent); see {@link writeBundle}. */
  write(components: readonly BundleComponentInput[]): Promise<StoredBundle> {
    return writeBundle(this.directory, components)
  }

  /** Load and verify one version; see {@link loadBundle}. */
  load(version: string): Promise<StoredBundle> {
    return loadBundle(this.directory, version)
  }

  /** Stored bundle versions (unverified). */
  versions(): Promise<string[]> {
    return listBundleVersions(this.directory)
  }

  /** The chain's tail. */
  activation(): Promise<Activation> {
    return readActivation(this.activationDirectory)
  }

  /** Every revision, oldest first. */
  async history(): Promise<readonly ActivationRevision[]> {
    return (await readActivationChain(this.activationDirectory)).revisions
  }

  /**
   * Make a stored bundle the adopted version. The bundle is verified first.
   * @param observed - Tail the decision was based on; defaults to the tail read now.
   * @returns the new tail, or `null` when the tail moved since `observed`.
   * @throws {@link CapabilityIntegrityError} when the bundle does not verify (nothing is published).
   */
  async adopt(version: string, evidence: JsonObject, observed?: Activation): Promise<Activation | null> {
    await this.load(version)
    const base = observed ?? (await this.activation())
    return commitActivation(this.activationDirectory, base, { type: 'adopt', version }, evidence, this.#now)
  }

  /**
   * Return to the version in force before the current one.
   * @returns the new tail, or `null` when the tail moved since `observed`.
   * @throws {@link CapabilityActivationError} when the baseline is in force.
   */
  async rollback(evidence: JsonObject, observed?: Activation): Promise<Activation | null> {
    const base = observed ?? (await this.activation())
    return commitActivation(this.activationDirectory, base, { type: 'rollback' }, evidence, this.#now)
  }

  /**
   * The adopted version, verified, ready to load. A version that fails
   * verification is rolled back (trigger `load-failure`, with the reason and
   * offending path as evidence) and the previous one tried, down to the
   * baseline. When another process moves the tail meanwhile, the new tail is
   * re-read and checked again.
   * @throws {@link CapabilityActivationError} when the chain itself is corrupt.
   */
  async resolveAdopted(): Promise<ResolvedCapabilities> {
    const rollbacks: LoadRollback[] = []
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const activation = await this.activation()
      try {
        return { activation, bundle: await this.load(activation.version), rollbacks }
      } catch (error) {
        if (!(error instanceof CapabilityIntegrityError)) throw error
        const evidence: JsonObject = {
          trigger: 'load-failure',
          failedVersion: activation.version,
          reason: error.reason,
          ...(error.path === undefined ? {} : { path: error.path }),
          message: error.message,
        }
        const next = await commitActivation(this.activationDirectory, activation, { type: 'rollback' }, evidence, this.#now)
        if (next !== null) rollbacks.push({ version: activation.version, error, activation: next })
      }
    }
    throw new CapabilityActivationError(`activation tail kept moving; gave up after ${MAX_ATTEMPTS} attempts`)
  }
}
