// Types for step6-meta-judges.mjs (consumed by packages/test-support/tests/accept-step6-meta.spec.ts).
// Observations are typed loosely: the judges also read damaged or partial ones.
export type MetaObservations = Record<string, any>
/** What every judge returns. */
export type MetaVerdict = { readonly status: 'passed' | 'failed'; readonly evidence: string }
type MetaJudge = (obs: MetaObservations | undefined) => MetaVerdict

export declare const judgeTrigger: MetaJudge
export declare const judgeMetaDiagnosis: MetaJudge
export declare const judgeMetaProposal: MetaJudge
export declare const judgeOrigin: MetaJudge
export declare const judgeIsolation: MetaJudge
export declare const judgeChildRuns: MetaJudge
export declare const judgeRule: MetaJudge
export declare const judgeAdoptedNext: MetaJudge
export declare const judgeRejected: MetaJudge
export declare const judgeEpoch: MetaJudge
export declare const judgeBudget: MetaJudge
export declare const judgeConcurrency: MetaJudge
export declare const judgeCopies: MetaJudge
export declare const judgeLedger: MetaJudge
/** The origin ADR 0009 gives from a project's origin facts, or undefined when there is no feedback job. */
export declare function expectedOrigin(facts: MetaObservations | undefined, meta: { readonly id: string; readonly createdAt: string }): { kind: 'unresolved' | 'feedback-version'; jobId: string; versions: string[]; feedbackIds: string[] } | undefined
export declare const META_JUDGES: Readonly<Record<'H04' | 'H05' | 'H06' | 'H07' | 'H08' | 'H09' | 'H10' | 'H11' | 'H12' | 'H13' | 'H14' | 'H15' | 'H16' | 'H17', MetaJudge>>
