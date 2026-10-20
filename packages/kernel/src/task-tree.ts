/**
 * One task tree: a root agent and the members (child sessions) it started
 * while it is open (ADR 0004 decision 7, `permissions.md` §子会话继承).
 *
 * The tree is minted when the root agent opens (create or resume) and
 * shared by every member: the `taskId`, the `perTask` cost totals that every
 * request of the tree adds to, the forms the tree used, the member count and
 * the `project`-scope grants in force (a grant one member obtains applies to
 * the others at once).
 */
import { randomUUID } from 'node:crypto'
import type { ApprovalGrant } from './contracts/approvals.js'
import { EXECUTION_FORMS, type ExecutionForm } from './contracts/collaboration.js'
import type { CostCap } from './contracts/config.js'
import { addUsage, ZERO_USAGE, type LLMUsage } from './contracts/llm.js'
import type { MemberCost } from './contracts/ledger.js'
import type { Spend } from './cost-caps.js'

/** A member's spend: usage, model requests and tool calls. */
interface MemberTotals {
  usage: LLMUsage
  requestCount: number
  toolCallCount: number
}

const emptyTotals = (): MemberTotals => ({ usage: ZERO_USAGE, requestCount: 0, toolCallCount: 0 })

export class TaskTree {
  /** Lowercase uuid v4 shared by every member. */
  readonly taskId = randomUUID()
  /** Model requests of the whole tree, failed ones included. */
  requests = 0
  /** Known `inputTokens + outputTokens` of the whole tree. */
  tokens = 0
  /** Rework D3: estimated USD of the whole tree, and of it since the root's current turn started (`perTask.maxUsd` counts one root task). */
  usd = 0
  turnUsd = 0
  /** Rework D3: some of the tree's dollars were estimated or are missing. */
  usdEstimated = false
  /** Rework D3: some of `turnUsd` was estimated or is missing. */
  turnUsdEstimated = false
  /**
   * Rework D3: the conversation's spending before the root's current turn
   * (`perConversation`, read from the ledger at the turn's start) and the
   * tree's own totals at that moment; requests the tree sends later are
   * added from its totals.
   */
  conversation: { readonly base: Spend; readonly requests: number; readonly tokens: number; readonly usd: number } | undefined
  /** Rework D3: `cost.warning` keys already written for this tree (once per cap instance). */
  readonly warned = new Set<string>()
  /** Child sessions created in this tree. */
  members = 0
  private readonly forms = new Set<ExecutionForm>(['direct'])
  /**
   * Step 4: each member's spend over the whole tree and since the root's
   * current turn started, in first-start order (`task.outcome.memberCosts`).
   */
  private readonly memberTotals = new Map<string, { name: string; executionForm: ExecutionForm; task: MemberTotals; turn: MemberTotals }>()
  /** Step 4: files of the latest version of each deliverable the tree presented, by deliverable id in first-presentation order. */
  private readonly presented = new Map<string, readonly string[]>()
  /** Deliverable versions presented in the tree since the root's current turn started (the present note reads it). */
  presentedThisTurn = 0
  /** Redesign 3.2: files presented since the root's current turn started (a check on them can make the turn retry). */
  readonly filesPresentedThisTurn = new Set<string>()
  /** Redesign 3.2: length of {@link commands} when the root's current turn started. */
  commandsAtTurnStart = 0
  /**
   * Shell commands of the tree run in the project root that exited with a
   * code (any; step 5 keeps failing ones too), in call order. Timed-out and
   * cancelled calls have no code and are left out.
   */
  readonly commands: { command: string; shell: 'bash' | 'pwsh'; exitCode: number }[] = []
  /** Step 4: whether a root-turn snapshot was taken (step 5 takes one every root turn), so checks run. */
  snapshotTaken = false
  /** Rework K4 D4: the root turn's snapshot once started (it never rejects); members wait for it before changing the project. */
  snapshot: Promise<unknown> | undefined

  constructor(
    /** Session id of the root agent. */
    readonly rootSessionId: string,
    /** The root's `costCaps.perTask`; the whole tree counts against it. */
    readonly perTask: CostCap | undefined,
    /** `project`-scope grants in force for every session of the tree. */
    readonly projectGrants: ApprovalGrant[],
  ) {}

  /** Record that a member of `form` was started. */
  use(form: ExecutionForm): void {
    this.forms.add(form)
  }

  /** Step 4: note a member (first start or reopen) so it appears in `memberCosts` even before it spends anything. */
  addMember(memberId: string, name: string, executionForm: ExecutionForm): void {
    if (!this.memberTotals.has(memberId)) this.memberTotals.set(memberId, { name, executionForm, task: emptyTotals(), turn: emptyTotals() })
  }

  /** Step 4: add a member's model requests and usage. */
  chargeMember(memberId: string, requests: number, usage: LLMUsage | undefined): void {
    const entry = this.memberTotals.get(memberId)
    if (entry === undefined) return
    for (const totals of [entry.task, entry.turn]) {
      totals.requestCount += requests
      if (usage !== undefined) totals.usage = addUsage(totals.usage, usage)
    }
  }

  /** Step 4: count one tool call of a member. */
  countMemberToolCall(memberId: string): void {
    const entry = this.memberTotals.get(memberId)
    if (entry === undefined) return
    entry.task.toolCallCount += 1
    entry.turn.toolCallCount += 1
  }

  /** Step 4: the root started a turn; per-turn member totals restart (the SDK counts a turn as a task). */
  beginRootTurn(): void {
    for (const entry of this.memberTotals.values()) entry.turn = emptyTotals()
    this.presentedThisTurn = 0
    this.filesPresentedThisTurn.clear()
    this.commandsAtTurnStart = this.commands.length
    this.turnUsd = 0
    this.turnUsdEstimated = false
    for (const key of [...this.warned]) if (key.startsWith('perTask:')) this.warned.delete(key)
  }

  /** Step 4: each member's spend over the whole tree (`task`) or since the root's current turn started (`turn`). */
  memberCosts(span: 'task' | 'turn' = 'task'): MemberCost[] {
    return [...this.memberTotals.entries()].map(([memberId, entry]) => {
      const totals = entry[span]
      return { memberId, name: entry.name, executionForm: entry.executionForm, usage: totals.usage, requestCount: totals.requestCount, toolCallCount: totals.toolCallCount }
    })
  }

  /** Step 4: note the files of a presented deliverable version (a later version replaces the earlier one's files). */
  present(deliverableId: string, paths: readonly string[]): void {
    this.presented.set(deliverableId, [...paths])
    this.presentedThisTurn += 1
    for (const path of paths) this.filesPresentedThisTurn.add(path)
  }

  /** Step 4: files of the latest presented version of each deliverable, deduplicated, first presentation first. */
  deliverableFiles(): string[] {
    return [...new Set([...this.presented.values()].flat())]
  }

  /** Forms the tree used, deduplicated, in {@link EXECUTION_FORMS} order. */
  formsUsed(): ExecutionForm[] {
    return EXECUTION_FORMS.filter(form => this.forms.has(form))
  }
}
