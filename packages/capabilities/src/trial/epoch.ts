/**
 * The evaluator epoch (ADR 0008 decision 5, `data-formats.md` §评价器与纪元).
 * The gate freezes the evaluator it judges by into `TrialPlan.epoch`: the
 * SHA-256 of the canonical evaluator settings (rules id, `costRatioCap`,
 * `costApprovalRatio`, `guardCases`, `reviewer`). The gate reads them from
 * `.nexgent/config.json` only (`capabilities` is a guarded config field), so
 * neither an improver nor a meta job nor a model can change them. Trials
 * of different epochs, or a trial without one (steps 4–5), are never
 * compared.
 */
import { createHash } from 'node:crypto'
import {
  canonicalEvaluatorText,
  evaluatorSettings,
  NexgentError,
  readProjectConfig,
  type CapabilitiesConfig,
  type TrialReceipt,
  type WorkspaceLayout,
} from '@nexgent/kernel'

/** The epoch id of a `capabilities` config (pure). */
export function evaluatorEpoch(capabilities: Pick<CapabilitiesConfig, 'costRatioCap' | 'costApprovalRatio' | 'guardCases' | 'reviewer'>): string {
  return createHash('sha256').update(canonicalEvaluatorText(evaluatorSettings(capabilities)), 'utf8').digest('hex')
}

/** The epoch a project's gate would run in now. */
export async function projectEpoch(layout: WorkspaceLayout): Promise<string> {
  return evaluatorEpoch((await readProjectConfig(layout.configFile)).config.capabilities)
}

/** The epoch a trial ran in (its `trial.start` plan), or `undefined` for a trial before step 6. */
export function trialEpoch(receipts: readonly TrialReceipt[]): string | undefined {
  const start = receipts.find(receipt => receipt.type === 'trial.start')
  return start?.type === 'trial.start' ? start.plan.epoch : undefined
}

/**
 * Check that trials (their receipts) may be put into one comparison: every
 * one has an epoch and all are the same.
 * @returns the common epoch.
 * @throws `improvement/epoch-mismatch` naming the epochs found.
 */
export function assertSameEpoch(trials: readonly (readonly TrialReceipt[])[]): string {
  const epochs = trials.map(trialEpoch)
  const first = epochs[0]
  if (first === undefined || epochs.some(epoch => epoch !== first)) {
    throw new NexgentError('improvement/epoch-mismatch', `trials of different evaluator epochs cannot be compared (${epochs.map(epoch => epoch?.slice(0, 12) ?? 'none').join(', ')})`)
  }
  return first
}
