import { useEffect, useState } from 'react'
import type { CostCap, Effort, SandboxMode, ThinkingMode } from '@nexgent/kernel'
import type { ProjectSettings, SettingsPatch } from '@nexgent/sdk'
import { useAppState, useAppStore } from '../hooks.js'
import { T, credentialText, effortText } from '../strings.js'
import { Page } from './Page.js'
import { readTheme, saveTheme, type Theme } from '../theme.js'

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
  const [autoImprove, setAutoImprove] = useState(true)
  const [improveTokens, setImproveTokens] = useState('')
  const [improveWindow, setImproveWindow] = useState('')
  const [shareEvidence, setShareEvidence] = useState(true)
  const userSettings = state.userSettings
  const [userStatus, setUserStatus] = useState<'idle' | 'saving' | 'saved' | 'invalid'>('idle')
  const [metaEnabled, setMetaEnabled] = useState(false)
  const [metaEvery, setMetaEvery] = useState('')
  const [metaTokens, setMetaTokens] = useState('')
  const [metaWindow, setMetaWindow] = useState('')
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
    setAutoImprove(settings.autoImprove)
    setImproveTokens(String(settings.improvement.budget.maxTokens))
    setImproveWindow(String(settings.improvement.budget.windowDays))
    setShareEvidence(settings.improvement.shareImproverEvidence)
    // Only when another project's settings arrive; edits in progress are kept otherwise.
  }, [state.project?.projectId, settings === undefined])

  // The user-level settings are read back from disk whenever the page opens.
  useEffect(() => {
    void store.refreshUserSettings()
  }, [])
  useEffect(() => {
    if (userSettings === undefined) return
    const meta = userSettings.improvement.meta
    setMetaEnabled(meta.enabled)
    setMetaEvery(String(meta.everyJobs))
    setMetaTokens(String(meta.budget.maxTokens))
    setMetaWindow(String(meta.budget.windowDays))
  }, [userSettings === undefined])

  const saveUser = async (): Promise<void> => {
    const everyJobs = Number(metaEvery.trim())
    const maxTokens = Number(metaTokens.trim())
    const windowDays = Number(metaWindow.trim())
    if (!Number.isInteger(everyJobs) || everyJobs < 1 || everyJobs > 20 || !Number.isInteger(maxTokens) || maxTokens <= 0 || !Number.isInteger(windowDays) || windowDays <= 0) {
      setUserStatus('invalid')
      return
    }
    setUserStatus('saving')
    const ok = await store.saveUserSettings({ improvement: { meta: { enabled: metaEnabled, everyJobs, budget: { maxTokens, windowDays }, model: userSettings!.improvement.meta.model } } })
    setUserStatus(ok ? 'saved' : 'idle')
  }

  const save = async (): Promise<void> => {
    const task = toCap(perTask, false)
    const project = toCap(perProject, true)
    const maxTokens = Number(improveTokens.trim())
    const windowDays = Number(improveWindow.trim())
    const improveInvalid = !Number.isInteger(maxTokens) || maxTokens <= 0 || !Number.isInteger(windowDays) || windowDays <= 0
    if (improveInvalid || task === 'invalid' || project === 'invalid' || model.trim() === '') {
      setStatus('invalid')
      return
    }
    const patch: SettingsPatch = {
      model: model.trim(),
      thinking,
      effort,
      sandboxMode,
      // Only what changed, so an untouched page never rewrites the guarded fields.
      ...(autoImprove === settings!.autoImprove ? {} : { autoImprove }),
      ...(maxTokens === settings!.improvement.budget.maxTokens &&
      windowDays === settings!.improvement.budget.windowDays &&
      shareEvidence === settings!.improvement.shareImproverEvidence
        ? {}
        : { improvement: { ...projectImprovement(settings!.improvement), budget: { maxTokens, windowDays }, shareImproverEvidence: shareEvidence } }),
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
    <Page title={T.settingsTitle} lead={T.settingsLead} onClose={onClose} testId="settings-page">
      <Appearance />
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
                  {effortText(e)}
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
          <h3>{T.panelImprovements}</h3>
          <label className="row">
            <input type="checkbox" checked={autoImprove} onChange={e => setAutoImprove(e.target.checked)} data-testid="settings-auto-improve" />
            {T.autoImprove}
          </label>
          <p className="muted small wrap">{T.autoImproveHelp}</p>
          <div className="caps">
            <label className="field">
              {T.improvementBudgetTokens}
              <input type="number" step={1} value={improveTokens} onChange={e => setImproveTokens(e.target.value)} data-testid="settings-improvement-budget" />
            </label>
            <label className="field">
              {T.improvementWindow}
              <input type="number" step={1} value={improveWindow} onChange={e => setImproveWindow(e.target.value)} data-testid="settings-improvement-window" />
            </label>
          </div>
          <h3>{T.settingsShareTitle}</h3>
          <label className="row">
            <input type="checkbox" checked={shareEvidence} onChange={e => setShareEvidence(e.target.checked)} data-testid="settings-share-improver" />
            {T.shareImproverEvidence}
          </label>
          <p className="muted small wrap">{T.shareImproverHelp}</p>
          <div className="row end">
            {status === 'saved' && <span className="ok-text" data-testid="settings-saved">{T.settingsSaved}</span>}
            {status === 'invalid' && <span className="field-error">请检查：模型不能为空，上限必须是正整数；改进预算和窗口也必须是正整数。</span>}
            <button type="submit" className="primary" disabled={status === 'saving'} data-testid="settings-save">
              {T.save}
            </button>
          </div>
        </form>
      )}
      <section className="stack" data-testid="settings-user-section">
        <h3>{T.settingsMeta}</h3>
        <p className="muted small wrap">{T.settingsMetaScope}</p>
        {userSettings === undefined ? (
          <p className="muted">{T.loading}</p>
        ) : (
          <form
            className="settings"
            onSubmit={event => {
              event.preventDefault()
              void saveUser()
            }}
          >
            <label className="row">
              <input type="checkbox" checked={metaEnabled} onChange={e => setMetaEnabled(e.target.checked)} data-testid="settings-meta-enabled" />
              {T.metaEnabled}
            </label>
            <p className="muted small wrap">{T.metaEnabledHelp}</p>
            <div className="caps">
              <label className="field">
                {T.metaEveryJobs}
                <input type="number" step={1} value={metaEvery} onChange={e => setMetaEvery(e.target.value)} data-testid="settings-meta-every" />
              </label>
              <label className="field">
                {T.metaBudgetTokens}
                <input type="number" step={1} value={metaTokens} onChange={e => setMetaTokens(e.target.value)} data-testid="settings-meta-budget" />
              </label>
              <label className="field">
                {T.metaWindow}
                <input type="number" step={1} value={metaWindow} onChange={e => setMetaWindow(e.target.value)} data-testid="settings-meta-window" />
              </label>
            </div>
            <div className="row end">
              {userStatus === 'saved' && <span className="ok-text" data-testid="settings-user-saved">{T.settingsSaved}</span>}
              {userStatus === 'invalid' && <span className="field-error">{T.settingsUserInvalid}</span>}
              <button type="submit" className="primary" disabled={userStatus === 'saving'} data-testid="settings-user-save">
                {T.settingsUserSave}
              </button>
            </div>
          </form>
        )}
      </section>
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
    </Page>
  )
}

