/**
 * Project settings over `.nexgent/config.json`, user settings over
 * `<NEXGENT_HOME>/config.json` (API 7, ADR 0012) and the API-key facts.
 *
 * Reads go through the kernel's validating reader; a patch is merged into
 * the file as it is on disk (fields the settings page does not know, such as
 * `approvals` or `extraReadRoots`, are kept), validated as a whole, then
 * written atomically. The key is described with the kernel's credential
 * resolution plus the llm route's `ANTHROPIC_API_KEY` fallback; its value is
 * only ever read to redact exports and never returned.
 */
import { join } from 'node:path'
import {
  assertUserConfig,
  credentialFilePath,
  DEFAULT_CHECK_RETRIES,
  LocalCredentials,
  NEXGENT_API_KEY,
  NexgentError,
  parseProjectConfig,
  readCredentialFile,
  readJsonFile,
  readProjectConfig,
  resolveUserConfig,
  RETIRED_CONFIG_FIELDS,
  USER_CONFIG_FILE_NAME,
  writeJsonFile,
  type CredentialInfo,
} from '@nexgent/kernel'
import { ANTHROPIC_API_KEY } from '@nexgent/llm'
import type { ProjectSettings, SettingsPatch, UserSettings, UserSettingsPatch } from './api.js'

/** Where credentials are looked up. */
export interface CredentialEnv {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly home: string
}

/** `{ configured, source }` for the model key: `NEXGENT_API_KEY` (env, then file), then `ANTHROPIC_API_KEY` in the env. */
export async function describeApiKey(where: CredentialEnv): Promise<CredentialInfo> {
  const credentials = new LocalCredentials({ env: where.env as NodeJS.ProcessEnv, home: where.home })
  const info = await credentials.describe(NEXGENT_API_KEY).catch((): CredentialInfo => ({ configured: false }))
  if (info.configured) return info
  const fallback = where.env[ANTHROPIC_API_KEY]
  return fallback !== undefined && fallback.trim() !== '' ? { configured: true, source: 'env' } : { configured: false }
}

/** Every key value currently in force (for redaction only). */
export async function secretValues(where: CredentialEnv): Promise<string[]> {
  const values = new Set<string>()
  const credentials = new LocalCredentials({ env: where.env as NodeJS.ProcessEnv, home: where.home })
  const key = await credentials.get(NEXGENT_API_KEY).catch(() => undefined)
  if (key !== undefined) values.add(key)
  const file = await readCredentialFile({ env: where.env as NodeJS.ProcessEnv, home: where.home }).catch(() => undefined)
  for (const value of Object.values(file?.credentials ?? {})) if (value !== '') values.add(value)
  for (const name of [NEXGENT_API_KEY, ANTHROPIC_API_KEY]) {
    const value = where.env[name]
    if (value !== undefined && value.trim() !== '') values.add(value)
  }
  return [...values]
}

/** Store (or, with an empty value, remove) the key in `<home>/credentials.json` (mode 0600). */
export async function setApiKey(where: CredentialEnv, value: string): Promise<CredentialInfo> {
  if (typeof value !== 'string') throw new NexgentError('tool/invalid-input', 'value must be a string')
  const options = { env: where.env as NodeJS.ProcessEnv, home: where.home }
  const path = credentialFilePath(options)
  const current = await readCredentialFile(options)
  const credentials: Record<string, string> = { ...current?.credentials }
  if (value.trim() === '') delete credentials[NEXGENT_API_KEY]
  else credentials[NEXGENT_API_KEY] = value.trim()
  await writeJsonFile(path, { version: 1, credentials }, { mode: 0o600, dirMode: 0o700 })
  return describeApiKey(where)
}

/** The settings view of a project. */
export async function readSettings(configFile: string, where: CredentialEnv): Promise<ProjectSettings> {
  const { config } = await readProjectConfig(configFile)
  return {
    model: config.model,
    thinking: config.thinking,
    effort: config.effort,
    sandboxMode: config.sandboxMode,
    costCaps: config.costCaps,
    learning: config.learning,
    apiKey: await describeApiKey(where),
    checkRetries: config.checkRetries ?? DEFAULT_CHECK_RETRIES,
    checkCommands: config.checkCommands ?? [],
  }
}

