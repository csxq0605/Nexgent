// Types for step2-judges.mjs (consumed by packages/test-support/tests/accept-step2-judges.spec.ts).
export type JudgeStatus = 'passed' | 'failed' | 'not-implemented'
export interface JudgeResult { readonly status: JudgeStatus; readonly evidence: string }
/** Observations from step2-headless.mjs; judges read them loosely. */
export type Observations = Record<string, any>
export interface JudgeTools {
  validateSessionRecord(value: unknown): readonly unknown[]
  validateLedgerRecord(value: unknown): readonly unknown[]
  validateMaterialMetadata(value: unknown): readonly unknown[]
  validateDeliverableVersion(value: unknown): readonly unknown[]
  requestText(body: unknown): string
  isAuxiliaryRequest(body: unknown): boolean
}
export declare const JUDGES: Readonly<Record<string, (obs: Observations, tools: JudgeTools) => JudgeResult>>
export declare function judge(id: string, obs: Observations, tools: JudgeTools): JudgeResult
export declare function verdict(conditions: ReadonlyArray<readonly [boolean, string]>, passEvidence: string): JudgeResult
export declare function partial(conditions: ReadonlyArray<readonly [boolean, string]>, missing: string, checked: string): JudgeResult
export declare function toolCalls(obs: Observations, phase: string): Array<{ name: string; arguments: Record<string, unknown>; isError: boolean | undefined; content: string; hasResult: boolean }>
