import { useState } from 'react'
import type { SessionSummary } from '@nexgent/sdk'
import { useAppState, useAppStore } from '../hooks.js'
import { T, formatTime, sessionGroup, sessionTitle } from '../strings.js'
import { useUi, useView } from '../ui.js'
import { Icon } from './Icon.js'

const GROUPS = [
  { id: 'today', label: T.groupToday },
  { id: 'week', label: T.groupWeek },
  { id: 'earlier', label: T.groupEarlier },
] as const

/** Left column (ADR 0020): project, new conversation, conversations by 今天 / 本周 / 更早, then 能力 and 设置. */
export function Sidebar(): JSX.Element {
  const state = useAppState()
  const store = useAppStore()
  const ui = useUi()
  const { view } = useView()
  const [switching, setSwitching] = useState(false)
  const project = state.project
  const others = state.recent.filter(p => p.root !== project?.root && p.exists)
  const firstMessage = state.timeline.find(entry => entry.kind === 'user')
  const firstText = firstMessage?.kind === 'user' ? firstMessage.text : undefined
  // Coordinator: the project's resident conversation, pinned above the others.
  const coordinator = state.sessions.find(session => session.coordinator === true)
  // Coordinator step two: threads sit under the conversation that started them.
  const threadsOf = (sessionId: string): SessionSummary[] => state.sessions
    .filter(session => session.thread?.coordinatorSessionId === sessionId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const withThreads = (session: SessionSummary): JSX.Element[] => [item(session), ...threadsOf(session.sessionId).map(item)]
  const item = (session: SessionSummary): JSX.Element => {
    const active = session.sessionId === state.sessionId
    const thread = session.thread !== undefined
    return (
      <button
        type="button"
        key={session.sessionId}
        className={`session-item${thread ? ' thread-item' : ''}${active && view === 'conversation' ? ' active' : ''}`}
        aria-current={active ? 'true' : undefined}
        onClick={() => {
          ui.showConversation()
          if (!active) void store.openSession(session.sessionId)
        }}
        title={`${formatTime(session.updatedAt)}${session.childCount !== undefined && session.childCount > 0 ? ` · ${T.memberCount(session.childCount)}` : ''}`}
        data-testid={thread ? 'thread-item' : 'session-item'}
      >
        <span className="session-title">{session.coordinator === true ? T.coordinatorConversation : thread ? session.thread!.title : sessionTitle(session, active ? firstText : undefined)}</span>
        {dot(session)}
      </button>
    )
  }

  const dot = (session: SessionSummary): JSX.Element | null => {
    const active = session.sessionId === state.sessionId
    if (active && state.pendingApprovals.length > 0) return <span className="dot warn" title={T.needsApproval} aria-label={T.needsApproval} />
    // Coordinator step three: a thread in the background waits for the user to allow something.
    if (!active && state.threads.some(t => t.threadId === session.sessionId && t.needsApproval === true)) return <span className="dot warn" title={T.needsApproval} aria-label={T.needsApproval} />
    if (session.running) return <span className="dot run" title={T.running} aria-label={T.running} />
    if (state.threads.some(t => t.threadId === session.sessionId && t.status === 'waiting')) return <span className="dot warn" title={T.threadWaiting} aria-label={T.threadWaiting} />
    if (session.interrupted) return <span className="dot" title={T.interrupted} aria-label={T.interrupted} />
    return null
  }

  return (
    <aside className="sidebar" data-testid="sidebar">
      <div className="project-switcher">
        <button
          type="button"
          className="nav-item project-button"
          aria-expanded={switching}
          onClick={() => setSwitching(!switching)}
          title={project?.root}
          data-testid="project-button"
        >
          <span className="project-mark" aria-hidden="true">
            {(project?.name ?? '?').slice(0, 1).toUpperCase()}
          </span>
          <span className="project-name">{project?.name}</span>
          <Icon name="chevronDown" className="faint" />
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
            {others.length > 0 && <li className="menu-sep" role="separator" />}
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
      <button
        type="button"
        className="nav-item"
        onClick={() => {
          ui.showConversation()
          void store.newSession()
        }}
        data-testid="new-session"
      >
        <Icon name="plus" />
        {T.newConversation}
      </button>
      <nav className="session-list" aria-label={T.conversations}>
        {state.sessions.length === 0 && <p className="muted small pad">{T.noConversations}</p>}
        {coordinator !== undefined && <div role="group" aria-label={T.coordinatorConversation}>{withThreads(coordinator)}</div>}
        {GROUPS.map(group => {
          const sessions = state.sessions.filter(session => session.coordinator !== true && session.thread === undefined && sessionGroup(session.updatedAt) === group.id)
          if (sessions.length === 0) return null
          return (
            <div key={group.id} role="group" aria-label={group.label}>
              <div className="group-label">{group.label}</div>
              {sessions.flatMap(withThreads)}
            </div>
          )
        })}
      </nav>
      <div className="sidebar-foot">
        <button
          type="button"
          className={view === 'capabilities' ? 'nav-item active' : 'nav-item'}
          onClick={() => ui.showPanel('learned')}
          data-testid="nav-capabilities"
        >
          <Icon name="star" />
          {T.capabilities}
        </button>
        <button type="button" className={view === 'settings' ? 'nav-item active' : 'nav-item'} onClick={() => ui.openSettings()} data-testid="open-settings">
          <Icon name="settings" />
          {T.settings}
        </button>
      </div>
    </aside>
  )
}
