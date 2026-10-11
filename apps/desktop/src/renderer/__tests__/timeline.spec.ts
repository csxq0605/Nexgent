import { describe, expect, it } from 'vitest'
import type { SdkEvent } from '@nexgent/sdk'
import { applyEvent, fromHistory, type TimelineEntry } from '../timeline.js'

let seq = 0
const ev = (event: Record<string, unknown>): SdkEvent => ({ projectId: 'p', sessionId: 's', eventSeq: ++seq, ...event }) as unknown as SdkEvent
const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
const run = (events: Record<string, unknown>[], start: TimelineEntry[] = []): TimelineEntry[] => events.reduce<TimelineEntry[]>((list, e) => applyEvent(list, ev(e)), start)

describe('timeline', () => {
  it('appends text deltas to one streaming entry and finalizes it on assistant.message', () => {
    let list = run([
      { type: 'turn.start', turn: 1, source: 'user' },
      { type: 'text.delta', turn: 1, step: 1, text: '你好' },
      { type: 'text.delta', turn: 1, step: 1, text: '，世界' },
    ])
    expect(list).toEqual([expect.objectContaining({ kind: 'assistant', text: '你好，世界', streaming: true })])
    list = run([{ type: 'assistant.message', turn: 1, step: 1, text: '你好，世界。', finishReason: 'stop', interrupted: false, usage }], list)
    expect(list).toEqual([expect.objectContaining({ kind: 'assistant', text: '你好，世界。', streaming: false })])
  })

  it('keeps streamed text when the turn is cancelled mid-stream', () => {
    const list = run([
      { type: 'text.delta', turn: 2, step: 1, text: '已经写了一半' },
      { type: 'assistant.message', turn: 2, step: 1, text: '已经写了', finishReason: 'aborted', interrupted: true, usage },
      { type: 'turn.end', turn: 2, reason: { kind: 'cancelled', cause: 'user' }, usage },
    ])
    expect(list[0]).toMatchObject({ kind: 'assistant', text: '已经写了一半', interrupted: true, streaming: false })
    expect(list[1]).toMatchObject({ kind: 'turn.end', reason: { kind: 'cancelled' } })
  })

  it('pairs tool.start with tool.result and settles running tools at turn.end', () => {
    let list = run([{ type: 'tool.start', turn: 1, step: 1, call: { id: 'c1', name: 'bash', arguments: '{"command":"ls"}' } }])
    expect(list).toEqual([expect.objectContaining({ kind: 'tool', running: true, name: 'bash' })])
    list = run([{ type: 'tool.result', turn: 1, step: 1, callId: 'c1', name: 'bash', content: 'a.txt', isError: false, durationMs: 12 }], list)
    expect(list).toEqual([expect.objectContaining({ kind: 'tool', running: false, content: 'a.txt' })])
    list = run([{ type: 'tool.start', turn: 1, step: 2, call: { id: 'c2', name: 'bash', arguments: '{}' } }, { type: 'turn.end', turn: 1, reason: { kind: 'completed' }, usage }], list)
    expect(list.find(e => e.key === 't:c2')).toMatchObject({ running: false })
  })

  it('records approvals with their decision and deliverables once', () => {
    const request = { id: 'a1', sessionId: 's', callId: 'c', tool: 'write_file', summary: 'write .env', risk: 'medium', options: ['once'] }
    const deliverable = { deliverableId: 'd', version: 1, title: 't', summary: 's', files: [] }
    const list = run([
      { type: 'approval.request', turn: 1, request },
      { type: 'approval.decision', turn: 1, decision: { id: 'a1', decision: 'allow', scope: 'once', decidedBy: 'user' } },
      { type: 'deliverable.presented', turn: 1, deliverable },
      { type: 'deliverable.presented', turn: 1, deliverable },
    ])
    expect(list.map(e => e.kind)).toEqual(['approval', 'deliverable'])
    expect(list[0]).toMatchObject({ decision: { decision: 'allow' } })
  })

  it('maps display history, skipping empty assistant steps', () => {
    const list = fromHistory([
      { kind: 'user', turn: 1, text: 'hi', source: 'user', materials: ['orders.csv'] },
      { kind: 'assistant', turn: 1, step: 1, text: '', finishReason: 'tool-calls', interrupted: false },
      { kind: 'tool', turn: 1, step: 1, call: { id: 'c', name: 'write_file', arguments: '{}' }, content: 'ok', isError: false, durationMs: 3 },
      { kind: 'turn.end', turn: 1, reason: { kind: 'interrupted' } },
    ])
    expect(list.map(e => e.kind)).toEqual(['user', 'tool', 'turn.end'])
  })
})
