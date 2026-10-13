// Types for step5-judges.mjs (consumed by packages/test-support/tests/accept-step5-judges.spec.ts).
import type { JudgeResult } from './step2-judges.mjs'

/** Loose on purpose: the scenario maps product files onto it; judges read defensively. */
export type Step5Observations = Record<string, any>
export declare const JUDGES: Readonly<Record<string, (obs: Step5Observations) => JudgeResult>>
export declare function judge(id: string, obs: Step5Observations | undefined): JudgeResult
export declare function judgeFeedbackProject(
  project: Step5Observations | undefined,
  helpers: { judgeTable: (csv: string, table: string | null) => { missingConvention: boolean; problems: readonly string[] }; csvOf: (task: any) => string },
): JudgeResult
