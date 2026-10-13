import type { ImprovementDetail, ImprovementJobView } from '@nexgent/sdk'
import { useAppState, useAppStore } from '../hooks.js'
import {
  IMPROVEMENT_CANCELLABLE,
  T,
  candidateStatusText,
  componentKindText,
  decisionReasonText,
  failureCategoryText,
  formatTime,
  improvementPhaseText,
  improvementStatusText,
  improvementTriggerText,
  percentText,
  tokensText,
} from '../strings.js'

function statusClass(status: string): string {
  if (status === 'adopted') return 'ok'
  if (['rejected', 'failed', 'interrupted', 'budget-exhausted'].includes(status)) return 'warn'
  if (status === 'awaiting-approval') return 'accent'
  if (['no-proposal', 'cancelled', 'waiting-history'].includes(status)) return ''
  return 'live'
}

function totalTokens(view: ImprovementJobView): number | 'unknown' | undefined {
  const values = Object.values(view.tokens)
  if (values.length === 0) return undefined
  if (values.some(v => v === 'unknown')) return 'unknown'
  return values.reduce<number>((sum, v) => sum + (v as number), 0)
}

function costText(view: ImprovementJobView): string {
  return view.estimatedUsd === 'unknown' ? T.improvementCostUnknown : `≈ $${view.estimatedUsd.toFixed(2)}`
}

