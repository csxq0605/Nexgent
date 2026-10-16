import { useEffect } from 'react'
import type { HandbookOp } from '@nexgent/kernel'
import type { HandbookEntryView, LearningStatus } from '@nexgent/sdk'
import { useAppState, useAppStore } from '../hooks.js'
import { L, dayText, rateText, usdText } from '../strings.js'
import { useUi } from '../ui.js'

/** Kernel `HANDBOOK_ACTIVATE_HELPFUL` (the renderer imports no kernel values; a test keeps them equal). */
export const ACTIVATE_HELPFUL = 2

/**
 * 能力 → 经验 (rework D2, ui-redesign-research §4.2): what waits for the
 * user, the learning switch and spend, then the handbook entries in use, on
 * trial and stopped, each opening its history.
 */
export function LearnedPanel(): JSX.Element {
  const state = useAppState()
  const store = useAppStore()
  // The page is the place people look after a task: read the latest.
  useEffect(() => {
    void store.refreshLearning()
  }, [])
  const entries = state.handbook?.entries ?? []
  const active = entries.filter(entry => entry.status === 'active')
  const trial = entries.filter(entry => entry.status === 'trial')
  const retired = entries.filter(entry => entry.status === 'retired')
  return (
    <div className="learned" data-testid="learned-panel">
      <Decide />
      {state.learning !== undefined && <LearningCard learning={state.learning} />}
      {entries.length === 0 ? (
        <p className="muted wrap" data-testid="handbook-empty">
          {L.empty}
        </p>
      ) : (
        <>
          <EntryGroup title={L.activeTitle} entries={active} testId="handbook-active" />
          <EntryGroup title={L.trialTitle} entries={trial} testId="handbook-trial" />
          {retired.length > 0 && (
            <details className="entry-group folded" data-testid="handbook-retired">
              <summary className="group-title">{L.retiredTitle(retired.length)}</summary>
              <ul className="entries">
                {retired.map(entry => (
                  <EntryRow key={entry.id} entry={entry} />
                ))}
              </ul>
            </details>
          )}
        </>
      )}
      <p className="muted small wrap foot-note">{L.olderHistory}</p>
    </div>
  )
}

/** The page's one-line status (the lead under the title). */
export function learnedLead(entries: readonly HandbookEntryView[] | undefined): string {
  const list = entries ?? []
  const active = list.filter(entry => entry.status === 'active').length
  const trial = list.filter(entry => entry.status === 'trial').length
  if (active + trial === 0) return L.leadNone
  const latest = list.filter(entry => entry.status !== 'retired').map(entry => entry.createdAt).sort().at(-1)
  return L.lead(active, trial, latest === undefined ? undefined : dayText(latest))
}

