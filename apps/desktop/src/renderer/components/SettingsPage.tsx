import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { CostCap, CostCaps, Effort, SandboxMode, ThinkingMode } from '@nexgent/kernel'
import type { ProjectSettings, SettingsPatch, UserSettingsPatch } from '@nexgent/sdk'
import { useAppState, useAppStore } from '../hooks.js'
import { L, T, credentialText, effortText } from '../strings.js'
import { readTheme, saveTheme, type Theme } from '../theme.js'
import { Switch } from './Learned.js'
import { Page } from './Page.js'

const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
const SANDBOX: ReadonlyArray<{ readonly value: SandboxMode; readonly label: string }> = [
  { value: 'read-only', label: T.sandboxReadOnly },
  { value: 'workspace-write', label: T.sandboxWorkspace },
  { value: 'full-access', label: T.sandboxFull },
]
/** Models offered in the list; any other id can still be typed. */
const MODELS = ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5']
const LANGUAGES: ReadonlyArray<{ readonly value: string; readonly label: string }> = [
  { value: '', label: L.languageAuto },
  { value: 'zh-CN', label: '简体中文' },
  { value: 'en', label: 'English' },
]
const GROUPS = ['general', 'model', 'permissions', 'cost', 'learning', 'advanced'] as const

interface CapFields {
  maxUsd: string
  maxTokens: string
  maxRequests: string
  windowDays: string
}

const capFields = (cap: CostCap | undefined): CapFields => ({
  maxUsd: cap?.maxUsd?.toString() ?? '',
  maxTokens: cap?.maxTokens?.toString() ?? '',
  maxRequests: cap?.maxRequests?.toString() ?? '',
  windowDays: cap?.windowDays?.toString() ?? '',
})

/** Parse a cap's inputs; empty fields are left out, an all-empty cap is `undefined`, a bad number is an error. Dollars may have cents, the rest are integers. */
export function toCap(fields: CapFields, allowWindow: boolean): CostCap | undefined | 'invalid' {
  const out: { maxUsd?: number; maxTokens?: number; maxRequests?: number; windowDays?: number } = {}
  const keys: Array<keyof CapFields> = ['maxUsd', 'maxTokens', 'maxRequests', ...(allowWindow ? (['windowDays'] as const) : [])]
  for (const key of keys) {
    const text = fields[key].trim()
    if (text === '') continue
    const value = Number(text)
    if (!Number.isFinite(value) || value <= 0 || (key !== 'maxUsd' && !Number.isInteger(value))) return 'invalid'
    out[key] = value
  }
  // A window alone limits nothing.
  return Object.keys(out).filter(key => key !== 'windowDays').length === 0 ? undefined : out
}

type SaveState = 'idle' | 'saving' | 'saved' | 'failed'

/**
 * Saves one after another (each a partial patch), so a quick second change
 * never races the first; the state is `saved` once the queue is empty and
 * every save in it went through.
 */
function useSaver(): { readonly state: SaveState; readonly run: (work: () => Promise<boolean>) => Promise<void>; readonly settle: () => void } {
  const [state, setState] = useState<SaveState>('idle')
  const queue = useRef<Promise<void>>(Promise.resolve())
  const pending = useRef(0)
  const failed = useRef(false)
  const run = (work: () => Promise<boolean>): Promise<void> => {
    pending.current += 1
    setState('saving')
    queue.current = queue.current.then(async () => {
      const ok = await work().catch(() => false)
      if (!ok) failed.current = true
      pending.current -= 1
      if (pending.current === 0) {
        setState(failed.current ? 'failed' : 'saved')
        failed.current = false
      }
    })
    return queue.current
  }
  // A field left without a change: nothing to send, but the page is up to date.
  const settle = (): void => {
    if (pending.current === 0) setState(current => (current === 'failed' ? current : 'saved'))
  }
  return { state, run, settle }
}

