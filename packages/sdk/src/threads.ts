/**
 * Coordinator step two: threads. {@link SdkThreadHost} implements the
 * kernel's `ThreadHost` (`ctx.threads`) over the SDK's sessions, and
 * {@link threadsPlugin} (profile row `@nexgent/threads`) provides it and
 * registers the four thread tools (`start_thread`, `message_thread`,
 * `read_thread`, `list_threads`).
 *
 * A thread is a root session (`session.start.thread`) with its own copy of
 * the project, merged back when each of its turns ends. A turn the
 * coordinator gives it (its first task, or `message_thread` while it is
 * idle) runs in the background and is recorded in the coordinator as a
 * member run (`subagent.start` / `subagent.end`, `executionForm: thread`,
 * under the coordinator's turn that started it). When that turn ends the
 * coordinator is woken: the note joins its running turn, or starts its next
 * turn (`user.message.source: thread`). A turn the user stopped, or one
 * stopped at the cost cap, does not wake it (the stop is the user's word;
 * `list_threads` shows the thread stopped). Turns the user starts in a
 * thread are the user's: not recorded in the coordinator, no wake.
 *
 * Once every thread run a coordinator turn started has ended (and that turn
 * has too), the host measures the turn again with the threads in it and
 * hands the profile to the organization library (`noteProfile`), which then
 * reflects on it like any team run.
 */
import {
  addUsage,
  LIST_THREADS_TOOL,
  MESSAGE_THREAD_TOOL,
  NexgentError,
  READ_THREAD_TOOL,
  START_THREAD_TOOL,
  THREAD_LIMITS,
  threadWakeNote,
  toErrorInfo,
  ZERO_USAGE,
  type Context,
  type DeliverableVersionRef,
  type HostRecordInput,
  type LLMUsage,
  type MemberDenial,
  type MemberResult,
  type OrganizationMemory,
  type SessionRecord,
  type Step2ToolSpec,
  type ThreadCaller,
  type ThreadHost,
  type ThreadInfo,
  type ThreadOrigin,
  type ThreadStartInput,
  type ThreadStatus,
  type ThreadView,
  type Tool,
  type ToolContext,
  type ToolOutput,
  type TurnResult,
  type WorkdirMerge,
  type ContextProvider,
  type SystemPromptSection,
  UPDATE_PROJECT_NOTES_TOOL,
} from '@nexgent/kernel'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { toMemberResult } from '@nexgent/subagent'
import { buildOrganizationProfile, openThreadRuns, reportBlocker, threadRunCount } from '@nexgent/workflow'

/** What the host needs from the SDK, for one project. */
export interface ThreadRuntime {
  /** Create a thread session (open and tracked); returns its id. */
  create(input: { readonly title: string; readonly thread: ThreadOrigin }): Promise<string>
  /** Open a root session when it is not (reopening runs its recoveries). */
  ensureOpen(sessionId: string): Promise<void>
  /** A session's records (`session/not-found` when it has none). */
  records(sessionId: string): Promise<readonly SessionRecord[]>
  /** Append a host record to a root session (opened when it is not). */
  append(sessionId: string, record: HostRecordInput): Promise<void>
  /** Start a turn with `source: thread`; `done` settles after the SDK's bookkeeping. */
  startTurn(sessionId: string, text: string, materialIds?: readonly string[]): Promise<{ readonly turn: number; readonly done: Promise<TurnResult> }>
  /** Join the session's running turn (`source: thread`); `false` when no turn takes it. */
  steer(sessionId: string, text: string): Promise<boolean>
  /** Whether a turn runs in the session. */
  running(sessionId: string): boolean
  /** Settles once the session's turn `turn` has finished (at once when it is not running). */
  turnDone(sessionId: string, turn: number): Promise<void>
  /** Wake a coordinator: the note joins its running turn or starts its next one. */
  wake(sessionId: string, text: string): Promise<void>
  /** The threads of a coordinator, oldest first. */
  threadIds(coordinatorSessionId: string): Promise<readonly string[]>
  /** What merging the thread's copy did at the end of its last turn in this process. */
  lastMerge(sessionId: string): WorkdirMerge | undefined
  /** Price of a usage in USD, when the model's prices are known. */
  costOf(usage: LLMUsage, model: string | undefined): number | undefined
  organizations(): OrganizationMemory | undefined
  /** The project is closing: no more wakes or measurements. */
  closed(): boolean
  /** Report a failure that must not stop anything (an `error` event). */
  report(sessionId: string, error: unknown): void
  /** Coordinator step three: a tool call in the session (or one of its members) waits for the user to allow it. */
  needsApproval(sessionId: string): boolean
  /** Coordinator step three: whether the session is the project's coordinator conversation. */
  isCoordinator(sessionId: string): Promise<boolean>
  /** Coordinator step three: the project notes file (`<dataDir>/coordinator-notes.md`). */
  notesFile(): string
}

