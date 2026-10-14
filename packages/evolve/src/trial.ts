/**
 * The trial phase: hand the job's candidate to the step-4 gate (the host
 * entry supplies how: the SDK runs `runGate` with its replay runner and
 * reviewer) and map the gate's answer onto the job. The phase's spend is the
 * ledger's model requests of that trial (`trialId`).
 */
import { addUsage, ZERO_USAGE, type CapabilityDecision, type ImproverComparisonParams, type LLMUsage, type WorkspaceLayout } from '@nexgent/kernel'
import { JsonlLedger } from '@nexgent/session'
import type { ImprovementJob } from './types.js'

/** What the gate answered (the shape of `@nexgent/capabilities`' `GateResult`). */
export type GateOutcome =
  | { readonly status: 'waiting'; readonly detail: string }
  | { readonly status: 'skipped'; readonly detail: string }
  | { readonly status: 'decided'; readonly trialId: string; readonly decision: CapabilityDecision }
  /** ADR 0013: rejected before any replay (`instance-literal`), no trial. */
  | { readonly status: 'refused'; readonly decision: CapabilityDecision }

/** Runs the gate for one candidate (provided by the host entry). */
export type TrialStarter = (input: {
  readonly layout: WorkspaceLayout
  readonly candidateId: string
  readonly job: ImprovementJob
  /** Step 6: the gate parameters of the job's pinned improver (`trialComparison`: counts never below the project's). */
  readonly comparison: ImproverComparisonParams
  /** Step 6: a comparison arm's evaluator epoch (the origin's); the gate refuses to run in another. */
  readonly epoch?: string
}) => Promise<GateOutcome>

/** Summed model requests of one trial in the ledger. */
export async function trialSpend(layout: WorkspaceLayout, trialId: string): Promise<{ readonly usage: LLMUsage; readonly requestCount: number }> {
  let usage: LLMUsage = ZERO_USAGE
  let requestCount = 0
  for await (const record of new JsonlLedger({ ledgersDir: layout.ledgers }).read({ types: ['llm.request.end'] })) {
    if (record.trialId !== trialId || record.type !== 'llm.request.end') continue
    usage = addUsage(usage, record.usage)
    requestCount += 1
  }
  return { usage, requestCount }
}

/** The job status a gate outcome leads to, with its detail. Pure. */
export function trialStatus(outcome: GateOutcome): { readonly status: 'adopted' | 'rejected' | 'awaiting-approval' | 'waiting-history' | 'failed'; readonly detail: string } {
  if (outcome.status === 'waiting') return { status: 'waiting-history', detail: `Waiting for more past tasks: ${outcome.detail}` }
  if (outcome.status === 'skipped') return { status: 'failed', detail: `The gate did not run the candidate: ${outcome.detail}` }
  const decision = outcome.decision
  const detail = decision.detail
  if (decision.outcome === 'adopted') return { status: 'adopted', detail }
  if (decision.outcome === 'awaiting-approval') return { status: 'awaiting-approval', detail }
  return { status: 'rejected', detail: `Rejected (${decision.reason}): ${detail}` }
}
