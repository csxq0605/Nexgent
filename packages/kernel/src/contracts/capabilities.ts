/**
 * The step-4 capability contract: content-addressed capability bundles, the
 * four component kinds, the activation chain (adopt / rollback revisions),
 * candidates, gate-trial receipts and verdicts, decision records, task
 * snapshots and check specs, and the project's `capabilities` settings.
 *
 * Normative text: `docs/adr/0005-capability-versions.md` (decisions),
 * `docs/spec/data-formats.md` §`CapabilityBundle` 清单, §采用历史, §候选与门控,
 * §任务快照与检查 (formats) and `docs/spec/permissions.md` §能力包组件的执行边界,
 * §插件安装审批 (what components may do). JSON Schemas of every file live in
 * `@nexgent/session` (`capabilities.v1.schema.json`), next to the session and
 * ledger schemas, so all persisted formats share one evaluator. Types and pure
 * helpers only: hashing and I/O belong to `@nexgent/capabilities`.
 */
import { NexgentError } from './errors.js'
import type { JsonSchema, JsonValue } from './json.js'
import type { LLMUsage, ThinkingMode } from './llm.js'
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
  /** `candidates/<candidateId>/`: `candidate.json` plus the proposed component files. */
  candidates: 'candidates',
  /** `trials/<trialId>.jsonl`: gate receipts, opened `wx`, one fsynced line per event. */
  trials: 'trials',
  /** `decisions/<decisionId>.json`: adopt / reject / awaiting-approval / rollback conclusions. */
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
  /** Bytes of one task snapshot (files above the limit leave the task out of replay sets). */
  maxSnapshotBytes: 209_715_200,
  /** Characters of a reviewer's reason and a decision's detail. */
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

/** Directory of each kind inside a bundle, a candidate or a draft area. */
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

/** `<kind-dir>/<name>`: where a component lives inside a bundle, candidate or draft area. */
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
 * where a component came from lives in the candidate and decision records,
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
 * process (not sandboxed). Trying it and adopting it each need the user's
 * approval (`permissions.md` §插件安装审批).
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
 * What the plugin approval dialog shows for one plugin component of a
 * candidate (`permissions.md` §插件安装审批): the plugin's own
 * `description` and `permissions` text and the tools it will register, read
 * from the candidate's copy of `plugin.json`. Combined with the component's
 * file hashes from the candidate record.
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
 * schema has no place for approvals, cost caps, sandbox mode, capability or
 * gate settings, so a candidate cannot change them (H13).
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
  /** What the teammate does first when the template is used. */
  readonly task: string
  readonly preset?: string
  readonly persona?: string
}

/**
 * `teams/<name>/team.json`: a reusable team line-up the Lead can start with
 * `spawn_teammate` calls (the template is guidance in the system prompt, not
 * an automatic spawn).
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
// Candidates
// ---------------------------------------------------------------------------

/**
 * Where a candidate stands. `drafted` exists only in views of a session's
 * draft area (nothing proposed yet); every other status is derived from the
 * candidate, its trial receipts, its decisions and the activation chain
 * (`data-formats.md` §候选与门控).
 */
export type CandidateStatus = 'drafted' | 'proposed' | 'trialing' | 'awaiting-approval' | 'adopted' | 'rejected' | 'rolled-back'

/** Every status. */
export const CANDIDATE_STATUSES: readonly CandidateStatus[] = ['drafted', 'proposed', 'trialing', 'awaiting-approval', 'adopted', 'rejected', 'rolled-back']

/**
 * The successful call that proves a proposed component was used in its
 * session (decision 2): a cap_* function call, a `load_skill` call, a
 * `delegate` / `spawn_teammate` / `workflow` call that used the preset,
 * template or graph, a tool the plugin registered, or — for a context policy,
 * which nothing calls — the `capability_try` call followed by a turn that
 * completed.
 */
export interface ComponentUseProof extends CapabilityComponentRef {
  readonly turn: number
  /** The proving call's id (for a context policy: the `capability_try` call). */
  readonly toolCallId: string
}

