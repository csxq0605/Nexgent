// Types for step2-real-judges.mjs (consumed by packages/test-support/tests/accept-step2-real.spec.ts).
import type { JudgeResult, Observations } from './step2-judges.mjs'
export declare const REAL_JUDGES: Readonly<Record<string, (obs: Observations) => JudgeResult>>
export declare function judgeReal(id: string, obs: Observations | undefined): JudgeResult
