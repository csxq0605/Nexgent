// @vitest-environment jsdom
/**
 * Step 3 in the renderer (W6): member blocks in the conversation, the
 * member's session read-only, final vs member deliverables, and approvals
 * that name the member asking.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { FakeBridge, SESSION, ZERO_USAGE, approvalRequest, memberRun, version } from '../testing/fake-bridge.js'
import { emit, renderApp } from './helpers.js'

const usage = { ...ZERO_USAGE, inputTokens: 1200, outputTokens: 80, totalTokens: 1280 }
const ref = { deliverableId: 'd2', version: 1, title: 'north.md', summary: '北区', files: [{ path: 'out/north.md', size: 10, sha256: 'c'.repeat(64), mediaType: 'text/markdown' }], memberName: 'analyst' }

describe('member blocks', () => {
  it('shows a member block that goes from running to completed with usage and deliverable links', async () => {
    const { bridge } = await renderApp()
    emit(bridge, { type: 'turn.start', turn: 1, source: 'user' })
    emit(bridge, { type: 'member.start', turn: 1, run: memberRun({ preset: 'read-only-analyst' }) })
    const block = screen.getByTestId('member-block')
    expect(block.dataset['member']).toBe('analyst')
    expect(block.textContent).toContain('委派')
    expect(block.textContent).toContain('read-only-analyst')
    expect(within(block).getByTestId('member-status').textContent).toBe('进行中')
    expect(block.hasAttribute('open')).toBe(false)

    // The member's own stream does not enter the main conversation.
    emit(bridge, { type: 'text.delta', sessionId: 'c1', parentSessionId: 's1', turn: 1, step: 1, text: '成员在写' })
    expect(screen.queryByText('成员在写')).toBeNull()

    emit(bridge, { type: 'member.end', turn: 1, run: memberRun({ preset: 'read-only-analyst', status: 'completed', deliverables: [ref], usage }) })
    const done = screen.getByTestId('member-block')
    expect(within(done).getByTestId('member-status').textContent).toBe('完成')
    expect(done.textContent).toContain('成果 1')
    fireEvent.click(within(done).getByText('analyst'))
    expect(within(done).getByTestId('member-usage').textContent).toBe('输入 1200 / 输出 80 tokens')
    expect(within(done).getByTestId('member-deliverable').textContent).toContain('north.md v1')
    fireEvent.click(within(done).getByTestId('member-deliverable'))
    await waitFor(() => expect(bridge.callsOf('deliverables.get')).toContainEqual(expect.objectContaining({ deliverableId: 'd2', version: 1 })))
  })

  it('opens the member\'s session read-only and goes back to the conversation', async () => {
    const bridge = new FakeBridge()
    bridge.view = { ...bridge.view, items: [{ kind: 'member', turn: 1, run: memberRun({ status: 'completed', deliverables: [ref] }) }] }
    bridge.memberViews['c1'] = {
      summary: { ...SESSION, sessionId: 'c1', title: undefined, parentSessionId: 's1', member: { name: 'analyst', executionForm: 'delegated' } } as never,
      sandboxMode: 'read-only',
      model: 'claude-sonnet-5-5',
      items: [
        { kind: 'user', turn: 1, text: '写北区汇总', source: 'user', materials: [] },
        { kind: 'assistant', turn: 1, step: 1, text: '北区写好了。', finishReason: 'stop', interrupted: false },
        { kind: 'deliverable', turn: 1, deliverable: ref },
      ],
      totalUsage: ZERO_USAGE,
    }
    await renderApp(bridge)
    fireEvent.click(within(screen.getByTestId('member-block')).getByText('analyst'))
    fireEvent.click(screen.getByTestId('open-member'))
    await waitFor(() => expect(screen.getByTestId('member-view')).toBeTruthy())
    expect(bridge.callsOf('sessions.view')).toEqual([{ projectId: 'p1', sessionId: 'c1' }])
    expect(bridge.callsOf('sessions.open').map(input => input.sessionId)).not.toContain('c1')
    const view = screen.getByTestId('member-view')
    expect(within(view).getByTestId('member-view-title').textContent).toBe('成员 analyst 的会话')
    expect(view.textContent).toContain('北区写好了。')
    expect(within(view).getByTestId('deliverable-card')).toBeTruthy()
    // Read-only: no composer, no feedback button.
    expect(screen.queryByTestId('composer-input')).toBeNull()
    expect(within(view).queryByTestId('give-feedback')).toBeNull()
    expect(screen.getByTestId('member-readonly')).toBeTruthy()

    // Live events of the member reach its open view.
    emit(bridge, { type: 'text.delta', sessionId: 'c1', parentSessionId: 's1', turn: 2, step: 1, text: '又补了一段' })
    expect(screen.getByTestId('member-view').textContent).toContain('又补了一段')

    fireEvent.click(screen.getByTestId('member-back'))
    expect(screen.queryByTestId('member-view')).toBeNull()
    expect(screen.getByTestId('composer-input')).toBeTruthy()
    expect(screen.getByTestId('member-block')).toBeTruthy()
  })

  it('shows a workflow with its phases and members, and team mail', async () => {
    const bridge = new FakeBridge()
    bridge.workflows = [{ workflowId: 'w1', kind: 'script', title: 'regions', phases: ['parts'], status: 'running', members: 1 }]
    const { bridge: b } = await renderApp(bridge)
    emit(b, { type: 'turn.start', turn: 1, source: 'user' })
    emit(b, { type: 'workflow.phase', turn: 1, workflowId: 'w1', phase: 'parts' })
    emit(b, { type: 'member.start', turn: 1, run: memberRun({ name: 'north', executionForm: 'workflow', workflowId: 'w1' }) })
    await waitFor(() => expect(screen.getByTestId('workflow-block').textContent).toContain('regions'))
    const workflow = screen.getByTestId('workflow-block')
    expect(workflow.textContent).toContain('阶段：parts')
    expect(within(screen.getByTestId('member-block')).getByText('工作流成员')).toBeTruthy()
    emit(b, { type: 'team.message', turn: 1, message: { id: 'x1', from: 'bob', to: 'lead', text: '数据好了', state: 'queued' } })
    expect(screen.getByTestId('team-message').textContent).toContain('待投递')
    emit(b, { type: 'team.message', turn: 1, message: { id: 'x1', from: 'bob', to: 'lead', text: '数据好了', state: 'delivered' } })
    expect(screen.getAllByTestId('team-message')).toHaveLength(1)
    expect(screen.getByTestId('team-message').textContent).toContain('bob → lead')
    expect(screen.getByTestId('team-message').textContent).toContain('已投递')
  })

  it('separates final deliverables from member deliverables', async () => {
    const bridge = new FakeBridge()
    bridge.deliverables = [
      { deliverableId: 'd2', title: 'north.md', versions: [{ ...version(1, 'd2'), title: 'north.md', memberId: 'c1', memberName: 'analyst' }] },
      { deliverableId: 'd1', title: 'summary.csv', versions: [version(1)] },
    ]
    await renderApp(bridge)
    fireEvent.click(screen.getByTestId('tab-deliverables'))
    const finals = screen.getByTestId('final-deliverables')
    const members = screen.getByTestId('member-deliverables')
    expect(within(finals).getByText('summary.csv')).toBeTruthy()
    expect(within(finals).queryByText('north.md')).toBeNull()
    expect(within(members).getByText('north.md')).toBeTruthy()
    expect(within(members).getByText('来自成员 analyst')).toBeTruthy()
    expect(screen.getByText('最终成果')).toBeTruthy()
    expect(screen.getByText('成员成果')).toBeTruthy()
  })

  it('shows the member count of a conversation in the list', async () => {
    const bridge = new FakeBridge()
    bridge.sessions = [{ ...SESSION, childCount: 2 }]
    await renderApp(bridge)
    expect(screen.getByTestId('session-item').textContent).toContain('2 个成员')
  })
})

describe('member approvals', () => {
  it('names the member in the approval dialog and answers under the member\'s session', async () => {
    const { bridge } = await renderApp()
    emit(bridge, { type: 'turn.start', turn: 1, source: 'user' })
    emit(bridge, { type: 'member.start', turn: 1, run: memberRun({ name: 'writer' }) })
    const request = { ...approvalRequest(['once']), sessionId: 'c1', member: { name: 'writer', executionForm: 'delegated' as const, parentSessionId: 's1' } }
    emit(bridge, { type: 'approval.request', sessionId: 'c1', parentSessionId: 's1', turn: 1, request })
    const dialog = await screen.findByTestId('approval-dialog')
    expect(within(dialog).getByTestId('approval-member').textContent).toBe('成员 writer（委派）请求这一操作')
    expect(screen.getByTestId('approval-note').textContent).toContain('writer')
    fireEvent.click(within(dialog).getByTestId('approval-once'))
    await waitFor(() => expect(bridge.callsOf('approvals.respond')).toEqual([{ projectId: 'p1', sessionId: 'c1', decision: { id: 'ap1', decision: 'allow', scope: 'once' } }]))
    expect(screen.queryByTestId('approval-dialog')).toBeNull()
    emit(bridge, { type: 'approval.decision', sessionId: 'c1', parentSessionId: 's1', turn: 1, decision: { id: 'ap1', decision: 'allow', scope: 'once', decidedBy: 'user' } })
    expect(screen.getByTestId('approval-note').textContent).toContain('已允许')
  })

  it('ignores approvals of members of other conversations', async () => {
    const { bridge } = await renderApp()
    const request = { ...approvalRequest(['once']), sessionId: 'c9', member: { name: 'other', executionForm: 'team' as const, parentSessionId: 's9' } }
    emit(bridge, { type: 'approval.request', sessionId: 'c9', parentSessionId: 's9', turn: 1, request })
    expect(screen.queryByTestId('approval-dialog')).toBeNull()
  })
})
