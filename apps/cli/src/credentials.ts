/**
 * API-key presence check before a run starts.
 *
 * The CLI only asks "is a key configured, and where": the value is read by
 * `ctx.credentials` (kernel) and handed to the LLM provider only. Until the
 * runtime is wired, {@link describeApiKey} mirrors the contract's resolution
 * order (`credentials.ts`: env first, then the local credential file) so a
 * missing key fails fast with instructions; it discards the value at once.
 * The integrator replaces it with `ctx.credentials.describe(NEXGENT_API_KEY)`.
 */
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { NEXGENT_API_KEY, type CredentialInfo } from '@nexgent/kernel'
import { CliError, EXIT } from './exit-codes.js'

/** Environment variable that relocates the per-user `~/.nexgent` directory (`permissions.md` §密钥存放). */
export const NEXGENT_HOME_ENV = 'NEXGENT_HOME'

/** Inputs of the check, injectable for tests. */
export interface CredentialProbe {
  readonly env: Readonly<Record<string, string | undefined>>
  /** User home directory. */
  readonly homedir: string
  /** Read a file as UTF-8; rejects when missing. */
  readFile(file: string): Promise<string>
}

const defaultProbe: CredentialProbe = {
  env: process.env,
  homedir: os.homedir(),
  readFile: file => fs.readFile(file, 'utf8'),
}

/** `~/.nexgent/credentials.json`, or `$NEXGENT_HOME/credentials.json` when set. */
export function credentialFilePath(env: CredentialProbe['env'], homedir: string): string {
  const home = env[NEXGENT_HOME_ENV]
  return path.join(home !== undefined && home !== '' ? home : path.join(homedir, '.nexgent'), 'credentials.json')
}

/**
 * Describe the model API key without returning it: `{ configured, source }`.
 * A malformed credential file counts as "not configured from the file".
 */
export async function describeApiKey(probe: CredentialProbe = defaultProbe): Promise<CredentialInfo> {
  const fromEnv = probe.env[NEXGENT_API_KEY]
  if (fromEnv !== undefined && fromEnv !== '') return { configured: true, source: 'env' }
  let text: string
  try {
    text = await probe.readFile(credentialFilePath(probe.env, probe.homedir))
  } catch {
    return { configured: false }
  }
  try {
    const file = JSON.parse(text) as { version?: unknown; credentials?: Record<string, unknown> }
    const present = file.version === 1
      && typeof file.credentials === 'object'
      && file.credentials !== null
      && typeof file.credentials[NEXGENT_API_KEY] === 'string'
      && file.credentials[NEXGENT_API_KEY] !== ''
    return present ? { configured: true, source: 'file' } : { configured: false }
  } catch {
    return { configured: false }
  }
}

/** The message shown when no key is configured. */
export function missingKeyMessage(file: string): string {
  return [
    'no model API key configured.',
    `Set the ${NEXGENT_API_KEY} environment variable, or create ${file} containing:`,
    `  { "version": 1, "credentials": { "${NEXGENT_API_KEY}": "<your key>" } }`,
    process.platform === 'win32' ? '' : '(on Linux / macOS make it private: chmod 600)',
  ].filter(line => line !== '').join('\n')
}

/**
 * Fail with {@link EXIT.ENVIRONMENT} and instructions when no key is configured.
 * @returns where the key will come from.
 */
export async function requireApiKey(probe: CredentialProbe = defaultProbe): Promise<CredentialInfo> {
  const info = await describeApiKey(probe)
  if (!info.configured) throw new CliError(EXIT.ENVIRONMENT, missingKeyMessage(credentialFilePath(probe.env, probe.homedir)))
  return info
}
