// Types for step5-real.mjs (consumed by packages/test-support/tests/accept-step5-real.spec.ts).
import type { RealObservations } from './step5-real-judges.mjs'
import type { usageOf } from './step4-real.mjs'

type Task = { readonly id: string; readonly kind: string; readonly month: string; readonly input: string; readonly output: string; readonly ask: string }
type Usage = ReturnType<typeof usageOf>
export declare const TASK_CAPS: { readonly maxRequests: number; readonly maxTokens: number }
export declare const TRIAL_BUDGET: { readonly maxRequests: number; readonly maxTokens: number }
export declare const IMPROVEMENT: { readonly feedbackThreshold: number; readonly budget: { readonly maxTokens: number; readonly windowDays: number }; readonly model: string; readonly thinking: string }
export declare const RESERVE: { readonly task: number; readonly feedback: number; readonly job: number }
export declare const SECOND_TASK: Task
export declare const SETTLED: ReadonlySet<string>
export declare function hiddenCheck(task: { readonly kind: string; readonly month: string; readonly output: string }, text: string | null | undefined): { readonly pass: boolean; readonly base: boolean; readonly missingConvention?: boolean; readonly problems: readonly string[] }
export declare function jobUsage(ledger: ReadonlyArray<Record<string, unknown>>, jobId: string): { readonly phases: Readonly<Record<string, Usage>>; readonly total: Usage }
export declare function runRealScenario(h: unknown, work: string, options: { env: Record<string, string | undefined>; realModel?: boolean; budgetUsd?: number; spent?: ReadonlyArray<number | string>; turnTimeoutMs?: number; jobTimeoutMs?: number; log?: (line: string) => void; second?: boolean }): Promise<RealObservations>
