// @vitest-environment jsdom
// "换个做法再试": a quiet button after a finished task, one line while it runs, both results side by side, then use or undo.
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { FakeBridge } from '../testing/fake-bridge.js'
import { emit, renderApp } from './helpers.js'

function finished(): FakeBridge {
  const bridge = new FakeBridge()
  bridge.view = {
    ...bridge.view,
    items: [
      { kind: 'user', turn: 1, text: '整理六月订单', source: 'user', materials: [] },
      { kind: 'turn.end', turn: 1, reason: { kind: 'completed' } },
    ],
  }
  bridge.retry = { offer: { turn: 1, side: { decision: 'solo' }, estimateUsd: 0.42 } }
  return bridge
}

describe('try another way', () => {
  it('offers, runs, compares, uses the new result and undoes it', async () => {
    const { bridge } = await renderApp(finished())
    const offer = await screen.findByTestId('retry-start')
    expect(offer.textContent).toBe('换个做法再试（约 0.42 美元）')
    fireEvent.click(offer)
    expect((await screen.findByTestId('retry-running')).textContent).toContain('正在用「一个人做」重做')
    const ready = {
      ...bridge.retry.latest!,
      status: 'ready' as const,
      original: { ...bridge.retry.latest!.original, usd: 0.42, files: ['summary.csv'] },
      retry: { side: { decision: 'solo' as const }, usd: 0.2, files: [{ path: 'summary.csv', change: 'changed' as const }, { path: 'notes.md', change: 'added' as const }], reply: '做完了' },
    }
    bridge.retry = { latest: ready }
    emit(bridge, { type: 'retry.update', retry: ready })
    const card = await screen.findByTestId('retry-card')
    expect(card.textContent).toContain('原来的 · 小组（主做加检查）')
    expect(card.textContent).toContain('新的 · 一个人做')
    expect(card.textContent).toContain('notes.md')
    fireEvent.click(screen.getByTestId('retry-use-new'))
    await waitFor(() => expect(bridge.callsOf('retries.choose')).toEqual([{ projectId: 'p1', retryId: 'r1', keep: 'retry' }]))
    expect((await screen.findByTestId('retry-applied')).textContent).toContain('已换成新的结果')
    fireEvent.click(screen.getByTestId('retry-undo'))
    await waitFor(() => expect(bridge.callsOf('retries.undo')).toEqual([{ projectId: 'p1', retryId: 'r1' }]))
    expect((await screen.findByTestId('retry-ended')).textContent).toContain('已换回原来的结果')
  })

  it('shows nothing while a turn runs or when there is nothing to redo', async () => {
    const bridge = new FakeBridge()
    await renderApp(bridge)
    expect(screen.queryByTestId('retry-start')).toBeNull()
    emit(bridge, { type: 'turn.start', turn: 1, source: 'user' })
    expect(screen.queryByTestId('retry-start')).toBeNull()
  })
})
