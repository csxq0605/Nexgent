/**
 * `@nexgent/llm` — the single OpenAI-compatible model route (MiMo by
 * default): SSE streaming, tool-call assembly, usage normalization with
 * explicit `'unknown'`, a request ledger pair per request, and HTTP(S) proxy
 * support. Implements the kernel's `LLMProvider` contract.
 */
import { LLMPlugin } from './plugin.js'

/** Package name, for profile rows and diagnostics. */
export const packageName = '@nexgent/llm'

export {
  createProvider,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  NEXGENT_API_BASE_URL,
  OpenAICompatibleProvider,
} from './provider.js'
export type { CompleteOptions, CreateProviderOptions, OpenAICompatibleProviderOptions } from './provider.js'
export { apply, LLMPlugin, providerOptionsFromConfig, validateLLMPluginConfig } from './plugin.js'
export type { LLMCompatConfig, LLMPluginConfig, LLMPluginConfigIssue } from './plugin.js'
export { ChunkAssembler, mapFinishReason } from './assembler.js'
export { normalizeUsage } from './usage.js'
export { readSseData } from './sse.js'
export { buildRequestBody, DEFAULT_WIRE_OPTIONS } from './wire.js'
export type { WireOptions } from './wire.js'
export { REDACTED, redactSecrets, sanitizeUrl } from './redact.js'
export {
  bypassesProxy,
  DIRECT_POLICY,
  isLoopbackHost,
  LOOPBACK_NO_PROXY,
  proxyForUrl,
  resolveProxyPolicy,
} from './proxy/policy.js'
export type { ProxyDiagnostic, ProxyEnv, ProxyPolicy, ProxyResolution } from './proxy/policy.js'
export { createProxyTransport, createTransport, fetchTransport, ProxyTunnelError } from './proxy/transport.js'
export type { CreateTransportOptions, Transport, TransportRequest, TunnelTlsOptions } from './proxy/transport.js'

export default LLMPlugin
