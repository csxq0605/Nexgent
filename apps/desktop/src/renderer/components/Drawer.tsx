import { useEffect, useState, type FormEvent } from 'react'
import type { DeliverableSummary } from '@nexgent/kernel'
import { useAppState, useAppStore } from '../hooks.js'
import { T, fileKind, formatBytes, formatTime, isAbsolutePath } from '../strings.js'
import { useUi, useView, useViewActions } from '../ui.js'
import { Icon } from './Icon.js'

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
      {active.length === 0 ? (
        <p className="muted">{T.noMaterials}</p>
      ) : (
        <ul className="item-list" data-testid="material-list">
          {active.map(m => (
            <li key={m.id} className="item" data-testid="material-item">
              <span className="file-badge small">{fileKind(m.originalName)}</span>
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
      {store.client?.canPickFiles === true && (
        <button type="button" className="primary full" onClick={() => void store.pickAndAddMaterials()} data-testid="pick-files">
          <Icon name="plus" />
          {T.addMaterial}
        </button>
      )}
      <form className="inline-form" onSubmit={add}>
        <input value={path} onChange={event => setPath(event.target.value)} placeholder={T.materialPathPlaceholder} aria-label={T.materialPathPlaceholder} data-testid="material-path" spellCheck={false} />
        <button type="submit" disabled={path.trim() === ''} data-testid="add-material">
          {T.addByPath}
        </button>
      </form>
      {invalid && <p className="field-error">{T.pathMustBeAbsolute}</p>}
      <p className="muted small">{T.dropHint}</p>
    </div>
  )
}

function DeliverableItems({ items, testId }: { readonly items: readonly DeliverableSummary[]; readonly testId: string }): JSX.Element {
  const ui = useUi()
  return (
    <ul className="item-list" data-testid={testId}>
      {[...items].reverse().map(d => {
        const latest = d.versions[d.versions.length - 1]
        return (
          <li key={d.deliverableId} className="item column" data-testid="deliverable-item">
            <button type="button" className="item-button" onClick={() => latest && ui.openDeliverable({ deliverableId: d.deliverableId, version: latest.version, mode: 'preview' })}>
              <span className="item-row">
                <span className="file-badge small">{fileKind(latest?.files[0]?.path ?? d.title)}</span>
                <span className="item-main">
                  <span className="item-title ellipsis">{d.title}</span>
                  <span className="muted small ellipsis">
                    {latest === undefined ? '' : T.versionLong(latest.version)}
                    {latest?.memberName !== undefined && ` · ${T.byMember(latest.memberName)}`}
                    {latest?.summary !== undefined && latest.summary !== '' && ` · ${latest.summary}`}
                  </span>
                </span>
              </span>
            </button>
            {d.versions.length > 1 && (
              <div className="versions">
                {d.versions.map(v => (
                  <button type="button" key={v.version} className="version-pill" onClick={() => ui.openDeliverable({ deliverableId: d.deliverableId, version: v.version, mode: 'preview' })}>
                    {T.versionLong(v.version)}
                  </button>
                ))}
              </div>
            )}
          </li>
        )
      })}
    </ul>
  )
}

/** The project's deliverables: the main conversations' first, then what members presented. */
function Deliverables(): JSX.Element {
  const state = useAppState()
  if (state.deliverables.length === 0) return <p className="muted panel-section">{T.noDeliverables}</p>
  const byMember = (d: DeliverableSummary): boolean => d.versions[d.versions.length - 1]?.memberName !== undefined
  const finals = state.deliverables.filter(d => !byMember(d))
  const members = state.deliverables.filter(byMember)
  return (
    <div className="panel-section" data-testid="deliverable-list">
      {members.length > 0 && <div className="panel-label">{T.finalDeliverables}</div>}
      {finals.length > 0 && <DeliverableItems items={finals} testId="final-deliverables" />}
      {members.length > 0 && (
        <>
          <div className="panel-label">{T.memberDeliverablesTitle}</div>
          <DeliverableItems items={members} testId="member-deliverables" />
        </>
      )}
    </div>
  )
}

const TABS = [
  { id: 'materials', label: T.panelMaterials },
  { id: 'deliverables', label: T.panelDeliverables },
] as const

/** The 资料与成果 drawer (ADR 0020 §1): opens from the conversation's top bar, closed by default; Escape closes it. */
export function Drawer(): JSX.Element | null {
  const state = useAppState()
  const { drawer } = useView()
  const { setDrawer } = useViewActions()
  useEffect(() => {
    if (drawer === undefined) return undefined
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && document.querySelector('.backdrop') === null) setDrawer(undefined)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [drawer, setDrawer])
  if (drawer === undefined) return null
  const counts = { materials: state.materials.filter(m => m.status === 'active').length, deliverables: state.deliverables.length }
  return (
    <aside className="drawer" aria-label={T.drawerTitle} data-testid="drawer">
      <div className="drawer-head">
        <div className="tabs" role="tablist">
          {TABS.map(t => (
            <button type="button" key={t.id} role="tab" aria-selected={drawer === t.id} className={drawer === t.id ? 'tab active' : 'tab'} onClick={() => setDrawer(t.id)} data-testid={`tab-${t.id}`}>
              {t.label}
              {counts[t.id] > 0 && <span className="count">{counts[t.id]}</span>}
            </button>
          ))}
        </div>
        <span className="grow" />
        <button type="button" className="icon" aria-label={T.drawerClose} title={T.drawerClose} onClick={() => setDrawer(undefined)} data-testid="drawer-close">
          <Icon name="close" />
        </button>
      </div>
      <div className="panel-body">{drawer === 'materials' ? <Materials /> : <Deliverables />}</div>
    </aside>
  )
}
