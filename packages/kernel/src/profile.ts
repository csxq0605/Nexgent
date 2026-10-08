// Adapted from deepseek-harness@46a7f68b packages/boot/app-boot/src/profile.ts and profile-plugins.ts (MIT)
/**
 * Profile boot: an ordered YAML list of {@link AppProfileRow}s, optional
 * `cordis.patch.yml`-style patch files applied with
 * {@link applyProfilePatches}, and a name → plugin registry the host passes
 * in. Each enabled row is loaded in order with `ctx.plugin(plugin, config)`,
 * so the plugin's schemastery `Config` validates its config. The kernel's
 * own plugins are always resolvable; the host supplies the rest (the CLI
 * registers `@nexgent/llm`, `@nexgent/session` and `@nexgent/workspace`).
 *
 * Unlike DSH, there is no `!!js` tag evaluation, module resolution or hot
 * reload: rows name plugins, the registry maps names to values.
 */
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Context, type Fiber, type Plugin } from '@deepseek-ai/cordis'
import YAML from 'yaml'
import { NexgentError } from './contracts/errors.js'
import { isJsonValue, type JsonObject } from './contracts/json.js'
import {
  type AppProfile,
  type AppProfilePatch,
  type AppProfilePatchEntry,
  type AppProfileRow,
} from './contracts/config.js'

/** Host-supplied plugins by row `name`. */
export type PluginRegistry = Readonly<Record<string, Plugin>> | ReadonlyMap<string, Plugin>

/** Absolute path of the shipped default product profile. */
export const DEFAULT_PROFILE_FILE: string = fileURLToPath(new URL('../profiles/nexgent.yml', import.meta.url))

function invalid(source: string, message: string): NexgentError {
  return new NexgentError('config/invalid', `${source}: ${message}`, { details: { source } })
}

function parseYaml(text: string, source: string): unknown {
  const doc = YAML.parseDocument(text, { prettyErrors: true, uniqueKeys: true })
  const problems = [...doc.errors, ...doc.warnings]
  if (problems.length > 0) throw invalid(source, problems.map(problem => problem.message).join('; '))
  return doc.toJS()
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function checkKeys(value: Record<string, unknown>, allowed: readonly string[], where: string, source: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw invalid(source, `${where} has unknown field "${key}"`)
  }
}

function parseConfig(value: unknown, where: string, source: string): JsonObject | undefined {
  if (value === undefined || value === null) return undefined
  if (!isObject(value) || !isJsonValue(value)) throw invalid(source, `${where}.config must be a JSON object`)
  return value as JsonObject
}

function parseRow(value: unknown, where: string, source: string): AppProfileRow {
  if (!isObject(value)) throw invalid(source, `${where} must be a mapping`)
  checkKeys(value, ['id', 'name', 'config', 'disabled'], where, source)
  if (typeof value.id !== 'string' || value.id === '') throw invalid(source, `${where}.id must be a non-empty string`)
  if (typeof value.name !== 'string' || value.name === '') throw invalid(source, `${where}.name must be a non-empty string`)
  if (value.disabled !== undefined && typeof value.disabled !== 'boolean') throw invalid(source, `${where}.disabled must be a boolean`)
  const config = parseConfig(value.config, where, source)
  return {
    id: value.id,
    name: value.name,
    ...(config === undefined ? {} : { config }),
    ...(value.disabled === undefined ? {} : { disabled: value.disabled }),
  }
}

/**
 * Parse profile YAML: a sequence of rows with unique ids.
 * @throws `config/invalid` on YAML errors, unknown fields or duplicate ids.
 */
export function parseProfile(text: string, source = 'profile'): AppProfile {
  const value = parseYaml(text, source) ?? []
  if (!Array.isArray(value)) throw invalid(source, 'a profile is a YAML sequence of rows')
  const rows = value.map((row, index) => parseRow(row, `row ${index + 1}`, source))
  const seen = new Set<string>()
  for (const row of rows) {
    if (seen.has(row.id)) throw invalid(source, `duplicate row id "${row.id}"`)
    seen.add(row.id)
  }
  return rows
}

/**
 * Parse patch YAML (`cordis.patch.yml` form): a sequence of `{ insert: [rows] }`
 * blocks and `{ id, name?, config?, disabled? }` row patches.
 */
