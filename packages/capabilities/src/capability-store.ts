/**
 * One project's capability versions: the bundle store, the activation chain
 * and the decision records, with the rules that join them. Every revision
 * is preceded by its decision (written first, so a revision never names a
 * missing decision); adopting verifies the bundle first;
 * {@link CapabilityStore.resolveAdopted} verifies the adopted bundle before
 * anyone loads it and, when it fails, rolls back (`load-failure`) until a
 * version verifies (the baseline always does), so a damaged bundle never
 * stops the app from starting.
 */
import { join } from 'node:path'
import type {
  ActivationRevision,
  ActivationTrigger,
  CapabilityDecision,
  DecisionReason,
  TrialCost,
  TrialVerdict,
  UsageRegressionEvidence,
} from '@nexgent/kernel'
import {
  ACTIVATION_DIR,
  commitActivation,
  readActivationChain,
  targetVersion,
  type Activation,
  type ActivationChain,
  type ActivationProblem,
} from './activation.js'
import { buildDecision, DECISIONS_DIR, listDecisions, publishDecision, readDecision, writeDecision, type DecisionInput } from './decisions.js'
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
  readonly decision: CapabilityDecision
  /** Tail after the rollback revision. */
  readonly activation: Activation
}

/** What {@link CapabilityStore.resolveAdopted} settled on. */
export interface ResolvedCapabilities {
  readonly activation: Activation
  readonly bundle: StoredBundle
  /** Rollbacks published by this call, oldest first; empty when the adopted version verified. */
  readonly rollbacks: readonly LoadRollback[]
  /**
   * The chain is damaged after `activation`: the app runs on the last valid
   * revision, and no revision (adoption or rollback) can be added until a
   * person repairs the file named here. Surface it to the user.
   */
  readonly problem?: ActivationProblem
  /**
   * Set when the chain is damaged and the last valid version also failed
   * verification: the session runs on the baseline without a revision.
   */
  readonly fallback?: { readonly version: string; readonly error: CapabilityIntegrityError }
}

/** Options for {@link CapabilityStore}. */
export interface CapabilityStoreOptions {
  /** Clock for revisions and decisions; tests pin it. */
  readonly now?: () => Date
  /** Called after each decision is written (the plugin appends the ledger's `capability.decision`). */
  readonly onDecision?: (decision: CapabilityDecision) => Promise<void> | void
}

/** What an adoption records. */
export interface AdoptInput {
  readonly trigger: Extract<ActivationTrigger, 'gate' | 'approval' | 'manual'>
  /** Default `manual`. */
  readonly reason?: DecisionReason
  /** Default: a sentence naming the trigger. */
  readonly detail?: string
  readonly candidateId?: string
  readonly trialId?: string
  readonly verdict?: TrialVerdict
  readonly cost?: { readonly candidate: TrialCost; readonly baseline: TrialCost; readonly review: TrialCost }
}

/** What a rollback records. */
export interface RollbackInput {
  readonly trigger: Extract<ActivationTrigger, 'load-failure' | 'usage-regression' | 'manual'>
  /** Default `manual`. */
  readonly reason?: DecisionReason
  /** Default: a sentence naming the trigger. */
  readonly detail?: string
  readonly candidateId?: string
  readonly regression?: UsageRegressionEvidence
}

/** A published change: the decision and the resulting tail. */
export interface CommittedChange {
  readonly decision: CapabilityDecision
  readonly activation: Activation
}

/** Upper bound on compare-and-publish retries when other processes keep moving the tail. */
const MAX_ATTEMPTS = 32

/** The capability versions of one project (`.nexgent/capabilities/`). */
export class CapabilityStore {
  /** `.nexgent/capabilities`. */
  readonly directory: string
  /** `.nexgent/capabilities/activation`. */
  readonly activationDirectory: string
  /** `.nexgent/capabilities/decisions`. */
  readonly decisionsDirectory: string
  readonly #now: () => Date
  readonly #onDecision: CapabilityStoreOptions['onDecision']

