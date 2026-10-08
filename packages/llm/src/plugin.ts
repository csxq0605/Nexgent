/**
 * The Cordis plugin: builds an {@link OpenAICompatibleProvider} from the
 * profile row's config and registers it as `ctx.llm`. It injects
 * `credentials` (API key) and `ledger` (request records), so it loads only
 * once both services are available.
 *
 * The accepted config is the `llm` row of the kernel's default profile
 * (`packages/kernel/profiles/nexgent.yml`, migrated from PR #4's
 * `llm-pi-ai.providers.mimo`) plus a few Nexgent-native keys.
 */
import { NexgentError, type Context, type JsonObject, type ThinkingMode } from '@nexgent/kernel'
import { OpenAICompatibleProvider, type OpenAICompatibleProviderOptions } from './provider.js'

/** Route quirks carried over from PR #4's pi-ai `compat` block. */
export interface LLMCompatConfig {
  /**
   * How reasoning is switched: `deepseek` / `zai` send `thinking: { type }`,
   * `qwen` sends `enable_thinking`, `none` sends nothing. Explicit
   * `thinkingParams` win.
   */
  readonly thinkingFormat?: 'deepseek' | 'zai' | 'qwen' | 'none'
  /** Output cap field name. */
  readonly maxTokensField?: 'max_tokens' | 'max_completion_tokens'
  /** Accepted for profile compatibility; the provider never sends `reasoning_effort`. */
  readonly supportsReasoningEffort?: boolean
  /** Accepted for profile compatibility; the provider never sends a `developer` role. */
  readonly supportsDeveloperRole?: boolean
  /** Accepted for profile compatibility; the provider never sends `store`. */
  readonly supportsStore?: boolean
}

/** Plugin config as a profile row carries it. Every field is optional. */
export interface LLMPluginConfig {
  /** Route key; default `mimo`. */
  readonly provider?: string
  /** Same as `provider` (Nexgent-native spelling). */
  readonly id?: string
  /** Display label; informational. */
  readonly displayName?: string
  /** Base URL; default the MiMo route. `NEXGENT_API_BASE_URL` overrides it. */
  readonly endpoint?: string
  /** Default model; default `mimo-v2.6-pro`. */
  readonly model?: string
  /** Credential name of the API key; default `NEXGENT_API_KEY`. */
  readonly apiKeyCredential?: string
  /** Same as `apiKeyCredential`. */
  readonly apiKeyName?: string
  /** Execution thinking mode; informational (each request carries its own `thinking`). */
  readonly thinking?: ThinkingMode
  /** Whole-request deadline (ms). */
  readonly timeoutMs?: number
  /** Stream idle deadline (ms). */
  readonly streamIdleTimeoutMs?: number
  /** Must be 0 when present. */
  readonly maxRetries?: 0
  /** Output cap applied when a request sets none. */
  readonly maxTokens?: number
  /** Model context window in tokens; informational. */
  readonly contextWindow?: number
  /** Route quirks. */
  readonly compat?: LLMCompatConfig
  /** Body fields per thinking mode; overrides `compat.thinkingFormat`. */
  readonly thinkingParams?: Readonly<Record<ThinkingMode, JsonObject>>
  /** Repeat the tool name on `tool` messages. */
  readonly toolMessageName?: boolean
  /** `'env'` (default) or `'none'`. */
  readonly proxy?: 'env' | 'none'
}

