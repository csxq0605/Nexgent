/**
 * The step-4 capability contract: content-addressed capability bundles, the
 * component kinds, the activation chain (adopt / rollback revisions),
 * decision records, and task snapshots and check specs.
 *
 * Normative text:
 * `docs/spec/data-formats.md` §`CapabilityBundle` 清单, §采用历史,
 * §任务快照与检查 (formats) and `docs/spec/permissions.md` §能力包组件的执行边界,
 * §插件安装审批 (what components may do). JSON Schemas of every file live in
 * `@nexgent/session` (`capabilities.v1.schema.json`), next to the session and
 * ledger schemas, so all persisted formats share one evaluator. Types and pure
 * helpers only: hashing and I/O belong to `@nexgent/capabilities`.
 */
import { NexgentError } from './errors.js'
import type { JsonSchema, JsonValue } from './json.js'
import type { TaskCheck } from './ledger.js'
import type { ToolEffect } from './tools.js'

// ---------------------------------------------------------------------------
// Versions and directories
// ---------------------------------------------------------------------------

/**
 * Identity of a capability bundle: {@link BASELINE_VERSION} (the empty bundle,
 * i.e. step-3 behavior) or the lowercase hex SHA-256 of the canonical manifest
 * ({@link canonicalManifestText}).
 */
export type CapabilityVersion = string

/** The empty bundle; never stored as a directory. */
export const BASELINE_VERSION = 'baseline'

/** Pattern of a {@link CapabilityVersion}. */
export const CAPABILITY_VERSION_PATTERN = /^(?:baseline|[a-f0-9]{64})$/

/** Lowercase hex SHA-256. */
export const SHA256_PATTERN = /^[a-f0-9]{64}$/

/** Layout below `.nexgent/capabilities/` (all host-written; the model's file tools can read and write none of it). */
export const CAPABILITY_DIRS = {
  /** `activation/<n>.json`: the revision chain; its tail is the adopted version. */
  activation: 'activation',
  /** `decisions/<decisionId>.json`: rollback conclusions. */
  decisions: 'decisions',
  /** `drafts/<sessionId>/<kind-dir>/<name>/`: a session's draft components. */
  drafts: 'drafts',
} as const

/** File name of a bundle's manifest inside `.nexgent/capabilities/<version>/`. */
export const MANIFEST_FILE = 'manifest.json'

/** `.nexgent/snapshots/` (task snapshots; host-written, denied to the model's file tools). */
export const SNAPSHOTS_DIR = 'snapshots'

/** Bounds every writer and loader enforces. */
export const CAPABILITY_LIMITS = {
  /** Components in one bundle. */
  maxComponents: 64,
  /** Files in one component. */
  maxFilesPerComponent: 64,
  /** Bytes of one component file. */
  maxFileBytes: 1_048_576,
  /** Bytes of one whole bundle. */
  maxBundleBytes: 16_777_216,
  /** Functions one function module exports. */
  maxFunctionsPerModule: 16,
  /** UTF-8 bytes of a context policy's `instructions`. */
  maxInstructionBytes: 16_384,
  /** UTF-8 bytes of a context policy's `personaSuffix`. */
  maxPersonaSuffixBytes: 4_096,
  /** Members of one team template. */
  maxTeamTemplateMembers: 8,
  /** Bytes of one task snapshot (files above the limit are left out). */
  maxSnapshotBytes: 209_715_200,
  /** Characters of a decision's detail. */
  maxReasonChars: 2_000,
} as const

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

/**
 * Component kinds. Four classes (plan 4.4): tools (`function-module`,
 * `plugin`), skills (`skill`), context strategy (`context-policy`) and
 * collaboration (`preset`, `team-template`, `architecture`).
 */
export type CapabilityComponentKind =
  | 'function-module'
  | 'plugin'
  | 'skill'
  | 'context-policy'
  | 'preset'
  | 'team-template'
  | 'architecture'

