import { useState } from 'react'
import { useAppState, useAppStore } from '../hooks.js'
import { T, capAmountText } from '../strings.js'
import { latestPlan, type PlanItem } from '../timeline.js'
import { useUi } from '../ui.js'

/**
 * Rework D3: the plan the model keeps with `todo_write`, above the composer
 * while it is the latest turn's and still has open items (or the turn runs).
 */
export function PlanPanel(): JSX.Element | null {
  const state = useAppState()
  const plan = latestPlan(state.timeline)
  const [open, setOpen] = useState(true)
  if (plan === undefined) return null
  const lastTurn = state.timeline.reduce((max, entry) => Math.max(max, entry.turn ?? 0), 0)
  const done = plan.items.filter(item => item.status === 'done').length
  if (plan.turn !== lastTurn || (!state.running && done === plan.items.length)) return null
  return (
    <aside className="plan-panel" data-testid="plan-panel" data-open={open ? 'true' : 'false'}>
      <button type="button" className="plan-head" aria-expanded={open} onClick={() => setOpen(!open)} data-testid="plan-toggle">
        <span className="setting-name">{T.planTitle}</span>
        <span className="muted small">{T.planProgress(done, plan.items.length)}</span>
      </button>
      {open && (
        <ol className="plan-items">
          {plan.items.map((item, index) => (
            <li key={index} className={`plan-item plan-${item.status}`} data-status={item.status}>
              <span className="plan-mark" aria-label={statusLabel(item)} />
              <span className="wrap">{item.text}</span>
            </li>
          ))}
        </ol>
      )}
    </aside>
  )
}

function statusLabel(item: PlanItem): string {
  return item.status === 'done' ? T.todoDone : item.status === 'in_progress' ? T.todoActive : T.todoPending
}

/** Rework D3: no API key yet; say what it is for and take it right here. */
export function KeyNotice(): JSX.Element | null {
  const state = useAppState()
  const store = useAppStore()
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)
  if (state.settings === undefined || state.settings.apiKey.configured) return null
  return (
    <aside className="notice-card" role="note" data-testid="key-notice">
      <div className="setting-name">{T.keyTitle}</div>
      <p className="muted small wrap">{T.keyBody}</p>
      <form
        className="inline-form"
        onSubmit={event => {
          event.preventDefault()
          if (value === '' || saving) return
          setSaving(true)
          void store.setApiKey(value).finally(() => {
            // The value leaves the page with this one call; the field is cleared either way.
            setValue('')
            setSaving(false)
          })
        }}
      >
        <input type="password" autoComplete="off" value={value} placeholder={T.apiKeyPlaceholder} aria-label={T.keyInput} onChange={event => setValue(event.target.value)} data-testid="key-notice-input" />
        <button type="submit" className="primary" disabled={value === '' || saving} data-testid="key-notice-save">
          {T.apiKeySave}
        </button>
      </form>
      <p className="faint small wrap">{T.keyEnvHint}</p>
    </aside>
  )
}

/** Rework D3 (ADR 0017 decision 6): a cost cap reached 80% or its limit. */
export function CostNotice(): JSX.Element | null {
  const state = useAppState()
  const store = useAppStore()
  const ui = useUi()
  const warning = state.costWarning
  if (warning === undefined) return null
  const scope = T.costScope[warning.scope] ?? warning.scope
  const used = capAmountText(warning.limit, warning.used)
  const cap = capAmountText(warning.limit, warning.cap)
  const reached = warning.level === 'reached'
  return (
    <aside className={reached ? 'notice-card notice-bad' : 'notice-card notice-warn'} role="status" data-testid="cost-notice" data-level={warning.level}>
      <div className="grow">
        <div className="setting-name">{reached ? T.costReachedTitle(scope) : T.costWarnTitle(scope)}</div>
        <p className="muted small wrap">
          {reached ? T.costReachedBody(warning.scope, used, cap) : T.costWarnBody(used, cap)}
          {warning.estimated && T.costEstimated}
        </p>
      </div>
      <div className="row">
        <button type="button" className="ghost" onClick={() => ui.openSettings('cost')} data-testid="cost-notice-settings">
          {T.costAdjust}
        </button>
        <button type="button" onClick={() => store.dismissCostWarning()} data-testid="cost-notice-dismiss">
          {T.dismiss}
        </button>
      </div>
    </aside>
  )
}