/** Coordinator step three: the project notes, in the project's data directory. */
export const COORDINATOR_NOTES_FILE = 'coordinator-notes.md'

/** Pure: the member name a thread's runs carry in the coordinator (`thread-<n>`, or a slug of an ASCII title). */
export function threadRunName(title: string, index: number): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/^[^a-z]+/, '').slice(0, 32).replace(/-+$/, '')
  return slug.length >= 3 ? slug : `thread-${index}`
}

function at(records: readonly SessionRecord[]): string {
  return records.at(-1)?.ts ?? ''
}

function lastTurn(records: readonly SessionRecord[]): number {
  let turn = 0
  for (const record of records) if (record.type === 'turn.start') turn = record.turn
  return turn
}

/** The text of a turn's last assistant message. */
function replyOf(records: readonly SessionRecord[], turn: number): string {
  let text = ''
  for (const record of records) if (record.type === 'assistant.message' && record.turn === turn) text = record.content
  return text
}

/** Pure: a thread's status from its records (`running` comes from the host). */
export function threadStatusOf(records: readonly SessionRecord[], running: boolean): { readonly status: ThreadStatus; readonly blocker?: string } {
  if (running) return { status: 'running' }
  const turn = lastTurn(records)
  const end = records.findLast(record => record.type === 'turn.end' && record.turn === turn)
  if (turn === 0 || end === undefined || end.type !== 'turn.end') return { status: 'stopped' }
  switch (end.reason.kind) {
    case 'completed': {
      const blocker = reportBlocker(replyOf(records, turn))
      return blocker === undefined ? { status: 'done' } : { status: 'waiting', blocker }
    }
    case 'error':
    case 'max-tokens':
      return { status: 'failed' }
    default:
      return { status: 'stopped' }
  }
}

/** Pure: a thread as the tools and the interface see it (`needsApproval` counts only while it runs). */
export function threadInfoOf(threadId: string, records: readonly SessionRecord[], running: boolean, needsApproval = false): ThreadInfo {
  const start = records[0]
  if (start?.type !== 'session.start' || start.thread === undefined) throw new NexgentError('session/not-found', `session ${threadId} is not a thread`)
  const { status, blocker } = threadStatusOf(records, running)
  return {
    threadId,
    title: start.thread.title,
    coordinatorSessionId: start.thread.coordinatorSessionId,
    status,
    turns: records.filter(record => record.type === 'turn.start').length,
    createdAt: start.ts,
    updatedAt: at(records),
    ...(blocker === undefined ? {} : { blocker }),
    ...(running && needsApproval ? { needsApproval: true as const } : {}),
  }
}

/** What a thread turn produced, from its records (as a member runner counts it). */
function turnFacts(records: readonly SessionRecord[], turn: number) {
  const deliverables: DeliverableVersionRef[] = []
  const denied: MemberDenial[] = []
  let requestCount = 0
  for (const record of records) {
    if (!('turn' in record) || record.turn !== turn) continue
    if (record.type === 'deliverable.presented') deliverables.push(record.deliverable)
    if (record.type === 'assistant.message') requestCount += 1
    if (record.type === 'tool.result') {
      const code = record.error?.code
      if ((code === 'approval/denied' || code === 'sandbox/denied') && !denied.some(item => item.tool === record.name)) denied.push({ tool: record.name, code })
    }
  }
  return { deliverables, requestCount, denied }
}

