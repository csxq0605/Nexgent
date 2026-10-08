import { describe, expect, it } from 'vitest'
import { isNexgentError, UNKNOWN_USAGE, type SessionRecord, type SessionRecordInput } from '@nexgent/kernel'
import { foldRecord, initialState, projectSession, replay, SessionProjector, shouldCheckpoint } from '../src/index.js'
import { KNOWN_USAGE, turnRecords } from './helpers.js'

const ID = 'proj-session'
const TS = '2026-10-07T08:00:00.000Z'

function stamp(inputs: readonly SessionRecordInput[]): SessionRecord[] {
  const start: SessionRecordInput = {
    type: 'session.start', version: 1, projectRoot: '/p', model: 'm', sandboxMode: 'full-access', title: 'T',
  }
  return [start, ...inputs].map((input, index) => ({ ...input, seq: index + 1, ts: TS, sessionId: ID }) as SessionRecord)
}

describe('projection', () => {
  it('initial state carries session.start metadata, zero usage, no grants', () => {
    const [start] = stamp([])
    if (start?.type !== 'session.start') throw new Error('unreachable')
    expect(initialState(start)).toEqual({
      sessionId: ID,
      version: 1,
      messages: [],
      metadata: {
        createdAt: TS,
        projectRoot: '/p',
        model: 'm',
        sandboxMode: 'full-access',
        grants: [],
        title: 'T',
        lastTurn: 0,
        totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 },
        lastSeq: 1,
      },
    })
  })

  it('folds a completed turn into request-form messages and sums usage', () => {
    const records = stamp(turnRecords(1))
    const state = projectSession(records)
    expect(state.messages).toEqual([
      { role: 'user', content: 'prompt 1 — 你好' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'read_file', arguments: '{"path":"README.md"}' }] },
      { role: 'tool', toolCallId: 'call_1', name: 'read_file', content: '# Hi', isError: false },
      { role: 'assistant', content: 'done 1 ✓' },
    ])
    expect(state.metadata.totalUsage).toEqual(KNOWN_USAGE)
    expect(state.metadata.lastTurn).toBe(1)
    expect(state.metadata.openTurn).toBeUndefined()
    expect(state.metadata.lastSeq).toBe(7)
  })

  it('keeps openTurn for an unclosed turn and propagates unknown usage', () => {
    const records = stamp([
      { type: 'turn.start', turn: 1 },
      { type: 'user.message', turn: 1, content: 'x', source: 'user' },
      { type: 'assistant.message', turn: 1, step: 1, requestId: 'r', content: 'part', usage: UNKNOWN_USAGE, finishReason: 'aborted', interrupted: true },
    ])
    const state = projectSession(records)
    expect(state.metadata.openTurn).toBe(1)
    expect(state.metadata.totalUsage).toEqual(UNKNOWN_USAGE)
    expect(state.messages.at(-1)).toEqual({ role: 'assistant', content: 'part' })
  })

  it('drops an interrupted assistant message with empty content', () => {
    const records = stamp([
      { type: 'turn.start', turn: 1 },
      { type: 'assistant.message', turn: 1, step: 1, requestId: 'r', content: '', usage: KNOWN_USAGE, finishReason: 'aborted', interrupted: true },
    ])
    const state = projectSession(records)
    expect(state.messages).toEqual([])
    expect(state.metadata.totalUsage).toEqual(KNOWN_USAGE)
  })

  it('collects grants; approval request/decision and error records do not touch messages', () => {
    const records = stamp([
      { type: 'turn.start', turn: 1 },
      {
        type: 'approval.request', turn: 1,
        request: { id: 'a', sessionId: ID, callId: 'c', tool: 'bash', summary: 'ls', risk: 'medium', options: ['once', 'session'] },
      },
      { type: 'approval.decision', turn: 1, decision: { id: 'a', decision: 'allow', scope: 'session', decidedBy: 'user' } },
      { type: 'approval.grant', grant: { tool: 'bash', pattern: 'ls', grantedAt: TS } },
      { type: 'error', error: { name: 'E', code: 'internal', message: 'm' }, fatal: false },
    ])
    const state = projectSession(records)
    expect(state.messages).toEqual([])
    expect(state.metadata.grants).toEqual([{ tool: 'bash', pattern: 'ls', grantedAt: TS }])
    expect(state.metadata.sandboxMode).toBe('full-access')
    expect(state.metadata.lastSeq).toBe(6)
  })

  it('a checkpoint record replaces the state; foldRecord, replay and the projector agree', () => {
    const records = stamp([...turnRecords(1), ...turnRecords(2)])
    const full = projectSession(records)
    const checkpoint: SessionRecord = {
      type: 'checkpoint', seq: records.length + 1, ts: TS, sessionId: ID, coversSeq: records.length, state: full,
    }
    const viaFold = foldRecord(projectSession(records.slice(0, 3)), checkpoint)
    expect(viaFold.messages).toEqual(full.messages)
    expect(viaFold.metadata.lastSeq).toBe(checkpoint.seq)

    let stepwise = projectSession(records.slice(0, 1))
    for (const record of records.slice(1)) stepwise = foldRecord(stepwise, record)
    expect(stepwise).toEqual(full)

    const projector = new SessionProjector(projectSession(records.slice(0, 1)))
    for (const record of records.slice(1)) projector.apply(record)
    expect(projector.snapshot()).toEqual(full)
    expect(replay(projectSession(records.slice(0, 1)), records, 1)).toEqual({ state: full, folded: records.length - 1 })
  })

  it('does not mutate its input state', () => {
    const records = stamp(turnRecords(1))
    const before = projectSession(records.slice(0, 2))
    const frozen = JSON.stringify(before)
    foldRecord(before, records[2] as SessionRecord)
    expect(JSON.stringify(before)).toBe(frozen)
  })

  it('rejects a second session.start, a foreign record and a list without session.start', () => {
    const records = stamp([])
    const state = projectSession(records)
    expect(() => foldRecord(state, records[0] as SessionRecord)).toThrow(/first record/)
    expect(() => foldRecord(state, { type: 'turn.start', seq: 2, ts: TS, sessionId: 'other', turn: 1 })).toThrow(/other/)
    try {
      projectSession(records.slice(1))
      expect.unreachable()
    } catch (error) {
      expect(isNexgentError(error, 'session/corrupt')).toBe(true)
    }
  })

  it('shouldCheckpoint fires on turn.end once N records were written since the last checkpoint', () => {
    expect(shouldCheckpoint({ type: 'turn.end', seq: 49 }, 0)).toBe(false)
    expect(shouldCheckpoint({ type: 'turn.end', seq: 50 }, 0)).toBe(true)
    expect(shouldCheckpoint({ type: 'user.message', seq: 500 }, 0)).toBe(false)
    expect(shouldCheckpoint({ type: 'turn.end', seq: 99 }, 50)).toBe(false)
    expect(shouldCheckpoint({ type: 'turn.end', seq: 100 }, 50)).toBe(true)
    expect(shouldCheckpoint({ type: 'turn.end', seq: 7 }, 0, 6)).toBe(true)
  })
})
