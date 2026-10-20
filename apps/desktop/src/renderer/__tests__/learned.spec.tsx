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
    expect((within(page).getByTestId('capabilities-record') as HTMLDetailsElement).open).toBe(false)
    await waitFor(() => expect(within(page).getAllByTestId('handbook-entry')).toHaveLength(1))
    expect(page.textContent).toContain('用着 1 条经验，最近一次改进在')
    expect(page.textContent).toContain('用上经验的任务，结果好 12 分（满分 100）。')
    expect(within(page).getByTestId('learning-spend').textContent).toContain('近 30 天学习花了 0.42 美元，预算 3.00 美元')
    expect(within(page).getByTestId('learning-phases').textContent).toBe('给结果打分 0.12 · 总结经验 0.30')
    expect(within(page).getByTestId('learning-self-eval').textContent).toContain('给 3 个任务打了分')
    expect(within(page).getByTestId('handbook-active').textContent).toContain('合并多份明细前先核对各文件的列名是否一致')
    // Trial and stopped entries are no longer listed (2026-10-19).
    expect(within(page).queryByTestId('handbook-trial')).toBeNull()
    expect(within(page).queryByTestId('handbook-retired')).toBeNull()
    expect((within(page).getByTestId('learning-toggle') as HTMLInputElement).checked).toBe(true)
    expect(within(page).queryByTestId('learning-acknowledge')).toBeNull()
  })

  it('shows an entry\'s history with the reasons, and stops it', async () => {
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
    await waitFor(() => expect(screen.queryAllByTestId('handbook-entry').find(row => row.dataset['entry'] === ACTIVE)).toBeUndefined())
  })

  it('says how often each entry was given and held back, how the outcomes differ, and when it was last used', async () => {
    await renderApp(learningBridge())
    fireEvent.click(screen.getByTestId('nav-capabilities'))
    const rows = await waitFor(() => {
      const all = screen.getAllByTestId('handbook-entry')
      expect(all).toHaveLength(1)
      return all
    })
    // ADR 0028: the evidence shows once the entry is opened.
    const text = async (id: string) => {
      const row = rows.find(row => row.dataset['entry'] === id)!
      expect(within(row).queryByTestId('handbook-evidence')).toBeNull()
      fireEvent.click(within(row).getByTestId('handbook-entry-open'))
      return (await within(row).findByTestId('handbook-evidence')).textContent
    }
    expect(await text(ACTIVE)).toBe('给过 6 次，没给 5 次，给了的结局好 12 分（满分 100）。最近一次用到：3 天前')
  })

  it('turns learning off from the card, and says what that means', async () => {
    const { bridge } = await renderApp(learningBridge())
    fireEvent.click(screen.getByTestId('nav-capabilities'))
    fireEvent.click(await screen.findByTestId('learning-toggle'))
    await waitFor(() => expect(bridge.callsOf('settings.update').at(-1)!.patch).toEqual({ learning: { enabled: false, budget: { maxUsd: 3, windowDays: 30 }, selfEvalMaxUsd: 0.05, useShared: true, contribute: true, skills: false } }))
    await waitFor(() => expect(screen.getByTestId('learning-card').textContent).toContain('已关闭'))
  })

  it('says when nothing was learned yet, and waits for the notice to be acknowledged', async () => {
    const bridge = new FakeBridge()
    await renderApp(bridge)
    fireEvent.click(screen.getByTestId('nav-capabilities'))
    expect(await screen.findByTestId('handbook-empty')).toBeTruthy()
    expect(screen.getByTestId('capabilities-page').textContent).toContain(L.leadNone)
    // Not acknowledged yet: the card says learning waits for it.
    fireEvent.click(screen.getByTestId('learning-acknowledge'))
    await waitFor(() => expect(bridge.callsOf('learning.acknowledge')).toHaveLength(1))
  })
})

