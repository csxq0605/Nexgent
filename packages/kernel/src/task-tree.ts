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

/** Shared state of one task tree. */
export class TaskTree {
  /** Lowercase uuid v4 shared by every member. */
  readonly taskId = randomUUID()
  /** Model requests of the whole tree, failed ones included. */
  requests = 0
  /** Known `inputTokens + outputTokens` of the whole tree. */
  tokens = 0
  /** Child sessions created in this tree. */
  members = 0
  private readonly forms = new Set<ExecutionForm>(['direct'])

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

  /** Forms the tree used, deduplicated, in {@link EXECUTION_FORMS} order. */
  formsUsed(): ExecutionForm[] {
    return EXECUTION_FORMS.filter(form => this.forms.has(form))
  }
}
