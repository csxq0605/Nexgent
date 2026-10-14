/**
 * The configuration contract: the per-project `.nexgent/config.json`, the
 * user-level `<NEXGENT_HOME>/config.json` (ADR 0012) and the application
 * profile rows the kernel loads plugins from.
 */
import { NexgentError } from './errors.js'
import type { JsonObject, JsonValue } from './json.js'
import type { ApprovalGrant } from './approvals.js'
import { resolveCapabilitiesConfig, type CapabilitiesConfig, type CapabilitiesConfigInput } from './capabilities.js'
import {
  checkMetaImprovementConfig,
  resolveImprovementConfig,
  resolveMetaImprovementConfig,
  type ImprovementConfig,
  type ImprovementConfigInput,
  type MetaImprovementConfig,
  type MetaImprovementConfigInput,
} from './improvement.js'
import type { Effort, ThinkingMode } from './llm.js'
import type { SandboxMode } from './workspace.js'

/** A spending ceiling; `permissions.md` §费用上限 defines counting and what happens on reaching it. */
export interface CostCap {
  /** Max tokens (input + output) before the turn is cancelled with cause `cost-cap`. */
  readonly maxTokens?: number
  /** Max model requests, failed ones included. */
  readonly maxRequests?: number
  /** `perProject` only: the ledger window the totals are summed over; default 30. */
  readonly windowDays?: number
}

/** `.nexgent/config.json`. Every field has a default; a missing file equals `{}`. */
export interface ProjectConfig {
  /** Format version; only 1 exists. */
  readonly version: 1
  /** Model id; default `claude-sonnet-5-5` (ADR 0002). */
  readonly model: string
  /** Claude API base URL (no path, no credentials); default `https://api.anthropic.com`. */
  readonly endpoint: string
  /** Reasoning mode for execution; default `'on'` (adaptive thinking, ADR 0003); `'off'` is the provider's lowest setting. */
  readonly thinking: ThinkingMode
  /** Effort level; default `'medium'` (agentic coding and multistep tool use). */
  readonly effort: Effort
  /** Default sandbox mode for new sessions; default `'workspace-write'`. */
  readonly sandboxMode: SandboxMode
  /** Cost ceilings. */
  readonly costCaps: {
    readonly perTask?: CostCap
    readonly perProject?: CostCap
  }
  /** `project`-scope approval grants; default `[]`. Changing it always needs approval. */
  readonly approvals: readonly ApprovalGrant[]
  /** Absolute directories readable besides the project root (`permissions.md` §路径策略); default `[]`. */
  readonly extraReadRoots: readonly string[]
  /**
   * Whether counted feedback and failed checks start improvement jobs on
   * their own (step 5); default `true` (decision 1). An explicit "improve"
   * is not limited by it. Changing it always needs approval.
   */
  readonly autoImprove: boolean
  /** Step 5: trigger threshold, improvement budget and model (`DEFAULT_IMPROVEMENT_CONFIG`). Changing it always needs approval. */
  readonly improvement: ImprovementConfig
  /** Step 4: gate and rollback settings (`DEFAULT_CAPABILITIES_CONFIG`). Changing it always needs approval. */
  readonly capabilities: CapabilitiesConfig
}

/**
 * Top-level config fields whose change always needs approval, whatever the
 * sandbox mode (`permissions.md` "始终审批"): a model must not widen its own
 * permissions, budgets or gate.
 */
export const GUARDED_PROJECT_CONFIG_FIELDS = ['approvals', 'costCaps', 'sandboxMode', 'capabilities', 'autoImprove', 'improvement'] as const

/** The defaults applied over a missing or partial config file. */
export const DEFAULT_PROJECT_CONFIG: ProjectConfig = Object.freeze({
  version: 1,
  model: 'claude-sonnet-5-5',
  endpoint: 'https://api.anthropic.com',
  thinking: 'on',
  effort: 'medium',
  sandboxMode: 'workspace-write',
  costCaps: Object.freeze({}),
  approvals: Object.freeze([]),
  extraReadRoots: Object.freeze([]),
  autoImprove: true,
  capabilities: resolveCapabilitiesConfig(),
  improvement: resolveImprovementConfig(),
}) as ProjectConfig

