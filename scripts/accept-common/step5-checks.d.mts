// Types for step5-checks.mjs (consumed by packages/test-support/tests/accept-step5.spec.ts).
import type { CheckEntry, CheckResult, LayerId } from './step2-checks.mjs'
export type { CheckEntry, CheckResult, ItemStatus, LayerId } from './step2-checks.mjs'
export { budgetGate, decideExit, evaluateItem, EXIT_FAIL, EXIT_NOT_READY, EXIT_PASS } from './step2-checks.mjs'
export declare const LAYERS: Readonly<Record<LayerId, { readonly title: string; readonly prefix: string }>>
export declare const DEFAULT_LAYERS: readonly LayerId[]
export declare const REAL_MODEL: {
  readonly model: string
  readonly thinking: 'on'
  readonly budgetUsd: number
  readonly keyEnv: readonly string[]
  readonly task: string
}
export declare const STEP4_HEADLESS: readonly CheckEntry[]
export declare function regressionVerdict(results: ReadonlyArray<readonly [string, CheckResult]>): CheckResult
export declare const CHECKS: readonly CheckEntry[]
export declare const OPTIONAL_CHECKS: ReadonlySet<string>
export declare function parseLayers(value: string | undefined): { ok: true; layers: LayerId[] } | { ok: false; reason: string }
export declare function realModelKeySource(env: Record<string, string | undefined>): string | undefined
