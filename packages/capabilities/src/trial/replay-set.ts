// Adapted from Nexgent PR #4 runtime/packages/bundle/nexgent-app/src/architecture-trials.ts (archive/python-host): selection and guard cases must be disjoint.
/**
 * Replay sets (`data-formats.md` §候选与门控, §任务快照与检查). A replay case
 * is one past root task: its snapshot at task start
 * (`snapshots/tasks/<taskId>.json`, with a tree), the checks recorded when it
 * ended (`snapshots/checks/<taskId>.json`, at least one spec) and its
 * session's user messages, replayed in order. The kernel gives a root
 * session one task id for all its turns, so a case is a whole root session.
 *
 * The selection set holds the task that proposed the candidate, then the past
 * tasks most similar to it (word overlap of the first user message); the
 * guard set holds the least similar ones. The two never share a task (ported
 * PR #4 check). Too little history makes the gate wait (plan 4.5): no
 * threshold is lowered.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  NexgentError,
  SNAPSHOTS_DIR,
  type ReplayCaseRef,
  type SessionRecord,
  type TaskCheckSpec,
  type TaskChecksRecord,
  type TaskSnapshotRecord,
  type WorkspaceLayout,
} from '@nexgent/kernel'
import { JsonlSessionStore, validateCapabilityFile } from '@nexgent/session'

/** One user message to replay. */
export interface ReplayMessage {
  readonly text: string
  /** Materials the message attached (copied into the replay project). */
  readonly materialIds?: readonly string[]
}

/** A replayable past task. */
export interface ReplayCase extends ReplayCaseRef {
  /** When its snapshot was taken (ordering). */
  readonly takenAt: string
  readonly messages: readonly ReplayMessage[]
}

/** What {@link buildReplaySet} settled on. */
export type ReplaySetResult =
  | { readonly status: 'ready'; readonly selection: readonly ReplayCase[]; readonly guard: readonly ReplayCase[] }
  | { readonly status: 'waiting'; readonly detail: string; readonly available: number }

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown
  } catch {
    return undefined
  }
}

async function names(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory)).filter(name => name.endsWith('.json')).sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

/** The user messages of a root session (`source: 'user'`), or `undefined` when it is not a readable root session. */
function replayMessages(records: readonly SessionRecord[]): ReplayMessage[] | undefined {
  const start = records[0]
  if (start?.type !== 'session.start' || start.parentSessionId !== undefined) return undefined
  const messages: ReplayMessage[] = []
  for (const record of records) {
    if (record.type !== 'user.message' || record.source !== 'user') continue
    messages.push({ text: record.content, ...(record.materials === undefined || record.materials.length === 0 ? {} : { materialIds: [...record.materials] }) })
  }
  return messages
}

/**
 * Every replayable past task of a project, oldest first: a snapshot with a
 * tree, a check record with at least one spec, and a root session with at
 * least one user message. Unreadable files are skipped.
 */
export async function listReplayCases(layout: WorkspaceLayout): Promise<ReplayCase[]> {
  const snapshots = join(layout.dataDir, SNAPSHOTS_DIR)
  const store = new JsonlSessionStore({ sessionsDir: layout.sessions })
  const cases: ReplayCase[] = []
  for (const name of await names(join(snapshots, 'tasks'))) {
    const snapshot = await readJson(join(snapshots, 'tasks', name))
    if (snapshot === undefined || validateCapabilityFile('taskSnapshot', snapshot).length > 0) continue
    const task = snapshot as TaskSnapshotRecord
    if (task.tree === null || `${task.taskId}.json` !== name) continue
    const checks = await readJson(join(snapshots, 'checks', name))
    if (checks === undefined || validateCapabilityFile('taskChecks', checks).length > 0) continue
    const record = checks as TaskChecksRecord
    if (record.taskId !== task.taskId || record.specs.length === 0) continue
    let messages: ReplayMessage[] | undefined
    try {
      messages = replayMessages((await store.readAll(task.sessionId)).records)
    } catch {
      continue
    }
    if (messages === undefined || messages.length === 0) continue
    cases.push({ caseId: task.taskId, sessionId: task.sessionId, tree: task.tree, checks: [...record.specs] as TaskCheckSpec[], takenAt: task.takenAt, messages })
  }
  return cases.sort((left, right) => (left.takenAt < right.takenAt ? -1 : left.takenAt > right.takenAt ? 1 : left.caseId < right.caseId ? -1 : 1))
}

/** Words of a message: Latin/digit runs lower-cased, and each CJK character. */
function words(text: string): Set<string> {
  const found = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  const out = new Set<string>()
  for (const token of found) {
    if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(token)) for (const char of token) out.add(char)
    else out.add(token)
  }
  return out
}

/** Jaccard overlap of two messages' words (0–1). */
export function similarity(left: string, right: string): number {
  const a = words(left)
  const b = words(right)
  if (a.size === 0 && b.size === 0) return 0
  let shared = 0
  for (const word of a) if (b.has(word)) shared += 1
  return shared / (a.size + b.size - shared)
}

/** @throws `config/invalid` when the halves share a task. */
export function assertDisjoint(selection: readonly ReplayCaseRef[], guard: readonly ReplayCaseRef[]): void {
  const chosen = new Set(selection.map(item => item.caseId))
  const shared = guard.find(item => chosen.has(item.caseId))
  if (shared !== undefined) throw new NexgentError('config/invalid', `replay task ${shared.caseId} is in both the selection and the guard set`)
  if (chosen.size !== selection.length || new Set(guard.map(item => item.caseId)).size !== guard.length) {
    throw new NexgentError('config/invalid', 'a replay task appears twice in one set')
  }
}

/**
 * Split the project's replayable tasks for one candidate.
 * @param originTaskId - The task that proposed the candidate (selected first when replayable).
 */
export function buildReplaySet(cases: readonly ReplayCase[], originTaskId: string, counts: { readonly selection: number; readonly guard: number }): ReplaySetResult {
  const needed = counts.selection + counts.guard
  if (cases.length < needed) {
    return {
      status: 'waiting',
      available: cases.length,
      detail: `the gate needs ${counts.selection} selection and ${counts.guard} guard past tasks with snapshots and checks; the project has ${cases.length}`,
    }
  }
  const origin = cases.find(item => item.caseId === originTaskId)
  const reference = origin?.messages[0]?.text ?? ''
  const ranked = cases
    .filter(item => item !== origin)
    .map((item, index) => ({ item, index, score: similarity(reference, item.messages[0]?.text ?? '') }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(entry => entry.item)
  const selection = [...(origin === undefined ? [] : [origin]), ...ranked].slice(0, counts.selection)
  const guard = ranked.filter(item => !selection.includes(item)).slice(-counts.guard)
  assertDisjoint(selection, guard)
  return { status: 'ready', selection, guard }
}
