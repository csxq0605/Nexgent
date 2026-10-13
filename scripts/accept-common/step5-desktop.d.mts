// Types for step5-desktop.mjs (consumed by packages/test-support/tests/accept-step5-desktop-judges.spec.ts).
/** The fake key the desktop app runs with. */
export declare const IMPROVEMENTS_DESKTOP_KEY: string
/** What the scenario types into the settings page (budget tokens, window days). */
export declare const SETTINGS_VALUES: Readonly<Record<'on' | 'off', { readonly budget: number; readonly window: number }>>
/** The desktop labels the scenario compares with. */
export declare const LABELS: Readonly<Record<'firstUse' | 'feedbackRate' | 'passRate' | 'review', string>>
/** Observations of the improvements desktop scenario; loosely typed, the judges read them defensively. */
export type ImprovementsDesktopObservations = Record<string, any>
export declare function runImprovementsDesktopScenario(harness: unknown, work: string, options?: { log?: (line: string) => void }): Promise<ImprovementsDesktopObservations>
