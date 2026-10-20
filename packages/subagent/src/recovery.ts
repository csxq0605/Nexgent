/**
 * Closing member runs a dead process left open (`data-formats.md`
 * §子会话与成员 恢复): after a root session is resumed, every
 * `subagent.start` without its `subagent.end` gets one with status
 * `interrupted`, written as a host record carrying the original parent turn.
 * The result keeps what the member's own session shows for that run: its
 * last assistant text, the versions it presented and its usage. Members are
 * not re-run.
 */
import {
  addUsage,
  NexgentError,
  ZERO_USAGE,
  type Agent,
  type DeliverableVersionRef,
  type MemberResult,
  type SessionRecord,
  type SessionStore,
  type SubagentEndRecord,
  type SubagentStartRecord,
} from '@nexgent/kernel'

const key = (childSessionId: string, childTurn: number) => `${childSessionId}#${childTurn}`

/** Runs of `records` that have a `subagent.start` and no `subagent.end`, in start order. */
export function openRuns(records: readonly SessionRecord[]): SubagentStartRecord[] {
  const ended = new Set(records.filter((r): r is SubagentEndRecord => r.type === 'subagent.end').map(r => key(r.childSessionId, r.childTurn)))
  return records.filter((r): r is SubagentStartRecord => r.type === 'subagent.start' && !ended.has(key(r.childSessionId, r.childTurn)))
}

/** What a member's session shows for one of its turns, as an `interrupted` result. Pure. */
export function interruptedResult(childRecords: readonly SessionRecord[], childTurn: number): MemberResult {
  let text = ''
  let usage = ZERO_USAGE
  let requestCount = 0
  const deliverables: DeliverableVersionRef[] = []
  for (const record of childRecords) {
    if (!('turn' in record) || record.turn !== childTurn) continue
    if (record.type === 'assistant.message') {
      text = record.content
      usage = addUsage(usage, record.usage)
      requestCount += 1
    } else if (record.type === 'deliverable.presented') {
      deliverables.push(record.deliverable)
    }
  }
  return {
    status: 'interrupted',
    text,
    deliverables,
    usage,
    requestCount,
    error: { name: 'NexgentError', code: 'internal', message: 'the process stopped while the member was running; the run was not resumed' },
  }
}

/**
 * Write the missing `subagent.end` records of a root agent opened with
 * `ctx.agents.resume`. Call it between turns, before the first new turn.
 * A member session that cannot be read still gets its record, with an empty
 * result.
 * @param store - the session store (`ctx.session`).
 * @returns the records written.
 * @throws `internal` when the agent is running a turn.
 */
export async function closeInterruptedRuns(parent: Agent, store: Pick<SessionStore, 'readAll'>): Promise<SubagentEndRecord[]> {
  if (parent.busy) throw new NexgentError('internal', `agent ${parent.sessionId} is running a turn; close interrupted runs between turns`)
  const { records } = await store.readAll(parent.sessionId)
  const written: SubagentEndRecord[] = []
  for (const start of openRuns(records)) {
    let childRecords: readonly SessionRecord[] = []
    try {
      childRecords = (await store.readAll(start.childSessionId)).records
    } catch {
      // An unreadable member session still closes the parent's run; the result is then empty.
    }
    const record = await parent.appendHostRecord({
      type: 'subagent.end',
      turn: start.turn,
      childSessionId: start.childSessionId,
      childTurn: start.childTurn,
      result: interruptedResult(childRecords, start.childTurn),
    })
    written.push(record as SubagentEndRecord)
  }
  return written
}
