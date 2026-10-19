import { useEffect, useState } from 'react'
import type { RewindView } from '@nexgent/sdk'
import { T } from '../strings.js'
import { useAppStore } from '../hooks.js'
import { Modal } from './Modal.js'

type Preview = RewindView | 'unavailable' | 'loading'

/**
 * Redesign 3.1: list what taking the files back to before `turn` changes,
 * and write it only when the user confirms.
 */
export function RewindDialog({ turn, onClose }: { readonly turn: number; readonly onClose: () => void }): JSX.Element {
  const store = useAppStore()
  const [preview, setPreview] = useState<Preview>('loading')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let live = true
    void store.previewRewind(turn).then(result => {
      if (!live) return
      if (result === undefined) onClose()
      else setPreview(result)
    })
    return () => {
      live = false
    }
  }, [store, turn, onClose])
  const restore = preview === 'loading' || preview === 'unavailable' ? [] : preview.changes.filter(change => change.action === 'restore')
  const remove = preview === 'loading' || preview === 'unavailable' ? [] : preview.changes.filter(change => change.action === 'delete')
  const ready = typeof preview === 'object'
  return (
    <Modal title={T.rewindTitle} onClose={onClose} testId="rewind-dialog">
      {preview === 'loading' && <p className="muted">{T.rewindLoading}</p>}
      {preview === 'unavailable' && <p data-testid="rewind-unavailable">{T.rewindUnavailable}</p>}
      {ready && preview.changes.length === 0 && <p data-testid="rewind-nothing">{T.rewindNothing}</p>}
      {restore.length > 0 && <PathGroup title={T.rewindRestore(restore.length)} paths={restore.map(change => change.path)} testId="rewind-restore" />}
      {remove.length > 0 && <PathGroup title={T.rewindDelete(remove.length)} paths={remove.map(change => change.path)} testId="rewind-delete" />}
      {ready && preview.changes.length > 0 && (
        <>
          {preview.unchanged.length > 0 && <p className="muted small">{T.rewindUnchanged(preview.unchanged.length)}</p>}
          <p className="muted small">{T.rewindKeep}</p>
        </>
      )}
      <div className="row end">
        <button type="button" onClick={onClose} data-testid="rewind-cancel">
          {T.rewindCancel}
        </button>
        {ready && preview.changes.length > 0 && (
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => {
              setBusy(true)
              void store.applyRewind(turn).then(() => onClose())
            }}
            data-testid="rewind-confirm"
          >
            {T.rewindConfirm}
          </button>
        )}
      </div>
    </Modal>
  )
}

function PathGroup({ title, paths, testId }: { readonly title: string; readonly paths: readonly string[]; readonly testId: string }): JSX.Element {
  return (
    <div className="rewind-group" data-testid={testId}>
      <div className="small">{title}</div>
      <ul className="change-list">
        {paths.map(path => (
          <li key={path}>
            <code>{path}</code>
          </li>
        ))}
      </ul>
    </div>
  )
}