  /** @param capabilitiesDir - `WorkspaceLayout.capabilities`. */
  constructor(capabilitiesDir: string, options: CapabilityStoreOptions = {}) {
    this.directory = capabilitiesDir
    this.activationDirectory = join(capabilitiesDir, ACTIVATION_DIR)
    this.decisionsDirectory = join(capabilitiesDir, DECISIONS_DIR)
    this.#now = options.now ?? (() => new Date())
    this.#onDecision = options.onDecision
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

  /** The whole chain, with any problem. */
  chain(): Promise<ActivationChain> {
    return readActivationChain(this.activationDirectory)
  }

  /** The tail of the valid part of the chain. */
  async activation(): Promise<Activation> {
    return (await this.chain()).activation
  }

  /** Valid revisions, oldest first. */
  async history(): Promise<readonly ActivationRevision[]> {
    return (await this.chain()).revisions
  }

  /** One decision; see {@link readDecision}. */
  decision(id: string): Promise<CapabilityDecision> {
    return readDecision(this.decisionsDirectory, id)
  }

  /** Every decision, oldest first. */
  decisions(): Promise<CapabilityDecision[]> {
    return listDecisions(this.decisionsDirectory)
  }

  /** Write a decision that publishes no revision (rejected, awaiting approval). */
  async recordDecision(input: DecisionInput): Promise<CapabilityDecision> {
    const decision = await writeDecision(this.decisionsDirectory, input, this.#now)
    await this.#onDecision?.(decision)
    return decision
  }

  /**
   * Make a stored bundle the adopted version: verify it, commit the revision,
   * then write the `adopted` decision it names.
   * @param observed - Tail the decision was based on; defaults to the tail read now.
   * @returns the change, or `null` when the tail moved since `observed` (nothing is written; the caller records what it concludes instead).
   * @throws `session/corrupt` when the bundle does not verify or the chain is damaged; `config/invalid` for a pointless change.
   */
  async adopt(version: string, input: AdoptInput, observed?: Activation): Promise<CommittedChange | null> {
    await this.load(version)
    const base = observed ?? (await this.activation())
    return this.#commit(base, { type: 'adopt', version }, { ...input, outcome: 'adopted' })
  }

  /**
   * Return to the version in force before the current one: commit the
   * revision, then write the `rolled-back` decision it names.
   * @returns the change, or `null` when the tail moved since `observed`.
   * @throws `config/invalid` when the baseline is in force; `session/corrupt` when the chain is damaged.
   */
  async rollback(input: RollbackInput, observed?: Activation): Promise<CommittedChange | null> {
    const base = observed ?? (await this.activation())
    return this.#commit(base, { type: 'rollback' }, { ...input, outcome: 'rolled-back' })
  }

  async #commit(base: Activation, change: { type: 'adopt'; version: string } | { type: 'rollback' },
    input: (AdoptInput | RollbackInput) & { outcome: 'adopted' | 'rolled-back' }): Promise<CommittedChange | null> {
    const toVersion = targetVersion(base, { ...change, trigger: input.trigger, decisionId: '' })
    // Validate the decision before the revision so a refused one changes nothing; publish it only once the revision is in.
    const decision = buildDecision({
      ...input,
      reason: input.reason ?? 'manual',
      detail: input.detail ?? `${change.type === 'adopt' ? 'adopted' : 'rolled back'} (${input.trigger})`,
      fromVersion: base.version,
      toVersion,
      revision: base.revision + 1,
    }, this.#now)
    const activation = await commitActivation(this.activationDirectory, base, { ...change, trigger: input.trigger, decisionId: decision.id }, this.#now)
    if (activation === null) return null
    await publishDecision(this.decisionsDirectory, decision)
    await this.#onDecision?.(decision)
    return { decision, activation }
  }

  /**
   * The adopted version, verified, ready to load. A version that fails
   * verification is rolled back (`load-failure`, with the reason and path in
   * the decision's detail) and the previous one tried, down to the baseline.
   * When another process moves the tail meanwhile, the new tail is re-read.
   * A damaged chain is reported in `problem` and not written to.
   */
  async resolveAdopted(): Promise<ResolvedCapabilities> {
    const rollbacks: LoadRollback[] = []
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const { activation, problem } = await this.chain()
      try {
        const bundle = await this.load(activation.version)
        return { activation, bundle, rollbacks, ...(problem === undefined ? {} : { problem }) }
      } catch (error) {
        if (!(error instanceof CapabilityIntegrityError)) throw error
        if (problem !== undefined) {
          return { activation, bundle: await this.load('baseline'), rollbacks, problem, fallback: { version: activation.version, error } }
        }
        const committed = await this.rollback({
          trigger: 'load-failure',
          reason: 'load-failure',
          detail: `${error.reason}${error.path === undefined ? '' : ` at ${error.path}`}: ${error.message}`,
        }, activation)
        if (committed !== null) rollbacks.push({ version: activation.version, error, decision: committed.decision, activation: committed.activation })
      }
    }
    throw new CapabilityIntegrityError('unknown', 'missing', `activation tail kept moving; gave up after ${MAX_ATTEMPTS} attempts`)
  }
}
