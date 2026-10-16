/**
 * `@nexgent/capabilities`: capability versions of a project — the
 * content-addressed bundle store, load-time verification, the activation
 * chain and decision records, the session draft area, the three capability
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
  type AdoptInput,
  type CapabilityStoreOptions,
  type CommittedChange,
  type LoadRollback,
  type ResolvedCapabilities,
  type RollbackInput,
} from './capability-store.js'
export { validateComponent, type ComponentFiles, type ComponentSpec, type ComponentValidationInput, type ComponentValidator } from './components.js'
export { applyDraft, draftDirectory, draftRoot, fileEntries, freezeDraft, readComponentDirectory, triedDirectory, type DraftChange } from './drafts.js'
export { CANDIDATE_FILE, CANDIDATES_DIR, listCandidates, readCandidate, writeCandidate, type CandidateInput, type ProposedComponent } from './candidates.js'
export { COMPONENT_EXAMPLES, componentFormat } from './formats.js'
export { findUseProof, latestTry } from './proofs.js'
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
export { capabilityDraftTool, capabilityProposeTool, capabilityTools, capabilityTryTool, type CapabilityToolsOptions, type RecordReader } from './tools.js'
export { capabilitiesProvider } from './provider.js'
export { apply, CapabilitiesPlugin, name, type CapabilitiesPluginConfig } from './plugin.js'
export * from './trial/index.js'
export * from './learning/index.js'
export { checkJobLiterals, componentLiteralTexts, taskLiteralSources, findJobLayout, instanceLiteralText, jobLiteralSources, layoutOfSessionsDir, MAX_LITERAL_TEXT_BYTES, projectTaskMessages, type LiteralCheckComponent } from './instance-literals.js'
export {
  improversDir,
  improverVersionOf,
  ImproverStore,
  userImproversDir,
  type ImproverStoreOptions,
  V0_IMPROVER_ACTIVATION,
  type ImproverActivation,
  type ImproverChain,
  type ImproverCommit,
  type ImproverLoadRollback,
  type ResolvedImprover,
} from './improvers.js'
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
  type LocatedEntry,
} from './handbook/handbook.js'
export { HandbookIndex, type ScoredEntry } from './handbook/retrieval.js'
export { jaccard, terms, termSet } from './handbook/tokens.js'
export { contextPolicyKey, deriveKeywords, MAX_MIGRATED_ENTRIES, migrateContextPolicies, policyPractices } from './handbook/migrate.js'
export { COPY_ADOPTION_DETAILS, givenEntries, HANDBOOK_INJECT_HEADER, HandbookHost, isTrialCopy, VERSION_PRACTICES_HEADER, type HandbookHostOptions, type HandbookRecordReader } from './handbook/host.js'
