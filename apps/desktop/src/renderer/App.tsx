import { useMemo, useState } from 'react'
import { ApprovalDialog } from './components/ApprovalDialog.js'
import { PluginApprovalDialog } from './components/Capabilities.js'
import { Conversation } from './components/Conversation.js'
import { DeliverableView } from './components/DeliverableView.js'
import { ErrorBoundary } from './components/ErrorBoundary.js'
import { Notices } from './components/Notices.js'
import { RightPanel } from './components/RightPanel.js'
import { SettingsPage } from './components/SettingsPage.js'
import { Sidebar } from './components/Sidebar.js'
import { StartScreen } from './components/StartScreen.js'
import { useAppState } from './hooks.js'
import { T } from './strings.js'
import { UiContext, type DeliverableTarget, type PanelTab, type UiActions } from './ui.js'

function BackendUnavailable(): JSX.Element {
  return (
    <main className="fatal" role="alert" data-testid="backend-unavailable">
      <h2>{T.backendUnavailableTitle}</h2>
      <p>{T.backendUnavailableBody}</p>
      <button type="button" onClick={() => window.location.reload()}>
        {T.reload}
      </button>
    </main>
  )
}

/** The window: start screen, or the three-column workspace with its dialogs. */
export function App(): JSX.Element {
  const state = useAppState()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [deliverable, setDeliverable] = useState<DeliverableTarget | undefined>(undefined)
  const [tab, setTab] = useState<PanelTab>('materials')
  const ui = useMemo<UiActions>(
    () => ({ openDeliverable: setDeliverable, openSettings: () => setSettingsOpen(true), showPanel: setTab }),
    [],
  )

  if (state.backend === 'unavailable') return <BackendUnavailable />
  if (state.backend === 'connecting') {
    return (
      <main className="fatal">
        <Notices />
        <p className="muted">{T.loading}</p>
      </main>
    )
  }

  const approval = state.pendingApprovals[0]
  return (
    <UiContext.Provider value={ui}>
      <Notices />
      {state.project === undefined ? (
        <StartScreen />
      ) : (
        <div className="workspace" data-testid="workspace">
          <ErrorBoundary region="sidebar">
            <Sidebar />
          </ErrorBoundary>
          <ErrorBoundary region="conversation">
            <Conversation />
          </ErrorBoundary>
          <ErrorBoundary region="panel">
            <RightPanel tab={tab} onTab={setTab} />
          </ErrorBoundary>
        </div>
      )}
      {settingsOpen && state.project !== undefined && (
        <ErrorBoundary region="settings">
          <SettingsPage onClose={() => setSettingsOpen(false)} />
        </ErrorBoundary>
      )}
      {deliverable !== undefined && state.project !== undefined && (
        <ErrorBoundary region="deliverable">
          <DeliverableView key={`${deliverable.deliverableId}:${deliverable.version}:${deliverable.mode}`} target={deliverable} onClose={() => setDeliverable(undefined)} />
        </ErrorBoundary>
      )}
      {approval !== undefined && <ApprovalDialog key={approval.id} request={approval} />}
      {approval === undefined && state.project !== undefined && <PluginApprovalDialog />}
    </UiContext.Provider>
  )
}
