/**
 * `@nexgent/capabilities`: capability versions of a project. Step 4 round 1
 * covers the content-addressed bundle store, load-time verification and the
 * activation chain (adopt / rollback revisions); drafts, the capability
 * tools, the loader and plugin packs follow in round 2.
 */
export {
  BASELINE_VERSION,
  BUNDLE_LIMITS,
  CAPABILITY_COMPONENT_TYPES,
  CapabilityManifestError,
  checkRelativePath,
  isBundleVersion,
  isCapabilityVersion,
  MANIFEST_FILE,
  MANIFEST_FORMAT,
  manifestVersion,
  normalizeManifest,
  serializeManifest,
  sha256,
  type CapabilityComponent,
  type CapabilityComponentType,
  type CapabilityFileEntry,
  type CapabilityManifest,
} from './manifest.js'
export {
  BASELINE_BUNDLE,
  buildManifest,
  CapabilityIntegrityError,
  componentDirectory,
  listBundleVersions,
  loadBundle,
  writeBundle,
  type BundleComponentInput,
  type BundleFileInput,
  type CapabilityIntegrityReason,
  type StoredBundle,
} from './store.js'
export {
  ACTIVATION_DIR,
  ACTIVATION_FORMAT,
  BASELINE_ACTIVATION,
  CapabilityActivationError,
  commitActivation,
  readActivation,
  readActivationChain,
  type Activation,
  type ActivationChange,
  type ActivationRevision,
  type ActivationType,
} from './activation.js'
export {
  CapabilityStore,
  type CapabilityStoreOptions,
  type LoadRollback,
  type ResolvedCapabilities,
} from './capability-store.js'
