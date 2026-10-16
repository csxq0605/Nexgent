/**
 * Epoch `adr-0019` rules on top of a gate verdict (ADR 0019 decisions 3
 * and 6), pure. Structured fields only: the verdict's `outcome` and
 * `reason` change, nothing is written as prose.
 *
 * - Decision 3: a learned candidate adopted because quality tied and it is
 *   cheaper is recorded as `cost-optimized`; it saves money and is never
 *   counted as an evolution ({@link evolutionCount}).
 * - Decision 6: while the self-scorer is not `reliable` (agreement with the
 *   external reviewer below 80%, or too few calibrations), a learned skill
 *   is not adopted on its own but waits for the user (`scorer-unreliable`),
 *   and a framework change does not go forward at all.
 *
 * Candidates the user proposed keep the rules they had (the old gate is
 * unchanged for them). The skill verification itself (decision 2) is G2's.
 */
import type { CapabilityDecision, DecisionReason, ScorerReliability, TrialVerdict } from '@nexgent/kernel'

/** What a candidate is: a layer-2 skill, a layer-3 framework change, or one the user proposed. */
export type EpochCandidateKind = 'skill' | 'framework' | 'user'

/** Reasons that mean "cheaper at equal quality": money saved, not an evolution. */
export const COST_ONLY_REASONS: readonly DecisionReason[] = ['cost-optimized', 'cost-down']

/** A gate verdict under epoch `adr-0019` (see the module comment). */
export function epochVerdict(verdict: TrialVerdict, context: { readonly kind: EpochCandidateKind; readonly scorer: Pick<ScorerReliability, 'status'> }): TrialVerdict {
  if (context.kind === 'user') return verdict
  const reliable = context.scorer.status === 'reliable'
  if (verdict.outcome === 'reject') return verdict
  if (!reliable) {
    if (context.kind === 'framework') return { ...verdict, outcome: 'reject', reason: 'scorer-unreliable' }
    if (verdict.outcome === 'adopt') return { ...verdict, outcome: 'await-approval', reason: 'scorer-unreliable' }
    return verdict
  }
  if (verdict.reason === 'cost-down') return { ...verdict, reason: 'cost-optimized' }
  return verdict
}

/** Adoptions that count as evolution, and the ones that only saved money (ADR 0019 decision 3). */
export function evolutionCount(decisions: readonly Pick<CapabilityDecision, 'outcome' | 'reason'>[]): { readonly evolutions: number; readonly costOptimizations: number } {
  let evolutions = 0
  let costOptimizations = 0
  for (const decision of decisions) {
    if (decision.outcome !== 'adopted') continue
    if (COST_ONLY_REASONS.includes(decision.reason)) costOptimizations += 1
    else if (decision.reason !== 'manual' && decision.reason !== 'load-failure' && decision.reason !== 'usage-regression') evolutions += 1
  }
  return { evolutions, costOptimizations }
}
