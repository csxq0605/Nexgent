import type { TimelineEntry } from '../timeline.js'
import { useAppState, useAppStore } from '../hooks.js'
import { T, errorText, memberFormText, memberStatusText, organizationText, roleKindText, threadRunState, threadStatusText, usageText } from '../strings.js'
import type { OrganizationRoleKind } from '@nexgent/kernel'
import { useUi } from '../ui.js'

type MemberEntry = Extract<TimelineEntry, { kind: 'member' }>
type WorkflowEntry = Extract<TimelineEntry, { kind: 'workflow' }>
type OrganizationEntry = Extract<TimelineEntry, { kind: 'organization' }>

/** The status dot's colour: running, done, stopped, failed. */
function dotClass(status: string): string {
  return status === 'running' ? 'run' : status === 'completed' ? 'ok' : status === 'interrupted' || status === 'cancelled' ? 'warn' : 'bad'
}

/** One member in the 小组进度 card: who, how it was started, its status; its deliverables and the way into its session underneath. */
/**
 * What stopped a member that is no longer running: the blocker its report
 * names, else the first refused tool call (an approval denied, or the
 * sandbox), in plain words.
 */
export function stuckReason(run: MemberEntry['run']): string | undefined {
  if (run.status === 'running') return undefined
  if (run.blocker !== undefined) return run.blocker
  const denial = run.denied?.[0]
  return denial === undefined ? undefined : T.memberDenied(denial.tool, denial.code)
}

/** Roles whose part is not a deliverable (planning, reading, checking): no "no deliverable" line for them. */
const NO_DELIVERABLE_ROLES: ReadonlySet<OrganizationRoleKind> = new Set(['plan', 'explore', 'test', 'review'])

