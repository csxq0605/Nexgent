/**
 * `ctx.approvals`: the {@link ApprovalBroker} (`permissions.md` §CLI 与桌面应用共用的审批交互).
 *
 * One host responder at a time. Without one every request is denied with
 * `decidedBy: 'timeout'`. Abort of the caller's signal closes a pending
 * request with `decidedBy: 'cancel'`; the optional `timeoutMs` closes it
 * with `decidedBy: 'timeout'`. A request settles once; answers arriving
 * afterwards are dropped, and the responder's signal is aborted so it can
 * take its prompt down.
 */
import { Context, Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type {
  ApprovalBroker,
  ApprovalDecidedBy,
  ApprovalDecision,
  ApprovalRequest,
  ApprovalResponder,
} from './contracts/approvals.js'

/** Plugin config of {@link ApprovalBrokerService}. */
export interface ApprovalsConfig {
  /** Deadline for an answer in ms; absent waits until answered or cancelled. */
  timeoutMs?: number
}

function deny(request: ApprovalRequest, decidedBy: ApprovalDecidedBy, reason?: string): ApprovalDecision {
  return { id: request.id, decision: 'deny', scope: 'once', decidedBy, ...(reason === undefined ? {} : { reason }) }
}

/** Normalize a responder's answer: id forced to the request's, deny scope forced to `once`, unoffered scope downgraded. */
function normalize(request: ApprovalRequest, answer: ApprovalDecision): ApprovalDecision {
  if (answer.decision !== 'allow') return deny(request, answer.decidedBy, answer.reason)
  const scope = request.options.includes(answer.scope) ? answer.scope : 'once'
  return {
    id: request.id,
    decision: 'allow',
    scope,
    decidedBy: answer.decidedBy,
    ...(answer.reason === undefined ? {} : { reason: answer.reason }),
  }
}

/** The `ctx.approvals` service. */
export class ApprovalBrokerService extends Service implements ApprovalBroker {
  static readonly Config: Schema<ApprovalsConfig> = Schema.object({
    timeoutMs: Schema.natural().description('Deadline for an approval answer in ms; absent waits indefinitely.'),
  })

  private responder: ApprovalResponder | undefined
  private readonly pending = new Set<AbortController>()

  constructor(ctx: Context, private readonly config: ApprovalsConfig = {}) {
    super(ctx, 'approvals')
    ctx.effect(() => () => {
      for (const controller of this.pending) controller.abort()
    }, 'approvals.pending')
  }

  /** Configured answer deadline, used by callers to fill `expiresAt`. */
  get timeoutMs(): number | undefined {
    return this.config.timeoutMs
  }

  /** Whether a host responder is registered. */
  get hasResponder(): boolean {
    return this.responder !== undefined
  }

  setResponder(responder: ApprovalResponder): () => void {
    this.responder = responder
    return () => {
      if (this.responder === responder) this.responder = undefined
    }
  }

  request(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision> {
    const responder = this.responder
    if (signal.aborted) return Promise.resolve(deny(request, 'cancel'))
    if (responder === undefined) return Promise.resolve(deny(request, 'timeout', 'no approval responder is registered'))

    const controller = new AbortController()
    this.pending.add(controller)
    return new Promise<ApprovalDecision>(resolve => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const settle = (decision: ApprovalDecision) => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        this.pending.delete(controller)
        controller.abort()
        resolve(decision)
      }
      const onAbort = () => settle(deny(request, 'cancel'))
      signal.addEventListener('abort', onAbort, { once: true })
      controller.signal.addEventListener('abort', () => settle(deny(request, 'cancel')), { once: true })
      if (this.config.timeoutMs !== undefined) {
        timer = setTimeout(() => settle(deny(request, 'timeout')), this.config.timeoutMs)
      }
      let answer: Promise<ApprovalDecision>
      try {
        answer = Promise.resolve(responder(request, controller.signal))
      } catch (error) {
        answer = Promise.reject(error)
      }
      answer.then(
        decision => settle(normalize(request, decision)),
        (error: unknown) => settle(deny(request, 'timeout', `approval responder failed: ${error instanceof Error ? error.message : String(error)}`)),
      )
    })
  }
}
