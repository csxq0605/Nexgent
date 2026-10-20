import type { DeliverableVersionRef, FileChange } from '@nexgent/kernel'
import { T, fileChangeText, fileKind, formatBytes } from '../strings.js'
import { useUi } from '../ui.js'

function ChangeList({ changes }: { readonly changes: readonly FileChange[] }): JSX.Element {
  return (
    <ul className="change-list">
      {changes.map(change => (
        <li key={change.path}>
          <span className={`badge change-${change.change}`}>{fileChangeText(change.change)}</span> <code>{change.path}</code>
        </li>
      ))}
    </ul>
  )
}

/**
 * A presented deliverable in the conversation (ADR 0020 §1): what it is and
 * its version, open and compare; the turn's changed files once at its foot,
 * the deliverable's own first and the rest of the process folded; then the
 * way to respond — tell Nexgent what is wrong.
 */
export function DeliverableCard({
  deliverable,
  latest,
  changes,
}: {
  readonly deliverable: DeliverableVersionRef
  readonly latest: boolean
  /** The turn's file changes, on its last card. */
  readonly changes?: readonly FileChange[]
}): JSX.Element {
  const ui = useUi()
  const { deliverableId, version } = deliverable
  const own = new Set(deliverable.files.map(file => file.path))
  const ownChanges = (changes ?? []).filter(change => own.has(change.path))
  const otherChanges = (changes ?? []).filter(change => !own.has(change.path))
  const size = deliverable.files.reduce((sum, file) => sum + file.size, 0)
  const meta = [T.versionLong(version), deliverable.files.length === 1 ? deliverable.files[0]!.path : T.fileCount(deliverable.files.length), formatBytes(size)].filter(part => part !== undefined).join(' · ')
  return (
    <section className="deliverable-card" data-testid="deliverable-card" data-version={version}>
      <div className="deliverable-head">
        <span className="file-badge" aria-hidden="true">
          {fileKind(deliverable.files[0]?.path ?? deliverable.title)}
        </span>
        <div className="deliverable-text">
          <span className="deliverable-title" title={deliverable.title}>
            {deliverable.title}
          </span>
          <span className="deliverable-meta">{meta}</span>
        </div>
        <div className="deliverable-actions">
          {version > 1 && (
            <button type="button" onClick={() => ui.openDeliverable({ deliverableId, version, mode: 'diff' })} data-testid="open-diff">
              {T.cardCompare}
            </button>
          )}
          <button type="button" className="primary" onClick={() => ui.openDeliverable({ deliverableId, version, mode: 'preview' })} data-testid="open-deliverable">
            {T.cardOpen}
          </button>
        </div>
      </div>
      {deliverable.summary !== '' && <p className="deliverable-summary">{deliverable.summary}</p>}
      {deliverable.files.length > 1 && (
        <ul className="deliverable-files">
          {deliverable.files.slice(0, 6).map(file => (
            <li key={file.path}>
              <code>{file.path}</code>
            </li>
          ))}
          {deliverable.files.length > 6 && <li>{T.moreFiles(deliverable.files.length - 6)}</li>}
        </ul>
      )}
      {(changes !== undefined || latest) && (
        <div className="deliverable-foot">
          {changes !== undefined && (
            <div className="stack" data-testid="deliverable-changes">
              {ownChanges.length > 0 && (
                <details>
                  <summary>{T.filesChanged(ownChanges.length)}</summary>
                  <ChangeList changes={ownChanges} />
                </details>
              )}
              {otherChanges.length > 0 && (
                <details data-testid="other-changes">
                  <summary>{T.filesOther(otherChanges.length)}</summary>
                  <ChangeList changes={otherChanges} />
                </details>
              )}
            </div>
          )}
          {latest && (
            <div className="right">
              <button type="button" className="link" onClick={() => ui.openDeliverable({ deliverableId, version, mode: 'feedback' })} data-testid="give-feedback">
                {T.cardFeedback}
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
