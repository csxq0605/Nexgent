// Types for step4-desktop-judges.mjs (consumed by packages/test-support/tests/accept-step4-desktop.spec.ts).
import type { JudgeResult } from './step2-judges.mjs'
import type { CapabilitiesObservations } from './step4-desktop.mjs'
export declare const CAPABILITY_JUDGES: Readonly<Record<string, (obs: CapabilitiesObservations) => JudgeResult>>
export declare function judgeCapabilities(id: string, obs: CapabilitiesObservations | undefined): JudgeResult
