// Types for step5-real-judges.mjs (consumed by packages/test-support/tests/accept-step5-real.spec.ts).
import type { JudgeResult } from './step2-judges.mjs'
/** Observations of the real layer (step5-real.mjs `runRealScenario`); loosely typed, the judges read them defensively. */
export type RealObservations = Record<string, any>
/** Tool names a human must never have typed in this layer (R01–R03). */
export declare const TOOL_NAMES: RegExp
export declare const REAL_JUDGES: Readonly<Record<string, (obs: RealObservations) => JudgeResult>>
export declare function judgeReal(id: string, obs: RealObservations | undefined): JudgeResult