/** A partial config as read from disk, before defaults. */
export type ProjectConfigInput = Partial<Omit<ProjectConfig, 'version' | 'capabilities' | 'improvement'>> & {
  readonly version?: 1
  /** Validated with `assertCapabilitiesConfig`; missing fields take their defaults. */
  readonly capabilities?: CapabilitiesConfigInput
  /** Validated with `assertImprovementConfig`; missing fields take their defaults. */
  readonly improvement?: ImprovementConfigInput
}

/**
 * Fill a partial config with {@link DEFAULT_PROJECT_CONFIG}. Pure; schema
 * validation happens in the loader before this.
 */
export function resolveProjectConfig(input: ProjectConfigInput = {}): ProjectConfig {
  return {
    version: 1,
    model: input.model ?? DEFAULT_PROJECT_CONFIG.model,
    endpoint: input.endpoint ?? DEFAULT_PROJECT_CONFIG.endpoint,
    thinking: input.thinking ?? DEFAULT_PROJECT_CONFIG.thinking,
    effort: input.effort ?? DEFAULT_PROJECT_CONFIG.effort,
    sandboxMode: input.sandboxMode ?? DEFAULT_PROJECT_CONFIG.sandboxMode,
    costCaps: input.costCaps ?? DEFAULT_PROJECT_CONFIG.costCaps,
    approvals: input.approvals ?? DEFAULT_PROJECT_CONFIG.approvals,
    extraReadRoots: input.extraReadRoots ?? DEFAULT_PROJECT_CONFIG.extraReadRoots,
    autoImprove: input.autoImprove ?? DEFAULT_PROJECT_CONFIG.autoImprove,
    capabilities: resolveCapabilitiesConfig(input.capabilities),
    improvement: resolveImprovementConfig(input.improvement),
  }
}

// ---------------------------------------------------------------------------
// User config (ADR 0012)
// ---------------------------------------------------------------------------

/** `config.json` below the Nexgent home (`~/.nexgent`, or `NEXGENT_HOME`). */
export const USER_CONFIG_FILE_NAME = 'config.json'

/**
 * `<NEXGENT_HOME>/config.json` (ADR 0012 decision 3): settings shared by
 * every project of the user. A missing file equals `{}`; unknown fields are
 * `config/invalid`. Only the meta-job settings live here so far; the
 * improver itself is the user-level version line `<NEXGENT_HOME>/improvers/`.
 */
export interface UserConfig {
  /** Format version; only 1 exists. */
  readonly version: 1
  readonly improvement: {
    /** Meta jobs over the shared improver: switch (default off), `everyJobs`, the meta budget, the model. */
    readonly meta: MetaImprovementConfig
  }
}

/**
 * User config fields whose change always needs approval when a model asks
 * for it (the settings page is a user action); the file lies outside every
 * project, so file tools cannot reach it anyway.
 */
export const GUARDED_USER_CONFIG_FIELDS = ['improvement'] as const

/** A partial user config as read from disk, before defaults. */
export interface UserConfigInput {
  readonly version?: 1
  readonly improvement?: { readonly meta?: MetaImprovementConfigInput }
}

/** Defaults of {@link UserConfig}. */
export const DEFAULT_USER_CONFIG: UserConfig = Object.freeze({
  version: 1,
  improvement: Object.freeze({ meta: resolveMetaImprovementConfig() }),
}) as UserConfig

/** Fill a validated partial user config with defaults (pure). */
export function resolveUserConfig(input: UserConfigInput = {}): UserConfig {
  return { version: 1, improvement: { meta: resolveMetaImprovementConfig(input.improvement?.meta) } }
}

/**
 * Validate a user config as read from disk (pure).
 * @throws `config/invalid` with `details.field` naming the field path.
 */
