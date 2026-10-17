// @vitest-environment jsdom
// Rework D3: turn cost, cost-cap notice, key guidance, plan-mode start, the todo plan, data location, settings saved while typing.
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { EDIT_SAVE_MS } from '../components/SettingsPage.js'
import { FakeBridge, SESSION, SETTINGS, ZERO_USAGE } from '../testing/fake-bridge.js'
import { emit, renderApp } from './helpers.js'

const usage = ZERO_USAGE
const keyed = (): FakeBridge => {
  const bridge = new FakeBridge()
  bridge.settings = { ...SETTINGS, apiKey: { configured: true, source: 'env' } }
  return bridge
}

describe('turn cost', () => {
  it('shows what a finished turn cost under it, and nothing when no price is known', async () => {
    const { bridge } = await renderApp(keyed())
    emit(bridge, { type: 'turn.start', turn: 1, source: 'user' })
    emit(bridge, { type: 'assistant.message', turn: 1, step: 1, text: '好了', finishReason: 'stop', interrupted: false, usage })
    emit(bridge, { type: 'turn.end', turn: 1, reason: { kind: 'completed' }, usage, cost: { usd: 0.1234, estimated: false } })
    expect(screen.getByTestId('turn-cost').textContent).toBe('本轮 0.12 美元')
    emit(bridge, { type: 'turn.start', turn: 2, source: 'user' })
    emit(bridge, { type: 'turn.end', turn: 2, reason: { kind: 'completed' }, usage, cost: { usd: 0, estimated: true } })
    expect(screen.getAllByTestId('turn-cost')).toHaveLength(1)
  })

  it('reads the cost back from history, saying when part of it is unknown', async () => {
    const bridge = keyed()
    bridge.view = { ...bridge.view, items: [{ kind: 'user', turn: 1, text: '汇总', source: 'user', materials: [] }, { kind: 'turn.end', turn: 1, reason: { kind: 'completed' }, cost: { usd: 0.004, estimated: true } }] }
    await renderApp(bridge)
    expect((await screen.findByTestId('turn-cost')).textContent).toBe('本轮至少 不到 0.01 美元（有的请求没有用量）')
  })
})

describe('cost-cap notice', () => {
  it('warns at 80%, says the cap is reached, and leads to the cost settings', async () => {
    const { bridge } = await renderApp(keyed())
    emit(bridge, { type: 'cost.warning', sessionId: undefined, warning: { scope: 'perConversation', level: 'warning', limit: 'maxUsd', used: 0.82, cap: 1, estimated: false, ts: '2026-10-16T12:00:00.000Z' } })
    const notice = screen.getByTestId('cost-notice')
    expect(notice.textContent).toContain('这段对话的费用快到上限了')
    expect(notice.textContent).toContain('已用 0.82 美元，上限 1.00 美元')
    emit(bridge, { type: 'cost.warning', sessionId: undefined, warning: { scope: 'perTask', level: 'reached', limit: 'maxTokens', used: 200000, cap: 200000, estimated: true, ts: '2026-10-16T12:01:00.000Z' } })
    expect(screen.getByTestId('cost-notice').dataset['level']).toBe('reached')
    expect(screen.getByTestId('cost-notice').textContent).toContain('这个任务的费用到上限了')
    expect(screen.getByTestId('cost-notice').textContent).toContain('200,000 tokens')
    expect(screen.getByTestId('cost-notice').textContent).toContain('其中有估算')
    fireEvent.click(screen.getByTestId('cost-notice-dismiss'))
    expect(screen.queryByTestId('cost-notice')).toBeNull()
    emit(bridge, { type: 'cost.warning', sessionId: undefined, warning: { scope: 'perProject', level: 'warning', limit: 'maxUsd', used: 8, cap: 10, estimated: false, ts: '2026-10-16T12:02:00.000Z' } })
    fireEvent.click(screen.getByTestId('cost-notice-settings'))
    expect(await screen.findByTestId('settings-page')).toBeTruthy()
  })
})

describe('missing key', () => {
  it('explains what the key is for and takes it in place', async () => {
    const { bridge } = await renderApp()
    const notice = screen.getByTestId('key-notice')
    expect(notice.textContent).toContain('还没有模型 API 密钥')
    expect(notice.textContent).toContain('NEXGENT_API_KEY')
    const input = within(notice).getByTestId('key-notice-input') as HTMLInputElement
    expect(input.type).toBe('password')
    const secret = 'sk-ant-test-secret-456'
    fireEvent.change(input, { target: { value: secret } })
    fireEvent.click(within(notice).getByTestId('key-notice-save'))
    await waitFor(() => expect(screen.queryByTestId('key-notice')).toBeNull())
    expect(bridge.callsOf('settings.setApiKey')).toEqual([{ value: secret }])
    expect(document.body.innerHTML).not.toContain(secret)
  })

  it('is not shown once a key is configured', async () => {
    await renderApp(keyed())
    expect(screen.queryByTestId('key-notice')).toBeNull()
  })
})

