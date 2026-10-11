import { useAppState } from '../hooks.js'
import { T, goalStatusText, sessionTitle } from '../strings.js'
import { Composer } from './Composer.js'
import { Timeline } from './Timeline.js'

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
        <h2 className="ellipsis">{sessionTitle(session === undefined ? undefined : { ...session, ...(state.goal === null ? {} : { goal: state.goal }) }, first?.kind === 'user' ? first.text : undefined)}</h2>
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
