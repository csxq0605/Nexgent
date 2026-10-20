/**
 * Coordinator: measure how a task was organized, from its run records.
 *
 * After every root turn the coordinator reads the turn's records (and its
 * members' child sessions) and builds an {@link OrganizationProfile}: per
 * part (the coordinator itself, each member) the tokens and share of the
 * cost, the wall time, failures and retries, idle wait, and whether the part's
 * work was thrown away. The organization library reflects on it
 * (`@nexgent/capabilities` `reflectOnRun`). Pure: no model requests, nothing
 * about the kind of task.
 *
 * - Cost: each part's model usage, priced with `costOf` when the host gives
 *   it (the model's real prices), otherwise weighted like Claude's price
 *   list (input 1, cache write 1.25, cache read 0.1, output 5); the task's
 *   USD is split by those shares.
 * - Idle wait: a workflow member's `queuedMs` (ready, but no free slot); the
 *   coordinator's time inside `organize` / `delegate` / `workflow` calls
 *   (overlapping calls counted once).
 * - Threads (`executionForm: thread`) are parts of kind `thread`; their runs
 *   may end after the coordinator's turn, and the task's time runs until the
 *   last of them ends.
 * - Wasted work: every file a member wrote into the project was later in
 *   the same task written whole again (`write_file`) by someone else, or
 *   deleted.
 */
import {
  type LLMUsage,
  type OrganizationPart,
  type OrganizationPartKind,
  type OrganizationProfile,
  type OrganizationRoleKind,
  type SessionRecord,
  type ToolCall,
  type UsageCount,
} from '@nexgent/kernel'

/** Tools during which the coordinator waits for members. */
export const MEMBER_WAIT_TOOLS: readonly string[] = ['organize', 'delegate', 'workflow']

/** Relative weights of Claude's prices, used when the host gives no price function. */
export const USAGE_WEIGHTS = { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 } as const

/** What {@link buildOrganizationProfile} reads. */
export interface ProfileInput {
  readonly turn: number
  /** The root session's records (any turns; only `turn` is read). */
  readonly records: readonly SessionRecord[]
  /** Child sessions' records by session id, when the host could read them. */
  readonly children?: ReadonlyMap<string, readonly SessionRecord[]>
  /** The task tree's cost of the turn in USD. */
  readonly usd: number
  /** Automatic check retries of the turn. */
  readonly checkRetries?: number
  /** Files the turn deleted (project-relative). */
  readonly deleted?: readonly string[]
  /** End of the turn (ms since epoch) when the records have no `turn.end` yet. */
  readonly now?: number
  /** Price of a usage on a model in USD, when the host knows it. */
  readonly costOf?: (usage: LLMUsage, model: string | undefined) => number | undefined
}

function count(value: UsageCount): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** Pure: all tokens of a usage (input, output, cache). */
export function usageTokens(usage: LLMUsage): number {
  return count(usage.inputTokens) + count(usage.outputTokens) + count(usage.cacheReadTokens) + count(usage.cacheWriteTokens)
}

function weighted(usage: LLMUsage): number {
  return count(usage.inputTokens) * USAGE_WEIGHTS.input + count(usage.cacheWriteTokens) * USAGE_WEIGHTS.cacheWrite
    + count(usage.cacheReadTokens) * USAGE_WEIGHTS.cacheRead + count(usage.outputTokens) * USAGE_WEIGHTS.output
}

function at(record: { readonly ts: string }): number {
  const value = Date.parse(record.ts)
  return Number.isFinite(value) ? value : 0
}

/** Pure: total length of the union of intervals. */
export function unionMs(intervals: readonly (readonly [number, number])[]): number {
  const sorted = intervals.filter(([start, end]) => end > start).map(([start, end]) => [start, end] as [number, number]).sort((l, r) => l[0] - r[0])
  let total = 0
  let current: [number, number] | undefined
  for (const interval of sorted) {
    if (current === undefined || interval[0] > current[1]) {
      if (current !== undefined) total += current[1] - current[0]
      current = [...interval]
    } else {
      current[1] = Math.max(current[1], interval[1])
    }
  }
  if (current !== undefined) total += current[1] - current[0]
  return total
}

function args(call: ToolCall): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(call.arguments)
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

/** Pure: `path` names the project-relative `file` (a member's copy has another root, so an absolute path matches by its end). */
export function samePath(path: string, file: string): boolean {
  const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '')
  return normalized === file || normalized.endsWith(`/${file}`)
}

/** Paths a session wrote whole with `write_file` in a turn, with when. */
function wholeWrites(records: readonly SessionRecord[], turn: number): { readonly path: string; readonly at: number }[] {
  const out: { path: string; at: number }[] = []
  for (const record of records) {
    if (record.type !== 'assistant.message' || record.turn !== turn) continue
    for (const call of record.toolCalls ?? []) {
      if (call.name !== 'write_file') continue
      const path = args(call).path
      if (typeof path === 'string' && path !== '') out.push({ path, at: at(record) })
    }
  }
  return out
}