/** `.nexgent/capabilities/candidates/<id>/candidate.json`, written once when the host accepts a proposal. */
export interface CandidateRecord {
  readonly formatVersion: 1
  /** Lowercase uuid v4. */
  readonly id: string
  /** ISO-8601 UTC. */
  readonly proposedAt: string
  /** Root session and task that proposed it. */
  readonly sessionId: string
  readonly taskId: string
  readonly turn: number
  /** Adopted version the session ran on; the candidate bundle is this bundle plus {@link components}. */
  readonly base: CapabilityVersion
  /** Version of the resulting bundle (content hash). */
  readonly version: CapabilityVersion
  /** New or changed components, with the hashes of the files copied next to this record. */
  readonly components: readonly CapabilityComponent[]
  /** One proof per component. */
  readonly proofs: readonly ComponentUseProof[]
  /** True when a component is a `plugin`: passing the gate then waits for approval. */
  readonly requiresApproval: boolean
  /** The model's one-line reason, at most 500 characters. */
  readonly summary?: string
  /** Step 5: who proposed it; absent means `session` (a user task's own `capability_propose`). */
  readonly origin?: CandidateOrigin
  /** Step 5: the improvement job, when `origin` is `improvement`. */
  readonly jobId?: string
}

/** Where a candidate came from: a user task's session (step 4) or an improvement job's propose phase (step 5). */
export type CandidateOrigin = 'session' | 'improvement'

/** Every origin. */
export const CANDIDATE_ORIGINS: readonly CandidateOrigin[] = ['session', 'improvement']

// ---------------------------------------------------------------------------
// Gate trials
// ---------------------------------------------------------------------------

/** The two arms of a trial. */
export type TrialArm = 'candidate' | 'baseline'

/** Replay-set halves; they never share a task (ported PR #4 check). */
export type ReplaySet = 'selection' | 'guard'

/** Three-way result: an incomparable run is `unknown`, never `fail` or `pass`. */
export type TrialStatus = 'pass' | 'fail' | 'unknown'

/** Why a run is `unknown`. */
export type TrialUnknownReason = 'not-run' | 'cancelled' | 'error' | 'timeout' | 'budget' | 'interrupted'

/** Every unknown reason. */
export const TRIAL_UNKNOWN_REASONS: readonly TrialUnknownReason[] = ['not-run', 'cancelled', 'error', 'timeout', 'budget', 'interrupted']

/** One replay case: a past root task with a snapshot and recorded check specs. */
export interface ReplayCaseRef {
  /** The past task's `taskId`. */
  readonly caseId: string
  /** Its root session (the first user message and materials are read from it). */
  readonly sessionId: string
  /** Snapshot tree taken at task start. */
  readonly tree: string
  /** Check specs recorded at the end of the replayed turn (`checks/<taskId>.json`, or per turn from step 5). */
  readonly checks: readonly TaskCheckSpec[]
  /**
   * Step 5: replay the user messages of turns 1 … `throughTurn` (each run
   * still a fresh session); absent means the first turn only (step 4). For a
   * feedback task it is the last turn before the first feedback, so the
   * feedback text never reaches the replay.
   */
  readonly throughTurn?: number
  /** Step 5: the feedback this case carries; each run of the case then gets a `trial.feedback` check. */
  readonly feedbackIds?: readonly string[]
}

/** Token / request totals; dollars are estimated separately and never decide anything. */
export interface TrialCost {
  readonly usage: LLMUsage
  readonly requestCount: number
  /**
   * Estimated USD from `@nexgent/llm`'s read-only price table (step 5,
   * display only), or `unknown` when the model has no price or any usage is
   * unknown. Never used by a decision.
   */
  readonly estimatedUsd: number | 'unknown'
}

/** Frozen gate parameters (a copy of the project's `capabilities` settings at trial start). */
export interface TrialPlan {
  readonly selection: readonly ReplayCaseRef[]
  readonly guard: readonly ReplayCaseRef[]
  /** Runs per arm per case. */
  readonly repeats: number
  /** Candidate tokens may be at most this multiple of the baseline's. */
  readonly costRatioCap: number
  readonly reviewer: ReviewerSettings
  /** The trial's own budget; exhausting it stops the trial with `unknown` (H12). */
  readonly budget: TrialBudget
}

