/**
 * The user config below the Nexgent home (`<home>/config.json`), as layer-1
 * learning reads it (the interface language and the learning budget).
 */
import { join } from 'node:path'
import { assertUserConfig, nexgentHome, NexgentError, resolveUserConfig, USER_CONFIG_FILE_NAME, type UserConfig } from '@nexgent/kernel'
import { readJson } from './lock.js'

/** The Nexgent home a caller names, else `NEXGENT_HOME` / `~/.nexgent`. */
export function homeOf(home: string | undefined): string {
  return home ?? nexgentHome()
}

/**
 * The user config (`<home>/config.json`); a missing file is `{}`.
 * @throws `config/invalid` when the file is not a valid user config.
 */
export async function readUserConfig(home: string): Promise<UserConfig> {
  let value: unknown
  try {
    value = await readJson(join(home, USER_CONFIG_FILE_NAME))
  } catch (cause) {
    throw new NexgentError('config/invalid', `${USER_CONFIG_FILE_NAME} (Nexgent home) is not valid JSON`, { cause })
  }
  if (value === undefined) return resolveUserConfig()
  assertUserConfig(value)
  return resolveUserConfig(value)
}
