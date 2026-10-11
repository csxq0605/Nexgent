/**
 * The pure team state: rebuilding from records, the task board rules and the
 * mailbox limits (`data-formats.md` §团队, `COLLABORATION_LIMITS`).
 */
import { COLLABORATION_LIMITS, type SessionRecord, type TeamMessage } from '@nexgent/kernel'
import { describe, expect, it } from 'vitest'
import {
  applyRecord,
  checkMessage,
  checkSpawn,
  checkTaskCreate,
  checkTaskUpdate,
  deliveredIds,
  emptyTeam,
  pendingFor,
  reduceTeam,
  renderBoard,
  renderInjectedMessage,
  type TeamState,
} from '../src/index.js'

const base = { seq: 1, ts: '2026-10-11T00:00:00.000Z', sessionId: 'lead' }
const record = (value: Record<string, unknown>) => ({ ...base, ...value }) as unknown as SessionRecord

function team(...names: string[]): TeamState {
  const state = emptyTeam()
  for (const name of names) applyRecord(state, record({ type: 'team.member', member: { name, sessionId: `${name}-s`, status: 'active' } }))
  return state
}

function add(state: TeamState, input: Parameters<typeof checkTaskCreate>[1]) {
  const task = checkTaskCreate(state, input)
  applyRecord(state, record({ type: 'team.task', task }))
  return task
}

describe('reduceTeam', () => {
  it('keeps the latest roster entry, task and message state; delivered is final', () => {
    const id = '11111111-2222-4333-8444-555555555555'
    const message = (state: 'queued' | 'delivered'): TeamMessage => ({ id, from: 'a', to: 'b', text: 'hi', state })
    const state = reduceTeam([
      record({ type: 'team.member', member: { name: 'a', sessionId: 's1', status: 'active' } }),
      record({ type: 'team.member', member: { name: 'a', sessionId: 's1', status: 'idle' } }),
      record({ type: 'team.task', task: { id: 't1', title: 'x', status: 'pending', dependsOn: [] } }),
      record({ type: 'team.task', task: { id: 't1', title: 'x', status: 'completed', dependsOn: [], result: 'ok' } }),
      record({ type: 'team.message', message: message('queued') }),
      record({ type: 'team.message', message: message('delivered') }),
      record({ type: 'team.message', message: message('queued') }),
    ])
    expect(state.members.get('a')!.status).toBe('idle')
    expect(state.tasks.get('t1')).toMatchObject({ status: 'completed', result: 'ok' })
    expect(state.messages.get(id)!.state).toBe('delivered')
    expect(pendingFor(state, 'b')).toEqual([])
  })
})

describe('task board', () => {
  it('numbers tasks, checks owners and dependencies, and refuses a start while dependencies are open', () => {
    const state = team('alice')
    expect(add(state, { title: 'one' }).id).toBe('t1')
    expect(add(state, { title: 'two', owner: 'alice', dependsOn: ['t1', 't1'] })).toMatchObject({ id: 't2', owner: 'alice', dependsOn: ['t1'] })
    expect(() => checkTaskCreate(state, { title: 'x', dependsOn: ['t9'] })).toThrow(/unknown tasks in dependsOn: t9/)
    expect(() => checkTaskCreate(state, { title: 'x', owner: 'zed' })).toThrow(/unknown owner "zed"/)
    expect(() => checkTaskCreate(state, { title: '  ' })).toThrow(/title/)
    expect(() => checkTaskUpdate(state, 'alice', { id: 't2', status: 'in_progress' })).toThrow(/t2 cannot start: it waits for t1 \(pending\)/)
    // A teammate claiming an unowned task becomes its owner.
    const claimed = checkTaskUpdate(state, 'alice', { id: 't1', status: 'in_progress' })
    expect(claimed.owner).toBe('alice')
    applyRecord(state, record({ type: 'team.task', task: { ...claimed, status: 'completed' } }))
    expect(checkTaskUpdate(state, 'alice', { id: 't2', status: 'in_progress' }).status).toBe('in_progress')
    expect(() => checkTaskUpdate(state, 'alice', { id: 't1', status: 'pending' })).toThrow(/already completed/)
    expect(() => checkTaskUpdate(state, 'alice', { id: 't2' })).toThrow(/at least one/)
    expect(renderBoard(state)).toContain('- t2 [pending] two (owner alice; waits for t1)')
  })

  it('lets a teammate change only unowned tasks or its own; the lead changes any', () => {
    const state = team('alice', 'bob')
    add(state, { title: 'bobs', owner: 'bob' })
    expect(() => checkTaskUpdate(state, 'alice', { id: 't1', status: 'cancelled' })).toThrow(/belongs to bob/)
    expect(checkTaskUpdate(state, 'lead', { id: 't1', owner: 'alice' }).owner).toBe('alice')
  })

  it(`holds at most ${COLLABORATION_LIMITS.maxTeamTasks} tasks`, () => {
    const state = team()
    for (let i = 0; i < COLLABORATION_LIMITS.maxTeamTasks; i += 1) add(state, { title: `task ${i}` })
    expect(() => checkTaskCreate(state, { title: 'one more' })).toThrow(expect.objectContaining({ code: 'tool/denied' }))
  })
})

