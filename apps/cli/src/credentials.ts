/**
 * API-key presence check before a run starts.
 *
 * The CLI only asks "is a key configured, and where": the value is read by
 * `ctx.credentials` (kernel) and handed to the LLM provider only. The check
 * runs on the kernel's `LocalCredentials` (same resolution order and `0600`
 * rule as the runtime: `NEXGENT_API_KEY` in the environment, then
 * `credentials.json` under `NEXGENT_HOME` / `~/.nexgent`) plus the llm
 * route's `ANTHROPIC_API_KEY` environment fallback, so a missing key fails
 * fast with instructions and the runtime never sees a half-configured run.
 */
import { credentialFilePath as kernelCredentialFilePath, LocalCredentials, NEXGENT_API_KEY, NEXGENT_HOME, type CredentialInfo } from '@nexgent/kernel'
import { ANTHROPIC_API_KEY } from '@nexgent/llm'
import { CliError, EXIT } from './exit-codes.js'

/** Environment variable that relocates the per-user `~/.nexgent` directory (`permissions.md` §密钥存放). */
export const NEXGENT_HOME_ENV = NEXGENT_HOME

/** Inputs of the check, injectable for tests. */
export interface CredentialProbe {
  readonly env: Readonly<Record<string, string | undefined>>
  /** Nexgent home directory; default `$NEXGENT_HOME`, then `~/.nexgent`. */
  readonly home?: string
}

const defaultProbe: CredentialProbe = { env: process.env }

/** `~/.nexgent/credentials.json`, or `$NEXGENT_HOME/credentials.json` when set (or `probe.home`). */
export function credentialFilePath(probe: CredentialProbe = defaultProbe): string {
  return kernelCredentialFilePath({ env: probe.env as NodeJS.ProcessEnv, ...(probe.home === undefined ? {} : { home: probe.home }) })
}

/**
 * Describe the model API key without returning it: `{ configured, source }`.
 * A malformed or insecure credential file counts as "not configured from the file".
 */
export async function describeApiKey(probe: CredentialProbe = defaultProbe): Promise<CredentialInfo> {
  const credentials = new LocalCredentials({ env: probe.env as NodeJS.ProcessEnv, ...(probe.home === undefined ? {} : { home: probe.home }) })
  const info = await credentials.describe(NEXGENT_API_KEY).catch((): CredentialInfo => ({ configured: false }))
  if (info.configured) return info
  const fallback = probe.env[ANTHROPIC_API_KEY]
  return fallback !== undefined && fallback.trim() !== '' ? { configured: true, source: 'env' } : { configured: false }
}

/** The message shown when no key is configured. */
export function missingKeyMessage(file: string): string {
  return [
    'no model API key configured.',
    `Set the ${NEXGENT_API_KEY} environment variable (or ${ANTHROPIC_API_KEY}), or create ${file} containing:`,
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
  if (!info.configured) throw new CliError(EXIT.ENVIRONMENT, missingKeyMessage(credentialFilePath(probe)))
  return info
}
