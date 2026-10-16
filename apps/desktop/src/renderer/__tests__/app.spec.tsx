// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { FakeBridge, MATERIAL, ZERO_USAGE, approvalRequest, version } from '../testing/fake-bridge.js'
import { emit, renderApp, showTab } from './helpers.js'

const usage = ZERO_USAGE

describe('conversation', () => {
  it('appends streamed text as it arrives and marks it finished on assistant.message', async () => {
    const { bridge } = await renderApp()
    emit(bridge, { type: 'turn.start', turn: 1, source: 'user' })
    emit(bridge, { type: 'text.delta', turn: 1, step: 1, text: '正在' })
    expect(screen.getByTestId('assistant-message').textContent).toContain('正在')
    emit(bridge, { type: 'text.delta', turn: 1, step: 1, text: '汇总订单' })
    const message = screen.getByTestId('assistant-message')
    expect(message.textContent).toContain('正在汇总订单')
    expect(message.dataset['streaming']).toBe('true')
    expect(screen.getByTestId('stop')).toBeTruthy()
    emit(bridge, { type: 'assistant.message', turn: 1, step: 1, text: '正在汇总订单。', finishReason: 'stop', interrupted: false, usage })
    emit(bridge, { type: 'turn.end', turn: 1, reason: { kind: 'completed' }, usage })
    expect(screen.getByTestId('assistant-message').dataset['streaming']).toBe('false')
    expect(screen.getByTestId('assistant-message').textContent).toContain('正在汇总订单。')
    expect(screen.getByTestId('send')).toBeTruthy()
  })

  it('shows a collapsible tool block that goes from running to done with its output', async () => {
    const { bridge } = await renderApp()
    emit(bridge, { type: 'turn.start', turn: 1, source: 'user' })
    emit(bridge, { type: 'tool.start', turn: 1, step: 1, call: { id: 'c1', name: 'write_file', arguments: JSON.stringify({ path: 'report/summary.csv', content: 'x' }) } })
    const block = screen.getByTestId('tool-block')
    expect(block.textContent).toContain('写入')
    expect(block.textContent).toContain('report/summary.csv')
    expect(block.textContent).toContain('执行中')
    expect(block.hasAttribute('open')).toBe(false)
    // the process is folded into one line by default
    const toggle = screen.getByTestId('steps-toggle')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(toggle.textContent).toBe('正在处理：写入 report/summary.csv')
    emit(bridge, { type: 'tool.result', turn: 1, step: 1, callId: 'c1', name: 'write_file', content: 'Wrote 1 line', isError: false, durationMs: 1200 })
    expect(screen.getByTestId('steps-toggle').textContent).toBe('写入 1 个文件 · 1.2 秒')
    expect(screen.getByTestId('tool-block').textContent).toContain('1.2 秒')
    fireEvent.click(screen.getByTestId('steps-toggle'))
    expect(screen.getByTestId('steps').dataset['open']).toBe('true')
    fireEvent.click(within(screen.getByTestId('tool-block')).getByText('写入'))
    expect(screen.getByTestId('tool-block').textContent).toContain('Wrote 1 line')
  })

  it('sends the message with @-mentioned and freshly added materials', async () => {
    const bridge = new FakeBridge()
    bridge.materials = [MATERIAL, { ...MATERIAL, id: 'm2', originalName: 'regions.xlsx' }]
    await renderApp(bridge)
    const user = userEvent.setup()
    const input = screen.getByTestId('composer-input')
    await user.type(input, '汇总 @ord')
    const menu = screen.getByTestId('mention-menu')
    expect(within(menu).getByText('orders.csv')).toBeTruthy()
    expect(within(menu).queryByText('regions.xlsx')).toBeNull()
    await user.keyboard('{Enter}')
    expect((input as HTMLTextAreaElement).value).toBe('汇总 @orders.csv ')
    await user.type(input, '按地区{Enter}')
    await waitFor(() => expect(bridge.callsOf('turns.send')).toHaveLength(1))
    expect(bridge.callsOf('turns.send')[0]).toEqual({ projectId: 'p1', sessionId: 's1', text: '汇总 @orders.csv 按地区', materialIds: ['m1'] })
    expect((input as HTMLTextAreaElement).value).toBe('')
    expect(screen.getByTestId('user-message').textContent).toContain('汇总 @orders.csv 按地区')
  })

  it('stops the running turn and keeps the text that already streamed', async () => {
    const { bridge } = await renderApp()
    emit(bridge, { type: 'turn.start', turn: 1, source: 'user' })
    emit(bridge, { type: 'text.delta', turn: 1, step: 1, text: '第一部分已经写好，' })
    let release: () => void = () => undefined
    bridge.handlers['turns.cancel'] = () => new Promise<void>(resolve => (release = resolve))
    fireEvent.click(screen.getByTestId('stop'))
    await waitFor(() => expect(bridge.callsOf('turns.cancel')).toEqual([{ projectId: 'p1', sessionId: 's1' }]))
    expect(screen.getByText('正在停止…')).toBeTruthy()
    emit(bridge, { type: 'assistant.message', turn: 1, step: 1, text: '第一部分', finishReason: 'aborted', interrupted: true, usage })
    emit(bridge, { type: 'turn.end', turn: 1, reason: { kind: 'cancelled', cause: 'user' }, usage })
    await act(async () => release())
    expect(screen.getByTestId('assistant-message').textContent).toContain('第一部分已经写好，')
    expect(screen.getByTestId('assistant-message').textContent).toContain('已中断')
    expect(screen.getByTestId('turn-end').textContent).toBe('已停止')
    expect(screen.getByTestId('send')).toBeTruthy()
  })
})

