/**
 * `.nexgent/config.json` loading and atomic writing
 * (`docs/spec/data-formats.md` §项目配置文件). The `Workspace` contract does not
 * cover config, so these are standalone functions over a {@link WorkspaceLayout}.
 */
import { randomBytes } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import * as nodePath from 'node:path'
import {
  EFFORT_LEVELS,
  NexgentError,
  SANDBOX_MODES,
  resolveProjectConfig,
  type ApprovalGrant,
  type CostCap,
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
}

/** A loaded config: contract defaults filled in, plus the workspace-only fields. */
export interface LoadedProjectConfig extends ProjectConfig {
  /** Absolute extra read roots; default `[]`. */
  readonly extraReadRoots: readonly string[]
}

const TOP_LEVEL_KEYS = new Set([
  'version', 'model', 'endpoint', 'thinking', 'effort', 'sandboxMode', 'costCaps', 'approvals', 'autoImprove', 'extraReadRoots',
])

function invalid(message: string, field?: string): NexgentError {
  return new NexgentError('config/invalid', `.nexgent/config.json: ${message}`, field === undefined ? {} : { details: { field } })
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function checkCostCap(value: unknown, field: string, allowWindow: boolean): CostCap {
  if (!isObject(value)) throw invalid(`${field} must be an object`, field)
  const allowed = allowWindow ? ['maxTokens', 'maxRequests', 'windowDays'] : ['maxTokens', 'maxRequests']
  for (const [key, entry] of Object.entries(value)) {
    if (!allowed.includes(key)) throw invalid(`unknown field ${field}.${key}`, `${field}.${key}`)
    if (typeof entry !== 'number' || !Number.isInteger(entry) || entry < 0) {
      throw invalid(`${field}.${key} must be a non-negative integer`, `${field}.${key}`)
    }
  }
  return value as CostCap
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
export function validateProjectConfig(raw: unknown): ProjectConfigFile {
  if (!isObject(raw)) throw invalid('must be a JSON object')
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
  if (raw.autoImprove !== undefined && typeof raw.autoImprove !== 'boolean') throw invalid('autoImprove must be a boolean', 'autoImprove')
  if (raw.costCaps !== undefined) {
    if (!isObject(raw.costCaps)) throw invalid('costCaps must be an object', 'costCaps')
    for (const [key, cap] of Object.entries(raw.costCaps)) {
      if (key !== 'perTask' && key !== 'perProject') throw invalid(`unknown field costCaps.${key}`, `costCaps.${key}`)
      checkCostCap(cap, `costCaps.${key}`, key === 'perProject')
    }
  }
  if (raw.approvals !== undefined) {
    if (!Array.isArray(raw.approvals)) throw invalid('approvals must be an array', 'approvals')
    raw.approvals.forEach(checkGrant)
  }
  if (raw.extraReadRoots !== undefined) {
    if (!Array.isArray(raw.extraReadRoots)
      || raw.extraReadRoots.some(root => typeof root !== 'string' || !nodePath.isAbsolute(root))) {
      throw invalid('extraReadRoots must be an array of absolute paths', 'extraReadRoots')
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
  const { extraReadRoots, ...contract } = file
  return { ...resolveProjectConfig(contract), extraReadRoots: extraReadRoots ?? [] }
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

/** Append a `project`-scope grant to `config.json.approvals` (deduplicated by tool + pattern). */
export async function addProjectApproval(layout: Pick<WorkspaceLayout, 'configFile'>, grant: ApprovalGrant): Promise<void> {
  await updateProjectConfig(layout, current => {
    const approvals = current.approvals ?? []
    if (approvals.some(entry => entry.tool === grant.tool && entry.pattern === grant.pattern)) return current
    return { ...current, approvals: [...approvals, grant] }
  })
}
