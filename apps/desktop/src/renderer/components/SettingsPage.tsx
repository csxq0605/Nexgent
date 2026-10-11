import { useEffect, useState } from 'react'
import type { CostCap, Effort, SandboxMode, ThinkingMode } from '@nexgent/kernel'
import type { ProjectSettings, SettingsPatch } from '@nexgent/sdk'
import { useAppState, useAppStore } from '../hooks.js'
import { T, credentialText } from '../strings.js'
import { Modal } from './Modal.js'

const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
const SANDBOX: ReadonlyArray<{ readonly value: SandboxMode; readonly label: string }> = [
  { value: 'read-only', label: T.sandboxReadOnly },
  { value: 'workspace-write', label: T.sandboxWorkspace },
  { value: 'full-access', label: T.sandboxFull },
]

interface CapFields {
  maxTokens: string
  maxRequests: string
  windowDays: string
}

const capFields = (cap: CostCap | undefined): CapFields => ({
  maxTokens: cap?.maxTokens?.toString() ?? '',
  maxRequests: cap?.maxRequests?.toString() ?? '',
  windowDays: cap?.windowDays?.toString() ?? '',
})

/** Parse the cap inputs; empty fields are left out, an all-empty cap is `undefined`, a bad number is an error. */
export function toCap(fields: CapFields, allowWindow: boolean): CostCap | undefined | 'invalid' {
  const out: { maxTokens?: number; maxRequests?: number; windowDays?: number } = {}
  const entries: Array<[keyof CapFields, string]> = [
    ['maxTokens', fields.maxTokens],
    ['maxRequests', fields.maxRequests],
    ...(allowWindow ? ([['windowDays', fields.windowDays]] as Array<[keyof CapFields, string]>) : []),
  ]
  for (const [key, raw] of entries) {
    const text = raw.trim()
    if (text === '') continue
    const value = Number(text)
    if (!Number.isInteger(value) || value <= 0) return 'invalid'
    out[key] = value
  }
  return Object.keys(out).length === 0 ? undefined : out
}

function CapEditor({ label, fields, onChange, allowWindow, testId }: { readonly label: string; readonly fields: CapFields; readonly onChange: (f: CapFields) => void; readonly allowWindow: boolean; readonly testId: string }): JSX.Element {
  return (
    <fieldset className="cap" data-testid={testId}>
      <legend>{label}</legend>
      <label>
        {T.maxTokens}
        <input inputMode="numeric" value={fields.maxTokens} placeholder={T.unlimited} onChange={e => onChange({ ...fields, maxTokens: e.target.value })} data-testid={`${testId}-tokens`} />
      </label>
      <label>
        {T.maxRequests}
        <input inputMode="numeric" value={fields.maxRequests} placeholder={T.unlimited} onChange={e => onChange({ ...fields, maxRequests: e.target.value })} data-testid={`${testId}-requests`} />
      </label>
      {allowWindow && (
        <label>
          {T.windowDays}
          <input inputMode="numeric" value={fields.windowDays} placeholder="30" onChange={e => onChange({ ...fields, windowDays: e.target.value })} data-testid={`${testId}-window`} />
        </label>
      )}
    </fieldset>
  )
}

