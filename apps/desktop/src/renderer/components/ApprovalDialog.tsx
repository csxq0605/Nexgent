import { useState } from 'react'
import type { ApprovalRequest, ApprovalScope } from '@nexgent/kernel'
import { useAppStore } from '../hooks.js'
import { T, memberFormText, riskText, toolVerb } from '../strings.js'
import { Icon } from './Icon.js'

/**
 * One pending approval as a card in the conversation, above the composer
 * (ADR 0020 §1): one sentence on what is about to happen, the risk, the
 * command, and at most three buttons — 拒绝 / 允许一次 / 总是允许 ▾, the
 * menu choosing this conversation or this project. The request's `options`
 * decide which scopes are offered. (`approval-dialog` stays its test id.)
 */
export function ApprovalCard({ request }: { readonly request: ApprovalRequest }): JSX.Element {
  const store = useAppStore()
  const [menu, setMenu] = useState(false)
  const always = request.options.filter((scope): scope is Exclude<ApprovalScope, 'once'> => scope !== 'once')
  const respond = (decision: 'allow' | 'deny', scope: ApprovalScope): void => {
    setMenu(false)
    void store.respondApproval(request, decision, scope)
  }
  const scopeText = (scope: Exclude<ApprovalScope, 'once'>): string => (scope === 'session' ? T.alwaysSession : T.alwaysProject)
  return (
    <section className="approval-card" role="group" aria-label={T.approvalTitle} data-testid="approval-dialog" data-risk={request.risk}>
      <div className="approval-q">
        <span className={request.risk === 'high' ? 'dot bad' : 'dot warn'} />
        {T.approvalWhat(toolVerb(request.tool))}
      </div>
      {request.member !== undefined && (
        <p className="approval-why" data-testid="approval-member">
          {T.approvalByMember(request.member.name, memberFormText(request.member.executionForm))}
        </p>
      )}
      <p className="approval-why">{T.approvalRiskLine(riskText(request.risk))}</p>
      <pre className="approval-command">{request.summary}</pre>
      {request.detail !== undefined && (
        <details>
          <summary>{T.approvalDetail}</summary>
          <pre className="approval-detail">{request.detail}</pre>
        </details>
      )}
      {request.pattern !== undefined && always.length > 0 && (
        <p className="muted small">
          {T.approvalPattern}：<code>{request.pattern}</code>
        </p>
      )}
      <div className="approval-actions">
        <span className="grow" />
        <button type="button" onClick={() => respond('deny', 'once')} data-testid="approval-deny">
          {T.deny}
        </button>
        {request.options.includes('once') && (
          <button type="button" className={always.length === 0 ? 'primary' : undefined} onClick={() => respond('allow', 'once')} data-testid="approval-once">
            {T.allowOnce}
          </button>
        )}
        {always.length > 0 && (
          <span className="split">
            <button type="button" className="primary" onClick={() => respond('allow', always[0]!)} data-testid="approval-always" title={scopeText(always[0]!)}>
              {T.allowAlways}
            </button>
            {always.length > 1 && (
              <button type="button" className="primary" aria-label={T.allowScope} aria-expanded={menu} onClick={() => setMenu(!menu)} data-testid="approval-scope">
                <Icon name="chevronDown" />
              </button>
            )}
            {menu && (
              <ul className="menu" role="menu">
                {always.map(scope => (
                  <li key={scope}>
                    <button type="button" role="menuitem" onClick={() => respond('allow', scope)} data-testid={`approval-${scope}`}>
                      {scopeText(scope)}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </span>
        )}
      </div>
    </section>
  )
}
