/**
 * Recovery after a workflow's process died (`data-formats.md` §子会话与成员
 * “恢复”, §工作流). When the root session is reopened, before its first new
 * turn: every member run with a `subagent.start` and no `subagent.end` is
 * closed as `interrupted` by `@nexgent/subagent`'s `closeInterruptedRuns`
 * (workflow members included, keeping what the member's own session shows),
 * then every `workflow.start` without a `workflow.end` gets a
 * `workflow.end` with status `interrupted`, carrying the turn of its start
 * record. Members that already have a `subagent.end` are left alone; nothing
 * is run again.
 */
import { type Agent, type HostRecordInput, type SessionRecord, type SessionStore, type WorkflowEndRecord } from '@nexgent/kernel'
import { closeInterruptedRuns } from '@nexgent/subagent'

/** Message of the error on an interrupted `workflow.end`. */
export const INTERRUPTED_MESSAGE = 'the process stopped while the workflow was running; it was not resumed'

/** The `workflow.end` records that close the open workflows in a parent session's records. Pure. */
export function planWorkflowRecovery(records: readonly SessionRecord[]): Extract<HostRecordInput, { type: 'workflow.end' }>[] {
  const finished = new Set<string>()
  const members = new Map<string, number>()
  for (const record of records) {
    if (record.type === 'workflow.end') finished.add(record.workflowId)
    if (record.type === 'subagent.start' && record.workflowId !== undefined) members.set(record.workflowId, (members.get(record.workflowId) ?? 0) + 1)
  }
  return records
    .filter(record => record.type === 'workflow.start' && !finished.has(record.workflowId))
    .map(record => {
      const start = record as Extract<SessionRecord, { type: 'workflow.start' }>
      return {
        type: 'workflow.end' as const,
        turn: start.turn,
        workflowId: start.workflowId,
        status: 'interrupted' as const,
        members: members.get(start.workflowId) ?? 0,
        error: { name: 'NexgentError', code: 'internal' as const, message: INTERRUPTED_MESSAGE },
      }
    })
}

/**
 * Close the interrupted member runs and workflows of a reopened root agent,
 * between turns. @returns the `workflow.end` records written.
 */
export async function recoverWorkflows(parent: Agent, store: Pick<SessionStore, 'readAll'>): Promise<WorkflowEndRecord[]> {
  await closeInterruptedRuns(parent, store)
  const { records } = await store.readAll(parent.sessionId)
  const written: WorkflowEndRecord[] = []
  for (const record of planWorkflowRecovery(records)) written.push(await parent.appendHostRecord(record) as WorkflowEndRecord)
  return written
}
