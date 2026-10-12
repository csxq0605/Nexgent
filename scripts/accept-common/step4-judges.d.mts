// Types for step4-judges.mjs (consumed by packages/test-support/tests/accept-step4-judges.spec.ts).
import type { ItemStatus } from './step2-checks.mjs'
export interface CheckResult { readonly status: ItemStatus; readonly evidence: string }
/** Observations of step4-headless.mjs; judges read them defensively. */
export type Step4Observations = Record<string, any>
export declare const FUNCTION_TOOL: string
export declare function versionWritten(obs: Step4Observations): boolean
export declare const JUDGES: Readonly<Record<string, (obs: Step4Observations) => CheckResult>>
export interface CheckpointEntry {
  readonly id: string
  readonly title: string
  readonly from?: readonly string[]
}
export declare const CHECKPOINT: readonly CheckpointEntry[]
export declare function checkpoint4(obs: Step4Observations): CheckResult
export declare function judgeCheckpoint(obs: Step4Observations): (CheckpointEntry & CheckResult)[]
export declare function judge(id: string, obs: Step4Observations | undefined): CheckResult
