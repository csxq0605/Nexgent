/**
 * The member runner: start a child session under an open root agent, run
 * one member turn, turn its end into a `MemberResult`, and record the run in
 * the parent (`subagent.start` / `subagent.end`, `data-formats.md`
 * §子会话与成员). `delegate` uses {@link runMember}; the team and workflow
 * packages reuse the pieces ({@link startMember}, {@link runMemberTurn},
 * {@link toMemberResult}) with their own record sink (a tool call's
 * `appendRecord`, or the Lead's `appendHostRecord` inside `holdTurn`).
 *
 * Inheritance (sandbox, tools, approvals, cost, cancellation) is enforced by
 * the kernel when the child is created and while it runs; nothing here
 * widens or bypasses it.
 */
import {
  addUsage,
  NexgentError,
  toErrorInfo,
  ZERO_USAGE,
  type Agent,
  type AgentPreset,
  type AgentsService,
  type BudgetShare,
  type DelegationMode,
  type DeliverableVersionRef,
  type ErrorInfo,
  type LLMUsage,
  type MemberExecutionForm,
  type MemberResult,
  type MemberResultStatus,
  type SandboxMode,
  type SessionRecordInput,
  type TurnResult,
} from '@nexgent/kernel'

/** Characters of the task text kept in `subagent.start.task`. */
export const RECORDED_TASK_CHARS = 500

/** Input of a `subagent.start` record. */
export type SubagentStartInput = Extract<SessionRecordInput, { readonly type: 'subagent.start' }>
/** Input of a `subagent.end` record. */
export type SubagentEndInput = Extract<SessionRecordInput, { readonly type: 'subagent.end' }>

/** Where a run's parent records go: a tool call's `appendRecord`, or the parent's `appendHostRecord`. */
export type MemberRecordSink = (record: SubagentStartInput | SubagentEndInput) => Promise<unknown>

/** Options of {@link startMember}. */
export interface StartMemberOptions {
  /** `ctx.agents` (only `create` is used). */
  readonly agents: Pick<AgentsService, 'create'>
  /** The open root agent's session id. */
  readonly parentSessionId: string
  readonly name: string
  readonly executionForm: MemberExecutionForm
  readonly preset?: AgentPreset
  /** Default `fresh`. */
  readonly mode?: DelegationMode
  readonly sandboxMode?: SandboxMode
  readonly budget?: BudgetShare
  /** Session title; default `<name>`. */
  readonly title?: string
}

/**
 * Create the member's child session. Fails without writing anything to the
 * parent when the kernel refuses it (`sandbox/denied` for a wider sandbox,
 * `tool/denied` for depth or the member limit, `session/not-found` when the
 * parent is not open here).
 */
export async function startMember(options: StartMemberOptions): Promise<Agent> {
  return options.agents.create({
    title: options.title ?? options.name,
    child: {
      parentSessionId: options.parentSessionId,
      member: { name: options.name, executionForm: options.executionForm, ...(options.preset === undefined ? {} : { preset: options.preset.name }) },
      ...(options.preset === undefined ? {} : { preset: options.preset }),
      ...(options.mode === undefined ? {} : { mode: options.mode }),
      ...(options.sandboxMode === undefined ? {} : { sandboxMode: options.sandboxMode }),
      ...(options.budget === undefined ? {} : { budget: options.budget }),
    },
  })
}

/** What one member turn produced, besides its end reason. */
export interface MemberTurnFacts {
  /** Versions presented during the turn, in order. */
  readonly deliverables: readonly DeliverableVersionRef[]
  /** Model requests the turn made. */
  readonly requestCount: number
  /** The `budget/exhausted` error the kernel recorded, when a cost cap ended the turn. */
  readonly budgetError?: ErrorInfo
}

function nexgentErrorInfo(code: ErrorInfo['code'], message: string, details?: Readonly<Record<string, unknown>>): ErrorInfo {
  return { name: 'NexgentError', code, message, ...(details === undefined ? {} : { details }) }
}

