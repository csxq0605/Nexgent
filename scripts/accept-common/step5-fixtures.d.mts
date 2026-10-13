// Types for step5-fixtures.mjs (consumed by packages/test-support/tests/step5-fixtures.spec.ts).
import type { FeedbackSpec } from '../real-task/step5-orders.mjs'

export interface ComponentFile {
  readonly path: string
  readonly content: string
}
export interface ComponentRef {
  readonly kind: string
  readonly name: string
}
export interface FamilyTask {
  readonly id: string
  readonly kind: 'summary' | 'regions'
  readonly month: string
  readonly set?: 'selection' | 'guard'
  readonly input: string
  readonly output: string
  readonly checkCommand: string
  readonly ask: string
}
export interface CheckRun {
  readonly exitCode: number | null
  readonly passed: boolean
  readonly stdout: string
}
export interface ToolCall {
  readonly name: string
  readonly arguments: Record<string, unknown>
}
export interface PlaybookStep {
  readonly phase: 'diagnose' | 'propose'
  readonly toolCalls?: readonly ToolCall[]
  readonly content?: string
}
export type PlaybookName = 'improve' | 'not-capability' | 'broken' | 'invalid' | 'two'
export interface Playbook {
  readonly name: PlaybookName
  readonly title: string
  readonly steps: readonly PlaybookStep[]
  readonly expect: {
    readonly candidate: boolean
    readonly component?: ComponentRef
    readonly outcome: string | readonly string[]
    readonly output?: string
  }
}
export interface EvidenceRef {
  readonly sessionId: string
  readonly turn: number
  readonly seq: number
}
export interface FeedbackProjectObservations {
  readonly root: string
  readonly home: string
  readonly projectId?: string
  readonly tasks: readonly {
    readonly id: string
    readonly set?: 'selection' | 'guard'
    readonly sessionId: string
    readonly reason?: { readonly kind: string }
    readonly error?: string
    readonly output: string | null
    readonly check: CheckRun
  }[]
  readonly deliverable?: { readonly deliverableId: string; readonly version: number; readonly sessionId: string }
  readonly deliverables?: readonly { readonly deliverableId: string; readonly version: number; readonly sessionId: string }[]
  readonly before?: unknown
  readonly feedback: readonly (FeedbackSpec & { readonly id?: string; readonly counted: boolean; readonly reason?: { readonly kind: string }; readonly observed?: unknown })[]
  readonly listing?: readonly { readonly id: string; readonly comment: string; readonly rating?: number; readonly sessionId: string; readonly turn: number }[]
}
export declare const SCRIPTED_API_KEY: string
export declare const DIAGNOSIS_TOOL: string
export declare const MAST: readonly string[]
export declare const JOB_STATES: readonly string[]
export declare const TERMINAL_STATES: readonly string[]
export declare const PARKED_STATES: readonly string[]
export declare const REGIONS_VERIFY_SOURCE: string
export declare function checkSource(entry: FamilyTask): string
export declare function familyTask(id: string, kind: 'summary' | 'regions', month: string, options?: { set?: 'selection' | 'guard' }): FamilyTask
export declare const HISTORY_TASKS: readonly FamilyTask[]
export declare const FEEDBACK_TASK: FamilyTask
export declare const NEXT_TASK: FamilyTask
export declare function writeFeedbackProject(root: string): Promise<{ root: string; months: string[]; files: string[] }>
export declare function outputFor(entry: FamilyTask, options?: { withAverage?: boolean }): string
export declare function runCheck(root: string, entry: FamilyTask): CheckRun
export declare function taskScript(h: unknown, tasks: readonly FamilyTask[], options?: { withAverage?: boolean }): unknown[]
export declare function feedbackScript(h: unknown, feedback: readonly FeedbackSpec[]): unknown[]
export declare const CONVENTION_SKILL: { readonly kind: 'skill'; readonly name: string; readonly files: readonly ComponentFile[] }
export declare const BROKEN_MODULE: { readonly kind: 'function-module'; readonly name: string; readonly function: string; readonly tool: string; readonly files: readonly ComponentFile[] }
export declare function playbook(name: PlaybookName, ctx: EvidenceRef): Playbook
export declare const PLAYBOOKS: readonly PlaybookName[]
export declare const EXTRA_PLAYBOOKS: readonly PlaybookName[]
export declare const PROPOSAL_MARKER: string
export declare const MISSING_SESSION: string
export declare const SECOND_SKILL: { readonly kind: 'skill'; readonly name: string; readonly files: readonly ComponentFile[] }
export declare function isDiagnosisRequest(body: unknown): boolean
export declare function isProposalRequest(h: unknown): (body: unknown) => boolean
export declare function playbookScript(h: unknown, name: PlaybookName, ctx: EvidenceRef): unknown[]
export declare function runFeedbackProject(
  h: unknown,
  pkgs: unknown,
  work: string,
  options?: {
    feedback?: readonly FeedbackSpec[]
    log?: (line: string) => void
    config?: Record<string, unknown>
    createSdk?: (env: Record<string, string>, home: string) => unknown
    server?: { readonly baseUrl: string; close(): Promise<void> }
    tasks?: readonly FamilyTask[]
    beforeFeedback?: (ctx: { sdk: any; projectId: string; root: string; feedbackSession: string }) => Promise<unknown>
    afterFeedback?: (entry: FeedbackSpec, ctx: { sdk: any; projectId: string; root: string; feedbackSession: string; id?: string }) => Promise<unknown>
  },
): Promise<FeedbackProjectObservations>
