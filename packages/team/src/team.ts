/**
 * One Lead session's team at run time (`agent-hooks.md` §步骤 3 工具,
 * `data-formats.md` §团队): the state rebuilt from the Lead's `team.*`
 * records, the teammates' open child sessions, and their runs.
 *
 * - A teammate run is one turn of its child session, recorded in the Lead as
 *   a `subagent.start` / `subagent.end` pair. Runs start only inside a Lead
 *   tool call (`spawn_teammate`, `send_message`, `wait_teammates`), because
 *   `subagent.start` is a tool record; they run in the background, held open
 *   with `lead.holdTurn`, and never outlive the Lead's turn: when it ends the
 *   kernel cancels them with cause `parent`, the teammate stays `active`, and
 *   the next Lead turn continues it.
 * - At most {@link COLLABORATION_LIMITS.maxConcurrentMembers} teammates run
 *   at once (the kernel does not limit this).
 * - Mail is queued in the Lead and delivered once: injected (a
 *   `user.message { source: 'inject' }` carrying the message id) before the
 *   recipient's next model request when a teammate is running (the kernel's
 *   `Agent.beforeRequest`), else at the start of its next turn, then recorded
 *   `delivered`. Mail for the Lead is handed over by `wait_teammates` or
 *   injected at the Lead's next turn.
 */
import {
  COLLABORATION_LIMITS,
  NexgentError,
  TEAM_LEAD_NAME,
  toErrorInfo,
  type Agent,
  type AgentPreset,
  type AgentsService,
  type ErrorInfo,
  type MemberResult,
  type SessionRecord,
  type SessionRecordInput,
  type SessionStore,
  type TeamMember,
  type TeamMemberStatus,
  type TeamMessage,
  type TeamTask,
  type Tool,
} from '@nexgent/kernel'
import { sessionPresetRegistry, type CapabilityPresetLookup } from '@nexgent/preset'
import { RECORDED_TASK_CHARS, runMemberTurn, startMember } from '@nexgent/subagent'
import {
  applyRecord,
  checkMessage,
  checkSpawn,
  checkTaskCreate,
  checkTaskUpdate,
  deliveredIds,
  pendingFor,
  reduceTeam,
  renderInjectedMessage,
  type TaskCreateInput,
  type TaskUpdateInput,
  type TeamState,
} from './state.js'

/** A `team.*` record as a caller passes it. */
export type TeamRecordInput = Extract<SessionRecordInput, { readonly type: 'team.member' | 'team.task' | 'team.message' }>
type SubagentStartInput = Extract<SessionRecordInput, { readonly type: 'subagent.start' }>

/** Where team records go: a Lead tool call's `appendRecord`, or the Lead's `appendHostRecord`. */
export type TeamRecordSink = (record: TeamRecordInput) => Promise<unknown>

/** A Lead tool call, as the team needs it. */
export interface LeadCall {
  readonly turn: number
  readonly callId: string
  readonly signal: AbortSignal
  /** The call's `appendRecord`. */
  readonly append: (record: TeamRecordInput | SubagentStartInput) => Promise<unknown>
}

/** Services a team uses. */
export interface TeamDeps {
  readonly agents: Pick<AgentsService, 'get' | 'create' | 'resume'>
  readonly store: Pick<SessionStore, 'readAll'>
  /** Absolute project root (presets are read from it). */
  readonly projectRoot: () => string
  /** The tools a teammate gets in its own scope (`send_message`, `team_task_list`, `team_task_update`). */
  readonly teammateTools: (team: Team, name: string) => readonly Tool[]
  /** `ctx.capabilities`, when loaded: presets of the Lead session's capability version and the ones it tried. */
  readonly capabilities?: CapabilityPresetLookup
}

/**
 * Runs one teammate may start in a single Lead turn. Mail can wake a
 * teammate again and again; this keeps two teammates that keep answering
 * each other from running without end (later mail waits for the next turn).
 */