/** One validation problem, in standard-schema issue shape. */
export interface LLMPluginConfigIssue {
  readonly message: string
  readonly path?: PropertyKey[]
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const STRING_KEYS = ['provider', 'id', 'displayName', 'endpoint', 'model', 'apiKeyCredential', 'apiKeyName'] as const
const POSITIVE_KEYS = ['timeoutMs', 'streamIdleTimeoutMs', 'maxTokens', 'contextWindow'] as const
const KNOWN_KEYS = new Set<string>([...STRING_KEYS, ...POSITIVE_KEYS, 'thinking', 'maxRetries', 'compat', 'thinkingParams', 'toolMessageName', 'proxy'])
const COMPAT_KEYS = new Set(['thinkingFormat', 'maxTokensField', 'supportsReasoningEffort', 'supportsDeveloperRole', 'supportsStore'])

/**
 * Validate a raw config. Unknown keys are rejected so a typo cannot silently
 * fall back to a default.
 * @param input - the profile row's `config`.
 * @returns the issues found; empty when valid.
 */
export function validateLLMPluginConfig(input: unknown): LLMPluginConfigIssue[] {
  if (input === undefined || input === null) return []
  if (!isObject(input)) return [{ message: 'config must be an object' }]
  const issues: LLMPluginConfigIssue[] = []
  for (const key of Object.keys(input)) {
    if (!KNOWN_KEYS.has(key)) issues.push({ message: `unknown key "${key}"`, path: [key] })
  }
  for (const key of STRING_KEYS) {
    if (input[key] !== undefined && (typeof input[key] !== 'string' || input[key] === '')) {
      issues.push({ message: `${key} must be a non-empty string`, path: [key] })
    }
  }
  for (const key of POSITIVE_KEYS) {
    const value = input[key]
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)) {
      issues.push({ message: `${key} must be a positive number`, path: [key] })
    }
  }
  if (input['thinking'] !== undefined && input['thinking'] !== 'off' && input['thinking'] !== 'on') {
    issues.push({ message: 'thinking must be "off" or "on"', path: ['thinking'] })
  }
  if (input['maxRetries'] !== undefined && input['maxRetries'] !== 0) issues.push({ message: 'maxRetries must be 0', path: ['maxRetries'] })
  const compat = input['compat']
  if (compat !== undefined) {
    if (!isObject(compat)) {
      issues.push({ message: 'compat must be an object', path: ['compat'] })
    } else {
      for (const key of Object.keys(compat)) {
        if (!COMPAT_KEYS.has(key)) issues.push({ message: `unknown key "compat.${key}"`, path: ['compat', key] })
      }
      const format = compat['thinkingFormat']
      if (format !== undefined && format !== 'deepseek' && format !== 'zai' && format !== 'qwen' && format !== 'none') {
        issues.push({ message: 'compat.thinkingFormat must be "deepseek", "zai", "qwen" or "none"', path: ['compat', 'thinkingFormat'] })
      }
      const field = compat['maxTokensField']
      if (field !== undefined && field !== 'max_tokens' && field !== 'max_completion_tokens') {
        issues.push({ message: 'compat.maxTokensField must be "max_tokens" or "max_completion_tokens"', path: ['compat', 'maxTokensField'] })
      }
      for (const key of ['supportsReasoningEffort', 'supportsDeveloperRole', 'supportsStore'] as const) {
        if (compat[key] !== undefined && typeof compat[key] !== 'boolean') {
          issues.push({ message: `compat.${key} must be a boolean`, path: ['compat', key] })
        }
      }
    }
  }
  const thinking = input['thinkingParams']
  if (thinking !== undefined && !(isObject(thinking) && isObject(thinking['off']) && isObject(thinking['on']))) {
    issues.push({ message: 'thinkingParams must be { off: object, on: object }', path: ['thinkingParams'] })
  }
  if (input['toolMessageName'] !== undefined && typeof input['toolMessageName'] !== 'boolean') {
    issues.push({ message: 'toolMessageName must be a boolean', path: ['toolMessageName'] })
  }
  if (input['proxy'] !== undefined && input['proxy'] !== 'env' && input['proxy'] !== 'none') {
    issues.push({ message: 'proxy must be "env" or "none"', path: ['proxy'] })
  }
  return issues
}

function thinkingParamsFor(format: LLMCompatConfig['thinkingFormat']): Readonly<Record<ThinkingMode, JsonObject>> | undefined {
  switch (format) {
    case 'qwen':
      return { off: { enable_thinking: false }, on: { enable_thinking: true } }
    case 'none':
      return { off: {}, on: {} }
    default:
      return undefined // deepseek / zai = the provider default `thinking: { type }`
  }
}

/**
 * Map a validated plugin config to provider options (without the injected
 * services).
 * @param config - a config that passed {@link validateLLMPluginConfig}.
 */
export function providerOptionsFromConfig(config: LLMPluginConfig): Omit<OpenAICompatibleProviderOptions, 'credentials' | 'ledger'> {
  const id = config.id ?? config.provider
  const apiKeyName = config.apiKeyName ?? config.apiKeyCredential
  const thinkingParams = config.thinkingParams ?? thinkingParamsFor(config.compat?.thinkingFormat)
  const maxTokensField = config.compat?.maxTokensField
  return {
    ...id === undefined ? {} : { id },
    ...config.endpoint === undefined ? {} : { endpoint: config.endpoint },
    ...config.model === undefined ? {} : { defaultModel: config.model },
    ...apiKeyName === undefined ? {} : { apiKeyName },
    ...config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs },
    ...config.streamIdleTimeoutMs === undefined ? {} : { streamIdleTimeoutMs: config.streamIdleTimeoutMs },
    ...config.maxTokens === undefined ? {} : { defaultMaxTokens: config.maxTokens },
    ...thinkingParams === undefined ? {} : { thinkingParams },
    ...maxTokensField === undefined ? {} : { maxTokensField },
    ...config.toolMessageName === undefined ? {} : { toolMessageName: config.toolMessageName },
    ...config.proxy === undefined ? {} : { proxy: config.proxy },
  }
}

/** Standard-schema validator Cordis applies to the row config before `apply`. */
const Config = {
  '~standard': {
    version: 1 as const,
    vendor: 'nexgent',
    validate(value: unknown) {
      const issues = validateLLMPluginConfig(value)
      return issues.length === 0 ? { value: (value ?? {}) as LLMPluginConfig } : { issues }
    },
  },
}

/**
 * Register the provider as `ctx.llm`.
 * @param ctx - the plugin context; `ctx.credentials` and `ctx.ledger` are injected.
 * @param config - validated config.
 */
export function apply(ctx: Context, config: LLMPluginConfig = {}): void {
  const issues = validateLLMPluginConfig(config)
  if (issues.length > 0) {
    throw new NexgentError('config/invalid', `@nexgent/llm config: ${issues.map(issue => issue.message).join('; ')}`)
  }
  const provider = new OpenAICompatibleProvider({
    credentials: ctx.credentials,
    ledger: ctx.ledger,
    ...providerOptionsFromConfig(config),
  })
  ctx.provide('llm', provider)
}

/** The `@nexgent/llm` Cordis plugin (object form). */
export const LLMPlugin = {
  name: '@nexgent/llm',
  inject: ['credentials', 'ledger'],
  provide: 'llm',
  Config,
  apply,
}
