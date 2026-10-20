/**
 * `@nexgent/capabilities`: capability versions of a project — the
 * content-addressed bundle store, load-time verification, the activation
 * chain and decision records, the session draft area, the two capability
 * tools and the loader that hands a bundle's components to the other
 * plugins.
 */
export {
  BASELINE_VERSION,
  checkComponentPath,
  checkManifest,
  EMPTY_MANIFEST,
  isBundleVersion,
  isCapabilityVersion,
  manifestVersion,
  sha256,
} from './manifest.js'
export {
  BASELINE_BUNDLE,
  buildManifest,
  CapabilityIntegrityError,
  componentDirectory,
  componentPath,
  listBundleVersions,
  loadBundle,
  readComponentFiles,
  writeBundle,
  type BundleComponentInput,
  type BundleFileInput,
  type CapabilityIntegrityReason,
  type StoredBundle,
} from './store.js'
export {
  ACTIVATION_DIR,
  BASELINE_ACTIVATION,
  CapabilityActivationError,
  commitActivation,
  publishExclusive,
  readActivation,
  readActivationChain,
  targetVersion,
  type Activation,
  type ActivationChain,
  type ActivationChange,
  type ActivationProblem,
} from './activation.js'
export { DECISIONS_DIR, listDecisions, readDecision, writeDecision, type DecisionInput } from './decisions.js'
export {
  CapabilityStore,
  type CapabilityStoreOptions,
  type CommittedChange,
  type LoadRollback,
  type ResolvedCapabilities,
  type RollbackInput,
} from './capability-store.js'
export { validateComponent, type ComponentFiles, type ComponentSpec, type ComponentValidationInput, type ComponentValidator } from './components.js'
export { applyDraft, draftDirectory, draftRoot, fileEntries, freezeDraft, readComponentDirectory, triedDirectory, type DraftChange } from './drafts.js'
export { COMPONENT_EXAMPLES, componentFormat } from './formats.js'
export { functionModuleTools, type FunctionModuleTools } from './function-tools.js'
export {
  capabilitiesOf,
  CapabilityService,
  type ActiveComponent,
  type CapabilitiesConfig,
  type CapabilityStatus,
  type ToolComponent,
  type VersionResolution,
} from './service.js'
export { capabilityDraftTool, capabilityTools, capabilityTryTool, type RecordReader } from './tools.js'
export { capabilitiesProvider } from './provider.js'
export { apply, CapabilitiesPlugin, name, type CapabilitiesPluginConfig } from './plugin.js'
export type { RelevanceGate } from './handbook/retrieval.js'
export * from './learning/index.js'
export { isTransientFsError, renameRetrying, retryTransient, RENAME_RETRY_DELAYS_MS, TRANSIENT_RENAME_CODES, transientRenameCodes, type RenameRetryOptions } from './fs-retry.js'
export { HANDBOOK_LOCK_FILE, HANDBOOK_LOG_FILE, checkHandbookOp, HandbookLog, normalizeKeywords, type HandbookOpInput } from './handbook/log.js'
export {
  Handbook,
  HANDBOOK_DUPLICATE_SIMILARITY,
  handbookProjectId,
  projectLearning,
  type HandbookApplyContext,
  type HandbookChange,
  type HandbookChangeResult,
  type HandbookOpenOptions,
  type HandbookTaskOutcome,
  type HandbookTurnHit,
  type LocatedEntry,
} from './handbook/handbook.js'
export { HANDBOOK_MIN_COVERAGE, HANDBOOK_MIN_SHARED_TERMS, HandbookIndex, type ScoredEntry } from './handbook/retrieval.js'
export { jaccard, MAX_SIMILARITY_KEYS, similarityKey, terms, termSet } from './handbook/tokens.js'
export { HANDBOOK_IDLE_DAYS, HANDBOOK_IDLE_MIN_TASKS, HANDBOOK_UNUSED_GIVEN_LIMIT, HANDBOOK_USAGE_FILE, handbookUsage, HandbookUsageLog, idleReason, type HandbookEntryUsage, type HandbookUsageInput } from './handbook/usage.js'
export { contextPolicyKey, deriveKeywords, MAX_MIGRATED_ENTRIES, migrateContextPolicies, policyPractices } from './handbook/migrate.js'
export { givenEntries, HANDBOOK_INJECT_HEADER, HANDBOOK_RULES_HEADER, HANDBOOK_TRIAL_HEADER, HandbookHost, VERSION_PRACTICES_HEADER, type HandbookHostOptions, type HandbookRecordReader } from './handbook/host.js'
export * from './organizations/library.js'
export * from './organizations/reflection.js'
export * from './organizations/model-reflection.js'