/**
 * Map a member turn's end to the result its parent sees: `completed`;
 * `budget` when a cost cap (task tree or the member's share) stopped it;
 * `cancelled` for any other cancel (`parent`, `user`, `timeout`, `shutdown`);
 * `interrupted` when the process died inside it; `failed` otherwise.
 */
export function toMemberResult(turn: Pick<TurnResult, 'reason' | 'text' | 'usage' | 'merge'>, facts: MemberTurnFacts): MemberResult {
  const base = { text: turn.text, deliverables: [...facts.deliverables], usage: turn.usage, requestCount: facts.requestCount, ...(turn.merge === undefined ? {} : { merge: turn.merge }) }
  const reason = turn.reason
  const end = (status: Exclude<MemberResultStatus, 'completed'>, error: ErrorInfo): MemberResult => ({ status, ...base, error })
  switch (reason.kind) {
    case 'completed':
      return { status: 'completed', ...base }
    case 'cancelled':
      if (reason.cause === 'cost-cap') {
        return end('budget', facts.budgetError ?? nexgentErrorInfo('budget/exhausted', 'a cost cap stopped the member before its next model request'))
      }
      return end('cancelled', nexgentErrorInfo('tool/aborted', `the member was cancelled (${reason.cause})`, { cause: reason.cause }))
    case 'error':
      return end('failed', reason.error)
    case 'max-tokens':
      return end('failed', nexgentErrorInfo('llm/invalid-response', 'the member\'s reply hit the output token limit'))
    case 'interrupted':
      return end('interrupted', nexgentErrorInfo('internal', 'the member\'s turn was interrupted'))
  }
}

/** Input of one member turn. */
export interface MemberTurnInput {
  readonly text: string
  /** Project materials shown in this turn (`TurnInput.materialIds`). */
  readonly materialIds?: readonly string[]
}

/**
 * Run one turn of an open member and settle it as a {@link MemberResult}.
 * Never rejects: a turn that cannot start (closed or busy member, store
 * failure) is a `failed` result.
 */
export async function runMemberTurn(member: Agent, input: MemberTurnInput, options: { readonly signal?: AbortSignal } = {}): Promise<{ readonly turn: number; readonly result: MemberResult }> {
  const deliverables: DeliverableVersionRef[] = []
  let budgetError: ErrorInfo | undefined
  const turn = member.turn + 1
  const requestsBefore = member.taskStats().requestCount
  const unsubscribe = member.subscribe(event => {
    if (event.type === 'record' && event.record.type === 'deliverable.presented' && event.record.turn === turn) deliverables.push(event.record.deliverable)
    if (event.type === 'error' && event.error.code === 'budget/exhausted') budgetError = event.error
  })
  try {
    const ended = await member.run(
      { text: input.text, ...(input.materialIds === undefined || input.materialIds.length === 0 ? {} : { materialIds: [...input.materialIds] }) },
      options.signal === undefined ? {} : { signal: options.signal },
    )
    const facts = { deliverables, requestCount: member.taskStats().requestCount - requestsBefore, ...(budgetError === undefined ? {} : { budgetError }) }
    return { turn: ended.turn, result: toMemberResult(ended, facts) }
  } catch (error) {
    return {
      turn,
      result: { status: 'failed', text: '', deliverables, usage: ZERO_USAGE, requestCount: member.taskStats().requestCount - requestsBefore, error: toErrorInfo(error) },
    }
  } finally {
    unsubscribe()
  }
}

/** Options of {@link runMember}. */
export interface RunMemberOptions extends StartMemberOptions {
  /** The member's first user message. */
  readonly prompt: string
  /** The task as the parent gave it; its first {@link RECORDED_TASK_CHARS} characters go into `subagent.start`. Default `prompt`. */
  readonly task?: string
  readonly materialIds?: readonly string[]
  /** Cancels the member's turn (the kernel also cancels it with cause `parent` when the parent's turn ends). */
  readonly signal?: AbortSignal
  /** Parent turn the records belong to. */
  readonly turn: number
  /** The parent tool call that started the run. */
  readonly toolCallId?: string
  /** Workflow member: the workflow it belongs to. */
  readonly workflowId?: string
  readonly record: MemberRecordSink
}