export const MAX_RUNS_PER_LEAD_TURN = 8

/** First message of a teammate's first run. */
export function renderTeammatePrompt(input: { readonly name: string; readonly task: string; readonly files: readonly string[]; readonly team: readonly string[] }): string {
  const parts = [`You are teammate "${input.name}". Your task:\n${input.task}`]
  if (input.files.length > 0) parts.push(`Read these project files first:\n${input.files.map(file => `- ${file}`).join('\n')}`)
  parts.push(
    `The team: ${[TEAM_LEAD_NAME, ...input.team].join(', ')} ("${TEAM_LEAD_NAME}" is the main conversation). `
    + 'Use send_message to reach anyone by name; messages to you arrive before your next step. '
    + 'team_task_list shows the shared task board and the team; team_task_update claims a task (in_progress), completes it with a one-line result, or cancels it. '
    + `Write files under your own subdirectory (${input.name}/) unless told otherwise, and hand them back with present. `
    + 'End with a short reply: what you did, where, and what is left.',
  )
  return parts.join('\n\n')
}

/** Turn text when new mail wakes an idle teammate (the mail itself is injected just before it). */
export const WAKE_PROMPT = 'New team messages arrived (above). Act on them, then end with a short reply: what you did and what is left.'

/** Turn text when an unfinished teammate continues in a later Lead turn. */
export const CONTINUE_PROMPT = 'Your previous turn was stopped before you finished (the lead\'s turn ended). '
  + 'Continue your task from where you stopped; any new team messages are above. End with a short reply: what you did and what is left.'

/** A teammate's last settled run. */
export interface TeammateRun {
  readonly leadTurn: number
  readonly childSessionId: string
  readonly childTurn: number
  readonly result: MemberResult
}

interface Mate {
  agent?: Agent
  /** Set from the moment a run is decided until it settles. */
  running?: Promise<void>
  preset?: AgentPreset
  persona?: string
  runs: { turn: number; count: number }
  last?: TeammateRun
  error?: ErrorInfo
}

type RunKind = 'continue' | 'wake'

/**
 * Bring the mailbox in line with what recipients actually saw, after a hard
 * kill: a `queued` message whose marker is in its recipient's session (an
 * injected message, or a Lead tool result) gets its `delivered` record; one
 * that is not stays queued and is delivered once later. Pure decision; the
 * caller writes.
 */
export async function undeliveredButSeen(state: TeamState, leadRecords: readonly SessionRecord[], store: Pick<SessionStore, 'readAll'>): Promise<TeamMessage[]> {
  const queued = [...state.messages.values()].filter(message => message.state === 'queued')
  if (queued.length === 0) return []
  const seen = new Map<string, Set<string>>()
  const seenBy = async (recipient: string): Promise<Set<string>> => {
    let ids = seen.get(recipient)
    if (ids !== undefined) return ids
    if (recipient === TEAM_LEAD_NAME) {
      ids = deliveredIds(leadRecords)
    } else {
      const member = state.members.get(recipient)
      try {
        ids = member === undefined ? new Set() : deliveredIds((await store.readAll(member.sessionId)).records)
      } catch {
        ids = new Set()
      }
    }
    seen.set(recipient, ids)
    return ids
  }
  const out: TeamMessage[] = []
  for (const message of queued) {
    if ((await seenBy(message.to)).has(message.id)) out.push(message)
  }
  return out
}

/**
 * Recovery after the Lead session was resumed (call between turns, after
 * `closeInterruptedRuns`): write the `delivered` records of messages a
 * recipient already received before the process died. Idempotent.
 * @returns the messages marked delivered.
 */
export async function recoverTeam(lead: Agent, store: Pick<SessionStore, 'readAll'>): Promise<TeamMessage[]> {
  const { records } = await store.readAll(lead.sessionId)
  const seen = await undeliveredButSeen(reduceTeam(records), records, store)
  for (const message of seen) await lead.appendHostRecord({ type: 'team.message', message: { ...message, state: 'delivered' } })
  return seen
}

