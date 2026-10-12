/**
 * Interrupted trials (H16). A trial whose receipts have no `trial.end` and
 * whose gate process is gone (no lock, or the lock names a dead process) was
 * killed. On the next start the host writes one `rejected` decision for it
 * (reason `interrupted`, no revision): the candidate is never tried again and
 * the adopted version stays as it was. Nothing is re-run.
 */
import type { CapabilityDecision } from '@nexgent/kernel'
import type { CapabilityStore } from '../capability-store.js'
import { listTrials, releaseTrialLock, trialRunning } from './receipts.js'

/**
 * Close every interrupted trial of the project.
 * @returns the decisions written.
 */
export async function recoverInterruptedTrials(store: CapabilityStore): Promise<CapabilityDecision[]> {
  const written: CapabilityDecision[] = []
  const decisions = await store.decisions()
  for (const trial of await listTrials(store.directory)) {
    if (trial.end !== undefined) continue
    if (decisions.some(decision => decision.trialId === trial.trialId || decision.candidateId === trial.candidateId)) continue
    if (await trialRunning(store.directory, trial.trialId)) continue
    const start = trial.receipts[0]
    const version = start?.type === 'trial.start' ? start.baselineVersion : (await store.activation()).version
    const runs = trial.receipts.filter(receipt => receipt.type === 'trial.run').length
    written.push(await store.recordDecision({
      outcome: 'rejected',
      reason: 'interrupted',
      trigger: 'gate',
      candidateId: trial.candidateId,
      trialId: trial.trialId,
      fromVersion: version,
      toVersion: version,
      detail: `The trial stopped before it finished (${runs} run${runs === 1 ? '' : 's'} recorded); its process is gone. The candidate is not tried again and the adopted version is unchanged.`,
    }))
    await releaseTrialLock(store.directory, trial.trialId).catch(() => undefined)
  }
  return written
}
