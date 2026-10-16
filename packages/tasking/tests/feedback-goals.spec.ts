import { renderFeedbackPrompt, type TurnContextInput } from '@nexgent/kernel'
import { validateSessionRecord } from '@nexgent/session'
import { describe, expect, it } from 'vitest'
import { createFeedbackEntry, createTaskingService, goalContextProvider } from '../src/index.js'
import { newStore, openSession, project, SESSION_A, SESSION_B } from './helpers.js'

describe('feedback', () => {
  it('validates a submission against the deliverable and builds the entry', async () => {
    const p = await project()
    await p.write('report.md', '# r\n')
    const v1 = await p.tasking.deliverables.present({ sessionId: SESSION_A, turn: 1, toolCallId: 'c1', paths: ['report.md'], summary: 's' })
    const entry = await createFeedbackEntry({ deliverableId: v1.deliverableId, version: 1, rating: 3, comment: '地区要用中文名' }, p.tasking.deliverables)
    expect(entry).toMatchObject({ deliverableId: v1.deliverableId, version: 1, rating: 3, comment: '地区要用中文名' })
    expect(entry.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(renderFeedbackPrompt(entry)).toBe(`Feedback on deliverable ${v1.deliverableId} version 1. Rating: 3/5.\n\n地区要用中文名`)
    const noRating = await createFeedbackEntry({ deliverableId: v1.deliverableId, version: 1, comment: 'ok' }, p.tasking.deliverables)
    expect('rating' in noRating).toBe(false)

    await expect(createFeedbackEntry({ deliverableId: v1.deliverableId, version: 2, comment: 'x' }, p.tasking.deliverables)).rejects.toMatchObject({ code: 'workspace/not-found' })
    await expect(createFeedbackEntry({ deliverableId: v1.deliverableId, version: 1, rating: 6 as 5, comment: 'x' }, p.tasking.deliverables)).rejects.toMatchObject({ code: 'tool/invalid-input' })
    await expect(createFeedbackEntry({ deliverableId: v1.deliverableId, version: 1, rating: 2.5 as 2, comment: 'x' }, p.tasking.deliverables)).rejects.toMatchObject({ code: 'tool/invalid-input' })
    await expect(createFeedbackEntry({ deliverableId: v1.deliverableId, version: 1, comment: '  ' }, p.tasking.deliverables)).rejects.toMatchObject({ code: 'tool/invalid-input' })
  })

  it('lists feedback records across sessions, filtered and in order, after a restart', async () => {
    const p = await project()
    // One millisecond per record, so the order by `ts` is the append order (same-ms records sort by session id).
    let tick = 0
    const sessions = newStore(p.workspace.layout.sessions, () => new Date(Date.UTC(2026, 9, 11, 9, 0, 0, tick++)))
    const appendA = await openSession(sessions, p.root, SESSION_A)
    const appendB = await openSession(sessions, p.root, SESSION_B)
    const d1 = '55555555-5555-4555-8555-555555555555'
    const d2 = '66666666-6666-4666-8666-666666666666'
    const feedback = (id: string, deliverableId: string, comment: string) => ({ id, deliverableId, version: 1, rating: 4 as const, comment })
    await appendA({ type: 'turn.start', turn: 1 })
    const first = await appendA({ type: 'feedback', turn: 1, feedback: feedback('aaaaaaaa-0000-4000-8000-000000000001', d1, 'first') })
    await appendB({ type: 'turn.start', turn: 1 })
    await appendB({ type: 'feedback', turn: 1, feedback: feedback('aaaaaaaa-0000-4000-8000-000000000002', d2, 'second') })
    await appendA({ type: 'turn.end', turn: 1, reason: { kind: 'completed' } })
    await appendA({ type: 'turn.start', turn: 2 })
    await appendA({ type: 'feedback', turn: 2, feedback: feedback('aaaaaaaa-0000-4000-8000-000000000003', d1, 'third') })

    const all = await p.reopen().feedback.list()
    expect(all.map(entry => entry.comment)).toEqual(['first', 'second', 'third'])
    expect(all[0]).toEqual({ ...feedback('aaaaaaaa-0000-4000-8000-000000000001', d1, 'first'), sessionId: SESSION_A, turn: 1, submittedAt: first.ts })
    expect((await p.tasking.feedback.list({ sessionId: SESSION_A })).map(entry => entry.comment)).toEqual(['first', 'third'])
    expect((await p.tasking.feedback.list({ deliverableId: d2 })).map(entry => entry.sessionId)).toEqual([SESSION_B])
    expect(await p.tasking.feedback.list({ sessionId: '77777777-7777-4777-8777-777777777777' })).toEqual([])
  })
})

describe('goal', () => {
  it('sets, updates and reads the goal through session records, also after a restart', async () => {
    const p = await project()
    const append = await openSession(p.sessions, p.root, SESSION_A)
    const sink = (record: Parameters<typeof append>[0]) => append(record)
    const tasking = createTaskingService(p.workspace.layout, p.sessions, { now: () => new Date('2026-10-11T09:00:00.000Z') })

    expect(await tasking.goals.get(SESSION_A)).toBeUndefined()
    await expect(tasking.goals.update(sink, SESSION_A, { status: 'completed' })).rejects.toMatchObject({ code: 'session/invalid-record' })
    await expect(tasking.goals.set(sink, '   ')).rejects.toMatchObject({ code: 'tool/invalid-input' })

    const goal = await tasking.goals.set(sink, '  按地区和月份汇总销售额  ')
    expect(goal).toMatchObject({ text: '按地区和月份汇总销售额', status: 'active', setAt: '2026-10-11T09:00:00.000Z', updatedAt: '2026-10-11T09:00:00.000Z' })
    expect(await tasking.goals.get(SESSION_A)).toEqual(goal)

    const done = await tasking.goals.update(sink, SESSION_A, { status: 'completed', note: 'report v2 accepted' })
    expect(done).toMatchObject({ id: goal.id, status: 'completed', note: 'report v2 accepted', text: goal.text })
    expect(await p.reopen().goals.get(SESSION_A)).toEqual(done)

    const edited = await tasking.goals.update(sink, SESSION_A, { status: 'active', text: '再加一列环比' })
    expect(edited).toMatchObject({ status: 'active', text: '再加一列环比', note: 'report v2 accepted' })
    expect(await p.reopen().goals.get(SESSION_A)).toEqual(edited)
    await expect(tasking.goals.update(sink, SESSION_A, { status: 'paused' as 'active' })).rejects.toMatchObject({ code: 'tool/invalid-input' })

    // Reading the goal mid-turn through the store that holds the lock must not close the open turn.
    await append({ type: 'turn.start', turn: 1 })
    expect(await tasking.goals.get(SESSION_A)).toEqual(edited)
    const records = (await p.sessions.readAll(SESSION_A)).records
    expect(records.map(record => record.type)).toEqual(['session.start', 'goal.set', 'goal.update', 'goal.update', 'turn.start'])
    for (const record of records) expect(validateSessionRecord(record)).toEqual([])
  })

  it('injects the Current goal while it is active and the history does not carry it yet (K2: not a system section)', async () => {
    const provider = goalContextProvider()
    expect(provider.id).toBe('goal')
    const input = (goal?: { status: 'active' | 'completed' }, messages: TurnContextInput['state']['messages'] = []): TurnContextInput => ({
      sessionId: SESSION_A,
      turn: 2,
      projectRoot: '/p',
      text: 'continue',
      source: 'user',
      materialIds: [],
      signal: new AbortController().signal,
      state: {
        sessionId: SESSION_A,
        version: 1,
        messages,
        metadata: {
          createdAt: '2026-10-11T09:00:00.000Z', projectRoot: '/p', model: 'm', sandboxMode: 'workspace-write', grants: [], lastTurn: 1,
          totalUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, reasoningTokens: 0 }, lastSeq: 3,
          ...(goal === undefined ? {} : { goal: { id: 'g', text: 'Summarize sales', setAt: 't', updatedAt: 't', ...goal } }),
        },
      },
    })
    expect(await provider.beginTurn(input())).toEqual({})
    expect(await provider.beginTurn(input({ status: 'completed' }))).toEqual({})
    const active = await provider.beginTurn(input({ status: 'active' }))
    expect(active.systemSections).toBeUndefined()
    expect(active.inject).toEqual([expect.stringMatching(/^# Current goal\nSummarize sales/)])
    // Already in the history: not injected again.
    expect(await provider.beginTurn(input({ status: 'active' }, [{ role: 'user', content: active.inject![0]! }]))).toEqual({})
  })
})
