import type { TimelineEntry } from '../timeline.js'
import { useAppStore } from '../hooks.js'
import { T, errorText, memberFormText, memberStatusText, usageText } from '../strings.js'
import { useUi } from '../ui.js'

type MemberEntry = Extract<TimelineEntry, { kind: 'member' }>
type WorkflowEntry = Extract<TimelineEntry, { kind: 'workflow' }>
type TeamMessageEntry = Extract<TimelineEntry, { kind: 'team.message' }>

/** The status dot's colour: running, done, stopped, failed. */
function dotClass(status: string): string {
  return status === 'running' ? 'run' : status === 'completed' ? 'ok' : status === 'interrupted' || status === 'cancelled' ? 'warn' : 'bad'
}

/** One member in the 小组进度 card: who, how it was started, its status; its deliverables and the way into its session underneath. */
function MemberRow({ entry, readOnly }: { readonly entry: MemberEntry; readonly readOnly: boolean }): JSX.Element {
  const store = useAppStore()
  const ui = useUi()
  const { run } = entry
  return (
    <div className="member-row" data-testid="member-block" data-member={run.name} data-status={run.status}>
      <div className="member-line">
        <span className={`dot ${dotClass(run.status)}`} aria-hidden="true" />
        <span className="member-name">{run.name}</span>
        <span className="member-doing">
          {memberFormText(run.executionForm)}
          {run.preset !== undefined && ` · ${run.preset}`}
        </span>
        <span className="member-status small" data-testid="member-status">
          {memberStatusText(run.status)}
        </span>
      </div>
      <div className="member-body">
        {run.usage !== undefined && <span data-testid="member-usage">{usageText(run.usage)}</span>}
        {run.error !== undefined && <span className="error-text">{errorText(run.error)}</span>}
        {run.deliverables.map(version => (
          <button
            type="button"
            key={`${version.deliverableId}:${version.version}`}
            className="link small"
            data-testid="member-deliverable"
            title={version.files.map(file => file.path).join(', ')}
            onClick={() => ui.openDeliverable({ deliverableId: version.deliverableId, version: version.version, mode: 'preview' })}
          >
            {version.title} · {T.versionLong(version.version)}
          </button>
        ))}
        {run.status !== 'running' && run.deliverables.length === 0 && <span>{T.memberNoDeliverables}</span>}
        {!readOnly && (
          <button type="button" className="link small" data-testid="open-member" onClick={() => void store.openMember(run.childSessionId, run.name)}>
            {T.openMember}
          </button>
        )}
      </div>
    </div>
  )
}

/** All members of one turn in one card (ADR 0020 §1): a row each, in the order they started. */
export function TeamCard({ members, readOnly = false }: { readonly members: readonly MemberEntry[]; readonly readOnly?: boolean }): JSX.Element {
  const done = members.filter(m => m.run.status !== 'running').length
  return (
    <section className="team-card" data-testid="team-card">
      <header>
        {T.teamProgress}
        <span className="muted small">{T.teamDone(done, members.length)}</span>
      </header>
      {members.map(entry => (
        <MemberRow key={entry.key} entry={entry} readOnly={readOnly} />
      ))}
    </section>
  )
}

/** A workflow inside the folded steps: title, status, phases and member count. */
export function WorkflowBlock({ entry }: { readonly entry: WorkflowEntry }): JSX.Element {
  const { workflow } = entry
  return (
    <div className="workflow-note" data-testid="workflow-block" data-status={workflow.status}>
      <span className={`dot ${dotClass(workflow.status)}`} aria-hidden="true" />
      <span>{T.workflow}</span>
      {workflow.title !== undefined && <strong className="ellipsis">{workflow.title}</strong>}
      <span>{memberStatusText(workflow.status)}</span>
      {workflow.phases.length > 0 && (
        <span className="ellipsis">
          {T.workflowPhases}：{workflow.phases.join('，')}
        </span>
      )}
      {workflow.members > 0 && <span>{T.workflowMembers(workflow.members)}</span>}
      {workflow.error !== undefined && <span className="error-text">{errorText(workflow.error)}</span>}
    </div>
  )
}

/** A message between members, inside the folded steps. */
export function TeamMessageNote({ entry }: { readonly entry: TeamMessageEntry }): JSX.Element {
  const { message } = entry
  return (
    <div className="team-note" data-testid="team-message" data-state={message.state}>
      <span>{T.teamMessage}</span>
      <span>{T.teamFromTo(message.from, message.to)}</span>
      <span className="team-text">{message.text}</span>
      <span className="faint">{message.state === 'delivered' ? T.teamDelivered : T.teamQueued}</span>
    </div>
  )
}