/** Every kind, in manifest order. */
export const CAPABILITY_COMPONENT_KINDS: readonly CapabilityComponentKind[] = [
  'function-module', 'plugin', 'skill', 'context-policy', 'preset', 'team-template', 'architecture',
]

/** The class a kind belongs to. */
export type CapabilityComponentClass = 'tool' | 'skill' | 'context' | 'collaboration'

/** Kind → class. */
export const COMPONENT_CLASS: Readonly<Record<CapabilityComponentKind, CapabilityComponentClass>> = {
  'function-module': 'tool',
  plugin: 'tool',
  skill: 'skill',
  'context-policy': 'context',
  preset: 'collaboration',
  'team-template': 'collaboration',
  architecture: 'collaboration',
}

/** Directory of each kind inside a bundle or a draft area. */
export const COMPONENT_DIRS: Readonly<Record<CapabilityComponentKind, string>> = {
  'function-module': 'functions',
  plugin: 'plugins',
  skill: 'skills',
  'context-policy': 'context',
  preset: 'presets',
  'team-template': 'teams',
  architecture: 'architectures',
}

/**
 * The file that defines each kind, relative to the component directory.
 * Every other file of a component is a supporting file (a module's code, a
 * skill's references).
 */
export const COMPONENT_ENTRY_FILES: Readonly<Record<CapabilityComponentKind, string>> = {
  'function-module': 'functions.json',
  plugin: 'plugin.json',
  skill: 'SKILL.md',
  'context-policy': 'policy.json',
  preset: 'preset.json',
  'team-template': 'team.json',
  architecture: 'architecture.json',
}

/** Pattern of a component name (unique per kind within a bundle). */
export const COMPONENT_NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/

/**
 * Pattern of a component-relative file path: `/`-separated, no empty, `.` or
 * `..` segment, no leading `/`, no backslash, no drive letter.
 */
export const COMPONENT_FILE_PATTERN = /^(?![./])(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*\/\/)[^\\:]+(?<!\/)$/

/** `<kind-dir>/<name>`: where a component lives inside a bundle or draft area. */
export function componentDir(kind: CapabilityComponentKind, name: string): string {
  return `${COMPONENT_DIRS[kind]}/${name}`
}

/** One file of a component, as hashed in the manifest. */
export interface CapabilityFile {
  /** Relative to the component directory; matches {@link COMPONENT_FILE_PATTERN}. */
  readonly path: string
  readonly sha256: string
  readonly bytes: number
}

/** One component of a manifest. */
export interface CapabilityComponent {
  readonly kind: CapabilityComponentKind
  readonly name: string
  /** Sorted by `path`; contains the kind's entry file. */
  readonly files: readonly CapabilityFile[]
}

/** `{ kind, name }`: how records and views name a component. */
export interface CapabilityComponentRef {
  readonly kind: CapabilityComponentKind
  readonly name: string
}

/**
 * `.nexgent/capabilities/<version>/manifest.json`. A bundle is complete (it
 * lists every component in force, not a delta) and holds content only:
 * so equal content has one version.
 */
export interface CapabilityManifest {
  readonly formatVersion: 1
  /** Sorted by kind ({@link CAPABILITY_COMPONENT_KINDS} order) then name; at most one `context-policy`. */
  readonly components: readonly CapabilityComponent[]
}

