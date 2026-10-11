// Types for step2-runtime.mjs (consumed by packages/test-support/tests/accept-step2-judges.spec.ts).
export type Step2Packages = Record<'sdk' | 'session', any>
export declare const CLI_BIN: string
export declare function isLoopbackUrl(url: unknown): boolean
export declare function loadStep2Packages(): Promise<{ readonly ok: true; readonly pkgs: Step2Packages } | { readonly ok: false; readonly reason: string }>
export declare function createStep2Sdk(pkgs: Step2Packages, options: {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly home?: string
  readonly approvals?: (request: any, signal: AbortSignal) => Promise<any>
  readonly realModel?: boolean
}): any
export declare function runTurn(sdk: any, input: Record<string, unknown>, options?: { readonly onEvent?: (event: any) => void }): Promise<{ result: any; error?: unknown; events: any[] }>
export declare function eventLine(event: any): string | undefined