function model(records: readonly SessionRecord[]): string | undefined {
  const start = records[0]
  return start?.type === 'session.start' ? start.model : undefined
}

/** The kernel's `ThreadHost` over the SDK's sessions of one project. */
export class SdkThreadHost implements ThreadHost {
  /** Per coordinator: measurements run one at a time. */
  private readonly measuring = new Map<string, Promise<void>>()

  constructor(private readonly rt: ThreadRuntime) {}

  async start(input: ThreadStartInput): Promise<ThreadInfo> {
    const title = input.title.trim().replace(/\s+/g, ' ')
    if (title === '' || title.length > THREAD_LIMITS.titleChars) throw new NexgentError('tool/invalid-input', `"title" must be 1 to ${THREAD_LIMITS.titleChars} characters`)
    if (input.task.trim() === '') throw new NexgentError('tool/invalid-input', '"task" must not be empty')
    const threads = await this.list({ coordinatorSessionId: input.coordinatorSessionId })
    if (threads.length >= THREAD_LIMITS.maxThreads) {
      throw new NexgentError('tool/denied', `this conversation already has ${threads.length} threads (at most ${THREAD_LIMITS.maxThreads}): give an existing thread the work with message_thread`)
    }
    const running = threads.filter(thread => thread.status === 'running').length
    if (running >= THREAD_LIMITS.maxRunning) {
      throw new NexgentError('tool/denied', `${running} threads are running (at most ${THREAD_LIMITS.maxRunning} at once): wait for one to finish, or give a running one the work with message_thread`)
    }
    const threadId = await this.rt.create({ title, thread: { coordinatorSessionId: input.coordinatorSessionId, title } })
    await this.runFor(input, threadId, threadRunName(title, threads.length + 1), title, input.task, input.materialIds)
    return this.info(threadId)
  }

  async message(input: ThreadCaller & { readonly threadId: string; readonly text: string }): Promise<ThreadInfo> {
    if (input.text.trim() === '') throw new NexgentError('tool/invalid-input', '"text" must not be empty')
    const info = await this.own(input.coordinatorSessionId, input.threadId)
    if (!(await this.rt.steer(input.threadId, input.text))) {
      const index = (await this.rt.threadIds(input.coordinatorSessionId)).indexOf(input.threadId) + 1
      await this.runFor(input, input.threadId, threadRunName(info.title, index), info.title, input.text)
    }
    return this.info(input.threadId)
  }

  async read(input: { readonly coordinatorSessionId: string; readonly threadId: string }): Promise<ThreadView> {
    await this.own(input.coordinatorSessionId, input.threadId)
    const records = await this.rt.records(input.threadId)
    const info = threadInfoOf(input.threadId, records, this.rt.running(input.threadId), this.rt.needsApproval(input.threadId))
    const turn = lastTurn(records)
    const reply = replyOf(records, turn)
    const merge = this.rt.lastMerge(input.threadId) ?? (await this.recordedMerge(input.coordinatorSessionId, input.threadId, turn))
    let usage: LLMUsage | undefined
    for (const record of records) if (record.type === 'assistant.message' && record.turn === turn) usage = usage === undefined ? record.usage : addUsage(usage, record.usage)
    return {
      ...info,
      reply: reply.length > THREAD_LIMITS.replyChars ? reply.slice(0, THREAD_LIMITS.replyChars) : reply,
      ...(reply.length > THREAD_LIMITS.replyChars ? { cut: reply.length - THREAD_LIMITS.replyChars } : {}),
      applied: [...(merge?.applied ?? [])],
      conflicts: (merge?.conflicts ?? []).map(conflict => ({ path: conflict.path, ...(conflict.copy === undefined ? {} : { copy: conflict.copy }) })),
      ...(usage === undefined ? {} : { usage }),
    }
  }

