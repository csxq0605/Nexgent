/**
 * `@nexgent/llm` — the Claude Platform model route (Anthropic Messages API
 * via `@anthropic-ai/sdk`): streaming text, thinking and tool calls, preserved
 * thinking replay, usage normalization with explicit `'unknown'`, and a
 * request ledger pair per request. Implements the kernel's `LLMProvider`
 * contract.
 */
import { LLMPlugin } from './plugin.js'

/** Package name, for profile rows and diagnostics. */
export const packageName = '@nexgent/llm'

export {
  ANTHROPIC_API_KEY,
  AnthropicProvider,
  CLAUDE_API_HOST,
  createProvider,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  mapStopReason,
  NEXGENT_API_BASE_URL,
} from './provider.js'
export type { AnthropicProviderOptions, CompleteOptions, CreateProviderOptions, FallbacksMode } from './provider.js'
export { apply, LLMPlugin, providerOptionsFromConfig, validateLLMPluginConfig } from './plugin.js'
export type { LLMPluginConfig, LLMPluginConfigIssue } from './plugin.js'
export { normalizeUsage } from './usage.js'
export type { WireUsage } from './usage.js'
export { buildMessageParams, DEFAULT_WIRE_OPTIONS, FALLBACK_BETA, thinkingParam, toJson, toWireMessages } from './wire.js'
export type { MessageParams, WireOptions } from './wire.js'
export { REDACTED, redactSecrets, sanitizeUrl } from './redact.js'

export default LLMPlugin
