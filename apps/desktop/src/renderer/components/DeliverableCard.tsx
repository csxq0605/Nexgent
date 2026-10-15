import type { DeliverableVersionRef } from '@nexgent/kernel'
import { useState } from 'react'
import { useAppState, useAppStore } from '../hooks.js'
import { T, formatBytes } from '../strings.js'
import { useUi } from '../ui.js'

/** A presented deliverable in the conversation: what it is, its files, and what to do next. */
export function DeliverableCard({ deliverable, latest }: { readonly deliverable: DeliverableVersionRef; readonly latest: boolean }): JSX.Element {
  const ui = useUi()
  const store = useAppStore()
  const { sessionId } = useAppState()
  const { deliverableId, version } = deliverable
  const [improving, setImproving] = useState<'idle' | 'starting' | 'started'>('idle')
  const improve = async (): Promise<void> => {
    setImproving('starting')
    const started = await store.runImprovement({ ...(sessionId === undefined ? {} : { sessionId }), deliverableId })
    setImproving(started ? 'started' : 'idle')
    // The new job and its progress are in the 改进 tab; a failure is already a notice.
    if (started) ui.showPanel('improvements')
  }
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
          <button type="button" disabled={improving === 'starting'} onClick={() => void improve()} data-testid="deliverable-improve">
            {improving === 'starting' ? T.deliverableImproveStarting : T.deliverableImprove}
          </button>
        )}
      </div>
      {latest && improving === 'started' && (
        <p className="muted small" role="status" data-testid="deliverable-improve-started">
          {T.deliverableImproveStarted}{' '}
          <button type="button" className="link" onClick={() => ui.showPanel('improvements')} data-testid="deliverable-improve-show">
            {T.deliverableImproveShow}
          </button>
        </p>
      )}
    </section>
  )
}
