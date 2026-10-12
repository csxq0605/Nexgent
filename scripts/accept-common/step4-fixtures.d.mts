// Types for step4-fixtures.mjs (consumed by packages/test-support/tests/step4-fixtures.spec.ts).
export type Quality = 'good' | 'bad'
export interface Component {
  readonly name: string
  readonly file: string
  readonly source: string
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
export interface ReplayObservations {
  readonly root: string
  readonly quality: Quality
  readonly tasks: readonly {
    readonly id: string
    readonly set?: 'selection' | 'guard'
    readonly sessionId: string
    readonly reason?: { readonly kind: string }
    readonly error?: string
    readonly output: string | null
    readonly check: CheckRun
  }[]
}
export declare const SCRIPTED_API_KEY: string
export declare const VERIFY_PATH: string
export declare const VERIFY_SOURCE: string
export declare function summarizerSource(options: { applyDiscount: boolean }): string
export declare const COMPONENTS: Readonly<Record<Quality, {
  readonly functionModule: Component & { readonly exports: readonly string[] }
  readonly skill: Component
}>>
export declare const REPLAY_TASKS: readonly FamilyTask[]
export declare const TASK_A: FamilyTask
export declare const TASK_B: FamilyTask
export declare function writeReplayProject(root: string): Promise<{ root: string; months: string[]; files: string[] }>
export declare function outputFor(task: FamilyTask, quality: Quality): Promise<string>
export declare function replayScript(h: unknown, tasks: readonly FamilyTask[], quality: Quality): Promise<unknown[]>
export declare function runCheck(root: string, task: FamilyTask): CheckRun
export declare function runReplayHistory(
  h: unknown,
  pkgs: unknown,
  work: string,
  options?: { quality?: Quality; tasks?: readonly FamilyTask[]; log?: (line: string) => void },
): Promise<ReplayObservations>
