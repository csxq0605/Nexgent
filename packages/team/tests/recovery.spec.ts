/**
 * Team recovery after a hard kill of the Lead's process (H06): queued mail is
 * delivered exactly once afterwards, the task board reads as before, and
 * unfinished teammates continue. Also the reconciliation rule for a kill
 * between a recipient seeing a message and its `delivered` record.
 */
import { spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as nodePath from 'node:path'
import { fileURLToPath } from 'node:url'
import { ContextPlugin } from '@nexgent/context'
import { createApp, type Context, type LLMRequest, type NexgentApp, type SessionRecord, type TeamTask } from '@nexgent/kernel'
import { SessionPlugin } from '@nexgent/session'
import { closeInterruptedRuns } from '@nexgent/subagent'
import { TaskingPlugin } from '@nexgent/tasking'
import { scriptedProvider } from '@nexgent/test-support'
import { WorkspacePlugin } from '@nexgent/workspace'
import { afterEach, describe, expect, it } from 'vitest'
import { CONTINUE_PROMPT, messageMarker, recoverTeam, reduceTeam, renderInjectedMessage, TeamPlugin, undeliveredButSeen, WAKE_PROMPT } from '../src/index.js'

const CHILD = fileURLToPath(new URL('./fixtures/team-crash-child.ts', import.meta.url))
const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url))

const apps: NexgentApp[] = []
const dirs: string[] = []
afterEach(async () => {
  while (apps.length > 0) await apps.pop()!.dispose()
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true, maxRetries: 5 })
})

function runChild(root: string): Promise<{ stdout: string; code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', CHILD, root], { cwd: PACKAGE_DIR, stdio: ['ignore', 'pipe', 'inherit'] })
    let stdout = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => (stdout += chunk))
    child.on('error', reject)
    child.on('exit', (code, signal) => resolve({ stdout, code, signal }))
  })
}

function memberOf(request: LLMRequest): string | undefined {
  const system = request.messages.find(message => message.role === 'system')
  const text = typeof system?.content === 'string' ? system.content : ''
  return /^Member: ([a-z][a-z0-9-]*) \(/m.exec(text)?.[1]
}

const of = <T extends SessionRecord['type']>(records: readonly SessionRecord[], type: T) =>
  records.filter((r): r is Extract<SessionRecord, { type: T }> => r.type === type)

describe('team recovery after a hard kill', () => {
  it('delivers queued mail exactly once, keeps the board, and continues the unfinished teammate', async () => {
    const root = realpathSync.native(await mkdtemp(nodePath.join(tmpdir(), 'nxteam-kill-')))
    dirs.push(root)
    const child = await runChild(root)
    const match = /^ids (\S+)$/m.exec(child.stdout)
    expect(match, child.stdout).not.toBeNull()
    expect(child.code === 0).toBe(false)
    const leadId = match![1]!

    const llm = scriptedProvider([
      { toolCalls: [{ id: 'l1', name: 'team_task_list', arguments: {} }] },
      { toolCalls: [{ id: 'w2', name: 'wait_teammates', arguments: {} }] },
      { content: 'recovered' },
    ], { routeKey: memberOf, routes: { alice: [{ content: 'alice continued' }], bob: [{ content: 'bob read it' }] } })
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
    await app.ctx.plugin(TeamPlugin)
    const store = app.ctx.session
    const records = async (id: string) => (await store.readAll(id)).records

    // On disk at the kill: both messages queued, none delivered; t1 claimed by alice.
    const before = reduceTeam(await records(leadId))
    const messages = [...before.messages.values()]
    expect(messages.map(m => [m.from, m.to, m.state])).toEqual([['alice', 'bob', 'queued'], ['alice', 'lead', 'queued']])
    expect([...before.tasks.values()].map(t => [t.id, t.status, t.owner ?? null])).toEqual([['t1', 'in_progress', 'alice'], ['t2', 'pending', null]])
    const roster = Object.fromEntries([...before.members.values()].map(m => [m.name, m]))
    expect(roster.alice!.status).toBe('active')
    expect(roster.bob!.status).toBe('idle')

    const lead = await app.agents.resume(leadId)
    expect(await closeInterruptedRuns(lead, store)).toHaveLength(1)
    expect(await recoverTeam(lead, store)).toEqual([])
    const ended = await lead.run('Carry on.')
    expect(ended.reason).toEqual({ kind: 'completed' })
    llm.assertConsumed()

    const leadRecords = await records(leadId)
    // The board as the recovered Lead lists it equals the board before the kill.
    const listed = of(leadRecords, 'tool.result').find(r => r.toolCallId === 'l1')!
    expect((listed.meta as unknown as { tasks: TeamTask[] }).tasks).toEqual([...before.tasks.values()])

    // Every message: exactly one queued and one delivered record.
    for (const message of messages) {
      expect(of(leadRecords, 'team.message').filter(r => r.message.id === message.id).map(r => r.message.state)).toEqual(['queued', 'delivered'])
    }
    const [toBob, toLead] = messages
    // The Lead's mail was injected once at its turn start, and not handed over again by wait_teammates.
    const leadInjects = of(leadRecords, 'user.message').filter(r => r.source === 'inject' && r.content.includes(messageMarker(toLead!.id)))
    expect(leadInjects.map(r => r.turn)).toEqual([2])
    expect(of(leadRecords, 'tool.result').some(r => r.content.includes(messageMarker(toLead!.id)))).toBe(false)
    // Bob got his once, in the run his mail woke; alice continued her interrupted work.
    const bobInjects = of(await records(roster.bob!.sessionId), 'user.message').filter(r => r.source === 'inject' && r.content.includes(messageMarker(toBob!.id)))
    expect(bobInjects).toHaveLength(1)
    const runs = of(leadRecords, 'subagent.start').filter(r => r.turn === 2).map(r => [r.name, r.task])
    expect(runs).toEqual(expect.arrayContaining([['alice', CONTINUE_PROMPT], ['bob', WAKE_PROMPT]]))
    expect(runs).toHaveLength(2)
    await lead.close()
  })
})

describe('reconciliation', () => {
  it('a queued message its recipient already holds is marked delivered, not delivered again', async () => {
    const id = '11111111-2222-4333-8444-555555555555'
    const other = '66666666-7777-4888-8999-aaaaaaaaaaaa'
    const base = { seq: 1, ts: '2026-10-11T00:00:00.000Z', sessionId: 'lead' }
    const leadRecords = [
      { ...base, type: 'team.member', member: { name: 'bob', sessionId: 'bob-session', status: 'idle' } },
      { ...base, type: 'team.message', message: { id, from: 'lead', to: 'bob', text: 'seen', state: 'queued' } },
      { ...base, type: 'team.message', message: { id: other, from: 'bob', to: 'lead', text: 'unseen', state: 'queued' } },
    ] as unknown as SessionRecord[]
    const bobRecords = [
      { ...base, sessionId: 'bob-session', type: 'user.message', turn: 2, source: 'inject', content: renderInjectedMessage({ id, from: 'lead', text: 'seen' }) },
    ] as unknown as SessionRecord[]
    const store = { readAll: async (sessionId: string) => ({ records: sessionId === 'bob-session' ? bobRecords : leadRecords }) }
    const seen = await undeliveredButSeen(reduceTeam(leadRecords), leadRecords, store as never)
    expect(seen.map(message => message.id)).toEqual([id])
  })
})