/** Sort components and files into manifest order (pure; returns a new manifest). */
export function normalizeManifest(manifest: CapabilityManifest): CapabilityManifest {
  const kindIndex = (kind: CapabilityComponentKind) => CAPABILITY_COMPONENT_KINDS.indexOf(kind)
  const components = [...manifest.components]
    .map(component => ({ kind: component.kind, name: component.name, files: [...component.files].map(file => ({ path: file.path, sha256: file.sha256, bytes: file.bytes })).sort((a, b) => compare(a.path, b.path)) }))
    .sort((a, b) => kindIndex(a.kind) - kindIndex(b.kind) || compare(a.name, b.name))
  return { formatVersion: 1, components }
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Canonical JSON: object keys sorted by UTF-16 code unit, no whitespace,
 * arrays in order. `undefined` members are dropped like `JSON.stringify`.
 */
export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${(value as readonly JsonValue[]).map(item => canonicalJson(item)).join(',')}]`
  const object = value as Readonly<Record<string, JsonValue | undefined>>
  const keys = Object.keys(object).filter(key => object[key] !== undefined).sort()
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(object[key] as JsonValue)}`).join(',')}}`
}

/**
 * The text whose SHA-256 (UTF-8, lowercase hex) is the bundle's version:
 * the canonical JSON of the normalized manifest.
 */
export function canonicalManifestText(manifest: CapabilityManifest): string {
  return canonicalJson(normalizeManifest(manifest) as unknown as JsonValue)
}

/**
 * Check a manifest's structure (names, paths, hashes, limits, one entry file
 * per component, unique kind + name, at most one context policy). Hash
 * verification against the files is the loader's job.
 * @throws `config/invalid` naming the first problem.
 */
export function assertCapabilityManifest(value: unknown): asserts value is CapabilityManifest {
  const fail = (message: string): never => {
    throw new NexgentError('config/invalid', `capability manifest: ${message}`)
  }
  if (!isRecord(value)) fail('must be an object')
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) if (key !== 'formatVersion' && key !== 'components') fail(`unknown field ${key}`)
  if (record.formatVersion !== 1) fail('formatVersion must be 1')
  if (!Array.isArray(record.components)) fail('components must be an array')
  const components = record.components as unknown[]
  if (components.length > CAPABILITY_LIMITS.maxComponents) fail(`more than ${CAPABILITY_LIMITS.maxComponents} components`)
  const seen = new Set<string>()
  let total = 0
  let policies = 0
  for (const [index, item] of components.entries()) {
    const at = `components[${index}]`
    if (!isRecord(item)) fail(`${at} must be an object`)
    const component = item as Record<string, unknown>
    for (const key of Object.keys(component)) if (!['kind', 'name', 'files'].includes(key)) fail(`${at} has unknown field ${key}`)
    if (!CAPABILITY_COMPONENT_KINDS.includes(component.kind as CapabilityComponentKind)) fail(`${at}.kind is not a component kind`)
    const kind = component.kind as CapabilityComponentKind
    if (typeof component.name !== 'string' || !COMPONENT_NAME_PATTERN.test(component.name)) fail(`${at}.name must match ${String(COMPONENT_NAME_PATTERN)}`)
    const key = `${kind}/${component.name as string}`
    if (seen.has(key)) fail(`duplicate component ${key}`)
    seen.add(key)
    if (kind === 'context-policy' && ++policies > 1) fail('at most one context-policy component')
    if (!Array.isArray(component.files) || component.files.length === 0) fail(`${at}.files must be a non-empty array`)
    const files = component.files as unknown[]
    if (files.length > CAPABILITY_LIMITS.maxFilesPerComponent) fail(`${at} has more than ${CAPABILITY_LIMITS.maxFilesPerComponent} files`)
    const paths = new Set<string>()
    for (const [fileIndex, entry] of files.entries()) {
      const fileAt = `${at}.files[${fileIndex}]`
      if (!isRecord(entry)) fail(`${fileAt} must be an object`)
      const file = entry as Record<string, unknown>
      for (const fileKey of Object.keys(file)) if (!['path', 'sha256', 'bytes'].includes(fileKey)) fail(`${fileAt} has unknown field ${fileKey}`)
      if (typeof file.path !== 'string' || !COMPONENT_FILE_PATTERN.test(file.path)) fail(`${fileAt}.path is not a relative component path`)
      if (paths.has(file.path as string)) fail(`${fileAt}.path is duplicated`)
      paths.add(file.path as string)
      if (typeof file.sha256 !== 'string' || !SHA256_PATTERN.test(file.sha256)) fail(`${fileAt}.sha256 must be lowercase hex SHA-256`)
      if (!Number.isSafeInteger(file.bytes) || (file.bytes as number) < 0 || (file.bytes as number) > CAPABILITY_LIMITS.maxFileBytes) {
        fail(`${fileAt}.bytes must be an integer in 0..${CAPABILITY_LIMITS.maxFileBytes}`)
      }
      total += file.bytes as number
    }
    if (!paths.has(COMPONENT_ENTRY_FILES[kind])) fail(`${at} lacks its entry file ${COMPONENT_ENTRY_FILES[kind]}`)
  }
  if (total > CAPABILITY_LIMITS.maxBundleBytes) fail(`bundle exceeds ${CAPABILITY_LIMITS.maxBundleBytes} bytes`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

// ---------------------------------------------------------------------------
// Component entry files
// ---------------------------------------------------------------------------

/** Pattern of an exported function name in a function module. */
export const FUNCTION_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/

/** Prefix of the model tools a function module's functions become. */
export const FUNCTION_TOOL_PREFIX = 'cap_'

/**
 * The model tool name of one exported function: `cap_<module>_<function>`.
 * Module names have no `_` (dashes only), so the first `_` after the prefix
 * separates module from function unambiguously.
 * @throws `config/invalid` when either name is malformed or the result exceeds 64 characters.
 */
export function functionToolName(moduleName: string, functionName: string): string {
  if (!COMPONENT_NAME_PATTERN.test(moduleName)) throw new NexgentError('config/invalid', `function module name must match ${String(COMPONENT_NAME_PATTERN)}`)
  if (!FUNCTION_NAME_PATTERN.test(functionName)) throw new NexgentError('config/invalid', `function name must match ${String(FUNCTION_NAME_PATTERN)}`)
  const name = `${FUNCTION_TOOL_PREFIX}${moduleName}_${functionName}`
  if (name.length > 64) throw new NexgentError('config/invalid', `tool name ${name} is longer than 64 characters`)
  return name
}

/** One exported function of a function module. */
export interface FunctionSpec {
  readonly name: string
  /** One paragraph for the model; the first line becomes the tool list entry. */
  readonly description: string
  /** JSON Schema of the function's single argument object. */
  readonly inputSchema: JsonSchema
  /** What the function does through host functions: subset of `read`, `write`, `network`. `execute` is implied (it runs code). */
  readonly effects: readonly Exclude<ToolEffect, 'execute'>[]
}

/**
 * `functions/<name>/functions.json`. The module (`entry`, an ES module) runs
 * in the same kind of isolated Node process as `run_code`; each exported
 * function listed here becomes the tool {@link functionToolName}, declared
 * with effects `['execute', ...effects]`, approval `never` and
 * `selfSandboxed: true` (`permissions.md` §能力包组件的执行边界).
 */
export interface FunctionModuleSpec {
  readonly formatVersion: 1
  /** Equals the component name. */
  readonly name: string
  readonly description: string
  /** Module file relative to the component directory, `.mjs`; default `index.mjs`. */
  readonly entry?: string
  readonly functions: readonly FunctionSpec[]
}

/**
 * `plugins/<name>/plugin.json`. A Nexgent plugin module loaded into the host
 * process (not sandboxed). Trying it needs the user's approval
 * (`permissions.md` §插件安装审批).
 */
export interface PluginSpec {
  readonly formatVersion: 1
  /** Equals the component name. */
  readonly name: string
  readonly description: string
  /** Module file relative to the component directory, `.mjs`; default `index.mjs`. */
  readonly entry?: string
  /** Plain-language statement of what the plugin will be able to do, shown in the approval dialog. */
  readonly permissions: string
  /** Names of the model tools it registers (each must not collide with a built-in tool). */
  readonly tools?: readonly string[]
}

/**
 * What the plugin try-approval dialog shows for one plugin component
 * (`permissions.md` §插件安装审批): the plugin's own `description` and
 * `permissions` text and the tools it will register, read from its
 * `plugin.json`.
 */
export interface PluginApprovalInfo {
  /** Component name (equals `plugin.json` `name`). */
  readonly name: string
  readonly description: string
  /** `plugin.json` `permissions`, verbatim. */
  readonly permissions: string
  /** `plugin.json` `tools`, `[]` when absent. */
  readonly tools: readonly string[]
}

/** The {@link PluginApprovalInfo} of a validated `plugin.json` (pure). */
export function pluginApprovalInfo(spec: PluginSpec): PluginApprovalInfo {
  return { name: spec.name, description: spec.description, permissions: spec.permissions, tools: [...(spec.tools ?? [])] }
}

/**
 * `context/<name>/policy.json`: the whitelisted context-strategy fields. The
 * schema has no place for approvals, cost caps or sandbox mode, so a
 * component cannot change them (H13).
 */
export interface ContextPolicySpec {
  readonly formatVersion: 1
  /** Equals the component name. */
  readonly name: string
  readonly description: string
  /** Rendered as a `# Learned practices` system-prompt section after the context providers' sections. */
  readonly instructions?: string
  /** Appended to the persona suffix (the closing paragraph of the system prompt). */
  readonly personaSuffix?: string
  /** Overrides `@nexgent/context`'s compaction settings for sessions on this bundle. */
  readonly compaction?: {
    /** 10 000 – 1 000 000. */
    readonly thresholdTokens?: number
    /** 1 – 10. */
    readonly keepRecentTurns?: number
  }
}

