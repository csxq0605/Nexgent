// Types for scenario-step2.mjs (consumed by packages/test-support/tests/accept-step2-judges.spec.ts).
export declare const OFFICE_SKILL: string
export declare const SCRIPTED_API_KEY: string
export declare const COMPACTION: { readonly threshold: number; readonly reportedInput: number; readonly summary: string }
export declare const MATERIALS: { readonly csv: string; readonly xlsx: string }
export declare const FILES: {
  readonly summary: { readonly path: string; readonly v1: string; readonly v2: string }
  readonly readme: { readonly path: string; readonly initial: string; readonly edited: string }
  readonly shellNote: { readonly path: string; readonly line: string }
  readonly outside: { readonly path: string; readonly content: string }
  readonly env: { readonly path: string; readonly allowed: string; readonly denied: string }
}
export declare const TASKS: Readonly<Record<string, string>>
export declare const STALL_TEXT: { readonly cancel: string; readonly kill: string }
export declare const SLOW_COMMAND: { readonly bash: string; readonly pwsh: string }
export declare const APPEND_NOTE: { readonly bash: string; readonly pwsh: string }
export declare function shellCall(command: { readonly bash: string; readonly pwsh: string }): { name: string; arguments: { command: string } }
export declare function materialPath(text: string, name: string): string | undefined
export declare function deliverableIdFrom(text: string): string | undefined
export declare function lastUserMentions(body: unknown, needle: string, h: { requestText(body: unknown): string }): boolean
export declare function buildStep2Script(h: unknown): Readonly<Record<string, readonly unknown[]>>
export declare const USER_WORDS_HEADING: string
export declare function userWordsSection(requestText: (body: unknown) => string, body: unknown): string
export declare function outsideUserWordsText(requestText: (body: unknown) => string, body: unknown): string