/** Project settings (model, thinking, effort, sandbox, cost caps) and the API key, which is written but never shown. */
export function SettingsPage({ onClose }: { readonly onClose: () => void }): JSX.Element {
  const state = useAppState()
  const store = useAppStore()
  const settings: ProjectSettings | undefined = state.settings
  const [model, setModel] = useState('')
  const [thinking, setThinking] = useState<ThinkingMode>('on')
  const [effort, setEffort] = useState<Effort>('medium')
  const [sandboxMode, setSandboxMode] = useState<SandboxMode>('workspace-write')
  const [perTask, setPerTask] = useState<CapFields>(capFields(undefined))
  const [perProject, setPerProject] = useState<CapFields>(capFields(undefined))
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'invalid'>('idle')
  const [key, setKey] = useState('')
  const [keyStatus, setKeyStatus] = useState<'idle' | 'saving' | 'saved'>('idle')

  useEffect(() => {
    if (settings === undefined) return
    setModel(settings.model)
    setThinking(settings.thinking)
    setEffort(settings.effort)
    setSandboxMode(settings.sandboxMode)
    setPerTask(capFields(settings.costCaps.perTask))
    setPerProject(capFields(settings.costCaps.perProject))
    // Only when another project's settings arrive; edits in progress are kept otherwise.
  }, [state.project?.projectId, settings === undefined])

  const save = async (): Promise<void> => {
    const task = toCap(perTask, false)
    const project = toCap(perProject, true)
    if (task === 'invalid' || project === 'invalid' || model.trim() === '') {
      setStatus('invalid')
      return
    }
    const patch: SettingsPatch = {
      model: model.trim(),
      thinking,
      effort,
      sandboxMode,
      costCaps: { ...(task === undefined ? {} : { perTask: task }), ...(project === undefined ? {} : { perProject: project }) },
    }
    setStatus('saving')
    setStatus((await store.saveSettings(patch)) ? 'saved' : 'idle')
  }

  const saveKey = async (value: string): Promise<void> => {
    setKeyStatus('saving')
    const ok = await store.setApiKey(value)
    // The value leaves the page with this one call; the field is cleared either way.
    setKey('')
    setKeyStatus(ok ? 'saved' : 'idle')
  }

  return (
    <Modal title={T.settingsTitle} onClose={onClose} testId="settings-page">
      {settings === undefined ? (
        <p className="muted">{T.loading}</p>
      ) : (
        <form
          className="settings"
          onSubmit={event => {
            event.preventDefault()
            void save()
          }}
        >
          <h3>{T.settingsProject}</h3>
          <label className="field">
            {T.model}
            <input value={model} onChange={e => setModel(e.target.value)} data-testid="setting-model" spellCheck={false} />
          </label>
          <label className="field">
            {T.thinkingMode}
            <select value={thinking} onChange={e => setThinking(e.target.value as ThinkingMode)} data-testid="setting-thinking">
              <option value="on">{T.thinkingOn}</option>
              <option value="off">{T.thinkingOff}</option>
            </select>
          </label>
          <label className="field">
            {T.effort}
            <select value={effort} onChange={e => setEffort(e.target.value as Effort)} data-testid="setting-effort">
              {EFFORTS.map(e => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            {T.sandbox}
            <select value={sandboxMode} onChange={e => setSandboxMode(e.target.value as SandboxMode)} data-testid="setting-sandbox">
              {SANDBOX.map(s => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <h3>{T.costCaps}</h3>
          <div className="caps">
            <CapEditor label={T.perTask} fields={perTask} onChange={setPerTask} allowWindow={false} testId="cap-task" />
            <CapEditor label={T.perProject} fields={perProject} onChange={setPerProject} allowWindow testId="cap-project" />
          </div>
          <div className="row end">
            {status === 'saved' && <span className="ok-text" data-testid="settings-saved">{T.settingsSaved}</span>}
            {status === 'invalid' && <span className="field-error">请检查：模型不能为空，上限必须是正整数。</span>}
            <button type="submit" className="primary" disabled={status === 'saving'} data-testid="settings-save">
              {T.save}
            </button>
          </div>
        </form>
      )}
      <section className="api-key" data-testid="api-key-section">
        <h3>{T.apiKey}</h3>
        <p data-testid="api-key-status">{credentialText(settings?.apiKey)}</p>
        <form
          className="inline-form"
          onSubmit={event => {
            event.preventDefault()
            if (key !== '') void saveKey(key)
          }}
        >
          <input type="password" autoComplete="off" value={key} placeholder={T.apiKeyPlaceholder} aria-label={T.apiKey} onChange={e => setKey(e.target.value)} data-testid="api-key-input" />
          <button type="submit" disabled={key === '' || keyStatus === 'saving'} data-testid="api-key-save">
            {T.apiKeySave}
          </button>
        </form>
        {settings?.apiKey.source === 'file' && (
          <button type="button" className="link small" onClick={() => void saveKey('')}>
            {T.apiKeyRemove}
          </button>
        )}
        {keyStatus === 'saved' && <p className="ok-text small">{T.saved}</p>}
      </section>
    </Modal>
  )
}