/** Top-level fields a {@link ContextPolicySpec} may have (anything else is refused). */
export const CONTEXT_POLICY_FIELDS = ['formatVersion', 'name', 'description', 'instructions', 'personaSuffix', 'compaction'] as const

/** One member of a {@link TeamTemplateSpec}. */
export interface TeamTemplateMember {
  /** Matches `MEMBER_NAME_PATTERN`. */
  readonly name: string
  /** What the member does first when the template is used. */
  readonly task: string
  readonly preset?: string
  readonly persona?: string
}

/**
 * `teams/<name>/team.json`: a reusable team line-up (the file format is kept
 * for old bundles).
 */
export interface TeamTemplateSpec {
  readonly formatVersion: 1
  /** Equals the component name. */
  readonly name: string
  readonly description: string
  /** 1 – {@link CAPABILITY_LIMITS.maxTeamTemplateMembers}, unique names, none `lead`. */
  readonly members: readonly TeamTemplateMember[]
}

/**
 * A preset component's `preset.json` is a `PresetFile`
 * (`collaboration.ts`); an architecture component's `architecture.json` is
 * an `ArchitectureFile`. Both keep their step-3 formats.
 */
export type CollaborationComponentFile = 'PresetFile' | 'ArchitectureFile'

// ---------------------------------------------------------------------------
// Activation chain (ported from PR #4 `architecture-activation.ts`)
// ---------------------------------------------------------------------------

