// Types for step3-judges.mjs (consumed by packages/test-support/tests/accept-step3.spec.ts).
import type { ItemStatus } from './step2-checks.mjs'
export interface RepoInventory {
  readonly source: string
  readonly files: readonly string[]
}
export interface Step3Observations {
  readonly repo?: RepoInventory
}
export declare const FORBIDDEN_TOP_LEVEL: readonly string[]
export declare const JUDGES: Readonly<Record<string, (obs: Step3Observations) => { status: ItemStatus; evidence: string }>>
export declare function judge(id: string, obs: Step3Observations | undefined): { status: ItemStatus; evidence: string }
