/**
 * Reader for `.nexgent/config.json` (`data-formats.md` §项目配置文件): a
 * missing file equals `{}`, unknown fields, wrong types and a version other
 * than 1 are `config/invalid`, and missing fields take
 * {@link DEFAULT_PROJECT_CONFIG} values.
 */
import { NexgentError } from './contracts/errors.js'
import { resolveProjectConfig, type CostCap, type ProjectConfig, type ProjectConfigInput } from './contracts/config.js'
import type { ApprovalGrant } from './contracts/approvals.js'
import { EFFORT_LEVELS, type Effort } from './contracts/llm.js'
import { SANDBOX_MODES, type SandboxMode } from './contracts/workspace.js'
import { readJsonFile, writeJsonFile } from './storage/json-file.js'

/** A loaded project config: the resolved values plus what the file actually set. */
export interface LoadedProjectConfig {
  /** Defaults filled in. */
  readonly config: ProjectConfig
  /** Only the fields present in the file. */
  readonly input: ProjectConfigInput
  /** `permissions.md` §路径策略 `extraReadRoots` (not yet part of the contract type). */
  readonly extraReadRoots: readonly string[]
}

const KNOWN_FIELDS = new Set([
  'version', 'model', 'endpoint', 'thinking', 'effort', 'sandboxMode', 'costCaps', 'approvals', 'autoImprove', 'extraReadRoots',
])

function fail(path: string, message: string): never {
  throw new NexgentError('config/invalid', `${path}: ${message}`, { details: { path } })
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseCap(path: string, field: string, value: unknown, allowWindow: boolean): CostCap {
  if (!isObject(value)) fail(path, `${field} must be an object`)
  const cap: { maxTokens?: number; maxRequests?: number; windowDays?: number } = {}
  for (const [key, raw] of Object.entries(value)) {
    if (key !== 'maxTokens' && key !== 'maxRequests' && !(allowWindow && key === 'windowDays')) {
      fail(path, `unknown field ${field}.${key}`)
    }
    if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) {
      fail(path, `${field}.${key} must be a non-negative integer`)
    }
    cap[key as 'maxTokens'] = raw
  }
  return cap
}

function parseGrant(path: string, index: number, value: unknown): ApprovalGrant {
  if (!isObject(value)) fail(path, `approvals[${index}] must be an object`)
  for (const key of Object.keys(value)) {
    if (key !== 'tool' && key !== 'pattern' && key !== 'grantedAt') fail(path, `unknown field approvals[${index}].${key}`)
  }
  if (typeof value.tool !== 'string' || value.tool === '') fail(path, `approvals[${index}].tool must be a string`)
  if (value.pattern !== undefined && typeof value.pattern !== 'string') fail(path, `approvals[${index}].pattern must be a string`)
  if (typeof value.grantedAt !== 'string') fail(path, `approvals[${index}].grantedAt must be a string`)
  return {
    tool: value.tool,
    ...(value.pattern === undefined ? {} : { pattern: value.pattern as string }),
    grantedAt: value.grantedAt,
  }
}

/**
 * Validate a parsed `config.json` value.
 * @param value - the parsed JSON (`undefined` = missing file).
 * @param path - file path for messages.
 * @throws `config/invalid` on any shape error.
 */
export function parseProjectConfig(value: unknown, path = 'config.json'): LoadedProjectConfig {
  if (value === undefined) return { config: resolveProjectConfig({}), input: {}, extraReadRoots: [] }
  if (!isObject(value)) fail(path, 'expected a JSON object')
  for (const key of Object.keys(value)) {
    if (!KNOWN_FIELDS.has(key)) fail(path, `unknown field ${key}`)
  }
  const input: { -readonly [K in keyof ProjectConfigInput]: ProjectConfigInput[K] } = {}
  if (value.version !== undefined) {
    if (value.version !== 1) fail(path, 'version must be 1')
    input.version = 1
  }
  for (const key of ['model', 'endpoint'] as const) {
    if (value[key] === undefined) continue
    if (typeof value[key] !== 'string' || value[key] === '') fail(path, `${key} must be a non-empty string`)
    input[key] = value[key] as string
  }
  if (value.thinking !== undefined) {
    if (value.thinking !== 'off' && value.thinking !== 'on') fail(path, 'thinking must be "off" or "on"')
    input.thinking = value.thinking
  }
  if (value.effort !== undefined) {
    if (!EFFORT_LEVELS.includes(value.effort as Effort)) fail(path, `effort must be one of ${EFFORT_LEVELS.join(', ')}`)
    input.effort = value.effort as Effort
  }
  if (value.sandboxMode !== undefined) {
    if (!SANDBOX_MODES.includes(value.sandboxMode as SandboxMode)) {
      fail(path, `sandboxMode must be one of ${SANDBOX_MODES.join(', ')}`)
    }
    input.sandboxMode = value.sandboxMode as SandboxMode
  }
  if (value.costCaps !== undefined) {
    if (!isObject(value.costCaps)) fail(path, 'costCaps must be an object')
    const caps: { perTask?: CostCap; perProject?: CostCap } = {}
    for (const [key, raw] of Object.entries(value.costCaps)) {
      if (key === 'perTask') caps.perTask = parseCap(path, 'costCaps.perTask', raw, false)
      else if (key === 'perProject') caps.perProject = parseCap(path, 'costCaps.perProject', raw, true)
      else fail(path, `unknown field costCaps.${key}`)
    }
    input.costCaps = caps
  }
  if (value.approvals !== undefined) {
    if (!Array.isArray(value.approvals)) fail(path, 'approvals must be an array')
    input.approvals = value.approvals.map((grant, index) => parseGrant(path, index, grant))
  }
  if (value.autoImprove !== undefined) {
    if (typeof value.autoImprove !== 'boolean') fail(path, 'autoImprove must be a boolean')
    input.autoImprove = value.autoImprove
  }
  let extraReadRoots: string[] = []
  if (value.extraReadRoots !== undefined) {
    if (!Array.isArray(value.extraReadRoots) || value.extraReadRoots.some(root => typeof root !== 'string')) {
      fail(path, 'extraReadRoots must be an array of strings')
    }
    extraReadRoots = value.extraReadRoots as string[]
  }
  return { config: resolveProjectConfig(input), input, extraReadRoots }
}

/** Read and validate a project config file; a missing file yields the defaults. */
export async function readProjectConfig(path: string): Promise<LoadedProjectConfig> {
  return parseProjectConfig(await readJsonFile(path), path)
}

/**
 * Append a `project`-scope grant to `config.json.approvals`, keeping every
 * other field byte-for-byte as parsed. A default writer hosts may use as the
 * project-grant hook of `ctx.agents`.
 */
export async function appendProjectGrant(path: string, grant: ApprovalGrant): Promise<void> {
  const raw = await readJsonFile(path)
  parseProjectConfig(raw, path)
  const current = (raw ?? {}) as Record<string, unknown>
  const approvals = Array.isArray(current.approvals) ? current.approvals : []
  await writeJsonFile(path, { ...current, approvals: [...approvals, grant] }, { mode: 0o644 })
}
