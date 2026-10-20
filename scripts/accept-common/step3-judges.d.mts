// Types for step3-judges.mjs (consumed by packages/test-support/tests/accept-step3.spec.ts).
import type { ItemStatus } from './step2-checks.mjs'
export interface RepoInventory {
  readonly source: string
  readonly files: readonly string[]
}
/** The direct phase's observations (step3-headless.mjs); loosely typed, judges read it defensively. */
export interface DirectObservations {
  readonly root?: string
  readonly sessionId?: string
  readonly reason?: { readonly kind: string; readonly [key: string]: unknown }
  readonly error?: string
  readonly toolCalls?: ReadonlyArray<{ readonly name: string; readonly isError: boolean }>
  readonly listed?: ReadonlyArray<{ readonly sessionId: string; readonly parentSessionId?: string; readonly childCount?: number }>
  readonly deliverables?: ReadonlyArray<{ readonly deliverableId: string; readonly versions: readonly unknown[] }>
  readonly requests?: ReadonlyArray<{ readonly route: string | null; readonly outcome: string }>
  readonly sessionFiles?: readonly string[]
  readonly sessions?: Readonly<Record<string, { readonly records: ReadonlyArray<Record<string, unknown>>; readonly truncated: unknown }>>
  readonly ledger?: ReadonlyArray<Record<string, unknown>>
  readonly export?: { readonly code: number | null; readonly stderr: string; readonly files: Readonly<Record<string, string>> }
  readonly secretHits?: readonly string[]
  readonly exportSecretHits?: readonly string[]
  readonly [key: string]: unknown
}
/** One scripted-server request, slimmed (step3-headless.mjs `slimRequest`). */
export interface RequestObservation {
  readonly phase: string
  readonly route: string | null
  readonly outcome: string
  readonly chunksSent: number
  readonly sessionText: string
  readonly text: string
  readonly tools: readonly string[]
}
type Sessions = Readonly<Record<string, { readonly records: ReadonlyArray<Record<string, unknown>>; readonly truncated: unknown }>>
/** The delegation project's observations (setup, fresh, fork, sameName, forkKill, resume). */
export interface DelegationObservations {
  readonly root?: string
  readonly sessionId?: string
  readonly materialId?: string
  readonly phases?: Readonly<Record<string, Readonly<Record<string, unknown>>>>
  readonly requests?: readonly RequestObservation[]
  readonly afterKill?: { readonly sessionFiles: readonly string[]; readonly sessions: Sessions }
  readonly sessionFiles?: readonly string[]
  readonly sessions?: Sessions
  readonly deliverables?: ReadonlyArray<{ readonly deliverableId: string; readonly versions: ReadonlyArray<{ readonly version: number; readonly sessionId: string; readonly memberId?: string; readonly files: readonly string[] }> }>
  readonly ledger?: ReadonlyArray<Record<string, unknown>>
  readonly [key: string]: unknown
}
/** The read-only project's observations. */
export interface ReadonlyObservations {
  readonly root?: string
  readonly shell?: string
  readonly sessionId?: string
  readonly reason?: { readonly kind: string; readonly [key: string]: unknown }
  readonly requests?: readonly RequestObservation[]
  readonly sessionFiles?: readonly string[]
  readonly sessions?: Sessions
  readonly [key: string]: unknown
}
export interface Step3Observations {
  readonly repo?: RepoInventory
  readonly direct?: DirectObservations
  readonly delegation?: DelegationObservations
  readonly readonly?: ReadonlyObservations
  readonly tools?: ProjectObservations
  readonly workflow?: ProjectObservations
  readonly cancel?: ProjectObservations
  readonly budget?: ProjectObservations
  readonly memberApproval?: ProjectObservations
  readonly skills?: ProjectObservations
  /** H21: what a fresh SDK's session queries return, per project, plus the model requests they caused. */
  readonly queries?: Readonly<Record<string, any>>
}
/** The tools and workflow projects' observations. */
export interface ProjectObservations {
  readonly root?: string
  readonly sessionId?: string
  readonly phases?: Readonly<Record<string, Readonly<Record<string, unknown>>>>
  readonly requests?: readonly RequestObservation[]
  readonly sessionFiles?: readonly string[]
  readonly sessions?: Sessions
  readonly ledger?: ReadonlyArray<Record<string, unknown>>
  readonly [key: string]: unknown
}
export declare const STEP3_RECORD_TYPES: readonly string[]
export declare const FORBIDDEN_TOP_LEVEL: readonly string[]
export declare const COLLABORATION_TOOLS: readonly string[]
export declare function forbiddenFor(form: string | undefined): string[]
export declare const PROJECTS: readonly string[]
export declare const JUDGES: Readonly<Record<string, (obs: Step3Observations) => { status: ItemStatus; evidence: string }>>
export declare function judge(id: string, obs: Step3Observations | undefined, tools?: unknown): { status: ItemStatus; evidence: string }
