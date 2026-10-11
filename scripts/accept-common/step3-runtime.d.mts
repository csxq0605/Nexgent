// Types for step3-runtime.mjs (consumed by packages/test-support/tests/accept-step3-judges.spec.ts).
export declare function loadStep3Packages(): Promise<{ ok: true; pkgs: Record<'sdk' | 'session' | 'subagent' | 'team' | 'workflow' | 'ptc' | 'spreadsheet' | 'web', unknown> } | { ok: false; reason: string }>
export declare const TEST_WEB_ADDRESS: string
export declare function step3Rows(pkgs: unknown, options?: { web?: 'shipped' | 'test' }): { registry: Record<string, unknown>; patches: unknown[] }
export declare function createStep3Sdk(pkgs: unknown, options: { env: Record<string, string>; home: string; approvals?: unknown; web?: 'shipped' | 'test' }): unknown
