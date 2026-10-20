import { describe, expect, it } from 'vitest'
import { resolveWorkspaceLayout, UNKNOWN_USAGE, type SessionRecordInput } from '@nexgent/kernel'
import { JsonlSessionStore, projectSession, validateSessionRecord } from '../src/index.js'
import { KNOWN_USAGE, SESSION_ID, sessionInit, tempDir, turnRecords } from './helpers.js'

const CHILD_ID = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f'
const SHA = 'c'.repeat(64)

async function setup() {
  const root = await tempDir()
  const store = new JsonlSessionStore({ layout: resolveWorkspaceLayout(root) })
  return { root, store }
}

/** One record of each parent-side step-3 type, inside turn 2. */
function parentRecords(): SessionRecordInput[] {
  const deliverable = {
    deliverableId: 'd1',
    version: 1,
    title: 'summary.csv',
    summary: 'Totals by region',
    files: [{ path: 'analyst/summary.csv', size: 3, sha256: SHA, mediaType: 'text/csv' }],
    memberName: 'analyst',
  }
  return [
    { type: 'turn.start', turn: 2 },
    { type: 'user.message', turn: 2, content: 'Split the work', source: 'user' },
    {
      type: 'subagent.start',
      turn: 2,
      toolCallId: 'call_d',
      childSessionId: CHILD_ID,
      childTurn: 1,
      name: 'analyst',
      executionForm: 'delegated',
      mode: 'fork',
      preset: 'read-only-analyst',
      task: 'Sum orders by region',
      materialIds: ['m1'],
    },
    {
      type: 'subagent.end',
      turn: 2,
      childSessionId: CHILD_ID,
      childTurn: 1,
      result: { status: 'completed', text: 'Done', deliverables: [deliverable], usage: KNOWN_USAGE, requestCount: 2 },
    },
    { type: 'workflow.start', turn: 2, toolCallId: 'call_w', workflowId: 'w1', kind: 'graph', architecture: SHA, title: 'Review' },
    { type: 'workflow.phase', turn: 2, workflowId: 'w1', phase: 'review' },
    {
      type: 'workflow.end',
      turn: 2,
      workflowId: 'w1',
      status: 'failed',
      members: 2,
      error: { name: 'NexgentError', code: 'tool/failed', message: 'member b failed' },
    },
    { type: 'turn.end', turn: 2, reason: { kind: 'cancelled', cause: 'parent' } },
  ]
}

describe('step-3 session records', () => {
  it('round-trip in the parent without changing the conversation', async () => {
    const { root, store } = await setup()
    const lock = await store.create(sessionInit(root))
    for (const record of [...turnRecords(1), ...parentRecords()]) await store.append(SESSION_ID, record)
    await store.release(lock)

    const { records, truncation } = await store.readAll(SESSION_ID)
    expect(truncation).toBeUndefined()
    for (const record of records) expect(validateSessionRecord(record), record.type).toEqual([])
    const types = records.map(record => record.type).filter(type => type !== 'checkpoint')
    expect(types.slice(7)).toEqual(parentRecords().map(record => record.type))

    const state = await store.resume(SESSION_ID)
    expect(state).toEqual(projectSession(records))
    expect(state.messages.at(-1)).toEqual({ role: 'user', content: 'Split the work' })
  })

  it('start a child with its member and fork seed, and resume it', async () => {
    const { root, store } = await setup()
    const member = { name: 'analyst', executionForm: 'delegated', preset: 'read-only-analyst' } as const
    const lock = await store.create(sessionInit(root, { sessionId: CHILD_ID, parentSessionId: SESSION_ID, member, sandboxMode: 'read-only' }))
    const seeded = [
      { role: 'user', content: 'Earlier question' },
      { role: 'assistant', content: 'Earlier answer', providerContent: [{ type: 'text', text: 'Earlier answer' }] },
    ] as const
    await store.append(CHILD_ID, { type: 'fork.seed', fromSessionId: SESSION_ID, throughSeq: 9, messages: seeded })
    for (const record of turnRecords(1, 'Sum orders by region')) await store.append(CHILD_ID, record)
    await store.release(lock)

    const { records } = await store.readAll(CHILD_ID)
    expect(records[0]).toMatchObject({ type: 'session.start', parentSessionId: SESSION_ID, member })
    expect(records[1]).toMatchObject({ type: 'fork.seed', seq: 2 })
    const state = await store.resume(CHILD_ID)
    expect(state.metadata.parentSessionId).toBe(SESSION_ID)
    expect(state.metadata.member).toEqual(member)
    expect(state.messages.slice(0, 2)).toEqual(seeded)
    expect(state.messages[2]).toEqual({ role: 'user', content: 'Sum orders by region' })
  })

  it('reject a fork seed after the conversation began, a child without a member, and bad member data', async () => {
    const { root, store } = await setup()
    const lock = await store.create(sessionInit(root))
    for (const record of turnRecords(1)) await store.append(SESSION_ID, record)
    await expect(store.append(SESSION_ID, { type: 'fork.seed', fromSessionId: 'p', throughSeq: 1, messages: [] }))
      .rejects.toMatchObject({ code: 'session/invalid-record' })
    await store.release(lock)

    await expect(store.create(sessionInit(root, { sessionId: CHILD_ID, parentSessionId: SESSION_ID })))
      .rejects.toMatchObject({ code: 'session/invalid-record' })

    const base = { seq: 3, ts: '2026-10-11T00:00:00.000Z', sessionId: SESSION_ID }
    const start = { ...base, type: 'subagent.start', turn: 1, childSessionId: CHILD_ID, childTurn: 1, name: 'analyst', executionForm: 'delegated', task: 'x' }
    expect(validateSessionRecord(start)).toEqual([])
    expect(validateSessionRecord({ ...start, name: 'Analyst' })).not.toEqual([])
    expect(validateSessionRecord({ ...start, executionForm: 'direct' })).not.toEqual([])
    expect(validateSessionRecord({ ...start, task: 'x'.repeat(501) })).not.toEqual([])
    const end = { ...base, type: 'subagent.end', turn: 1, childSessionId: CHILD_ID, childTurn: 1 }
    expect(validateSessionRecord({ ...end, result: { status: 'budget', text: '', deliverables: [], usage: UNKNOWN_USAGE, requestCount: 0 } })).toEqual([])
    expect(validateSessionRecord({ ...end, result: { status: 'gone', text: '', deliverables: [], usage: UNKNOWN_USAGE, requestCount: 0 } })).not.toEqual([])
    expect(validateSessionRecord({ ...base, type: 'workflow.start', turn: 1, toolCallId: 'c', workflowId: 'w', kind: 'graph', architecture: 'ABC' })).not.toEqual([])
  })
})
