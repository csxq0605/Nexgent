/**
 * The Cordis plugin: builds an {@link AnthropicProvider} from the profile
 * row's config and registers it as `ctx.llm`. It injects `credentials` (API
 * key) and `ledger` (request records), so it loads only once both services
 * are available.
 *
 * The accepted config is the `llm` row of the kernel's default profile
 * (`packages/kernel/profiles/nexgent.yml`).
 */
import { EFFORT_LEVELS, NexgentError, type Context, type Effort, type ThinkingMode } from '@nexgent/kernel'
import { AnthropicProvider, type AnthropicProviderOptions, type FallbacksMode } from './provider.js'

/** Plugin config as a profile row carries it. Every field is optional. */
export interface LLMPluginConfig {
  /** Route key written to the ledger; default `anthropic`. */
  readonly provider?: string
  /** Base URL; default `https://api.anthropic.com`. `NEXGENT_API_BASE_URL` overrides it. */
  readonly endpoint?: string
  /** Default model; default `claude-sonnet-5-5`. */
  readonly model?: string
  /** Credential name of the API key; default `NEXGENT_API_KEY` (falls back to `ANTHROPIC_API_KEY`). */
  readonly apiKeyCredential?: string
  /** Execution thinking mode; informational (each request carries its own `thinking`). */
  readonly thinking?: ThinkingMode
  /** Default `output_config.effort`; default `medium`. */
  readonly effort?: Effort
  /** `max_tokens` applied when a request sets none; default 16000. */
  readonly maxTokens?: number
  /** Whole-request deadline (ms). */
  readonly timeoutMs?: number
  /** Stream idle deadline (ms). */
  readonly streamIdleTimeoutMs?: number
  /** Must be 0 when present. */
  readonly maxRetries?: 0
  /** Server-side refusal fallbacks; default `'default'`. */
  readonly fallbacks?: FallbacksMode
}

/** One validation problem, in standard-schema issue shape. */
export interface LLMPluginConfigIssue {
  readonly message: string
  readonly path?: PropertyKey[]
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const STRING_KEYS = ['provider', 'endpoint', 'model', 'apiKeyCredential'] as const
const POSITIVE_KEYS = ['maxTokens', 'timeoutMs', 'streamIdleTimeoutMs'] as const
const KNOWN_KEYS = new Set<string>([...STRING_KEYS, ...POSITIVE_KEYS, 'thinking', 'effort', 'maxRetries', 'fallbacks'])

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
  if (input['effort'] !== undefined && !(EFFORT_LEVELS as readonly unknown[]).includes(input['effort'])) {
    issues.push({ message: `effort must be one of ${EFFORT_LEVELS.join(', ')}`, path: ['effort'] })
  }
  if (input['maxRetries'] !== undefined && input['maxRetries'] !== 0) issues.push({ message: 'maxRetries must be 0', path: ['maxRetries'] })
  if (input['fallbacks'] !== undefined && input['fallbacks'] !== 'default' && input['fallbacks'] !== 'off') {
    issues.push({ message: 'fallbacks must be "default" or "off"', path: ['fallbacks'] })
  }
  return issues
}

/**
 * Map a validated plugin config to provider options (without the injected
 * services).
 * @param config - a config that passed {@link validateLLMPluginConfig}.
 */
export function providerOptionsFromConfig(config: LLMPluginConfig): Omit<AnthropicProviderOptions, 'credentials' | 'ledger'> {
  return {
    ...config.provider === undefined ? {} : { id: config.provider },
    ...config.endpoint === undefined ? {} : { endpoint: config.endpoint },
    ...config.model === undefined ? {} : { defaultModel: config.model },
    ...config.apiKeyCredential === undefined ? {} : { apiKeyName: config.apiKeyCredential },
    ...config.effort === undefined ? {} : { effort: config.effort },
    ...config.maxTokens === undefined ? {} : { maxTokens: config.maxTokens },
    ...config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs },
    ...config.streamIdleTimeoutMs === undefined ? {} : { streamIdleTimeoutMs: config.streamIdleTimeoutMs },
    ...config.fallbacks === undefined ? {} : { fallbacks: config.fallbacks },
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
  const provider = new AnthropicProvider({
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
