import { useState } from 'react'
import { useAppState, useAppStore } from '../hooks.js'
import { T, goalStatusText, memberFormText, sessionTitle } from '../strings.js'
import { useView, useViewActions } from '../ui.js'
import { ApprovalCard } from './ApprovalDialog.js'
import { LearningNotice } from './LearningNotice.js'
import { Composer } from './Composer.js'
import { Drawer } from './Drawer.js'
import { Icon } from './Icon.js'
import { Timeline } from './Timeline.js'

/** The conversation's title; the pencil turns it into a field (Enter saves, Esc cancels). */
function Title({ sessionId, title, initial }: { readonly sessionId: string; readonly title: string; readonly initial: string }): JSX.Element {
  const store = useAppStore()
  const [draft, setDraft] = useState<string | undefined>(undefined)
  if (draft === undefined) {
    return (
      <>
        <h2 className="ellipsis" data-testid="session-title" title={title}>
          {title}
        </h2>
        <button type="button" className="icon" aria-label={T.rename} title={T.rename} onClick={() => setDraft(initial)} data-testid="rename-session">
          <Icon name="pencil" />
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

/** The conversation's goal as one line under the title bar; click it to change, finish or drop it. */
function GoalLine(): JSX.Element {
  const state = useAppState()
  const store = useAppStore()
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const goal = state.goal
  return (
    <div className="goal-line">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} title={goal?.text} data-testid="goal-button">
        {goal === null ? (
          <span className="faint">{T.goalAdd}</span>
        ) : (
          <>
            <span className={`badge goal-${goal.status}`}>{goalStatusText(goal.status)}</span>
            <span className="ellipsis">{T.goalLabel(goal.text)}</span>
          </>
        )}
      </button>
      {open && (
        <div className="popover" data-testid="goal-panel">
          {goal === null ? (
            <p className="muted">{T.goalNone}</p>
          ) : (
            <>
              <p className="goal-text">{goal.text}</p>
              {goal.note !== undefined && <p className="muted small">{goal.note}</p>}
              <div className="row">
                {goal.status === 'active' ? (
                  <>
                    <button type="button" onClick={() => void store.updateGoal('completed')}>
                      {T.goalComplete}
                    </button>
                    <button type="button" className="ghost" onClick={() => void store.updateGoal('abandoned')}>
                      {T.goalAbandon}
                    </button>
                  </>
                ) : (
                  <button type="button" onClick={() => void store.updateGoal('active')}>
                    {T.goalReopen}
                  </button>
                )}
              </div>
            </>
          )}
          <form
            className="stack"
            onSubmit={event => {
              event.preventDefault()
              void store.setGoal(text).then(() => {
                setText('')
                setOpen(false)
              })
            }}
          >
            <textarea value={text} rows={2} onChange={event => setText(event.target.value)} placeholder={T.goalPlaceholder} aria-label={T.goalPlaceholder} />
            <button type="submit" className="primary" disabled={text.trim() === ''}>
              {T.setGoal}
            </button>
          </form>
        </div>
      )}
    </div>
  )
}

function DrawerToggle(): JSX.Element {
  const { drawer } = useView()
  const { setDrawer } = useViewActions()
  return (
    <button type="button" aria-expanded={drawer !== undefined} onClick={() => setDrawer(drawer === undefined ? 'materials' : undefined)} data-testid="drawer-toggle">
      <Icon name="panel" />
      {T.drawerTitle}
    </button>
  )
}

/** The approvals waiting in this conversation, as cards above the composer (ADR 0020 §1). */
function Approvals(): JSX.Element | null {
  const state = useAppState()
  const first = state.pendingApprovals[0]
  if (first === undefined) return null
  return (
    <div className="approvals">
      <ApprovalCard key={first.id} request={first} />
    </div>
  )
}

/** A member's session, read-only, with the way back to the conversation. */
function MemberConversation(): JSX.Element {
  const state = useAppState()
  const store = useAppStore()
  const view = state.memberView!
  return (
    <section className="conversation member-conversation" data-testid="member-view" data-session={view.sessionId}>
      <header className="topbar">
        <button type="button" className="ghost" onClick={() => store.closeMember()} data-testid="member-back">
          <Icon name="back" />
          {T.backToConversation}
        </button>
        <h2 className="ellipsis" data-testid="member-view-title">
          {T.memberSessionTitle(view.name)}
        </h2>
        {view.summary?.member !== undefined && <span className="muted small">{memberFormText(view.summary.member.executionForm)}</span>}
        <span className="grow" />
        {view.summary?.running === true && <span className="badge live">{T.running}</span>}
      </header>
      {view.loading ? (
        <div className="empty">
          <p className="muted">{T.loading}</p>
        </div>
      ) : (
        <Timeline entries={view.timeline} deliverables={state.deliverables} readOnly />
      )}
      <Approvals />
      <p className="member-readonly muted small" data-testid="member-readonly">
        {T.memberReadOnly}
      </p>
    </section>
  )
}

/** The main area's conversation: title bar, timeline, approvals, composer, and the 资料与成果 drawer. */
export function Conversation(): JSX.Element {
  const state = useAppState()
  if (state.memberView !== undefined && state.memberView.parentSessionId === state.sessionId) return <MemberConversation />
  return <MainConversation />
}

function MainConversation(): JSX.Element {
  const state = useAppState()
  const session = state.sessions.find(s => s.sessionId === state.sessionId)
  const first = state.timeline.find(entry => entry.kind === 'user')
  if (state.sessionId === undefined) {
    return (
      <section className="conversation empty-state" data-testid="conversation">
        <header className="topbar">
          <span className="grow" />
          <DrawerToggle />
        </header>
        <div className="empty">
          <h2>{T.noSessionTitle}</h2>
          <p className="muted">{T.noSessionBody}</p>
        </div>
        <Drawer />
      </section>
    )
  }
  return (
    <section className="conversation" data-testid="conversation">
      <header className="topbar">
        <Title
          key={state.sessionId}
          sessionId={state.sessionId}
          initial={session?.title ?? ''}
          title={sessionTitle(session === undefined ? undefined : { ...session, ...(state.goal === null ? {} : { goal: state.goal }) }, first?.kind === 'user' ? first.text : undefined)}
        />
        <GoalLine key={`goal:${state.sessionId}`} />
        <span className="grow" />
        <DrawerToggle />
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
      <Approvals />
      <LearningNotice />
      <Composer />
      <Drawer />
    </section>
  )
}
