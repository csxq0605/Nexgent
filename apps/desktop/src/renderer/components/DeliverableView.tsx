import { useEffect, useState } from 'react'
import type { DeliverableDiff, DeliverableVersion, FeedbackRating } from '@nexgent/kernel'
import { errorInfoOf } from '../bridge.js'
import { useAppState, useAppStore } from '../hooks.js'
import { T, errorText, formatBytes, formatTime } from '../strings.js'
import type { DeliverableTarget } from '../ui.js'
import { DiffView } from './DiffView.js'
import { Modal } from './Modal.js'

type Load<T> = { readonly state: 'loading' } | { readonly state: 'ready'; readonly value: T } | { readonly state: 'error'; readonly message: string }

function FeedbackForm({ deliverableId, version, onDone }: { readonly deliverableId: string; readonly version: number; readonly onDone: () => void }): JSX.Element {
  const store = useAppStore()
  const state = useAppState()
  const [rating, setRating] = useState<FeedbackRating | undefined>(undefined)
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <form
      className="feedback-form"
      data-testid="feedback-form"
      onSubmit={event => {
        event.preventDefault()
        setBusy(true)
        void store.submitFeedback(deliverableId, version, rating, comment).then(ok => {
          setBusy(false)
          if (ok) onDone()
        })
      }}
    >
      <h3>{T.feedbackTitle}</h3>
      <div className="rating" role="radiogroup" aria-label={T.rating}>
        <span className="muted small">{T.rating}</span>
        {([1, 2, 3, 4, 5] as const).map(n => (
          <button type="button" key={n} role="radio" aria-checked={rating === n} className={rating !== undefined && n <= rating ? 'star on' : 'star'} onClick={() => setRating(rating === n ? undefined : n)} aria-label={`${n}`}>
            ★
          </button>
        ))}
        {rating === undefined && <span className="muted small">{T.noRating}</span>}
      </div>
      <label htmlFor="feedback-comment" className="muted small">
        {T.comment}
      </label>
      <textarea id="feedback-comment" data-testid="feedback-comment" rows={4} value={comment} placeholder={T.commentPlaceholder} onChange={event => setComment(event.target.value)} />
      <div className="row end">
        <button type="submit" className="primary" disabled={busy || comment.trim() === '' || state.running || state.sessionId === undefined} data-testid="submit-feedback">
          {T.submitFeedback}
        </button>
      </div>
    </form>
  )
}

