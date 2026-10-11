/**
 * Cordis plugin of `@nexgent/context` (profile row `@nexgent/context`).
 */
import {
  DEFAULT_PROJECT_CONFIG,
  NexgentError,
  readProjectConfig,
  type Context,
  type ContextService,
  type Effort,
  type ThinkingMode,
} from '@nexgent/kernel'
import { BasicCompactor, type SummaryRequestSettings } from './compaction.js'
import { workspaceInstructionsProvider } from './instructions.js'
import { materialsProvider } from './materials.js'
import { ContextRegistry } from './service.js'

/** Plugin config (every field optional). */
export interface ContextPluginConfig {
  readonly instructions?: { readonly maxBytes?: number }
  readonly materials?: { readonly inlineMaxBytes?: number; readonly inlineTotalMaxBytes?: number }
  readonly compaction?: {
    /** Default `true`; `false` leaves `compactor` unset (the loop then never compacts). */
    readonly enabled?: boolean
    /** Default 160 000; `NEXGENT_COMPACTION_THRESHOLD` overrides it. */
    readonly thresholdTokens?: number
    /** Default 2. */
    readonly keepRecentTurns?: number
    /** Output cap of the summary request; default 16 000. */
    readonly maxTokens?: number
    /** Whole-request deadline of the summary request in ms. */
    readonly timeoutMs?: number
    /** Override the project's thinking setting for the summary request. */
    readonly thinking?: ThinkingMode
    /** Override the project's effort for the summary request. */
    readonly effort?: Effort
  }
}

const TOP_LEVEL = new Set(['instructions', 'materials', 'compaction'])

/** Reject unknown top-level keys (a typo would silently disable a setting). */
export function checkContextPluginConfig(config: unknown): asserts config is ContextPluginConfig {
  if (config === undefined || config === null) return
  if (typeof config !== 'object' || Array.isArray(config)) throw new NexgentError('config/invalid', '@nexgent/context config must be an object')
  const unknown = Object.keys(config).filter(key => !TOP_LEVEL.has(key))
  if (unknown.length > 0) throw new NexgentError('config/invalid', `@nexgent/context config: unknown field(s) ${unknown.join(', ')}`)
}

/** Build the service over a context that provides `workspace` and `llm`. */
export function createContextService(ctx: Pick<Context, 'workspace' | 'llm'>, config: ContextPluginConfig = {}): ContextRegistry {
  checkContextPluginConfig(config)
  const compaction = config.compaction ?? {}
  const settings = async (): Promise<SummaryRequestSettings> => {
    const loaded = await readProjectConfig(ctx.workspace.layout.configFile)
    const effort = compaction.effort ?? loaded.input.effort ?? DEFAULT_PROJECT_CONFIG.effort
    return { thinking: compaction.thinking ?? loaded.input.thinking ?? DEFAULT_PROJECT_CONFIG.thinking, effort }
  }
  const compactor = compaction.enabled === false
    ? undefined
    : new BasicCompactor({
      llm: () => ctx.llm,
      settings,
      ...(compaction.thresholdTokens === undefined ? {} : { thresholdTokens: compaction.thresholdTokens }),
      ...(compaction.keepRecentTurns === undefined ? {} : { keepRecentTurns: compaction.keepRecentTurns }),
      ...(compaction.maxTokens === undefined ? {} : { maxTokens: compaction.maxTokens }),
      ...(compaction.timeoutMs === undefined ? {} : { timeoutMs: compaction.timeoutMs }),
    })
  const service = new ContextRegistry(compactor)
  service.register(workspaceInstructionsProvider(config.instructions ?? {}))
  service.register(materialsProvider(config.materials ?? {}))
  return service
}

/**
 * The plugin: provides `ctx.context` (the property is typed by the kernel's
 * service declarations; this package does not augment Cordis itself) with the `workspace-instructions` and
 * `materials` providers and (unless disabled) the basic compactor. Other
 * packages add providers with `ctx.context.register(...)`.
 */
export const ContextPlugin = {
  name: '@nexgent/context',
  inject: ['workspace', 'llm'],
  provide: ['context'],
  apply(ctx: Context, config: ContextPluginConfig = {}): void {
    ctx.provide('context', createContextService(ctx, config ?? {}))
  },
}

export const name = ContextPlugin.name
export const apply = ContextPlugin.apply
