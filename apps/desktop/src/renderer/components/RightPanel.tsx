import { useEffect, useMemo, useState, type FormEvent } from 'react'
import type { FileChange } from '@nexgent/kernel'
import { useAppState, useAppStore } from '../hooks.js'
import { T, fileChangeText, formatBytes, formatTime, goalStatusText, isAbsolutePath } from '../strings.js'
import { useUi, type PanelTab } from '../ui.js'

const TABS: ReadonlyArray<{ readonly id: PanelTab; readonly label: string }> = [
  { id: 'materials', label: T.panelMaterials },
  { id: 'deliverables', label: T.panelDeliverables },
  { id: 'files', label: T.panelFiles },
  { id: 'goal', label: T.panelGoal },
]

function Materials(): JSX.Element {
  const state = useAppState()
  const store = useAppStore()
  const [path, setPath] = useState('')
  const [invalid, setInvalid] = useState(false)
  const add = (event: FormEvent): void => {
    event.preventDefault()
    const value = path.trim()
    if (!isAbsolutePath(value)) {
      setInvalid(true)
      return
    }
    setInvalid(false)
    setPath('')
    void store.addMaterials([value])
  }
  const active = state.materials.filter(m => m.status === 'active')
  return (
    <div className="panel-section" data-testid="materials-panel">
      {store.client?.canPickFiles === true && (
        <button type="button" className="primary full" onClick={() => void store.pickAndAddMaterials()} data-testid="pick-files">
          ＋ {T.attach}
        </button>
      )}
      <form className="inline-form" onSubmit={add}>
        <input value={path} onChange={event => setPath(event.target.value)} placeholder={T.materialPathPlaceholder} aria-label={T.materialPathPlaceholder} data-testid="material-path" spellCheck={false} />
        <button type="submit" disabled={path.trim() === ''} data-testid="add-material">
          {T.addByPath}
        </button>
      </form>
      {invalid && <p className="field-error">{T.pathMustBeAbsolute}</p>}
      {active.length === 0 ? (
        <p className="muted small">{T.noMaterials}</p>
      ) : (
        <ul className="item-list" data-testid="material-list">
          {active.map(m => (
            <li key={m.id} className="item" data-testid="material-item">
              <div className="item-main">
                <span className="item-title ellipsis" title={m.originalName}>
                  {m.originalName}
                </span>
                <span className="muted small">
                  {formatBytes(m.size)} · {formatTime(m.addedAt)}
                </span>
              </div>
              <button type="button" className="link small" onClick={() => void store.removeMaterial(m.id)}>
                {T.removeMaterial}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Deliverables(): JSX.Element {
  const state = useAppState()
  const ui = useUi()
  if (state.deliverables.length === 0) return <p className="muted small panel-section">{T.noDeliverables}</p>
  return (
    <ul className="item-list panel-section" data-testid="deliverable-list">
      {[...state.deliverables].reverse().map(d => {
        const latest = d.versions[d.versions.length - 1]
        return (
          <li key={d.deliverableId} className="item column" data-testid="deliverable-item">
            <button type="button" className="item-button" onClick={() => latest && ui.openDeliverable({ deliverableId: d.deliverableId, version: latest.version, mode: 'preview' })}>
              <span className="item-title ellipsis">{d.title}</span>
              <span className="muted small">{latest?.summary}</span>
            </button>
            <div className="versions">
              {d.versions.map(v => (
                <button type="button" key={v.version} className="version-pill" onClick={() => ui.openDeliverable({ deliverableId: d.deliverableId, version: v.version, mode: 'preview' })}>
                  {T.version(v.version)}
                </button>
              ))}
            </div>
          </li>
        )
      })}
    </ul>
  )
}

/** The project folder's files (`files.list`), marking the ones this conversation changed. */
function Files(): JSX.Element {
  const state = useAppState()
  const store = useAppStore()
  useEffect(() => {
    void store.refreshFiles()
  }, [store, state.project?.projectId])
  const changed = useMemo(() => {
    const latest = new Map<string, FileChange['change']>()
    for (const entry of state.timeline) if (entry.kind === 'files') for (const change of entry.changes) latest.set(change.path, change.change)
    return latest
  }, [state.timeline])
  const listing = state.projectFiles
  const present = new Set(listing?.files.map(f => f.path))
  const deleted = [...changed.entries()].filter(([path, change]) => change === 'deleted' && !present.has(path)).map(([path]) => path)
  return (
    <div className="panel-section" data-testid="files-panel">
      <div className="row between">
        <span className="muted small ellipsis" title={state.project?.root}>{state.project?.root}</span>
        <button type="button" className="link small" onClick={() => void store.refreshFiles()} data-testid="refresh-files">
          {T.filesRefresh}
        </button>
      </div>
      {listing === undefined ? (
        <p className="muted small">{T.loading}</p>
      ) : listing.files.length === 0 && deleted.length === 0 ? (
        <p className="muted small">{T.noFiles}</p>
      ) : (
        <ul className="item-list" data-testid="file-list">
          {listing.files.map(file => {
            const change = changed.get(file.path)
            return (
              <li key={file.path} className="item" data-testid="file-item">
                <div className="item-main">
                  <code className="ellipsis" title={file.path}>
                    {file.path}
                  </code>
                  <span className="muted small">
                    {formatBytes(file.size)} · {formatTime(file.modifiedAt)}
                  </span>
                </div>
                {change !== undefined && (
                  <span className={`badge change-${change}`} title={T.filesChangedHere}>
                    {fileChangeText(change)}
                  </span>
                )}
              </li>
            )
          })}
          {deleted.map(path => (
            <li key={path} className="item" data-testid="file-item">
              <code className="ellipsis muted" title={path}>
                {path}
              </code>
              <span className="badge change-deleted" title={T.filesChangedHere}>
                {fileChangeText('deleted')}
              </span>
            </li>
          ))}
        </ul>
      )}
      {listing?.truncated === true && <p className="muted small">{T.filesTruncated(listing.files.length)}</p>}
    </div>
  )
}

function GoalPanel(): JSX.Element {
  const state = useAppState()
  const store = useAppStore()
  const [text, setText] = useState('')
  if (state.sessionId === undefined) return <p className="muted small panel-section">{T.noSessionTitle}</p>
  const goal = state.goal
  return (
    <div className="panel-section" data-testid="goal-panel">
      {goal === null ? (
        <p className="muted small">{T.goalNone}</p>
      ) : (
        <div className="goal">
          <p>{goal.text}</p>
          <p className="small">
            <span className={`badge goal-${goal.status}`}>{goalStatusText(goal.status)}</span> <span className="muted">{formatTime(goal.updatedAt)}</span>
          </p>
          {goal.note !== undefined && <p className="muted small">{goal.note}</p>}
          <div className="row">
            {goal.status === 'active' ? (
              <>
                <button type="button" onClick={() => void store.updateGoal('completed')}>
                  {T.goalComplete}
                </button>
                <button type="button" className="ghost" onClick={() => void store.updateGoal('abandoned')}>
                  {T.goalAbandon}
                </button>
              </>
            ) : (
              <button type="button" onClick={() => void store.updateGoal('active')}>
                {T.goalReopen}
              </button>
            )}
          </div>
        </div>
      )}
      <form
        className="stack"
        onSubmit={event => {
          event.preventDefault()
          void store.setGoal(text).then(() => setText(''))
        }}
      >
        <textarea value={text} rows={2} onChange={event => setText(event.target.value)} placeholder={T.goalPlaceholder} aria-label={T.goalPlaceholder} />
        <button type="submit" disabled={text.trim() === ''}>
          {T.setGoal}
        </button>
      </form>
    </div>
  )
}

/** Right column: the project's materials, deliverables, files and the conversation's goal. */
export function RightPanel({ tab, onTab }: { readonly tab: PanelTab; readonly onTab: (tab: PanelTab) => void }): JSX.Element {
  const state = useAppState()
  const counts: Partial<Record<PanelTab, number>> = {
    materials: state.materials.filter(m => m.status === 'active').length,
    deliverables: state.deliverables.length,
  }
  return (
    <aside className="right-panel" data-testid="right-panel">
      <div className="tabs" role="tablist">
        {TABS.map(t => (
          <button type="button" key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'tab active' : 'tab'} onClick={() => onTab(t.id)} data-testid={`tab-${t.id}`}>
            {t.label}
            {counts[t.id] !== undefined && counts[t.id]! > 0 && <span className="count">{counts[t.id]}</span>}
          </button>
        ))}
      </div>
      <div className="panel-body">
        {tab === 'materials' && <Materials />}
        {tab === 'deliverables' && <Deliverables />}
        {tab === 'files' && <Files />}
        {tab === 'goal' && <GoalPanel />}
      </div>
    </aside>
  )
}