/**
 * One line of `.nexgent/capabilities/trials/<trialId>.jsonl`. The file is
 * created with `wx` (a trial id is never reused) and each line is fsynced
 * before the next run starts; a trial without `trial.end` was interrupted.
 */
export type TrialReceipt =
  | {
      readonly type: 'trial.start'
      readonly format: 1
      readonly trialId: string
      readonly ts: string
      readonly candidateId: string
      readonly candidateVersion: CapabilityVersion
      readonly baselineVersion: CapabilityVersion
      readonly plan: TrialPlan
    }
  | {
      readonly type: 'trial.run'
      readonly format: 1
      readonly trialId: string
      readonly ts: string
      readonly set: ReplaySet
      readonly caseId: string
      readonly arm: TrialArm
      /** 1 … `repeats`. */
      readonly repeat: number
      readonly status: TrialStatus
      readonly reason?: TrialUnknownReason
      /** Checks the host ran on the run's result (empty when `unknown`). */
      readonly checks: readonly TaskCheck[]
      readonly cost: TrialCost
      readonly durationMs: number
    }
  | {
      readonly type: 'trial.review'
      readonly format: 1
      readonly trialId: string
      readonly ts: string
      readonly set: ReplaySet
      readonly caseId: string
      readonly repeat: number
      /** Reviewer-model opinion, marked separately from the checks (plan 4.4). */
      readonly preference: 'candidate' | 'baseline' | 'tie' | 'unknown'
      readonly reason: string
      readonly model: string
      readonly cost: TrialCost
    }
  | {
      /**
       * Step 5, ADR 0006: the feedback check of one run of a feedback case.
       * The reviewer model reads the run's deliverables and the feedback
       * text and answers whether the problem the feedback names is solved.
       * Marked separately from deterministic checks and from `trial.review`.
       */
      readonly type: 'trial.feedback'
      readonly format: 1
      readonly trialId: string
      readonly ts: string
      readonly caseId: string
      readonly arm: TrialArm
      readonly repeat: number
      readonly feedbackIds: readonly string[]
      /** `unknown`: the run itself was unknown, the reviewer failed, or its answer did not parse. */
      readonly status: TrialStatus
      readonly reason: string
      readonly model: string
      readonly cost: TrialCost
    }
  | {
      readonly type: 'trial.end'
      readonly format: 1
      readonly trialId: string
      readonly ts: string
      readonly status: TrialStatus
      readonly verdict: TrialVerdict
      readonly cost: { readonly candidate: TrialCost; readonly baseline: TrialCost; readonly review: TrialCost }
    }

/** Receipt `type` vocabulary. */
export const TRIAL_RECEIPT_TYPES = ['trial.start', 'trial.run', 'trial.review', 'trial.feedback', 'trial.end'] as const

/** Pass counts of one arm over one replay set. */
export interface ArmTally {
  readonly passed: number
  readonly failed: number
  readonly unknown: number
}

/** What {@link decideTrial} reads. */
export interface TrialTally {
  readonly selection: { readonly candidate: ArmTally; readonly baseline: ArmTally }
  readonly guard: { readonly candidate: ArmTally; readonly baseline: ArmTally }
  /** Review preferences over selection runs (unknown reviews are not counted). */
  readonly review: { readonly candidate: number; readonly baseline: number; readonly tie: number }
  /** Total tokens of each arm's runs (input + output, as cost caps count); `unknown` when any run's usage is unknown. */
  readonly tokens: { readonly candidate: number | 'unknown'; readonly baseline: number | 'unknown' }
  /** The trial budget ran out before every run finished. */
  readonly budgetExhausted: boolean
  /** The candidate includes a plugin. */
  readonly requiresApproval: boolean
  /** Step 5: feedback checks per arm (`trial.feedback`); absent when no case carries feedback. */
  readonly feedback?: { readonly candidate: ArmTally; readonly baseline: ArmTally }
}