export function assertUserConfig(value: unknown): asserts value is UserConfigInput {
  const fail = (field: string, message: string): never => {
    throw new NexgentError('config/invalid', `${USER_CONFIG_FILE_NAME} (Nexgent home): ${field} ${message}`, { details: { field } })
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('config', 'must be an object')
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) if (key !== 'version' && key !== 'improvement') fail(key, 'is not a known field')
  if (record.version !== undefined && record.version !== 1) fail('version', 'must be 1')
  if (record.improvement === undefined) return
  if (record.improvement === null || typeof record.improvement !== 'object' || Array.isArray(record.improvement)) fail('improvement', 'must be an object')
  const improvement = record.improvement as Record<string, unknown>
  for (const key of Object.keys(improvement)) if (key !== 'meta') fail(`improvement.${key}`, 'is not a known field')
  if (improvement.meta !== undefined) checkMetaImprovementConfig(improvement.meta, (field, message) => fail(`improvement.${field}`, message))
}

/**
 * One plugin row of an application profile (the YAML the kernel boots from).
 * `name` is the plugin module or service name; `config` is validated by that
 * plugin's schemastery `Config`.
 */
export interface AppProfileRow {
  /** Stable row id, unique within a profile; patches address rows by it. */
  readonly id: string
  /** Plugin to load, e.g. `@nexgent/llm`. */
  readonly name: string
  /** Plugin config; absent means defaults. */
  readonly config?: JsonObject
  /** Skip loading without deleting the row. */
  readonly disabled?: boolean
}

/** A profile: ordered rows. */
export type AppProfile = readonly AppProfileRow[]

/** Add rows that do not exist yet (ids must be new). */
export interface AppProfileInsert {
  readonly insert: readonly AppProfileRow[]
}

/**
 * Change an existing row by id: `config` deep-merges into the row's config
 * (objects merge recursively, arrays and scalars replace), `disabled` and
 * `name` replace when present.
 */
export interface AppProfilePatch {
  readonly id: string
  readonly name?: string
  readonly config?: JsonObject
  readonly disabled?: boolean
}

/** One entry of a patch file (`cordis.patch.yml` style): an insert block or a row patch. */
export type AppProfilePatchEntry = AppProfileInsert | AppProfilePatch

/** Whether an entry is an insert block. */
export function isProfileInsert(entry: AppProfilePatchEntry): entry is AppProfileInsert {
  return 'insert' in entry
}

function isPlainObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Deep-merge JSON objects: nested objects merge, everything else is replaced by `patch`. */
export function mergeJsonObjects(base: JsonObject, patch: JsonObject): JsonObject {
  const result: Record<string, JsonValue> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    const existing = result[key]
    result[key] = isPlainObject(existing) && isPlainObject(value) ? mergeJsonObjects(existing, value) : value
  }
  return result
}

/**
 * Apply patch entries to a profile in order. Pure; returns a new profile.
 * @throws `config/profile-patch` on a duplicate insert id or a patch naming an unknown id.
 */
export function applyProfilePatches(profile: AppProfile, entries: readonly AppProfilePatchEntry[]): AppProfile {
  const rows: AppProfileRow[] = [...profile]
  for (const entry of entries) {
    if (isProfileInsert(entry)) {
      for (const row of entry.insert) {
        if (rows.some(existing => existing.id === row.id)) {
          throw new NexgentError('config/profile-patch', `profile insert duplicates row id "${row.id}"`)
        }
        rows.push(row)
      }
      continue
    }
    const index = rows.findIndex(row => row.id === entry.id)
    const current = rows[index]
    if (current === undefined) {
      throw new NexgentError('config/profile-patch', `profile patch names unknown row id "${entry.id}"`)
    }
    const config = entry.config === undefined
      ? current.config
      : mergeJsonObjects(current.config ?? {}, entry.config)
    const disabled = entry.disabled ?? current.disabled
    rows[index] = {
      id: current.id,
      name: entry.name ?? current.name,
      ...(config === undefined ? {} : { config }),
      ...(disabled === undefined ? {} : { disabled }),
    }
  }
  return rows
}
