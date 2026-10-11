/**
 * `@nexgent/team` in the real loop (scripted model; real session store,
 * workspace, tasking and context services): two teammates working at once,
 * mail delivered exactly once, the task board's dependencies, the Lead's
 * cancel and the next turn continuing, the concurrency limit, and what
 * members see.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as nodePath from 'node:path'
import { ContextPlugin } from '@nexgent/context'
import {
  createApp,
  type Context,
  type LLMRequest,
  type NexgentApp,
  type SessionRecord,
  type TaskingService,
  type TeamTask,
} from '@nexgent/kernel'
import { SessionPlugin } from '@nexgent/session'
import { SubagentPlugin } from '@nexgent/subagent'
import { TaskingPlugin } from '@nexgent/tasking'
import { scriptedProvider, type ScriptedProvider, type ScriptEntry, type ScriptedTurn } from '@nexgent/test-support'
import { WorkspacePlugin } from '@nexgent/workspace'
import { afterEach, describe, expect, it } from 'vitest'
import { CONTINUE_PROMPT, messageMarker, TeamPlugin, WAKE_PROMPT } from '../src/index.js'

const apps: NexgentApp[] = []
const dirs: string[] = []
afterEach(async () => {
  while (apps.length > 0) await apps.pop()!.dispose()
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true, maxRetries: 5 })
})

async function tempRoot(): Promise<string> {
  const base = realpathSync.native(await mkdtemp(nodePath.join(tmpdir(), 'nxteam-')))
  dirs.push(base)
  return base
}

/** Route a request to its member's queue by the member line of its system prompt. */
function memberOf(request: LLMRequest): string | undefined {
  const system = request.messages.find(message => message.role === 'system')
  const text = typeof system?.content === 'string' ? system.content : ''
  return /^Member: ([a-z][a-z0-9-]*) \(/m.exec(text)?.[1]
}

interface Booted {
  readonly app: NexgentApp
  readonly llm: ScriptedProvider
  readonly tasking: TaskingService
  records(sessionId: string): Promise<readonly SessionRecord[]>
}

async function boot(root: string, script: ScriptEntry<LLMRequest>[], routes: Record<string, ScriptEntry<LLMRequest>[]> = {}): Promise<Booted> {
  const llm = scriptedProvider(script, { routes, routeKey: memberOf })
  const app = await createApp({
    patches: [{ id: 'workspace', config: { root } }],
    registry: {
      '@nexgent/llm': { name: 'scripted-llm', apply: (ctx: Context) => void ctx.provide('llm', llm) },
      '@nexgent/session': SessionPlugin,
      '@nexgent/workspace': WorkspacePlugin,
    },
  })
  apps.push(app)
  await app.ctx.plugin(TaskingPlugin)
  await app.ctx.plugin(ContextPlugin)
  await app.ctx.plugin(SubagentPlugin)
  await app.ctx.plugin(TeamPlugin)
  return {
    app,
    llm,
    tasking: app.ctx.get('tasking') as TaskingService,
    records: async sessionId => (await app.ctx.session.readAll(sessionId)).records,
  }
}

const call = (name: string, args: Record<string, unknown> = {}, id?: string) => ({ ...(id === undefined ? {} : { id }), name, arguments: args })
const calls = (...list: ReturnType<typeof call>[]): ScriptedTurn => ({ toolCalls: list })
const slow = (turn: ScriptedTurn, ms = 15): ScriptedTurn => ({ ...turn, chunkDelayMs: ms })
const of = <T extends SessionRecord['type']>(records: readonly SessionRecord[], type: T) =>
  records.filter((r): r is Extract<SessionRecord, { type: T }> => r.type === type)
const resultOf = (records: readonly SessionRecord[], callId: string) => {
  const record = of(records, 'tool.result').find(r => r.toolCallId === callId)
  if (record === undefined) throw new Error(`no tool.result for ${callId}`)
  return record
}
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1

/** Whether a pid is alive; a zombie counts as dead. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const state = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]
    return state !== 'Z' && state !== 'X'
  } catch {
    return process.platform !== 'linux'
  }
}

async function until(check: () => boolean | Promise<boolean>, label: string, timeoutMs = 5_000): Promise<void> {
  const start = Date.now()
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

describe('team: two teammates', () => {
  it('work at once on separate files, mail reaches a working teammate before its next step and wakes an idle one, and the board enforces dependencies', async () => {
    const root = await tempRoot()
    const booted = await boot(root, [
      calls(
        call('team_task_create', { title: 'Write a' }, 'c1'),
        call('team_task_create', { title: 'Write b' }, 'c2'),
        call('team_task_create', { title: 'Merge a and b', dependsOn: ['t1', 't2'] }, 'c3'),
      ),
      calls(
        call('spawn_teammate', { name: 'alice', task: 'Do task t1: write alice/a.md.' }, 's1'),
        call('spawn_teammate', { name: 'bob', task: 'Do task t2: write bob/b.md.', preset: 'general-executor' }, 's2'),
      ),
      calls(call('wait_teammates', {}, 'w1')),
      calls(call('send_message', { to: 'bob', text: 'check part b once more' }, 'm1')),
      calls(call('wait_teammates', {}, 'w2')),
      calls(call('team_task_update', { id: 't3', status: 'in_progress' }, 'u3'), call('team_task_list', {}, 'l1')),
      { content: 'Both parts are written.' },
    ], {
      alice: [
        slow(calls(call('team_task_update', { id: 't1', status: 'in_progress' }, 'a1'))),
        slow(calls(call('write_file', { path: 'alice/a.md', content: 'part a\n' }, 'a2'))),
        slow(calls(call('present', { paths: ['alice/a.md'], summary: 'Part a.' }, 'a3'))),
        slow(calls(call('send_message', { to: 'bob', text: 'a is ready' }, 'a4'), call('send_message', { to: 'lead', text: 'alice finished t1' }, 'a5'))),
        slow(calls(call('write_file', { path: 'alice/sent.txt', content: 'sent\n' }, 'a6'))),
        slow(calls(call('team_task_update', { id: 't1', status: 'completed', result: 'alice/a.md written' }, 'a7'))),
        { content: 'alice done' },
      ],
      bob: [
        slow(calls(call('team_task_update', { id: 't3', status: 'in_progress' }, 'b0'))),
        slow(calls(call('team_task_update', { id: 't2', status: 'in_progress' }, 'b1'))),
        slow(calls(call('write_file', { path: 'bob/b.md', content: 'part b\n' }, 'b2'))),
        // Holds bob mid-run until alice's mail to him is queued.
        slow(calls(call('wait_for_file', { path: 'alice/sent.txt' }, 'bw'))),
        slow(calls(call('present', { paths: ['bob/b.md'], summary: 'Part b.' }, 'b3'))),
        slow(calls(call('team_task_update', { id: 't2', status: 'completed', result: 'bob/b.md written' }, 'b4'))),
        { content: 'bob done' },
        { content: 'bob checked part b' },
      ],
    })
    const { app, llm, records, tasking } = booted
    app.ctx.tools.register({
      definition: { name: 'wait_for_file', description: 'Wait until a project file exists.', inputSchema: { type: 'object', properties: { path: { type: 'string' } } }, effects: ['read'], approval: 'never' },
      handler: async input => {
        await until(() => existsSync(nodePath.join(root, (input as { path: string }).path)), 'the file')
        return { content: 'there' }
      },
    })
    const lead = await app.agents.create()
    const ended = await lead.run('Write both parts with a team.')
    expect(ended.reason).toEqual({ kind: 'completed' })
    llm.assertConsumed()

    // Both files, written by different teammates, each its own deliverable.
    expect(await readFile(nodePath.join(root, 'alice', 'a.md'), 'utf8')).toBe('part a\n')
    expect(await readFile(nodePath.join(root, 'bob', 'b.md'), 'utf8')).toBe('part b\n')
    const deliverables = await tasking.deliverables.list()
    expect(deliverables.map(d => d.versions.map(v => v.memberName)).sort()).toEqual([['alice'], ['bob']])

    // They ran at the same time: the two routes' requests interleave.
    const routes = llm.calls.map(c => c.route).filter(route => route !== undefined)
    const firstBob = routes.indexOf('bob')
    expect(firstBob).toBeGreaterThan(-1)
    expect(routes.lastIndexOf('alice')).toBeGreaterThan(firstBob)

    const leadRecords = await records(lead.sessionId)
    const roster = of(leadRecords, 'team.member')
    const alice = roster.find(r => r.member.name === 'alice')!.member
    const bob = roster.find(r => r.member.name === 'bob')!.member

    // Every message: one queued, one delivered record, same id.
    const messages = of(leadRecords, 'team.message')
    const ids = [...new Set(messages.map(r => r.message.id))]
    expect(ids).toHaveLength(3)
    for (const id of ids) {
      expect(messages.filter(r => r.message.id === id).map(r => r.message.state)).toEqual(['queued', 'delivered'])
    }
    const aliceToBob = messages.find(r => r.message.to === 'bob' && r.message.from === 'alice')!.message
    const leadToBob = messages.find(r => r.message.to === 'bob' && r.message.from === 'lead')!.message
    const toLead = messages.find(r => r.message.to === 'lead')!.message
    const bobRecords = await records(bob.sessionId)
    const injected = of(bobRecords, 'user.message').filter(r => r.source === 'inject')
    // Alice's mail reaches bob while he works: injected once in his first run, right after the step that waited for it.
    const midRun = injected.filter(r => r.content.includes(messageMarker(aliceToBob.id)))
    expect(midRun).toHaveLength(1)
    expect(midRun[0]).toMatchObject({ turn: 1 })
    expect(bobRecords.find(r => r.seq === midRun[0]!.seq - 1)).toMatchObject({ type: 'tool.result', toolCallId: 'bw' })
    const carried = llm.calls.filter(c => c.route === 'bob' && String(c.request.messages.at(-1)?.content).includes(messageMarker(aliceToBob.id)))
    expect(carried).toHaveLength(1)
    // The Lead's mail to idle bob wakes him: injected at the start of his second run, before the wake prompt.
    const woken = injected.filter(r => r.content.includes(messageMarker(leadToBob.id)))
    expect(woken).toHaveLength(1)
    expect(woken[0]).toMatchObject({ turn: 2 })
    expect(of(bobRecords, 'user.message').filter(r => r.source === 'user').map(r => r.content)[1]).toBe(WAKE_PROMPT)
    const waited = resultOf(leadRecords, 'w1')
    expect(count(waited.content, messageMarker(toLead.id))).toBe(1)
    expect(waited.content).toContain('alice finished t1')
    expect(JSON.stringify(of(leadRecords, 'user.message'))).not.toContain(aliceToBob.id)

    // The board: a task with open dependencies cannot start.
    const bobT3 = resultOf(bobRecords, 'b0')
    expect(bobT3.isError).toBe(true)
    expect(bobT3.content).toMatch(/t3 cannot start: it waits for t1 \((pending|in_progress)\), t2 \(pending\)/)
    expect(resultOf(leadRecords, 'u3').isError).not.toBe(true)
    const board = (resultOf(leadRecords, 'l1').meta as unknown as { tasks: TeamTask[] }).tasks
    expect(board.map(task => [task.id, task.status, task.owner ?? null])).toEqual([
      ['t1', 'completed', 'alice'],
      ['t2', 'completed', 'bob'],
      ['t3', 'in_progress', null],
    ])

    // Runs in the Lead: alice one, bob two; each start has its end; the roster ends idle.
    const starts = of(leadRecords, 'subagent.start')
    expect(starts.map(r => [r.name, r.childTurn, r.executionForm, r.toolCallId])).toEqual([
      ['alice', 1, 'team', 's1'],
      ['bob', 1, 'team', 's2'],
      ['bob', 2, 'team', 'm1'],
    ])
    expect(of(leadRecords, 'subagent.end').map(r => [r.childSessionId, r.childTurn, r.result.status]).sort()).toEqual([
      [alice.sessionId, 1, 'completed'],
      [bob.sessionId, 1, 'completed'],
      [bob.sessionId, 2, 'completed'],
    ].sort())
    expect(roster.at(-1)).toMatchObject({ member: { status: 'idle' } })
    const types = leadRecords.map(r => r.type)
    expect(types.lastIndexOf('subagent.end')).toBeLessThan(types.lastIndexOf('turn.end'))
    await lead.close()
  })
})

describe('team: cancel and continue', () => {
  it.skipIf(process.platform === 'win32')('a Lead cancel ends every teammate with cause parent, no process remains, and the next turn continues them', async () => {
    const root = await tempRoot()
    const hang: ScriptedTurn = { content: 'still thinking', chunkDelayMs: 30_000 }
    const { app, llm, records } = await boot(root, [
      calls(call('spawn_teammate', { name: 'runner', task: 'Run the long job.' }, 's1'), call('spawn_teammate', { name: 'thinker', task: 'Think.' }, 's2')),
      calls(call('wait_teammates', {}, 'w1')),
      // Turn 2
      calls(call('wait_teammates', {}, 'w2')),
      { content: 'all done' },
    ], {
      runner: [calls(call('bash', { command: 'sleep 30 & echo $! > sleeper.pid; wait' }, 'r1')), { content: 'runner finished' }],
      thinker: [hang, { content: 'thinker finished' }],
    })
    const lead = await app.agents.create()
    const controller = new AbortController()
    const running = lead.run('Start the team.', { signal: controller.signal })
    const pidFile = nodePath.join(root, 'sleeper.pid')
    await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '', 'the sleeper pid')
    await until(() => llm.calls.some(c => c.route === 'thinker'), 'the thinker to be thinking')
    const pid = Number(readFileSync(pidFile, 'utf8').trim())
    expect(pidAlive(pid)).toBe(true)
    controller.abort()
    const ended = await running
    expect(ended.reason).toEqual({ kind: 'cancelled', cause: 'user' })
    await until(() => !pidAlive(pid), 'the sleeper to end')

    let leadRecords = await records(lead.sessionId)
    const roster = new Map(of(leadRecords, 'team.member').map(r => [r.member.name, r.member]))
    expect([...roster.values()].map(m => m.status)).toEqual(['active', 'active'])
    for (const member of roster.values()) {
      const turnEnd = of(await records(member.sessionId), 'turn.end')
      expect(turnEnd.map(r => r.reason)).toEqual([{ kind: 'cancelled', cause: 'parent' }])
    }
    expect(of(leadRecords, 'subagent.end').map(r => r.result.status)).toEqual(['cancelled', 'cancelled'])
    expect(app.agents.membersOf(lead.sessionId).every(member => !member.busy)).toBe(true)

    // The next Lead turn continues both from where they stopped.
    const next = await lead.run('Carry on.')
    expect(next.reason).toEqual({ kind: 'completed' })
    leadRecords = await records(lead.sessionId)
    const second = of(leadRecords, 'subagent.start').filter(r => r.turn === 2)
    expect(second.map(r => [r.name, r.childTurn, r.task])).toEqual([['runner', 2, CONTINUE_PROMPT], ['thinker', 2, CONTINUE_PROMPT]])
    expect(of(leadRecords, 'subagent.end').filter(r => r.turn === 2).map(r => r.result.status)).toEqual(['completed', 'completed'])
    expect(resultOf(leadRecords, 'w2').content).toContain('runner finished')
    await lead.close()
  })

  it('starts at most four teammates at once', async () => {
    const root = await tempRoot()
    const hang: ScriptedTurn = { content: 'busy', chunkDelayMs: 30_000 }
    const names = ['m1', 'm2', 'm3', 'm4', 'm5']
    const { app, records } = await boot(root, [
      calls(...names.map((name, i) => call('spawn_teammate', { name, task: `job ${i}` }, `s${i + 1}`))),
      { content: 'four are enough' },
    ], Object.fromEntries(names.map(name => [name, [hang]])))
    const lead = await app.agents.create()
    const ended = await lead.run('Start five.')
    expect(ended.reason).toEqual({ kind: 'completed' })
    const leadRecords = await records(lead.sessionId)
    expect(resultOf(leadRecords, 's5')).toMatchObject({ isError: true })
    expect(resultOf(leadRecords, 's5').content).toMatch(/4 teammates are already running/)
    expect(of(leadRecords, 'team.member').filter(r => r.member.status === 'active').map(r => r.member.name)).toEqual(['m1', 'm2', 'm3', 'm4'])
    await lead.close()
  })
})

describe('team: what members see', () => {
  it('teammates keep send_message and the board but cannot start members; the Lead tools refuse members', async () => {
    const root = await tempRoot()
    const { app, llm, records } = await boot(root, [
      calls(call('spawn_teammate', { name: 'mate', task: 'Look around.' }, 's1')),
      calls(call('wait_teammates', {}, 'w1')),
      calls(call('delegate', { name: 'helper', task: 'Try the team tools.' }, 'd1')),
      { content: 'checked' },
    ], {
      mate: [calls(call('team_task_list', {}, 'm1')), { content: 'looked' }],
      helper: [calls(call('send_message', { to: 'lead', text: 'hi' }, 'h1')), { content: 'tried' }],
    })
    const lead = await app.agents.create()
    await lead.run('Check member tools.')
    const toolsOf = (route: string) => llm.calls.find(c => c.route === route)!.request.tools!.map(tool => tool.name)
    const mateTools = toolsOf('mate')
    expect(mateTools).toEqual(expect.arrayContaining(['send_message', 'team_task_list', 'team_task_update']))
    for (const denied of ['spawn_teammate', 'wait_teammates', 'delegate']) expect(mateTools).not.toContain(denied)
    expect(toolsOf('helper')).not.toContain('spawn_teammate')
    const leadRecords = await records(lead.sessionId)
    const helperId = of(leadRecords, 'subagent.start').find(r => r.name === 'helper')!.childSessionId
    const refused = resultOf(await records(helperId), 'h1')
    expect(refused).toMatchObject({ isError: true })
    expect(refused.content).toMatch(/delegated member is not on a team/)
    expect(of(leadRecords, 'team.message')).toEqual([])
    await lead.close()
  })
})
