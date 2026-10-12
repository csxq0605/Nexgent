// Types for step4-real.mjs (consumed by packages/test-support/tests/accept-step4.spec.ts and accept-step4-real.spec.ts).
import type { RealObservations } from './step4-real-judges.mjs'
export declare const TASK_CAPS: { readonly maxRequests: number; readonly maxTokens: number }
export declare const TRIAL_BUDGET: { readonly maxRequests: number; readonly maxTokens: number }
export declare const RESERVE: { readonly task: number; readonly gate: number }
export declare const HISTORY: ReadonlyArray<{ readonly id: string; readonly kind: string; readonly month: string; readonly input: string; readonly output: string; readonly ask: string }>
export declare const REGRESSION_TASKS: ReadonlyArray<{ readonly id: string; readonly kind: string; readonly month: string; readonly input: string; readonly output: string; readonly ask: string }>
export declare const AFTER_ROLLBACK: { readonly id: string; readonly kind: string; readonly month: string; readonly input: string; readonly output: string; readonly ask: string }
export declare function hiddenCheck(task: { readonly kind: string; readonly month: string; readonly output: string }, text: string | null | undefined): { readonly pass: boolean; readonly problems: readonly string[] }
export declare function usageOf(records: ReadonlyArray<Record<string, unknown>>): { readonly callCount: number; readonly known: { input: number; output: number; cacheRead: number; cacheWrite: number }; readonly unknownCount: number; readonly unknownRequestIds: readonly string[]; readonly costUsd: number }
export declare function brokenModuleSource(spec: { readonly functions?: ReadonlyArray<{ readonly name?: unknown }> }): string
export declare function runRealScenario(h: unknown, work: string, options: { env: Record<string, string | undefined>; realModel?: boolean; budgetUsd?: number; spent?: ReadonlyArray<number | string>; turnTimeoutMs?: number; gateTimeoutMs?: number; log?: (line: string) => void }): Promise<RealObservations>
export declare function realPrerequisites(
  env: Readonly<Record<string, string | undefined>>,
  budgetUsd: number,
  spent: readonly (number | 'unknown')[],
):
  | { readonly ok: true; readonly keySource: string; readonly remainingUsd: number }
  | { readonly ok: false; readonly reason: string }
export declare const TASK_A_REAL: { readonly id: string; readonly kind: string; readonly month: string; readonly input: string; readonly output: string; readonly ask: string }
