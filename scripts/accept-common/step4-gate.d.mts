// Types for step4-gate.mjs (consumed by packages/test-support/tests/accept-step4-judges.spec.ts).
import type { FamilyTask } from './step4-fixtures.mjs'
export declare const GATE_PLUGIN: Readonly<{ kind: 'plugin'; name: string; tool: string; marker: string }>
export declare const GATE_TASKS: Readonly<Record<'A0' | 'H1' | 'H2' | 'H3' | 'C' | 'B2' | 'D' | 'E' | 'F' | 'G', FamilyTask>>
export declare const REGRESS: Readonly<{ input: string; ask: string }>
export declare const BUDGET: Readonly<{ maxRequests: number; maxTokens: number }>
export declare const SKILLS: Readonly<{ D: string; F: string }>
/** Observations of the gate scenario; loosely typed, the judges read them defensively. */
export type GateObservations = Record<string, any>
export declare function runStep4Gate(h: unknown, work: string, options?: { log?: (line: string) => void }): Promise<GateObservations>