function Detail({ detail }: { readonly detail: ImprovementDetail }): JSX.Element {
  const { diagnosis, candidate, job, view } = detail
  const decision = candidate?.decisions[candidate.decisions.length - 1]
  const verdict = decision?.verdict
  const feedbackRuns = candidate?.receipts.filter(receipt => receipt.type === 'trial.feedback') ?? []
  const feedbackPassed = feedbackRuns.filter(receipt => receipt.status === 'pass').length
  return (
    <div className="candidate-detail stack" data-testid="improvement-detail">
      {diagnosis === undefined ? null : (
        <div className="stack" data-testid="improvement-diagnosis">
          <span className="panel-label">{T.improvementDiagnosis}</span>
          <span className="small wrap">
            {T.improvementHypothesis}：{diagnosis.hypothesis}
          </span>
          <span className="small wrap">
            {T.improvementProposal}：{diagnosis.proposalKind === 'none' ? '无' : componentKindText(diagnosis.proposalKind)}
          </span>
          {diagnosis.failureTypes.length > 0 && (
            <ul className="file-list">
              {diagnosis.failureTypes.map((failure, index) => (
                <li key={index} className="small wrap" data-testid="improvement-failure">
                  {failureCategoryText(failure.category)} · {failure.label}（{T.improvementEvidence(failure.evidence.length)}）
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="stack" data-testid="improvement-candidate">
        <span className="panel-label">{T.improvementCandidate}</span>
        {candidate === undefined ? (
          <span className="muted small">{T.improvementNoCandidate}</span>
        ) : (
          <>
            <span className="small wrap">{candidate.view.components.map(c => `${componentKindText(c.kind)} · ${c.name}`).join('、')}</span>
            <span className="small">
              <span className={`badge ${statusClass(candidate.view.status)}`}>{candidateStatusText(candidate.view.status)}</span>
            </span>
            {candidate.view.summary !== undefined && <span className="muted small wrap">{candidate.view.summary}</span>}
          </>
        )}
      </div>

      <div className="stack" data-testid="improvement-gate">
        <span className="panel-label">{T.improvementGate}</span>
        {decision === undefined ? (
          <span className="muted small">{T.improvementNoGate}</span>
        ) : (
          <>
            <span className="small wrap" data-testid="improvement-gate-verdict">
              {improvementStatusText(decision.outcome === 'adopted' ? 'adopted' : decision.outcome === 'rejected' ? 'rejected' : decision.outcome === 'awaiting-approval' ? 'awaiting-approval' : decision.outcome)}：{decisionReasonText(decision.reason)}。{decision.detail}
            </span>
            {verdict !== undefined && (
              <span className="muted small" data-testid="improvement-gate-rate">
                {T.improvementPassRate(percentText(verdict.passRate.candidate), percentText(verdict.passRate.baseline))}
              </span>
            )}
            {verdict?.feedbackPassRate !== undefined && (
              <span className="small" data-testid="improvement-gate-feedback">
                {T.improvementFeedbackRate(percentText(verdict.feedbackPassRate.candidate), percentText(verdict.feedbackPassRate.baseline))}
                {feedbackRuns.length > 0 ? `（${feedbackPassed}/${feedbackRuns.length}）` : ''}
              </span>
            )}
            {verdict?.decidedByReview === true && (
              <span className="muted small" data-testid="improvement-gate-review">
                {T.improvementReviewer}
              </span>
            )}
          </>
        )}
      </div>

      {Object.keys(view.tokens).length > 0 && (
        <ul className="file-list" data-testid="improvement-phases" aria-label={T.improvementPhases}>
          {Object.entries(view.tokens).map(([phase, tokens]) => (
            <li key={phase} className="small" data-phase={phase}>
              {improvementPhaseText(phase)}：{T.improvementTokens(tokensText(tokens as number | 'unknown'))}
            </li>
          ))}
        </ul>
      )}

      {job.firstUse !== undefined && (
        <span className="small ok-text" data-testid="improvement-first-use">
          {T.improvementFirstUse(formatTime(job.firstUse.at))}
        </span>
      )}
      {job.rolledBack !== undefined && (
        <span className="small wrap" data-testid="improvement-rolled-back">
          {T.improvementRolledBack(formatTime(job.rolledBack.at))}
        </span>
      )}
    </div>
  )
}

function Job({ view }: { readonly view: ImprovementJobView }): JSX.Element {
  const state = useAppState()
  const store = useAppStore()
  const detail = state.improvementDetail?.view.id === view.id ? state.improvementDetail : undefined
  const tokens = totalTokens(view)
  return (
    <li className="item column candidate" data-testid="improvement-job" data-job={view.id} data-status={view.status}>
      <button type="button" className="item-button" onClick={() => void store.toggleImprovement(view.id)} aria-expanded={detail !== undefined}>
        <span className="item-title ellipsis" data-testid="improvement-trigger">
          {improvementTriggerText(view.trigger)} · {T.improvementItems(view.itemCount)}
        </span>
        <span className={`badge ${statusClass(view.status)}`} data-testid="improvement-status">
          {improvementStatusText(view.status)}
        </span>
      </button>
      <span className="muted small wrap">
        {formatTime(view.createdAt)} ·{' '}
        <span data-testid="improvement-cost">
          {costText(view)}
          {tokens === undefined ? '' : ` · ${T.improvementTokens(tokensText(tokens))}`}
        </span>
      </span>
      {view.detail !== undefined && view.detail !== '' && (
        <span className="small wrap" data-testid="improvement-detail-text">
          {view.detail}
        </span>
      )}
      {detail !== undefined && <Detail detail={detail} />}
      {IMPROVEMENT_CANCELLABLE.includes(view.status) && (
        <button type="button" className="link small" onClick={() => void store.cancelImprovement(view.id)} data-testid="improvement-cancel">
          {T.improvementCancel}
        </button>
      )}
    </li>
  )
}

/** The 改进 tab: counted feedback and budget, the "improve now" button, and the jobs with the chain feedback → diagnosis → candidate → gate → first use. */
export function ImprovementsPanel(): JSX.Element {
  const state = useAppState()
  const store = useAppStore()
  const listing = state.improvements
  if (listing === undefined) return <p className="muted small">{T.loading}</p>
  const { budget } = listing
  return (
    <div className="panel-section" data-testid="improvement-panel">
      <div className="stack">
        <span className="small" data-testid="improvement-pending">
          {T.improvementPending(listing.pending, listing.threshold)}
        </span>
        <span className="muted small wrap" data-testid="improvement-budget">
          {T.improvementBudget(tokensText(budget.usedTokens), tokensText(budget.maxTokens), budget.windowDays)}
        </span>
        <button type="button" className="primary" disabled={listing.activeJobId !== undefined} onClick={() => void store.runImprovement()} data-testid="improvement-run">
          {T.improvementRun}
        </button>
      </div>
      <span className="panel-label">{T.improvementJobs}</span>
      {listing.jobs.length === 0 ? (
        <p className="muted small">{T.improvementNone}</p>
      ) : (
        <ul className="item-list" data-testid="improvement-jobs">
          {listing.jobs.map(view => (
            <Job key={view.id} view={view} />
          ))}
        </ul>
      )}
    </div>
  )
}
