// Types for step6-headless.mjs (consumed by packages/test-support/tests/accept-step6.spec.ts).
// Observations are typed loosely; the judges in step6-judges.mjs read them.
export declare function loadCapabilities(): Promise<Record<string, any>>
export declare function projectRoots(dir: string): Promise<string[]>
export declare function v0Phase(pkgs: unknown, step5Work: string): Promise<Record<string, unknown>>
export declare function storePhase(capabilities: Record<string, any>, kernel: Record<string, any>, work: string): Promise<Record<string, unknown>>
export declare function pinnedPhase(h: unknown, pkgs: unknown, capabilities: Record<string, any>, work: string, log: (line: string) => void): Promise<Record<string, unknown>>
export declare function runStep6Headless(h: unknown, work: string, options?: { step5Work?: string; log?: (line: string) => void }): Promise<Record<string, unknown>>