/** 等你决定: only when a new practice waits for the user's yes. */
function Decide(): JSX.Element | null {
  const state = useAppState()
  const store = useAppStore()
  const waiting = state.capabilities?.candidates.filter(candidate => candidate.status === 'awaiting-approval') ?? []
  if (waiting.length === 0) return null
  return (
    <section className="decide" data-testid="learned-decide">
      <h3 className="group-title">
        <span className="dot warn" aria-hidden="true" />
        {L.decideTitle}
      </h3>
      <ul className="entries">
        {waiting.map(candidate => (
          <li key={candidate.id} className="entry">
            <div className="grow">
              <div className="entry-text">{L.decideRow(candidate.components.map(component => component.name).join('、'))}</div>
              <div className="muted small">{L.decideWhy}</div>
            </div>
            <button type="button" className="ghost" onClick={() => void store.askPluginApproval(candidate.id)} data-testid="learned-decide-open">
              {L.decideOpen}
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** The switch, the spend against the budget and what self-evaluation did. */
function LearningCard({ learning }: { readonly learning: LearningStatus }): JSX.Element {
  const store = useAppStore()
  const ui = useUi()
  const { budget } = learning
  const share = budget.maxUsd > 0 ? Math.min(1, budget.spentUsd / budget.maxUsd) : 0
  const phases = budget.phases.filter(phase => phase.usd > 0 || phase.requestCount > 0)
  const { reliability } = learning
  return (
    <section className="learning-card" data-testid="learning-card">
      <div className="setting-line">
        <div className="grow">
          <div className="setting-name">{L.learningSwitch}</div>
          <div className="muted small">{learning.config.enabled ? L.learningSwitchHelp : L.learningOff}</div>
        </div>
        <Switch checked={learning.config.enabled} onChange={enabled => void store.saveLearning({ enabled })} label={L.learningSwitch} testId="learning-toggle" />
      </div>
      {learning.config.enabled && !learning.noticeAcknowledged && (
        <div className="setting-line">
          <div className="grow muted small">{L.learningWaiting}</div>
          <button type="button" className="primary" onClick={() => void store.acknowledgeLearning()} data-testid="learning-acknowledge">
            {L.learningAcknowledge}
          </button>
        </div>
      )}
      <div className="spend" data-testid="learning-spend">
        <div className="row between">
          <span>
            {L.spend(usdText(budget.spentUsd), usdText(budget.maxUsd), budget.windowDays)}
            {budget.estimated ? L.spendEstimated : ''}
          </span>
          <span className="muted small">{L.spendLeft(usdText(budget.remainingUsd))}</span>
        </div>
        <div className="meter" role="meter" aria-valuemin={0} aria-valuemax={budget.maxUsd} aria-valuenow={budget.spentUsd} aria-label={L.learningBudget}>
          <span style={{ width: `${(share * 100).toFixed(1)}%` }} />
        </div>
        {phases.length > 0 && (
          <div className="muted small" data-testid="learning-phases">
            {phases.map(phase => `${L.phases[phase.phase] ?? phase.phase} ${usdText(phase.usd)}`).join(' · ')}
          </div>
        )}
      </div>
      <div className="muted small wrap" data-testid="learning-self-eval">
        {L.selfEvaluations(learning.selfEvaluations)}
        {'。'}
        {reliability.status === 'insufficient' ? L.reliability.insufficient(reliability.sampled) : reliability.status === 'reliable' ? L.reliability.reliable(rateText(reliability.rate)) : L.reliability.unreliable(rateText(reliability.rate))}
      </div>
      <button type="button" className="link small" onClick={() => ui.openSettings()} data-testid="learning-adjust">
        {L.learningAdjust}
      </button>
    </section>
  )
}

function EntryGroup({ title, entries, testId }: { readonly title: string; readonly entries: readonly HandbookEntryView[]; readonly testId: string }): JSX.Element | null {
  if (entries.length === 0) return null
  return (
    <section className="entry-group" data-testid={testId}>
      <h3 className="group-title">
        {title}
        <span className="faint"> {entries.length}</span>
      </h3>
      <ul className="entries">
        {entries.map(entry => (
          <EntryRow key={entry.id} entry={entry} />
        ))}
      </ul>
    </section>
  )
}

function entryMeta(entry: HandbookEntryView): string {
  const parts = [entry.scope === 'user' ? L.scopeUser : L.scopeProject]
  if (entry.helpful > 0) parts.push(L.helpful(entry.helpful))
  if (entry.harmful > 0) parts.push(L.harmful(entry.harmful))
  if (entry.status === 'trial') parts.push(L.untilActive(Math.max(1, ACTIVATE_HELPFUL - entry.helpful, entry.harmful - entry.helpful + 1)))
  parts.push(L.sinceDate(dayText(entry.createdAt)))
  return parts.join(' · ')
}

function EntryRow({ entry }: { readonly entry: HandbookEntryView }): JSX.Element {
  const state = useAppState()
  const store = useAppStore()
  const detail = state.handbookDetail?.entry.id === entry.id ? state.handbookDetail : undefined
  const dot = entry.status === 'active' ? 'ok' : entry.status === 'trial' ? 'run' : ''
  return (
    <li className="entry" data-testid="handbook-entry" data-entry={entry.id} data-status={entry.status}>
      <span className={`dot ${dot}`} aria-hidden="true" />
      <div className="grow">
        <button type="button" className="entry-button" onClick={() => void store.toggleHandbookEntry(entry.id)} aria-expanded={detail !== undefined} data-testid="handbook-entry-open">
          <span className="entry-text">{entry.text}</span>
        </button>
        <div className="muted small">{entryMeta(entry)}</div>
        {detail !== undefined && <EntryHistory keywords={detail.entry.keywords} sources={detail.entry.sources.length} ops={detail.ops} />}
      </div>
      {entry.status === 'retired' ? (
        <button type="button" className="link small" onClick={() => void store.setHandbookStatus(entry.id, 'active')} data-testid="handbook-restore">
          {L.restore}
        </button>
      ) : (
        <button type="button" className="link small" onClick={() => void store.setHandbookStatus(entry.id, 'retired')} data-testid="handbook-stop">
          {L.stop}
        </button>
      )}
    </li>
  )
}

function opText(op: HandbookOp): string {
  return op.op === 'status' ? L.op[op.status] ?? op.status : L.op[op.op] ?? op.op
}

function EntryHistory({ keywords, sources, ops }: { readonly keywords: readonly string[]; readonly sources: number; readonly ops: readonly HandbookOp[] }): JSX.Element {
  return (
    <div className="entry-detail" data-testid="handbook-detail">
      {keywords.length > 0 && (
        <div className="small">
          <span className="muted">{L.keywords}：</span>
          {keywords.join('、')}
        </div>
      )}
      {sources > 0 && <div className="muted small">{L.sources(sources)}</div>}
      <div className="small muted">{L.historyTitle}</div>
      <ol className="history">
        {ops.map(op => (
          <li key={`${op.seq}:${op.at}`} data-testid="handbook-op" data-op={op.op}>
            <span className="muted">{dayText(op.at)}</span> {opText(op)}
            {op.actor === 'user' ? `（${L.byUser}）` : ''}
            {op.reason !== undefined && <span className="muted">：{op.reason}</span>}
          </li>
        ))}
      </ol>
    </div>
  )
}

/** A toggle switch on a checkbox, so keyboard, screen readers and tests treat it as one. */
export function Switch({ checked, onChange, label, testId, disabled }: { readonly checked: boolean; readonly onChange: (checked: boolean) => void; readonly label: string; readonly testId: string; readonly disabled?: boolean }): JSX.Element {
  return (
    <label className="switch">
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} aria-label={label} onChange={event => onChange(event.target.checked)} data-testid={testId} />
      <span className="switch-track" aria-hidden="true" />
    </label>
  )
}
