import { useState, type FormEvent } from 'react'
import type { CandidateView } from '@nexgent/sdk'
import { useAppState, useAppStore } from '../hooks.js'
import { T, candidateStatusText, componentKindText, decisionReasonText, formatTime, triggerText, versionText } from '../strings.js'
import { Modal } from './Modal.js'

function statusClass(status: string): string {
  return status === 'adopted' ? 'ok' : status === 'rejected' || status === 'rolled-back' ? 'warn' : status === 'awaiting-approval' ? 'accent' : 'live'
}

function Candidate({ candidate }: { readonly candidate: CandidateView }): JSX.Element {
  const state = useAppState()
  const store = useAppStore()
  const detail = state.candidateDetail?.view.id === candidate.id ? state.candidateDetail : undefined
  const runs = detail?.receipts.filter(receipt => receipt.type === 'trial.run').length ?? 0
  return (
    <li className="item column candidate" data-testid="capability-candidate" data-candidate={candidate.id} data-status={candidate.status}>
      <button type="button" className="item-button" onClick={() => void store.toggleCandidate(candidate.id)} aria-expanded={detail !== undefined}>
        <span className="item-title ellipsis">{candidate.components.map(c => c.name).join('、')}</span>
        <span className={`badge ${statusClass(candidate.status)}`} data-testid="candidate-status">
          {candidateStatusText(candidate.status)}
        </span>
      </button>
      <span className="muted small ellipsis">
        {candidate.components.map(c => componentKindText(c.kind)).join('、')} · {formatTime(candidate.proposedAt)}
        {candidate.requiresApproval ? ` · ${T.candidateNeedsApproval}` : ''}
      </span>
      {candidate.summary !== undefined && <span className="small wrap">{candidate.summary}</span>}
      {detail !== undefined && (
        <div className="candidate-detail" data-testid="candidate-detail">
          {candidate.decision !== undefined ? (
            <p className="small wrap" data-testid="candidate-reason">
              {T.candidateReason}：{decisionReasonText(candidate.decision.reason)}。{candidate.decision.detail}
            </p>
          ) : null}
          <p className="muted small">
            {candidate.trialId === undefined ? T.candidateNoTrial : `${T.candidateTrial} ${candidate.trialId.slice(0, 8)} · ${T.candidateTrialRuns(runs)}`}
          </p>
        </div>
      )}
      {candidate.status === 'proposed' && (
        <button type="button" className="link small" onClick={() => void store.startTrial(candidate.id)} data-testid="candidate-trial">
          {T.candidateStartTrial}
        </button>
      )}
      {candidate.status === 'awaiting-approval' && (
        <button type="button" className="link small" onClick={() => void store.askPluginApproval(candidate.id)} data-testid="candidate-approve">
          {T.candidateApprove}
        </button>
      )}
    </li>
  )
}

function Rollback(): JSX.Element {
  const store = useAppStore()
  const [confirming, setConfirming] = useState(false)
  const [reason, setReason] = useState('')
  if (!confirming) {
    return (
      <button type="button" onClick={() => setConfirming(true)} data-testid="capability-rollback">
        {T.capabilityRollback}
      </button>
    )
  }
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    void store.rollbackCapability(reason).then(() => {
      setConfirming(false)
      setReason('')
    })
  }
  return (
    <form className="stack" onSubmit={submit}>
      <input value={reason} onChange={event => setReason(event.target.value)} placeholder={T.capabilityRollbackReason} aria-label={T.capabilityRollbackReason} data-testid="capability-rollback-reason" />
      <div className="row">
        <button type="submit" className="danger" data-testid="capability-rollback-confirm">
          {T.capabilityRollbackConfirm}
        </button>
        <button type="button" className="ghost" onClick={() => setConfirming(false)}>
          {T.cancel}
        </button>
      </div>
    </form>
  )
}

