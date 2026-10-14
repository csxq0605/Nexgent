// Types for step6-desktop-judges.mjs (consumed by packages/test-support/tests/accept-step6-desktop-judges.spec.ts).
// Observations are typed loosely: the judges also read damaged or partial ones.
import type { JudgeResult } from './step2-judges.mjs'
import type { Step6DesktopObservations } from './step6-desktop.mjs'

export declare const IMPROVER_REASON_WORDS: Readonly<Record<string, string>>
export declare const GATE_REASON_WORDS: Readonly<Record<string, string>>
export declare const ADR0013_REASON_WORDS: Readonly<Record<string, string>>
export declare const SHARED_NOTE: string
export declare function judgeD24(obs: Step6DesktopObservations | undefined): JudgeResult
export declare function judgeD25(obs: Step6DesktopObservations | undefined): JudgeResult
export declare function judgeD26(obs: Step6DesktopObservations | undefined): JudgeResult
export declare function judgeD27(obs: Step6DesktopObservations | undefined): JudgeResult
export declare const DESKTOP_JUDGES: Readonly<Record<'D24' | 'D25' | 'D26' | 'D27', (obs: Step6DesktopObservations | undefined) => JudgeResult>>
