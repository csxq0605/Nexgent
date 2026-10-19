import { useAppState, useAppStore } from '../hooks.js'
import { T, errorText } from '../strings.js'

/** Errors from failed calls (and a missing PowerShell 7), stacked at the top of the window until dismissed. */
export function Notices(): JSX.Element | null {
  const { notices, shellMissing } = useAppState()
  const store = useAppStore()
  if (notices.length === 0 && shellMissing !== true) return null
  return (
    <div className="notices" role="status">
      {shellMissing === true && (
        <div className="notice" role="alert" data-testid="shell-missing">
          <span>{T.shellMissing}</span>
          <button type="button" className="link" onClick={() => store.dismissShellMissing()}>
            {T.dismiss}
          </button>
        </div>
      )}
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
