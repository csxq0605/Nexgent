/**
 * The ledger contract: the append-only accounting written under
 * `.nexgent/ledgers/<yyyy-mm>/requests.jsonl`.
 *
 * The ledger answers "what did this cost and did it work", never "what was
 * said": there is no field for prompt text, message content, tool arguments,
 * tool output, API keys or endpoint credentials, so none can be written. Every
 * model request produces exactly one `llm.request.start` and one
 * `llm.request.end`, failed and aborted ones included (`maxRetries: 0`).
 */
import type { ToolCallApproval } from './approvals.js'
import type { ActivationTrigger, CapabilityVersion, ComponentUsage, DecisionOutcome, DecisionReason, TrialArm } from './capabilities.js'
import type { ExecutionForm } from './collaboration.js'
import type { ErrorInfo } from './errors.js'
import type { FinishReason, LLMRequestPurpose, LLMUsage } from './llm.js'
import type { ToolEffect } from './tools.js'

/**
 * Attribution fields. All optional in the schema. Step 3 kernels stamp
 * `taskId`, `memberId` and `executionForm` on every record a session writes
 * (`AgentAttribution`); step 4 adds `capabilityVersion` on every record a
 * session writes, and `trialId` / `arm` on the records of gate-trial runs.
 */
export interface LedgerAttribution {
  /** Version of the capability bundle the session runs on (`baseline` or its content hash). */
  readonly capabilityVersion?: CapabilityVersion
  /** Step 4: the gate trial this record belongs to (trial runs and reviews); normal tasks have none. */
  readonly trialId?: string
  /** Step 4: which side of the trial the run is (reviewer requests carry `trialId` without `arm`). */
  readonly arm?: TrialArm
  /** Member that issued the record: `main` for the root session, else the child's session id. */
  readonly memberId?: string
  /** How the issuing member executes: directly, delegated, as a teammate (step 3), or in a workflow. */
  readonly executionForm?: ExecutionForm
  /** Task tree the record contributes to; each member session closes with its own `task.outcome`. */
  readonly taskId?: string
}

/** Fields every ledger record carries. */
export interface LedgerRecordBase extends LedgerAttribution {
  readonly type: string
  /** ISO-8601 UTC instant of the event. */
  readonly ts: string
  /** Session the record belongs to, when there is one (auxiliary calls may have none). */
  readonly sessionId?: string
}

/** A model request was sent. */
export interface LLMRequestStartRecord extends LedgerRecordBase {
  readonly type: 'llm.request.start'
  /** Joins to `llm.request.end` and to the session's `assistant.message`. */
  readonly requestId: string
  /** Route key, e.g. `anthropic`. */
  readonly provider: string
  /** Endpoint base URL without credentials. */
  readonly endpoint: string
  readonly model: string
  readonly purpose: LLMRequestPurpose
  /** Whether reasoning was requested. */
  readonly thinking: 'off' | 'on'
}

/** How a request settled. `'unknown'` means the process died before the stream ended. */
export type LLMRequestStatus = 'ok' | 'error' | 'aborted' | 'unknown'

/** A model request settled. */
export interface LLMRequestEndRecord extends LedgerRecordBase {
  readonly type: 'llm.request.end'
  readonly requestId: string
  readonly provider: string
  readonly endpoint: string
  readonly model: string
  readonly status: LLMRequestStatus
  /** Reported usage; all-`'unknown'` when the provider reported none or the request failed early. */
  readonly usage: LLMUsage
  /** Wall-clock ms from send to terminal event. */
  readonly latencyMs: number
  /** HTTP status of the response, when one was received. */
  readonly httpStatus?: number
  /** Finish reason on `ok`/`aborted`. */
  readonly finishReason?: FinishReason
  /** Error code on `error`; never the message. */
  readonly errorCode?: string
}

/** A tool call ran (or was denied). No arguments and no output are recorded. */
export interface ToolCallRecord extends LedgerRecordBase {
  readonly type: 'tool.call'
  readonly sessionId: string
  readonly turn: number
  readonly callId: string
  readonly name: string
  readonly effects: readonly ToolEffect[]
  /** How the call was authorized; `permissions.md` §工具审批. */
  readonly approval: ToolCallApproval
  readonly isError: boolean
  readonly durationMs: number
}

/** One deterministic check the host ran at task end (step 4 fills the set; step 1 fixes the shape). */
export interface TaskCheck {
  /** Check identity; step 4 writes the names in `TASK_CHECK_NAMES` (`file-exists`, `parses`, `test-command`). */
  readonly name: string
  readonly passed: boolean
  /** Short diagnostic; never file contents. */
  readonly detail?: string
  /** Step 4: the check spec's id (`TaskCheckSpec.id`); paths and commands stay in `.nexgent/snapshots/checks/`. */
  readonly target?: string
}

