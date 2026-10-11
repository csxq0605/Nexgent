// Types for step2-checks.mjs (consumed by packages/test-support/tests/accept-step2.spec.ts).
export type LayerId = 'headless' | 'desktop' | 'real'
export type ItemStatus = 'passed' | 'failed' | 'not-implemented'
export type CheckResult =
  | { readonly pass: boolean; readonly evidence?: string }
  | { readonly status: ItemStatus; readonly evidence?: string }
export interface CheckEntry {
  readonly id: string
  readonly layer: LayerId
  readonly title: string
  readonly run?: (ctx: unknown) => CheckResult | Promise<CheckResult>
}
export declare const EXIT_PASS: 0
export declare const EXIT_FAIL: 1
export declare const EXIT_NOT_READY: 2
export declare const LAYERS: Readonly<Record<LayerId, { readonly title: string; readonly prefix: string }>>
export declare const DEFAULT_LAYERS: readonly LayerId[]
export declare const REAL_MODEL: {
  readonly model: string
  readonly thinking: 'on' | 'off'
  readonly budgetUsd: number
  readonly keyEnv: readonly string[]
  readonly task: string
}
export declare const CHECKS: readonly CheckEntry[]
export declare const OPTIONAL_CHECKS: ReadonlySet<string>
export declare function parseLayers(value: string | undefined):
  | { readonly ok: true; readonly layers: LayerId[] }
  | { readonly ok: false; readonly reason: string }
export declare function evaluateItem(entry: Partial<CheckEntry>, ctx: unknown): Promise<{ status: ItemStatus; evidence: string }>
export declare function decideExit(statuses: readonly ItemStatus[], notReady?: number): 0 | 1 | 2
export declare function budgetGate(capUsd: number, spentUsd: ReadonlyArray<number | string>):
  | { readonly ok: true; readonly remainingUsd: number }
  | { readonly ok: false; readonly reason: string }
export declare function realModelKeySource(env: Readonly<Record<string, string | undefined>>): string | undefined
