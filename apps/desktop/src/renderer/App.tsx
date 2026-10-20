import { useEffect, useMemo, useState } from 'react'
import { CapabilitiesPage } from './components/CapabilitiesPage.js'
import { Conversation } from './components/Conversation.js'
import { DeliverableView } from './components/DeliverableView.js'
import { ErrorBoundary } from './components/ErrorBoundary.js'
import { Notices } from './components/Notices.js'
import { SettingsPage } from './components/SettingsPage.js'
import { Sidebar } from './components/Sidebar.js'
import { StartScreen } from './components/StartScreen.js'
import { useAppState, useAppStore } from './hooks.js'
import { T } from './strings.js'
import { UiContext, ViewActionsContext, ViewContext, type DeliverableTarget, type MainView, type SettingsGroup, type UiActions, type ViewActions, type ViewState } from './ui.js'

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
  const store = useAppStore()
  const [view, setView] = useState<MainView>('conversation')
  const [drawer, setDrawer] = useState<ViewState['drawer']>(undefined)
  const [deliverable, setDeliverable] = useState<DeliverableTarget | undefined>(undefined)
  const [settingsGroup, setSettingsGroup] = useState<SettingsGroup | undefined>(undefined)
  const ui = useMemo<UiActions>(
    () => ({
      openDeliverable: setDeliverable,
      openSettings: group => {
        store.notePage()
        setSettingsGroup(group)
        setView('settings')
      },
      showPanel: tab => {
        if (tab === 'materials' || tab === 'deliverables') {
          setView('conversation')
          setDrawer(tab)
        } else {
          store.notePage()
          setView('capabilities')
        }
      },
      showConversation: () => setView('conversation'),
    }),
    [store],
  )
  const actions = useMemo<ViewActions>(() => ({ setDrawer }), [])
  const viewState = useMemo<ViewState>(() => ({ view, drawer }), [view, drawer])

  // Opening a conversation to show it, or switching project, shows the conversation
  // (one that opens behind a page the user just opened does not).
  useEffect(() => setView('conversation'), [state.showTick, state.project?.projectId])

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
                    <SettingsPage onClose={() => setView('conversation')} {...(settingsGroup === undefined ? {} : { initialGroup: settingsGroup })} />
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
        </ViewActionsContext.Provider>
      </ViewContext.Provider>
    </UiContext.Provider>
  )
}
