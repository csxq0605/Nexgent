import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  isNexgentError,
  renderCompactionSummary,
  resolveWorkspaceLayout,
  UNKNOWN_USAGE,
  type SessionRecordInput,
} from '@nexgent/kernel'
import { JsonlSessionStore, projectSession, validateSessionRecord } from '../src/index.js'
import { KNOWN_USAGE, SESSION_ID, sessionInit, tempDir, turnRecords } from './helpers.js'

/** Session id of the step-1 real-model run kept as a fixture (first turn and its checkpoint). */
const STEP1_SESSION = '1814c7d2-b395-4ab9-8e8d-ffdd5d7ed9f4'
const SHA = 'b'.repeat(64)

async function setup() {
  const root = await tempDir()
  const store = new JsonlSessionStore({ layout: resolveWorkspaceLayout(root) })
  return { root, store }
}

/** One record of each step-2 type, in an order the projection accepts (after one complete turn). */
function step2Records(): SessionRecordInput[] {
  return [
    {
      type: 'material.added',
      material: { id: 'm1', originalName: 'orders.csv', path: '.nexgent/materials/m1/orders.csv', size: 3, sha256: SHA, mediaType: 'text/csv' },
    },
    { type: 'goal.set', goal: { id: 'g1', text: 'Summarize sales', status: 'active', setAt: '2026-10-11T00:00:00.000Z', updatedAt: '2026-10-11T00:00:00.000Z' } },
    { type: 'turn.start', turn: 2 },
    { type: 'feedback', turn: 2, feedback: { id: 'f1', deliverableId: 'd1', version: 1, rating: 3, comment: 'Add growth' } },
    { type: 'user.message', turn: 2, content: 'Add growth', source: 'feedback' },
    {
      type: 'compaction',
      turn: 2,
      step: 1,
      summary: 'Turn 1 read the README.',
      keepMessages: 1,
      compactedMessages: 4,
      requestId: 'req-compact',
      usage: KNOWN_USAGE,
      trigger: { inputTokens: 5000, threshold: 4000 },
    },
    {
      type: 'deliverable.presented',
      turn: 2,
      step: 1,
      toolCallId: 'call_p',
      deliverable: {
        deliverableId: 'd1',
        version: 2,
        title: 'summary.csv',
        summary: 'Adds growth',
        files: [{ path: 'report/summary.csv', size: 3, sha256: SHA, mediaType: 'text/csv' }],
      },
    },
    { type: 'goal.update', turn: 2, goalId: 'g1', status: 'completed', note: 'presented v2' },
    { type: 'turn.files', turn: 2, changes: [{ path: 'report/summary.csv', change: 'modified' }] },
    { type: 'turn.end', turn: 2, reason: { kind: 'completed' } },
  ]
}

