/**
 * `.nexgent/config.json` loading and atomic writing
 * (`docs/spec/data-formats.md` §项目配置文件). The `Workspace` contract does not
 * cover config, so these are standalone functions over a {@link WorkspaceLayout}.
 */
import { randomBytes } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import * as nodePath from 'node:path'
import {
  appendGrant,
  assertLearningConfig,
  checkCostCaps,
  checkCommandsProblem,
  MAX_CHECK_RETRIES,
  EFFORT_LEVELS,
  NexgentError,
  readProjectGrants,
  SANDBOX_MODES,
  resolveProjectConfig,
  RETIRED_CONFIG_FIELDS,
  type ApprovalGrant,
  type ProjectConfig,
  type ProjectConfigInput,
  type WorkspaceLayout,
} from '@nexgent/kernel'

/**
 * The on-disk shape: every {@link ProjectConfig} field optional, plus
 * `extraReadRoots` from `permissions.md` §路径策略 (absolute paths the file
 * tools may also read; not yet part of the kernel contract).
 */
export interface ProjectConfigFile extends ProjectConfigInput {
  readonly extraReadRoots?: readonly string[]
  /** Absolute directories outside the project the tools and commands may also write (ADR 0022 decision 2). */
  readonly extraWriteRoots?: readonly string[]
  /** Command settings (ADR 0022 decision 1). */
  readonly commands?: ProjectCommandsConfig
}

/** Whether commands run in the OS sandbox: `auto` when the platform has one, `required` refuses to run without, `off` never. */
export type SystemSandboxSetting = 'auto' | 'required' | 'off'

/** `.nexgent/config.json` → `commands`. */
export interface ProjectCommandsConfig {
  /** Whether commands may reach the network; default `true`. Enforced by the OS sandbox where there is one. */
  readonly network?: boolean
  /** Default `auto`. */
  readonly systemSandbox?: SystemSandboxSetting
}

/** A loaded config: contract defaults filled in, plus the workspace-only fields. */
export interface LoadedProjectConfig extends ProjectConfig {
  /** Absolute extra read roots; default `[]`. */
  readonly extraReadRoots: readonly string[]
  /** Absolute extra write roots; default `[]`. */
  readonly extraWriteRoots: readonly string[]
  /** Command settings with defaults: network on, system sandbox `auto`. */
  readonly commands: { readonly network: boolean; readonly systemSandbox: SystemSandboxSetting }
}

/** Accepted `commands.systemSandbox` values. */
export const SYSTEM_SANDBOX_SETTINGS: readonly SystemSandboxSetting[] = ['auto', 'required', 'off']

const TOP_LEVEL_KEYS = new Set([
  'version', 'model', 'endpoint', 'thinking', 'effort', 'sandboxMode', 'costCaps', 'approvals', 'extraReadRoots', 'extraWriteRoots', 'commands', 'learning',
  'maxStepsPerTurn', 'checkRetries', 'checkCommands',
])

