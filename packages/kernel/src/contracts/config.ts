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
import {
  resolveLearningConfig,
  type LearningConfig,
  type LearningConfigInput,
  type UserLearningSettings,
} from './learning.js'
import type { Effort, ThinkingMode } from './llm.js'
import type { SandboxMode } from './workspace.js'

/**
 * A spending ceiling; `permissions.md` §费用上限 defines counting and what
 * happens on reaching it. ADR 0017 decision 5 makes `maxUsd` the primary
 * field (estimated from the price table, cache included); the token and
 * request fields stay valid, and whichever limit is reached first applies.
 */
export interface CostCap {
  /** Max estimated USD before the turn is cancelled with cause `cost-cap`; a warning is emitted at {@link COST_WARNING_RATIO}. */
  readonly maxUsd?: number
  /** Max tokens (input + output) before the turn is cancelled with cause `cost-cap`. */
  readonly maxTokens?: number
  /** Max model requests, failed ones included. */
  readonly maxRequests?: number
  /** `perProject` only: the ledger window the totals are summed over; default 30. */
  readonly windowDays?: number
}

/** The scopes a cap can apply to (ADR 0017 decision 5). */
export type CostCapScope = 'perTask' | 'perConversation' | 'perProject'

/** Every {@link CostCapScope}. */
export const COST_CAP_SCOPES: readonly CostCapScope[] = ['perTask', 'perConversation', 'perProject']

/** `.nexgent/config.json` `costCaps`. */
export interface CostCaps {
  /** One root task: the turn and every subagent, team member and workflow node it starts. */
  readonly perTask?: CostCap
  /** One conversation (session), all its turns. */
  readonly perConversation?: CostCap
  /** The whole project over `windowDays`. */
  readonly perProject?: CostCap
}

/** Share of a cap at which the host emits one `cost.warning` (ADR 0017 decision 5). */
export const COST_WARNING_RATIO = 0.8

/** Where spending stands against a cap. */
export type CostCapLevel = 'ok' | 'warning' | 'reached'

/** Every {@link CostCapLevel} a warning record may carry. */
export const COST_WARNING_LEVELS: readonly Exclude<CostCapLevel, 'ok'>[] = ['warning', 'reached']

/** Spending to compare with a cap. */
export interface CostCapUsage {
  readonly usd: number
  readonly tokens: number
  readonly requests: number
}

/**
 * The level of a cap (pure): `reached` once any set limit is met, `warning`
 * once any reaches {@link COST_WARNING_RATIO} of its limit, else `ok`. A
 * limit of 0 is reached at once.
 */
export function costCapLevel(cap: CostCap, used: CostCapUsage): CostCapLevel {
  const pairs: [number | undefined, number][] = [[cap.maxUsd, used.usd], [cap.maxTokens, used.tokens], [cap.maxRequests, used.requests]]
  let level: CostCapLevel = 'ok'
  for (const [limit, value] of pairs) {
    if (limit === undefined) continue
    if (value >= limit) return 'reached'
    if (value >= limit * COST_WARNING_RATIO) level = 'warning'
  }
  return level
}

/** Largest `maxUsd` the validator accepts. */
export const MAX_COST_CAP_USD = 100_000

/**
 * Validate a `costCaps` object as read from disk (pure); both config readers
 * use it so they accept the same files. `fail` receives the field path and a
 * message that already names it.
 */
