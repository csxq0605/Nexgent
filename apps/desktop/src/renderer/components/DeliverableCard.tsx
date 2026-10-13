import type { DeliverableVersionRef } from '@nexgent/kernel'
import { useAppState, useAppStore } from '../hooks.js'
import { T, formatBytes } from '../strings.js'
import { useUi } from '../ui.js'

/** A presented deliverable in the conversation: what it is, its files, and what to do next. */
export function DeliverableCard({ deliverable, latest }: { readonly deliverable: DeliverableVersionRef; readonly latest: boolean }): JSX.Element {
  const ui = useUi()
  const store = useAppStore()
  const { sessionId } = useAppState()
  const { deliverableId, version } = deliverable
  return (
    <section className="deliverable-card" data-testid="deliverable-card" data-version={version}>
      <header>
        <span className="badge accent">{T.deliverable}</span>
        <strong className="deliverable-title">{deliverable.title}</strong>
        <span className="version">{T.version(version)}</span>
      </header>
      {deliverable.summary !== '' && <p className="deliverable-summary">{deliverable.summary}</p>}
      <ul className="file-list">
        {deliverable.files.slice(0, 5).map(file => (
          <li key={file.path}>
            <code>{file.path}</code> <span className="muted small">{formatBytes(file.size)}</span>
          </li>
        ))}
        {deliverable.files.length > 5 && <li className="muted small">… +{deliverable.files.length - 5}</li>}
      </ul>
      <div className="row">
        <button type="button" onClick={() => ui.openDeliverable({ deliverableId, version, mode: 'preview' })}>
          {T.viewDeliverable}
        </button>
        {version > 1 && (
          <button type="button" onClick={() => ui.openDeliverable({ deliverableId, version, mode: 'diff' })} data-testid="open-diff">
            {T.changes}
          </button>
        )}
        {latest && (
          <button type="button" className="primary" onClick={() => ui.openDeliverable({ deliverableId, version, mode: 'feedback' })} data-testid="give-feedback">
            {T.giveFeedback}
          </button>
        )}
        {latest && (
          <button type="button" onClick={() => void store.runImprovement({ ...(sessionId === undefined ? {} : { sessionId }), deliverableId })} data-testid="deliverable-improve">
            {T.deliverableImprove}
          </button>
        )}
      </div>
    </section>
  )
}
