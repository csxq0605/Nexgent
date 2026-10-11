// Types for step3-scenario.mjs (consumed by packages/test-support/tests/accept-step3-judges.spec.ts).
export declare const SCRIPTED_API_KEY: string
export declare const FILES: Readonly<Record<string, { readonly path: string; readonly content: string }>>
export declare const TASKS: Readonly<Record<string, string>>
export declare function buildStep3Script(h: unknown): Readonly<Record<string, { readonly lead: readonly unknown[]; readonly routes: Readonly<Record<string, readonly unknown[]>> }>>