/** Why a trial or decision came out as it did. */
export type DecisionReason =
  | 'quality-up'
  | 'cost-down'
  | 'review-preferred'
  | 'quality-down'
  | 'guard-regressed'
  | 'cost-over-cap'
  | 'no-improvement'
  | 'unknown-runs'
  | 'budget-exhausted'
  | 'interrupted'
  | 'approved'
  | 'approval-denied'
  | 'load-failure'
  | 'usage-regression'
  | 'component-errors'
  | 'manual'

/** Every decision reason. */
export const DECISION_REASONS: readonly DecisionReason[] = [
  'quality-up', 'cost-down', 'review-preferred', 'quality-down', 'guard-regressed', 'cost-over-cap', 'no-improvement',
  'unknown-runs', 'budget-exhausted', 'interrupted', 'approved', 'approval-denied', 'load-failure', 'usage-regression',
  'component-errors', 'manual',
]

/** The gate's conclusion, before it is written as a decision. */
export interface TrialVerdict {
  readonly outcome: 'adopt' | 'reject' | 'await-approval'
  readonly reason: DecisionReason
  /** Quality (0–1) per arm: selection runs plus feedback checks (step 5), `unknown` excluded. */
  readonly passRate: { readonly candidate: number; readonly baseline: number }
  /** Step 5: feedback-check pass rates alone, when the trial had any (marked separately in evidence). */
  readonly feedbackPassRate?: { readonly candidate: number; readonly baseline: number }
  /** Candidate tokens / baseline tokens, or `unknown`. */
  readonly costRatio: number | 'unknown'
  /** Whether the reviewer's opinion decided (only possible on a check tie). */
  readonly decidedByReview: boolean
}

function rate(tally: ArmTally): number {
  const counted = tally.passed + tally.failed
  return counted === 0 ? 0 : tally.passed / counted
}

/**
 * The adoption rule (plan 4.4; ADR 0005 decision 5 as amended by ADR 0006),
 * pure:
 *
 * 1. Any `unknown` run or feedback check, or an exhausted budget, rejects
 *    (`unknown-runs` / `budget-exhausted`); the receipt's status is `unknown`.
 * 2. The guard set may not regress: candidate guard passes below the
 *    baseline's reject (`guard-regressed`).
 * 3. Quality is the pass rate of the selection runs' deterministic checks
 *    together with the feedback checks (each feedback check counts as one
 *    more pass or fail of its arm; step 5, ADR 0006). Lower
 *    rejects (`quality-down`). Higher adopts if the cost ratio is within the
 *    cap (`quality-up`), else rejects (`cost-over-cap`).
 * 4. On a tie: a cost ratio below 1 adopts (`cost-down`); otherwise the
 *    reviewer decides: more `candidate` than `baseline` preferences and a
 *    ratio within the cap adopt (`review-preferred`), anything else rejects
 *    (`no-improvement`).
 * 5. An adopting verdict for a candidate with a plugin becomes
 *    `await-approval` with the same reason.
 */
export function decideTrial(tally: TrialTally, costRatioCap: number): TrialVerdict {
  const feedback = tally.feedback
  const quality = (arm: 'candidate' | 'baseline'): ArmTally => feedback === undefined
    ? tally.selection[arm]
    : { passed: tally.selection[arm].passed + feedback[arm].passed, failed: tally.selection[arm].failed + feedback[arm].failed, unknown: tally.selection[arm].unknown + feedback[arm].unknown }
  const passRate = { candidate: rate(quality('candidate')), baseline: rate(quality('baseline')) }
  const feedbackPassRate = feedback === undefined ? undefined : { candidate: rate(feedback.candidate), baseline: rate(feedback.baseline) }
  const { candidate: candidateTokens, baseline: baselineTokens } = tally.tokens
  const costRatio: number | 'unknown' = candidateTokens === 'unknown' || baselineTokens === 'unknown' || baselineTokens === 0
    ? 'unknown'
    : candidateTokens / baselineTokens
  const verdict = (outcome: 'adopt' | 'reject', reason: DecisionReason, decidedByReview = false): TrialVerdict => ({
    outcome: outcome === 'adopt' && tally.requiresApproval ? 'await-approval' : outcome,
    reason,
    passRate,
    ...(feedbackPassRate === undefined ? {} : { feedbackPassRate }),
    costRatio,
    decidedByReview,
  })
  const unknownRuns = quality('candidate').unknown + quality('baseline').unknown + tally.guard.candidate.unknown + tally.guard.baseline.unknown
  if (tally.budgetExhausted) return verdict('reject', 'budget-exhausted')
  if (unknownRuns > 0 || costRatio === 'unknown') return verdict('reject', 'unknown-runs')
  if (tally.guard.candidate.passed < tally.guard.baseline.passed) return verdict('reject', 'guard-regressed')
  if (passRate.candidate < passRate.baseline) return verdict('reject', 'quality-down')
  if (passRate.candidate > passRate.baseline) return costRatio <= costRatioCap ? verdict('adopt', 'quality-up') : verdict('reject', 'cost-over-cap')
  if (costRatio < 1) return verdict('adopt', 'cost-down')
  if (tally.review.candidate > tally.review.baseline && costRatio <= costRatioCap) return verdict('adopt', 'review-preferred', true)
  return verdict('reject', 'no-improvement')
}

