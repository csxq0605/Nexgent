/**
 * Normalize Messages API usage into the contract's {@link LLMUsage}. A count
 * the API did not report is `'unknown'`, never 0.
 */
import { toUsageCount, type LLMUsage, type UsageCount } from '@nexgent/kernel'

/** The usage fields the stream reports, in `message_start` and `message_delta`. */
export interface WireUsage {
  readonly input_tokens?: number | null
  readonly output_tokens?: number | null
  readonly cache_read_input_tokens?: number | null
  readonly cache_creation_input_tokens?: number | null
}

/**
 * Merge the usage of `message_start` (input and cache counts) with that of
 * `message_delta` (output count; its cumulative input counts win when given).
 *
 * - `input_tokens` → `inputTokens` (the API's count already excludes cached input);
 * - `output_tokens` → `outputTokens`;
 * - `cache_read_input_tokens` → `cacheReadTokens`;
 * - `cache_creation_input_tokens` is ignored (the contract has no field for it);
 * - `reasoningTokens` is always `'unknown'` (not reported separately);
 * - `totalTokens` = input + output + cacheRead when all three are known.
 * @param start - usage of `message_start`, if seen.
 * @param delta - usage of `message_delta`, if seen.
 */
export function normalizeUsage(start: WireUsage | undefined, delta: WireUsage | undefined): LLMUsage {
  const pick = (key: keyof WireUsage): UsageCount => {
    const value = delta?.[key] ?? start?.[key]
    return toUsageCount(value)
  }
  const inputTokens = pick('input_tokens')
  const outputTokens = pick('output_tokens')
  const cacheReadTokens = pick('cache_read_input_tokens')
  const totalTokens: UsageCount = inputTokens !== 'unknown' && outputTokens !== 'unknown' && cacheReadTokens !== 'unknown'
    ? inputTokens + outputTokens + cacheReadTokens
    : 'unknown'
  return { inputTokens, outputTokens, totalTokens, cacheReadTokens, reasoningTokens: 'unknown' }
}