const THEMES: ReadonlyArray<{ readonly id: Theme; readonly label: string }> = [
  { id: 'system', label: T.themeSystem },
  { id: 'light', label: T.themeLight },
  { id: 'dark', label: T.themeDark },
]

/** 外观: follow the system, or fix light or dark (ADR 0020 §5); applies at once, per machine. */
function Appearance(): JSX.Element {
  const [theme, setTheme] = useState<Theme>(readTheme)
  return (
    <section className="setting-row" data-testid="settings-appearance">
      <div className="grow">
        <div className="setting-name">{T.appearance}</div>
        <div className="muted">{T.appearanceHint}</div>
      </div>
      <div className="segmented inline" role="radiogroup" aria-label={T.appearance}>
        {THEMES.map(t => (
          <button
            type="button"
            key={t.id}
            role="radio"
            aria-checked={theme === t.id}
            aria-selected={theme === t.id}
            onClick={() => {
              setTheme(t.id)
              saveTheme(t.id)
            }}
            data-testid={`theme-${t.id}`}
          >
            {t.label}
          </button>
        ))}
      </div>
    </section>
  )
}

/** The project's improvement settings without the deprecated `meta` (ADR 0012: meta settings are the user's), so a save does not write it. */
function projectImprovement(improvement: ProjectSettings['improvement']): Omit<ProjectSettings['improvement'], 'meta'> {
  const { meta: _deprecated, ...rest } = improvement
  return rest
}
