/**
 * Reader for `.nexgent/config.json` (`data-formats.md` §项目配置文件): a
 * missing file equals `{}`, unknown fields, wrong types and a version other
 * than 1 are `config/invalid` (fields of removed features are ignored), and missing fields take
 * {@link DEFAULT_PROJECT_CONFIG} values.
 */
import { NexgentError } from './contracts/errors.js'
import { checkCommandsProblem, checkCostCaps, MAX_CHECK_RETRIES, RETIRED_CONFIG_FIELDS, resolveProjectConfig, type ProjectConfig, type ProjectConfigInput } from './contracts/config.js'
import { assertLearningConfig } from './contracts/learning.js'
import type { ApprovalGrant } from './contracts/approvals.js'
import { EFFORT_LEVELS, type Effort } from './contracts/llm.js'
import { SANDBOX_MODES, type SandboxMode, type WorkspaceLayout } from './contracts/workspace.js'
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
  'version', 'model', 'endpoint', 'thinking', 'effort', 'sandboxMode', 'costCaps', 'approvals', 'extraReadRoots', 'learning',
  'maxStepsPerTurn', 'checkRetries', 'checkCommands',
])

function fail(path: string, message: string): never {
  throw new NexgentError('config/invalid', `${path}: ${message}`, { details: { path } })
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
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
    if (!KNOWN_FIELDS.has(key) && !RETIRED_CONFIG_FIELDS.includes(key)) fail(path, `unknown field ${key}`)
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
    const caps = value.costCaps
    checkCostCaps(caps, (_field, message) => fail(path, message))
    input.costCaps = caps
  }
  if (value.approvals !== undefined) {
    if (!Array.isArray(value.approvals)) fail(path, 'approvals must be an array')
    input.approvals = value.approvals.map((grant, index) => parseGrant(path, index, grant))
  }
  if (value.maxStepsPerTurn !== undefined) {
    if (typeof value.maxStepsPerTurn !== 'number' || !Number.isSafeInteger(value.maxStepsPerTurn) || value.maxStepsPerTurn < 1) {
      fail(path, 'maxStepsPerTurn must be a positive integer')
    }
    input.maxStepsPerTurn = value.maxStepsPerTurn
  }
  if (value.checkRetries !== undefined) {
    if (typeof value.checkRetries !== 'number' || !Number.isSafeInteger(value.checkRetries) || value.checkRetries < 0 || value.checkRetries > MAX_CHECK_RETRIES) {
      fail(path, `checkRetries must be an integer from 0 to ${MAX_CHECK_RETRIES}`)
    }
    input.checkRetries = value.checkRetries
  }
  if (value.checkCommands !== undefined) {
    const problem = checkCommandsProblem(value.checkCommands)
    if (problem !== undefined) fail(path, problem)
    input.checkCommands = value.checkCommands as string[]
  }
  if (value.learning !== undefined) {
    try {
      assertLearningConfig(value.learning)
    } catch (error) {
      fail(path, (error as Error).message.replace('.nexgent/config.json: ', ''))
    }
    input.learning = value.learning
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

/**
 * Read a project's config at its data location (K1, ADR 0017 decision 4):
 * when the data is in the user data directory the `project`-scope grants
 * come from `grants.json` there and `config.json.approvals` is ignored, so
 * a cloned project never brings someone else's grants.
 */
export async function readProjectSettings(layout: Pick<WorkspaceLayout, 'configFile' | 'grantsFile'>): Promise<LoadedProjectConfig> {
  const loaded = await readProjectConfig(layout.configFile)
  if (layout.grantsFile === undefined) return loaded
  const approvals = await readProjectGrants(layout.grantsFile)
  const input = { ...loaded.input, approvals }
  return { ...loaded, input, config: { ...loaded.config, approvals } }
}

/** The grants of `grants.json` (`ProjectGrantsFile`); a missing file has none. */
export async function readProjectGrants(path: string): Promise<ApprovalGrant[]> {
  const raw = await readJsonFile(path)
  if (raw === undefined) return []
  if (!isObject(raw) || raw.formatVersion !== 1 || !Array.isArray(raw.approvals)) fail(path, 'expected { formatVersion: 1, approvals: [] }')
  return raw.approvals.map((grant, index) => parseGrant(path, index, grant))
}

/** Append a `project`-scope grant where the project keeps them: `grants.json` in the user data directory, else `config.json.approvals`. */
export async function appendGrant(layout: Pick<WorkspaceLayout, 'configFile' | 'grantsFile'>, grant: ApprovalGrant): Promise<void> {
  if (layout.grantsFile === undefined) return appendProjectGrant(layout.configFile, grant)
  const approvals = await readProjectGrants(layout.grantsFile)
  await writeJsonFile(layout.grantsFile, { formatVersion: 1, approvals: [...approvals, grant] }, { mode: 0o600 })
}