/** Settings as one page with six groups (ADR 0020, rework D2); every change saves at once. */
export function SettingsPage({ onClose }: { readonly onClose: () => void }): JSX.Element {
  const state = useAppState()
  const store = useAppStore()
  const settings: ProjectSettings | undefined = state.settings
  const userSettings = state.userSettings
  const project = useSaver()
  const user = useSaver()

  const [model, setModel] = useState('')
  const [caps, setCaps] = useState<Record<'perTask' | 'perConversation' | 'perProject', CapFields>>({ perTask: capFields(undefined), perConversation: capFields(undefined), perProject: capFields(undefined) })
  const [learnUsd, setLearnUsd] = useState('')
  const [learnDays, setLearnDays] = useState('')
  const [legacyTokens, setLegacyTokens] = useState('')
  const [legacyWindow, setLegacyWindow] = useState('')
  const [share, setShare] = useState(true)
  const [metaOn, setMetaOn] = useState(false)
  const [metaEvery, setMetaEvery] = useState('')
  const [metaTokens, setMetaTokens] = useState('')
  const [metaWindow, setMetaWindow] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [key, setKey] = useState('')
  const [keyStatus, setKeyStatus] = useState<'idle' | 'saving' | 'saved'>('idle')

  useEffect(() => {
    if (settings === undefined) return
    setModel(settings.model)
    setCaps({ perTask: capFields(settings.costCaps.perTask), perConversation: capFields(settings.costCaps.perConversation), perProject: capFields(settings.costCaps.perProject) })
    setLearnUsd(String(settings.learning.budget.maxUsd))
    setLearnDays(String(settings.learning.budget.windowDays))
    setLegacyTokens(String(settings.improvement.budget.maxTokens))
    setLegacyWindow(String(settings.improvement.budget.windowDays))
    setShare(settings.improvement.shareImproverEvidence)
    // Only when another project's settings arrive; edits in progress are kept otherwise.
  }, [state.project?.projectId, settings === undefined])

  // The user-level settings are read back from disk whenever the page opens.
  useEffect(() => {
    void store.refreshUserSettings()
  }, [])
  useEffect(() => {
    if (userSettings === undefined) return
    const meta = userSettings.improvement.meta
    setMetaOn(meta.enabled)
    setMetaEvery(String(meta.everyJobs))
    setMetaTokens(String(meta.budget.maxTokens))
    setMetaWindow(String(meta.budget.windowDays))
  }, [userSettings === undefined])

  const fail = (field: string, message: string | undefined): void => setErrors(current => {
    const { [field]: _old, ...rest } = current
    return message === undefined ? rest : { ...rest, [field]: message }
  })

  const saveProject = (patch: SettingsPatch): void => void project.run(() => store.saveSettings(patch))
  const saveUser = (patch: UserSettingsPatch): void => void user.run(() => store.saveUserSettings(patch))

  const commitModel = (): void => {
    const value = model.trim()
    if (value === '') return fail('model', L.invalidModel)
    fail('model', undefined)
    if (value === settings?.model) return project.settle()
    saveProject({ model: value })
  }

  const commitCaps = (): void => {
    if (settings === undefined) return
    const next: { -readonly [K in keyof CostCaps]: CostCap } = {}
    let invalid = false
    for (const scope of ['perTask', 'perConversation', 'perProject'] as const) {
      const cap = toCap(caps[scope], scope === 'perProject')
      if (cap === 'invalid') {
        invalid = true
        fail(scope, L.invalidNumber)
      } else {
        fail(scope, undefined)
        if (cap !== undefined) next[scope] = cap
      }
    }
    if (invalid) return
    if (JSON.stringify(next) === JSON.stringify(settings.costCaps)) return project.settle()
    saveProject({ costCaps: next })
  }

  const positiveInt = (text: string): number | undefined => {
    const value = Number(text.trim())
    return text.trim() !== '' && Number.isInteger(value) && value > 0 ? value : undefined
  }

  const commitLearningBudget = (): void => {
    if (settings === undefined) return
    const maxUsd = Number(learnUsd.trim())
    const windowDays = positiveInt(learnDays)
    if (learnUsd.trim() === '' || !Number.isFinite(maxUsd) || maxUsd < 0 || windowDays === undefined) return fail('learning', L.invalidNumber)
    fail('learning', undefined)
    const budget = settings.learning.budget
    if (maxUsd === budget.maxUsd && windowDays === budget.windowDays) return project.settle()
    project.run(() => store.saveLearning({ budget: { maxUsd, windowDays } }))
  }

  // Switches keep their own state, so a field left right after a switch never sends the switch's old value.
  const commitLegacy = (shareNow: boolean = share): void => {
    if (settings === undefined) return
    const maxTokens = positiveInt(legacyTokens)
    const windowDays = positiveInt(legacyWindow)
    if (maxTokens === undefined || windowDays === undefined) return fail('legacy', L.invalidInteger)
    fail('legacy', undefined)
    const shareImproverEvidence = shareNow
    const current = settings.improvement
    if (maxTokens === current.budget.maxTokens && windowDays === current.budget.windowDays && shareImproverEvidence === current.shareImproverEvidence) return project.settle()
    saveProject({ improvement: { ...projectImprovement(current), budget: { maxTokens, windowDays }, shareImproverEvidence } })
  }

  const commitMeta = (on: boolean = metaOn): void => {
    if (userSettings === undefined) return
    const everyJobs = positiveInt(metaEvery)
    const maxTokens = positiveInt(metaTokens)
    const windowDays = positiveInt(metaWindow)
    if (everyJobs === undefined || everyJobs > 20) return fail('meta', L.invalidEvery)
    if (maxTokens === undefined || windowDays === undefined) return fail('meta', L.invalidInteger)
    fail('meta', undefined)
    const meta = userSettings.improvement.meta
    if (on === meta.enabled && everyJobs === meta.everyJobs && maxTokens === meta.budget.maxTokens && windowDays === meta.budget.windowDays) return user.settle()
    saveUser({ improvement: { meta: { enabled: on, everyJobs, budget: { maxTokens, windowDays }, model: meta.model } } })
  }

  const saveKey = async (value: string): Promise<void> => {
    setKeyStatus('saving')
    const ok = await store.setApiKey(value)
    // The value leaves the page with this one call; the field is cleared either way.
    setKey('')
    setKeyStatus(ok ? 'saved' : 'idle')
  }

  const onEnter = (commit: () => void) => (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') commit()
  }

  const capRow = (scope: 'perTask' | 'perConversation' | 'perProject', name: string, help: string, testId: string): JSX.Element => {
    const fields = caps[scope]
    const set = (patch: Partial<CapFields>): void => setCaps(current => ({ ...current, [scope]: { ...current[scope], ...patch } }))
    return (
      <Row name={name} help={help} error={errors[scope]} testId={`${testId}-row`}>
        <span className="unit-input">
          <input inputMode="decimal" value={fields.maxUsd} placeholder={L.unlimited} aria-label={`${name}（${L.usd}）`} onChange={e => set({ maxUsd: e.target.value })} onBlur={commitCaps} onKeyDown={onEnter(commitCaps)} data-testid={`${testId}-usd`} />
          <span className="muted">{L.usd}</span>
        </span>
      </Row>
    )
  }

  const usage = (scope: 'perTask' | 'perConversation' | 'perProject', testId: string, label: string): JSX.Element => {
    const fields = caps[scope]
    const set = (patch: Partial<CapFields>): void => setCaps(current => ({ ...current, [scope]: { ...current[scope], ...patch } }))
    const input = (field: keyof CapFields, placeholder: string, suffix: string, aria: string): JSX.Element => (
      <input inputMode="numeric" value={fields[field]} placeholder={placeholder} aria-label={`${label} ${aria}`} onChange={e => set({ [field]: e.target.value })} onBlur={commitCaps} onKeyDown={onEnter(commitCaps)} data-testid={`${testId}-${suffix}`} />
    )
    return (
      <div className="usage-caps" data-testid={testId}>
        <span className="muted small">{label}</span>
        {input('maxTokens', L.unlimited, 'tokens', L.maxTokens)}
        {input('maxRequests', L.unlimited, 'requests', L.maxRequests)}
        {scope === 'perProject' && input('windowDays', '30', 'window', L.windowDays)}
      </div>
    )
  }

  // The page head speaks for the whole page: saved once something saved and nothing is saving or failed.
  const busy = project.state === 'saving' || user.state === 'saving'
  const failed = project.state === 'failed' || user.state === 'failed'
  const saved = !busy && !failed && (project.state === 'saved' || user.state === 'saved')
  return (
    <Page
      title={T.settingsTitle}
      lead={L.settingsLead}
      onClose={onClose}
      testId="settings-page"
      aside={
        <span className="save-state small" data-testid="settings-save-state" data-state={busy ? 'saving' : failed ? 'failed' : saved ? 'saved' : 'idle'} aria-live="polite">
          {busy ? <span className="muted">{L.saving}</span> : null}
          {saved && <span className="ok-text" data-testid="settings-saved">{L.saved}</span>}
        </span>
      }
    >
      <div className="settings-layout">
        <nav className="settings-nav" aria-label={T.settingsTitle}>
          {GROUPS.map(group => (
            <button type="button" key={group} className="nav-item" onClick={() => document.getElementById(`settings-${group}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })} data-testid={`settings-nav-${group}`}>
              {L.groups[group]}
            </button>
          ))}
        </nav>
        <div className="settings-groups">
          <Group id="general">
            <Appearance />
            <Row name={L.language} help={L.languageHelp} testId="settings-language">
              <select value={userSettings?.language ?? ''} disabled={userSettings === undefined} aria-label={L.language} onChange={e => saveUser({ language: e.target.value === '' ? null : e.target.value })} data-testid="setting-language">
                {LANGUAGES.map(language => (
                  <option key={language.value} value={language.value}>
                    {language.label}
                  </option>
                ))}
                {userSettings?.language !== undefined && !LANGUAGES.some(language => language.value === userSettings.language) && <option value={userSettings.language}>{userSettings.language}</option>}
              </select>
            </Row>
          </Group>
          {settings === undefined ? (
            <p className="muted">{T.loading}</p>
          ) : (
            <>
              <Group id="model">
                <Row name={L.model} help={L.modelHelp} error={errors['model']}>
                  <input list="settings-models" value={model} aria-label={L.model} onChange={e => setModel(e.target.value)} onBlur={commitModel} onKeyDown={onEnter(commitModel)} data-testid="setting-model" spellCheck={false} />
                  <datalist id="settings-models">
                    {MODELS.map(id => (
                      <option key={id} value={id} />
                    ))}
                  </datalist>
                </Row>
                <Row name={L.thinking} help={L.thinkingHelp}>
                  <select value={settings.thinking} aria-label={L.thinking} onChange={e => saveProject({ thinking: e.target.value as ThinkingMode })} data-testid="setting-thinking">
                    <option value="on">{T.thinkingOn}</option>
                    <option value="off">{T.thinkingOff}</option>
                  </select>
                </Row>
                <Row name={L.effort} help={L.effortHelp}>
                  <select value={settings.effort} aria-label={L.effort} onChange={e => saveProject({ effort: e.target.value as Effort })} data-testid="setting-effort">
                    {EFFORTS.map(e => (
                      <option key={e} value={e}>
                        {effortText(e)}
                      </option>
                    ))}
                  </select>
                </Row>
              </Group>
              <Group id="permissions">
                <Row name={L.sandbox} help={L.sandboxHelp}>
                  <select value={settings.sandboxMode} aria-label={L.sandbox} onChange={e => saveProject({ sandboxMode: e.target.value as SandboxMode })} data-testid="setting-sandbox">
                    {SANDBOX.map(s => (
                      <option key={s.value} value={s.value}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </Row>
              </Group>
              <Group id="cost">
                {capRow('perTask', L.perTask, L.perTaskHelp, 'cap-task')}
                {capRow('perConversation', L.perConversation, L.perConversationHelp, 'cap-conversation')}
                {capRow('perProject', L.perProject, L.perProjectHelp(Number(caps.perProject.windowDays) || 30), 'cap-project')}
                <details className="usage-more" open={hasUsageCaps(settings.costCaps)}>
                  <summary className="muted small">{L.usageCaps}</summary>
                  {usage('perTask', 'cap-task', L.perTask)}
                  {usage('perConversation', 'cap-conversation', L.perConversation)}
                  {usage('perProject', 'cap-project', L.perProject)}
                </details>
              </Group>
              <Group id="learning">
                <Row name={L.learningSwitch} help={L.learningSwitchHelp}>
                  <Switch checked={settings.learning.enabled} onChange={enabled => project.run(() => store.saveLearning({ enabled }))} label={L.learningSwitch} testId="settings-auto-improve" />
                </Row>
                <Row name={L.learningBudget} help={L.learningBudgetHelp(settings.learning.budget.windowDays)} error={errors['learning']}>
                  <span className="unit-input">
                    <input inputMode="decimal" value={learnUsd} aria-label={`${L.learningBudget}（${L.usd}）`} onChange={e => setLearnUsd(e.target.value)} onBlur={commitLearningBudget} onKeyDown={onEnter(commitLearningBudget)} data-testid="settings-learning-budget" />
                    <span className="muted">{L.usd}</span>
                    <span className="muted">/</span>
                    <input inputMode="numeric" className="short" value={learnDays} aria-label={L.windowDays} onChange={e => setLearnDays(e.target.value)} onBlur={commitLearningBudget} onKeyDown={onEnter(commitLearningBudget)} data-testid="settings-learning-window" />
                    <span className="muted">天</span>
                  </span>
                </Row>
                <Row name={L.useShared} help={L.useSharedHelp}>
                  <Switch checked={settings.learning.useShared} onChange={useShared => project.run(() => store.saveLearning({ useShared }))} label={L.useShared} testId="settings-use-shared" />
                </Row>
                <Row name={L.contribute} help={L.contributeHelp}>
                  <Switch checked={settings.learning.contribute} onChange={contribute => project.run(() => store.saveLearning({ contribute }))} label={L.contribute} testId="settings-contribute" />
                </Row>
              </Group>
            </>
          )}
          <Group id="advanced">
            <Row name={L.apiKey} help={`${L.apiKeyHelp} ${credentialText(settings?.apiKey)}`} testId="api-key-section">
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
            </Row>
            <p className="sr-only" data-testid="api-key-status">
              {credentialText(settings?.apiKey)}
            </p>
            {settings?.apiKey.source === 'file' && (
              <button type="button" className="link small" onClick={() => void saveKey('')}>
                {T.apiKeyRemove}
              </button>
            )}
            {keyStatus === 'saved' && <p className="ok-text small">{T.saved}</p>}
            <details className="legacy" open data-testid="settings-legacy">
              <summary className="setting-name">{L.legacyTitle}</summary>
              <p className="muted small wrap">{L.legacyHelp}</p>
              {settings !== undefined && (
                <>
                  <Row name={L.legacyBudget} error={errors['legacy']}>
                    <span className="unit-input">
                      <input inputMode="numeric" value={legacyTokens} aria-label={L.legacyBudget} onChange={e => setLegacyTokens(e.target.value)} onBlur={() => commitLegacy()} onKeyDown={onEnter(() => commitLegacy())} data-testid="settings-improvement-budget" />
                      <span className="muted">/</span>
                      <input inputMode="numeric" className="short" value={legacyWindow} aria-label={L.legacyWindow} onChange={e => setLegacyWindow(e.target.value)} onBlur={() => commitLegacy()} onKeyDown={onEnter(() => commitLegacy())} data-testid="settings-improvement-window" />
                      <span className="muted">天</span>
                    </span>
                  </Row>
                  <Row name={L.shareEvidence} help={L.shareEvidenceHelp}>
                    <Switch checked={share} onChange={next => { setShare(next); commitLegacy(next) }} label={L.shareEvidence} testId="settings-share-improver" />
                  </Row>
                </>
              )}
              <section data-testid="settings-user-section">
                <Row name={L.metaTitle} help={L.metaHelp} error={errors['meta']}>
                  {userSettings === undefined ? (
                    <span className="muted">{T.loading}</span>
                  ) : (
                    <Switch checked={metaOn} onChange={next => { setMetaOn(next); commitMeta(next) }} label={L.metaTitle} testId="settings-meta-enabled" />
                  )}
                </Row>
                {userSettings !== undefined && (
                  <div className="usage-caps">
                    <label className="small muted">
                      {L.metaEvery}
                      <input inputMode="numeric" value={metaEvery} onChange={e => setMetaEvery(e.target.value)} onBlur={() => commitMeta()} onKeyDown={onEnter(() => commitMeta())} data-testid="settings-meta-every" />
                    </label>
                    <label className="small muted">
                      {L.metaBudget}
                      <input inputMode="numeric" value={metaTokens} onChange={e => setMetaTokens(e.target.value)} onBlur={() => commitMeta()} onKeyDown={onEnter(() => commitMeta())} data-testid="settings-meta-budget" />
                    </label>
                    <label className="small muted">
                      {L.metaWindow}
                      <input inputMode="numeric" value={metaWindow} onChange={e => setMetaWindow(e.target.value)} onBlur={() => commitMeta()} onKeyDown={onEnter(() => commitMeta())} data-testid="settings-meta-window" />
                    </label>
                  </div>
                )}
                {user.state === 'saved' && (
                  <span className="ok-text small" data-testid="settings-user-saved">
                    {L.saved}
                  </span>
                )}
              </section>
            </details>
          </Group>
        </div>
      </div>
    </Page>
  )
}

function hasUsageCaps(caps: CostCaps): boolean {
  return [caps.perTask, caps.perConversation, caps.perProject].some(cap => cap?.maxTokens !== undefined || cap?.maxRequests !== undefined)
}

function Group({ id, children }: { readonly id: (typeof GROUPS)[number]; readonly children: ReactNode }): JSX.Element {
  return (
    <section className="settings-group" id={`settings-${id}`} aria-labelledby={`settings-${id}-title`} data-testid={`settings-group-${id}`}>
      <h3 id={`settings-${id}-title`}>{L.groups[id]}</h3>
      <p className="muted small">{L.groupHelp[id]}</p>
      <div className="setting-rows">{children}</div>
    </section>
  )
}

/** One setting: its name and one line of help on the left, the control on the right. */
function Row({ name, help, error, testId, children }: { readonly name: string; readonly help?: string; readonly error?: string | undefined; readonly testId?: string; readonly children: ReactNode }): JSX.Element {
  return (
    <div className="setting-row" data-testid={testId}>
      <div className="grow">
        <div className="setting-name">{name}</div>
        {help !== undefined && <div className="muted small wrap">{help}</div>}
        {error !== undefined && <div className="field-error small">{error}</div>}
      </div>
      <div className="setting-control">{children}</div>
    </div>
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
    <div className="setting-row" data-testid="settings-appearance">
      <div className="grow">
        <div className="setting-name">{T.appearance}</div>
        <div className="muted small">{T.appearanceHint}</div>
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
    </div>
  )
}

/** The project's improvement settings without the deprecated `meta` (ADR 0012: meta settings are the user's), so a save does not write it. */
function projectImprovement(improvement: ProjectSettings['improvement']): Omit<ProjectSettings['improvement'], 'meta'> {
  const { meta: _deprecated, ...rest } = improvement
  return rest
}
