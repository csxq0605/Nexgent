/**
 * The approval contract: what the kernel's approval broker asks a host (CLI
 * or desktop app) and what it records. The normative text is
 * `docs/spec/permissions.md` §工具审批 and §CLI 与桌面应用共用的审批交互.
 */

/** How far a granted approval reaches. */
export type ApprovalScope = 'once' | 'session' | 'project'

/** How risky the call is: low = sensitive read, medium = blacklisted command, high = always-ask table. */
export type ApprovalRisk = 'low' | 'medium' | 'high'

/** Who closed an approval request. */
export type ApprovalDecidedBy = 'user' | 'timeout' | 'cancel' | 'headless'

/** One pending question to the host. */
export interface ApprovalRequest {
  /** Request id; written to the session and the ledger. */
  readonly id: string
  readonly sessionId: string
  /** The {@link ToolCall.id} being authorized. */
  readonly callId: string
  /** Tool name, e.g. `bash`, `pwsh`, `fs.write`. */
  readonly tool: string
  /** One line: the full command or the path. */
  readonly summary: string
  /** Multi-line context: cwd, the rule that matched, the model's reason. */
  readonly detail?: string
  readonly risk: ApprovalRisk
  /** Scopes the host may offer; the always-ask table offers only `once`. */
  readonly options: readonly ApprovalScope[]
  /** Pattern a `session` / `project` grant would store (command prefix or path glob). */
  readonly pattern?: string
  /** ISO-8601 deadline; the CLI fills it, the desktop app may leave it empty. */
  readonly expiresAt?: string
}

/** The host's answer. A request is answered at most once; late answers are dropped. */
export interface ApprovalDecision {
  /** The {@link ApprovalRequest.id} answered. */
  readonly id: string
  readonly decision: 'allow' | 'deny'
  /** Always `once` for a deny. */
  readonly scope: ApprovalScope
  readonly decidedBy: ApprovalDecidedBy
  /** Optional user note. */
  readonly reason?: string
}

/** A standing grant: a `session` grant lives in the session file, a `project` grant in `config.json.approvals`. */
export interface ApprovalGrant {
  readonly tool: string
  /** Command prefix or project-relative path glob; absent admits every call of the tool. */
  readonly pattern?: string
  /** ISO-8601 instant the grant was made. */
  readonly grantedAt: string
}

/** How a tool call was authorized, as the ledger's `tool.call.approval` records it. */
export interface ToolCallApproval {
  /** Whether policy required an answer for this call. */
  readonly required: boolean
  /** `auto` = admitted without asking (approval `never`, or an existing grant matched). */
  readonly decision: 'allow' | 'deny' | 'timeout' | 'cancel' | 'auto'
  readonly scope?: ApprovalScope
  /** The {@link ApprovalRequest.id}, when one was raised. */
  readonly requestId?: string
}

/** What a call acts on, for matching standing grants. */
export interface ApprovalSubject {
  readonly kind: 'command' | 'path' | 'other'
  /** Full command, project-relative path, or a compact rendering of the arguments. */
  readonly value: string
}

/** What a tool hands to {@link ToolContext.requestApproval} when policy says `ask`. */
export interface ToolApprovalAsk {
  /** One line: what is about to happen (full command or path). */
  readonly summary: string
  /** Multi-line context (matched rule, cwd). */
  readonly detail?: string
  /** Default `medium`. */
  readonly risk?: ApprovalRisk
  /** Grant pattern (command prefix or path glob); absent derives one from `subject`. */
  readonly pattern?: string
  /** Default `{ kind: 'other', value: summary }`. */
  readonly subject?: ApprovalSubject
  /** Scopes to offer; default all the host supports; `high` risk offers only `once`. */
  readonly options?: readonly ApprovalScope[]
}

/** The single host-side responder; without one every request is denied with `decidedBy: 'timeout'`. */
export type ApprovalResponder = (request: ApprovalRequest, signal: AbortSignal) => Promise<ApprovalDecision>

/** The `ctx.approvals` broker. */
export interface ApprovalBroker {
  /** Register the host's responder; returns an unregister function. A second registration replaces the first. */
  setResponder(responder: ApprovalResponder): () => void
  /** Ask; resolves with a decision (never rejects for deny / timeout / cancel). */
  request(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision>
}