function invalid(message: string, field?: string): NexgentError {
  return new NexgentError('config/invalid', `.nexgent/config.json: ${message}`, field === undefined ? {} : { details: { field } })
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function checkGrant(value: unknown, index: number): ApprovalGrant {
  const field = `approvals[${index}]`
  if (!isObject(value)) throw invalid(`${field} must be an object`, field)
  for (const key of Object.keys(value)) {
    if (!['tool', 'pattern', 'grantedAt'].includes(key)) throw invalid(`unknown field ${field}.${key}`, `${field}.${key}`)
  }
  if (typeof value.tool !== 'string' || value.tool === '') throw invalid(`${field}.tool must be a non-empty string`, `${field}.tool`)
  if (value.pattern !== undefined && typeof value.pattern !== 'string') throw invalid(`${field}.pattern must be a string`, `${field}.pattern`)
  if (typeof value.grantedAt !== 'string' || Number.isNaN(Date.parse(value.grantedAt))) {
    throw invalid(`${field}.grantedAt must be an ISO-8601 timestamp`, `${field}.grantedAt`)
  }
  return value as unknown as ApprovalGrant
}

/**
 * Validate a parsed config object. Unknown fields, wrong types and a
 * `version` other than 1 throw `config/invalid`.
 */
export function validateProjectConfig(input: unknown): ProjectConfigFile {
  if (!isObject(input)) throw invalid('must be a JSON object')
  let raw: Record<string, unknown> = input
  // Fields of removed features are dropped, so older config files still load and are not written back.
  raw = Object.fromEntries(Object.entries(raw).filter(([key]) => !RETIRED_CONFIG_FIELDS.includes(key)))
  for (const key of Object.keys(raw)) if (!TOP_LEVEL_KEYS.has(key)) throw invalid(`unknown field ${key}`, key)
  if (raw.version !== undefined && raw.version !== 1) throw invalid('version must be 1', 'version')
  for (const key of ['model', 'endpoint'] as const) {
    if (raw[key] !== undefined && (typeof raw[key] !== 'string' || raw[key] === '')) throw invalid(`${key} must be a non-empty string`, key)
  }
  if (raw.thinking !== undefined && raw.thinking !== 'off' && raw.thinking !== 'on') throw invalid('thinking must be "off" or "on"', 'thinking')
  if (raw.effort !== undefined && !(EFFORT_LEVELS as readonly unknown[]).includes(raw.effort)) {
    throw invalid(`effort must be one of ${EFFORT_LEVELS.join(', ')}`, 'effort')
  }
  if (raw.sandboxMode !== undefined && !(SANDBOX_MODES as readonly unknown[]).includes(raw.sandboxMode)) {
    throw invalid(`sandboxMode must be one of ${SANDBOX_MODES.join(', ')}`, 'sandboxMode')
  }
  if (raw.maxStepsPerTurn !== undefined && !(typeof raw.maxStepsPerTurn === 'number' && Number.isSafeInteger(raw.maxStepsPerTurn) && raw.maxStepsPerTurn >= 1)) {
    throw invalid('maxStepsPerTurn must be a positive integer', 'maxStepsPerTurn')
  }
  if (raw.checkRetries !== undefined && !(typeof raw.checkRetries === 'number' && Number.isSafeInteger(raw.checkRetries) && raw.checkRetries >= 0 && raw.checkRetries <= MAX_CHECK_RETRIES)) {
    throw invalid(`checkRetries must be an integer from 0 to ${MAX_CHECK_RETRIES}`, 'checkRetries')
  }
  if (raw.checkCommands !== undefined) {
    const problem = checkCommandsProblem(raw.checkCommands)
    if (problem !== undefined) throw invalid(problem, 'checkCommands')
  }
  if (raw.costCaps !== undefined) {
    checkCostCaps(raw.costCaps, (field, message) => {
      throw invalid(message, field)
    })
  }
  if (raw.approvals !== undefined) {
    if (!Array.isArray(raw.approvals)) throw invalid('approvals must be an array', 'approvals')
    raw.approvals.forEach(checkGrant)
  }
  if (raw.learning !== undefined) assertLearningConfig(raw.learning)
  for (const key of ['extraReadRoots', 'extraWriteRoots'] as const) {
    const roots = raw[key]
    if (roots !== undefined && (!Array.isArray(roots) || roots.some(root => typeof root !== 'string' || !nodePath.isAbsolute(root)))) {
      throw invalid(`${key} must be an array of absolute paths`, key)
    }
  }
  if (raw.commands !== undefined) {
    const commands = raw.commands
    if (!isObject(commands)) throw invalid('commands must be an object', 'commands')
    for (const key of Object.keys(commands)) if (key !== 'network' && key !== 'systemSandbox') throw invalid(`unknown field commands.${key}`, `commands.${key}`)
    if (commands.network !== undefined && typeof commands.network !== 'boolean') throw invalid('commands.network must be a boolean', 'commands.network')
    if (commands.systemSandbox !== undefined && !(SYSTEM_SANDBOX_SETTINGS as readonly unknown[]).includes(commands.systemSandbox)) {
      throw invalid(`commands.systemSandbox must be one of ${SYSTEM_SANDBOX_SETTINGS.join(', ')}`, 'commands.systemSandbox')
    }
  }
  return raw as ProjectConfigFile
}

/** Read and validate the raw file; `{}` when it does not exist. */
export async function readProjectConfigFile(layout: Pick<WorkspaceLayout, 'configFile'>): Promise<ProjectConfigFile> {
  let text: string
  try {
    text = await readFile(layout.configFile, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text.replace(/^﻿/, ''))
  } catch (error) {
    throw new NexgentError('config/invalid', `.nexgent/config.json is not valid JSON: ${(error as Error).message}`, { cause: error })
  }
  return validateProjectConfig(parsed)
}

/**
 * Load `.nexgent/config.json` with defaults applied (`resolveProjectConfig`).
 * A missing file equals `{}`.
 * @throws `config/invalid` on malformed JSON, unknown fields or wrong types.
 */
export async function loadProjectConfig(layout: Pick<WorkspaceLayout, 'configFile'>): Promise<LoadedProjectConfig> {
  const file = await readProjectConfigFile(layout)
  const { extraReadRoots, extraWriteRoots, commands, ...contract } = file
  return {
    ...resolveProjectConfig(contract),
    extraReadRoots: extraReadRoots ?? [],
    extraWriteRoots: extraWriteRoots ?? [],
    commands: { network: commands?.network ?? true, systemSandbox: commands?.systemSandbox ?? 'auto' },
  }
}

/**
 * Atomically replace `.nexgent/config.json`: validate, write a sibling temp
 * file, fsync, rename. Writes exactly the given fields (defaults are not
 * expanded into the file).
 */
export async function writeProjectConfig(layout: Pick<WorkspaceLayout, 'configFile'>, config: ProjectConfigFile): Promise<void> {
  validateProjectConfig(config)
  const dir = nodePath.dirname(layout.configFile)
  await mkdir(dir, { recursive: true })
  const temp = nodePath.join(dir, `.config.json.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
  const handle = await open(temp, 'w')
  try {
    await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temp, layout.configFile)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

/**
 * Read-modify-write the raw config file atomically (single process). Used for
 * `project`-scope approval grants and settings changes.
 */
export async function updateProjectConfig(
  layout: Pick<WorkspaceLayout, 'configFile'>,
  update: (current: ProjectConfigFile) => ProjectConfigFile,
): Promise<ProjectConfigFile> {
  const next = update(await readProjectConfigFile(layout))
  await writeProjectConfig(layout, next)
  return next
}

/**
 * Append a `project`-scope grant (deduplicated by tool + pattern) where the
 * project keeps them: `grants.json` when the data is in the user data
 * directory (K1), else `config.json.approvals`.
 */
export async function addProjectApproval(layout: Pick<WorkspaceLayout, 'configFile' | 'grantsFile'>, grant: ApprovalGrant): Promise<void> {
  if (layout.grantsFile !== undefined) {
    const approvals = await readProjectGrants(layout.grantsFile)
    if (approvals.some(entry => entry.tool === grant.tool && entry.pattern === grant.pattern)) return
    await appendGrant(layout, grant)
    return
  }
  await updateProjectConfig(layout, current => {
    const approvals = current.approvals ?? []
    if (approvals.some(entry => entry.tool === grant.tool && entry.pattern === grant.pattern)) return current
    return { ...current, approvals: [...approvals, grant] }
  })
}
