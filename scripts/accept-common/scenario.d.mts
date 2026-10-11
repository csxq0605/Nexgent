// Types for scenario.mjs (consumed by apps/cli/tests/accept-common.spec.ts).
export declare const WRITE_TOOL: string
export declare const SCRIPTED_API_KEY: string
export declare const FILES: {
  readonly first: { readonly path: string; readonly content: string }
  readonly resumed: { readonly path: string; readonly content: string }
}
export declare const TASKS: { readonly write: string; readonly long: string; readonly resume: string }
export declare function buildScript(): Array<Record<string, unknown>>
export declare function parseJsonLines(text: string): Array<Record<string, unknown>>
