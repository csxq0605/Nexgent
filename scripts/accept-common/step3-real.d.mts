// Types for step3-real.mjs (consumed by packages/test-support/tests/accept-step3.spec.ts and accept-step3-real.spec.ts).
import type { RealObservations } from './step3-real-judges.mjs'
export declare const MATERIAL_PATH: string
export declare const TASK_CAPS: { readonly maxRequests: number; readonly maxTokens: number }
export declare const TASK: string
export declare const FEEDBACK: string
export declare const RUNS: ReadonlyArray<{ readonly id: string; readonly form: string; readonly ask: string }>
export declare function runRestock(h: unknown, pkgs: unknown, work: string, run: { id: string; form: string; ask: string }, options: { env: Record<string, string>; realModel?: boolean; turnTimeoutMs?: number; log?: (line: string) => void }): Promise<RealObservations>
export declare function runRealScenario(h: unknown, work: string, options: { env: Record<string, string>; realModel?: boolean; budgetUsd?: number; spent?: ReadonlyArray<number | string>; runCapUsd?: number; only?: readonly string[]; turnTimeoutMs?: number; log?: (line: string) => void }): Promise<RealObservations>
export declare function realPrerequisites(
  env: Readonly<Record<string, string | undefined>>,
  budgetUsd: number,
  spent: ReadonlyArray<number | string>,
): { readonly ok: false; readonly reason: string } | { readonly ok: true; readonly keySource: string; readonly remainingUsd: number }
