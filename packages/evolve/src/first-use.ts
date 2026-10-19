/**
 * After adoption (`data-formats.md` §改进作业 `firstUse`, `rolledBack`): the
 * first root task that ran on the adopted version and actually called the
 * job's component (`task.outcome.componentsUsed`, trial runs and improvement
 * sessions excluded), and whether that version was later rolled back. The
 * host sweeps adopted jobs when it starts and when a turn starts (the
 * previous task's outcome is in the ledger by then).
 */
import type { CapabilityDecision, TaskOutcomeRecord, WorkspaceLayout } from '@nexgent/kernel'
import { CapabilityStore, readCandidate } from '@nexgent/capabilities'
import { JsonlLedger } from '@nexgent/session'
import { listJobs, updateJob } from './jobs.js'
import { improvementsDir } from './paths.js'
import type { ImprovementJob } from './types.js'

/** Record `firstUse` and `rolledBack` on adopted jobs that lack them. @returns the jobs changed. */
export async function sweepAdoptedJobs(layout: WorkspaceLayout, now: Date = new Date()): Promise<ImprovementJob[]> {
  const directory = improvementsDir(layout)
  const open = (await listJobs(directory)).filter(job => job.status === 'adopted' && job.decisionId !== undefined && job.candidateId !== undefined && (job.firstUse === undefined || job.rolledBack === undefined))
  if (open.length === 0) return []
  const decisions: CapabilityDecision[] = await new CapabilityStore(layout.capabilities).decisions()
  let outcomes: TaskOutcomeRecord[] | undefined
  const changed: ImprovementJob[] = []
  for (const job of open) {
    const decision = decisions.find(item => item.id === job.decisionId)
    if (decision === undefined || decision.outcome !== 'adopted') continue
    const version = decision.toVersion
    const patch: { firstUse?: NonNullable<ImprovementJob['firstUse']>; rolledBack?: NonNullable<ImprovementJob['rolledBack']> } = {}
    if (job.firstUse === undefined) {
      const candidate = await readCandidate(layout.capabilities, job.candidateId!).catch(() => undefined)
      const component = candidate?.components[0]
      if (component !== undefined) {
        outcomes ??= await rootOutcomes(layout)
        const first = outcomes.find(record => record.capabilityVersion === version && record.ts >= decision.decidedAt
          && (record.componentsUsed ?? []).some(used => used.kind === component.kind && used.name === component.name && used.calls > 0))
        if (first !== undefined && first.taskId !== undefined) patch.firstUse = { taskId: first.taskId, sessionId: first.sessionId, at: first.ts, version }
      }
    }
    if (job.rolledBack === undefined) {
      const rollback = decisions.find(item => item.outcome === 'rolled-back' && item.fromVersion === version && item.decidedAt >= decision.decidedAt)
      if (rollback !== undefined) patch.rolledBack = { decisionId: rollback.id, at: rollback.decidedAt }
    }
    if (patch.firstUse !== undefined || patch.rolledBack !== undefined) changed.push(await updateJob(directory, job.id, patch, now))
  }
  return changed
}

/** Root task outcomes of user tasks, oldest first. */
async function rootOutcomes(layout: WorkspaceLayout): Promise<TaskOutcomeRecord[]> {
  const out: TaskOutcomeRecord[] = []
  for await (const record of new JsonlLedger({ ledgersDir: layout.ledgers }).read({ types: ['task.outcome'] })) {
    if (record.type !== 'task.outcome' || record.trialId !== undefined || record.improvementId !== undefined) continue
    if (record.memberId !== undefined && record.memberId !== 'main') continue
    out.push(record)
  }
  return out.sort((left, right) => (left.ts < right.ts ? -1 : left.ts > right.ts ? 1 : 0))
}