const PATCH_FIELDS = new Set(['model', 'thinking', 'effort', 'sandboxMode', 'costCaps', 'learning', 'checkRetries', 'checkCommands'])

/** Merge a patch into `config.json` (validated as a whole before writing). */
export async function updateSettings(configFile: string, patch: SettingsPatch, where: CredentialEnv): Promise<ProjectSettings> {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) throw new NexgentError('config/invalid', 'settings patch must be an object')
  for (const key of Object.keys(patch)) {
    if (!PATCH_FIELDS.has(key)) throw new NexgentError('config/invalid', `settings patch: unknown or read-only field ${key}`)
  }
  const raw = await readJsonFile(configFile)
  parseProjectConfig(raw, configFile)
  const current = (raw ?? {}) as Record<string, unknown>
  // Fields of removed features are dropped when the file is written again.
  const next: Record<string, unknown> = { version: 1, ...Object.fromEntries(Object.entries(current).filter(([key]) => !RETIRED_CONFIG_FIELDS.includes(key))) }
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) next[key] = value
  }
  parseProjectConfig(next, configFile)
  await writeJsonFile(configFile, next, { mode: 0o644 })
  return readSettings(configFile, where)
}

/** `<home>/config.json`. */
export function userConfigFile(home: string): string {
  return join(home, USER_CONFIG_FILE_NAME)
}

async function readUserConfigRaw(file: string): Promise<Record<string, unknown> | undefined> {
  let raw: unknown
  try {
    raw = await readJsonFile(file)
  } catch (cause) {
    throw new NexgentError('config/invalid', `${USER_CONFIG_FILE_NAME} (Nexgent home) is not valid JSON`, { cause })
  }
  if (raw === undefined) return undefined
  assertUserConfig(raw)
  return raw as Record<string, unknown>
}

/** `userSettings.get`: the user config with defaults (a missing file is `{}`). */
export async function readUserSettings(home: string): Promise<UserSettings> {
  const raw = await readUserConfigRaw(userConfigFile(home))
  const resolved = resolveUserConfig(raw ?? {})
  return { learning: resolved.learning, ...(resolved.language === undefined ? {} : { language: resolved.language }) }
}

/**
 * `learning.acknowledge` (API 8, ADR 0017 decision 3): record when the user
 * acknowledged the background-learning notice; a second call keeps the
 * first time. Other fields on disk are kept.
 */
export async function acknowledgeLearning(home: string, now: () => Date = () => new Date()): Promise<UserSettings> {
  const file = userConfigFile(home)
  const current = await readUserConfigRaw(file)
  const learning = (current?.learning ?? {}) as Record<string, unknown>
  if (learning.noticeAcknowledgedAt !== undefined) return readUserSettings(home)
  const next: Record<string, unknown> = { version: 1, ...current, learning: { ...learning, noticeAcknowledgedAt: now().toISOString() } }
  assertUserConfig(next)
  await writeJsonFile(file, next, { mode: 0o644, dirMode: 0o700 })
  return readUserSettings(home)
}

/**
 * `userSettings.update`: `language` sets the interface language (`null`
 * removes it); other fields on disk are kept.
 * Validated as a whole before writing.
 */
export async function updateUserSettings(home: string, patch: UserSettingsPatch): Promise<UserSettings> {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) throw new NexgentError('config/invalid', 'user settings patch must be an object')
  for (const key of Object.keys(patch)) if (key !== 'language') throw new NexgentError('config/invalid', `user settings patch: unknown field ${key}`)
  const file = userConfigFile(home)
  const next: Record<string, unknown> = { version: 1, ...await readUserConfigRaw(file) }
  if (patch.language === null) delete next.language
  else if (patch.language !== undefined) next.language = patch.language
  assertUserConfig(next)
  await writeJsonFile(file, next, { mode: 0o644, dirMode: 0o700 })
  return readUserSettings(home)
}
