import { useEffect, useState } from 'react'
import type { HandbookOp } from '@nexgent/kernel'
import type { HandbookEntryView, LearningStatus } from '@nexgent/sdk'
import { useAppState, useAppStore } from '../hooks.js'
import { L, agoText, dayText, organizationText, rateText, usdText } from '../strings.js'
import { useUi } from '../ui.js'

/** Kernel `HANDBOOK_ACTIVATE_HELPFUL` (the renderer imports no kernel values; a test keeps them equal). */
export const ACTIVATE_HELPFUL = 2

/**
 * 能力 (ADR 0028): what Nexgent uses now and what it changed, in a few lines;
 * the machinery (trial entries, spend, versions, runs) sits in the folded
 * record. These are the page's pieces.
 */
function useEntries() {
  const all = useAppState().handbook?.entries ?? []
  const live = all.filter(entry => entry.status !== 'retired')
  return {
    all,
    rules: live.filter(entry => entry.kind === 'rule' && entry.pending !== true),
    pendingRules: live.filter(entry => entry.kind === 'rule' && entry.pending === true),
    active: live.filter(entry => entry.kind !== 'rule' && entry.status === 'active'),
    trial: live.filter(entry => entry.kind !== 'rule' && entry.status === 'trial'),
    retired: all.filter(entry => entry.status === 'retired'),
  }
}

/** Read the latest learning and handbook when the page opens (people look here after a task). */
export function useLearningRefresh(): void {
  const store = useAppStore()
  useEffect(() => {
    void store.refreshLearning()
  }, [])
}

/** Project rules in force, one line each. */
export function RulesList(): JSX.Element | null {
  const { rules } = useEntries()
  if (rules.length === 0) return null
  return (
    <section className="entry-group" data-testid="handbook-rules">
      <h3 className="group-title">
        {L.rulesTitle}
        <span className="faint"> {rules.length}</span>
      </h3>
      <ul className="entries">
        {rules.map(entry => (
          <RuleRow key={entry.id} entry={entry} />
        ))}
      </ul>
    </section>
  )
}

/** Practices in use, one line each; the history opens on click. */
export function InUseList(): JSX.Element {
  const { all, active } = useEntries()
  if (all.length === 0)
    return (
      <p className="muted wrap" data-testid="handbook-empty">
        {L.empty}
      </p>
    )
  if (active.length === 0) return <p className="muted small wrap" data-testid="handbook-none-active">{L.noneActive}</p>
  return <EntryGroup title={L.activeTitle} entries={active} testId="handbook-active" />
}

/** For the record: practices on trial and stopped ones. */
export function MoreEntries(): JSX.Element | null {
  const { trial, retired } = useEntries()
  if (trial.length + retired.length === 0) return null
  return (
    <>
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
  )
}

/** Rules the user still has to confirm (shown under 等你看一眼). */
export function PendingRules(): JSX.Element | null {
  const { pendingRules } = useEntries()
  if (pendingRules.length === 0) return null
  return (
    <ul className="entries" data-testid="handbook-pending-rules">
      {pendingRules.map(entry => (
        <RuleRow key={entry.id} entry={entry} />
      ))}
    </ul>
  )
}

/** Whether anything under 等你看一眼 waits. */
export function hasPendingRules(entries: readonly HandbookEntryView[] | undefined): boolean {
  return (entries ?? []).some(entry => entry.kind === 'rule' && entry.status !== 'retired' && entry.pending === true)
}

/** The page's one-line status (the lead under the title): what is in use, the latest change and, with evidence, the effect. */
export function learnedLead(entries: readonly HandbookEntryView[] | undefined): string {
  const list = (entries ?? []).filter(entry => entry.status !== 'retired' && entry.pending !== true)
  const rules = list.filter(entry => entry.kind === 'rule').length
  const active = list.filter(entry => entry.kind !== 'rule' && entry.status === 'active').length
  const trial = list.filter(entry => entry.kind !== 'rule' && entry.status === 'trial').length
  if (rules + active + trial === 0) return L.leadNone
  const latest = list.map(entry => entry.updatedAt ?? entry.createdAt).sort().at(-1)
  return L.lead(active, trial, rules, latest === undefined ? undefined : dayText(latest)) + effectText(list)
}

/**
 * New direction step 3: one sentence on the class of similar tasks with the
 * most runs: which organization it uses and how it compares with working
 * alone (or that the comparison is still going on).
 */
