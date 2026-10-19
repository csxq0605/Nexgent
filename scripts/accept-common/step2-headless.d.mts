// Types for step2-headless.mjs (consumed by packages/test-support/tests/accept-step2-judges.spec.ts).
import type { Observations } from './step2-judges.mjs'
export declare const DRIVER: string
export declare const AGENTS_MD: string
export declare const ORDERS_CSV: string
export declare const XLSX_SOURCE: string
export declare function sha256(bytes: string | Uint8Array): string
export declare function treeHashes(root: string): Promise<Record<string, string>>
export declare function openTurn(records: ReadonlyArray<{ readonly type: string; readonly turn?: number }>): number | undefined
export declare function filesContaining(dir: string, needle: string, base?: string): Promise<string[]>
export declare function runHeadlessScenario(h: unknown, work: string, options?: { readonly log?: (line: string) => void }): Promise<Observations>
