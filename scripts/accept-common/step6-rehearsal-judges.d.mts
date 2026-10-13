// Types for step6-rehearsal-judges.mjs (consumed by packages/test-support/tests/accept-step6-rehearsal-judges.spec.ts).
// Observations are typed loosely: the judges also read damaged or partial ones.
import type { CheckResult } from './step2-checks.mjs'
export declare function judgeIsolation(obs: unknown): CheckResult
export declare function judgeHoldoutArms(obs: unknown): CheckResult