describe('plan mode at the start', () => {
  it('toggles plan mode on an empty conversation and hides the switch after the first message', async () => {
    const { bridge } = await renderApp(keyed())
    const toggle = screen.getByTestId('plan-start')
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(toggle)
    await waitFor(() => expect(screen.getByTestId('plan-start').getAttribute('aria-pressed')).toBe('true'))
    expect(bridge.callsOf('sessions.setMode')).toEqual([{ projectId: 'p1', sessionId: 's1', plan: true }])
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: '先看看再说' } })
    fireEvent.click(screen.getByTestId('send'))
    await waitFor(() => expect(screen.queryByTestId('plan-start')).toBeNull())
    expect(screen.getByTestId('plan-chip').textContent).toBe('计划模式')
  })

  it('does not pull the user back when a new conversation finishes creating after they moved on', async () => {
    const bridge = keyed()
    bridge.sessions = [SESSION, { ...SESSION, sessionId: 's3', title: '另一段' }]
    let finish: () => void = () => undefined
    bridge.handlers['sessions.create'] = () => new Promise(resolve => {
      finish = () => resolve({ ...SESSION, sessionId: 's2', title: undefined })
    })
    const { store } = await renderApp(bridge)
    let created: Promise<void> = Promise.resolve()
    act(() => {
      created = store.newSession()
    })
    await act(async () => {
      await store.openSession('s3')
    })
    await act(async () => {
      finish()
      await created
    })
    expect(store.getState().sessionId).toBe('s3')
    expect(store.getState().sessions.some(s => s.sessionId === 's2')).toBe(true)
  })
})

describe('todo plan', () => {
  const todos = (items: Array<[string, 'pending' | 'in_progress' | 'done']>) => JSON.stringify({ todos: items.map(([text, status]) => ({ text, status })) })

  it('shows the latest todo_write list above the composer while the turn runs', async () => {
    const { bridge } = await renderApp(keyed())
    emit(bridge, { type: 'turn.start', turn: 1, source: 'user' })
    emit(bridge, { type: 'tool.start', turn: 1, step: 1, call: { id: 't1', name: 'todo_write', arguments: todos([['读订单', 'in_progress'], ['写汇总', 'pending']]) } })
    emit(bridge, { type: 'tool.result', turn: 1, step: 1, callId: 't1', name: 'todo_write', content: '计划已更新', isError: false, durationMs: 3 })
    const panel = screen.getByTestId('plan-panel')
    expect(panel.textContent).toContain('计划')
    expect(panel.textContent).toContain('0 / 2 完成')
    expect(panel.textContent).toContain('读订单')
    emit(bridge, { type: 'tool.start', turn: 1, step: 2, call: { id: 't2', name: 'todo_write', arguments: todos([['读订单', 'done'], ['写汇总', 'done']]) } })
    expect(screen.getByTestId('plan-panel').textContent).toContain('2 / 2 完成')
    expect(screen.getByTestId('steps-toggle').textContent).toContain('更新计划')
    emit(bridge, { type: 'tool.result', turn: 1, step: 2, callId: 't2', name: 'todo_write', content: '计划已更新', isError: false, durationMs: 3 })
    emit(bridge, { type: 'turn.end', turn: 1, reason: { kind: 'completed' }, usage })
    // Everything done and the turn over: the plan stays only in the folded steps.
    expect(screen.queryByTestId('plan-panel')).toBeNull()
    expect(screen.getByTestId('steps-toggle').textContent).toContain('更新了计划')
  })
})

describe('settings finishing', () => {
  it('saves a typed value shortly after typing stops, without leaving the field', async () => {
    const { bridge } = await renderApp(keyed())
    fireEvent.click(screen.getByTestId('open-settings'))
    const page = await screen.findByTestId('settings-page')
    fireEvent.change(within(page).getByTestId('cap-conversation-usd'), { target: { value: '2' } })
    expect(bridge.callsOf('settings.update')).toEqual([])
    await waitFor(() => expect(bridge.callsOf('settings.update').map(call => call.patch)).toEqual([{ costCaps: { perConversation: { maxUsd: 2 } } }]), { timeout: EDIT_SAVE_MS + 1500 })
  })

  it('saves what is pending at once when the window is hidden or closed', async () => {
    const { bridge } = await renderApp(keyed())
    fireEvent.click(screen.getByTestId('open-settings'))
    const page = await screen.findByTestId('settings-page')
    fireEvent.change(within(page).getByTestId('setting-model'), { target: { value: 'claude-opus-5-5' } })
    act(() => {
      window.dispatchEvent(new Event('beforeunload'))
    })
    // Sent right away (well before the delayed save would run).
    await waitFor(() => expect(bridge.callsOf('settings.update').map(call => call.patch)).toEqual([{ model: 'claude-opus-5-5' }]), { timeout: EDIT_SAVE_MS / 2 })
  })

  it('does not show an error for a number still being typed until the field is left', async () => {
    const { bridge } = await renderApp(keyed())
    fireEvent.click(screen.getByTestId('open-settings'))
    const page = await screen.findByTestId('settings-page')
    fireEvent.change(within(page).getByTestId('cap-task-usd'), { target: { value: '-' } })
    await new Promise(resolve => setTimeout(resolve, EDIT_SAVE_MS + 100))
    expect(within(page).queryByText(/请填正数/)).toBeNull()
    expect(bridge.callsOf('settings.update')).toEqual([])
    fireEvent.blur(within(page).getByTestId('cap-task-usd'))
    expect(within(page).getByText(/请填正数/)).toBeTruthy()
  })

  it('shows where the project data lives and opens it in the file manager', async () => {
    const { bridge } = await renderApp(keyed())
    fireEvent.click(screen.getByTestId('open-settings'))
    const page = await screen.findByTestId('settings-page')
    expect(within(page).getByTestId('settings-data-dir-path').textContent).toBe('/home/me/.nexgent/projects/p1')
    fireEvent.click(within(page).getByTestId('settings-data-dir-reveal'))
    await waitFor(() => expect(bridge.callsOf('projects.revealData')).toEqual([{ projectId: 'p1' }]))
  })
})
