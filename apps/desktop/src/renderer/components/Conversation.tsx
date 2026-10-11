import { useState } from 'react'
import { useAppState, useAppStore } from '../hooks.js'
import { T, goalStatusText, sessionTitle } from '../strings.js'
import { Composer } from './Composer.js'
import { Timeline } from './Timeline.js'

/** The conversation's title; 改名 turns it into a field (Enter saves, Esc cancels). */
function Title({ sessionId, title, initial }: { readonly sessionId: string; readonly title: string; readonly initial: string }): JSX.Element {
  const store = useAppStore()
  const [draft, setDraft] = useState<string | undefined>(undefined)
  if (draft === undefined) {
    return (
      <>
        <h2 className="ellipsis" data-testid="session-title">
          {title}
        </h2>
        <button type="button" className="link small" onClick={() => setDraft(initial)} data-testid="rename-session">
          {T.rename}
        </button>
      </>
    )
  }
  const save = (): void => {
    const value = draft.trim()
    setDraft(undefined)
    if (value !== '' && value !== initial) void store.renameSession(sessionId, value)
  }
  return (
    <input
      className="title-input"
      value={draft}
      autoFocus
      maxLength={200}
      aria-label={T.renameLabel}
      data-testid="rename-input"
      onChange={event => setDraft(event.target.value)}
      onBlur={save}
      onKeyDown={event => {
        if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
          event.preventDefault()
          save()
        } else if (event.key === 'Escape') {
          event.preventDefault()
          setDraft(undefined)
        }
      }}
    />
  )
}

/** Middle column: header, timeline, composer (or an empty state). */
export function Conversation(): JSX.Element {
  const state = useAppState()
  const session = state.sessions.find(s => s.sessionId === state.sessionId)
  const first = state.timeline.find(entry => entry.kind === 'user')
  if (state.sessionId === undefined) {
    return (
      <section className="conversation empty-state" data-testid="conversation">
        <div className="empty">
          <h2>{T.noSessionTitle}</h2>
          <p className="muted">{T.noSessionBody}</p>
        </div>
      </section>
    )
  }
  return (
    <section className="conversation" data-testid="conversation">
      <header className="conversation-head">
        <Title
          key={state.sessionId}
          sessionId={state.sessionId}
          initial={session?.title ?? ''}
          title={sessionTitle(session === undefined ? undefined : { ...session, ...(state.goal === null ? {} : { goal: state.goal }) }, first?.kind === 'user' ? first.text : undefined)}
        />
        {state.goal !== null && (
          <span className={`badge goal-${state.goal.status}`} title={state.goal.text}>
            {T.panelGoal}·{goalStatusText(state.goal.status)}
          </span>
        )}
        <span className="grow" />
        {state.sessionMeta !== undefined && <span className="muted small">{state.sessionMeta.model}</span>}
      </header>
      {state.sessionLoading ? (
        <div className="empty">
          <p className="muted">{T.loading}</p>
        </div>
      ) : state.timeline.length === 0 ? (
        <div className="empty">
          <h2>{T.emptyConversationTitle}</h2>
          <p className="muted">{T.emptyConversationBody}</p>
        </div>
      ) : (
        <Timeline entries={state.timeline} deliverables={state.deliverables} />
      )}
      <Composer />
    </section>
  )
}
