import { useState, type FormEvent } from 'react'
import type { ComparisonArmResult, ImproverBundle, ImproverChange, ImproverComparison } from '@nexgent/kernel'
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
  improverReasonText,
  improverVersionText,
  improvementPhaseText,
  improvementStatusText,
  improvementTriggerText,
  metaStageText,
  percentText,
  triggerText,
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

/** The parent's text the change replaces, and the new text, both as display strings. */
export function changeSides(change: ImproverChange, parent: ImproverBundle | undefined): { readonly label: string; readonly before: string; readonly after: string } {
  const unknown = T.improvementChangeUnknown
  switch (change.op) {
    case 'set-diagnosis-paragraph':
      return {
        label: `改写诊断段落 #${change.index + 1}`,
        before: parent === undefined ? unknown : (parent.diagnosis.paragraphs[change.index] ?? T.improvementChangeMissing),
        after: change.text,
      }
    case 'set-proposal-kinds':
      return { label: '设置可提议的组件类型', before: parent === undefined ? unknown : parent.proposal.kinds.map(componentKindText).join('、'), after: change.kinds.map(componentKindText).join('、') }
    case 'set-proposal-brief':
      return { label: `设置${componentKindText(change.kind)}的提案模板`, before: parent === undefined ? unknown : (parent.proposal.briefs[change.kind] ?? T.improvementChangeMissing), after: change.template }
    case 'set-comparison-param':
      return { label: `设置对比参数 ${change.param}`, before: parent === undefined ? unknown : String(parent.comparison[change.param]), after: String(change.value) }
  }
}

function armTokens(arm: ComparisonArmResult): number | 'unknown' {
  const { totalTokens, inputTokens, outputTokens } = arm.cost.usage
  if (typeof totalTokens === 'number') return totalTokens
  return typeof inputTokens === 'number' && typeof outputTokens === 'number' ? inputTokens + outputTokens : 'unknown'
}

function Arm({ arm }: { readonly arm: ComparisonArmResult }): JSX.Element {
  const verdict = arm.verdict
  const usd = arm.cost.estimatedUsd
  return (
    <li className="stack arm" data-testid="improvement-arm" data-arm={arm.arm}>
      <span className="panel-label">{arm.arm === 'parent' ? T.improvementArmParent : T.improvementArmChild}</span>
      <span className="small wrap" data-testid="improvement-arm-version">
        {T.improverOfJob(improverVersionText(arm.improverVersion))}
      </span>
      <span className="small wrap" data-testid="improvement-arm-offspring">
        {T.improvementArmOffspring}：{arm.candidateId === undefined ? T.improvementArmNoOffspring : arm.candidateId.slice(0, 8)}
      </span>
      <span className="small wrap" data-testid="improvement-arm-gate">
        {T.improvementArmGate}：
        {verdict === undefined
          ? improvementStatusText(arm.status)
          : `${verdict.outcome === 'adopt' ? T.improvementArmGatePass : verdict.outcome === 'reject' ? T.improvementArmGateFail : T.improvementArmGateAwait}（${decisionReasonText(verdict.reason)}）`}
      </span>
      <span className="small" data-testid="improvement-arm-quality">
        {T.improvementArmQuality}：{verdict === undefined ? '—' : percentText(verdict.passRate.candidate)}
      </span>
      <span className="small wrap" data-testid="improvement-arm-cost">
        {T.improvementArmCost}：{usd === 'unknown' ? T.improvementCostUnknown : `≈ $${usd.toFixed(2)}`} · {T.improvementTokens(tokensText(armTokens(arm)))}
      </span>
    </li>
  )
}

