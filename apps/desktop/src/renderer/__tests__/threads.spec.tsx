// @vitest-environment jsdom
/**
 * Coordinator step two in the renderer: a thread run is a card of its own
 * (进行中 / 做完了 / 等你回复) with the way into the thread, a thread's note
 * is one line, threads sit under their conversation in the sidebar, and a
 * thread's title bar leads back.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { FakeBridge, SESSION, approvalRequest, memberRun } from '../testing/fake-bridge.js'
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

  it('shows on the coordinator\'s card and in the sidebar that a thread waits for the user to allow something', async () => {
    const bridge = new FakeBridge()
    bridge.sessions = [SESSION, THREAD]
    const running = { threadId: 't1', title: 'Summary', coordinatorSessionId: 's1', status: 'running' as const, turns: 1, createdAt: SESSION.createdAt, updatedAt: SESSION.updatedAt }
    bridge.threads = [running]
    await renderApp(bridge)
    emit(bridge, { type: 'turn.start', turn: 1, source: 'user' })
    emit(bridge, { type: 'member.start', turn: 1, run: memberRun({ name: 'summary', childSessionId: 't1', executionForm: 'thread' }) })
    expect(screen.getByTestId('thread-status').textContent).toBe('进行中')

    // The thread asks in the background: its card and its row say so, and one click leads there.
    emit(bridge, { type: 'approval.request', sessionId: 't1', turn: 1, request: { ...approvalRequest(['once']), sessionId: 't1' } })
    expect(screen.getByTestId('thread-status').textContent).toBe('等你批准')
    expect(screen.getByTestId('thread-approval').textContent).toContain('进入讨论串')
    expect(within(screen.getByTestId('thread-item')).getByLabelText('等你批准')).toBeTruthy()

    // Answered (in the thread): back to running.
    bridge.threads = [running]
    emit(bridge, { type: 'approval.decision', sessionId: 't1', turn: 1, decision: { id: 'ap1', decision: 'allow', scope: 'once', decidedBy: 'user' } })
    await waitFor(() => expect(screen.getByTestId('thread-status').textContent).toBe('进行中'))
    expect(screen.queryByTestId('thread-approval')).toBeNull()
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

  it('folds finished threads into one row and keeps the others in view', async () => {
    const bridge = new FakeBridge()
    const DONE = { ...SESSION, sessionId: 't2', title: 'Index', thread: { coordinatorSessionId: 's1', title: 'Index' } }
    bridge.sessions = [SESSION, THREAD, DONE]
    const base = { coordinatorSessionId: 's1', turns: 1, createdAt: SESSION.createdAt, updatedAt: SESSION.updatedAt }
    bridge.threads = [{ ...base, threadId: 't1', title: 'Summary', status: 'running' as const }, { ...base, threadId: 't2', title: 'Index', status: 'done' as const }]
    await renderApp(bridge)
    await waitFor(() => expect(screen.getByTestId('thread-fold').textContent).toContain('已完成的讨论串（1）'))
    expect(screen.getAllByTestId('thread-item').map(item => item.textContent)).toEqual([expect.stringContaining('Summary')])
    fireEvent.click(screen.getByTestId('thread-fold'))
    expect(screen.getAllByTestId('thread-item')).toHaveLength(2)
  })

  it('keeps the coordinator pinned and named after it opens, and shows the turn\'s organization change under its message once the turn organized the work', async () => {
    const bridge = new FakeBridge()
    bridge.sessions = [{ ...SESSION, coordinator: true as const }]
    // An open answers the summary without the list's coordinator mark.
    bridge.handlers['sessions.open'] = () => ({ ...bridge.view, summary: { ...SESSION } })
    await renderApp(bridge)
    await waitFor(() => expect(screen.getAllByTestId('session-item')[0]!.textContent).toContain('总对话'))
    emit(bridge, { type: 'turn.start', turn: 1, source: 'user', change: { status: 'trying', action: 'split', target: { part: 'docs', kind: 'thread', cause: 'cost', value: 0.6 } } })
    // Not shown while the turn has not organized anything (a turn done alone did not try it).
    expect(screen.queryByTestId('turn-change')).toBeNull()
    emit(bridge, { type: 'member.start', turn: 1, run: memberRun({ name: 'docs', childSessionId: 't1', executionForm: 'thread' }) })
    expect(screen.getByTestId('turn-change').textContent).toBe('这次比上次改了一处：讨论串「docs」的活拆成两个讨论串（上次讨论串「docs」占了 60% 的花费）')
  })

  it('keeps a conversation the user creates while the project is still loading, instead of switching to the coordinator', async () => {
    const bridge = new FakeBridge()
    bridge.sessions = [{ ...SESSION, coordinator: true as const }]
    let release: () => void = () => {}
    const coordinator = bridge.handlers['sessions.coordinator']!
    bridge.handlers['sessions.coordinator'] = input => new Promise(resolve => { release = () => resolve(coordinator(input)) })
    const { store } = await renderApp(bridge, { open: false })
    const opening = store.openProject('/work/sales')
    await waitFor(() => expect(bridge.callsOf('sessions.coordinator')).toHaveLength(1))
    await store.newSession()
    expect(store.getState().sessionId).toBe('s2')
    release()
    await opening
    expect(store.getState().sessionId).toBe('s2')
  })

  it('opens a new conversation behind the 能力 page the user opened while it was being created, and holds the composer meanwhile', async () => {
    const bridge = new FakeBridge()
    let release: () => void = () => {}
    const create = bridge.handlers['sessions.create']!
    bridge.handlers['sessions.create'] = input => new Promise(resolve => { release = () => resolve(create(input)) })
    const { store } = await renderApp(bridge)
    const creating = store.newSession()
    await waitFor(() => expect((screen.getByTestId('composer-input') as HTMLTextAreaElement).disabled).toBe(true))
    fireEvent.click(screen.getByTestId('nav-capabilities'))
    await waitFor(() => expect(screen.getByTestId('capabilities-page')).toBeTruthy())
    release()
    await creating
    expect(screen.getByTestId('capabilities-page')).toBeTruthy()
    expect(store.getState().sessionId).toBe('s2')
  })
})