/** A settled member run. */
export interface MemberRun {
  readonly childSessionId: string
  readonly childTurn: number
  readonly name: string
  readonly result: MemberResult
}

/**
 * Start a member, record `subagent.start`, run its one turn, record
 * `subagent.end`, and close it (the member writes its own `task.outcome`).
 * Rejects only when the member cannot be created (nothing is recorded then)
 * or a parent record cannot be written.
 */
export async function runMember(options: RunMemberOptions): Promise<MemberRun> {
  return runOpenMember(await startMember(options), options)
}

/** Options of {@link continueMember}. */
export interface ContinueMemberOptions extends Omit<RunMemberOptions, 'agents' | 'mode' | 'title' | 'executionForm' | 'sandboxMode'> {
  /** `ctx.agents` (only `resume` is used). */
  readonly agents: Pick<AgentsService, 'resume'>
  /** The member's child session, from an earlier run under the same parent. */
  readonly childSessionId: string
  /** The member's execution form as its session records it (`delegated` or `workflow`). */
  readonly executionForm: MemberExecutionForm
}

/**
 * Rework K4 (audit D6): reopen a member that ran before under the same parent
 * and run one more turn of it with `prompt` (it keeps its whole history),
 * recorded like a new run (`subagent.start` / `subagent.end` with the same
 * child session), then close it again. The kernel checks that the session is
 * a member of this parent.
 */
export async function continueMember(options: ContinueMemberOptions): Promise<MemberRun> {
  const member = await options.agents.resume(options.childSessionId, {
    child: { parentSessionId: options.parentSessionId, ...(options.budget === undefined ? {} : { budget: options.budget }) },
    ...(options.preset === undefined ? {} : { preset: options.preset }),
  })
  return runOpenMember(member, { ...options, mode: 'fresh' })
}

/** Record `subagent.start`, run one turn of an open member, record `subagent.end`, and close it. */
async function runOpenMember(member: Agent, options: Omit<RunMemberOptions, 'agents'>): Promise<MemberRun> {
  let run: MemberRun | undefined
  let failure: unknown
  try {
    const task = options.task ?? options.prompt
    await options.record({
      type: 'subagent.start',
      turn: options.turn,
      ...(options.toolCallId === undefined ? {} : { toolCallId: options.toolCallId }),
      childSessionId: member.sessionId,
      childTurn: member.turn + 1,
      name: options.name,
      executionForm: options.executionForm,
      ...(options.mode === undefined || member.turn > 0 ? {} : { mode: options.mode }),
      ...(options.preset === undefined ? {} : { preset: options.preset.name }),
      ...(options.workflowId === undefined ? {} : { workflowId: options.workflowId }),
      task: task.slice(0, RECORDED_TASK_CHARS),
      ...(options.materialIds === undefined || options.materialIds.length === 0 ? {} : { materialIds: [...options.materialIds] }),
    })
    const { turn, result } = await runMemberTurn(member, { text: options.prompt, ...(options.materialIds === undefined ? {} : { materialIds: options.materialIds }) }, options.signal === undefined ? {} : { signal: options.signal })
    run = { childSessionId: member.sessionId, childTurn: turn, name: options.name, result }
    await options.record({ type: 'subagent.end', turn: options.turn, childSessionId: member.sessionId, childTurn: turn, result })
  } catch (error) {
    failure = error
  } finally {
    await member.close().catch(error => {
      failure ??= error
    })
  }
  if (failure !== undefined) throw failure
  if (run === undefined) throw new NexgentError('internal', 'member run settled without a result')
  return run
}

/** Sum of a run's usage over several results (e.g. a workflow's members). */
export function totalUsage(results: readonly Pick<MemberResult, 'usage'>[]): LLMUsage {
  return results.length === 0 ? ZERO_USAGE : addUsage(...results.map(result => result.usage))
}
