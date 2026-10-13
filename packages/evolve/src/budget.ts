/**
 * The improvement budget (decision 6): tokens per project over a rolling
 * window, covering the diagnosis, proposal and trial phases of every job
 * created inside the window. Decisions use tokens only; dollars are for
 * display (decision 9, not here).
 *
 * A usage field the provider did not report (`'unknown'`) cannot be added
 * up; such phases count their known fields and are reported in
 * `unknownPhases`, so a reader can see the total is a lower bound.
 */
import type { LLMUsage } from '@nexgent/kernel'
import type { ImprovementBudget, ImprovementJob, PhaseCost } from './types.js'

const DAY_MS = 86_400_000

/** Billed tokens of one usage record (input, output, cache read and write); unknown fields count 0. */
export function billedTokens(usage: LLMUsage): { readonly tokens: number; readonly complete: boolean } {
  let tokens = 0
  let complete = true
  for (const value of [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens]) {
    if (value === 'unknown') complete = false
    else tokens += value
  }
  return { tokens, complete }
}

/** What the window has spent. */
export interface BudgetStatus {
  readonly limit: number
  readonly used: number
  readonly remaining: number
  readonly exhausted: boolean
  /** Phases whose usage was partly unknown (counted with their known fields). */
  readonly unknownPhases: number
  /** Start of the window (ISO-8601). */
  readonly windowStart: string
}

/** Spend of every job created in the window ending at `now`. */
export function budgetStatus(jobs: readonly ImprovementJob[], budget: ImprovementBudget, now: Date = new Date()): BudgetStatus {
  const start = now.getTime() - budget.windowDays * DAY_MS
  let used = 0
  let unknownPhases = 0
  for (const job of jobs) {
    if (Date.parse(job.createdAt) < start) continue
    for (const phase of Object.values(job.phases) as PhaseCost[]) {
      const { tokens, complete } = billedTokens(phase.usage)
      used += tokens
      if (!complete) unknownPhases += 1
    }
  }
  const remaining = Math.max(0, budget.tokens - used)
  return { limit: budget.tokens, used, remaining, exhausted: remaining <= 0, unknownPhases, windowStart: new Date(start).toISOString() }
}
