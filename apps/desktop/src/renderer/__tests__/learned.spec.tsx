// @vitest-environment jsdom
/**
 * Rework D2: 能力 → 经验 (the handbook, the learning switch and spend), the
 * one-time learning notice, the settings page's groups and language, the
 * title a conversation gets after its first turn, and plain words.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { HandbookEntryView } from '@nexgent/sdk'
import { L } from '../strings.js'
import { FakeBridge, SESSION } from '../testing/fake-bridge.js'
import { emit, renderApp } from './helpers.js'

const entry = (overrides: Partial<HandbookEntryView> & Pick<HandbookEntryView, 'id' | 'text'>): HandbookEntryView => ({
  keywords: ['汇总', '表格'],
  scope: 'user',
  status: 'trial',
  helpful: 0,
  harmful: 0,
  sources: [{ projectId: 'p1', taskId: 't1' }],
  supersedes: [],
  createdAt: '2026-10-15T08:00:00.000Z',
  updatedAt: '2026-10-15T08:00:00.000Z',
  retrievable: true,
  ...overrides,
})

const ACTIVE = 'a0000000-0000-4000-8000-000000000001'
const TRIAL = 'a0000000-0000-4000-8000-000000000002'
const RETIRED = 'a0000000-0000-4000-8000-000000000003'

function learningBridge(): FakeBridge {
  const bridge = new FakeBridge()
  bridge.userSettings = { ...bridge.userSettings, learning: { noticeAcknowledgedAt: '2026-10-16T08:00:00.000Z' } }
  bridge.handbook = [
    entry({ id: ACTIVE, text: '合并多份明细前先核对各文件的列名是否一致。', status: 'active', helpful: 2, createdAt: '2026-10-16T09:00:00.000Z', evidence: { shown: 6, heldBack: 5, shownMean: 0.82, heldBackMean: 0.7, lastUsedAt: new Date(Date.now() - 3 * 86_400_000).toISOString() } }),
    entry({ id: TRIAL, text: '改配置文件前先完整读一遍，保留原有注释。', helpful: 1, scope: 'project', projectId: 'p1' }),
    entry({ id: RETIRED, text: '总是先把表格转成 CSV。', status: 'retired', harmful: 2, retrievable: false }),
  ]
  bridge.handbookOps[ACTIVE] = [
    { formatVersion: 1, seq: 1, at: '2026-10-15T08:00:00.000Z', entryId: ACTIVE, actor: 'reflection', op: 'add', text: 'x', keywords: [], scope: 'user', reason: '这次汇总前没核对列名，结果错了一列。' },
    { formatVersion: 1, seq: 2, at: '2026-10-16T09:00:00.000Z', entryId: ACTIVE, actor: 'host', op: 'status', status: 'active', reason: '帮上忙 2 次，正式启用。' },
  ]
  bridge.learningSpend = { spentUsd: 0.42, estimated: false, phases: [{ phase: 'self-eval', usd: 0.12, requestCount: 6 }, { phase: 'reflect', usd: 0.3, requestCount: 3 }] }
  bridge.selfEvaluations = 3
  return bridge
}

describe('能力 → 经验', () => {
  it('opens on 经验: a status line, the learning card with spend against the budget, and the entries by state', async () => {
    await renderApp(learningBridge())
    fireEvent.click(screen.getByTestId('nav-capabilities'))
    const page = await screen.findByTestId('capabilities-page')
    expect(within(page).getByTestId('tab-learned').getAttribute('aria-selected')).toBe('true')
    await waitFor(() => expect(within(page).getAllByTestId('handbook-entry')).toHaveLength(3))
    expect(page.textContent).toContain('用着 1 条经验，另有 1 条在试用，最近一次学到是在 10 月 16 日')
    expect(within(page).getByTestId('learning-spend').textContent).toContain('近 30 天学习花了 0.42 美元，预算 3.00 美元')
    expect(within(page).getByTestId('learning-phases').textContent).toBe('给结果打分 0.12 · 总结经验 0.30')
    expect(within(page).getByTestId('learning-self-eval').textContent).toContain('给 3 个任务打了分')
    expect(within(page).getByTestId('handbook-active').textContent).toContain('合并多份明细前先核对各文件的列名是否一致')
    const trial = within(page).getByTestId('handbook-trial')
    expect(trial.textContent).toContain('只用于这个项目')
    expect(trial.textContent).toContain('再帮上忙 1 次就正式启用')
    expect(within(page).getByTestId('handbook-retired').textContent).toContain('已停用（1）')
    expect((within(page).getByTestId('learning-toggle') as HTMLInputElement).checked).toBe(true)
    expect(within(page).queryByTestId('learning-acknowledge')).toBeNull()
    expect(within(page).queryByTestId('learned-decide')).toBeNull()
  })

  it('shows an entry\'s history with the reasons, and stops or restores it', async () => {
    const { bridge } = await renderApp(learningBridge())
    fireEvent.click(screen.getByTestId('nav-capabilities'))
    const active = await waitFor(() => screen.getAllByTestId('handbook-entry').find(row => row.dataset['entry'] === ACTIVE)!)
    fireEvent.click(within(active).getByTestId('handbook-entry-open'))
    const detail = await within(active).findByTestId('handbook-detail')
    expect(detail.textContent).toContain('适用于：汇总、表格')
    expect(within(detail).getAllByTestId('handbook-op').map(op => op.textContent)).toEqual([
      '10 月 15 日 学到这条经验：这次汇总前没核对列名，结果错了一列。',
      '10 月 16 日 正式启用：帮上忙 2 次，正式启用。',
    ])
    fireEvent.click(within(active).getByTestId('handbook-stop'))
    await waitFor(() => expect(bridge.callsOf('handbook.setStatus')).toEqual([{ projectId: 'p1', entryId: ACTIVE, status: 'retired' }]))
    await waitFor(() => expect(screen.getAllByTestId('handbook-entry').find(row => row.dataset['entry'] === ACTIVE)!.dataset['status']).toBe('retired'))
    const stopped = screen.getAllByTestId('handbook-entry').find(row => row.dataset['entry'] === ACTIVE)!
    expect(within(stopped).getAllByTestId('handbook-op').at(-1)!.textContent).toContain('停用（你）')
    fireEvent.click(within(stopped).getByTestId('handbook-restore'))
    await waitFor(() => expect(bridge.callsOf('handbook.setStatus').at(-1)).toMatchObject({ entryId: ACTIVE, status: 'active' }))
  })

  it('says how often each entry was given and held back, how the outcomes differ, and when it was last used', async () => {
    await renderApp(learningBridge())
    fireEvent.click(screen.getByTestId('nav-capabilities'))
    const rows = await waitFor(() => {
      const all = screen.getAllByTestId('handbook-entry')
      expect(all).toHaveLength(3)
      return all
    })
    const text = (id: string) => within(rows.find(row => row.dataset['entry'] === id)!).getByTestId('handbook-evidence').textContent
    expect(text(ACTIVE)).toBe('给过 6 次，没给 5 次，给了的结局好 12 分（满分 100）。最近一次用到：3 天前')
    expect(text(TRIAL)).toBe('还没有对照记录。还没用到过')
  })

  it('turns learning off from the card, and says what that means', async () => {
    const { bridge } = await renderApp(learningBridge())
    fireEvent.click(screen.getByTestId('nav-capabilities'))
    fireEvent.click(await screen.findByTestId('learning-toggle'))
    await waitFor(() => expect(bridge.callsOf('settings.update').at(-1)!.patch).toEqual({ learning: { enabled: false, budget: { maxUsd: 3, windowDays: 30 }, selfEvalMaxUsd: 0.05, useShared: true, contribute: true } }))
    await waitFor(() => expect(screen.getByTestId('learning-card').textContent).toContain('已关闭'))
  })

  it('shows what waits for the user\'s yes, and says when nothing was learned yet', async () => {
    const bridge = new FakeBridge()
    bridge.capabilities = { ...bridge.capabilities, candidates: [{ id: 'c1', status: 'awaiting-approval', proposedAt: '2026-10-16T08:00:00.000Z', components: [{ kind: 'plugin', name: 'xlsx-reader' }], requiresApproval: true } as never] }
    await renderApp(bridge)
    fireEvent.click(screen.getByTestId('nav-capabilities'))
    const decide = await screen.findByTestId('learned-decide')
    expect(decide.textContent).toContain('新做法「xlsx-reader」测试下来更好，要你同意才会启用')
    expect(screen.getByTestId('handbook-empty')).toBeTruthy()
    expect(screen.getByTestId('capabilities-page').textContent).toContain(L.leadNone)
    // Not acknowledged yet: the card says learning waits for it.
    fireEvent.click(screen.getByTestId('learning-acknowledge'))
    await waitFor(() => expect(bridge.callsOf('learning.acknowledge')).toHaveLength(1))
  })
})

describe('the learning notice', () => {
  it('appears once the conversation has a message, until acknowledged; 去设置 opens the settings', async () => {
    const bridge = new FakeBridge()
    bridge.view = { ...bridge.view, items: [] }
    await renderApp(bridge)
    expect(screen.queryByTestId('learning-notice')).toBeNull()
    emit(bridge, { type: 'turn.start', turn: 1, source: 'user' })
    emit(bridge, { type: 'text.delta', turn: 1, step: 1, text: '好的' })
    const notice = await screen.findByTestId('learning-notice')
    expect(notice.textContent).toContain('每个项目每 30 天最多花 3.00 美元')
    fireEvent.click(within(notice).getByTestId('learning-notice-settings'))
    expect(screen.getByTestId('settings-page')).toBeTruthy()
    fireEvent.click(screen.getByTestId('page-back'))
    fireEvent.click(screen.getByTestId('learning-notice-ok'))
    await waitFor(() => expect(screen.queryByTestId('learning-notice')).toBeNull())
    expect(bridge.callsOf('learning.acknowledge')).toHaveLength(1)
  })
})

describe('settings in groups', () => {
  it('has the six groups, saves the language for every project, and the learning budget in dollars', async () => {
    const { bridge } = await renderApp(learningBridge())
    fireEvent.click(screen.getByTestId('open-settings'))
    const page = await screen.findByTestId('settings-page')
    expect(['general', 'model', 'permissions', 'cost', 'learning', 'advanced'].map(id => within(page).getByTestId(`settings-group-${id}`).querySelector('h3')!.textContent)).toEqual(['通用', '模型', '权限', '费用', '自动改进', '高级'])
    fireEvent.change(within(page).getByTestId('setting-language'), { target: { value: 'en' } })
    await waitFor(() => expect(bridge.callsOf('userSettings.update')).toEqual([{ patch: { language: 'en' } }]))
    expect(bridge.userSettings.language).toBe('en')
    fireEvent.change(within(page).getByTestId('setting-language'), { target: { value: '' } })
    await waitFor(() => expect(bridge.callsOf('userSettings.update').at(-1)).toEqual({ patch: { language: null } }))
    fireEvent.change(within(page).getByTestId('settings-learning-budget'), { target: { value: '5' } })
    fireEvent.blur(within(page).getByTestId('settings-learning-budget'))
    await waitFor(() => expect(bridge.callsOf('settings.update').at(-1)!.patch.learning).toMatchObject({ budget: { maxUsd: 5, windowDays: 30 } }))
    fireEvent.click(within(page).getByTestId('settings-contribute'))
    await waitFor(() => expect(bridge.callsOf('settings.update').at(-1)!.patch.learning).toMatchObject({ contribute: false, budget: { maxUsd: 5 } }))
    await waitFor(() => expect(within(page).getByTestId('settings-saved')).toBeTruthy())
  })
})

describe('plain words', () => {
  it('the new pages never say 门控、候选、基线、改进器 or 元改进', async () => {
    const jargon = /门控|候选|基线|改进器|元改进/
    const words = JSON.stringify(L, (_key, value) => (typeof value === 'function' ? String(value) : value))
    expect(words).not.toMatch(jargon)
    await renderApp(learningBridge())
    fireEvent.click(screen.getByTestId('nav-capabilities'))
    await waitFor(() => expect(screen.getAllByTestId('handbook-entry')).toHaveLength(3))
    expect(screen.getByTestId('capabilities-page').textContent).not.toMatch(jargon)
    fireEvent.click(screen.getByTestId('open-settings'))
    expect((await screen.findByTestId('settings-page')).textContent).not.toMatch(jargon)
  })
})

describe('the conversation title', () => {
  it('follows a session.title event in the sidebar and the title bar', async () => {
    const bridge = new FakeBridge()
    const { title: _untitled, ...untitled } = SESSION
    bridge.sessions = [untitled]
    await renderApp(bridge)
    emit(bridge, { type: 'session.title', title: '9 月订单按地区汇总' })
    expect(screen.getByTestId('session-item').textContent).toContain('9 月订单按地区汇总')
    expect(screen.getByTestId('conversation').querySelector('.topbar')!.textContent).toContain('9 月订单按地区汇总')
  })
})