  async list(input: { readonly coordinatorSessionId: string }): Promise<readonly ThreadInfo[]> {
    const out: ThreadInfo[] = []
    for (const threadId of await this.rt.threadIds(input.coordinatorSessionId)) {
      try {
        out.push(await this.info(threadId))
      } catch {
        // an unreadable thread is left out; opening it reports why
      }
    }
    return out
  }

  private async info(threadId: string): Promise<ThreadInfo> {
    return threadInfoOf(threadId, await this.rt.records(threadId), this.rt.running(threadId), this.rt.needsApproval(threadId))
  }

  // -------------------------------------------------------------------------
  // coordinator step three: the coordinator's notes and prompt
  // -------------------------------------------------------------------------

  isCoordinator(sessionId: string): Promise<boolean> {
    return this.rt.isCoordinator(sessionId)
  }

  /** The project notes (empty when there are none yet). */
  async readNotes(): Promise<string> {
    try {
      return await readFile(this.rt.notesFile(), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
      throw error
    }
  }

  /** Replace the project notes (written to a temporary file, then renamed). */
  async writeNotes(text: string): Promise<void> {
    if (text.length > THREAD_LIMITS.notesChars) throw new NexgentError('tool/invalid-input', `the notes are ${text.length} characters (at most ${THREAD_LIMITS.notesChars}): keep what stays true across tasks and drop the rest`)
    const file = this.rt.notesFile()
    await mkdir(dirname(file), { recursive: true })
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temporary, text.trim() === '' ? '' : `${text.trim()}\n`, 'utf8')
    await rename(temporary, file)
  }

  /** A thread of this coordinator, or `session/not-found`. */
  private async own(coordinatorSessionId: string, threadId: string): Promise<ThreadInfo> {
    let info: ThreadInfo
    try {
      info = await this.info(threadId)
    } catch {
      throw new NexgentError('session/not-found', `no thread ${threadId} in this conversation (list_threads lists them)`)
    }
    if (info.coordinatorSessionId !== coordinatorSessionId) throw new NexgentError('session/not-found', `no thread ${threadId} in this conversation (list_threads lists them)`)
    return info
  }

  /** The merge of a thread run the coordinator recorded, for a thread whose last turn ended in an earlier process. */
  private async recordedMerge(coordinatorSessionId: string, threadId: string, turn: number): Promise<WorkdirMerge | undefined> {
    const records = await this.rt.records(coordinatorSessionId).catch(() => [] as readonly SessionRecord[])
    const end = records.findLast(record => record.type === 'subagent.end' && record.childSessionId === threadId && record.childTurn === turn)
    return end?.type === 'subagent.end' ? end.result.merge : undefined
  }

  /** Start a thread turn for the coordinator and record it there; returns once the run is recorded. */
  private async runFor(caller: ThreadCaller, threadId: string, name: string, title: string, text: string, materialIds?: readonly string[]): Promise<void> {
    const started = await this.rt.startTurn(threadId, text, materialIds)
    const recorded = await this.rt.append(caller.coordinatorSessionId, {
      type: 'subagent.start',
      turn: caller.turn,
      ...(caller.toolCallId === undefined ? {} : { toolCallId: caller.toolCallId }),
      childSessionId: threadId,
      childTurn: started.turn,
      name,
      executionForm: 'thread',
      task: text.slice(0, 500),
      ...(materialIds === undefined || materialIds.length === 0 ? {} : { materialIds: [...materialIds] }),
    }).then(() => true, (error: unknown) => {
      this.rt.report(caller.coordinatorSessionId, error)
      return false
    })
    void started.done
      .then(result => ({ result }), (error: unknown) => ({ error }))
      .then(settled => this.ended(caller, threadId, title, started.turn, settled, recorded))
      .catch(error => this.rt.report(caller.coordinatorSessionId, error))
  }

