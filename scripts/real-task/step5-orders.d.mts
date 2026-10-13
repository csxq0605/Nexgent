// Types for step5-orders.mjs (consumed by packages/test-support/tests/step5-fixtures.spec.ts).
export { ordersCsv } from './step4-orders.mjs'
export interface FeedbackSpec {
  readonly key: string
  readonly rating?: 1 | 2 | 3 | 4 | 5
  readonly comment: string
}
export declare const CONVENTION_COLUMN: string
export declare const MONTHS: { readonly history: readonly string[]; readonly feedback: string; readonly next: string; readonly second: string }
export declare function regionTable(csvText: string, options: { withAverage: boolean }): string
export declare function judgeRegionTable(csvText: string, tableText: string | null | undefined): { readonly pass: boolean; readonly problems: readonly string[]; readonly missingConvention: boolean }
export declare function countsTowardImprovement(entry: { readonly rating?: number; readonly comment?: string } | null | undefined): boolean
export declare const THRESHOLD: number
export declare const FEEDBACK: readonly FeedbackSpec[]
/** The column the second family of feedback names (R07). */
export declare const SECOND_COLUMN: string
export declare const SECOND_FEEDBACK: readonly FeedbackSpec[]