describe('approvals', () => {
  for (const scope of ['once', 'session', 'project'] as const) {
    it(`answers allow with scope ${scope}`, async () => {
      const { bridge } = await renderApp()
      emit(bridge, { type: 'turn.start', turn: 1, source: 'user' })
      emit(bridge, { type: 'approval.request', turn: 1, request: approvalRequest(['once', 'session', 'project']) })
      // the card sits in the conversation, above the composer: deny, once, always (▾ picks the scope)
      const dialog = screen.getByTestId('approval-dialog')
      expect(dialog.closest('[data-testid="conversation"]')).not.toBeNull()
      expect(dialog.textContent).toContain('write .env')
      expect(within(dialog).getByText('允许一次')).toBeTruthy()
      expect(within(dialog).getByText('总是允许')).toBeTruthy()
      expect(screen.queryByTestId('approval-project')).toBeNull()
      if (scope === 'once') fireEvent.click(screen.getByTestId('approval-once'))
      else if (scope === 'session') fireEvent.click(screen.getByTestId('approval-always'))
      else {
        fireEvent.click(screen.getByTestId('approval-scope'))
        expect(within(dialog).getByText('在这段对话里总是允许')).toBeTruthy()
        fireEvent.click(screen.getByTestId('approval-project'))
      }
      await waitFor(() => expect(bridge.callsOf('approvals.respond')).toHaveLength(1))
      expect(bridge.callsOf('approvals.respond')[0]).toEqual({ projectId: 'p1', sessionId: 's1', decision: { id: 'ap1', decision: 'allow', scope } })
      expect(screen.queryByTestId('approval-dialog')).toBeNull()
    })
  }

  it('denies with scope once, and offers only the scopes the request allows', async () => {
    const { bridge } = await renderApp()
    emit(bridge, { type: 'approval.request', turn: 1, request: approvalRequest(['once']) })
    expect(screen.queryByTestId('approval-always')).toBeNull()
    expect(screen.queryByTestId('approval-scope')).toBeNull()
    fireEvent.click(screen.getByTestId('approval-deny'))
    await waitFor(() => expect(bridge.callsOf('approvals.respond')).toEqual([{ projectId: 'p1', sessionId: 's1', decision: { id: 'ap1', decision: 'deny', scope: 'once' } }]))
    emit(bridge, { type: 'approval.decision', turn: 1, decision: { id: 'ap1', decision: 'deny', scope: 'once', decidedBy: 'user' } })
    expect(screen.getByTestId('approval-note').textContent).toContain('已拒绝')
  })

  it('closes the dialog when the turn ends (e.g. approval timeout)', async () => {
    const { bridge } = await renderApp()
    emit(bridge, { type: 'turn.start', turn: 1, source: 'user' })
    emit(bridge, { type: 'approval.request', turn: 1, request: approvalRequest(['once']) })
    expect(screen.getByTestId('approval-dialog')).toBeTruthy()
    emit(bridge, { type: 'turn.end', turn: 1, reason: { kind: 'cancelled', cause: 'timeout' }, usage })
    expect(screen.queryByTestId('approval-dialog')).toBeNull()
  })
})