export function checkCostCaps(value: unknown, fail: (field: string, message: string) => never): asserts value is CostCaps {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('costCaps', 'costCaps must be an object')
  for (const [scope, cap] of Object.entries(value as Record<string, unknown>)) {
    const field = `costCaps.${scope}`
    if (!(COST_CAP_SCOPES as readonly string[]).includes(scope)) fail(field, `unknown field ${field}`)
    if (cap === null || typeof cap !== 'object' || Array.isArray(cap)) fail(field, `${field} must be an object`)
    for (const [key, raw] of Object.entries(cap as Record<string, unknown>)) {
      const sub = `${field}.${key}`
      if (key === 'maxUsd') {
        if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > MAX_COST_CAP_USD) fail(sub, `${sub} must be a number from 0 to ${MAX_COST_CAP_USD}`)
        continue
      }
      if (key !== 'maxTokens' && key !== 'maxRequests' && !(scope === 'perProject' && key === 'windowDays')) fail(sub, `unknown field ${sub}`)
      if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) fail(sub, `${sub} must be a non-negative integer`)
    }
  }
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
  readonly costCaps: CostCaps
  /** `project`-scope approval grants; default `[]`. Changing it always needs approval. */
  readonly approvals: readonly ApprovalGrant[]
  /** Absolute directories readable besides the project root (`permissions.md` §路径策略); default `[]`. */
  readonly extraReadRoots: readonly string[]
  /**
   * Whether counted feedback and failed checks start improvement jobs on
   * their own (step 5); default `true` (decision 1). An explicit "improve"
   * is not limited by it. Changing it always needs approval.
   * @deprecated ADR 0017 decision 3: read {@link ProjectConfig.learning}
   * `enabled`, which takes this value as its default.
   */
  readonly autoImprove: boolean
  /** Step 5: trigger threshold, improvement budget and model (`DEFAULT_IMPROVEMENT_CONFIG`). Changing it always needs approval. */
  readonly improvement: ImprovementConfig
  /** Step 4: gate and rollback settings (`DEFAULT_CAPABILITIES_CONFIG`). Changing it always needs approval. */
  readonly capabilities: CapabilitiesConfig
  /** ADR 0017–0019: background learning switch, dollar budget, self-eval ceiling, sharing. Changing it always needs approval. */
  readonly learning: LearningConfig
  /**
   * Model calls one turn may make before it stops with cancel cause
   * `step-limit` (the user continues by sending another message; ADR 0021).
   * Absent: the `agents` profile row's `maxSteps` (400). A member preset's
   * `maxSteps` still wins for that member. Changing it always needs approval.
   */
  readonly maxStepsPerTurn?: number
}

/**
 * Top-level config fields whose change always needs approval, whatever the
 * sandbox mode (`permissions.md` "始终审批"): a model must not widen its own
 * permissions, budgets or gate.
 */
export const GUARDED_PROJECT_CONFIG_FIELDS = ['approvals', 'costCaps', 'sandboxMode', 'capabilities', 'autoImprove', 'improvement', 'learning', 'maxStepsPerTurn'] as const

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
  learning: resolveLearningConfig(),
}) as ProjectConfig

/** A partial config as read from disk, before defaults. */
export type ProjectConfigInput = Partial<Omit<ProjectConfig, 'version' | 'capabilities' | 'improvement' | 'learning'>> & {
  readonly version?: 1
  /** Validated with `assertCapabilitiesConfig`; missing fields take their defaults. */
  readonly capabilities?: CapabilitiesConfigInput
  /** Validated with `assertImprovementConfig`; missing fields take their defaults. */
  readonly improvement?: ImprovementConfigInput
  /** Validated with `assertLearningConfig`; missing fields take their defaults (or the retired `autoImprove` / `shareImproverEvidence`). */
  readonly learning?: LearningConfigInput
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
    learning: resolveLearningConfig(input.learning, {
      ...(input.autoImprove === undefined ? {} : { autoImprove: input.autoImprove }),
      ...(input.improvement?.shareImproverEvidence === undefined ? {} : { shareImproverEvidence: input.improvement.shareImproverEvidence }),
    }),
    ...(input.maxStepsPerTurn === undefined ? {} : { maxStepsPerTurn: input.maxStepsPerTurn }),
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
  /** ADR 0017 decision 3: when the user was told about background learning (absent: not yet; learning waits). */
  readonly learning: UserLearningSettings
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
  readonly learning?: UserLearningSettings
}

/** Defaults of {@link UserConfig}. */
export const DEFAULT_USER_CONFIG: UserConfig = Object.freeze({
  version: 1,
  improvement: Object.freeze({ meta: resolveMetaImprovementConfig() }),
  learning: Object.freeze({}),
}) as UserConfig

/** Fill a validated partial user config with defaults (pure). */
export function resolveUserConfig(input: UserConfigInput = {}): UserConfig {
  return {
    version: 1,
    improvement: { meta: resolveMetaImprovementConfig(input.improvement?.meta) },
    learning: input.learning?.noticeAcknowledgedAt === undefined ? {} : { noticeAcknowledgedAt: input.learning.noticeAcknowledgedAt },
  }
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
  for (const key of Object.keys(record)) if (key !== 'version' && key !== 'improvement' && key !== 'learning') fail(key, 'is not a known field')
  if (record.version !== undefined && record.version !== 1) fail('version', 'must be 1')
  if (record.learning !== undefined) {
    if (record.learning === null || typeof record.learning !== 'object' || Array.isArray(record.learning)) fail('learning', 'must be an object')
    const learning = record.learning as Record<string, unknown>
    for (const key of Object.keys(learning)) if (key !== 'noticeAcknowledgedAt') fail(`learning.${key}`, 'is not a known field')
    const at = learning.noticeAcknowledgedAt
    if (at !== undefined && (typeof at !== 'string' || Number.isNaN(Date.parse(at)))) fail('learning.noticeAcknowledgedAt', 'must be an ISO-8601 timestamp')
  }
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
