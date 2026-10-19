// Types for step4-scenario.mjs (consumed by packages/test-support/tests/accept-step4-judges.spec.ts).
import type { ComponentFile } from './step4-fixtures.mjs'
export interface PolicyComponent {
  readonly kind: 'context-policy'
  readonly name: string
  readonly files: readonly ComponentFile[]
}
export declare const CAPABILITY_TOOLS: readonly string[]
export declare const FUNCTION_TOOL: string
export declare const ASKS: Readonly<Record<'peer' | 'extras' | 'tamper', string>>
export declare const HELPER: { readonly name: string; readonly task: string }
export declare const POLICIES: {
  readonly good: PolicyComponent
  readonly bad: readonly (PolicyComponent & { readonly field: string })[]
}
export declare const PLUGIN: { readonly kind: 'plugin'; readonly name: string; readonly tool: string }
export declare function pluginFiles(marker: string): ComponentFile[]
export declare function draftPath(sessionId: string, file: string): string
export declare function bundlePath(version: string, file: string): string
export declare function routeOf(h: unknown): (body: unknown) => string | undefined
export declare function buildStep4Script(h: unknown, state: Record<string, unknown>): Promise<{ lead: unknown[]; routes: Record<string, unknown[]> }>