function MemberRow({ entry, readOnly, role, reassignedTo }: { readonly entry: MemberEntry; readonly readOnly: boolean; readonly role?: OrganizationRoleKind; readonly reassignedTo?: string }): JSX.Element {
  const store = useAppStore()
  const ui = useUi()
  const { run } = entry
  const reason = stuckReason(run)
  const stuck = reason !== undefined
  return (
    <div className="member-row" data-testid="member-block" data-member={run.name} data-status={run.status} {...(stuck ? { 'data-stuck': '' } : {})}>
      <div className="member-line">
        <span className={`dot ${stuck ? 'warn' : dotClass(run.status)}`} aria-hidden="true" />
        <span className="member-name">{run.name}</span>
        <span className="member-doing" data-testid="member-doing">
          {role !== undefined ? roleKindText(role) : (
            <>
              {memberFormText(run.executionForm)}
              {run.preset !== undefined && ` · ${run.preset}`}
            </>
          )}
        </span>
        <span className="member-status small" data-testid="member-status">
          {stuck ? T.memberStuck : memberStatusText(run.status)}
        </span>
      </div>
      {stuck && (
        <div className="member-stuck small wrap" data-testid="member-stuck">
          {T.memberStuckOn(reason!)}
          {reassignedTo !== undefined && <span data-testid="member-reassigned">{`，${T.memberReassigned(reassignedTo)}`}</span>}
        </div>
      )}
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
        {run.status !== 'running' && run.deliverables.length === 0 && !stuck && run.error === undefined && (role === undefined || !NO_DELIVERABLE_ROLES.has(role)) && <span>{T.memberNoDeliverables}</span>}
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
export function TeamCard({ members, organizations = [], readOnly = false }: {
  readonly members: readonly MemberEntry[]
  readonly organizations?: readonly OrganizationEntry[]
  readonly readOnly?: boolean
}): JSX.Element {
  // A member that ran to the end but reported a blocker is not counted as done.
  const done = members.filter(m => m.run.status !== 'running' && stuckReason(m.run) === undefined).length
  const latest = organizations.at(-1)?.organization
  // New direction step 2: a member started by an organization shows its role.
  const roleOf = (entry: MemberEntry): OrganizationRoleKind | undefined => {
    const organization = organizations.find(o => o.organization.workflowId === entry.run.workflowId)?.organization
    return organization?.roles.find(role => role.name === entry.run.name)?.kind
  }
  // A stuck member whose organization was changed afterwards: the roles of the same kind in the next organization took its part over.
  const reassignedTo = (entry: MemberEntry, kind: OrganizationRoleKind | undefined): string | undefined => {
    if (kind === undefined || stuckReason(entry.run) === undefined) return undefined
    const index = organizations.findIndex(o => o.organization.workflowId === entry.run.workflowId)
    const next = index === -1 ? undefined : organizations.slice(index + 1).find(o => o.organization.replaces !== undefined)?.organization
    const names = next?.roles.filter(role => role.kind === kind).map(role => role.name) ?? []
    return names.length === 0 ? undefined : names.join('、')
  }
  return (
    <section className="team-card" data-testid="team-card">
      <header>
        {T.teamProgress}
        {latest !== undefined && <span className="muted small" data-testid="team-organization">{organizationText(latest.name)}</span>}
        <span className="muted small">{T.teamDone(done, members.length)}</span>
      </header>
      {organizations.flatMap(o => (o.organization.reason === undefined ? [] : [
        <div key={o.key} className="team-change small" data-testid="team-change">{T.reorganized(o.organization.reason)}</div>,
      ]))}
      {members.map(entry => {
        const role = roleOf(entry)
        const to = reassignedTo(entry, role)
        return <MemberRow key={entry.key} entry={entry} readOnly={readOnly} {...(role === undefined ? {} : { role })} {...(to === undefined ? {} : { reassignedTo: to })} />
      })}
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

/**
 * Coordinator step two: one thread run in the coordinator. Its title, where
 * it stands (进行中 / 做完了 / 等你回复 / 停了 / 没做成), what it asks when it
 * waits, and the way into the thread (a conversation the user can talk to).
 */
export function ThreadCard({ entry, readOnly = false }: { readonly entry: MemberEntry; readonly readOnly?: boolean }): JSX.Element {
  const store = useAppStore()
  const ui = useUi()
  const { run } = entry
  const app = useAppState()
  const thread = app.sessions.find(session => session.sessionId === run.childSessionId)
  const state = threadRunState(run.status, run.blocker)
  // Coordinator step three: the running thread waits for the user to allow a tool call; the answer is given in the thread.
  const approval = state === 'running' && app.threads.some(t => t.threadId === run.childSessionId && t.needsApproval === true)
  const dot = approval ? 'warn' : state === 'running' ? 'run' : state === 'done' ? 'ok' : state === 'failed' ? 'bad' : 'warn'
  return (
    <section className="thread-card" data-testid="thread-card" data-thread={run.childSessionId} data-status={approval ? 'approval' : state}>
      <div className="member-line">
        <span className={`dot ${dot}`} aria-hidden="true" />
        <span className="small muted">{T.threadLabel}</span>
        <span className="member-name ellipsis" data-testid="thread-title">{thread?.thread?.title ?? thread?.title ?? run.name}</span>
        <span className="member-status small" data-testid="thread-status">{approval ? T.threadApproval : threadStatusText(state)}</span>
      </div>
      {approval && <div className="member-stuck small wrap" data-testid="thread-approval">{T.threadApprovalHint}</div>}
      {state === 'waiting' && run.blocker !== undefined && <div className="member-stuck small wrap" data-testid="thread-ask">{T.threadAsk(run.blocker)}</div>}
      {run.error !== undefined && <div className="error-text small">{errorText(run.error)}</div>}
      {!readOnly && (
        <div className="member-body">
          <button
            type="button"
            className="link small"
            data-testid="open-thread"
            onClick={() => {
              ui.showConversation()
              void store.openSession(run.childSessionId)
            }}
          >
            {T.openThread}
          </button>
        </div>
      )}
    </section>
  )
}
