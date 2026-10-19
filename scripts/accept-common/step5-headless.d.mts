// Types for step5-headless.mjs (consumed by packages/test-support/tests/accept-step5.spec.ts).
import type { Step5Observations } from './step5-judges.mjs'

export declare function evolvePackageBuilt(): boolean
export declare function csvOf(task: { readonly id: string }): string
export declare function runStep5Headless(h: unknown, work: string, options?: { log?: (line: string) => void }): Promise<Step5Observations>
