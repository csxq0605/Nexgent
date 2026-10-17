/**
 * Dollar cost caps and their 80% warning (ADR 0017 decision 6,
 * `permissions.md` §费用上限 “重做 C1”): pure helpers the agent loop uses to
 * add up spending per scope and to decide when a cap warns or is reached.
 *
 * Dollars come from the LLM provider's price table
 * ({@link LLMProvider.estimateUsd}); a request whose usage or price is
 * unknown adds nothing and marks the total as estimated, like the ledger's
 * host-estimated usage does.
 */
import type { CostCap, CostCapLevel, CostCapScope } from './contracts/config.js'
import { COST_WARNING_RATIO } from './contracts/config.js'
import type { LLMProvider, LLMUsage } from './contracts/llm.js'

/** Spending to compare with a cap: requests (failed ones included), known tokens, estimated dollars. */
export interface Spend {
  requests: number
  tokens: number
  usd: number
  /** Some of `usd` was estimated or is missing (unknown usage or price). */
  estimated: boolean
}

/** A fresh, empty {@link Spend}. */
export function zeroSpend(): Spend {
  return { requests: 0, tokens: 0, usd: 0, estimated: false }
}

/** Known `inputTokens + outputTokens` of a usage. */
export function knownUsageTokens(usage: LLMUsage): number {
  return (usage.inputTokens === 'unknown' ? 0 : usage.inputTokens) + (usage.outputTokens === 'unknown' ? 0 : usage.outputTokens)
}

/** Dollars of one usage on `model`, and whether it is an estimate (unknown usage or price, or the provider prices nothing). */
export function usageUsd(llm: Pick<LLMProvider, 'estimateUsd'>, model: string, usage: LLMUsage, hostEstimated = false): { readonly usd: number; readonly estimated: boolean } {
  const usd = llm.estimateUsd?.(model, usage)
  if (usd === undefined || usd === 'unknown') return { usd: 0, estimated: true }
  return { usd, estimated: hostEstimated }
}

/** `a` plus `b` (a new object). */
export function addSpend(a: Spend, b: Spend): Spend {
  return { requests: a.requests + b.requests, tokens: a.tokens + b.tokens, usd: a.usd + b.usd, estimated: a.estimated || b.estimated }
}

/** `a` minus `b`, never below zero (a new object; `estimated` from `a`). */
export function subtractSpend(a: Spend, b: Spend): Spend {
  return { requests: Math.max(0, a.requests - b.requests), tokens: Math.max(0, a.tokens - b.tokens), usd: Math.max(0, a.usd - b.usd), estimated: a.estimated }
}

/** Which limit of a cap the warning names. */
export type CostLimit = 'maxUsd' | 'maxTokens' | 'maxRequests'

/** One cap's state against its spending: the most severe limit, first in the order `maxUsd`, `maxTokens`, `maxRequests`. */
export interface CapStatus {
  readonly level: Exclude<CostCapLevel, 'ok'>
  readonly limit: CostLimit
  readonly used: number
  readonly cap: number
}

/**
 * The status of `cap` against `spend` (pure): `reached` once any set limit
 * is met, `warning` once any reaches {@link COST_WARNING_RATIO}, else
 * `undefined`. A limit of 0 is reached at once.
 */
export function capStatus(cap: CostCap | undefined, spend: Spend): CapStatus | undefined {
  if (cap === undefined) return undefined
  const limits: [CostLimit, number | undefined, number][] = [['maxUsd', cap.maxUsd, spend.usd], ['maxTokens', cap.maxTokens, spend.tokens], ['maxRequests', cap.maxRequests, spend.requests]]
  let warning: CapStatus | undefined
  for (const [limit, value, used] of limits) {
    if (value === undefined) continue
    if (used >= value) return { level: 'reached', limit, used, cap: value }
    if (warning === undefined && used >= value * COST_WARNING_RATIO) warning = { level: 'warning', limit, used, cap: value }
  }
  return warning
}

/** The key that makes a warning once per cap instance: scope, level, limit and the limit's value. */
export function warningKey(scope: CostCapScope, status: Pick<CapStatus, 'level' | 'limit' | 'cap'>): string {
  return `${scope}:${status.level}:${status.limit}:${status.cap}`
}

/** What a `cost.warning` agent event and ledger record carry. */
export interface CostWarning extends CapStatus {
  readonly scope: CostCapScope
  readonly estimated: boolean
}

/** The `ErrorInfo.details.scope` of a scope (`permissions.md` §费用上限). */
export function errorScope(scope: CostCapScope): 'task' | 'conversation' | 'project' {
  return scope === 'perTask' ? 'task' : scope === 'perConversation' ? 'conversation' : 'project'
}

/** The `ErrorInfo.details.metric` of a limit. */
export function errorMetric(limit: CostLimit): 'usd' | 'tokens' | 'requests' {
  return limit === 'maxUsd' ? 'usd' : limit === 'maxTokens' ? 'tokens' : 'requests'
}
