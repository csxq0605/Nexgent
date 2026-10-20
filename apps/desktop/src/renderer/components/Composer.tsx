import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { MaterialMetadata } from '@nexgent/kernel'
import { useAppState, useAppStore } from '../hooks.js'
import { T, modelText } from '../strings.js'
import { Icon } from './Icon.js'

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

/** The message box: Enter sends (also while a turn runs: the turn takes the message), Shift+Enter breaks a line, `@` picks a material; Stop shows while a turn runs. */
export function Composer(): JSX.Element {
  const state = useAppState()
  const store = useAppStore()
  const [text, setText] = useState('')
  const [caret, setCaret] = useState(0)
  const [highlight, setHighlight] = useState(0)
  const [picked, setPicked] = useState<ReadonlyMap<string, string>>(new Map())
  const ref = useRef<HTMLTextAreaElement>(null)
  // Caret to restore after a mention is inserted: set right after that render commits,
  // before any further keystroke (a later frame could move the caret under the user's typing).
  const pendingCaret = useRef<number | undefined>(undefined)
  useLayoutEffect(() => {
    const position = pendingCaret.current
    if (position === undefined) return
    pendingCaret.current = undefined
    ref.current?.focus()
    ref.current?.setSelectionRange(position, position)
  })

  const mention = mentionAt(text, caret)
  const options = useMemo<readonly MaterialMetadata[]>(() => {
    if (mention === undefined) return []
    const q = mention.query.toLowerCase()
    return state.materials.filter(m => m.status === 'active' && m.originalName.toLowerCase().includes(q)).slice(0, 8)
  }, [mention, state.materials])

  const disabled = state.sessionId === undefined || state.creatingSession
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
    pendingCaret.current = position
  }

  const send = async (): Promise<void> => {
    if (text.trim() === '') return
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

  const insertMention = (): void => {
    const el = ref.current
    const at = el?.selectionStart ?? text.length
    const before = text.slice(0, at)
    const insert = before === '' || /\s$/.test(before) ? '@' : ' @'
    const next = before + insert + text.slice(at)
    const position = at + insert.length
    setText(next)
    setCaret(position)
    setHighlight(0)
    pendingCaret.current = position
  }

  const placeholder = state.timeline.length === 0 ? T.composerPlaceholder : T.composerPlaceholderMore
  const model = state.sessionMeta?.model
  // ADR 0022 decision 1: say when commands run without an OS sandbox; never claim one.
  const status = state.sessionMeta?.sandboxMode === 'full-access' ? undefined : state.sessionMeta?.commandSandbox
  const sandboxNote = status?.kind === 'none' ? { text: T.noOsSandbox, title: status.reason } : status?.kind === 'off' ? { text: T.osSandboxOff, title: 'commands.systemSandbox: off' } : undefined
  return (
    <div className="composer" data-testid="composer">
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
      <div className="composer-box">
        {fresh.length > 0 && (
          <div className="chips fresh">
            {fresh.map(m => (
              <span key={m.id} className="chip">
                <Icon name="paperclip" />
                {m.originalName}
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={ref}
          data-testid="composer-input"
          aria-label={T.composerPlaceholder}
          placeholder={placeholder}
          value={text}
          disabled={disabled}
          rows={2}
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
            <button type="button" className="chip-button" onClick={() => void store.pickAndAddMaterials()} disabled={disabled} data-testid="attach-files">
              <Icon name="paperclip" />
              {T.attach}
            </button>
          )}
          <button type="button" className="chip-button" onMouseDown={event => event.preventDefault()} onClick={insertMention} disabled={disabled} data-testid="mention-button">
            {T.mentionChip}
          </button>
          {model !== undefined && <span className="faint small model-chip">{modelText(model)}</span>}
          {state.timeline.length === 0 && state.sessionMeta !== undefined && !state.running ? (
            // Rework D3: a conversation can start in plan mode until its first message.
            <button
              type="button"
              className={state.sessionMeta.plan === true ? 'chip-button active' : 'chip-button'}
              aria-pressed={state.sessionMeta.plan === true}
              title={T.planStartHelp}
              onClick={() => void store.setPlan(state.sessionMeta?.plan !== true)}
              disabled={disabled}
              data-testid="plan-start"
            >
              <Icon name="list" />
              {T.planStart}
            </button>
          ) : (
            state.sessionMeta?.plan === true && <span className="faint small model-chip" title={T.planModeHelp} data-testid="plan-chip">{T.planMode}</span>
          )}
          {sandboxNote !== undefined && <span className="faint small model-chip" title={sandboxNote.title} data-testid="sandbox-note">{sandboxNote.text}</span>}
          <span className="composer-status">{state.running ? (state.stopping ? T.stopping : T.busy) : ''}</span>
          {state.running && (
            <button type="button" className="send-button" aria-label={T.stop} title={T.stop} onClick={() => void store.cancel()} disabled={state.stopping} data-testid="stop">
              <Icon name="stop" />
            </button>
          )}
          {(!state.running || text.trim() !== '') && (
            <button type="button" className="send-button" aria-label={T.send} title={T.send} onClick={() => void send()} disabled={disabled || text.trim() === ''} data-testid="send">
              <Icon name="send" />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
