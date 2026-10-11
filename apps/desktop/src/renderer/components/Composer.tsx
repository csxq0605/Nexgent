import { useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { MaterialMetadata } from '@nexgent/kernel'
import { useAppState, useAppStore } from '../hooks.js'
import { T } from '../strings.js'

/** The `@query` being typed right before the caret, if any. */
export function mentionAt(text: string, caret: number): { readonly start: number; readonly query: string } | undefined {
  const before = text.slice(0, caret)
  const match = /(^|\s)@([^\s@]*)$/.exec(before)
  if (match === null) return undefined
  return { start: caret - match[2]!.length - 1, query: match[2]! }
}

/** Material ids whose `@name` still appears in the text. */
export function mentionedIds(text: string, picked: ReadonlyMap<string, string>): string[] {
  return [...picked.entries()].filter(([name]) => text.includes(`@${name}`)).map(([, id]) => id)
}

/** The message box: Enter sends, Shift+Enter breaks a line, `@` picks a material; Stop replaces Send while a turn runs. */
export function Composer(): JSX.Element {
  const state = useAppState()
  const store = useAppStore()
  const [text, setText] = useState('')
  const [caret, setCaret] = useState(0)
  const [highlight, setHighlight] = useState(0)
  const [picked, setPicked] = useState<ReadonlyMap<string, string>>(new Map())
  const ref = useRef<HTMLTextAreaElement>(null)

  const mention = mentionAt(text, caret)
  const options = useMemo<readonly MaterialMetadata[]>(() => {
    if (mention === undefined) return []
    const q = mention.query.toLowerCase()
    return state.materials.filter(m => m.status === 'active' && m.originalName.toLowerCase().includes(q)).slice(0, 8)
  }, [mention, state.materials])

  const disabled = state.sessionId === undefined
  const fresh = state.freshMaterialIds.map(id => state.materials.find(m => m.id === id)).filter((m): m is MaterialMetadata => m !== undefined)

  const choose = (material: MaterialMetadata): void => {
    if (mention === undefined) return
    const insert = `@${material.originalName} `
    const next = text.slice(0, mention.start) + insert + text.slice(caret)
    const position = mention.start + insert.length
    setText(next)
    setCaret(position)
    setPicked(new Map(picked).set(material.originalName, material.id))
    setHighlight(0)
    requestAnimationFrame(() => {
      ref.current?.focus()
      ref.current?.setSelectionRange(position, position)
    })
  }

  const send = async (): Promise<void> => {
    if (state.running || text.trim() === '') return
    const ids = mentionedIds(text, picked)
    const sent = await store.send(text, ids)
    if (sent) {
      setText('')
      setCaret(0)
      setPicked(new Map())
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (options.length > 0 && mention !== undefined) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setHighlight((highlight + 1) % options.length)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setHighlight((highlight - 1 + options.length) % options.length)
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        choose(options[Math.min(highlight, options.length - 1)]!)
        return
      }
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      void send()
    }
  }

  return (
    <div className="composer" data-testid="composer">
      {fresh.length > 0 && (
        <div className="chips fresh">
          {fresh.map(m => (
            <span key={m.id} className="chip">
              📎 {m.originalName}
            </span>
          ))}
        </div>
      )}
      {mention !== undefined && (
        <ul className="mention-menu" role="listbox" data-testid="mention-menu">
          {options.length === 0 && <li className="muted small">{T.mentionNone}</li>}
          {options.map((m, index) => (
            <li key={m.id} role="option" aria-selected={index === highlight}>
              <button type="button" onMouseDown={event => event.preventDefault()} onClick={() => choose(m)}>
                {m.originalName}
              </button>
            </li>
          ))}
        </ul>
      )}
      <textarea
        ref={ref}
        data-testid="composer-input"
        aria-label={T.composerPlaceholder}
        placeholder={T.composerPlaceholder}
        value={text}
        disabled={disabled}
        rows={3}
        onChange={event => {
          setText(event.target.value)
          setCaret(event.target.selectionStart)
          setHighlight(0)
        }}
        onSelect={event => setCaret(event.currentTarget.selectionStart)}
        onKeyDown={onKeyDown}
      />
      <div className="composer-bar">
        {store.client?.canPickFiles === true && (
          <button type="button" className="ghost" onClick={() => void store.pickAndAddMaterials()} disabled={disabled}>
            📎 {T.attach}
          </button>
        )}
        <span className="muted small grow">{state.running ? (state.stopping ? T.stopping : T.busy) : ''}</span>
        {state.running ? (
          <button type="button" className="danger" onClick={() => void store.cancel()} disabled={state.stopping} data-testid="stop">
            ■ {T.stop}
          </button>
        ) : (
          <button type="button" className="primary" onClick={() => void send()} disabled={disabled || text.trim() === ''} data-testid="send">
            {T.send}
          </button>
        )}
      </div>
    </div>
  )
}