describe('project rules (ADR 0024)', () => {
  it('lists rules first with their range, and asks before a pending one is used', async () => {
    const bridge = learningBridge()
    const RULE = 'a0000000-0000-4000-8000-000000000004'
    const PENDING = 'a0000000-0000-4000-8000-000000000005'
    bridge.handbook = [
      ...bridge.handbook,
      entry({ id: RULE, text: '金额一律返回整数分。', kind: 'rule', status: 'active', scope: 'project', projectId: 'p1', appliesTo: '整个项目' }),
      entry({ id: PENDING, text: '每个新函数单独一个测试文件。', kind: 'rule', pending: true, scope: 'project', projectId: 'p1', appliesTo: 'src/billing/' }),
    ]
    await renderApp(bridge)
    fireEvent.click(screen.getByTestId('nav-capabilities'))
    const page = await screen.findByTestId('capabilities-page')
    const rules = await within(page).findByTestId('handbook-rules')
    expect(rules.textContent).toContain('金额一律返回整数分。')
    expect(rules.textContent).toContain('适用于：整个项目')
    const pending = within(page).getByTestId('handbook-pending-rules')
    expect(pending.textContent).toContain('适用于：src/billing/')
    expect(within(page).getAllByTestId('handbook-entry')).toHaveLength(1)
    fireEvent.click(within(pending).getByTestId('rule-confirm'))
    await waitFor(() => expect(within(page).queryByTestId('handbook-pending-rules')).toBeNull())
    expect(within(page).getByTestId('handbook-rules').textContent).toContain('每个新函数单独一个测试文件。')
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
    expect(['general', 'model', 'permissions', 'cost', 'learning', 'advanced'].map(id => within(page).getByTestId(`settings-group-${id}`).querySelector('h3')!.textContent!.replace(/\?$/, ''))).toEqual(['通用', '模型', '权限', '费用', '自动改进', '高级'])
    fireEvent.change(within(page).getByTestId('setting-language'), { target: { value: 'en' } })
    await waitFor(() => expect(bridge.callsOf('userSettings.update')).toEqual([{ patch: { language: 'en' } }]))
    expect(bridge.userSettings.language).toBe('en')
    fireEvent.change(within(page).getByTestId('setting-language'), { target: { value: '' } })
    await waitFor(() => expect(bridge.callsOf('userSettings.update').at(-1)).toEqual({ patch: { language: null } }))
    fireEvent.change(within(page).getByTestId('settings-learning-budget'), { target: { value: '5' } })
    fireEvent.blur(within(page).getByTestId('settings-learning-budget'))
    await waitFor(() => expect(bridge.callsOf('settings.update').at(-1)!.patch.learning).toMatchObject({ budget: { maxUsd: 5, windowDays: 30 } }))
    expect(within(page).queryByTestId('settings-contribute')).toBeNull()
    expect(within(page).queryByTestId('settings-use-shared')).toBeNull()
    expect(within(page).queryByTestId('settings-legacy')).toBeNull()
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
    await waitFor(() => expect(screen.getAllByTestId('handbook-entry')).toHaveLength(1))
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
    // An ordinary conversation, not the coordinator (its sidebar row always reads 总对话).
    bridge.handlers['sessions.coordinator'] = () => { throw Object.assign(new Error('no coordinator'), { code: 'session/not-found' }) }
    await renderApp(bridge)
    emit(bridge, { type: 'session.title', title: '9 月订单按地区汇总' })
    expect(screen.getByTestId('session-item').textContent).toContain('9 月订单按地区汇总')
    expect(screen.getByTestId('conversation').querySelector('.topbar')!.textContent).toContain('9 月订单按地区汇总')
  })
})

describe('organizations on the capabilities page (new direction step 3)', () => {
  it('says in one sentence how the commonest kind of task is organized and how it compares with working alone', async () => {
    const { organizationLead } = await import('../components/Learned.js')
    const base = { classId: 'c1', keywords: ['导出', 'csv', '报表', '接口'], soloRuns: 5, teamRuns: 12 }
    expect(organizationLead(undefined)).toBe('')
    expect(organizationLead([{ ...base, verdict: 'team-better', organization: 'plan-build-review', soloGood: 0.4, teamGood: 0.75, costChange: 0.3 }]))
      .toBe('同类任务用“规划、并行实现、审查”分工，比单独做的顺利率高 35%，花费多 30%。')
    expect(organizationLead([{ ...base, verdict: 'solo-better', soloGood: 0.8, teamGood: 0.6, costChange: 1 }]))
      .toBe('同类任务单独做更好，顺利率比组队高 20%，花费少 50%。')
    expect(organizationLead([{ ...base, verdict: 'comparing' }])).toBe('同类任务还在比较组队和单独做（已做 17 次）。')
    expect(organizationLead([{ ...base, verdict: 'comparing', sinceStart: { costChange: -0.3, timeChange: -0.2, qualityHeld: true } }]))
      .toBe('同类任务还在比较组队和单独做（已做 17 次）。组织调整后，比一开始花费少 30%、快 20%，质量没变。')
  })

  it('says on the team card in one line what changed from the last similar task, and why', async () => {
    const { changeNoteText } = await import('../strings.js')
    const target = { part: 'builder', kind: 'implement' as const, cause: 'cost' as const, value: 0.55 }
    expect(changeNoteText({ status: 'trying', action: 'split', target })).toBe('这次比上次改了一处：“实现”拆给两个成员同时做（上次“实现”占了 55% 的花费）')
    expect(changeNoteText({ status: 'reverted', action: 'split', target, next: { action: 'narrow-reading', target } }))
      .toBe('上次的改动没变好，已退回；这次比上次改了一处：“实现”只读相关的文件（上次“实现”占了 55% 的花费）')
  })
})
