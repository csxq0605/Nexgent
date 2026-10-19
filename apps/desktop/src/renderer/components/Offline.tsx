import { useEffect, useState } from 'react'
import type { OfflineCandidate } from '@nexgent/kernel'
import type { OfflineListing, OfflineRunView } from '@nexgent/sdk'
import { useAppState, useAppStore } from '../hooks.js'
import { O } from '../offline-strings.js'
import { dayText, T } from '../strings.js'

/**
 * 能力 → 离线改进 (ADR 0026, ADR 0027): what is in force now (and stopping
 * it), the practice set, the latest run with the one action it waits for
 * (approve its cap, stop or continue it, apply or decline what it found),
 * and the older runs. Every button acts on the user's word only.
 */
export function OfflinePanel(): JSX.Element {
  const state = useAppState()
  const store = useAppStore()
  useEffect(() => {
    void store.refreshOffline()
  }, [])
  const listing = state.offline
  if (listing === undefined) return <p className="muted small">{T.loading}</p>
  const [latest, ...older] = listing.runs
  return (
    <div className="learned offline" data-testid="offline-panel">
      <Current listing={listing} />
      <Practice listing={listing} latest={latest} />
      <section className="learning-card" data-testid="offline-latest">
        <h3 className="group-title">{O.runTitle}</h3>
        {latest === undefined ? <p className="muted small">{O.noRun}</p> : <Run run={latest} decidedAbove={latest === offlineWaiting(listing)} />}
      </section>
      {older.length > 0 && (
        <details className="entry-group folded" data-testid="offline-history">
          <summary className="group-title">{O.historyTitle(older.length)}</summary>
          <ul className="entries">
            {older.map(run => (
              <li key={run.runId} className="entry" data-testid="offline-history-run" data-run={run.runId}>
                <span className={`dot ${run.decision?.outcome === 'applied' ? 'ok' : run.live ? 'run' : ''}`} aria-hidden="true" />
                <div className="grow small">{O.historyRow(dayText(run.createdAt), statusText(run), run.spentUsd)}</div>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

/** 等你看一眼: the latest run found a better version and waits for apply / decline. */
export function offlineWaiting(listing: OfflineListing | undefined): OfflineRunView | undefined {
  const latest = listing?.runs[0]
  return latest !== undefined && latest.status === 'awaiting-user' && latest.result?.verdict === 'recommended' && latest.decision === undefined ? latest : undefined
}

export function OfflineDecision({ run }: { readonly run: OfflineRunView }): JSX.Element {
  return <Result run={run} />
}

function statusText(run: OfflineRunView): string {
  if (run.decision !== undefined) return run.decision.outcome === 'applied' ? O.statusApplied : O.statusDeclined
  if (run.live) return O.live
  return O.status[run.status]
}

/** What new tasks use now: the applied version or the defaults, in words, with a way back. */
function Current({ listing }: { readonly listing: OfflineListing }): JSX.Element {
  const store = useAppStore()
  const [confirming, setConfirming] = useState(false)
  const applied = listing.applied
  const candidate = applied?.candidate ?? listing.defaults
  return (
    <section className="learning-card" data-testid="offline-current" data-applied={applied === undefined ? 'no' : 'yes'}>
      <h3 className="group-title">
        <span className={`dot ${applied === undefined ? '' : 'ok'}`} aria-hidden="true" />
        {O.currentTitle}
      </h3>
      <p className="small wrap">{applied === undefined ? O.currentDefault : O.currentApplied(dayText(applied.appliedAt))}</p>
      <Candidate candidate={candidate} />
      {applied !== undefined && (confirming ? (
        <div className="setting-line">
          <div className="grow muted small wrap">{O.revertHelp}</div>
          <button type="button" className="ghost" onClick={() => setConfirming(false)}>{T.cancel}</button>
          <button type="button" className="danger" onClick={() => void store.revertOffline().then(() => setConfirming(false))} data-testid="offline-revert-confirm">
            {O.revertConfirm}
          </button>
        </div>
      ) : (
        <button type="button" className="ghost" onClick={() => setConfirming(true)} data-testid="offline-revert">
          {O.revert}
        </button>
      ))}
    </section>
  )
}

/** One version's two parts, as text. */
function Candidate({ candidate }: { readonly candidate: OfflineCandidate }): JSX.Element {
  return (
    <dl className="offline-parts">
      <dt className="muted small">{O.guidanceLabel}</dt>
      <dd className="small offline-guidance" data-testid="offline-guidance">{candidate.executionGuidance.trim() === '' ? O.guidanceNone : candidate.executionGuidance}</dd>
      <dt className="muted small">{O.retrievalLabel}</dt>
      <dd className="small wrap" data-testid="offline-retrieval">{O.retrieval(candidate.retrieval)}</dd>
    </dl>
  )
}

/** The practice set and the plan button (planning is free; a run waits for approval). */
function Practice({ listing, latest }: { readonly listing: OfflineListing; readonly latest: OfflineRunView | undefined }): JSX.Element {
  const store = useAppStore()
  const { practice } = listing
  const enough = practice.train > 0 && practice.selection > 0 && practice.holdout > 0
  // One run at a time: a plan waiting for approval, or a run not yet finished, comes first.
  const busy = latest !== undefined && latest.decision === undefined && (latest.status === 'awaiting-approval' || latest.status === 'running' || latest.live || latest.resumable)
  return (
    <section className="learning-card" data-testid="offline-practice">
      <h3 className="group-title">{O.practiceTitle}</h3>
      <p className="small">{O.practice(practice)}</p>
      <p className="muted small wrap">{enough ? O.practiceHelp : O.practiceShort}</p>
      {!busy && (
        <div className="setting-line">
          <div className="grow muted small wrap">{O.planHelp}</div>
          <button type="button" disabled={!enough} onClick={() => void store.planOffline()} data-testid="offline-plan">
            {O.plan}
          </button>
        </div>
      )}
    </section>
  )
}

/** The latest run and the one thing it waits for. */
function Run({ run, decidedAbove = false }: { readonly run: OfflineRunView; readonly decidedAbove?: boolean }): JSX.Element {
  const store = useAppStore()
  const caseCount = run.cases.minibatch + run.cases.selection + run.cases.holdout + run.cases.guard
  const share = run.capUsd > 0 ? Math.min(1, run.spentUsd / run.capUsd) : 0
  return (
    <div className="offline-run" data-testid="offline-run" data-run={run.runId} data-status={run.status} data-live={run.live ? 'yes' : 'no'}>
      {run.status === 'awaiting-approval' && run.approvedAt === undefined && (
        <>
          <p className="small wrap">{O.planned(run.maxIterations, caseCount)}</p>
          <p className="small wrap" data-testid="offline-cost">{O.plannedCost(run.estimateUsd, run.capUsd)}</p>
          <button type="button" className="primary" onClick={() => void store.approveOffline(run.runId, run.capUsd)} data-testid="offline-approve">
            {O.approve(run.capUsd)}
          </button>
        </>
      )}
      {run.status === 'awaiting-approval' && run.approvedAt !== undefined && !run.resumable && <p className="small">{O.approved}</p>}
      {(run.live || run.status === 'running' || run.status === 'stopped' || (run.status === 'awaiting-approval' && run.resumable)) && (
        <>
          {run.live && <p className="small">{O.running(run.iteration, run.maxIterations)}</p>}
          {!run.live && run.status === 'running' && <p className="small wrap">{O.interrupted}</p>}
          {!run.live && run.status === 'stopped' && run.stop !== undefined && <p className="small wrap" data-testid="offline-stop-reason">{O.stopped(run.stop.reason, run.stop.detail)}</p>}
          <div className="spend">
            <div className="row between">
              <span className="small">{O.spent(run.spentUsd, run.capUsd)}</span>
              <span className="muted small">{O.versions(run.versions)}</span>
            </div>
            <div className="meter" role="meter" aria-valuemin={0} aria-valuemax={run.capUsd} aria-valuenow={run.spentUsd} aria-label={O.spent(run.spentUsd, run.capUsd)}>
              <span style={{ width: `${(share * 100).toFixed(1)}%` }} />
            </div>
          </div>
          {run.live && (
            <div className="setting-line">
              <div className="grow muted small wrap">{O.stopHelp}</div>
              <button type="button" className="ghost" onClick={() => void store.stopOffline(run.runId)} data-testid="offline-stop">{O.stop}</button>
            </div>
          )}
          {run.resumable && (
            <button type="button" onClick={() => void store.resumeOffline(run.runId)} data-testid="offline-resume">{O.resume}</button>
          )}
        </>
      )}
      {run.status === 'awaiting-user' && run.result !== undefined && !decidedAbove && <Result run={run} />}
    </div>
  )
}

/** A finished run: what it found, side by side with what was in force, and the user's answer. */
function Result({ run }: { readonly run: OfflineRunView }): JSX.Element {
  const store = useAppStore()
  const result = run.result!
  const holdout = result.holdout
  return (
    <div className="offline-result" data-testid="offline-result" data-verdict={result.verdict}>
      <p className="small wrap">{O.spent(run.spentUsd, run.capUsd)}</p>
      {result.verdict === 'recommended' && run.best !== undefined && holdout !== undefined ? (
        <>
          <p className="small wrap" data-testid="offline-verdict">
            {O.recommended(run.cases.holdout, holdout.meanDiff, holdout.ciLow, holdout.ciHigh)}
            {holdout.guardDiff !== undefined ? O.guardOk : ''}
          </p>
          <div className="offline-compare">
            <div className="offline-side">
              <span className="panel-label">{O.before}</span>
              <Candidate candidate={run.start} />
            </div>
            <div className="offline-side">
              <span className="panel-label">{O.after}</span>
              <Candidate candidate={run.best} />
            </div>
          </div>
          {run.decision === undefined ? (
            <div className="setting-line">
              <div className="grow muted small wrap">{O.applyHelp}</div>
              <button type="button" className="ghost" onClick={() => void store.decideOffline(run.runId, 'decline')} data-testid="offline-decline">{O.decline}</button>
              <button type="button" className="primary" onClick={() => void store.decideOffline(run.runId, 'apply')} data-testid="offline-apply">{O.apply}</button>
            </div>
          ) : (
            <p className="muted small" data-testid="offline-decision">{run.decision.outcome === 'applied' ? O.applied(dayText(run.decision.at)) : O.declined(dayText(run.decision.at))}</p>
          )}
        </>
      ) : (
        <p className="small wrap" data-testid="offline-verdict">{O.noBetter}</p>
      )}
    </div>
  )
}
