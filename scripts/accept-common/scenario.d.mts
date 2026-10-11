// Types for scenario.mjs (consumed by apps/cli/tests/accept-common.spec.ts).
export declare const WRITE_TOOL: string
export declare const SCRIPTED_API_KEY: string
export declare const RUNTIME_NOT_WIRED_CODE: string
export declare const FILES: {
  readonly first: { readonly path: string; readonly content: string }
  readonly resumed: { readonly path: string; readonly content: string }
}
export declare const TASKS: { readonly write: string; readonly long: string; readonly resume: string }
export interface ScenarioRecord {
  readonly type: string
  readonly [key: string]: unknown
}
export declare function buildScript(): Array<Record<string, unknown>>
export declare function parseJsonLines(text: string): Array<Record<string, unknown>>
export declare function sessionIdFrom(events: ReadonlyArray<Record<string, unknown>>): string | undefined
export declare function isRuntimeNotWired(exit: { readonly code: number | null }, events: ReadonlyArray<Record<string, unknown>>): boolean
export declare function turnEndKinds(records: readonly ScenarioRecord[]): Map<number, string | undefined>
export declare function seqContiguous(records: readonly ScenarioRecord[]): boolean
export declare function openTurns(records: readonly ScenarioRecord[]): number[]
export declare function taskOutcomes(ledger: readonly ScenarioRecord[], sessionId: string): ScenarioRecord[]
export declare function unpairedRequests(ledger: readonly ScenarioRecord[]): { withoutEnd: string[]; withoutStart: string[] }
export declare function requestMentions(body: { readonly messages?: ReadonlyArray<{ readonly role: string; readonly content?: unknown }> } | undefined, text: string): boolean