export function organizationLead(classes: LearningStatus['organizations']): string {
  const top = classes?.[0]
  if (top === undefined) return ''
  const kind = `“${top.keywords.slice(0, 3).join('、')}”`
  const cost = top.costChange === undefined ? '' : L.orgCost(Math.round(top.costChange * 100))
  const gap = Math.round(Math.abs((top.teamGood ?? 0) - (top.soloGood ?? 0)) * 100)
  if (top.verdict === 'team-better') return L.orgTeamBetter(kind, organizationText(top.organization ?? 'custom'), gap, cost)
  if (top.verdict === 'solo-better') return L.orgSoloBetter(kind, gap, top.costChange === undefined ? '' : L.orgCost(Math.round((1 / (1 + top.costChange) - 1) * 100)))
  return L.orgComparing(kind, top.soloRuns + top.teamRuns)
}

/** Outcome gap over every entry with both arms, weighted by how often it was given. */
function effectText(entries: readonly HandbookEntryView[]): string {
  let weight = 0
  let gap = 0
  for (const entry of entries) {
    const e = entry.evidence
    if (e?.shownMean === undefined || e.heldBackMean === undefined || e.shown === 0) continue
    weight += e.shown
    gap += e.shown * (e.shownMean - e.heldBackMean)
  }
  return weight === 0 ? '' : L.effect(Math.round((gap / weight) * 100))
}

/** 等你决定: only when a new practice waits for the user's yes. */
export function Decide(): JSX.Element | null {
  const state = useAppState()
  const store = useAppStore()
  const waiting = state.capabilities?.candidates.filter(candidate => candidate.status === 'awaiting-approval') ?? []
  if (waiting.length === 0) return null
  return (
    <section data-testid="learned-decide">
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
export function LearningCard({ learning }: { readonly learning: LearningStatus }): JSX.Element {
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
        <Switch checked={learning.config.enabled} onChange={enabled => store.saveLearning({ enabled })} label={L.learningSwitch} testId="learning-toggle" />
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

/** Redesign UI 1: how often the entry was given and held back, the outcome gap, and its last use. */
function evidenceText(entry: HandbookEntryView): string {
  const e = entry.evidence
  const parts = [L.trials(e?.shown ?? 0, e?.heldBack ?? 0)]
  if (e?.shownMean !== undefined && e.heldBackMean !== undefined) parts.push(L.trialGap(Math.round((e.shownMean - e.heldBackMean) * 100)))
  return `${parts.join('，')}。${L.lastUsed(e?.lastUsedAt === undefined ? undefined : agoText(e.lastUsedAt))}`
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
        {detail !== undefined && <div className="muted small" data-testid="handbook-evidence">{evidenceText(entry)}</div>}
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

/** A project rule: its text and range; a pending one asks the user, one in force can be stopped. */
function RuleRow({ entry }: { readonly entry: HandbookEntryView }): JSX.Element {
  const store = useAppStore()
  return (
    <li className="entry" data-testid="handbook-rule" data-entry={entry.id} data-pending={entry.pending === true ? 'true' : 'false'}>
      <span className={`dot ${entry.pending === true ? 'run' : 'ok'}`} aria-hidden="true" />
      <div className="grow">
        <span className="entry-text">{entry.text}</span>
        <div className="muted small">{L.ruleMeta(entry.appliesTo, dayText(entry.createdAt))}</div>
      </div>
      {entry.pending === true ? (
        <span className="row">
          <button type="button" className="link small" onClick={() => void store.setHandbookStatus(entry.id, 'active')} data-testid="rule-confirm">
            {L.confirmRule}
          </button>
          <button type="button" className="link small" onClick={() => void store.setHandbookStatus(entry.id, 'retired')} data-testid="rule-reject">
            {L.rejectRule}
          </button>
        </span>
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

/**
 * A toggle switch on a checkbox, so keyboard, screen readers and tests treat it as one.
 * It shows the new state at once while `onChange`'s save runs, then follows `checked`.
 */
export function Switch({ checked, onChange, label, testId, disabled }: { readonly checked: boolean; readonly onChange: (checked: boolean) => unknown; readonly label: string; readonly testId: string; readonly disabled?: boolean }): JSX.Element {
  const [pending, setPending] = useState<boolean | undefined>(undefined)
  return (
    <label className="switch">
      <input
        type="checkbox"
        role="switch"
        checked={pending ?? checked}
        disabled={disabled}
        aria-label={label}
        onChange={event => {
          const next = event.target.checked
          setPending(next)
          void Promise.resolve(onChange(next)).finally(() => setPending(undefined))
        }}
        data-testid={testId}
      />
      <span className="switch-track" aria-hidden="true" />
    </label>
  )
}
