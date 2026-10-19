// Types for step3-desktop-judges.mjs (consumed by packages/test-support/tests/accept-step3-desktop.spec.ts).
import type { JudgeResult } from './step2-judges.mjs'
import type { MembersObservations } from './step3-desktop.mjs'
export declare const WRITER_APPROVAL_LINE: string
export declare const MEMBER_JUDGES: Readonly<Record<string, (obs: MembersObservations) => JudgeResult>>
export declare function judgeMembers(id: string, obs: MembersObservations | undefined): JudgeResult
