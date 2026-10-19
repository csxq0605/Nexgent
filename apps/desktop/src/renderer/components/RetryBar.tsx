import { useState } from 'react'
import type { RetryFileChange, RetryView } from '@nexgent/sdk'
import { useAppState, useAppStore } from '../hooks.js'
import { R } from '../retry-strings.js'

/** Files shown per side before "还有 N 个文件". */
const SHOWN_FILES = 5

function Files({ files }: { readonly files: readonly RetryFileChange[] }): JSX.Element {
  if (files.length === 0) return <p className="muted small">{R.noFiles}</p>
  return (
    <ul className="retry-files">
      {files.slice(0, SHOWN_FILES).map(file => (
        <li key={file.path} className="ellipsis" title={file.path}>
          <span className={`badge change-${file.change === 'changed' ? 'modified' : file.change}`}>{R.changeBadge[file.change]}</span> <code>{file.path}</code>
        </li>
      ))}
      {files.length > SHOWN_FILES && <li className="muted small">{R.moreFiles(files.length - SHOWN_FILES)}</li>}
    </ul>
  )
}

/** The finished copy next to the original, and the two choices. */
function Compare({ retry }: { readonly retry: RetryView }): JSX.Element {
  const store = useAppStore()
  const [busy, setBusy] = useState(false)
  const choose = (keep: 'retry' | 'original'): void => {
    setBusy(true)
    void store.chooseRetry(retry.retryId, keep).finally(() => setBusy(false))
  }
  return (
    <aside className="retry-card" data-testid="retry-card">
      <div className="retry-sides">
        <section>
          <div className="setting-name">{R.original(retry.original.side)}</div>
          <p className="muted small">{R.cost(retry.original.usd)}</p>
          <Files files={retry.original.files.map(path => ({ path, change: 'changed' as const }))} />
        </section>
        <section>
          <div className="setting-name">{R.retry(retry.retry.side)}</div>
          <p className="muted small">{R.cost(retry.retry.usd)}</p>
          <Files files={retry.retry.files ?? []} />
          {retry.retry.reply !== undefined && (
            <details className="retry-reply">
              <summary className="small">{R.reply}</summary>
              <p className="small wrap">{retry.retry.reply}</p>
            </details>
          )}
        </section>
      </div>
      <div className="row retry-actions">
        <button type="button" className="ghost" disabled={busy} onClick={() => choose('original')} data-testid="retry-keep-original">
          {R.keepOriginal}
        </button>
        <button type="button" className="primary" disabled={busy} onClick={() => choose('retry')} data-testid="retry-use-new">
          {R.useNew}
        </button>
      </div>
    </aside>
  )
}

/**
 * "换个做法再试" under the conversation: a quiet button after a finished
 * task, one line while the copy works, the two results side by side when it
 * is done, and a one-line result with "撤销" after the new one is used.
 */
export function RetryBar(): JSX.Element | null {
  const state = useAppState()
  const store = useAppStore()
  const [hidden, setHidden] = useState<string | undefined>(undefined)
  const retry = state.retry
  if (retry === undefined || state.running || state.sessionLoading) return null
  const latest = retry.latest
  if (latest !== undefined && latest.retryId !== hidden) {
    if (latest.status === 'running') {
      return (
        <div className="retry-line" role="status" data-testid="retry-running">
          <span className="grow muted small">{R.running(latest.retry.side)}</span>
          <button type="button" className="link small" onClick={() => void store.stopRetry(latest.retryId)} data-testid="retry-stop">
            {R.stop}
          </button>
        </div>
      )
    }
    if (latest.status === 'ready') return <Compare retry={latest} />
    if (latest.status === 'applied') {
      return (
        <div className="retry-line" role="status" data-testid="retry-applied">
          <span className="grow small">{latest.undoable === true ? R.applied : `${R.applied}${R.undoUnavailable}`}</span>
          {latest.undoable === true && (
            <button type="button" className="link small" onClick={() => void store.undoRetry(latest.retryId)} data-testid="retry-undo">
              {R.undo}
            </button>
          )}
          <button type="button" className="link small" onClick={() => setHidden(latest.retryId)}>
            {R.dismiss}
          </button>
        </div>
      )
    }
    if (latest.status === 'failed' || latest.status === 'stopped' || latest.status === 'undone') {
      return (
        <div className="retry-line" role="status" data-testid="retry-ended">
          <span className="grow muted small">{latest.status === 'failed' ? R.failed(latest.retry.detail) : latest.status === 'stopped' ? R.stopped : R.undone}</span>
          <button type="button" className="link small" onClick={() => setHidden(latest.retryId)}>
            {R.dismiss}
          </button>
        </div>
      )
    }
  }
  const offer = retry.offer
  if (offer === undefined) return null
  return (
    <div className="retry-line" data-testid="retry-offer">
      <span className="grow" />
      <button type="button" className="link small" title={R.offerTitle(offer.side)} onClick={() => void store.startRetry()} data-testid="retry-start">
        {R.offer(offer.estimateUsd)}
      </button>
    </div>
  )
}
