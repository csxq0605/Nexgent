/**
 * The Cordis plugin that provides `ctx.session` and `ctx.ledger`, plus a
 * plain factory for hosts and tests that do not boot Cordis.
 *
 * The config is validated by a hand-written Standard Schema object (this
 * package does not depend on schemastery); Cordis runs it before `apply`.
 */
import { isAbsolute } from 'node:path'
import { resolveWorkspaceLayout, type Context } from '@nexgent/kernel'
import { JsonlLedger } from './ledger.js'
import { JsonlSessionStore, type SessionFsyncPolicy } from './store.js'

/**
 * Plugin config. The plain factory needs `root`, or both `sessionsDir` and
 * `ledgersDir`; the Cordis plugin falls back to `ctx.workspace.layout`.
 */
export interface SessionPluginConfig {
  /** Absolute project root; data goes to `<root>/.nexgent/{sessions,ledgers}`. */
  readonly root?: string
  /** Absolute sessions directory; overrides the one derived from `root`. */
  readonly sessionsDir?: string
  /** Absolute ledgers directory; overrides the one derived from `root`. */
  readonly ledgersDir?: string
  /** Checkpoint threshold N; default 50. */
  readonly checkpointEvery?: number
  /** Write a closing checkpoint on release; default true. */
  readonly checkpointOnRelease?: boolean
  /** `'always'` (default) or `'boundaries'`. */
  readonly fsync?: SessionFsyncPolicy
}

/** The services the plugin provides. */
export interface SessionServices {
  readonly store: JsonlSessionStore
  readonly ledger: JsonlLedger
}

interface Issue {
  readonly message: string
  readonly path?: readonly PropertyKey[]
}

/**
 * Check a plugin config.
 * @param requireLocation - require `root` or both directories (the plain
 *   factory does; the plugin falls back to `ctx.workspace.layout`).
 * @returns the issues; empty when valid.
 */
export function checkSessionPluginConfig(value: unknown, requireLocation = true): Issue[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [{ message: 'config must be an object' }]
  const config = value as Record<string, unknown>
  const issues: Issue[] = []
  const known = new Set(['root', 'sessionsDir', 'ledgersDir', 'checkpointEvery', 'checkpointOnRelease', 'fsync'])
  for (const key of Object.keys(config)) if (!known.has(key)) issues.push({ message: 'unknown option', path: [key] })
  for (const key of ['root', 'sessionsDir', 'ledgersDir']) {
    const dir = config[key]
    if (dir !== undefined && (typeof dir !== 'string' || !isAbsolute(dir))) {
      issues.push({ message: 'must be an absolute path', path: [key] })
    }
  }
  if (requireLocation && config.root === undefined && (config.sessionsDir === undefined || config.ledgersDir === undefined)) {
    issues.push({ message: 'give `root`, or both `sessionsDir` and `ledgersDir`' })
  }
  const every = config.checkpointEvery
  if (every !== undefined && (typeof every !== 'number' || !Number.isSafeInteger(every) || every < 1)) {
    issues.push({ message: 'must be a positive integer', path: ['checkpointEvery'] })
  }
  if (config.checkpointOnRelease !== undefined && typeof config.checkpointOnRelease !== 'boolean') {
    issues.push({ message: 'must be a boolean', path: ['checkpointOnRelease'] })
  }
  if (config.fsync !== undefined && config.fsync !== 'always' && config.fsync !== 'boundaries') {
    issues.push({ message: "must be 'always' or 'boundaries'", path: ['fsync'] })
  }
  return issues
}

/** Standard Schema (v1) validator for {@link SessionPluginConfig}, used as the plugin's `Config`. */
export const SessionPluginConfigSchema = {
  '~standard': {
    version: 1 as const,
    vendor: 'nexgent',
    validate(value: unknown): { value: SessionPluginConfig } | { issues: readonly Issue[] } {
      const config = value ?? {}
      const issues = checkSessionPluginConfig(config, false)
      return issues.length === 0 ? { value: config as SessionPluginConfig } : { issues }
    },
  },
}

/**
 * Build the store and ledger without Cordis.
 * @throws `TypeError` when the config is invalid.
 */
export function createSessionServices(config: SessionPluginConfig): SessionServices {
  const issues = checkSessionPluginConfig(config)
  if (issues.length > 0) {
    throw new TypeError(`invalid session config: ${issues.map(issue => `${issue.path?.join('.') ?? '/'}: ${issue.message}`).join('; ')}`)
  }
  const layout = config.root === undefined ? undefined : resolveWorkspaceLayout(config.root)
  // Validation guarantees `root` or both directories.
  const sessionsDir = (config.sessionsDir ?? layout?.sessions) as string
  const ledgersDir = (config.ledgersDir ?? layout?.ledgers) as string
  const store = new JsonlSessionStore({
    sessionsDir,
    ...(config.checkpointEvery === undefined ? {} : { checkpointEvery: config.checkpointEvery }),
    ...(config.checkpointOnRelease === undefined ? {} : { checkpointOnRelease: config.checkpointOnRelease }),
    ...(config.fsync === undefined ? {} : { fsync: config.fsync }),
  })
  return { store, ledger: new JsonlLedger({ ledgersDir }) }
}

/**
 * Cordis plugin (profile row `@nexgent/session`): provides `ctx.session` and
 * `ctx.ledger`. It injects `workspace` and stores data under
 * `ctx.workspace.layout` unless the config names `root` or the directories.
 * Disposing the fiber releases every session lock the store holds (writing
 * closing checkpoints per policy).
 */
export const SessionPlugin = {
  name: '@nexgent/session',
  inject: ['workspace'],
  provide: ['session', 'ledger'],
  Config: SessionPluginConfigSchema,
  apply(ctx: Context, config: SessionPluginConfig = {}): void {
    const own = config.root === undefined ? undefined : resolveWorkspaceLayout(config.root)
    const layout = ctx.workspace.layout
    const { store, ledger } = createSessionServices({
      ...config,
      sessionsDir: config.sessionsDir ?? own?.sessions ?? layout.sessions,
      ledgersDir: config.ledgersDir ?? own?.ledgers ?? layout.ledgers,
    })
    ctx.provide('ledger', ledger)
    ctx.provide('session', store)
    ctx.effect(() => () => store.close())
  },
}
