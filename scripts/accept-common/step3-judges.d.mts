// Types for step3-judges.mjs (consumed by packages/test-support/tests/accept-step3.spec.ts).
import type { ItemStatus } from './step2-checks.mjs'
export interface RepoInventory {
  readonly source: string
  readonly files: readonly string[]
}
/** The direct phase's observations (step3-headless.mjs); loosely typed, judges read it defensively. */
export interface DirectObservations {
  readonly root?: string
  readonly sessionId?: string
  readonly reason?: { readonly kind: string; readonly [key: string]: unknown }
  readonly error?: string
  readonly toolCalls?: ReadonlyArray<{ readonly name: string; readonly isError: boolean }>
  readonly listed?: ReadonlyArray<{ readonly sessionId: string; readonly parentSessionId?: string; readonly childCount?: number }>
  readonly deliverables?: ReadonlyArray<{ readonly deliverableId: string; readonly versions: readonly unknown[] }>
  readonly requests?: ReadonlyArray<{ readonly route: string | null; readonly outcome: string }>
  readonly sessionFiles?: readonly string[]
  readonly sessions?: Readonly<Record<string, { readonly records: ReadonlyArray<Record<string, unknown>>; readonly truncated: unknown }>>
  readonly ledger?: ReadonlyArray<Record<string, unknown>>
  readonly export?: { readonly code: number | null; readonly stderr: string; readonly files: Readonly<Record<string, string>> }
  readonly secretHits?: readonly string[]
  readonly exportSecretHits?: readonly string[]
  readonly [key: string]: unknown
}
export interface Step3Observations {
  readonly repo?: RepoInventory
  readonly direct?: DirectObservations
}
export declare const STEP3_RECORD_TYPES: readonly string[]
export declare const FORBIDDEN_TOP_LEVEL: readonly string[]
export declare const JUDGES: Readonly<Record<string, (obs: Step3Observations) => { status: ItemStatus; evidence: string }>>
export declare function judge(id: string, obs: Step3Observations | undefined, tools?: unknown): { status: ItemStatus; evidence: string }