// ---------------------------------------------------------------------------
// Decisions and rollback
// ---------------------------------------------------------------------------

/** What a decision concluded. */
export type DecisionOutcome = 'adopted' | 'rejected' | 'awaiting-approval' | 'rolled-back'

/** Every outcome. */
export const DECISION_OUTCOMES: readonly DecisionOutcome[] = ['adopted', 'rejected', 'awaiting-approval', 'rolled-back']

/**
 * `.nexgent/capabilities/decisions/<id>.json`, written once (`wx`). Every
 * activation revision names one; rejected and awaiting-approval decisions
 * have no revision. A ledger `capability.decision` record points to it.
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
  readonly candidateId?: string
  readonly trialId?: string
  /** Adopted version when the decision was made. */
  readonly fromVersion: CapabilityVersion
  /** Version in force afterwards (equals `fromVersion` for rejected and awaiting-approval). */
  readonly toVersion: CapabilityVersion
  /** Revision written for it (adopted, rolled-back). */
  readonly revision?: number
  /** Gate evidence: the verdict and the per-arm costs (trial decisions only). */
  readonly verdict?: TrialVerdict
  readonly cost?: { readonly candidate: TrialCost; readonly baseline: TrialCost; readonly review: TrialCost }
  /** Rollback evidence: the tasks and checks that triggered it (rollback decisions only). */
  readonly regression?: UsageRegressionEvidence
  /** Human-readable explanation, at most {@link CAPABILITY_LIMITS.maxReasonChars} characters. */
  readonly detail: string
}

/** One root task observed on a newly adopted version. */
export interface UsageObservation {
  readonly taskId: string
  readonly checksPassed: number
  readonly checksTotal: number
  /** Calls of the version's new components in this task, in order: `true` = error. */
  readonly componentErrors: readonly boolean[]
}

/** Evidence a usage-regression rollback records. */
export interface UsageRegressionEvidence {
  readonly observations: readonly UsageObservation[]
  /** Baseline pass rate the gate measured (selection set). */
  readonly baselinePassRate: number
  readonly passRate: number
  readonly consecutiveErrors: number
}

/**
 * The usage-regression rule (decision 6), pure. Observations are the first
 * root tasks that ran on the newly adopted version, in order. Rolls back with
 * `component-errors` as soon as the new components' calls error
 * `consecutiveErrors` times in a row (across tasks), and with
 * `usage-regression` once `windowTasks` tasks are in and their check pass rate
 * is below the gate's baseline rate. Returns `undefined` while neither holds
 * (including after the window, when monitoring stops).
 */
