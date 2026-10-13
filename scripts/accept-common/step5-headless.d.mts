// Types for step5-headless.mjs (consumed by packages/test-support/tests/accept-step5.spec.ts).
import type { FeedbackProjectObservations } from './step5-fixtures.mjs'

export declare function evolvePackageBuilt(): boolean
export declare function evolveInSdk(sdkPackage: unknown): boolean
export declare function csvOf(task: { readonly id: string }): string
export declare function runStep5Headless(h: unknown, work: string, options?: { log?: (line: string) => void }): Promise<{ features: { evolve: boolean; evolvePackage: boolean }; project: FeedbackProjectObservations }>
