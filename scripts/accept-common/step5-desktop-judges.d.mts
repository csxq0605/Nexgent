// Types for step5-desktop-judges.mjs (consumed by packages/test-support/tests/accept-step5-desktop-judges.spec.ts).
import type { JudgeResult } from './step2-judges.mjs'
import type { ImprovementsDesktopObservations } from './step5-desktop.mjs'

export interface DesktopJudgeContext {
  /** The scenario's observations (absent when it could not run). */
  readonly improvements?: ImprovementsDesktopObservations | undefined
  /** Why the scenario could not run at all. */
  readonly improvementsError?: unknown | undefined
}
export declare const STATUS_WORDS: Readonly<Record<string, string>>
export declare const REASON_WORDS: Readonly<Record<string, string>>
export declare const TRIGGER_WORDS: Readonly<Record<string, string>>
export declare const LABELS: Readonly<Record<string, string>>
export declare const DESKTOP_JUDGES: Readonly<Record<'D19' | 'D20' | 'D21' | 'D22' | 'D23', (ctx: DesktopJudgeContext) => JudgeResult>>
export declare function judgeDesktop(id: string, ctx: DesktopJudgeContext): JudgeResult