export class Team {
  readonly leadId: string
  readonly state: TeamState
  private readonly deps: TeamDeps
  private readonly mates = new Map<string, Mate>()
  private lock: Promise<unknown> = Promise.resolve()
  private readonly waiters = new Set<() => void>()
  /** Lead turn whose end already cancelled teammates (no new runs start in it). */
  private settling: number | undefined
  /** Message ids handed to a recipient's turn start or next request and not yet recorded delivered. */
  private readonly inflight = new Set<string>()

  constructor(deps: TeamDeps, leadId: string, state: TeamState) {
    this.deps = deps
    this.leadId = leadId
    this.state = state
  }

  // -------------------------------------------------------------------------
  // basics
  // -------------------------------------------------------------------------

  /** The open Lead agent. */
  lead(): Agent {
    const lead = this.deps.agents.get(this.leadId)
    if (lead === undefined || lead.isClosed) throw new NexgentError('internal', `the lead session ${this.leadId} is not open`)
    return lead
  }

  private readonly hostSink: TeamRecordSink = record => this.lead().appendHostRecord(record)

  /** Run `task` after every earlier one (state checks and their records never interleave). */
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const result = this.lock.catch(() => undefined).then(task)
    this.lock = result
    return result
  }

  private async write(sink: TeamRecordSink, record: TeamRecordInput): Promise<void> {
    await sink(record)
    applyRecord(this.state, { ...record, seq: 0, ts: '', sessionId: this.leadId } as SessionRecord)
    this.notify()
  }

  private notify(): void {
    for (const wake of [...this.waiters]) wake()
  }

  /** Settles on the next state change, or when `signal` aborts. */
  private changed(signal: AbortSignal): Promise<void> {
    return new Promise(resolve => {
      const done = () => {
        this.waiters.delete(done)
        signal.removeEventListener('abort', done)
        resolve()
      }
      this.waiters.add(done)
      signal.addEventListener('abort', done, { once: true })
    })
  }

  private mate(name: string): Mate {
    let mate = this.mates.get(name)
    if (mate === undefined) {
      mate = { runs: { turn: 0, count: 0 } }
      this.mates.set(name, mate)
    }
    return mate
  }

  /** Names of teammates with a run in progress. */
  running(): Set<string> {
    return new Set([...this.mates].filter(([, mate]) => mate.running !== undefined).map(([name]) => name))
  }

  /** The teammate a session belongs to. */
  nameOf(sessionId: string): string | undefined {
    if (sessionId === this.leadId) return TEAM_LEAD_NAME
    return [...this.state.members.values()].find(member => member.sessionId === sessionId)?.name
  }

  /** A teammate's last settled run. */
  lastRun(name: string): TeammateRun | undefined {
    return this.mates.get(name)?.last
  }

  /**
   * After a reload: record `delivered` for queued messages a recipient
   * already saw (see {@link undeliveredButSeen}).
   */
  async reconcile(leadRecords: readonly SessionRecord[]): Promise<void> {
    await this.serial(async () => {
      for (const message of await undeliveredButSeen(this.state, leadRecords, this.deps.store)) {
        await this.write(this.hostSink, { type: 'team.message', message: { ...message, state: 'delivered' } })
      }
    })
  }

  // -------------------------------------------------------------------------
  // teammates and runs
  // -------------------------------------------------------------------------

  private async presetOf(member: TeamMember, mate: Mate): Promise<AgentPreset | undefined> {
    let preset = mate.preset
    if (preset === undefined && member.preset !== undefined) {
      preset = await (await sessionPresetRegistry(this.deps.projectRoot(), this.leadId, this.deps.capabilities)).resolve(member.preset)
      mate.preset = preset
    }
    // The spawn persona: in memory, or from the roster after a restart.
    const persona = mate.persona ?? member.persona
    if (preset === undefined || persona === undefined) return preset
    return { ...preset, persona }
  }

  /** Give a teammate's agent its team tools and its mail before each model request, and remember it. */
  private bind(name: string, agent: Agent): Agent {
    for (const tool of this.deps.teammateTools(this, name)) agent.ctx.tools.register(tool)
    agent.beforeRequest(() => this.takeInjections(agent.sessionId))
    this.mate(name).agent = agent
    return agent
  }

  /** The teammate's open agent, resumed under the Lead when it was closed (a later Lead turn, or after a restart). */
  private async agentOf(name: string): Promise<Agent> {
    const mate = this.mate(name)
    if (mate.agent !== undefined && !mate.agent.isClosed) return mate.agent
    const member = this.state.members.get(name)
    if (member === undefined) throw new NexgentError('internal', `no teammate named ${name}`)
    const preset = await this.presetOf(member, mate)
    const agent = await this.deps.agents.resume(member.sessionId, {
      child: { parentSessionId: this.leadId },
      ...(preset === undefined ? {} : { preset }),
    })
    return this.bind(name, agent)
  }

  /** What a teammate would start now, if anything. */
  private runnable(name: string, leadTurn: number): RunKind | undefined {
    const member = this.state.members.get(name)
    const mate = this.mates.get(name)
    if (member === undefined || mate?.running !== undefined) return undefined
    if (mate !== undefined && mate.runs.turn === leadTurn && mate.runs.count >= MAX_RUNS_PER_LEAD_TURN) return undefined
    if (member.status === 'active') return 'continue'
    if (member.status === 'idle' && pendingFor(this.state, name).some(message => !this.inflight.has(message.id))) return 'wake'
    return undefined
  }

  /**
   * Record and start one run (inside a Lead call): `team.member active`
   * when needed, `subagent.start`, then the member turn in the background.
   */
  private async startRun(call: LeadCall, name: string, agent: Agent, input: { readonly text: string; readonly task: string; readonly materialIds?: readonly string[] }): Promise<void> {
    const mate = this.mate(name)
    const member = this.state.members.get(name)!
    if (member.status !== 'active') await this.write(call.append, { type: 'team.member', member: { ...member, status: 'active' } })
    await call.append({
      type: 'subagent.start',
      turn: call.turn,
      toolCallId: call.callId,
      childSessionId: agent.sessionId,
      childTurn: agent.turn + 1,
      name,
      executionForm: 'team',
      ...(member.preset === undefined ? {} : { preset: member.preset }),
      task: input.task.slice(0, RECORDED_TASK_CHARS),
      ...(input.materialIds === undefined || input.materialIds.length === 0 ? {} : { materialIds: [...input.materialIds] }),
    })
    if (mate.runs.turn !== call.turn) mate.runs = { turn: call.turn, count: 0 }
    mate.runs.count += 1
    const run = this.execute(name, agent, input, call.turn)
    mate.running = run
    this.lead().holdTurn(run)
  }

  private async execute(name: string, agent: Agent, input: { readonly text: string; readonly materialIds?: readonly string[] }, leadTurn: number): Promise<void> {
    const mate = this.mate(name)
    try {
      const { turn, result } = await runMemberTurn(agent, { text: input.text, ...(input.materialIds === undefined ? {} : { materialIds: input.materialIds }) })
      const lead = this.lead()
      await lead.appendHostRecord({ type: 'subagent.end', turn: leadTurn, childSessionId: agent.sessionId, childTurn: turn, result })
      mate.last = { leadTurn, childSessionId: agent.sessionId, childTurn: turn, result }
      // A run cancelled by the Lead's turn ending: start nothing more in that turn; the teammate continues in the next one.
      if (result.status === 'cancelled' && (result.error?.details as { cause?: unknown } | undefined)?.cause === 'parent') this.settling = leadTurn
      const status: TeamMemberStatus = result.status === 'failed' ? 'stopped' : result.status === 'cancelled' || result.status === 'interrupted' ? 'active' : 'idle'
      await this.serial(async () => {
        const member = this.state.members.get(name)
        if (member !== undefined && member.status !== status) await this.write(this.hostSink, { type: 'team.member', member: { ...member, status } })
      })
    } catch (error) {
      mate.error = toErrorInfo(error)
    } finally {
      delete mate.running
      this.notify()
    }
  }

  /** Start the runs that are due, up to the concurrency limit. Call inside {@link serial}. */
  private async pump(call: LeadCall): Promise<void> {
    if (call.signal.aborted || this.settling === call.turn) return
    for (const member of [...this.state.members.values()]) {
      if (this.running().size >= COLLABORATION_LIMITS.maxConcurrentMembers) return
      const kind = this.runnable(member.name, call.turn)
      if (kind === undefined) continue
      const agent = await this.agentOf(member.name)
      const text = kind === 'wake' ? WAKE_PROMPT : CONTINUE_PROMPT
      await this.startRun(call, member.name, agent, { text, task: text })
    }
  }

  /** Options of {@link spawn}. */
  async spawn(call: LeadCall, input: {
    readonly name: string
    readonly preset: AgentPreset
    readonly persona?: string
    readonly prompt: string
    readonly task: string
    readonly materialIds: readonly string[]
  }): Promise<Agent> {
    return this.serial(async () => {
      checkSpawn(this.state, input.name)
      const running = this.running().size
      if (running >= COLLABORATION_LIMITS.maxConcurrentMembers) {
        throw new NexgentError('tool/denied', `${running} teammates are already running (at most ${COLLABORATION_LIMITS.maxConcurrentMembers} at once); call wait_teammates before starting another`)
      }
      const preset = input.persona === undefined ? input.preset : { ...input.preset, persona: input.persona }
      const agent = await startMember({ agents: this.deps.agents, parentSessionId: this.leadId, name: input.name, executionForm: 'team', preset })
      // A stopped teammate's name is reused by a new session: forget the old one's run state.
      this.mates.delete(input.name)
      const mate = this.mate(input.name)
      mate.preset = input.preset
      if (input.persona !== undefined) mate.persona = input.persona
      this.bind(input.name, agent)
      await this.write(call.append, { type: 'team.member', member: { name: input.name, sessionId: agent.sessionId, status: 'active', preset: input.preset.name, ...(input.persona === undefined ? {} : { persona: input.persona }) } })
      await this.startRun(call, input.name, agent, { text: input.prompt, task: input.task, materialIds: input.materialIds })
      return agent
    })
  }

  // -------------------------------------------------------------------------
  // mailbox
  // -------------------------------------------------------------------------

  /** Queue a message from the Lead (and wake an idle recipient). */
  async sendFromLead(call: LeadCall, to: string, text: string): Promise<TeamMessage> {
    return this.serial(async () => {
      const message = this.queue(TEAM_LEAD_NAME, to, text)
      await this.write(call.append, { type: 'team.message', message })
      await this.pump(call)
      return message
    })
  }

  /** Queue a message from a teammate (recorded in the Lead; the Lead's next team call or wait wakes an idle recipient). */
  async sendFromTeammate(from: string, to: string, text: string): Promise<TeamMessage> {
    return this.serial(async () => {
      const message = this.queue(from, to, text)
      await this.write(this.hostSink, { type: 'team.message', message })
      return message
    })
  }

  private queue(from: string, to: string, text: string): TeamMessage {
    checkMessage(this.state, from, to, text)
    return { id: crypto.randomUUID(), from, to, text, state: 'queued' }
  }

  /**
   * For a recipient's turn start or, for a running teammate, its next model
   * request: the injected texts of its undelivered mail. Each message is
   * recorded `delivered` once the recipient's session holds it (the kernel
   * appends injected texts before that request starts); one that never
   * landed is offered again at the next request or turn.
   */
  takeInjections(sessionId: string): string[] {
    const recipient = this.nameOf(sessionId)
    if (recipient === undefined) return []
    const messages = pendingFor(this.state, recipient).filter(message => !this.inflight.has(message.id))
    if (messages.length === 0) return []
    const agent = this.deps.agents.get(sessionId)
    if (agent === undefined) return []
    const waiting = new Map(messages.map(message => [message.id, message]))
    for (const id of waiting.keys()) this.inflight.add(id)
    const release = () => {
      unsubscribe()
      for (const id of waiting.keys()) this.inflight.delete(id)
    }
    const unsubscribe = agent.subscribe(event => {
      if (event.type === 'record' && event.record.type === 'user.message' && event.record.source === 'inject') {
        for (const id of deliveredIds([event.record])) {
          const message = waiting.get(id)
          if (message === undefined) continue
          waiting.delete(id)
          void this.serial(async () => {
            try {
              await this.write(this.hostSink, { type: 'team.message', message: { ...message, state: 'delivered' } })
            } catch {
              // Left queued: recovery finds the injected copy and records it then.
            } finally {
              this.inflight.delete(id)
            }
          })
        }
        if (waiting.size === 0) unsubscribe()
      } else if (event.type === 'request.start' || event.type === 'turn.end' || event.type === 'closed') {
        // Injections are written before the request they precede; whatever has not landed by then did not.
        release()
      }
    })
    return messages.map(renderInjectedMessage)
  }

  // -------------------------------------------------------------------------
  // Lead tools
  // -------------------------------------------------------------------------

  /**
   * Wait until the named teammates (default: every active, running or due one)
   * have no run in progress and none due, starting due runs meanwhile; then
   * hand over the Lead's mail (recorded `delivered`).
   */
  async wait(call: LeadCall, names: readonly string[] | undefined): Promise<{ readonly targets: readonly string[]; readonly mail: readonly TeamMessage[] }> {
    const unknown = (names ?? []).filter(name => !this.state.members.has(name))
    if (unknown.length > 0) throw new NexgentError('tool/invalid-input', `no teammates named ${unknown.join(', ')}`)
    const running = this.running()
    const targets = names === undefined
      ? [...this.state.members.values()]
        .filter(member => member.status === 'active' || running.has(member.name) || this.runnable(member.name, call.turn) !== undefined)
        .map(member => member.name)
      : [...new Set(names)]
    for (;;) {
      if (call.signal.aborted) throw new NexgentError('tool/aborted', 'wait_teammates was cancelled')
      const changed = this.changed(call.signal)
      await this.serial(() => this.pump(call))
      const busy = targets.filter(name => this.mates.get(name)?.running !== undefined || this.runnable(name, call.turn) !== undefined)
      if (busy.length === 0 || this.settling === call.turn) break
      await changed
    }
    const mail = await this.serial(async () => {
      const handed: TeamMessage[] = []
      for (const message of pendingFor(this.state, TEAM_LEAD_NAME)) {
        if (this.inflight.has(message.id)) continue
        const delivered: TeamMessage = { ...message, state: 'delivered' }
        await this.write(call.append, { type: 'team.message', message: delivered })
        handed.push(delivered)
      }
      return handed
    })
    return { targets, mail }
  }

  /** Add a board entry. */
  async createTask(sink: TeamRecordSink, input: TaskCreateInput): Promise<TeamTask> {
    return this.serial(async () => {
      const task = checkTaskCreate(this.state, input)
      await this.write(sink, { type: 'team.task', task })
      return task
    })
  }

  /** Change a board entry on behalf of `actor`. */
  async updateTask(sink: TeamRecordSink, actor: string, input: TaskUpdateInput): Promise<TeamTask> {
    return this.serial(async () => {
      const task = checkTaskUpdate(this.state, actor, input)
      await this.write(sink, { type: 'team.task', task })
      return task
    })
  }

  /** A teammate's board update goes to the Lead session. */
  readonly teammateSink: TeamRecordSink = record => this.hostSink(record)
}