export function decideUsageRollback(
  observations: readonly UsageObservation[],
  baselinePassRate: number,
  rule: CapabilitiesConfig['rollback'],
): { readonly reason: 'component-errors' | 'usage-regression'; readonly evidence: UsageRegressionEvidence } | undefined {
  const window = observations.slice(0, rule.windowTasks)
  let run = 0
  let longest = 0
  for (const call of window.flatMap(observation => observation.componentErrors)) {
    run = call ? run + 1 : 0
    longest = Math.max(longest, run)
  }
  const passed = window.reduce((sum, observation) => sum + observation.checksPassed, 0)
  const total = window.reduce((sum, observation) => sum + observation.checksTotal, 0)
  const passRate = total === 0 ? 1 : passed / total
  const evidence: UsageRegressionEvidence = { observations: window, baselinePassRate, passRate, consecutiveErrors: longest }
  if (longest >= rule.consecutiveErrors) return { reason: 'component-errors', evidence }
  if (window.length === rule.windowTasks && total > 0 && passRate < baselinePassRate) return { reason: 'usage-regression', evidence }
  return undefined
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
// Project settings
// ---------------------------------------------------------------------------

/** Reviewer-model settings (decision 5). */
export interface ReviewerSettings {
  readonly model: string
  readonly thinking: ThinkingMode
}

/** A trial budget, counted like a cost cap. */
export interface TrialBudget {
  readonly maxTokens?: number
  readonly maxRequests?: number
}

/**
 * `.nexgent/config.json` `capabilities`: gate and rollback settings. Writing
 * it always needs approval (like `approvals`, `costCaps`, `sandboxMode`); no
 * capability component can carry these fields.
 */
export interface CapabilitiesConfig {
  /** Start a trial in a separate process when a task that proposed a candidate ends (decision 3); default `true`. */
  readonly autoTrial: boolean
  /** Budget of one trial (all runs and reviews); default `{ maxRequests: 400, maxTokens: 8 000 000 }`. */
  readonly trialBudget: TrialBudget
  /** Selection cases per trial; at least 2 (default 2). Too few past tasks: the gate waits. */
  readonly selectionCases: number
  /** Guard cases per trial; at least 1 (default 1). */
  readonly guardCases: number
  /** Runs per arm per case, 1–5 (default 2). */
  readonly repeats: number
  /** Candidate / baseline token ratio allowed when quality rises, 1–10 (default 1.2). */
  readonly costRatioCap: number
  /** Default `{ model: 'claude-sonnet-5-5', thinking: 'on' }`. */
  readonly reviewer: ReviewerSettings
  /** Usage-regression watch after an adoption (decision 6). */
  readonly rollback: {
    /** Root tasks watched, 1–20 (default 3). */
    readonly windowTasks: number
    /** Consecutive erroring calls of new components that roll back, 1–20 (default 3). */
    readonly consecutiveErrors: number
  }
}

/** Defaults of {@link CapabilitiesConfig}. */
export const DEFAULT_CAPABILITIES_CONFIG: CapabilitiesConfig = Object.freeze({
  autoTrial: true,
  trialBudget: Object.freeze({ maxRequests: 400, maxTokens: 8_000_000 }),
  selectionCases: 2,
  guardCases: 1,
  repeats: 2,
  costRatioCap: 1.2,
  reviewer: Object.freeze({ model: 'claude-sonnet-5-5', thinking: 'on' as ThinkingMode }),
  rollback: Object.freeze({ windowTasks: 3, consecutiveErrors: 3 }),
}) as CapabilitiesConfig

/** A partial `capabilities` object as written in the config file. */
export interface CapabilitiesConfigInput {
  readonly autoTrial?: boolean
  readonly trialBudget?: TrialBudget
  readonly selectionCases?: number
  readonly guardCases?: number
  readonly repeats?: number
  readonly costRatioCap?: number
  readonly reviewer?: Partial<ReviewerSettings>
  readonly rollback?: Partial<CapabilitiesConfig['rollback']>
}

/** Fill a validated partial `capabilities` object with defaults (pure). */
export function resolveCapabilitiesConfig(input: CapabilitiesConfigInput = {}): CapabilitiesConfig {
  const d = DEFAULT_CAPABILITIES_CONFIG
  return {
    autoTrial: input.autoTrial ?? d.autoTrial,
    trialBudget: input.trialBudget ?? d.trialBudget,
    selectionCases: input.selectionCases ?? d.selectionCases,
    guardCases: input.guardCases ?? d.guardCases,
    repeats: input.repeats ?? d.repeats,
    costRatioCap: input.costRatioCap ?? d.costRatioCap,
    reviewer: { model: input.reviewer?.model ?? d.reviewer.model, thinking: input.reviewer?.thinking ?? d.reviewer.thinking },
    rollback: {
      windowTasks: input.rollback?.windowTasks ?? d.rollback.windowTasks,
      consecutiveErrors: input.rollback?.consecutiveErrors ?? d.rollback.consecutiveErrors,
    },
  }
}

/**
 * Validate the `capabilities` field of `.nexgent/config.json`. Minimums are
 * floors, not defaults: a config can ask for more replay cases, never fewer
 * (plan 4.5: too little history makes the gate wait, it does not lower the bar).
 * @throws `config/invalid` naming the field.
 */
export function assertCapabilitiesConfig(value: unknown): asserts value is CapabilitiesConfigInput {
  const fail = (field: string, message: string): never => {
    throw new NexgentError('config/invalid', `.nexgent/config.json: capabilities.${field} ${message}`, { details: { field: `capabilities.${field}` } })
  }
  if (!isRecord(value)) throw new NexgentError('config/invalid', '.nexgent/config.json: capabilities must be an object', { details: { field: 'capabilities' } })
  const known = ['autoTrial', 'trialBudget', 'selectionCases', 'guardCases', 'repeats', 'costRatioCap', 'reviewer', 'rollback']
  for (const key of Object.keys(value)) if (!known.includes(key)) fail(key, 'is not a known field')
  const integer = (field: string, entry: unknown, min: number, max: number) => {
    if (entry === undefined) return
    if (typeof entry !== 'number' || !Number.isInteger(entry) || entry < min || entry > max) fail(field, `must be an integer in ${min}..${max}`)
  }
  if (value.autoTrial !== undefined && typeof value.autoTrial !== 'boolean') fail('autoTrial', 'must be a boolean')
  if (value.trialBudget !== undefined) {
    if (!isRecord(value.trialBudget)) fail('trialBudget', 'must be an object')
    const budget = value.trialBudget as Record<string, unknown>
    for (const key of Object.keys(budget)) if (key !== 'maxTokens' && key !== 'maxRequests') fail(`trialBudget.${key}`, 'is not a known field')
    integer('trialBudget.maxTokens', budget.maxTokens, 1, Number.MAX_SAFE_INTEGER)
    integer('trialBudget.maxRequests', budget.maxRequests, 1, Number.MAX_SAFE_INTEGER)
  }
  integer('selectionCases', value.selectionCases, 2, 50)
  integer('guardCases', value.guardCases, 1, 50)
  integer('repeats', value.repeats, 1, 5)
  if (value.costRatioCap !== undefined && (typeof value.costRatioCap !== 'number' || !Number.isFinite(value.costRatioCap) || value.costRatioCap < 1 || value.costRatioCap > 10)) {
    fail('costRatioCap', 'must be a number in 1..10')
  }
  if (value.reviewer !== undefined) {
    if (!isRecord(value.reviewer)) fail('reviewer', 'must be an object')
    const reviewer = value.reviewer as Record<string, unknown>
    for (const key of Object.keys(reviewer)) if (key !== 'model' && key !== 'thinking') fail(`reviewer.${key}`, 'is not a known field')
    if (reviewer.model !== undefined && (typeof reviewer.model !== 'string' || reviewer.model.trim() === '')) fail('reviewer.model', 'must be a non-empty string')
    if (reviewer.thinking !== undefined && reviewer.thinking !== 'on' && reviewer.thinking !== 'off') fail('reviewer.thinking', 'must be "on" or "off"')
  }
  if (value.rollback !== undefined) {
    if (!isRecord(value.rollback)) fail('rollback', 'must be an object')
    const rollback = value.rollback as Record<string, unknown>
    for (const key of Object.keys(rollback)) if (key !== 'windowTasks' && key !== 'consecutiveErrors') fail(`rollback.${key}`, 'is not a known field')
    integer('rollback.windowTasks', rollback.windowTasks, 1, 20)
    integer('rollback.consecutiveErrors', rollback.consecutiveErrors, 1, 20)
  }
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