export function parsePatches(text: string, source = 'patch'): AppProfilePatchEntry[] {
  const value = parseYaml(text, source) ?? []
  if (!Array.isArray(value)) throw invalid(source, 'a patch file is a YAML sequence of entries')
  return value.map((entry, index): AppProfilePatchEntry => {
    const where = `entry ${index + 1}`
    if (!isObject(entry)) throw invalid(source, `${where} must be a mapping`)
    if ('insert' in entry) {
      checkKeys(entry, ['insert'], where, source)
      if (!Array.isArray(entry.insert)) throw invalid(source, `${where}.insert must be a sequence`)
      return { insert: entry.insert.map((row, rowIndex) => parseRow(row, `${where}.insert[${rowIndex}]`, source)) }
    }
    checkKeys(entry, ['id', 'name', 'config', 'disabled'], where, source)
    if (typeof entry.id !== 'string' || entry.id === '') throw invalid(source, `${where}.id must be a non-empty string`)
    if (entry.name !== undefined && (typeof entry.name !== 'string' || entry.name === '')) throw invalid(source, `${where}.name must be a non-empty string`)
    if (entry.disabled !== undefined && typeof entry.disabled !== 'boolean') throw invalid(source, `${where}.disabled must be a boolean`)
    const config = parseConfig(entry.config, where, source)
    const patch: AppProfilePatch = {
      id: entry.id,
      ...(entry.name === undefined ? {} : { name: entry.name as string }),
      ...(config === undefined ? {} : { config }),
      ...(entry.disabled === undefined ? {} : { disabled: entry.disabled as boolean }),
    }
    return patch
  })
}

/** Read and parse a profile file. */
export async function loadProfileFile(path: string): Promise<AppProfile> {
  return parseProfile(await readFile(path, 'utf8'), path)
}

/** Read and parse a patch file. */
export async function loadPatchFile(path: string): Promise<AppProfilePatchEntry[]> {
  return parsePatches(await readFile(path, 'utf8'), path)
}

/** The shipped default product profile (MiMo route, thinking off, PR #4 persona). */
export function defaultProfile(): AppProfile {
  return parseProfile(readFileSync(DEFAULT_PROFILE_FILE, 'utf8'), DEFAULT_PROFILE_FILE)
}

/** Look a plugin name up in host registry, then in `fallback`. */
export function resolvePlugin(name: string, registry: PluginRegistry | undefined, fallback: PluginRegistry): Plugin | undefined {
  const lookup = (from: PluginRegistry | undefined) => {
    if (from === undefined) return undefined
    return from instanceof Map ? from.get(name) : (from as Readonly<Record<string, Plugin>>)[name]
  }
  return lookup(registry) ?? lookup(fallback)
}

/** One loaded row. */
export interface LoadedRow {
  readonly row: AppProfileRow
  readonly fiber: Fiber
}

const FIBER_ACTIVE = 2

/**
 * Load every enabled row into `ctx`, in order, then wait until all are
 * active. Rows whose injected services never appear fail the boot.
 * @throws `config/invalid` for an unknown plugin name, a config the plugin's
 *   schema rejects, a plugin that throws on start, or unmet dependencies.
 */
export async function bootProfile(
  ctx: Context,
  profile: AppProfile,
  registry: PluginRegistry | undefined,
  fallback: PluginRegistry = {},
): Promise<LoadedRow[]> {
  const loaded: LoadedRow[] = []
  for (const row of profile) {
    if (row.disabled === true) continue
    const plugin = resolvePlugin(row.name, registry, fallback)
    if (plugin === undefined) {
      throw new NexgentError('config/invalid', `profile row "${row.id}" names unknown plugin "${row.name}"`, {
        details: { row: row.id, plugin: row.name },
      })
    }
    const fiber = ctx.plugin(plugin, structuredClone(row.config ?? {}))
    loaded.push({ row, fiber })
  }
  // A row injecting a service provided by a later row starts only after that
  // row is active, so settle repeatedly until no fiber has work in flight.
  for (let pass = 0; ; pass += 1) {
    for (const { row, fiber } of loaded) await awaitRow(row, fiber)
    await new Promise(resolve => setImmediate(resolve))
    if (loaded.every(({ fiber }) => fiber.inertia === undefined) || pass > 1000) break
  }
  for (const { row, fiber } of loaded) {
    if ((fiber.state as number) === FIBER_ACTIVE) continue
    const missing = Object.keys(fiber.inject).filter(name => ctx.get(name) === undefined)
    throw new NexgentError('config/invalid', `profile row "${row.id}" (${row.name}) is not active; missing services: ${missing.join(', ') || 'unknown'}`, {
      details: { row: row.id, plugin: row.name, missing },
    })
  }
  return loaded
}

async function awaitRow(row: AppProfileRow, fiber: Fiber): Promise<void> {
  try {
    await fiber.await()
  } catch (cause) {
    throw new NexgentError('config/invalid', `profile row "${row.id}" (${row.name}) failed to start: ${cause instanceof Error ? cause.message : String(cause)}`, {
      cause,
      details: { row: row.id, plugin: row.name },
    })
  }
}

