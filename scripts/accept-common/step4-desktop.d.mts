// Types for step4-desktop.mjs (consumed by packages/test-support/tests/accept-step4-desktop.spec.ts).
export declare const CAPABILITY_DESKTOP_KEY: string
export declare const CAPABILITY_TEXTS: Readonly<Record<'firstTurn' | 'firstDone' | 'secondTurn' | 'secondDone' | 'rejectDetail' | 'rollbackReason', string>>
export declare const PLUGIN_NAME: string
export declare const PLUGIN_SPEC: Readonly<{ formatVersion: 1; name: string; description: string; permissions: string; tools: readonly string[] }>
export declare function capabilityScript(): { script: unknown[] }
/** Observations of the capabilities scenario; loosely typed, the judges read them defensively. */
export type CapabilitiesObservations = Record<string, any>
export declare function runCapabilitiesDesktopScenario(harness: unknown, work: string, options?: { log?: (line: string) => void }): Promise<CapabilitiesObservations>
