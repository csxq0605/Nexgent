/**
 * The learning budget (ADR 0018 decision 10, ADR 0017 decision 6;
 * `data-formats.md` §项目配置文件): estimated dollars of the project's ledger
 * records that carry `learningPhase`, over a rolling window by `ts`. It never
 * counts against a task's caps, and the task caps never count here.
 *
 * Dollars come from the price table (`@nexgent/llm` `estimateUsd`). A record
 * whose usage or price is unknown is still counted, with every known token at
 * the highest listed price, so an unknown never makes the budget look larger
 * than it is; such records are reported in `estimated`.
 */
import type { DollarBudget, LearningPhase, Ledger, LedgerRecord, LLMUsage } from '@nexgent/kernel'
import { estimateUsd, MODEL_PRICES } from '@nexgent/llm'

const DAY_MS = 86_400_000

/** What the window has spent. */
export interface LearningBudgetStatus {
  readonly maxUsd: number
  readonly windowDays: number
  readonly usedUsd: number
  readonly remainingUsd: number
  /** Records counted at the fallback price (usage or price unknown) or whose usage the host estimated (`usageEstimated`). */
  readonly estimated: number
  /** Learning requests in the window. */
  readonly requests: number
  /** Spend per learning phase, in first-seen order. */
  readonly phases: readonly { readonly phase: LearningPhase; readonly usd: number; readonly requestCount: number }[]
  /** Start of the window (ISO-8601). */
  readonly windowStart: string
}

/** Dollars of one usage at the highest listed price, unknown fields as 0. */
function fallbackUsd(usage: LLMUsage): number {
  const prices = Object.values(MODEL_PRICES)
  const max = (pick: (price: (typeof prices)[number]) => number) => Math.max(...prices.map(pick))
  const count = (value: number | 'unknown') => (value === 'unknown' ? 0 : value)
  return (count(usage.inputTokens) * max(p => p.input) + count(usage.outputTokens) * max(p => p.output)
    + count(usage.cacheReadTokens) * max(p => p.cacheRead) + count(usage.cacheWriteTokens) * max(p => p.cacheWrite)) / 1e6
}

/** Estimated dollars of one `llm.request.end` record, and whether it fell back. */
export function recordUsd(record: Pick<Extract<LedgerRecord, { type: 'llm.request.end' }>, 'model' | 'usage'>): { readonly usd: number; readonly estimated: boolean } {
  const usd = estimateUsd(record.model, record.usage)
  return usd === 'unknown' ? { usd: fallbackUsd(record.usage), estimated: true } : { usd, estimated: false }
}

/** Sum the learning records of `ledger` inside the window ending at `now`. */
export async function learningBudgetStatus(ledger: Pick<Ledger, 'read'>, budget: DollarBudget, now: Date = new Date()): Promise<LearningBudgetStatus> {
  const start = new Date(now.getTime() - budget.windowDays * DAY_MS)
  let usedUsd = 0
  let estimated = 0
  let requests = 0
  const phases = new Map<LearningPhase, { usd: number; requestCount: number }>()
  for await (const record of ledger.read({ from: start.toISOString(), types: ['llm.request.end'] })) {
    if (record.type !== 'llm.request.end' || record.learningPhase === undefined) continue
    if (Date.parse(record.ts) < start.getTime()) continue
    const { usd, estimated: fell } = recordUsd(record)
    usedUsd += usd
    requests += 1
    const phase = phases.get(record.learningPhase) ?? { usd: 0, requestCount: 0 }
    phases.set(record.learningPhase, { usd: phase.usd + usd, requestCount: phase.requestCount + 1 })
    if (fell || record.usageEstimated === true) estimated += 1
  }
  const remainingUsd = Math.max(0, budget.maxUsd - usedUsd)
  return { maxUsd: budget.maxUsd, windowDays: budget.windowDays, usedUsd, remainingUsd, estimated, requests, phases: [...phases].map(([phase, spend]) => ({ phase, ...spend })), windowStart: start.toISOString() }
}