/** The 能力 tab: adopted version, any problem, candidates with their gate results, the adoption history, manual rollback. */
export function CapabilitiesPanel(): JSX.Element {
  const state = useAppState()
  const listing = state.capabilities
  if (listing === undefined) return <p className="muted small">{T.loading}</p>
  const { current } = listing
  return (
    <div className="panel-section" data-testid="capability-panel">
      {current.problem !== undefined && (
        <div className="error-banner small wrap" role="alert" data-testid="capability-problem">
          <strong>{T.capabilityProblem}：</strong>
          {current.problem}
        </div>
      )}
      <div className="stack" data-testid="capability-current" data-version={current.version} data-revision={current.revision}>
        <span className="panel-label">{T.capabilityCurrent}</span>
        <strong className="ellipsis" title={current.version} data-testid="capability-version">
          {versionText(current.version)}
        </strong>
        {current.revision > 0 && (
          <span className="muted small">
            {T.capabilityRevision(current.revision)}
            {current.trigger !== undefined ? ` · ${triggerText(current.trigger)}` : ''}
            {current.since !== undefined ? ` · ${formatTime(current.since)}` : ''}
          </span>
        )}
        {current.components.length === 0 ? (
          <span className="muted small">{T.capabilityNoComponents}</span>
        ) : (
          <ul className="file-list" data-testid="capability-components">
            {current.components.map(c => (
              <li key={`${c.kind}/${c.name}`} className="small ellipsis">
                {componentKindText(c.kind)} · {c.name}
              </li>
            ))}
          </ul>
        )}
        <span className="muted small">{T.capabilityNewSessions}</span>
        {current.revision > 0 && current.version !== 'baseline' && <Rollback />}
      </div>

      <span className="panel-label">{T.capabilityCandidates}</span>
      {listing.candidates.length === 0 ? (
        <p className="muted small">{T.capabilityNoCandidates}</p>
      ) : (
        <ul className="item-list" data-testid="capability-candidates">
          {listing.candidates.map(candidate => (
            <Candidate key={candidate.id} candidate={candidate} />
          ))}
        </ul>
      )}

      <span className="panel-label">{T.capabilityHistory}</span>
      {listing.history.length === 0 ? (
        <p className="muted small">{T.capabilityNoHistory}</p>
      ) : (
        <ol className="item-list" data-testid="capability-history">
          {[...listing.history].reverse().map(revision => (
            <li key={revision.revision} className="item column" data-testid="capability-revision" data-type={revision.type} data-version={revision.version}>
              <span className="small ellipsis">
                #{revision.revision} {revision.type === 'adopt' ? '采用' : '回滚'} → {versionText(revision.version)}
              </span>
              <span className="muted small">
                {triggerText(revision.trigger)} · {formatTime(revision.committedAt)}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

/** Plugin package approval: package names, bundle hash and file hashes, what a plugin may do; allow adopts, deny rejects. */
export function PluginApprovalDialog(): JSX.Element | null {
  const state = useAppState()
  const store = useAppStore()
  const detail = state.pluginApproval
  if (detail === undefined) return null
  const plugins = detail.record.components.filter(component => component.kind === 'plugin')
  return (
    <Modal title={T.pluginApprovalTitle} testId="plugin-approval-dialog" onClose={() => store.closePluginApproval()}>
      <p className="small wrap">{T.pluginApprovalBody}</p>
      <p className="small">
        {T.pluginApprovalPackages}：
        <strong data-testid="plugin-approval-names">{plugins.map(component => component.name).join('、')}</strong>
      </p>
      <p className="small">
        {T.pluginApprovalVersion}：<code className="wrap" data-testid="plugin-approval-hash">{detail.record.version}</code>
      </p>
      <ul className="file-list small" data-testid="plugin-approval-files">
        {plugins.flatMap(component =>
          component.files.map(file => (
            <li key={`${component.name}/${file.path}`} className="wrap">
              {component.name}/{file.path} <code>{file.sha256.slice(0, 16)}</code>
            </li>
          )),
        )}
      </ul>
      {detail.view.summary !== undefined && <p className="muted small wrap">{detail.view.summary}</p>}
      <div className="row end">
        <button type="button" className="danger" onClick={() => void store.answerPluginApproval('deny')} data-testid="plugin-deny">
          {T.pluginDeny}
        </button>
        <button type="button" className="primary" onClick={() => void store.answerPluginApproval('allow')} data-testid="plugin-allow">
          {T.pluginAllow}
        </button>
      </div>
    </Modal>
  )
}
