import { useState, type FormEvent } from 'react'
import type { CandidateDetail, CandidateView } from '@nexgent/sdk'
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

/** ADR 0007's default when a trial's plan predates `costApprovalRatio`. */
const DEFAULT_COST_APPROVAL_RATIO = 2

/** Why a quality rise waits for the user on cost (ADR 0007): the ratio, its limit, each arm's cost and the quality comparison. */
interface CostApproval {
  readonly ratio: number
  readonly limit: number
  readonly basis: 'usd' | 'tokens'
  readonly candidate: number | 'unknown'
  readonly baseline: number | 'unknown'
  readonly passRate: { readonly candidate: number; readonly baseline: number }
  readonly feedbackPassRate?: { readonly candidate: number; readonly baseline: number }
}

/** The cost reason of a candidate awaiting approval, from its gate decision (or the trial's end receipt); undefined when cost is not why it waits. */
export function costApproval(detail: CandidateDetail): CostApproval | undefined {
  const decision = [...detail.decisions].reverse().find(d => d.outcome === 'awaiting-approval' && d.verdict !== undefined)
  const end = [...detail.receipts].reverse().find(r => r.type === 'trial.end' && (decision?.trialId === undefined || r.trialId === decision.trialId))
  const verdict = decision?.verdict ?? (end?.type === 'trial.end' ? end.verdict : undefined)
  const cost = decision?.cost ?? (end?.type === 'trial.end' ? end.cost : undefined)
  if (verdict === undefined || verdict.outcome !== 'await-approval' || verdict.reason !== 'quality-up' || typeof verdict.costRatio !== 'number') return undefined
  const trialId = decision?.trialId ?? end?.trialId
  const start = detail.receipts.find(r => r.type === 'trial.start' && r.trialId === trialId)
  const limit = (start?.type === 'trial.start' ? start.plan.costApprovalRatio : undefined) ?? DEFAULT_COST_APPROVAL_RATIO
  if (verdict.costRatio <= limit) return undefined
  const basis = verdict.costBasis ?? 'tokens'
  const amount = (arm: 'candidate' | 'baseline'): number | 'unknown' => {
    const armCost = cost?.[arm]
    if (armCost === undefined) return 'unknown'
    if (basis === 'usd') return armCost.estimatedUsd
    const { inputTokens: input, outputTokens: output } = armCost.usage
    return typeof input === 'number' && typeof output === 'number' ? input + output : 'unknown'
  }
  return {
    ratio: verdict.costRatio,
    limit,
    basis,
    candidate: amount('candidate'),
    baseline: amount('baseline'),
    passRate: verdict.passRate,
    ...(verdict.feedbackPassRate === undefined ? {} : { feedbackPassRate: verdict.feedbackPassRate }),
  }
}

/** ADR 0013: the newest awaiting-approval decision waits because the candidate was verified only on the original task. */
export function originalOnlyApproval(detail: CandidateDetail): boolean {
  const decision = [...detail.decisions].reverse().find(d => d.outcome === 'awaiting-approval')
  return decision?.reason === 'no-similar-cases'
}

const ratioText = (n: number) => (Math.round(n * 100) / 100).toString()
const percent = (n: number) => `${Math.round(n * 100)}%`
const usdText = (n: number | 'unknown') => (n === 'unknown' ? '未知' : `$${n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2)}`)
const tokenText = (n: number | 'unknown') => (n === 'unknown' ? '未知' : n.toLocaleString('en-US'))

function CostApprovalSection({ cost }: { readonly cost: CostApproval }): JSX.Element {
  return (
    <div className="stack candidate-detail" data-testid="approval-cost">
      <p className="small wrap">{T.costApprovalBody}</p>
      <strong className="small" data-testid="approval-cost-ratio">{T.costApprovalRatio(ratioText(cost.ratio), ratioText(cost.limit))}</strong>
      <span className="small wrap" data-testid="approval-cost-amounts">
        {cost.basis === 'usd'
          ? T.costApprovalUsd(usdText(cost.candidate), usdText(cost.baseline))
          : T.costApprovalTokens(tokenText(cost.candidate), tokenText(cost.baseline))}
      </span>
      <span className="small wrap" data-testid="approval-quality">{T.costApprovalQuality(percent(cost.passRate.candidate), percent(cost.passRate.baseline))}</span>
      {cost.feedbackPassRate !== undefined && (
        <span className="small wrap" data-testid="approval-feedback">{T.costApprovalFeedback(percent(cost.feedbackPassRate.candidate), percent(cost.feedbackPassRate.baseline))}</span>
      )}
    </div>
  )
}