function Comparison({ comparison }: { readonly comparison: ImproverComparison }): JSX.Element {
  const { verdict } = comparison
  return (
    <div className="stack" data-testid="improvement-comparison">
      <span className="panel-label">{T.improvementComparison}</span>
      <ul className="arms">
        <Arm arm={comparison.parent} />
        <Arm arm={comparison.child} />
      </ul>
      <span className="small wrap" data-testid="improvement-comparison-verdict" data-outcome={verdict.outcome} data-reason={verdict.reason}>
        {T.improvementDecision}：{verdict.outcome === 'adopt' ? T.improvementDecisionAdopt : T.improvementDecisionReject}（{improverReasonText(verdict.reason)}）
      </span>
    </div>
  )
}

function MetaDetail({ detail }: { readonly detail: ImprovementDetail }): JSX.Element {
  const state = useAppState()
  const { metaDiagnosis, change, comparison, view } = detail
  const sides = change === undefined ? undefined : changeSides(change.change, state.improvementParent)
  return (
    <div className="candidate-detail stack" data-testid="improvement-detail">
      {metaDiagnosis === undefined ? null : (
        <div className="stack" data-testid="improvement-meta-diagnosis">
          <span className="panel-label">{T.improvementMetaDiagnosis}</span>
          <span className="small wrap">
            {T.improvementHypothesis}：{metaDiagnosis.hypothesis}
          </span>
          <span className="small wrap">
            {T.improvementMetaProposal}：{metaDiagnosis.proposal === 'change' ? T.improvementMetaProposalChange : T.improvementMetaNoChange}
          </span>
          {metaDiagnosis.findings.length > 0 && (
            <ul className="file-list" aria-label={T.improvementMetaFindings}>
              {metaDiagnosis.findings.map((finding, index) => (
                <li key={index} className="small wrap" data-testid="improvement-meta-finding" data-stage={finding.stage}>
                  {finding.label}（{T.improvementMetaFinding(metaStageText(finding.stage), finding.jobIds.length)}）
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {change === undefined || sides === undefined ? null : (
        <div className="stack" data-testid="improvement-change" data-op={change.change.op}>
          <span className="panel-label">{T.improvementChange}</span>
          <span className="small wrap">
            {sides.label} · {improverVersionText(change.parentVersion)} → {improverVersionText(change.childVersion)}
          </span>
          <span className="muted small">{T.improvementChangeBefore}</span>
          <pre className="diff-text small wrap" data-testid="improvement-change-before">{sides.before}</pre>
          <span className="muted small">{T.improvementChangeAfter}</span>
          <pre className="diff-text small wrap" data-testid="improvement-change-after">{sides.after}</pre>
          {change.rationale !== '' && (
            <span className="muted small wrap" data-testid="improvement-change-rationale">
              {T.improvementChangeRationale}：{change.rationale}
            </span>
          )}
        </div>
      )}

      {comparison === undefined ? null : <Comparison comparison={comparison} />}

      <span className="small wrap" data-testid="improvement-meta-cost">
        {T.improvementMetaCost}：{costText(view)}
        {totalTokens(view) === undefined ? '' : ` · ${T.improvementTokens(tokensText(totalTokens(view)!))}`}
      </span>
      {Object.keys(view.tokens).length > 0 && (
        <ul className="file-list" data-testid="improvement-phases" aria-label={T.improvementPhases}>
          {Object.entries(view.tokens).map(([phase, tokens]) => (
            <li key={phase} className="small" data-phase={phase}>
              {improvementPhaseText(phase)}：{T.improvementTokens(tokensText(tokens as number | 'unknown'))}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
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
            {decision.reason === 'instance-literal' && (
              <div className="stack">
                <span className="small">
                  <span className="badge warn" data-testid="improvement-refused">{T.improvementRefused}</span>
                </span>
                <span className="muted small">{T.improvementLiteralsTitle}</span>
                <ul className="file-list" data-testid="improvement-literals">
                  {(decision.instanceLiterals ?? []).map((hit, index) => (
                    <li key={index} className="small wrap" data-testid="improvement-literal">
                      {T.improvementLiteral(hit.value, hit.path, hit.source)}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {decision.outcome === 'awaiting-approval' && decision.reason === 'no-similar-cases' && (
              <div className="stack" data-testid="improvement-original-only">
                <strong className="small">{T.approvalOriginalOnlyTitle}</strong>
                <span className="small wrap">{T.approvalOriginalOnlyBody}</span>
              </div>
            )}
            {verdict?.similarPassRate !== undefined && (
              <span className="small" data-testid="improvement-similar-rate">
                {T.improvementSimilarRate(percentText(verdict.similarPassRate.candidate), percentText(verdict.similarPassRate.baseline))}
              </span>
            )}
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
  const meta = view.kind === 'meta'
  return (
    <li className="item column candidate" data-testid="improvement-job" data-job={view.id} data-status={view.status} data-kind={meta ? 'meta' : 'capability'}>
      <button type="button" className="item-button" onClick={() => void store.toggleImprovement(view.id)} aria-expanded={detail !== undefined}>
        <span className="item-title ellipsis" data-testid="improvement-trigger">
          {meta && (
            <span className="badge accent" data-testid="improvement-meta-badge">
              {T.improvementMetaBadge}
            </span>
          )}{' '}
          {improvementTriggerText(view.trigger)}{meta ? null : ` · ${T.improvementItems(view.itemCount)}`}
        </span>
        <span className={`badge ${statusClass(view.status)}`} data-testid="improvement-status">
          {improvementStatusText(view.status)}
        </span>
      </button>
      <span className="muted small wrap">
        <span data-testid="improvement-improver" data-version={view.improverVersion ?? 'v0'} data-scope={view.improverScope ?? 'project'}>
          {T.improverOfJob(improverVersionText(view.improverVersion))}
          {view.improverScope === 'user' ? ` · ${T.improverScopeUser}` : ''}
        </span>{' '}
        · {formatTime(view.createdAt)} ·{' '}
        <span data-testid="improvement-cost">
          {costText(view)}
          {tokens === undefined ? '' : ` · ${T.improvementTokens(tokensText(tokens))}`}
        </span>
      </span>
      {view.meta?.childVersion !== undefined && (
        <span className="small wrap" data-testid="improvement-meta-child">
          {T.improvementMetaChild(improverVersionText(view.meta.childVersion))}
          {view.meta.outcome === undefined ? '' : `：${view.meta.outcome === 'adopt' ? T.improvementDecisionAdopt : T.improvementDecisionReject}`}
          {view.meta.reason === undefined ? '' : `（${improverReasonText(view.meta.reason)}）`}
        </span>
      )}
      {view.detail !== undefined && view.detail !== '' && (
        <span className="small wrap" data-testid="improvement-detail-text">
          {view.detail}
        </span>
      )}
      {detail !== undefined && (meta ? <MetaDetail detail={detail} /> : <Detail detail={detail} />)}
      {IMPROVEMENT_CANCELLABLE.includes(view.status) && (
        <button type="button" className="link small" onClick={() => void store.cancelImprovement(view.id)} data-testid="improvement-cancel">
          {T.improvementCancel}
        </button>
      )}
    </li>
  )
}

function Rollback(): JSX.Element {
  const store = useAppStore()
  const usedBy = useAppState().improver?.usedBy ?? []
  const [confirming, setConfirming] = useState(false)
  const [reason, setReason] = useState('')
  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => {
          setConfirming(true)
          // The projects that ran on the improver change with every job of any project: read them afresh.
          void store.refreshImprover()
        }}
        data-testid="improver-rollback"
      >
        {T.improverRollback}
      </button>
    )
  }
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    void store.rollbackImprover(reason).then(() => {
      setConfirming(false)
      setReason('')
    })
  }
  return (
    <form className="stack" onSubmit={submit}>
      <p className="small wrap">{T.improverRollbackAffectsAll}</p>
      <div className="stack" data-testid="improver-rollback-projects">
        <span className="muted small">{T.improverRollbackProjects}</span>
        {usedBy.length === 0 ? (
          <span className="muted small">{T.improverRollbackNoProjects}</span>
        ) : (
          usedBy.map(project => (
            <span key={project.root} className="small wrap" data-testid="improver-rollback-project" title={project.root}>
              {project.name} · {formatTime(project.lastJobAt)}
            </span>
          ))
        )}
      </div>
      <input value={reason} onChange={event => setReason(event.target.value)} placeholder={T.improverRollbackReason} aria-label={T.improverRollbackReason} data-testid="improver-rollback-reason" />
      <div className="row">
        <button type="submit" className="danger" data-testid="improver-rollback-confirm">
          {T.improverRollbackConfirm}
        </button>
        <button type="button" className="ghost" onClick={() => setConfirming(false)}>
          {T.cancel}
        </button>
      </div>
    </form>
  )
}

/** The improver in force, its history, rollback and the meta-improvement button. */
function ImproverSection(): JSX.Element | null {
  const state = useAppState()
  const store = useAppStore()
  const listing = state.improver
  const meta = state.improvements?.meta
  if (listing === undefined) return null
  const { current } = listing
  return (
    <div className="stack" data-testid="improver-section">
      <span className="panel-label">{T.improverTitle}</span>
      <span className="muted small wrap" data-testid="improver-shared-note">{T.improverSharedNote}</span>
      {current.problem !== undefined && (
        <div className="error-banner small wrap" role="alert" data-testid="improver-problem">
          <strong>{T.improverProblem}：</strong>
          {current.problem}
        </div>
      )}
      <div className="stack" data-testid="improver-current" data-version={current.version} data-revision={current.revision}>
        <span className="muted small">{T.improverCurrent}</span>
        <strong className="wrap" title={current.version} data-testid="improver-version">
          {improverVersionText(current.version)}
        </strong>
        {current.revision > 0 && (
          <span className="muted small wrap">
            {T.improverRevision(current.revision)}
            {current.trigger !== undefined ? ` · ${triggerText(current.trigger)}` : ''}
            {current.since !== undefined ? ` · ${formatTime(current.since)}` : ''}
            {current.jobId !== undefined ? ` · ${T.improverAdopter} ${current.jobId}` : ''}
          </span>
        )}
        <span className="muted small">{T.improverNewJobs}</span>
        {current.revision > 0 && current.version !== 'v0' && <Rollback />}
      </div>
      {meta !== undefined && (
        <div className="stack">
          <span className="small" data-testid="improvement-meta-status">
            {T.improvementMetaStatus(meta.enabled, meta.pending, meta.everyJobs)}
          </span>
          <span className="muted small wrap" data-testid="improvement-meta-budget">
            {T.improvementMetaBudget(tokensText(meta.budget.usedTokens), tokensText(meta.budget.maxTokens), meta.budget.windowDays)}
          </span>
        </div>
      )}
      <button type="button" disabled={state.improvements?.activeJobId !== undefined} onClick={() => void store.runMetaImprovement()} data-testid="improvement-run-meta">
        {T.improvementRunMeta}
      </button>
      <span className="panel-label">{T.improverHistory}</span>
      {listing.history.length === 0 ? (
        <p className="muted small">{T.improverNoHistory}</p>
      ) : (
        <ol className="item-list" data-testid="improver-history">
          {[...listing.history].reverse().map(revision => (
            <li key={revision.revision} className="item column" data-testid="improver-revision" data-type={revision.type} data-version={revision.version}>
              <span className="small wrap">
                #{revision.revision} {revision.type === 'adopt' ? T.improverAdopt : T.improverRolledBack} → {improverVersionText(revision.version)}
              </span>
              <span className="muted small wrap">
                {triggerText(revision.trigger)} · {formatTime(revision.committedAt)}
                {revision.reason !== undefined ? ` · ${revision.reason}` : ''}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
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
      <ImproverSection />
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