  private async ended(
    caller: ThreadCaller,
    threadId: string,
    title: string,
    childTurn: number,
    settled: { readonly result: TurnResult } | { readonly error: unknown },
    recorded: boolean,
  ): Promise<void> {
    if (this.rt.closed()) return
    const records = await this.rt.records(threadId).catch(() => [] as readonly SessionRecord[])
    const facts = turnFacts(records, childTurn)
    const result: MemberResult = 'result' in settled
      ? toMemberResult(settled.result, facts)
      : { status: 'failed', text: '', deliverables: facts.deliverables, usage: ZERO_USAGE, requestCount: facts.requestCount, error: toErrorInfo(settled.error) }
    if (recorded) {
      await this.rt.ensureOpen(caller.coordinatorSessionId)
      const coordinator = await this.rt.records(caller.coordinatorSessionId).catch(() => [] as readonly SessionRecord[])
      // Recovery may already have closed the run (the coordinator was reopened meanwhile).
      const closed = coordinator.some(record => record.type === 'subagent.end' && record.childSessionId === threadId && record.childTurn === childTurn)
      if (!closed) await this.rt.append(caller.coordinatorSessionId, { type: 'subagent.end', turn: caller.turn, childSessionId: threadId, childTurn, result })
    }
    const cause = 'result' in settled && settled.result.reason.kind === 'cancelled' ? settled.result.reason.cause : undefined
    if (cause === 'shutdown') return
    if (this.rt.closed()) return
    // A thread the user stopped, or one stopped at the cost cap, stays stopped: the coordinator is not woken to pick it up again.
    if (cause !== 'user' && cause !== 'cost-cap') {
      const { status } = threadStatusOf(records, false)
      const mergedThreads = result.merge !== undefined && result.merge.applied.length > 0 ? await this.mergedThreads(caller.coordinatorSessionId) : undefined
      await this.rt.wake(caller.coordinatorSessionId, threadWakeNote({
        title,
        threadId,
        status,
        reply: result.text,
        ...(result.merge === undefined ? {} : { merge: result.merge }),
        ...(mergedThreads === undefined ? {} : { mergedThreads }),
      }))
    }
    if (recorded) await this.measure(caller.coordinatorSessionId, caller.turn)
  }

  /**
   * Threads whose runs merged changes into the project since the user's last
   * message in the coordinator, once no thread run is still going
   * (`undefined` while one is).
   */
  private async mergedThreads(coordinatorSessionId: string): Promise<number | undefined> {
    const records = await this.rt.records(coordinatorSessionId).catch(() => [] as readonly SessionRecord[])
    const starts = records.filter(record => record.type === 'subagent.start' && record.executionForm === 'thread')
    const ends = records.filter(record => record.type === 'subagent.end')
    const ended = (start: SessionRecord) => start.type === 'subagent.start' && ends.some(end => end.type === 'subagent.end' && end.childSessionId === start.childSessionId && end.childTurn === start.childTurn)
    if (!starts.every(ended)) return undefined
    const since = records.findLast(record => record.type === 'user.message' && record.source === 'user')?.seq ?? 0
    const threads = new Set(starts.flatMap(start => (start.type === 'subagent.start' ? [start.childSessionId] : [])))
    const merged = new Set(ends.flatMap(end => (end.type === 'subagent.end' && end.seq > since && threads.has(end.childSessionId) && (end.result.merge?.applied.length ?? 0) > 0 ? [end.childSessionId] : [])))
    return merged.size
  }

  /** Once a coordinator turn's thread runs have all ended, measure the turn with them and hand it to the library. */
  private measure(coordinatorSessionId: string, turn: number): Promise<void> {
    const previous = this.measuring.get(coordinatorSessionId) ?? Promise.resolve()
    const next = previous.then(() => this.measureNow(coordinatorSessionId, turn)).catch(error => this.rt.report(coordinatorSessionId, error))
    this.measuring.set(coordinatorSessionId, next)
    void next.finally(() => {
      if (this.measuring.get(coordinatorSessionId) === next) this.measuring.delete(coordinatorSessionId)
    })
    return next
  }