describe('deliverables', () => {
  it('shows a card on present, then the v1 → v2 diff after feedback', async () => {
    const bridge = new FakeBridge()
    const { store } = await renderApp(bridge)
    bridge.deliverables = [{ deliverableId: 'd1', title: 'summary.csv', versions: [version(1)] }]
    emit(bridge, { type: 'turn.start', turn: 1, source: 'user' })
    emit(bridge, { type: 'deliverable.presented', turn: 1, deliverable: version(1) })
    emit(bridge, { type: 'turn.end', turn: 1, reason: { kind: 'completed' }, usage })
    showTab('deliverables')
    await waitFor(() => expect(screen.getByTestId('tab-deliverables').textContent).toContain('1'))
    const card = screen.getByTestId('deliverable-card')
    expect(card.textContent).toContain('summary.csv')
    expect(card.textContent).toContain('第 1 版')
    expect(card.textContent).toContain('report/summary.csv')

    // feedback from the card opens the form; submitting starts the feedback turn
    fireEvent.click(screen.getByTestId('give-feedback'))
    const view = screen.getByTestId('deliverable-view')
    await waitFor(() => expect(within(view).getByTestId('file-content').textContent).toContain('north,1200'))
    fireEvent.click(within(view).getByLabelText('3'))
    fireEvent.change(within(view).getByTestId('feedback-comment'), { target: { value: '地区用中文名' } })
    fireEvent.click(within(view).getByTestId('submit-feedback'))
    await waitFor(() => expect(bridge.callsOf('feedback.submit')).toEqual([{ projectId: 'p1', sessionId: 's1', deliverableId: 'd1', version: 1, rating: 3, comment: '地区用中文名' }]))
    expect(screen.queryByTestId('deliverable-view')).toBeNull()
    expect(screen.getByTestId('feedback-message').textContent).toContain('地区用中文名')

    bridge.deliverables = [{ deliverableId: 'd1', title: 'summary.csv', versions: [version(1), version(2)] }]
    emit(bridge, { type: 'turn.start', turn: 2, source: 'feedback' })
    emit(bridge, { type: 'deliverable.presented', turn: 2, deliverable: version(2) })
    emit(bridge, { type: 'turn.end', turn: 2, reason: { kind: 'completed' }, usage })
    await waitFor(() => expect(store.getState().deliverables[0]?.versions).toHaveLength(2))
    const cards = screen.getAllByTestId('deliverable-card')
    expect(cards.map(c => c.dataset['version'])).toEqual(['1', '2'])
    expect(within(cards[0]!).queryByTestId('give-feedback')).toBeNull()

    fireEvent.click(within(cards[1]!).getByTestId('open-diff'))
    const diff = await screen.findByTestId('diff-view')
    expect(diff.textContent).toContain('v1 → v2')
    const ops = [...diff.querySelectorAll('[data-op]')].map(el => [el.getAttribute('data-op'), el.textContent])
    expect(ops).toEqual([['context', ' region,total'], ['remove', '-north,1200'], ['add', '+华北,1200']])
    expect(bridge.callsOf('deliverables.diff')).toEqual([{ projectId: 'p1', deliverableId: 'd1', from: 1, to: 2 }])
  })
})

