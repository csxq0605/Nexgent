// Types for step3-scenario.mjs (consumed by packages/test-support/tests/accept-step3-judges.spec.ts).
export declare const SCRIPTED_API_KEY: string
export declare const FILES: {
  readonly plan: { readonly path: string; readonly content: string }
  readonly summary: { readonly path: string; readonly content: string }
  readonly report: { readonly path: string; readonly content: string }
  readonly shared: { readonly path: string; readonly a: string; readonly b: string }
}
export declare const MATERIAL: { readonly name: string; readonly content: string }
export declare const HISTORY_MARKER: string
export declare const STALL_TEXT: string
export declare function readonlyPresets(): { readonly shell: string; readonly files: Readonly<Record<string, Record<string, unknown>>> }
export declare const TASKS: Readonly<Record<string, string>>
export declare const MEMBER_TASKS: Readonly<Record<string, string>>
export declare function buildStep3Script(h: unknown, state?: { materialId?: string }): Readonly<Record<string, { readonly lead: readonly unknown[]; readonly routes: Readonly<Record<string, readonly unknown[]>> }>>
