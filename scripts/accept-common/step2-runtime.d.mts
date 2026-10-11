// Types for step2-runtime.mjs (consumed by packages/test-support/tests/accept-step2-judges.spec.ts).
export type Step2Packages = Record<'kernel' | 'llm' | 'session' | 'workspace' | 'context' | 'tasking' | 'skill' | 'cli', any>
export declare function isLoopbackUrl(url: unknown): boolean
export declare function loadStep2Packages(): Promise<{ readonly ok: true; readonly pkgs: Step2Packages } | { readonly ok: false; readonly reason: string }>
export declare function bootStep2(pkgs: Step2Packages, options: {
  readonly root: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly context?: Record<string, unknown>
  readonly approvals?: (request: any, signal: AbortSignal) => Promise<any>
  readonly realModel?: boolean
}): Promise<{ app: any; ctx: any; tasking: any; skills: any }>
export declare function runTurn(agent: any, input: unknown, options?: { readonly onEvent?: (event: any, agent: any) => void }): Promise<{ result: any; error?: unknown; events: any[] }>
export declare function eventLine(event: any): string | undefined
