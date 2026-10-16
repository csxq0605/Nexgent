import { useEffect, useMemo, useState } from 'react'
import { PluginApprovalDialog } from './components/Capabilities.js'
import { CapabilitiesPage } from './components/CapabilitiesPage.js'
import { Conversation } from './components/Conversation.js'
import { DeliverableView } from './components/DeliverableView.js'
import { ErrorBoundary } from './components/ErrorBoundary.js'
import { Notices } from './components/Notices.js'
import { SettingsPage } from './components/SettingsPage.js'
import { Sidebar } from './components/Sidebar.js'
import { StartScreen } from './components/StartScreen.js'
import { useAppState } from './hooks.js'
import { T } from './strings.js'
import { UiContext, ViewActionsContext, ViewContext, type DeliverableTarget, type MainView, type UiActions, type ViewActions, type ViewState } from './ui.js'

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

/**
 * The window (ADR 0020): the start screen, or two columns — the sidebar and
 * the main area. The main area shows the conversation (with the 资料与成果
 * drawer on demand) or one of the full pages, 能力 and 设置.
 */
export function App(): JSX.Element {
  const state = useAppState()
  const [view, setView] = useState<MainView>('conversation')
  const [drawer, setDrawer] = useState<ViewState['drawer']>(undefined)
  const [section, setSection] = useState<ViewState['section']>('capabilities')
  const [deliverable, setDeliverable] = useState<DeliverableTarget | undefined>(undefined)
  const ui = useMemo<UiActions>(
    () => ({
      openDeliverable: setDeliverable,
      openSettings: () => setView('settings'),
      showPanel: tab => {
        if (tab === 'materials' || tab === 'deliverables') {
          setView('conversation')
          setDrawer(tab)
        } else {
          setView('capabilities')
          setSection(tab)
        }
      },
      showConversation: () => setView('conversation'),
    }),
    [],
  )
  const actions = useMemo<ViewActions>(() => ({ setDrawer, setSection }), [])
  const viewState = useMemo<ViewState>(() => ({ view, drawer, section }), [view, drawer, section])

  // Switching conversation or project shows that conversation.
  useEffect(() => setView('conversation'), [state.sessionId, state.project?.projectId])

  if (state.backend === 'unavailable') return <BackendUnavailable />
  if (state.backend === 'connecting') {
    return (
      <main className="fatal">
        <Notices />
        <p className="muted">{T.loading}</p>
      </main>
    )
  }

  return (
    <UiContext.Provider value={ui}>
      <ViewContext.Provider value={viewState}>
        <ViewActionsContext.Provider value={actions}>
          <Notices />
          {state.project === undefined ? (
            <StartScreen />
          ) : (
            <div className="workspace" data-testid="workspace">
              <ErrorBoundary region="sidebar">
                <Sidebar />
              </ErrorBoundary>
              <main className="main" data-testid="main">
                {view === 'conversation' && (
                  <ErrorBoundary region="conversation">
                    <Conversation />
                  </ErrorBoundary>
                )}
                {view === 'capabilities' && (
                  <ErrorBoundary region="capabilities">
                    <CapabilitiesPage />
                  </ErrorBoundary>
                )}
                {view === 'settings' && (
                  <ErrorBoundary region="settings">
                    <SettingsPage onClose={() => setView('conversation')} />
                  </ErrorBoundary>
                )}
              </main>
            </div>
          )}
          {deliverable !== undefined && state.project !== undefined && (
            <ErrorBoundary region="deliverable">
              <DeliverableView key={`${deliverable.deliverableId}:${deliverable.version}:${deliverable.mode}`} target={deliverable} onClose={() => setDeliverable(undefined)} />
            </ErrorBoundary>
          )}
          {state.pendingApprovals.length === 0 && state.project !== undefined && <PluginApprovalDialog />}
        </ViewActionsContext.Provider>
      </ViewContext.Provider>
    </UiContext.Provider>
  )
}
