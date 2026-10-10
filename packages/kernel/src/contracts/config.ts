/**
 * The configuration contract: the per-project `.nexgent/config.json` and the
 * application profile rows the kernel loads plugins from.
 */
import { NexgentError } from './errors.js'
import type { JsonObject, JsonValue } from './json.js'
import type { ApprovalGrant } from './approvals.js'
import type { ThinkingMode } from './llm.js'
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
  /** Model id; default `mimo-v2.6-pro`. */
  readonly model: string
  /** OpenAI-compatible base URL; default is the MiMo route. */
  readonly endpoint: string
  /** Reasoning mode for execution; default `'off'`. */
  readonly thinking: ThinkingMode
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
  /** Whether feedback-triggered improvement runs (step 5); default `false`. */
  readonly autoImprove: boolean
}

/** The defaults applied over a missing or partial config file. */
export const DEFAULT_PROJECT_CONFIG: ProjectConfig = Object.freeze({
  version: 1,
  model: 'mimo-v2.6-pro',
  endpoint: 'https://token-plan-cn.xiaomimimo.com/v1',
  thinking: 'off',
  sandboxMode: 'workspace-write',
  costCaps: Object.freeze({}),
  approvals: Object.freeze([]),
  extraReadRoots: Object.freeze([]),
  autoImprove: false,
}) as ProjectConfig

/** A partial config as read from disk, before defaults. */
export type ProjectConfigInput = Partial<Omit<ProjectConfig, 'version'>> & { readonly version?: 1 }

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
    sandboxMode: input.sandboxMode ?? DEFAULT_PROJECT_CONFIG.sandboxMode,
    costCaps: input.costCaps ?? DEFAULT_PROJECT_CONFIG.costCaps,
    approvals: input.approvals ?? DEFAULT_PROJECT_CONFIG.approvals,
    extraReadRoots: input.extraReadRoots ?? DEFAULT_PROJECT_CONFIG.extraReadRoots,
    autoImprove: input.autoImprove ?? DEFAULT_PROJECT_CONFIG.autoImprove,
  }
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
