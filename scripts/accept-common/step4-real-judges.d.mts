// Types for step4-real-judges.mjs (consumed by packages/test-support/tests/accept-step4-real.spec.ts).
import type { JudgeResult } from './step2-judges.mjs'
/** Observations of the real layer (step4-real.mjs `runRealScenario`); loosely typed, the judges read them defensively. */
export type RealObservations = Record<string, any>
export declare const REAL_JUDGES: Readonly<Record<string, (obs: RealObservations) => JudgeResult>>
export declare function judgeReal(id: string, obs: RealObservations | undefined): JudgeResult
