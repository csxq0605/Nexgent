/**
 * `ctx.credentials`: API-key resolution per `permissions.md` §密钥存放.
 *
 * Order: the environment variable of the same name, then the local
 * credential file `<home>/credentials.json` where `<home>` is `NEXGENT_HOME`
 * or `~/.nexgent`. Empty strings count as unset. Nothing is cached. On POSIX
 * a file readable by group or others is refused with a fix-it message.
 */
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { NexgentError } from './contracts/errors.js'
import type { CredentialFile, CredentialInfo, Credentials } from './contracts/credentials.js'
import { readJsonFile, writeJsonFile } from './storage/json-file.js'

/** Environment variable that relocates the per-user Nexgent directory. */
export const NEXGENT_HOME = 'NEXGENT_HOME'

/** File name of the credential file inside the Nexgent home directory. */
export const CREDENTIAL_FILE_NAME = 'credentials.json'

/** Where the credential layer reads from; every field defaults to the live process. */
export interface CredentialSourceOptions {
  /** Environment to read; default `process.env` (read on every call). */
  readonly env?: NodeJS.ProcessEnv
  /** Nexgent home directory; default `$NEXGENT_HOME` or `~/.nexgent`. */
  readonly home?: string
  /** Platform used for the permission check; default `process.platform`. */
  readonly platform?: NodeJS.Platform
}

/** The Nexgent home directory for an environment. */
export function nexgentHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[NEXGENT_HOME]
  return override !== undefined && override !== '' ? override : join(homedir(), '.nexgent')
}

/** Absolute path of the credential file for the given options. */
export function credentialFilePath(options: CredentialSourceOptions = {}): string {
  return join(options.home ?? nexgentHome(options.env ?? process.env), CREDENTIAL_FILE_NAME)
}

function parseCredentialFile(value: unknown, path: string): CredentialFile {
  const invalid = (why: string) => new NexgentError('config/invalid', `${path}: ${why}`, { details: { path } })
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalid('expected an object')
  const record = value as Record<string, unknown>
  if (record.version !== 1) throw invalid('version must be 1')
  const credentials = record.credentials
  if (credentials === null || typeof credentials !== 'object' || Array.isArray(credentials)) {
    throw invalid('credentials must be an object')
  }
  for (const [name, secret] of Object.entries(credentials)) {
    if (typeof secret !== 'string') throw invalid(`credentials.${name} must be a string`)
  }
  return { version: 1, credentials: credentials as Record<string, string> }
}

/**
 * Read the credential file, enforcing owner-only permissions on POSIX.
 * @returns `undefined` when the file does not exist.
 * @throws `credentials/missing` (details `reason: 'insecure-permissions'`) when the mode is wider than `0600`;
 *   `config/invalid` when the file is malformed.
 */
export async function readCredentialFile(options: CredentialSourceOptions = {}): Promise<CredentialFile | undefined> {
  const path = credentialFilePath(options)
  let mode: number
  try {
    mode = (await stat(path)).mode
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  if ((options.platform ?? process.platform) !== 'win32' && (mode & 0o077) !== 0) {
    const octal = (mode & 0o777).toString(8).padStart(4, '0')
    throw new NexgentError(
      'credentials/missing',
      `refusing to read ${path}: permissions ${octal} are wider than 0600; run \`chmod 600 ${path}\``,
      { details: { reason: 'insecure-permissions', path, mode: octal } },
    )
  }
  const value = await readJsonFile(path)
  return value === undefined ? undefined : parseCredentialFile(value, path)
}

/**
 * Store one secret in the credential file (atomic replace, mode `0600`,
 * directory `0700`), keeping the other entries.
 */
export async function saveCredential(name: string, secret: string, options: CredentialSourceOptions = {}): Promise<string> {
  const path = credentialFilePath(options)
  const current = (await readJsonFile(path).then(value => value === undefined ? undefined : parseCredentialFile(value, path)))
  const file: CredentialFile = { version: 1, credentials: { ...current?.credentials, [name]: secret } }
  await writeJsonFile(path, file, { mode: 0o600, dirMode: 0o700 })
  return path
}

/** The {@link Credentials} implementation over env + local file. */
export class LocalCredentials implements Credentials {
  constructor(private readonly options: CredentialSourceOptions = {}) {}

  private async lookup(name: string): Promise<{ value: string; source: 'env' | 'file' } | undefined> {
    const fromEnv = (this.options.env ?? process.env)[name]
    if (fromEnv !== undefined && fromEnv !== '') return { value: fromEnv, source: 'env' }
    const file = await readCredentialFile(this.options)
    const fromFile = file?.credentials[name]
    if (fromFile !== undefined && fromFile !== '') return { value: fromFile, source: 'file' }
    return undefined
  }

  async get(name: string): Promise<string | undefined> {
    return (await this.lookup(name))?.value
  }

  async describe(name: string): Promise<CredentialInfo> {
    const hit = await this.lookup(name)
    return hit === undefined ? { configured: false } : { configured: true, source: hit.source }
  }
}

/** Plugin config of {@link CredentialsService}. */
export interface CredentialsConfig {
  /** Override of the Nexgent home directory (else `NEXGENT_HOME` / `~/.nexgent`). */
  home?: string
}

/** Cordis plugin providing `ctx.credentials` as {@link LocalCredentials}. */
export class CredentialsService extends Service implements Credentials {
  static readonly Config: Schema<CredentialsConfig> = Schema.object({
    home: Schema.string().description('Nexgent home directory holding credentials.json.'),
  })

  private readonly impl: LocalCredentials

  constructor(ctx: Context, config: CredentialsConfig = {}) {
    super(ctx, 'credentials')
    this.impl = new LocalCredentials(config.home === undefined ? {} : { home: config.home })
  }

  get(name: string): Promise<string | undefined> {
    return this.impl.get(name)
  }

  describe(name: string): Promise<CredentialInfo> {
    return this.impl.describe(name)
  }
}
