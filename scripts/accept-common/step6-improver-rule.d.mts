// Types for step6-improver-rule.mjs (consumed by packages/test-support/tests/accept-step6.spec.ts).
// Records follow the kernel contract (ComparisonOrigin, ComparisonArmResult); typed loosely so the
// judge also reads damaged or partial records.
export type ImproverReason = 'gate-passed' | 'quality-up' | 'cost-down' | 'no-improvement' | 'no-offspring' | 'unknown-arm' | 'origin-mismatch' | 'epoch-mismatch'
export interface OriginLike {
  readonly kind?: string
  readonly sourceJobId?: string
  readonly tree?: string
  readonly feedbackIds?: readonly string[]
  readonly capabilityVersion?: string
  readonly epoch?: string
}
export interface ArmLike {
  readonly arm?: string
  readonly origin?: OriginLike
  readonly status?: string
  readonly error?: { readonly code?: string }
  readonly candidateId?: string
  readonly verdict?: { readonly reason?: string; readonly passRate?: { readonly candidate?: number } }
  readonly cost?: { readonly estimatedUsd?: number | 'unknown' }
}
export declare const COST_DOWN_RATIO: number
export declare function armFacts(arm: ArmLike | undefined): { unknown: boolean; offspring: boolean; gatePassed: boolean; quality: number | undefined; costUsd: unknown }
export declare function referenceImproverDecision(origin: OriginLike | undefined, parent: ArmLike | undefined, child: ArmLike | undefined): { outcome: 'adopt' | 'reject'; reason: ImproverReason }
export interface PlaybookArm { readonly status: string; readonly offspring: boolean; readonly passRate: number | null; readonly costUsd: number }
export interface Playbook {
  readonly id: string
  readonly title: string
  readonly metaDiagnosis: { readonly proposalKind: 'change' | 'none'; readonly finding: string }
  readonly change: ({ readonly op: string } & Readonly<Record<string, unknown>>) | null
  readonly arms: { readonly parent: PlaybookArm; readonly child: PlaybookArm } | null
  readonly expect: { readonly status: string; readonly reason: string | null; readonly nextJobUsesChild: boolean }
}
export declare const PLAYBOOKS: readonly Playbook[]
export declare function arm(origin: OriginLike, name: 'parent' | 'child', spec: PlaybookArm): ArmLike & Record<string, unknown>
export declare function changeFor(playbook: Playbook, parent: { readonly diagnosis: { readonly paragraphs: readonly string[] } }): Record<string, unknown> | null