describe('settings', () => {
  it('saves model, thinking, effort, sandbox and cost caps as one patch', async () => {
    const { bridge } = await renderApp()
    fireEvent.click(screen.getByTestId('open-settings'))
    const page = await screen.findByTestId('settings-page')
    fireEvent.change(within(page).getByTestId('setting-model'), { target: { value: 'claude-opus-5-5' } })
    fireEvent.change(within(page).getByTestId('setting-thinking'), { target: { value: 'off' } })
    fireEvent.change(within(page).getByTestId('setting-effort'), { target: { value: 'high' } })
    fireEvent.change(within(page).getByTestId('setting-sandbox'), { target: { value: 'read-only' } })
    fireEvent.change(within(page).getByTestId('cap-task-tokens'), { target: { value: '200000' } })
    fireEvent.change(within(page).getByTestId('cap-project-requests'), { target: { value: '500' } })
    fireEvent.change(within(page).getByTestId('cap-project-window'), { target: { value: '7' } })
    fireEvent.click(within(page).getByTestId('settings-save'))
    await screen.findByTestId('settings-saved')
    expect(bridge.callsOf('settings.update')).toEqual([
      {
        projectId: 'p1',
        patch: { model: 'claude-opus-5-5', thinking: 'off', effort: 'high', sandboxMode: 'read-only', costCaps: { perTask: { maxTokens: 200000 }, perProject: { maxRequests: 500, windowDays: 7 } } },
      },
    ])
  })

  it('rejects a non-numeric cap without calling the backend', async () => {
    const { bridge } = await renderApp()
    fireEvent.click(screen.getByTestId('open-settings'))
    const page = await screen.findByTestId('settings-page')
    fireEvent.change(within(page).getByTestId('cap-task-tokens'), { target: { value: '十万' } })
    fireEvent.click(within(page).getByTestId('settings-save'))
    expect(within(page).getByText(/上限必须是正整数/)).toBeTruthy()
    expect(bridge.callsOf('settings.update')).toEqual([])
  })

  it('writes the API key once, clears the field and shows only configured / source', async () => {
    const { bridge } = await renderApp()
    fireEvent.click(screen.getByTestId('open-settings'))
    const page = await screen.findByTestId('settings-page')
    expect(within(page).getByTestId('api-key-status').textContent).toBe('未配置')
    const secret = 'sk-ant-test-secret-value-123'
    const input = within(page).getByTestId('api-key-input') as HTMLInputElement
    expect(input.type).toBe('password')
    fireEvent.change(input, { target: { value: secret } })
    fireEvent.click(within(page).getByTestId('api-key-save'))
    await waitFor(() => expect(within(page).getByTestId('api-key-status').textContent).toBe('已配置（来源：本机凭证文件）'))
    expect(bridge.callsOf('settings.setApiKey')).toEqual([{ value: secret }])
    expect(input.value).toBe('')
    expect(document.body.innerHTML).not.toContain(secret)
  })
})

describe('errors', () => {
  it('shows a clear screen when there is no backend bridge at all', async () => {
    await renderApp(null, { open: false })
    expect(screen.getByTestId('backend-unavailable').textContent).toContain('无法连接后端')
  })

  it('shows the backend error instead of a blank window when a call fails', async () => {
    const bridge = new FakeBridge()
    bridge.handlers['projects.open'] = () => {
      throw { name: 'NexgentError', code: 'internal', message: '主进程不可用' }
    }
    await renderApp(bridge, { open: false })
    await act(async () => {
      await bridge.invoke('noop', {}).catch(() => undefined)
    })
    expect(screen.getByTestId('start-screen')).toBeTruthy()
    fireEvent.change(screen.getByTestId('project-path'), { target: { value: '/work/sales' } })
    fireEvent.click(screen.getByText('打开'))
    const notice = await screen.findByTestId('notice')
    expect(notice.textContent).toContain('主进程不可用')
    expect(notice.textContent).toContain('internal')
  })

  it('keeps working when the IPC itself throws (main process gone)', async () => {
    const bridge = new FakeBridge()
    await renderApp(bridge)
    bridge.handlers['turns.send'] = () => {
      throw new Error('Error invoking remote method: reply was never sent')
    }
    const user = userEvent.setup()
    await user.type(screen.getByTestId('composer-input'), '你好{Enter}')
    const notice = await screen.findByTestId('notice')
    expect(notice.textContent).toContain('reply was never sent')
    expect(screen.getByTestId('send')).toBeTruthy()
    expect((screen.getByTestId('composer-input') as HTMLTextAreaElement).value).toBe('你好')
  })

  it('contains a render error to its column', async () => {
    const bridge = new FakeBridge()
    await renderApp(bridge)
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    onTestFinished(() => {
      quiet.mockRestore()
      warn.mockRestore()
    })
    // a deliverable without its file list cannot render; only the conversation column shows the error
    emit(bridge, { type: 'deliverable.presented', turn: 1, deliverable: { deliverableId: 'd9', version: 1, title: 'x', summary: '' } })
    expect(screen.getByTestId('render-error').textContent).toContain('界面出错了')
    expect(screen.getByTestId('sidebar')).toBeTruthy()
    expect(screen.getByTestId('nav-capabilities')).toBeTruthy()
  })

  it('reports a malformed event instead of throwing out of the listener', async () => {
    const bridge = new FakeBridge()
    await renderApp(bridge)
    emit(bridge, { type: 'tool.start', turn: 1, step: 1, call: undefined as never })
    expect((await screen.findByTestId('notice')).textContent).toContain('internal')
    expect(screen.getByTestId('composer')).toBeTruthy()
  })
})