/** One deliverable: versions, file preview, the change from the previous version, and feedback. */
export function DeliverableView({ target, onClose }: { readonly target: DeliverableTarget; readonly onClose: () => void }): JSX.Element {
  const store = useAppStore()
  const state = useAppState()
  const projectId = state.project?.projectId ?? ''
  const summary = state.deliverables.find(d => d.deliverableId === target.deliverableId)
  const [version, setVersion] = useState(target.version)
  const [mode, setMode] = useState<'preview' | 'diff'>(target.mode === 'diff' ? 'diff' : 'preview')
  const [showFeedback, setShowFeedback] = useState(target.mode === 'feedback')
  const [meta, setMeta] = useState<Load<DeliverableVersion>>({ state: 'loading' })
  const [file, setFile] = useState<string | undefined>(undefined)
  const [content, setContent] = useState<Load<string>>({ state: 'loading' })
  const [diff, setDiff] = useState<Load<DeliverableDiff>>({ state: 'loading' })
  const versions = summary?.versions.map(v => v.version) ?? [target.version]
  const latest = Math.max(...versions)

  useEffect(() => {
    let live = true
    setMeta({ state: 'loading' })
    store.client
      ?.call('deliverables.get', { projectId, deliverableId: target.deliverableId, version })
      .then(value => {
        if (!live) return
        setMeta({ state: 'ready', value })
        setFile(value.files[0]?.path)
      })
      .catch((error: unknown) => live && setMeta({ state: 'error', message: errorText(errorInfoOf(error)) }))
    return () => {
      live = false
    }
  }, [store, projectId, target.deliverableId, version])

  useEffect(() => {
    if (file === undefined || mode !== 'preview') return undefined
    let live = true
    setContent({ state: 'loading' })
    store.client
      ?.call('deliverables.readText', { projectId, deliverableId: target.deliverableId, version, path: file })
      .then(value => live && setContent({ state: 'ready', value }))
      .catch((error: unknown) => live && setContent({ state: 'error', message: errorText(errorInfoOf(error)) }))
    return () => {
      live = false
    }
  }, [store, projectId, target.deliverableId, version, file, mode])

  useEffect(() => {
    if (mode !== 'diff' || version < 2) return undefined
    let live = true
    setDiff({ state: 'loading' })
    store.client
      ?.call('deliverables.diff', { projectId, deliverableId: target.deliverableId, from: version - 1, to: version })
      .then(value => live && setDiff({ state: 'ready', value }))
      .catch((error: unknown) => live && setDiff({ state: 'error', message: errorText(errorInfoOf(error)) }))
    return () => {
      live = false
    }
  }, [store, projectId, target.deliverableId, version, mode])

  const title = meta.state === 'ready' ? meta.value.title : (summary?.title ?? T.deliverable)

  return (
    <Modal title={`${title} · ${T.version(version)}`} onClose={onClose} wide testId="deliverable-view">
      <div className="deliverable-toolbar">
        <div className="versions">
          {versions.map(v => (
            <button type="button" key={v} className={v === version ? 'version-pill active' : 'version-pill'} onClick={() => setVersion(v)} data-testid={`version-${v}`}>
              {T.version(v)}
            </button>
          ))}
        </div>
        <div className="tabs small">
          <button type="button" className={mode === 'preview' ? 'tab active' : 'tab'} onClick={() => setMode('preview')}>
            {T.preview}
          </button>
          <button type="button" className={mode === 'diff' ? 'tab active' : 'tab'} onClick={() => setMode('diff')} disabled={version < 2} data-testid="diff-tab">
            {T.changes}
          </button>
        </div>
        <span className="grow" />
        {version === latest && !showFeedback && (
          <button type="button" className="primary" onClick={() => setShowFeedback(true)} data-testid="show-feedback">
            {T.giveFeedback}
          </button>
        )}
      </div>
      {meta.state === 'error' && <p className="error-box">{meta.message}</p>}
      {meta.state === 'ready' && meta.value.summary !== '' && (
        <p className="muted">
          {meta.value.summary} · {formatTime(meta.value.presentedAt)}
        </p>
      )}
      {mode === 'preview' && meta.state === 'ready' && (
        <div className="preview">
          <ul className="preview-files">
            {meta.value.files.map(f => (
              <li key={f.path}>
                <button type="button" className={f.path === file ? 'file active' : 'file'} onClick={() => setFile(f.path)}>
                  <span className="ellipsis">{f.path}</span>
                  <span className="muted small">{formatBytes(f.size)}</span>
                </button>
              </li>
            ))}
          </ul>
          <div className="preview-content">
            {file !== undefined && (
              <div className="row">
                <code className="grow ellipsis">{file}</code>
                <button
                  type="button"
                  className="link small"
                  onClick={() => void store.client?.call('deliverables.reveal', { projectId, deliverableId: target.deliverableId, version, path: file }).catch((error: unknown) => store.notify(error))}
                >
                  {T.reveal}
                </button>
              </div>
            )}
            {content.state === 'loading' && <p className="muted">{T.loading}</p>}
            {content.state === 'error' && <p className="muted">{content.message}</p>}
            {content.state === 'ready' && <pre className="file-content" data-testid="file-content">{content.value}</pre>}
          </div>
        </div>
      )}
      {mode === 'diff' && diff.state === 'loading' && <p className="muted">{T.loading}</p>}
      {mode === 'diff' && diff.state === 'error' && <p className="error-box">{diff.message}</p>}
      {mode === 'diff' && diff.state === 'ready' && <DiffView diff={diff.value} />}
      {showFeedback && version === latest && <FeedbackForm deliverableId={target.deliverableId} version={version} onDone={onClose} />}
    </Modal>
  )
}
