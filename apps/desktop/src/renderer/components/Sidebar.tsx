import { useState } from 'react'
import { useAppState, useAppStore } from '../hooks.js'
import { T, formatTime, sessionTitle } from '../strings.js'
import { useUi } from '../ui.js'
import markUrl from '../assets/mark.svg'

/** Left column: project switcher, conversation list, settings. */
export function Sidebar(): JSX.Element {
  const state = useAppState()
  const store = useAppStore()
  const ui = useUi()
  const [switching, setSwitching] = useState(false)
  const project = state.project
  const others = state.recent.filter(p => p.root !== project?.root && p.exists)
  const firstMessage = state.timeline.find(entry => entry.kind === 'user')
  const firstText = firstMessage?.kind === 'user' ? firstMessage.text : undefined

  return (
    <aside className="sidebar" data-testid="sidebar">
      <div className="sidebar-brand">
        <img src={markUrl} alt="" className="brand-mark small" />
        <span>{T.appName}</span>
      </div>
      <div className="project-switcher">
        <button type="button" className="project-button" aria-expanded={switching} onClick={() => setSwitching(!switching)} title={project?.root} data-testid="project-button">
          <span className="project-name">{project?.name}</span>
          <span className="chevron">▾</span>
        </button>
        {switching && (
          <ul className="menu" role="menu">
            {others.map(p => (
              <li key={p.root}>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setSwitching(false)
                    void store.openProject(p.root)
                  }}
                  title={p.root}
                >
                  {p.name}
                </button>
              </li>
            ))}
            <li>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setSwitching(false)
                  store.leaveProject()
                }}
              >
                {T.otherProject}
              </button>
            </li>
          </ul>
        )}
      </div>
      <button type="button" className="new-session" onClick={() => void store.newSession()} data-testid="new-session">
        ＋ {T.newConversation}
      </button>
      <div className="section-label">{T.conversations}</div>
      <nav className="session-list" aria-label={T.conversations}>
        {state.sessions.length === 0 && <p className="muted small pad">{T.noConversations}</p>}
        {state.sessions.map(session => (
          <button
            type="button"
            key={session.sessionId}
            className={session.sessionId === state.sessionId ? 'session-item active' : 'session-item'}
            aria-current={session.sessionId === state.sessionId ? 'true' : undefined}
            onClick={() => void store.openSession(session.sessionId)}
            data-testid="session-item"
          >
            <span className="session-title">{sessionTitle(session, session.sessionId === state.sessionId ? firstText : undefined)}</span>
            <span className="session-meta">
              {session.running && <span className="badge live">{T.running}</span>}
              {!session.running && session.interrupted && <span className="badge warn">{T.interrupted}</span>}
              <span className="muted small">{formatTime(session.updatedAt)}</span>
            </span>
          </button>
        ))}
      </nav>
      <button type="button" className="settings-button" onClick={ui.openSettings} data-testid="open-settings">
        ⚙ {T.settings}
      </button>
    </aside>
  )
}
