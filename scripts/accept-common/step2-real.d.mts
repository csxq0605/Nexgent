// Types for step2-real.mjs (consumed by packages/test-support/tests/accept-step2-real.spec.ts).
import type { Observations } from './step2-judges.mjs'
export declare const MATERIALS_DIR: string
export declare const PRICE: { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number }
export declare const TASK_CAPS: { readonly maxRequests: number; readonly maxTokens: number }
export declare const TASKS: { readonly first: string; readonly feedback: string; readonly round3: string; readonly resume: string }
export interface LedgerUsage {
  callCount: number
  known: { input: number; output: number; cacheRead: number; cacheWrite: number }
  unknownCount: number
  unknownRequestIds: string[]
  costUsd: number
  httpStatuses: number[]
}
export declare function ledgerUsage(ledger: ReadonlyArray<Record<string, any>>, sessionId: string | undefined): LedgerUsage
export declare function runRealScenario(h: unknown, work: string, options: {
  env: Record<string, string>
  keyFromEnv?: string
  realModel?: boolean
  runCapUsd?: number
  turnTimeoutMs?: number
  log?: (line: string) => void
}): Promise<Observations>