describe('project and materials', () => {
  it('lists materials added by path and removes them', async () => {
    const { bridge } = await renderApp()
    showTab('materials')
    fireEvent.change(screen.getByTestId('material-path'), { target: { value: '/data/orders.csv' } })
    fireEvent.click(screen.getByTestId('add-material'))
    await waitFor(() => expect(screen.getAllByTestId('material-item')).toHaveLength(1))
    fireEvent.change(screen.getByTestId('material-path'), { target: { value: '/data/regions.xlsx' } })
    fireEvent.click(screen.getByTestId('add-material'))
    await waitFor(() => expect(screen.getAllByTestId('material-item')).toHaveLength(2))
    expect(bridge.callsOf('materials.add')).toEqual([
      { projectId: 'p1', sourcePath: '/data/orders.csv', sessionId: 's1' },
      { projectId: 'p1', sourcePath: '/data/regions.xlsx', sessionId: 's1' },
    ])
    fireEvent.change(screen.getByTestId('material-path'), { target: { value: 'relative.csv' } })
    fireEvent.click(screen.getByTestId('add-material'))
    expect(screen.getByText('请输入绝对路径。')).toBeTruthy()
    fireEvent.click(within(screen.getAllByTestId('material-item')[0]!).getByText('移除'))
    await waitFor(() => expect(screen.getAllByTestId('material-item')).toHaveLength(1))
  })

  it('opens a project from the start screen and marks interrupted conversations', async () => {
    const bridge = new FakeBridge()
    bridge.sessions = [{ ...bridge.sessions[0]!, interrupted: true }]
    await renderApp(bridge, { open: false })
    expect(screen.getByTestId('recent-projects').textContent).toContain('sales')
    fireEvent.click(within(screen.getByTestId('recent-projects')).getByText('sales'))
    await screen.findByTestId('workspace')
    expect(screen.getByTestId('session-item').querySelector('.dot')?.getAttribute('aria-label')).toBe('上次中断')
    expect(bridge.callsOf('sessions.open')).toEqual([{ projectId: 'p1', sessionId: 's1' }])
  })

  it('shows the native picker buttons only when the bridge has pickers, and uses them', async () => {
    const plain = await renderApp(new FakeBridge(), { open: false })
    expect(screen.queryByTestId('pick-directory')).toBeNull()
    plain.store.dispose()
    cleanup()

    const bridge = Object.assign(new FakeBridge(), {
      pickDirectory: vi.fn(async () => '/work/sales'),
      pickFiles: vi.fn(async () => ['/data/orders.csv', '/data/regions.xlsx']),
    })
    await renderApp(bridge, { open: false })
    fireEvent.click(screen.getByTestId('pick-directory'))
    await screen.findByTestId('workspace')
    expect(bridge.callsOf('projects.open')).toEqual([{ root: '/work/sales' }])
    expect(screen.getByTestId('attach-files')).toBeTruthy()
    showTab('materials')
    fireEvent.click(screen.getByTestId('pick-files'))
    await waitFor(() => expect(screen.getAllByTestId('material-item')).toHaveLength(2))
    expect(bridge.pickFiles).toHaveBeenCalledTimes(1)
    expect(bridge.callsOf('materials.add').map(input => input.sourcePath)).toEqual(['/data/orders.csv', '/data/regions.xlsx'])
  })

  it('shows a turn\'s changed files once: folded under the turn, or on its deliverable card split from the rest', async () => {
    const bridge = new FakeBridge()
    await renderApp(bridge)
    emit(bridge, { type: 'turn.start', turn: 1, source: 'user' })
    emit(bridge, { type: 'turn.files', turn: 1, changes: [{ path: 'report/summary.csv', change: 'added' }, { path: 'old.txt', change: 'deleted' }] })
    emit(bridge, { type: 'turn.end', turn: 1, reason: { kind: 'completed' }, usage })
    const note = screen.getByTestId('files-note')
    expect(note.hasAttribute('open')).toBe(false)
    expect(note.textContent).toContain('改动了 2 个文件')
    expect(note.textContent).toContain('新增')
    expect(note.textContent).toContain('删除')

    emit(bridge, { type: 'turn.start', turn: 2, source: 'user' })
    emit(bridge, { type: 'turn.files', turn: 2, changes: [{ path: 'report/summary.csv', change: 'modified' }, { path: 'scratch/draft.md', change: 'added' }] })
    emit(bridge, { type: 'deliverable.presented', turn: 2, deliverable: version(1) })
    emit(bridge, { type: 'turn.end', turn: 2, reason: { kind: 'completed' }, usage })
    expect(screen.getAllByTestId('files-note')).toHaveLength(1)
    const changes = within(screen.getByTestId('deliverable-card')).getByTestId('deliverable-changes')
    expect(changes.textContent).toContain('改动了 1 个文件')
    expect(within(changes).getByTestId('other-changes').textContent).toContain('过程中另外改动了 1 个文件')
    expect(within(changes).getByTestId('other-changes').textContent).toContain('scratch/draft.md')
  })
})

