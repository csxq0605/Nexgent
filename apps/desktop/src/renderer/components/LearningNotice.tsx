import { useAppState, useAppStore } from '../hooks.js'
import { L, usdText } from '../strings.js'
import { useUi } from '../ui.js'

/**
 * ADR 0017 decision 3: before learning spends anything on this machine, say
 * once what it does, what it may cost and where to turn it off. Shown above
 * the composer after the first message, until acknowledged.
 */
export function LearningNotice(): JSX.Element | null {
  const state = useAppState()
  const store = useAppStore()
  const ui = useUi()
  const learning = state.settings?.learning
  if (state.userSettings === undefined || learning === undefined || !learning.enabled) return null
  if (state.userSettings.learning.noticeAcknowledgedAt !== undefined || state.timeline.length === 0) return null
  return (
    <aside className="learning-notice" role="note" data-testid="learning-notice">
      <div className="grow">
        <div className="setting-name">{L.noticeTitle}</div>
        <p className="muted small wrap">{L.noticeBody(usdText(learning.budget.maxUsd), learning.budget.windowDays)}</p>
      </div>
      <div className="row">
        <button type="button" className="ghost" onClick={() => ui.openSettings()} data-testid="learning-notice-settings">
          {L.noticeSettings}
        </button>
        <button type="button" className="primary" onClick={() => void store.acknowledgeLearning()} data-testid="learning-notice-ok">
          {L.noticeOk}
        </button>
      </div>
    </aside>
  )
}
