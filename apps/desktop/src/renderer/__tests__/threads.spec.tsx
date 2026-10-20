// @vitest-environment jsdom
/**
 * Coordinator step two in the renderer: a thread run is a card of its own
 * (进行中 / 做完了 / 等你回复) with the way into the thread, a thread's note
 * is one line, threads sit under their conversation in the sidebar, and a
 * thread's title bar leads back.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { FakeBridge, SESSION, memberRun } from '../testing/fake-bridge.js'
import { emit, renderApp } from './helpers.js'

const THREAD = { ...SESSION, sessionId: 't1', title: 'Summary', thread: { coordinatorSessionId: 's1', title: 'Summary' } }

describe('threads', () => {
  it('shows a thread run as its own card, from running to waiting for an answer', async () => {
    const { bridge } = await renderApp()
    emit(bridge, { type: 'turn.start', turn: 1, source: 'user' })
    emit(bridge, { type: 'member.start', turn: 1, run: memberRun({ name: 'summary', childSessionId: 't1', executionForm: 'thread' }) })
    const card = screen.getByTestId('thread-card')
    expect(screen.queryByTestId('team-card')).toBeNull()
    expect(within(card).getByTestId('thread-status').textContent).toBe('进行中')
    emit(bridge, { type: 'member.end', turn: 1, run: memberRun({ name: 'summary', childSessionId: 't1', executionForm: 'thread', status: 'completed', blocker: '要写哪一年？' }) })
    expect(within(screen.getByTestId('thread-card')).getByTestId('thread-status').textContent).toBe('等你回复')
    expect(screen.getByTestId('thread-ask').textContent).toBe('在问：要写哪一年？')

    // The wake note is one line, not a message bubble.
    emit(bridge, { type: 'thread.message', turn: 2, text: 'Thread "Summary" (t1) stopped with a question or blocker. Its last reply:\n…' })
    expect(screen.getByTestId('thread-note').textContent).toBe('讨论串「Summary」等你回复')
    expect(screen.queryAllByTestId('user-message')).toHaveLength(0)

    fireEvent.click(screen.getByTestId('open-thread'))
    await waitFor(() => expect(bridge.callsOf('sessions.open')).toContainEqual(expect.objectContaining({ sessionId: 't1' })))
  })

  it('puts threads under their conversation in the sidebar, marks one waiting, and leads back from it', async () => {
    const bridge = new FakeBridge()
    bridge.sessions = [SESSION, THREAD]
    bridge.threads = [{ threadId: 't1', title: 'Summary', coordinatorSessionId: 's1', status: 'waiting', turns: 1, createdAt: SESSION.createdAt, updatedAt: SESSION.updatedAt, blocker: '要写哪一年？' }]
    const { store } = await renderApp(bridge)
    await waitFor(() => expect(screen.getAllByTestId('thread-item')).toHaveLength(1))
    const item = screen.getByTestId('thread-item')
    expect(item.textContent).toContain('Summary')
    expect(within(item).getByLabelText('等你回复')).toBeTruthy()
    expect(screen.getAllByTestId('session-item')).toHaveLength(1)

    await store.openSession('t1')
    await waitFor(() => expect(screen.getByTestId('thread-back').textContent).toContain('讨论串 · 属于'))
    fireEvent.click(screen.getByTestId('thread-back'))
    await waitFor(() => expect(bridge.callsOf('sessions.open').at(-1)).toMatchObject({ sessionId: 's1' }))
  })
})
