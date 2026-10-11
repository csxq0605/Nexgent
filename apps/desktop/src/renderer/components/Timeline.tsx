import { useEffect, useRef } from 'react'
import type { DeliverableSummary } from '@nexgent/kernel'
import type { TimelineEntry } from '../timeline.js'
import { T, errorText, fileChangeText, riskText, turnEndText } from '../strings.js'
import { DeliverableCard } from './DeliverableCard.js'
import { Markdown } from './Markdown.js'
import { MemberBlock, TeamMessageNote, WorkflowBlock } from './MemberBlock.js'
import { ToolBlock } from './ToolBlock.js'

function latestVersion(deliverables: readonly DeliverableSummary[], deliverableId: string, fallback: number): number {
  const found = deliverables.find(d => d.deliverableId === deliverableId)
  return found === undefined ? fallback : Math.max(fallback, ...found.versions.map(v => v.version))
}

function Entry({ entry, deliverables, readOnly }: { readonly entry: TimelineEntry; readonly deliverables: readonly DeliverableSummary[]; readonly readOnly: boolean }): JSX.Element | null {
  switch (entry.kind) {
    case 'user':
      return (
        <div className="msg user" data-testid="user-message">
          <div className="bubble">
            <p className="text">{entry.text}</p>
            {entry.materials.length > 0 && (
              <div className="chips">
                {entry.materials.map(name => (
                  <span key={name} className="chip">
                    @{name}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      )
    case 'assistant':
      return (
        <div className="msg assistant" data-testid="assistant-message" data-streaming={entry.streaming ? 'true' : 'false'}>
          <Markdown text={entry.text} />
          {entry.streaming && <span className="caret" aria-hidden="true" />}
          {entry.interrupted && <p className="muted small">{T.interruptedText}</p>}
        </div>
      )
    case 'reasoning':
      return (
        <details className="reasoning">
          <summary>{entry.streaming ? T.thinkingLive : T.thinking}</summary>
          <p className="text muted">{entry.text}</p>
        </details>
      )
    case 'tool':
      return <ToolBlock entry={entry} />
    case 'approval':
      return (
        <div className="approval-note" data-testid="approval-note">
          <span className={`badge risk-${entry.request.risk}`}>
            {T.approvalRisk} {riskText(entry.request.risk)}
          </span>
          {entry.request.member !== undefined && <span className="badge">{entry.request.member.name}</span>}
          <code>{entry.request.summary}</code>
          <span className="muted small">
            {entry.decision === undefined ? T.approvalTitle : entry.decision.decision === 'allow' ? T.approvalAllowed : T.approvalDenied}
          </span>
        </div>
      )
    case 'deliverable':
      return (
        <DeliverableCard
          deliverable={entry.deliverable}
          latest={!readOnly && latestVersion(deliverables, entry.deliverable.deliverableId, entry.deliverable.version) === entry.deliverable.version}
        />
      )
    case 'files':
      return (
        <div className="files-note">
          <div className="muted small">{T.filesChanged}</div>
          <ul>
            {entry.changes.map(change => (
              <li key={change.path}>
                <span className={`badge change-${change.change}`}>{fileChangeText(change.change)}</span> <code>{change.path}</code>
              </li>
            ))}
          </ul>
        </div>
      )
    case 'feedback':
      return (
        <div className="msg user" data-testid="feedback-message">
          <div className="bubble feedback">
            <div className="muted small">
              {T.feedbackLabel} · {T.version(entry.version)}
              {entry.rating !== undefined && ` · ${'★'.repeat(entry.rating)}${'☆'.repeat(5 - entry.rating)}`}
            </div>
            <p className="text">{entry.comment}</p>
          </div>
        </div>
      )
    case 'compaction':
      return <div className="divider">{T.compacted}</div>
    case 'turn.end': {
      const text = turnEndText(entry.reason)
      return text === undefined ? null : (
        <div className={`turn-end turn-end-${entry.reason.kind}`} data-testid="turn-end">
          {text}
        </div>
      )
    }
    case 'error':
      return (
        <div className="error-box" role="alert">
          {errorText(entry.error)}
        </div>
      )
    case 'member':
      return <MemberBlock entry={entry} readOnly={readOnly} />
    case 'workflow':
      return <WorkflowBlock entry={entry} />
    case 'team.message':
      return <TeamMessageNote entry={entry} />
  }
}

/** The conversation itself; follows the bottom while new content streams in. */
export function Timeline({
  entries,
  deliverables,
  readOnly = false,
}: {
  readonly entries: readonly TimelineEntry[]
  readonly deliverables: readonly DeliverableSummary[]
  /** A member's session: no feedback buttons, no nested member views. */
  readonly readOnly?: boolean
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  useEffect(() => {
    const el = ref.current
    if (el !== null && stick.current) el.scrollTop = el.scrollHeight
  }, [entries])
  return (
    <div
      className="timeline"
      ref={ref}
      data-testid="timeline"
      onScroll={event => {
        const el = event.currentTarget
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
      }}
    >
      <div className="timeline-inner">
        {entries.map(entry => (
          <Entry key={entry.key} entry={entry} deliverables={deliverables} readOnly={readOnly} />
        ))}
      </div>
    </div>
  )
}
