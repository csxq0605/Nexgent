// Types for step6-judges.mjs (consumed by packages/test-support/tests/accept-step6.spec.ts).
// Observations are typed loosely: the judges also read damaged or partial ones.
import type { CheckResult } from './step2-checks.mjs'
export declare function judgeV0(obs: unknown, regression: CheckResult | undefined): CheckResult
export declare function judgeStore(obs: unknown): CheckResult
export declare function judgePinned(obs: unknown): CheckResult
export declare function judgeSets(obs: unknown): CheckResult
export declare function judgeReport(obs: unknown): CheckResult
export declare function judgePilotReport(obs: unknown): CheckResult