  private async measureNow(coordinatorSessionId: string, turn: number): Promise<void> {
    const memory = this.rt.organizations()
    if (memory?.noteProfile === undefined) return
    const before = await this.rt.records(coordinatorSessionId)
    if (threadRunCount(before, turn) === 0 || openThreadRuns(before, turn) > 0) return
    await this.rt.turnDone(coordinatorSessionId, turn)
    if (this.rt.closed()) return
    const records = await this.rt.records(coordinatorSessionId)
    const children = new Map<string, readonly SessionRecord[]>()
    const threadRuns: { readonly childSessionId: string; readonly childTurn: number }[] = []
    for (const record of records) {
      if (record.type !== 'subagent.start' || record.turn !== turn) continue
      if (record.executionForm === 'thread') threadRuns.push(record)
      if (children.has(record.childSessionId)) continue
      try {
        children.set(record.childSessionId, await this.rt.records(record.childSessionId))
      } catch {
        // measured from the coordinator's records only
      }
    }
    const costOf = (usage: LLMUsage, of: string | undefined) => this.rt.costOf(usage, of)
    const profile = buildOrganizationProfile({ turn, records, children, usd: 0, costOf })
    // The threads' cost: each run's own requests and its members'.
    let addUsd = 0
    for (const run of threadRuns) {
      const child = children.get(run.childSessionId) ?? []
      let usage = ZERO_USAGE
      for (const record of child) {
        if (!('turn' in record) || record.turn !== run.childTurn) continue
        if (record.type === 'assistant.message') usage = addUsage(usage, record.usage)
        if (record.type === 'subagent.end') usage = addUsage(usage, record.result.usage)
      }
      addUsd += costOf(usage, model(child)) ?? 0
    }
    await memory.noteProfile({ sessionId: coordinatorSessionId, turn, profile, addUsd })
  }
}

// ---------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------

export const START_THREAD_DESCRIPTION = 'Hand one part of the work to a thread, short or long: a conversation of its own that runs in the background '
  + 'in its own copy of the project (merged back when each of its turns ends). It does its part itself or organizes its own members. '
  + 'A thread that has finished folds away in the user\'s list; the user can open any thread and talk to it. Give it everything it needs in task: its part, the inputs, what to produce and where, '
  + 'and what not to touch. This returns at once; when the thread ends a turn you get a note with its reply. '
  + `At most ${THREAD_LIMITS.maxRunning} threads run at once; give threads that run at the same time different files, and start a part that needs another's result after that thread ends.`

export const MESSAGE_THREAD_DESCRIPTION = 'Tell one of your threads something: a correction, an answer to its question, or its next step. '
  + 'It joins the turn the thread is running, or starts its next turn in the background; you get a note when that turn ends.'

export const READ_THREAD_DESCRIPTION = 'A thread\'s status, its last reply, and the project files its last turn brought in or left in conflict.'

export const LIST_THREADS_DESCRIPTION = 'Every thread of this conversation with its status (running, waiting for an answer, done, stopped, failed).'

function definition(spec: Step2ToolSpec, description: string): Tool['definition'] {
  return {
    name: spec.name,
    description,
    inputSchema: spec.inputSchema,
    effects: spec.effects,
    approval: spec.approval,
    ...(spec.concurrent === undefined ? {} : { concurrent: spec.concurrent }),
  }
}

const STATUS_TEXT: Readonly<Record<ThreadStatus, string>> = {
  running: 'running',
  waiting: 'waiting for an answer',
  done: 'done',
  stopped: 'stopped',
  failed: 'failed',
}

function infoLine(info: ThreadInfo): string {
  return `- ${info.title} (id ${info.threadId}): ${STATUS_TEXT[info.status]}, ${info.turns} turn${info.turns === 1 ? '' : 's'}${info.needsApproval === true ? '; a tool call in it waits for the user to allow it (the user answers in that thread)' : ''}${info.blocker === undefined ? '' : `; blocker: ${info.blocker}`}`
}

