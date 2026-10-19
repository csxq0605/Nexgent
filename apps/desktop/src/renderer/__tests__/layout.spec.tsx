// @vitest-environment jsdom
/**
 * The window of ADR 0020: two columns, the 资料与成果 drawer, 能力 and 设置
 * as full pages, the folded process line, one 小组进度 card per turn and the
 * light / dark appearance.
 */
import { fireEvent, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { durationText, sessionGroup, stepsParts } from '../strings.js'
import { FakeBridge, ZERO_USAGE, memberRun } from '../testing/fake-bridge.js'
import type { TimelineEntry } from '../timeline.js'
import { blocksOf, stepsLine } from '../components/Timeline.js'
import { emit, renderApp } from './helpers.js'

const usage = ZERO_USAGE
const tool = (key: string, turn: number, name: string, extra: Partial<Extract<TimelineEntry, { kind: 'tool' }>> = {}): TimelineEntry =>
  ({ kind: 'tool', key, turn, step: 1, callId: key, name, args: JSON.stringify({ path: `${key}.csv` }), running: false, durationMs: 300, ...extra }) as TimelineEntry

describe('two columns and the drawer', () => {
  it('has no right column; the drawer opens from the top bar, switches tabs and closes with Escape', async () => {
    await renderApp()
    expect(screen.getByTestId('sidebar')).toBeTruthy()
    expect(screen.getByTestId('main')).toBeTruthy()
    expect(screen.queryByTestId('right-panel')).toBeNull()
    expect(screen.queryByTestId('drawer')).toBeNull()
    fireEvent.click(screen.getByTestId('drawer-toggle'))
    const drawer = screen.getByTestId('drawer')
    expect(within(drawer).getByTestId('tab-materials').getAttribute('aria-selected')).toBe('true')
    fireEvent.click(within(drawer).getByTestId('tab-deliverables'))
    expect(within(drawer).getByTestId('tab-deliverables').getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByTestId('drawer')).toBeNull()
    fireEvent.click(screen.getByTestId('drawer-toggle'))
    fireEvent.click(screen.getByTestId('drawer-close'))
    expect(screen.queryByTestId('drawer')).toBeNull()
  })

  it('shows 能力 and 设置 as full pages in the main area, with the way back to the conversation', async () => {
    await renderApp()
    fireEvent.click(screen.getByTestId('nav-capabilities'))
    expect(screen.getByTestId('capabilities-page')).toBeTruthy()
    expect(screen.queryByTestId('conversation')).toBeNull()
    expect(screen.queryByTestId('tab-capabilities')).toBeNull()
    expect(screen.queryByTestId('tab-improvements')).toBeNull()
    fireEvent.click(screen.getByTestId('page-back'))
    expect(screen.getByTestId('conversation')).toBeTruthy()
    fireEvent.click(screen.getByTestId('open-settings'))
    expect(screen.getByTestId('settings-page')).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.getByTestId('conversation')).toBeTruthy()
    // a conversation in the sidebar always brings the conversation back
    fireEvent.click(screen.getByTestId('nav-capabilities'))
    fireEvent.click(screen.getByTestId('session-item'))
    expect(screen.getByTestId('conversation')).toBeTruthy()
  })

  it('switches light / dark / system from 设置 and remembers the choice', async () => {
    await renderApp()
    fireEvent.click(screen.getByTestId('open-settings'))
    fireEvent.click(screen.getByTestId('theme-dark'))
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(window.localStorage.getItem('nexgent.theme')).toBe('dark')
    fireEvent.click(screen.getByTestId('theme-light'))
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    fireEvent.click(screen.getByTestId('theme-system'))
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
    expect(window.localStorage.getItem('nexgent.theme')).toBeNull()
  })
})

describe('the process, folded', () => {
  it('groups consecutive process entries of a turn, and puts all members of a turn in one card', () => {
    const entries: TimelineEntry[] = [
      { kind: 'user', key: 'u1', turn: 1, text: '汇总', feedback: false, materials: [] },
      tool('a', 1, 'read_file'),
      tool('b', 1, 'read_file'),
      { kind: 'member', key: 'm1', turn: 1, run: memberRun({ name: 'north' }) },
      tool('c', 1, 'bash'),
      { kind: 'member', key: 'm2', turn: 1, run: memberRun({ name: 'south', childSessionId: 'c2' }) },
      tool('d', 2, 'read_file'),
    ]
    const blocks = blocksOf(entries)
    expect(blocks.map(b => b.kind)).toEqual(['entry', 'steps', 'team', 'steps', 'steps'])
    const team = blocks[2]!
    expect(team.kind === 'team' && team.members.map(m => m.run.name)).toEqual(['north', 'south'])
  })

  it('says what runs now, or what was done and how long it took', () => {
    expect(stepsLine([tool('a', 1, 'read_file'), tool('b', 1, 'bash', { running: true, args: JSON.stringify({ command: 'pnpm test' }) })])).toEqual({ text: '正在处理：运行命令 pnpm test', running: true })
    expect(stepsLine([tool('a', 1, 'read_file'), tool('b', 1, 'read_file'), tool('c', 1, 'bash', { durationMs: 2000 })]).text).toBe('读了 2 个文件，运行了 1 条命令 · 2.6 秒')
    expect(stepsParts([])).toEqual([])
  })

  it('writes durations people can read', () => {
    expect(durationText(4)).toBe('不到 0.1 秒')
    expect(durationText(1234)).toBe('1.2 秒')
    expect(durationText(42_000)).toBe('42 秒')
    expect(durationText(125_000)).toBe('2 分 5 秒')
  })

  it('groups conversations by today, this week and earlier', () => {
    const now = new Date(2026, 9, 16, 15, 0)
    expect(sessionGroup(new Date(2026, 9, 16, 9, 0).toISOString(), now)).toBe('today')
    expect(sessionGroup(new Date(2026, 9, 12, 9, 0).toISOString(), now)).toBe('week')
    expect(sessionGroup(new Date(2026, 8, 1).toISOString(), now)).toBe('earlier')
  })

  it('shows members of a turn as rows of one 小组进度 card with a count of the finished', async () => {
    const { bridge } = await renderApp(new FakeBridge())
    emit(bridge, { type: 'turn.start', turn: 1, source: 'user' })
    emit(bridge, { type: 'member.start', turn: 1, run: memberRun({ name: 'north' }) })
    emit(bridge, { type: 'member.start', turn: 1, run: memberRun({ name: 'south', childSessionId: 'c2' }) })
    emit(bridge, { type: 'member.end', turn: 1, run: memberRun({ name: 'north', status: 'completed' }) })
    const card = screen.getByTestId('team-card')
    expect(within(card).getAllByTestId('member-block').map(row => row.dataset['member'])).toEqual(['north', 'south'])
    expect(card.textContent).toContain('1 / 2 完成')
    expect(screen.getAllByTestId('team-card')).toHaveLength(1)
    emit(bridge, { type: 'turn.end', turn: 1, reason: { kind: 'completed' }, usage })
  })
})
