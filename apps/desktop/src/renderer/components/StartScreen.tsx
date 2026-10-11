import { useState, type FormEvent } from 'react'
import { useAppState, useAppStore } from '../hooks.js'
import { T, formatTime, isAbsolutePath } from '../strings.js'
import markUrl from '../assets/mark.svg'

/** No project open: recent projects plus open / create by folder. */
export function StartScreen(): JSX.Element {
  const state = useAppState()
  const store = useAppStore()
  const [path, setPath] = useState('')
  const [invalid, setInvalid] = useState(false)
  const [busy, setBusy] = useState(false)

  const open = async (create: boolean): Promise<void> => {
    const root = path.trim()
    if (!isAbsolutePath(root)) {
      setInvalid(true)
      return
    }
    setInvalid(false)
    setBusy(true)
    await store.openProject(root, create)
    setBusy(false)
  }
  const onSubmit = (event: FormEvent): void => {
    event.preventDefault()
    void open(false)
  }

  return (
    <main className="start" data-testid="start-screen">
      <div className="start-card">
        <div className="brand-row">
          <img src={markUrl} alt="" className="brand-mark" />
          <div>
            <h1>{T.appName}</h1>
            <p className="muted">{T.tagline}</p>
          </div>
        </div>
        <h2>{T.startTitle}</h2>
        <p className="muted">{T.startHint}</p>
        {store.client?.canPickDirectory === true && (
          <button type="button" className="primary" onClick={() => void store.pickAndOpenProject(false)}>
            {T.chooseFolder}
          </button>
        )}
        <form className="path-form" onSubmit={onSubmit}>
          <label htmlFor="project-path">{T.folderPathLabel}</label>
          <input
            id="project-path"
            data-testid="project-path"
            value={path}
            placeholder={T.folderPathPlaceholder}
            onChange={event => setPath(event.target.value)}
            spellCheck={false}
          />
          {invalid && <p className="field-error">{T.pathMustBeAbsolute}</p>}
          <div className="row">
            <button type="submit" className="primary" disabled={busy || path.trim() === ''}>
              {T.openProject}
            </button>
            <button type="button" disabled={busy || path.trim() === ''} onClick={() => void open(true)} data-testid="create-project">
              {T.createProject}
            </button>
          </div>
        </form>
        <h3>{T.recentProjects}</h3>
        {state.recent.length === 0 ? (
          <p className="muted">{T.noRecent}</p>
        ) : (
          <ul className="recent" data-testid="recent-projects">
            {state.recent.map(project => (
              <li key={project.root}>
                <button type="button" className="recent-item" disabled={!project.exists} onClick={() => void store.openProject(project.root)} title={project.root}>
                  <span className="recent-name">{project.name}</span>
                  <span className="recent-root">{project.root}</span>
                  <span className="muted small">{project.exists ? formatTime(project.lastOpenedAt) : T.missingProject}</span>
                </button>
                <button type="button" className="link small" onClick={() => void store.forgetProject(project.root)}>
                  {T.forget}
                </button>
              </li>
            ))}
          </ul>
        )}
        {state.appVersion !== undefined && <p className="muted small app-version">v{state.appVersion}</p>}
      </div>
    </main>
  )
}
