// Types for step6-rework-judges.mjs (consumed by packages/test-support/tests/accept-step6-rework.spec.ts).
// Observations are typed loosely: the judges also read damaged or partial ones.
export type ReworkObservations = Record<string, any>
export type ReworkVerdict = { readonly status: 'passed' | 'failed'; readonly evidence: string }
type ReworkJudge = (obs: ReworkObservations | undefined) => ReworkVerdict
export declare const judgeShared: ReworkJudge
export declare const judgeProposeLiteral: ReworkJudge
export declare const judgeSimilarRegression: ReworkJudge
export declare const judgeNoSimilar: ReworkJudge
export declare const judgeGateLiteral: ReworkJudge
export declare const judgeMetaLiteral: ReworkJudge
export declare const REWORK_JUDGES: Readonly<Record<'H19' | 'H20' | 'H21' | 'H22' | 'H23' | 'H24', ReworkJudge>>