describe('session rename', () => {
  it('renames from the header; Enter saves, Escape cancels, empty is ignored', async () => {
    const bridge = new FakeBridge()
    await renderApp(bridge)
    expect(screen.getByTestId('session-title').textContent).toBe('销售汇总')
    fireEvent.click(screen.getByTestId('rename-session'))
    const input = screen.getByTestId('rename-input') as HTMLInputElement
    expect(input.value).toBe('销售汇总')
    fireEvent.change(input, { target: { value: '  六月订单  ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(screen.getByTestId('session-title').textContent).toBe('六月订单'))
    expect(bridge.callsOf('sessions.rename')).toEqual([{ projectId: 'p1', sessionId: 's1', title: '六月订单' }])
    expect(screen.getByTestId('session-item').textContent).toContain('六月订单')

    fireEvent.click(screen.getByTestId('rename-session'))
    fireEvent.change(screen.getByTestId('rename-input'), { target: { value: '不要' } })
    fireEvent.keyDown(screen.getByTestId('rename-input'), { key: 'Escape' })
    fireEvent.click(screen.getByTestId('rename-session'))
    fireEvent.change(screen.getByTestId('rename-input'), { target: { value: '   ' } })
    fireEvent.keyDown(screen.getByTestId('rename-input'), { key: 'Enter' })
    expect(screen.getByTestId('session-title').textContent).toBe('六月订单')
    expect(bridge.callsOf('sessions.rename')).toHaveLength(1)
  })
})

describe('markdown replies', () => {
  it('renders Markdown (GFM tables, code, lists) and never raw HTML', async () => {
    const { bridge } = await renderApp()
    const text = ['## 汇总', '', '**华北**最高，见 `report/summary.csv`：', '', '| 地区 | 金额 |', '| --- | --- |', '| 华北 | 1200 |', '', '- 去重', '- 换算', '', '<img src=x onerror="alert(1)"><script>alert(2)</script>', '', '[来源](https://example.com/a)'].join('\n')
    emit(bridge, { type: 'turn.start', turn: 1, source: 'user' })
    emit(bridge, { type: 'assistant.message', turn: 1, step: 1, text, finishReason: 'stop', interrupted: false, usage })
    const message = screen.getByTestId('assistant-message')
    expect(message.querySelector('h2')?.textContent).toBe('汇总')
    expect(message.querySelector('strong')?.textContent).toBe('华北')
    expect(message.querySelector('code')?.textContent).toBe('report/summary.csv')
    expect([...message.querySelectorAll('td')].map(td => td.textContent)).toEqual(['华北', '1200'])
    expect(message.querySelectorAll('li')).toHaveLength(2)
    expect(message.querySelector('script')).toBeNull()
    expect(message.querySelector('img')).toBeNull()
    const link = message.querySelector('a')!
    expect(link.getAttribute('title')).toBe('https://example.com/a')
    const click = new MouseEvent('click', { bubbles: true, cancelable: true })
    link.dispatchEvent(click)
    expect(click.defaultPrevented).toBe(true)
  })

  it('bolds emphasis that ends in CJK punctuation right before CJK text', async () => {
    const { bridge } = await renderApp()
    emit(bridge, { type: 'turn.start', turn: 1, source: 'user' })
    emit(bridge, { type: 'assistant.message', turn: 1, step: 1, text: '**金额口径：**按数量×单价计算，**“已完成”**才计入。', finishReason: 'stop', interrupted: false, usage })
    const message = screen.getByTestId('assistant-message')
    expect([...message.querySelectorAll('strong')].map(node => node.textContent)).toEqual(['金额口径：', '“已完成”'])
    expect(message.textContent).not.toContain('**')
  })
})
