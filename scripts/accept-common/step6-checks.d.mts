// Types for step6-checks.mjs (consumed by packages/test-support/tests/accept-step6.spec.ts).
import type { CheckResult, ItemStatus } from './step2-checks.mjs'
export type { CheckResult, ItemStatus } from './step2-checks.mjs'
export { budgetGate, decideExit, EXIT_FAIL, EXIT_NOT_READY, EXIT_PASS } from './step2-checks.mjs'
export type Step6LayerId = 'headless' | 'desktop' | 'experiment' | 'real'
export interface Step6CheckEntry {
  readonly id: string
  readonly layer: Step6LayerId
  readonly title: string
  readonly run?: (ctx: unknown) => CheckResult | Promise<CheckResult>
}
export declare function evaluateItem(entry: Partial<Step6CheckEntry>, ctx: unknown): Promise<{ status: ItemStatus; evidence: string }>
export declare const LAYERS: Readonly<Record<Step6LayerId, { readonly title: string; readonly prefix: string }>>
export declare const DEFAULT_LAYERS: readonly Step6LayerId[]
export declare const REAL_MODEL: {
  readonly model: string
  readonly thinking: 'on'
  readonly budgetUsd: number
  readonly keyEnv: readonly string[]
  readonly task: string
}
export declare const STEP5_HEADLESS: readonly { readonly id: string; readonly run?: (ctx: unknown) => CheckResult | Promise<CheckResult> }[]
export declare function regressionVerdict(results: ReadonlyArray<readonly [string, CheckResult]>): CheckResult
export declare const CHECKS: readonly Step6CheckEntry[]
export declare const OPTIONAL_CHECKS: ReadonlySet<string>
export declare function parseLayers(value: string | undefined): { ok: true; layers: Step6LayerId[] } | { ok: false; reason: string }
export declare function realModelKeySource(env: Record<string, string | undefined>): string | undefined
export declare const REWORK_ITEMS: readonly string[]
export interface ReworkExpectation {
  readonly step: 5 | 6
  readonly id: string
  readonly kind: 'change' | 'verify' | 'stale'
  readonly adr: string
  readonly why: string
}
export declare const REWORK_EXPECTATIONS: readonly ReworkExpectation[]
