// Types for step3-runtime.mjs (consumed by packages/test-support/tests/accept-step3-judges.spec.ts).
export declare function loadStep3Packages(): Promise<{ ok: true; pkgs: { sdk: unknown; session: unknown; subagent: unknown } } | { ok: false; reason: string }>
export declare function step3Rows(pkgs: unknown): { registry: Record<string, unknown>; patches: unknown[] }
export declare function createStep3Sdk(pkgs: unknown, options: { env: Record<string, string>; home: string; approvals?: unknown }): unknown
