/**
 * The read-only price table (step 5, decision 9; ADR 0006 decision 8):
 * list prices of the models Nexgent routes to. Step 5 used it only to show
 * an estimated dollar figure; since ADR
 * 0017 decision 6 the dollar cost caps and the learning budget read it too.
 */
import type { LLMUsage } from '@nexgent/kernel'

/** USD per million tokens. Cache writes are the 5-minute (ephemeral) rate, 1.25 × input. */
export interface ModelPrice {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

/** List prices by model id (Claude Platform, 2026-10). */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = Object.freeze({
  'claude-sonnet-5-5': Object.freeze({ input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }),
  'claude-opus-5-5': Object.freeze({ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }),
})

/** The price of a model, or `undefined` when it is not in the table. */
export function modelPrice(model: string): ModelPrice | undefined {
  return Object.hasOwn(MODEL_PRICES, model) ? MODEL_PRICES[model] : undefined
}

/**
 * Estimated USD of `usage` on `model`, for display only: `'unknown'` when
 * the model is not in the table or any priced usage field is `'unknown'`.
 * Not rounded.
 */
export function estimateUsd(model: string, usage: LLMUsage): number | 'unknown' {
  const price = modelPrice(model)
  if (price === undefined) return 'unknown'
  const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = usage
  if (inputTokens === 'unknown' || outputTokens === 'unknown' || cacheReadTokens === 'unknown' || cacheWriteTokens === 'unknown') return 'unknown'
  return (inputTokens * price.input + outputTokens * price.output + cacheReadTokens * price.cacheRead + cacheWriteTokens * price.cacheWrite) / 1e6
}

/**
 * Sum of {@link estimateUsd} over several `(model, usage)` pairs; `'unknown'`
 * as soon as one is.
 */
export function estimateUsdTotal(items: Iterable<{ readonly model: string; readonly usage: LLMUsage }>): number | 'unknown' {
  let total = 0
  for (const item of items) {
    const usd = estimateUsd(item.model, item.usage)
    if (usd === 'unknown') return 'unknown'
    total += usd
  }
  return total
}
