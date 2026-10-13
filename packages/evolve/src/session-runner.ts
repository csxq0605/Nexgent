/**
 * How an improvement job opens model sessions. The job process does not boot
 * the product itself: the host entry (the SDK's, which composes every
 * plugin) hands it an {@link ImprovementSessionRunner}, as the step-4 gate
 * gets its replay runner. This module is the seam's contract on the evolve
 * side; `docs/spec/data-formats.md` §改进作业 and `permissions.md`
 * §改进会话与改进预算 say what the runner must do:
 *
 * - `session.start` carries `purpose: 'improvement'` and
 *   `improvement: { jobId, phase, improverVersion }`; the session is written in the real
 *   project's `sessions/` (hidden from the conversation list).
 * - Every ledger record of the session carries `improvementId` = `jobId`
 *   and `improvementPhase` = `phase` (step 6: and `improverVersion`), in
 *   the real project's ledger.
 * - Diagnose: the session's tools are exactly `request.tools` (the four
 *   `improve_*` tools this package builds): no file, command, network,
 *   collaboration or capability tools, no project plugins. Step 6: the
 *   meta-diagnose and meta-propose sessions likewise get exactly their
 *   five and three tools.
 * - Step 6, comparison arms: `projectRoot` is the arm's copy; the records
 *   carry `metaJobId` and `comparisonArm` and go to `ledgerRoot`'s ledger.
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
import type { ComparisonArm, ImproverVersion, LLMUsage, SandboxMode, ThinkingMode, Tool } from '@nexgent/kernel'

/** What a job asks the runner to open. */
export interface ImprovementSessionRequest {
  readonly jobId: string
  /** Step 6 adds the meta job's two sessions (their tools are exactly `request.tools`). */
  readonly phase: 'diagnose' | 'propose' | 'meta-diagnose' | 'meta-propose'
  /** Lowercase uuid v4 the job chose (recorded in `job.json` before the session runs). */
  readonly sessionId: string
  /** The real project (sessions, ledger, candidates). */
  readonly projectRoot: string
  /** Step 6: the improver version the job pinned (for `session.start.improvement` and the ledger). */
  readonly improverVersion: ImproverVersion
  /** Step 6, comparison arms: the meta job and the arm (on `session.start.improvement` and every ledger record). */
  readonly metaJobId?: string
  readonly comparisonArm?: ComparisonArm
  /**
   * Step 6, comparison arms: the real project, whose ledger gets the
   * session's records (`projectRoot` is then the arm's copy, where the
   * session file is written).
   */
  readonly ledgerRoot?: string
  /** Propose only: the snapshot copy the file tools work in. */
  readonly workspaceRoot?: string
  /** Propose only: the sandbox mode of the session (already the narrower one). */
  readonly sandboxMode?: SandboxMode
  readonly model: string
  readonly thinking: ThinkingMode
  readonly title: string
  /** Diagnose, meta-diagnose and meta-propose: the session's complete tool set. */
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
