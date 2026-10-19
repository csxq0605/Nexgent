// Types for step2-desktop-judges.mjs (consumed by packages/test-support/tests/accept-step2-desktop.spec.ts).
import type { JudgeResult, Observations } from './step2-judges.mjs'
export declare const DESKTOP_JUDGES: Readonly<Record<string, (obs: Observations) => JudgeResult>>
export declare function judgeDesktop(id: string, obs: Observations | undefined): JudgeResult
