import { useEffect, useRef, type ReactNode } from 'react'
import { T } from '../strings.js'

interface Props {
  readonly title: string
  readonly onClose?: () => void
  readonly children: ReactNode
  readonly wide?: boolean
  readonly testId?: string
}

/** A centered dialog over a dimmed backdrop; Escape closes it when closable. */
export function Modal({ title, onClose, children, wide, testId }: Props): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.focus()
    if (onClose === undefined) return undefined
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="backdrop">
      <div className={wide ? 'modal wide' : 'modal'} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref} data-testid={testId}>
        <header className="modal-head">
          <h2>{title}</h2>
          {onClose !== undefined && (
            <button type="button" className="icon" aria-label={T.close} onClick={onClose}>
              ×
            </button>
          )}
        </header>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  )
}
