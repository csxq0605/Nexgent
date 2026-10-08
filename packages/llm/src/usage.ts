/**
 * Normalize an OpenAI-compatible `usage` object into the contract's
 * {@link LLMUsage}. A count the provider did not report is `'unknown'`,
 * never 0.
 */
import { toUsageCount, UNKNOWN_USAGE, type LLMUsage, type UsageCount } from '@nexgent/kernel'

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/**
 * Convert a wire usage object.
 *
 * - `prompt_tokens` includes cached input on OpenAI-compatible routes; the
 *   cached share comes from `prompt_tokens_details.cached_tokens` (OpenAI) or
 *   `prompt_cache_hit_tokens` (DeepSeek-style routes) and is subtracted so
 *   `inputTokens` is uncached input as the contract defines it.
 * - When the route reports no cache split at all, `cacheReadTokens` is
 *   `'unknown'` and `inputTokens` is `prompt_tokens` as reported (the route
 *   does not distinguish a cached share).
 * - `reasoningTokens` comes from `completion_tokens_details.reasoning_tokens`
 *   and is `'unknown'` when absent.
 * @param wire - the `usage` value of a chunk; anything that is not an object yields {@link UNKNOWN_USAGE}.
 */
export function normalizeUsage(wire: unknown): LLMUsage {
  const usage = record(wire)
  if (usage === undefined) return UNKNOWN_USAGE
  const prompt = toUsageCount(usage['prompt_tokens'])
  const cachedRaw = record(usage['prompt_tokens_details'])?.['cached_tokens'] ?? usage['prompt_cache_hit_tokens']
  const cacheRead = toUsageCount(cachedRaw)
  let inputTokens: UsageCount = prompt
  if (prompt !== 'unknown' && cacheRead !== 'unknown') {
    inputTokens = prompt >= cacheRead ? prompt - cacheRead : 'unknown'
  }
  return {
    inputTokens,
    outputTokens: toUsageCount(usage['completion_tokens']),
    totalTokens: toUsageCount(usage['total_tokens']),
    cacheReadTokens: cacheRead,
    reasoningTokens: toUsageCount(record(usage['completion_tokens_details'])?.['reasoning_tokens']),
  }
}
