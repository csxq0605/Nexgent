import { useEffect, type ReactNode } from 'react'
import { T } from '../strings.js'
import { Icon } from './Icon.js'

interface Props {
  readonly title: string
  readonly lead?: string
  readonly onClose: () => void
  readonly testId?: string
  /** Between the header and the scrolling body (a section switch). */
  readonly bar?: ReactNode
  /** Beside the title, before the way back (the settings page's “已保存”). */
  readonly aside?: ReactNode
  readonly children: ReactNode
}

/**
 * A full page in the main area (能力, 设置; ADR 0020 §1): a header with the
 * way back to the conversation, then a scrolling body. Escape goes back too,
 * unless a dialog is open over it.
 */
export function Page({ title, lead, onClose, testId, bar, aside, children }: Props): JSX.Element {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || document.querySelector('.backdrop') !== null) return
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <section className="page" role="region" aria-label={title} data-testid={testId}>
      <header className="page-head">
        <div className="inner">
          <div className="page-head-row">
            <div className="grow">
              <h2 className="page-title">{title}</h2>
              {lead !== undefined && <p>{lead}</p>}
            </div>
            {aside}
            <button type="button" className="ghost" onClick={onClose} data-testid="page-back">
              <Icon name="back" />
              {T.backToChat}
            </button>
          </div>
          {bar}
        </div>
      </header>
      <div className="page-body">
        <div className="inner">{children}</div>
      </div>
    </section>
  )
}