/** What caused a revision. */
export type ActivationTrigger =
  /** A gate trial adopted a skill / function / context / collaboration candidate. */
  | 'gate'
  /** The user approved a plugin candidate that passed its gate. */
  | 'approval'
  /** The adopted bundle failed verification or loading. */
  | 'load-failure'
  /** Early root tasks on the adopted bundle regressed (checks or component errors). */
  | 'usage-regression'
  /** The user rolled back from the CLI or the desktop app. */
  | 'manual'

/** Every trigger. */
export const ACTIVATION_TRIGGERS: readonly ActivationTrigger[] = ['gate', 'approval', 'load-failure', 'usage-regression', 'manual']

/**
 * `.nexgent/capabilities/activation/<n>.json`, published with an exclusive
 * hard link and only when revision `n - 1` is still the tail
 * (compare-and-publish). Never rewritten or deleted.
 */
export interface ActivationRevision {
  readonly format: 1
  /** 1, 2, …; equals the file's base name. */
  readonly revision: number
  /** SHA-256 of the previous revision file's exact bytes; `null` for revision 1. */
  readonly previous: string | null
  /** Version in force before this revision (`baseline` before the first adoption). */
  readonly from: CapabilityVersion
  /** Version in force after it. */
  readonly version: CapabilityVersion
  readonly type: 'adopt' | 'rollback'
  readonly trigger: ActivationTrigger
  /** The decision record that justifies the revision. */
  readonly decisionId: string
  /** ISO-8601 UTC. */
  readonly committedAt: string
}