/**
 * A candidate awaiting the user's approval (ADR 0005, ADR 0007): a plugin
 * package shows its names, bundle hash, file hashes and what each plugin
 * may do; a quality rise above the cost limit shows the cost ratio, each
 * arm's estimated cost and the quality comparison; both when both apply.
 * Allow adopts, deny rejects.
 */
export function PluginApprovalDialog(): JSX.Element | null {
  const state = useAppState()
  const store = useAppStore()
  const detail = state.pluginApproval
  if (detail === undefined) return null
  const plugins = detail.record.components.filter(component => component.kind === 'plugin')
  const infoOf = (name: string) => detail.plugins?.find(info => info.name === name)
  const unreadable = plugins.filter(component => infoOf(component.name) === undefined).map(component => component.name)
  const cost = costApproval(detail)
  const originalOnly = originalOnlyApproval(detail)
  const title = cost === undefined && !originalOnly && plugins.length > 0 ? T.pluginApprovalTitle : T.candidateApprovalTitle
  return (
    <Modal title={title} testId="plugin-approval-dialog" onClose={() => store.closePluginApproval()}>
      {originalOnly && (
        <div className="stack candidate-detail" data-testid="approval-original-only">
          <strong className="small">{T.approvalOriginalOnlyTitle}</strong>
          <p className="small wrap">{T.approvalOriginalOnlyBody}</p>
        </div>
      )}
      {cost !== undefined && <CostApprovalSection cost={cost} />}
      {plugins.length > 0 && (
        <div className="stack" data-testid="approval-plugins">
          <p className="small wrap">{T.pluginApprovalBody}</p>
          <p className="small">
            {T.pluginApprovalPackages}：
            <strong data-testid="plugin-approval-names">{plugins.map(component => component.name).join('、')}</strong>
          </p>
          <p className="small">
            {T.pluginApprovalVersion}：<code className="wrap" data-testid="plugin-approval-hash">{detail.record.version}</code>
          </p>
          {plugins.map(component => {
            const info = infoOf(component.name)
            return (
              <div key={component.name} className="stack candidate-detail" data-testid="plugin-approval-plugin" data-plugin={component.name}>
                <strong className="small">{component.name}</strong>
                {info === undefined ? null : (
                  <>
                    <span className="small wrap" data-testid="plugin-approval-description">
                      {T.pluginApprovalDescription}：{info.description}
                    </span>
                    <span className="small wrap" data-testid="plugin-approval-permissions">
                      {T.pluginApprovalPermissions}：{info.permissions}
                    </span>
                    <span className="small wrap" data-testid="plugin-approval-tools">
                      {info.tools.length === 0 ? T.pluginApprovalNoTools : `${T.pluginApprovalTools}：${info.tools.join('、')}`}
                    </span>
                  </>
                )}
                <ul className="file-list small" data-testid="plugin-approval-files">
                  {component.files.map(file => (
                    <li key={file.path} className="wrap">
                      {component.name}/{file.path} <code>{file.sha256.slice(0, 16)}</code>
                    </li>
                  ))}
                </ul>
              </div>
            )
          })}
          {unreadable.length > 0 && (
            <div className="error-banner small wrap" role="alert" data-testid="plugin-approval-unreadable">
              {T.pluginApprovalUnreadable(unreadable.join('、'))}
            </div>
          )}
        </div>
      )}
      {plugins.length === 0 && (
        <p className="small">
          {T.pluginApprovalVersion}：<code className="wrap" data-testid="plugin-approval-hash">{detail.record.version}</code>
        </p>
      )}
      {detail.view.summary !== undefined && <p className="muted small wrap">{detail.view.summary}</p>}
      <div className="row end">
        <button type="button" className="danger" onClick={() => void store.answerPluginApproval('deny')} data-testid="plugin-deny">
          {T.pluginDeny}
        </button>
        <button type="button" className="primary" disabled={unreadable.length > 0} onClick={() => void store.answerPluginApproval('allow')} data-testid="plugin-allow">
          {T.pluginAllow}
        </button>
      </div>
    </Modal>
  )
}