function host(lookup: () => ThreadHost | undefined, context: ToolContext): ThreadHost {
  if (context.member !== undefined) throw new NexgentError('tool/denied', 'members cannot use threads')
  const threads = lookup()
  if (threads === undefined) throw new NexgentError('tool/failed', 'this host runs no threads')
  return threads
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new NexgentError('tool/invalid-input', `"${field}" must be a non-empty string`)
  return value
}

/** The four thread tools over `ctx.threads`. */
export function threadTools(lookup: () => ThreadHost | undefined): Tool[] {
  const start: Tool = {
    definition: definition(START_THREAD_TOOL, START_THREAD_DESCRIPTION),
    handler: async (raw, context): Promise<ToolOutput> => {
      const args = (raw ?? {}) as Record<string, unknown>
      const materialIds = args.materialIds === undefined ? undefined : (args.materialIds as unknown[]).map(id => text(id, 'materialIds[]'))
      const info = await host(lookup, context).start({
        coordinatorSessionId: context.sessionId,
        turn: context.turn,
        toolCallId: context.callId,
        title: text(args.title, 'title'),
        task: text(args.task, 'task'),
        ...(materialIds === undefined ? {} : { materialIds }),
      })
      return {
        content: `Thread "${info.title}" started (id ${info.threadId}). It works in the background; you get a note when its turn ends. Go on with other work or end your turn: do not wait for it.`,
        meta: { threadId: info.threadId },
      }
    },
  }
  const message: Tool = {
    definition: definition(MESSAGE_THREAD_TOOL, MESSAGE_THREAD_DESCRIPTION),
    handler: async (raw, context): Promise<ToolOutput> => {
      const args = (raw ?? {}) as Record<string, unknown>
      const info = await host(lookup, context).message({
        coordinatorSessionId: context.sessionId,
        turn: context.turn,
        toolCallId: context.callId,
        threadId: text(args.thread, 'thread'),
        text: text(args.text, 'text'),
      })
      return { content: `Sent to thread "${info.title}"; it is working on it. You get a note when its turn ends.`, meta: { threadId: info.threadId } }
    },
  }
  const read: Tool = {
    definition: definition(READ_THREAD_TOOL, READ_THREAD_DESCRIPTION),
    handler: async (raw, context): Promise<ToolOutput> => {
      const args = (raw ?? {}) as Record<string, unknown>
      const view = await host(lookup, context).read({ coordinatorSessionId: context.sessionId, threadId: text(args.thread, 'thread') })
      const lines = [infoLine(view).slice(2)]
      if (view.applied.length > 0) lines.push(`Brought into the project by its last turn: ${view.applied.join(', ')}`)
      for (const conflict of view.conflicts) lines.push(`Conflict: ${conflict.path} kept as the project has it${conflict.copy === undefined ? '' : `; the thread's version is at ${conflict.copy}`}`)
      lines.push('', 'Last reply:', view.reply.trim() === '' ? '(none)' : view.reply)
      if (view.cut !== undefined) lines.push(`[… ${view.cut} more characters cut]`)
      return { content: lines.join('\n') }
    },
  }
  const list: Tool = {
    definition: definition(LIST_THREADS_TOOL, LIST_THREADS_DESCRIPTION),
    handler: async (_raw, context): Promise<ToolOutput> => {
      const threads = await host(lookup, context).list({ coordinatorSessionId: context.sessionId })
      return { content: threads.length === 0 ? 'This conversation has no threads.' : threads.map(infoLine).join('\n') }
    },
  }
  return [start, message, read, list]
}

/**
 * Coordinator step three: what the coordinator conversation is told at the
 * start of every turn. General: how to keep the notes, brief a thread and
 * take its note; nothing about any task.
 */
export const COORDINATOR_PROMPT = [
  'You are this project\'s coordinator conversation: the user\'s standing entry to the project. You do not do the work yourself and start no members; threads do all of it, and each thread organizes its own members. '
    + 'Your job: split the task into parts, hand each part to a thread (start_thread), follow their progress, pass the user\'s corrections on at once (message_thread), '
    + 'check their results, sum them up for the user, and reflect on how the task was split. Answer simple questions directly.',
  '',
  'Project notes: keep them with update_project_notes. They hold what stays true across tasks: the project\'s long-term goals, the user\'s standing rules, decisions made and why, and pitfalls found. Write one short line per fact with its reason, under the headings Goals, Rules, Decisions and Pitfalls. No progress reports, no one-off requests, nothing a file in the project already says. Update them when you learn something of that kind; replace a line that turned out wrong rather than adding a second one.',
  '',
  'Briefing a thread (start_thread, message_thread): state the goal, the inputs (files, materials, what is already known), what done looks like, and what it must not do or touch. Pass on the rules from the notes that apply to its part.',
  '',
  'When a thread\'s note arrives: when the note says its reply was cut, read the whole reply with read_thread first (yourself, without asking the user). Then sum up for the user in a few lines what the thread did and what it left open, decide the next step (answer its question, give it or another thread the next part, check its work, or finish) and do it.',
].join('\n')

/** Pure: the coordinator's system sections for a turn. */
export function coordinatorSections(notes: string): SystemPromptSection[] {
  return [
    { id: 'coordinator', title: 'Coordinating this project', body: COORDINATOR_PROMPT },
    { id: 'coordinator-notes', title: 'Project notes', body: notes.trim() === '' ? '(none yet)' : notes.trim() },
  ]
}

/** Coordinator step three: the coordinator's prompt and notes, for its turns only. */
export function coordinatorProvider(host: SdkThreadHost): ContextProvider {
  return {
    id: 'coordinator',
    async beginTurn(input) {
      if (!(await host.isCoordinator(input.sessionId))) return {}
      return { systemSections: coordinatorSections(await host.readNotes()) }
    },
  }
}

export const UPDATE_PROJECT_NOTES_DESCRIPTION = 'Replace the project notes with a new full text: the project\'s long-term goals, the user\'s standing rules, decisions and why, and pitfalls. '
  + `They are shown to you at the start of every turn. At most ${THREAD_LIMITS.notesChars} characters.`

/** Coordinator step three: `update_project_notes`. */
export function projectNotesTool(host: SdkThreadHost): Tool {
  return {
    definition: definition(UPDATE_PROJECT_NOTES_TOOL, UPDATE_PROJECT_NOTES_DESCRIPTION),
    handler: async (raw, context): Promise<ToolOutput> => {
      if (context.member !== undefined || !(await host.isCoordinator(context.sessionId))) throw new NexgentError('tool/denied', 'only the coordinator conversation keeps the project notes')
      const notes = (raw ?? {}) as Record<string, unknown>
      if (typeof notes.notes !== 'string') throw new NexgentError('tool/invalid-input', '"notes" must be a string')
      await host.writeNotes(notes.notes)
      return { content: notes.notes.trim() === '' ? 'The project notes are now empty.' : `The project notes are saved (${notes.notes.trim().length} characters).` }
    },
  }
}

/** Name of the profile row. */
export const THREADS_PLUGIN_NAME = '@nexgent/threads'

/** The plugin of one project: provides `ctx.threads`, registers the thread tools and `update_project_notes`, and the coordinator's context. */
export function threadsPlugin(threads: SdkThreadHost) {
  return {
    name: THREADS_PLUGIN_NAME,
    apply(ctx: Context): void {
      ctx.provide('threads', threads)
      ctx.inject(['tools'], scope => {
        for (const tool of [...threadTools(() => threads), projectNotesTool(threads)]) scope.effect(() => scope.tools.register(tool), `tools.register(${tool.definition.name})`)
      })
      ctx.inject(['context'], scope => {
        scope.effect(() => scope.context.register(coordinatorProvider(threads)), 'context.register(coordinator)')
      })
    },
  }
}
