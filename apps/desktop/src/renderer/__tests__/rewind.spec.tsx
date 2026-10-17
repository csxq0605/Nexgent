// @vitest-environment jsdom
// Redesign 3.1 / 3.2: taking files back to before a message (preview, then confirm), and the automatic-retry line.
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { FakeBridge } from '../testing/fake-bridge.js'
import { emit, renderApp } from './helpers.js'

function withHistory(): FakeBridge {
  const bridge = new FakeBridge()
  bridge.view = {
    ...bridge.view,
    items: [
      { kind: 'user', turn: 1, text: '整理六月订单', source: 'user', materials: [] },
      { kind: 'files', turn: 1, changes: [{ path: 'summary.csv', change: 'added' }, { path: 'orders.csv', change: 'modified' }] },
      { kind: 'turn.end', turn: 1, reason: { kind: 'completed' } },
      { kind: 'user', turn: 2, text: '谢谢', source: 'user', materials: [] },
      { kind: 'turn.end', turn: 2, reason: { kind: 'completed' } },
    ],
  }
  bridge.rewind = { turn: 1, takenAt: '2026-10-16T10:00:00.000Z', changes: [{ path: 'orders.csv', action: 'restore' }, { path: 'summary.csv', action: 'delete' }], unchanged: ['notes.md'] }
  return bridge
}

describe('taking files back', () => {
  it('lists what changes, writes only after confirming, and records it in the conversation', async () => {
    const { bridge } = await renderApp(withHistory())
    // Only the message whose turn changed files offers it.
    expect(screen.getAllByTestId('rewind-open')).toHaveLength(1)
    fireEvent.click(screen.getByTestId('rewind-open'))
    const dialog = await screen.findByTestId('rewind-dialog')
    await waitFor(() => expect(within(dialog).getByTestId('rewind-restore').textContent).toContain('orders.csv'))
    expect(within(dialog).getByTestId('rewind-delete').textContent).toContain('summary.csv')
    expect(dialog.textContent).toContain('另有 1 个文件已经和当时一样')
    expect(bridge.callsOf('sessions.rewind')).toEqual([{ projectId: 'p1', sessionId: 's1', turn: 1 }])
    fireEvent.click(within(dialog).getByTestId('rewind-confirm'))
    await waitFor(() => expect(screen.queryByTestId('rewind-dialog')).toBeNull())
    expect(bridge.callsOf('sessions.rewind').at(-1)).toEqual({ projectId: 'p1', sessionId: 's1', turn: 1, apply: true })
    expect((await screen.findByTestId('rewind-note')).textContent).toContain('已撤回文件改动：恢复 1 个，删除 1 个')
  })

  it('says so when the turn left no snapshot, and writes nothing', async () => {
    const bridge = withHistory()
    bridge.rewind = undefined
    await renderApp(bridge)
    fireEvent.click(screen.getByTestId('rewind-open'))
    expect((await screen.findByTestId('rewind-unavailable')).textContent).toBe('这一轮太早，没有留下文件快照，无法撤回。')
    expect(screen.queryByTestId('rewind-confirm')).toBeNull()
    expect(bridge.callsOf('sessions.rewind').filter(call => (call as { apply?: boolean }).apply === true)).toEqual([])
  })
})

describe('automatic retry after failed checks', () => {
  it('shows one plain line, with what failed inside', async () => {
    const { bridge } = await renderApp()
    emit(bridge, { type: 'turn.start', turn: 1, source: 'user' })
    emit(bridge, { type: 'check.retry', turn: 1, retry: { attempt: 1, max: 2, failed: [{ check: 'test-command', target: 'npm test', detail: 'exit 1' }, { check: 'parses', target: 'out.json', format: 'json' }] } })
    const line = screen.getByTestId('check-retry')
    expect(line.querySelector('summary')!.textContent).toContain('检查没通过，自动再改一次（第 1 次，最多 2 次）')
    expect(line.textContent).toContain('测试命令 npm test 没通过')
    expect(line.textContent).toContain('out.json 不能按 json 读取')
    // No rewind while the turn runs.
    expect(screen.queryByTestId('rewind-open')).toBeNull()
  })
})
