// Types for step3-desktop.mjs (consumed by packages/test-support/tests/accept-step3-desktop.spec.ts).
export declare const MEMBERS_KEY: string
export declare const MEMBER_TEXTS: Readonly<Record<'firstTurn' | 'writerTask' | 'writerDone' | 'rootDone' | 'secondTurn' | 'slowTask', string>>
export declare const MEMBER_FILES: { readonly north: { readonly path: string; readonly content: string }; readonly env: { readonly path: string; readonly content: string } }
export declare function membersScript(): { script: unknown[]; routes: Record<string, unknown[]> }
/** Observations of the members scenario; loosely typed, the judges read them defensively. */
export type MembersObservations = Record<string, any>
export declare function runMembersDesktopScenario(harness: unknown, work: string, options?: { log?: (line: string) => void }): Promise<MembersObservations>
