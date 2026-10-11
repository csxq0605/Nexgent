import type { ApprovalRequest } from '@nexgent/kernel'
import { useAppStore } from '../hooks.js'
import { T, memberFormText, riskText } from '../strings.js'
import { Modal } from './Modal.js'

const SCOPE_LABEL = { once: T.allowOnce, session: T.allowSession, project: T.allowProject } as const

/** Asks the user about one pending approval; the request's `options` decide which scopes are offered. */
export function ApprovalDialog({ request }: { readonly request: ApprovalRequest }): JSX.Element {
  const store = useAppStore()
  return (
    <Modal title={T.approvalTitle} testId="approval-dialog">
      {request.member !== undefined && (
        <p className="approval-member" data-testid="approval-member">
          {T.approvalByMember(request.member.name, memberFormText(request.member.executionForm))}
        </p>
      )}
      <p className="approval-summary">
        <span className={`badge risk-${request.risk}`}>
          {T.approvalRisk} {riskText(request.risk)}
        </span>{' '}
        <span className="muted">{request.tool}</span>
      </p>
      <pre className="approval-command">{request.summary}</pre>
      {request.detail !== undefined && <pre className="approval-detail">{request.detail}</pre>}
      {request.pattern !== undefined && request.options.some(o => o !== 'once') && (
        <p className="muted small">
          {T.approvalPattern}：<code>{request.pattern}</code>
        </p>
      )}
      <div className="row end">
        <button type="button" className="danger" onClick={() => void store.respondApproval(request, 'deny', 'once')} data-testid="approval-deny">
          {T.deny}
        </button>
        {request.options.map(scope => (
          <button
            type="button"
            key={scope}
            className={scope === 'once' ? 'primary' : undefined}
            onClick={() => void store.respondApproval(request, 'allow', scope)}
            data-testid={`approval-${scope}`}
          >
            {SCOPE_LABEL[scope]}
          </button>
        ))}
      </div>
    </Modal>
  )
}