/** Paths a session wrote in a turn (`write_file`, `str_replace`), for a member without a merge. */
function writtenPaths(records: readonly SessionRecord[], turn: number): string[] {
  const out = new Set<string>()
  for (const record of records) {
    if (record.type !== 'assistant.message' || record.turn !== turn) continue
    for (const call of record.toolCalls ?? []) {
      if (call.name !== 'write_file' && call.name !== 'str_replace') continue
      const path = args(call).path
      if (typeof path === 'string' && path !== '') out.add(path.replace(/\\/g, '/').replace(/^\.\//, ''))
    }
  }
  return [...out]
}

interface MemberRun {
  readonly name: string
  readonly thread: boolean
  readonly childSessionId: string
  readonly childTurn: number
  readonly start: number
  readonly end: number
  readonly queuedMs: number
  readonly usage: LLMUsage
  readonly failures: number
  /** Files it wrote into the project. */
  readonly files: readonly string[]
  /** Files it wrote whole (for judging whether it redid another part's work). */
  readonly whole: readonly string[]
}

/**
 * Pure: the organization profile of one root turn. Parts: the coordinator
 * first, then one per member name in start order (a member that ran more
 * than once in the turn is one part with `retries`).
 */
export function buildOrganizationProfile(input: ProfileInput): OrganizationProfile {
  const { turn } = input
  const mine = input.records.filter(record => 'turn' in record && record.turn === turn)
  const model = sessionModel(input.records)
  const startRecord = mine.find(record => record.type === 'turn.start')
  const endRecord = mine.find(record => record.type === 'turn.end')
  const turnStart = startRecord === undefined ? (mine[0] === undefined ? 0 : at(mine[0])) : at(startRecord)
  const turnEnd = endRecord === undefined ? input.now ?? (mine.at(-1) === undefined ? turnStart : at(mine.at(-1)!)) : at(endRecord)
  const turnMs = Math.max(0, turnEnd - turnStart)

  // Role kinds by member name, from the turn's organizations (a later one wins).
  const kinds = new Map<string, OrganizationRoleKind>()
  for (const record of mine) if (record.type === 'organization') for (const role of record.roles) kinds.set(role.name, role.kind)

  // The coordinator.
  const coordinatorUsage: LLMUsage[] = []
  let coordinatorFailures = 0
  const waits: [number, number][] = []
  for (const record of mine) {
    if (record.type === 'assistant.message') coordinatorUsage.push(record.usage)
    if (record.type === 'tool.result') {
      if (MEMBER_WAIT_TOOLS.includes(record.name)) waits.push([at(record) - record.durationMs, at(record)])
      else if (record.isError) coordinatorFailures += 1
    }
  }
  const coordinatorIdle = Math.min(turnMs, unionMs(waits))

  // Member runs.
  const starts = new Map<string, Extract<SessionRecord, { type: 'subagent.start' }>>()
  const runs: MemberRun[] = []
  for (const record of mine) {
    if (record.type === 'subagent.start') starts.set(`${record.childSessionId}:${record.childTurn}`, record)
    if (record.type !== 'subagent.end') continue
    const start = starts.get(`${record.childSessionId}:${record.childTurn}`)
    if (start === undefined) continue
    const child = input.children?.get(record.childSessionId) ?? []
    const childErrors = child.filter(item => item.type === 'tool.result' && item.turn === record.childTurn && item.isError).length
    const result = record.result
    const files = result.merge !== undefined ? result.merge.applied.filter(path => !result.merge!.conflicts.some(conflict => conflict.path === path)) : writtenPaths(child, record.childTurn)
    runs.push({
      name: start.name,
      thread: start.executionForm === 'thread',
      childSessionId: record.childSessionId,
      childTurn: record.childTurn,
      start: at(start),
      end: at(record),
      queuedMs: start.queuedMs ?? 0,
      usage: result.usage,
      failures: (result.status === 'completed' ? 0 : 1) + (result.denied?.length ?? 0) + (result.merge?.conflicts.length ?? 0) + childErrors,
      files,
      whole: wholeWrites(child, record.childTurn).map(write => write.path),
    })
  }

  // Wasted work: every file a member wrote was later written whole by another part, or deleted.
  const rootWrites = wholeWrites(input.records, turn)
  const deleted = new Set(input.deleted ?? [])
  const redoer = (run: MemberRun, file: string): string | undefined => {
    let last: { readonly who: string; readonly at: number } | undefined
    for (const write of rootWrites) if (write.at > run.end && samePath(write.path, file) && (last === undefined || write.at >= last.at)) last = { who: 'coordinator', at: write.at }
    for (const other of runs) {
      if (other.name === run.name || other.start < run.end) continue
      if (other.files.includes(file) && other.whole.some(path => samePath(path, file)) && (last === undefined || other.end >= last.at)) last = { who: other.name, at: other.end }
    }
    if (last !== undefined) return last.who
    return deleted.has(file) ? '' : undefined
  }

  const usdOf = (usage: LLMUsage, of: string | undefined): number => {
    const priced = input.costOf?.(usage, of)
    return priced !== undefined && Number.isFinite(priced) ? priced : weighted(usage)
  }

  interface Draft { name: string; kind: OrganizationPartKind; tokens: number; units: number; ms: number; failures: number; retries: number; idleMs: number; files: Set<string>; wasted: boolean; redoneBy?: string }
  const coordinatorTotal = coordinatorUsage.reduce((sum, usage) => sum + usageTokens(usage), 0)
  const drafts: Draft[] = [{
    name: 'coordinator',
    kind: 'coordinator',
    tokens: coordinatorTotal,
    units: coordinatorUsage.reduce((sum, usage) => sum + usdOf(usage, model), 0),
    ms: Math.max(0, turnMs - coordinatorIdle),
    failures: coordinatorFailures,
    retries: input.checkRetries ?? 0,
    idleMs: coordinatorIdle,
    files: new Set(),
    wasted: false,
  }]
  for (const run of runs) {
    const runModel = sessionModel(input.children?.get(run.childSessionId) ?? []) ?? model
    let draft = drafts.find(item => item.name === run.name && item.kind !== 'coordinator')
    if (draft === undefined) {
      draft = { name: run.name, kind: run.thread ? 'thread' : kinds.get(run.name) ?? 'member', tokens: 0, units: 0, ms: 0, failures: 0, retries: -1, idleMs: 0, files: new Set(), wasted: false }
      drafts.push(draft)
    }
    draft.tokens += usageTokens(run.usage)
    draft.units += usdOf(run.usage, runModel)
    draft.ms += Math.max(0, run.end - run.start)
    draft.failures += run.failures
    draft.retries += 1
    draft.idleMs += run.queuedMs
    for (const file of run.files) draft.files.add(file)
  }
  for (const draft of drafts) {
    if (draft.kind === 'coordinator' || draft.files.size === 0) continue
    const owner = runs.filter(run => run.name === draft.name)
    const last = owner.at(-1)!
    const who = [...draft.files].map(file => redoer(last, file))
    if (who.every(item => item !== undefined)) {
      draft.wasted = true
      const named = who.filter((item): item is string => item !== undefined && item !== '').at(-1)
      if (named !== undefined) draft.redoneBy = named
    }
  }

  const totalUnits = drafts.reduce((sum, draft) => sum + draft.units, 0)
  const parts: OrganizationPart[] = drafts.map(draft => {
    const share = totalUnits > 0 ? draft.units / totalUnits : 0
    return {
      name: draft.name,
      kind: draft.kind,
      tokens: draft.tokens,
      share: round(share, 4),
      usd: round(input.usd * share, 6),
      ms: Math.round(draft.ms),
      failures: draft.failures,
      retries: Math.max(0, draft.retries),
      idleMs: Math.round(draft.idleMs),
      wasted: draft.wasted,
      ...(draft.redoneBy === undefined ? {} : { redoneBy: draft.redoneBy }),
    }
  })
  // Threads (coordinator step two) may end after the turn: the task lasts until the last of them.
  const taskMs = Math.max(turnMs, ...runs.map(run => run.end - turnStart))
  return { usd: round(input.usd, 6), ms: Math.round(taskMs), tokens: parts.reduce((sum, part) => sum + part.tokens, 0), parts }
}

/** Pure: thread runs (coordinator step two) a turn started. */
export function threadRunCount(records: readonly SessionRecord[], turn: number): number {
  return records.filter(record => record.type === 'subagent.start' && record.turn === turn && record.executionForm === 'thread').length
}

/** Pure: thread runs (coordinator step two) a turn started that have not ended yet. */
export function openThreadRuns(records: readonly SessionRecord[], turn: number): number {
  const ended = new Set(records.flatMap(record => (record.type === 'subagent.end' ? [`${record.childSessionId}:${record.childTurn}`] : [])))
  return records.filter(record => record.type === 'subagent.start' && record.turn === turn && record.executionForm === 'thread' && !ended.has(`${record.childSessionId}:${record.childTurn}`)).length
}

function sessionModel(records: readonly SessionRecord[]): string | undefined {
  for (const record of records) if (record.type === 'session.start') return record.model
  return undefined
}

function round(value: number, digits: number): number {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}
