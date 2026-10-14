// Types for step6-desktop.mjs (consumed by packages/test-support/tests/accept-step6-desktop-judges.spec.ts).
/** The fake key the desktop app runs with. */
export declare const META_DESKTOP_KEY: string
/** What the scenario types into the settings page: the user-level meta settings and the project's sharing switch (saved separately). */
export declare const META_SETTINGS: Readonly<Record<'on' | 'off', { readonly enabled: boolean; readonly every: number; readonly budget: number; readonly window: number; readonly share: boolean }>>
/** The three ADR 0013 gate conclusions the last launch shows (seeded). */
export declare const GATE_SEEDS: readonly Record<string, unknown>[]
/** The paragraph change of the seeded child improver. */
export declare const SEEDED_CHANGE: Readonly<Record<string, unknown>>
/** Observations of the step-6 desktop scenario; loosely typed, the judges read them defensively. */
export type Step6DesktopObservations = Record<string, any>
export declare function runStep6DesktopScenario(harness: unknown, work: string, options?: { log?: (line: string) => void }): Promise<Step6DesktopObservations>