/** The tail of the chain as a reader sees it. */
export interface ActivationState {
  /** 0 before any revision. */
  readonly revision: number
  /** SHA-256 of the tail file's bytes; `null` at revision 0. */
  readonly digest: string | null
  /** Adopted version (`baseline` at revision 0). */
  readonly version: CapabilityVersion
}

/** The state before any revision. */
export const INITIAL_ACTIVATION: ActivationState = Object.freeze({ revision: 0, digest: null, version: BASELINE_VERSION })

/**
 * Whether `next` may follow `state` (pure part of chain verification; the
 * reader also checks the file name and hashes the bytes for `digest`).
 */
export function isNextRevision(state: ActivationState, next: ActivationRevision): boolean {
  return next.format === 1
    && next.revision === state.revision + 1
    && next.previous === state.digest
    && next.from === state.version
    && next.version !== next.from
    && CAPABILITY_VERSION_PATTERN.test(next.version)
}

// ---------------------------------------------------------------------------
// Decisions and rollback
// ---------------------------------------------------------------------------

/**
 * What a decision concluded. Only rollbacks are decided now; versions adopted
 * earlier (by the removed gate) stay in the activation chain and still load.
 */
export type DecisionOutcome = 'rolled-back'

/** Every outcome. */
export const DECISION_OUTCOMES: readonly DecisionOutcome[] = ['rolled-back']

/** Why: the adopted bundle failed to load, or the user rolled back. */
export type DecisionReason = 'load-failure' | 'manual'

/** Every decision reason. */
export const DECISION_REASONS: readonly DecisionReason[] = ['load-failure', 'manual']

/**
 * `.nexgent/capabilities/decisions/<id>.json`, written once (`wx`). Every
 * activation revision names one. A ledger `capability.decision` record
 * points to it.
 */
export interface CapabilityDecision {
  readonly formatVersion: 1
  /** Lowercase uuid v4. */
  readonly id: string
  readonly outcome: DecisionOutcome
  readonly reason: DecisionReason
  readonly trigger: ActivationTrigger
  /** ISO-8601 UTC. */
  readonly decidedAt: string
  /** Adopted version when the decision was made. */
  readonly fromVersion: CapabilityVersion
  /** Version in force afterwards. */
  readonly toVersion: CapabilityVersion
  /** Revision written for it. */
  readonly revision?: number
  /** Human-readable explanation, at most {@link CAPABILITY_LIMITS.maxReasonChars} characters. */
  readonly detail: string
}

// ---------------------------------------------------------------------------
// Task snapshots and checks
// ---------------------------------------------------------------------------

/** Names of the deterministic checks the host runs at task end and in trials. */
export type TaskCheckName = 'file-exists' | 'parses' | 'test-command'

/** File base name of a per-turn snapshot or checks record (step 5): `<taskId>.t<turn>.json`. */
export function perTurnFileName(taskId: string, turn: number): string {
  if (!Number.isSafeInteger(turn) || turn < 1) throw new NexgentError('internal', `turn must be a positive integer: ${turn}`)
  return `${taskId}.t${turn}.json`
}

/** Every check name. */
export const TASK_CHECK_NAMES: readonly TaskCheckName[] = ['file-exists', 'parses', 'test-command']

/** Formats `parses` understands. */
export type ParseFormat = 'json' | 'csv' | 'xlsx'

