/**
 * How an improvement job opens model sessions. The job process does not boot
 * the product itself: the host entry (the SDK's, which composes every
 * plugin) hands it an {@link ImprovementSessionRunner}, as the step-4 gate
 * gets its replay runner. This module is the seam's contract on the evolve
 * side; `docs/spec/data-formats.md` §改进作业 and `permissions.md`
 * §改进会话与改进预算 say what the runner must do:
 *
 * - `session.start` carries `purpose: 'improvement'` and
 *   `improvement: { jobId, phase }`; the session is written in the real
 *   project's `sessions/` (hidden from the conversation list).
 * - Every ledger record of the session carries `improvementId` = `jobId`
 *   and `improvementPhase` = `phase`, in the real project's ledger.
 * - Diagnose: the session's tools are exactly `request.tools` (the four
 *   `improve_*` tools this package builds): no file, command, network,
 *   collaboration or capability tools, no project plugins.
 * - Propose: the file tools work in `request.workspaceRoot` (the snapshot
 *   copy), with the ordinary task tools plus `capability_draft / try /
 *   propose`; the sandbox is the narrower of the original task's mode and
 *   `workspace-write`; calls that need approval are denied (`headless`).
 *   Candidates go to the real project's `capabilities/candidates/` when the
 *   runner can route them there; otherwise they stay in the copy and the job
 *   imports the one it accepts.
 * - Model and thinking are `request.model` / `request.thinking`
 *   (`improvement.model`, `improvement.thinking`).
 */
import type { LLMUsage, SandboxMode, ThinkingMode, Tool } from '@nexgent/kernel'

/** What a job asks the runner to open. */
export interface ImprovementSessionRequest {
  readonly jobId: string
  readonly phase: 'diagnose' | 'propose'
  /** Lowercase uuid v4 the job chose (recorded in `job.json` before the session runs). */
  readonly sessionId: string
  /** The real project (sessions, ledger, candidates). */
  readonly projectRoot: string
  /** Propose only: the snapshot copy the file tools work in. */
  readonly workspaceRoot?: string
  /** Propose only: the sandbox mode of the session (already the narrower one). */
  readonly sandboxMode?: SandboxMode
  readonly model: string
  readonly thinking: ThinkingMode
  readonly title: string
  /** Diagnose only: the session's complete tool set. */
  readonly tools?: readonly Tool[]
  readonly signal?: AbortSignal
}

/** How one turn ended. */
export interface ImprovementTurnResult {
  /** `budget`: a cost cap stopped it; `error`: the turn failed (its detail says why). */
  readonly outcome: 'completed' | 'cancelled' | 'budget' | 'error'
  readonly detail?: string
  /** Usage of this turn's model requests (`addUsage`). */
  readonly usage: LLMUsage
  readonly requestCount: number
}

/** An open improvement session. */
export interface ImprovementSession {
  readonly sessionId: string
  /** Send one user message and run the turn to its end. */
  send(text: string): Promise<ImprovementTurnResult>
  /** Release the session (and the product the runner booted for it). */
  close(): Promise<void>
}

/** Opens improvement sessions (provided by the host entry). */
export interface ImprovementSessionRunner {
  open(request: ImprovementSessionRequest): Promise<ImprovementSession>
}