describe('mailbox', () => {
  it('checks recipient, size and the per-recipient queue', () => {
    const state = team('alice', 'bob')
    expect(() => checkMessage(state, 'alice', 'alice', 'me')).toThrow(/itself/)
    expect(() => checkMessage(state, 'alice', 'zed', 'hi')).toThrow(/unknown recipient "zed"; the team is: lead, alice, bob/)
    expect(() => checkMessage(state, 'alice', 'bob', ' ')).toThrow(/empty/)
    expect(() => checkMessage(state, 'alice', 'bob', 'é'.repeat(COLLABORATION_LIMITS.maxMessageBytes / 2 + 1))).toThrow(/at most 65536 bytes/)
    expect(() => checkMessage(state, 'alice', 'bob', 'x'.repeat(COLLABORATION_LIMITS.maxMessageBytes))).not.toThrow()
    for (let i = 0; i < COLLABORATION_LIMITS.maxPendingMessagesPerMember; i += 1) {
      applyRecord(state, record({ type: 'team.message', message: { id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, from: 'alice', to: 'bob', text: 'x', state: 'queued' } }))
    }
    expect(() => checkMessage(state, 'alice', 'bob', 'one more')).toThrow(expect.objectContaining({ code: 'tool/denied' }))
    expect(() => checkMessage(state, 'bob', 'lead', 'to the lead')).not.toThrow()
  })

  it('finds delivered ids in injected messages and tool results only', () => {
    const id = '11111111-2222-4333-8444-555555555555'
    const text = renderInjectedMessage({ id, from: 'a', text: 'hello' })
    expect(deliveredIds([record({ type: 'user.message', source: 'inject', content: text, turn: 1 })])).toEqual(new Set([id]))
    expect(deliveredIds([record({ type: 'tool.result', content: text })])).toEqual(new Set([id]))
    expect(deliveredIds([record({ type: 'user.message', source: 'user', content: text, turn: 1 })])).toEqual(new Set())
  })
})

describe('roster', () => {
  it('checks names, reuses a stopped name, and holds at most 16 teammates', () => {
    const state = team('alice')
    expect(() => checkSpawn(state, 'Alice')).toThrow(/must match/)
    expect(() => checkSpawn(state, 'lead')).toThrow(/main conversation/)
    expect(() => checkSpawn(state, 'alice')).toThrow(/already on the team/)
    applyRecord(state, record({ type: 'team.member', member: { name: 'alice', sessionId: 'x', status: 'stopped' } }))
    expect(() => checkSpawn(state, 'alice')).not.toThrow()
    const full = team(...Array.from({ length: 16 }, (_, i) => `m${i}`))
    expect(() => checkSpawn(full, 'extra')).toThrow(expect.objectContaining({ code: 'tool/denied' }))
  })
})