/** How a task ended. */
export type TaskOutcomeStatus = 'completed' | 'cancelled' | 'failed'

/** A task finished; one per task. */
export interface TaskOutcomeRecord extends LedgerRecordBase {
  readonly type: 'task.outcome'
  readonly sessionId: string
  readonly status: TaskOutcomeStatus
  /** Why the task did not complete (e.g. `budget/exhausted`); absent when `completed`. */
  readonly error?: ErrorInfo
  /** Sum of every request's usage in the task. */
  readonly totalUsage: LLMUsage
  readonly requestCount: number
  readonly toolCallCount: number
  /** Turns the task spanned. */
  readonly turns: number
  /** Deterministic checks, when any ran. */
  readonly checks?: readonly TaskCheck[]
  /** Tool names actually called, deduplicated (step 4 proves component use from this). */
  readonly toolsUsed: readonly string[]
  /** Root session only (step 3): forms its tree actually used, deduplicated in {@link EXECUTION_FORMS} order. */
  readonly formsUsed?: readonly ExecutionForm[]
  /** Step 4: capability components this session actually used (calls of cap_* tools, skill loads, presets, templates, graphs, plugin tools). */
  readonly componentsUsed?: readonly ComponentUsage[]
  /** Step 4, root session only: usage of each member of the tree (the root's own totals stay in `totalUsage`). */
  readonly memberCosts?: readonly MemberCost[]
}

/** One member's share of a task tree (`task.outcome.memberCosts`). */
export interface MemberCost {
  /** The member's session id. */
  readonly memberId: string
  readonly name: string
  readonly executionForm: ExecutionForm
  readonly usage: LLMUsage
  readonly requestCount: number
  readonly toolCallCount: number
}

/**
 * Step 4: a capability decision was written (gate verdict, approval, or
 * rollback). The decision record holds the evidence; this line makes it
 * visible next to the costs it concerns.
 */
export interface CapabilityDecisionRecord extends LedgerRecordBase {
  readonly type: 'capability.decision'
  readonly decisionId: string
  readonly outcome: DecisionOutcome
  readonly reason: DecisionReason
  readonly trigger: ActivationTrigger
  readonly fromVersion: CapabilityVersion
  readonly toVersion: CapabilityVersion
  readonly candidateId?: string
  /** Activation revision written for it, when one was. */
  readonly revision?: number
}

/** Every ledger record kind. */
export type LedgerRecord = LLMRequestStartRecord | LLMRequestEndRecord | ToolCallRecord | TaskOutcomeRecord | CapabilityDecisionRecord

/** The `type` tag vocabulary. */
export type LedgerRecordType = LedgerRecord['type']

/** All record types, for schema and exhaustiveness tests. */
export const LEDGER_RECORD_TYPES: readonly LedgerRecordType[] = [
  'llm.request.start',
  'llm.request.end',
  'tool.call',
  'task.outcome',
  'capability.decision',
]

/** Distributive omit over a union. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** What a caller passes to `append`: the ledger stamps `ts`. */
export type LedgerRecordInput = DistributiveOmit<LedgerRecord, 'ts'>

/** A read window; both bounds are inclusive ISO-8601 instants. */
export interface LedgerRange {
  /** Earliest `ts` to include; absent means from the beginning. */
  readonly from?: string
  /** Latest `ts` to include; absent means to the end. */
  readonly to?: string
  /** Only these record types; absent means all. */
  readonly types?: readonly LedgerRecordType[]
  /** Only this session. */
  readonly sessionId?: string
}

/** The `ctx.ledger` service. */
export interface Ledger {
  /**
   * Append one record (fsync before resolving). A write failure rejects with
   * `ledger/write-failed` and increments `writeFailures`; it never changes the
   * outcome of the request it accounts for.
   */
  append(record: LedgerRecordInput): Promise<LedgerRecord>
  /** Stream records in file order within a range. */
  read(range?: LedgerRange): AsyncIterable<LedgerRecord>
  /** Appends that failed since the process started; nonzero means accounting is incomplete. */
  readonly writeFailures: number
}

/**
 * The month directory a record belongs to: `yyyy-mm` of its `ts` in UTC.
 * @param ts - ISO-8601 instant.
 * @throws `RangeError` on an unparsable timestamp.
 */
export function ledgerMonth(ts: string): string {
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) throw new RangeError(`invalid ledger timestamp: ${ts}`)
  return date.toISOString().slice(0, 7)
}

/** File name every step-1 record type is appended to inside the month directory. */
export const LEDGER_FILE_NAME = 'requests.jsonl'