/**
 * One check to run (recorded at task end, replayed in trials). `file-exists`
 * and `parses` name a project-relative `path` (a deliverable's file);
 * `test-command` names a test-runner shell `command` the original task ran in
 * the project root, whatever its exit code (step 5: a failing test run is
 * recorded too and re-run, so it becomes a failing check; ADR 0006 decision
 * 10); it is re-run at turn end and in trials, and only that re-run decides
 * the result.
 * The command text lives only here, never in the ledger: a ledger `TaskCheck`
 * carries the spec's `id` as its `target`.
 */
export type TaskCheckSpec =
  | { readonly id: string; readonly name: 'file-exists'; readonly path: string }
  | { readonly id: string; readonly name: 'parses'; readonly path: string; readonly format: ParseFormat }
  | { readonly id: string; readonly name: 'test-command'; readonly command: string; readonly shell: 'bash' | 'pwsh' }

/** One file of a snapshot tree. */
export interface SnapshotFile {
  /** Project-relative, `/`-separated. */
  readonly path: string
  readonly sha256: string
  readonly bytes: number
  /** POSIX executable bit. */
  readonly executable?: true
}

/**
 * `.nexgent/snapshots/trees/<sha256>.json`; the name is the SHA-256 of
 * {@link canonicalJson} of this object. File bodies live once each in
 * `.nexgent/snapshots/objects/<sha256>`.
 */
export interface SnapshotTree {
  readonly formatVersion: 1
  /** Sorted by path; `.nexgent/`, `.git/`, `node_modules/` excluded like `turn.files`. */
  readonly files: readonly SnapshotFile[]
}

/**
 * `.nexgent/snapshots/tasks/<taskId>.json` (step 4: written when a root task
 * starts) and, from step 5, `tasks/<taskId>.t<turn>.json` written when each
 * root turn starts (decision 7: the task id stays, snapshots are per turn).
 * A step-4 file without `turn` is the task's first turn.
 */
export interface TaskSnapshotRecord {
  readonly formatVersion: 1
  readonly taskId: string
  /** Step 5: the root turn it was taken before; absent in step-4 files (turn 1). */
  readonly turn?: number
  readonly sessionId: string
  /** ISO-8601 UTC. */
  readonly takenAt: string
  /** Tree id, or `null` when the workspace exceeded {@link CAPABILITY_LIMITS.maxSnapshotBytes}. */
  readonly tree: string | null
  /** Set with `tree: null`. */
  readonly omitted?: { readonly reason: 'too-large'; readonly bytes: number }
  /** Capability version the task ran on. */
  readonly capabilityVersion: CapabilityVersion
}

/**
 * `.nexgent/snapshots/checks/<taskId>.json` (step 4: rewritten at the end of
 * every root turn, so it holds the latest turn) and, from step 5,
 * `checks/<taskId>.t<turn>.json` written once at the end of each root turn;
 * a feedback turn never overwrites the turn it is about.
 */
export interface TaskChecksRecord {
  readonly formatVersion: 1
  readonly taskId: string
  /** Step 5: the root turn checked; absent in step-4 files (the latest turn at the time). */
  readonly turn?: number
  readonly sessionId: string
  /** ISO-8601 UTC. */
  readonly checkedAt: string
  readonly specs: readonly TaskCheckSpec[]
  /** One per spec, same order; `target` is the spec id. */
  readonly results: readonly TaskCheck[]
}

// ---------------------------------------------------------------------------
// Ledger and session vocabulary
// ---------------------------------------------------------------------------

/** One component a task actually used (`task.outcome.componentsUsed`). */
export interface ComponentUsage extends CapabilityComponentRef {
  /** Bundle the component came from, or `draft` for a component tried in this session. */
  readonly version: CapabilityVersion | 'draft'
  readonly calls: number
  readonly errors: number
}

/** Why a session's capability version changed (`capability.version` record). */
export type CapabilityVersionSwitchReason =
  /** On resume the recorded version was missing or failed verification. */
  | 'unavailable'
  /** Loading the version failed when the session opened. */
  | 'load-failure'

/** Every switch reason. */
export const CAPABILITY_VERSION_SWITCH_REASONS: readonly CapabilityVersionSwitchReason[] = ['unavailable', 'load-failure']
