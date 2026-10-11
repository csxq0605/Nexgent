// Types for step2-sales-hidden.mjs (consumed by packages/test-support/tests/accept-step2-real.spec.ts).
export declare const SCRIPT_PATH: string
export declare const SUMMARY_PATH: string
export declare const README_PATH: string
export declare const DATA_PATH: string
export declare const HEADER: readonly string[]
export interface ExpectedRow { region: string; month: string; sales: number; growth: number | null }
export declare function parseCsv(text: string): string[][]
export declare function expectedSummary(ordersText: string): ExpectedRow[]
export declare function checkSummary(text: string | null, expected: readonly ExpectedRow[]): Array<[boolean, string]>
export declare function checkReadme(text: string | null): Array<[boolean, string]>
export declare function checkSalesProject(root: string, ordersPath: string): Promise<{ checks: Array<{ name: string; ok: boolean }>; expected: ExpectedRow[] }>
