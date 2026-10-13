// Types for step6-improver-rule.mjs (consumed by packages/test-support/tests/accept-step6.spec.ts).
export interface ArmRecord {
  readonly descendant: boolean | 'unknown'
  readonly gatePassed: boolean | 'unknown'
  readonly quality: number | 'unknown'
  readonly costUsd: number | 'unknown'
}
export type ImproverDecisionReason = 'unknown' | 'no-descendant' | 'gate-win' | 'quality-win' | 'cost-win' | 'no-gain'
export declare const COST_WIN_FRACTION: number
export declare function referenceImproverDecision(
  parent: ArmRecord | undefined,
  child: ArmRecord | undefined,
): { adopt: boolean; reason: ImproverDecisionReason; detail: string }
export interface Playbook {
  readonly id: string
  readonly title: string
  readonly metaDiagnosis: { readonly proposalKind: 'change' | 'none'; readonly finding: string }
  readonly change: { readonly kind: string; readonly summary: string; readonly field?: string; readonly value?: unknown } | null
  readonly arms: { readonly parent: ArmRecord; readonly child: ArmRecord } | null
  readonly expect: { readonly status: string; readonly reason: string | null; readonly nextJobUsesChild: boolean }
}
export declare const PLAYBOOKS: readonly Playbook[]
