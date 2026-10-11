// Types for step2-desktop.mjs (consumed by packages/test-support/tests/accept-step2-desktop.spec.ts).
import type { Observations } from './step2-judges.mjs'
export declare const DESKTOP_DIR: string
export declare const DESKTOP_KEY: string
export declare const LONG_TEXT: readonly string[]
export declare const TEXTS: { readonly firstTurn: string; readonly feedbackDone: string; readonly killStream: string; readonly continued: string }
export declare const ENV_CONTENT: string
export declare const SETTINGS: { readonly model: string; readonly thinking: string; readonly perTaskTokens: number; readonly perProjectRequests: number }
export declare function desktopScript(): unknown[]
export declare function desktopPrerequisites(): Promise<{ ok: true } | { ok: false; reason: string }>
export declare function runDesktopScenario(harness: unknown, work: string, options?: { log?: (line: string) => void }): Promise<Observations>
export declare const VITE_BIN: string
export declare function run(command: string, args: string[], options?: object): Promise<{ code: number | null; stderr: string }>
export declare function ensureDisplay(): Promise<{ display: string | undefined; stop: () => void }>
export declare function poll<T>(read: () => Promise<T> | T, ok: (value: T) => boolean, what: string, ms?: number): Promise<T>