describe('step-2 session records', () => {
  it('round-trip through the store and project goal and compaction', async () => {
    const { root, store } = await setup()
    const lock = await store.create(sessionInit(root))
    for (const record of [...turnRecords(1), ...step2Records()]) await store.append(SESSION_ID, record)
    await store.release(lock)

    const { records, truncation } = await store.readAll(SESSION_ID)
    expect(truncation).toBeUndefined()
    for (const record of records) expect(validateSessionRecord(record), record.type).toEqual([])
    expect(records.map(record => record.type).slice(7).filter(type => type !== 'checkpoint')).toEqual(step2Records().map(record => record.type))

    const state = await store.resume(SESSION_ID)
    expect(state).toEqual(projectSession(records))
    expect(state.messages).toEqual([
      { role: 'user', content: renderCompactionSummary('Turn 1 read the README.') },
      { role: 'user', content: 'Add growth' },
    ])
    expect(state.metadata.goal).toMatchObject({ id: 'g1', status: 'completed', text: 'Summarize sales', note: 'presented v2' })
    expect(state.metadata.goal?.updatedAt).toBe(records.find(record => record.type === 'goal.update')?.ts)
    expect(state.metadata.lastCompactionSeq).toBe(records.find(record => record.type === 'compaction')?.seq)
    expect(state.metadata.lastUsage).toBeUndefined()
    expect(state.metadata.openTurn).toBeUndefined()
  })

  it('refuses a compaction whose tail starts at a tool result, and a goal.update for another goal', async () => {
    const { root, store } = await setup()
    const lock = await store.create(sessionInit(root))
    for (const record of turnRecords(1)) await store.append(SESSION_ID, record)
    const before = (await store.readAll(SESSION_ID)).records.length
    const bad: SessionRecordInput[] = [
      { type: 'compaction', turn: 1, step: 3, summary: 's', keepMessages: 2, compactedMessages: 2, requestId: 'r', usage: KNOWN_USAGE, trigger: { inputTokens: 2, threshold: 1 } },
      { type: 'compaction', turn: 1, step: 3, summary: 's', keepMessages: 99, compactedMessages: 1, requestId: 'r', usage: KNOWN_USAGE, trigger: { inputTokens: 2, threshold: 1 } },
      { type: 'goal.update', goalId: 'nope', status: 'completed' },
    ]
    for (const record of bad) {
      await expect(store.append(SESSION_ID, record)).rejects.toSatisfy(error => isNexgentError(error, 'session/invalid-record'))
    }
    expect((await store.readAll(SESSION_ID)).records).toHaveLength(before)
    await store.release(lock)
  })

  it('accepts a compaction that splits the current turn at a reply (ADR 0021); kept replies lose their provider content', async () => {
    const { root, store } = await setup()
    const lock = await store.create(sessionInit(root))
    const records = turnRecords(1).filter(record => record.type !== 'turn.end')
    const withThinking = records.map(record => record.type === 'assistant.message' && record.step === 1
      ? { ...record, providerContent: [{ type: 'thinking', thinking: 't', signature: 's' }] }
      : record)
    for (const record of withThinking) await store.append(SESSION_ID, record)
    await store.append(SESSION_ID, { type: 'compaction', turn: 1, step: 3, summary: 's', keepMessages: 3, compactedMessages: 1, requestId: 'r', usage: KNOWN_USAGE, trigger: { inputTokens: 2, threshold: 1 } })
    const state = await store.resume(SESSION_ID)
    expect(state.messages[0]).toEqual({ role: 'user', content: renderCompactionSummary('s') })
    expect(state.messages[1]).toMatchObject({ role: 'assistant', toolCalls: [{ id: 'call_1' }] })
    expect(state.messages[1]).not.toHaveProperty('providerContent')
    expect(state.messages.map(message => message.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    await store.release(lock)
  })

  it('projects the latest reply usage with a known billed input as lastUsage, cleared by a compaction (ADR 0021)', async () => {
    const { root, store } = await setup()
    const lock = await store.create(sessionInit(root))
    const records = turnRecords(1).filter(record => record.type !== 'turn.end')
    for (const record of records) await store.append(SESSION_ID, record)
    const known = { ...KNOWN_USAGE, inputTokens: 1234 }
    await store.append(SESSION_ID, { type: 'assistant.message', turn: 1, step: 3, requestId: 'r3', content: 'more', usage: known, finishReason: 'stop' })
    await store.append(SESSION_ID, { type: 'assistant.message', turn: 1, step: 4, requestId: 'r4', content: 'cut', usage: UNKNOWN_USAGE, finishReason: 'error', interrupted: true })
    expect((await store.resume(SESSION_ID)).metadata.lastUsage).toEqual(known)
    await store.append(SESSION_ID, { type: 'compaction', turn: 1, step: 5, summary: 's', keepMessages: 1, compactedMessages: 5, requestId: 'r', usage: KNOWN_USAGE, trigger: { inputTokens: 2, threshold: 1 } })
    const state = await store.resume(SESSION_ID)
    expect(state.metadata.lastUsage).toBeUndefined()
    expect(validateSessionRecord({ type: 'checkpoint', seq: 99, ts: new Date().toISOString(), sessionId: SESSION_ID, coversSeq: 98, state: { ...state, metadata: { ...state.metadata, lastUsage: known } } })).toEqual([])
    await store.release(lock)
  })

  it('rejects malformed step-2 records', () => {
    const base = { seq: 2, ts: '2026-10-11T00:00:00.000Z', sessionId: SESSION_ID }
    const presented = step2Records().find(record => record.type === 'deliverable.presented')
    expect(validateSessionRecord({ ...base, ...presented })).toEqual([])
    // Windows separators are not portable paths.
    expect(validateSessionRecord({
      ...base,
      type: 'turn.files',
      turn: 1,
      changes: [{ path: 'report\\summary.csv', change: 'modified' }],
    })).not.toEqual([])
    expect(validateSessionRecord({ ...base, type: 'feedback', turn: 1, feedback: { id: 'f', deliverableId: 'd', version: 1, rating: 6, comment: '' } })).not.toEqual([])
    expect(validateSessionRecord({ ...base, type: 'goal.update', goalId: 'g', status: 'paused' })).not.toEqual([])
    expect(validateSessionRecord({ ...base, type: 'user.message', turn: 1, content: 'x', source: 'robot' })).not.toEqual([])
    expect(validateSessionRecord({
      ...base,
      type: 'material.added',
      material: { id: 'm', originalName: 'a', path: 'a', size: 1, sha256: 'XYZ', mediaType: 'text/plain' },
    })).not.toEqual([])
  })
})

describe('a session written by step 1 stays readable', () => {
  it('reads, resumes and continues the step-1 real-model session with step-2 records', async () => {
    const { root, store } = await setup()
    const dir = join(root, '.nexgent', 'sessions', STEP1_SESSION)
    await mkdir(dir, { recursive: true })
    // Normalize line endings in case a Windows checkout converted the fixture to CRLF.
    const text = await readFile(new URL('./fixtures/step1-real-session.jsonl', import.meta.url), 'utf8')
    await writeFile(join(dir, 'session.jsonl'), text.replace(/\r\n/g, '\n'), 'utf8')

    const { records, truncation } = await store.readAll(STEP1_SESSION)
    expect(truncation).toBeUndefined()
    expect(records).toHaveLength(12)
    const checkpoint = records[11]
    if (checkpoint?.type !== 'checkpoint') throw new Error('expected the fixture to end with a checkpoint')
    // The step-1 checkpoint predates `lastUsage` (ADR 0021); a reader resuming from it simply has none.
    const { lastUsage, ...projected } = projectSession(records.slice(0, 11)).metadata
    expect(lastUsage).toMatchObject({ inputTokens: expect.any(Number) })
    expect(checkpoint.state).toEqual({ ...projectSession(records.slice(0, 11)), metadata: projected })
    const resumed = await store.resume(STEP1_SESSION)
    expect(resumed).toEqual({ ...checkpoint.state, metadata: { ...checkpoint.state.metadata, lastSeq: 12 } })

    const lock = await store.lock(STEP1_SESSION)
    await store.append(STEP1_SESSION, { type: 'goal.set', goal: { id: 'g', text: 'Fix the bugs', status: 'active', setAt: '2026-10-11T00:00:00.000Z', updatedAt: '2026-10-11T00:00:00.000Z' } })
    await store.append(STEP1_SESSION, { type: 'turn.start', turn: 2 })
    await store.append(STEP1_SESSION, { type: 'turn.files', turn: 2, changes: [] })
    await store.append(STEP1_SESSION, { type: 'turn.end', turn: 2, reason: { kind: 'completed' } })
    await store.release(lock)
    const after = await store.resume(STEP1_SESSION)
    expect(after.messages).toEqual(checkpoint.state.messages)
    expect(after.metadata.goal?.text).toBe('Fix the bugs')
    expect(after.metadata.lastTurn).toBe(2)
  })
})
