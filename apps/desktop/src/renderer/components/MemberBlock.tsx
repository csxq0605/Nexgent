import type { TimelineEntry } from '../timeline.js'
import { useAppStore } from '../hooks.js'
import { T, errorText, memberFormText, memberStatusText, usageText } from '../strings.js'
import { useUi } from '../ui.js'

type MemberEntry = Extract<TimelineEntry, { kind: 'member' }>
type WorkflowEntry = Extract<TimelineEntry, { kind: 'workflow' }>
type TeamMessageEntry = Extract<TimelineEntry, { kind: 'team.message' }>

function statusClass(status: string): string {
  return status === 'running' ? 'live' : status === 'completed' ? 'ok' : status === 'interrupted' || status === 'cancelled' ? 'warn' : 'bad'
}

/**
 * One member run (delegate, teammate, workflow member) as a collapsible
 * block: name, how it was started, status, usage; inside, its deliverables
 * and the way into its session (read-only).
 */
export function MemberBlock({ entry, readOnly = false }: { readonly entry: MemberEntry; readonly readOnly?: boolean }): JSX.Element {
  const store = useAppStore()
  const ui = useUi()
  const { run } = entry
  const detail = [run.preset, run.mode === 'fork' ? 'fork' : undefined].filter(part => part !== undefined).join(' · ')
  return (
    <details className={`tool member tool-${statusClass(run.status)}`} data-testid="member-block" data-member={run.name} data-status={run.status}>
      <summary>
        <span className="badge accent">{memberFormText(run.executionForm)}</span>
        <span className="tool-name">{run.name}</span>
        <span className="tool-target">{detail}</span>
        {run.deliverables.length > 0 && <span className="muted small">{T.memberDeliverables(run.deliverables.length)}</span>}
        <span className={`badge ${statusClass(run.status)}`} data-testid="member-status">
          {memberStatusText(run.status)}
        </span>
      </summary>
      <div className="tool-body member-body">
        {run.usage !== undefined && <p className="muted small" data-testid="member-usage">{usageText(run.usage)}</p>}
        {run.error !== undefined && <p className="error-text small">{errorText(run.error)}</p>}
        {run.status !== 'running' && run.deliverables.length === 0 && <p className="muted small">{T.memberNoDeliverables}</p>}
        {run.deliverables.length > 0 && (
          <ul className="file-list">
            {run.deliverables.map(version => (
              <li key={`${version.deliverableId}:${version.version}`}>
                <button
                  type="button"
                  className="link"
                  data-testid="member-deliverable"
                  onClick={() => ui.openDeliverable({ deliverableId: version.deliverableId, version: version.version, mode: 'preview' })}
                >
                  {version.title} {T.version(version.version)}
                </button>{' '}
                <span className="muted small ellipsis">{version.files.map(file => file.path).join(', ')}</span>
              </li>
            ))}
          </ul>
        )}
        {!readOnly && (
          <button type="button" className="link small" data-testid="open-member" onClick={() => void store.openMember(run.childSessionId, run.name)}>
            {T.openMember}
          </button>
        )}
      </div>
    </details>
  )
}

/** A workflow: title, status, phases and member count; its members follow as their own blocks. */
export function WorkflowBlock({ entry }: { readonly entry: WorkflowEntry }): JSX.Element {
  const { workflow } = entry
  return (
    <div className="workflow-note" data-testid="workflow-block" data-status={workflow.status}>
      <span className="badge accent">{T.workflow}</span>
      {workflow.title !== undefined && <strong className="ellipsis">{workflow.title}</strong>}
      <span className={`badge ${statusClass(workflow.status)}`}>{memberStatusText(workflow.status)}</span>
      {workflow.phases.length > 0 && (
        <span className="muted small ellipsis">
          {T.workflowPhases}：{workflow.phases.join(' → ')}
        </span>
      )}
      {workflow.members > 0 && <span className="muted small">{T.workflowMembers(workflow.members)}</span>}
      {workflow.error !== undefined && <span className="error-text small">{errorText(workflow.error)}</span>}
    </div>
  )
}

/** A team mailbox message. */
export function TeamMessageNote({ entry }: { readonly entry: TeamMessageEntry }): JSX.Element {
  const { message } = entry
  return (
    <div className="team-note" data-testid="team-message" data-state={message.state}>
      <span className="badge">{T.teamMessage}</span>
      <span className="small">
        {message.from} → {message.to}
      </span>
      <span className="team-text">{message.text}</span>
      <span className="muted small">{message.state === 'delivered' ? T.teamDelivered : T.teamQueued}</span>
    </div>
  )
}
