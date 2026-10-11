import { useAppState, useAppStore } from '../hooks.js'
import { T, errorText } from '../strings.js'

/** Errors from failed calls, stacked at the top of the window until dismissed. */
export function Notices(): JSX.Element | null {
  const { notices } = useAppState()
  const store = useAppStore()
  if (notices.length === 0) return null
  return (
    <div className="notices" role="status">
      {notices.slice(-3).map(notice => (
        <div key={notice.id} className="notice" role="alert" data-testid="notice">
          <span>{errorText(notice.error)}</span>
          <button type="button" className="link" onClick={() => store.dismissNotice(notice.id)}>
            {T.dismiss}
          </button>
        </div>
      ))}
    </div>
  )
}
