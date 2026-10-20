/**
 * Coordinator step two through the SDK: a conversation hands work to a
 * thread (`start_thread`); the thread runs in the background in its own copy
 * of the project, its turn is recorded in the conversation as a member run
 * (`executionForm: thread`), its files are merged back, and its end wakes
 * the conversation (`user.message.source: thread`). A thread that asks a
 * question waits; `message_thread` answers it. Once a turn's threads have
 * all ended, the organization library gets the turn's full profile.
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import * as nodePath from 'node:path'
import { resolveUserDataLayout, type Context, type LLMRequest, type SessionRecord } from '@nexgent/kernel'
import { llmSessionText, scriptedProvider, type ScriptedProvider, type ScriptEntry } from '@nexgent/test-support'
import { describe, expect, it } from 'vitest'
import { COORDINATOR_NOTES_FILE, threadRunName, threadStatusOf, type SdkEvent } from '../src/index.js'
import { testSdk, waitForEvent, type TestSdk } from './helpers.js'

const THREAD_LINE = /You are a thread of this project's coordinator conversation, working on "([^"]+)"/

/** An SDK whose scripted model answers threads from `threads[title]` and everything else from `main`. */
async function threadSdk(main: ScriptEntry<LLMRequest>[], threads: Record<string, ScriptEntry<LLMRequest>[]>): Promise<TestSdk & { readonly llm: () => ScriptedProvider }> {
  let provider: ScriptedProvider | undefined
  const t = await testSdk([], {
    registry: {
      '@nexgent/llm': {
        name: 'scripted-llm',
        apply(ctx: Context) {
          provider = scriptedProvider(main, { routeKey: request => THREAD_LINE.exec(llmSessionText(request))?.[1], routes: threads })
          ctx.provide('llm', provider)
        },
      },
    },
  })
  return { ...t, llm: () => provider! }
}

const report = (done: string, blockers = 'none') => `Done: ${done}\nNot done: none\nChecks: none\nBlockers: ${blockers}`

async function recordsOf(t: TestSdk, projectId: string, sessionId: string): Promise<readonly SessionRecord[]> {
  const view = await t.sdk.call('sessions.view', { projectId, sessionId })
  expect(view.summary.sessionId).toBe(sessionId)
  return (await (t.sdk as unknown as { projects: Map<string, { app: { ctx: { session: { readAll(id: string): Promise<{ records: SessionRecord[] }> } } } }> }).projects.get(projectId)!.app.ctx.session.readAll(sessionId)).records
}

const turnEnd = (sessionId: string, turn: number) => (event: SdkEvent) => event.sessionId === sessionId && event.type === 'turn.end' && event.turn === turn

describe('threads through the SDK', () => {
  it('runs a thread in the background, merges its files, records it as a run and wakes the conversation', async () => {
    const t = await threadSdk([
      { toolCalls: [{ name: 'start_thread', arguments: { title: 'Summary', task: 'Write out/a.md with the summary.' } }] },
      { content: 'A thread is writing the summary.' },
      // Woken by the thread.
      { content: 'The summary is in out/a.md.' },
    ], {
      Summary: [
        { toolCalls: [{ name: 'write_file', arguments: { path: 'out/a.md', content: 'summary' } }], chunkDelayMs: 150 },
        { content: report('wrote out/a.md') },
      ],
    })
    const project = await t.sdk.call('projects.open', { root: nodePath.join(t.base, 'p'), create: true })
    const coordinator = await t.sdk.call('sessions.coordinator', { projectId: project.projectId })
    const started = await t.sdk.startTurn({ projectId: project.projectId, sessionId: coordinator.sessionId, text: 'Summarize the project.\nPut the summary in out/a.md and keep the rest of the project as it is.' })
    expect((await started.done).reason).toEqual({ kind: 'completed' })
    await waitForEvent(t, turnEnd(coordinator.sessionId, 2))

    const threadStart = (t.events.find(event => event.type === 'member.start' && event.sessionId === coordinator.sessionId) as Extract<SdkEvent, { type: 'member.start' }>).run
    expect(threadStart).toMatchObject({ executionForm: 'thread', name: 'summary', childTurn: 1 })
    const threadId = threadStart.childSessionId

    // The thread's copy was merged into the project.
    expect(await readFile(nodePath.join(project.root, 'out/a.md'), 'utf8')).toBe('summary')

    // The conversation: the run, then the wake note as turn 2.
    const records = await recordsOf(t, project.projectId, coordinator.sessionId)
    const end = records.find(record => record.type === 'subagent.end')
    expect(end).toMatchObject({ turn: 1, childSessionId: threadId, childTurn: 1, result: { status: 'completed', merge: { applied: ['out/a.md'] } } })
    const wake = records.find(record => record.type === 'user.message' && record.source === 'thread')
    expect(wake).toMatchObject({ turn: 2 })
    expect((wake as Extract<SessionRecord, { type: 'user.message' }>).content).toContain('Thread "Summary"')
    expect(t.events.some(event => event.type === 'thread.message' && event.sessionId === coordinator.sessionId && event.turn === 2)).toBe(true)

    // The thread is a conversation of its own, under the coordinator, without the thread tools.
    const threadRecords = await recordsOf(t, project.projectId, threadId)
    expect(threadRecords[0]).toMatchObject({ type: 'session.start', thread: { coordinatorSessionId: coordinator.sessionId, title: 'Summary' } })
    expect(threadRecords.find(record => record.type === 'user.message' && record.source !== 'inject')).toMatchObject({ source: 'thread', content: 'Write out/a.md with the summary.' })
    const list = await t.sdk.call('sessions.list', { projectId: project.projectId })
    expect(list.find(summary => summary.sessionId === threadId)).toMatchObject({ thread: { title: 'Summary' } })
    expect(await t.sdk.call('threads.list', { projectId: project.projectId, sessionId: coordinator.sessionId })).toEqual([
      expect.objectContaining({ threadId, title: 'Summary', status: 'done', turns: 1 }),
    ])

    // The organization library measured turn 1 again with the thread in it.
    const log = nodePath.join(resolveUserDataLayout(t.home).organizations, 'runs.jsonl')
    await expect.poll(async () => existsSync(log) && (await readFile(log, 'utf8')).includes('"type":"profile"'), { timeout: 3_000 }).toBe(true)
    const lines = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { type: string; waiting?: boolean; profile?: { parts: { kind: string }[] } })
    expect(lines.find(line => line.type === 'run')).toMatchObject({ waiting: true })
    expect(lines.find(line => line.type === 'profile')!.profile!.parts.map(part => part.kind)).toEqual(['coordinator', 'thread'])
  })

  it('hides the thread tools in threads, keeps a thread with a question waiting, and message_thread answers it', async () => {
    let threadId = ''
    const t = await threadSdk([
      { toolCalls: [{ name: 'start_thread', arguments: { title: 'Report', task: 'Write the report.' } }] },
      { content: 'Started.' },
      // Woken with the question: answer it.
      () => ({ toolCalls: [{ name: 'message_thread', arguments: { thread: threadId, text: 'Use 2025.' } }] }),
      { content: 'Answered.' },
      // Woken again: done.
      { content: 'The report is done.' },
    ], {
      Report: [
        { content: report('nothing yet', 'which year should the report cover?'), chunkDelayMs: 150 },
        { content: report('wrote the 2025 report') },
      ],
    })
    const project = await t.sdk.call('projects.open', { root: nodePath.join(t.base, 'p'), create: true })
    const coordinator = await t.sdk.call('sessions.coordinator', { projectId: project.projectId })
    const firstRun = waitForEvent(t, event => event.type === 'member.start' && event.sessionId === coordinator.sessionId)
    await t.sdk.startTurn({ projectId: project.projectId, sessionId: coordinator.sessionId, text: 'Write the report' })
    threadId = ((await firstRun) as Extract<SdkEvent, { type: 'member.start' }>).run.childSessionId
    await waitForEvent(t, turnEnd(coordinator.sessionId, 3))

    const records = await recordsOf(t, project.projectId, coordinator.sessionId)
    const notes = records.filter(record => record.type === 'user.message' && record.source === 'thread').map(record => (record as Extract<SessionRecord, { type: 'user.message' }>).content)
    expect(notes[0]).toContain('stopped with a question or blocker')
    expect(notes[1]).toContain('finished its turn')
    expect(records.filter(record => record.type === 'subagent.start').map(record => [record.turn, (record as Extract<SessionRecord, { type: 'subagent.start' }>).childTurn])).toEqual([[1, 1], [2, 2]])
    expect(await t.sdk.call('threads.list', { projectId: project.projectId, sessionId: coordinator.sessionId })).toEqual([expect.objectContaining({ threadId, status: 'done', turns: 2 })])

    // Tools: the conversation has the thread tools, the thread does not.
    const tools = (route: string | undefined) => t.llm().calls.find(call => call.route === route)!.request.tools?.map(tool => tool.name) ?? []
    expect(tools(undefined)).toEqual(expect.arrayContaining(['start_thread', 'message_thread', 'read_thread', 'list_threads']))
    expect(tools('Report')).not.toContain('start_thread')
    expect(tools('Report')).not.toContain('list_threads')
    expect(tools('Report')).not.toContain('update_project_notes')
    // The coordinator only assigns: no tool that writes or runs commands; its thread keeps them.
    expect(tools(undefined)).not.toEqual(expect.arrayContaining(['write_file']))
    expect(tools(undefined).filter(name => ['write_file', 'str_replace', 'bash', 'run_code'].includes(name))).toEqual([])
    expect(tools(undefined)).toEqual(expect.arrayContaining(['read_file', 'organize', 'delegate']))
    expect(tools('Report')).toEqual(expect.arrayContaining(['write_file', 'bash']))
  })

  it('gives only the coordinator its prompt, its notes and update_project_notes', async () => {
    const notes = '## Rules\n- Keep the public API unchanged (the user said so for every task).'
    const t = await threadSdk([
      { toolCalls: [{ name: 'update_project_notes', arguments: { notes } }] },
      { content: 'Noted.' },
      { content: 'Second turn.' },
      // An ordinary conversation.
      { content: 'Hello.' },
    ], {})
    const project = await t.sdk.call('projects.open', { root: nodePath.join(t.base, 'p'), create: true })
    const coordinator = await t.sdk.call('sessions.coordinator', { projectId: project.projectId })
    expect((await (await t.sdk.startTurn({ projectId: project.projectId, sessionId: coordinator.sessionId, text: 'Remember the rule.' })).done).reason).toEqual({ kind: 'completed' })
    expect((await (await t.sdk.startTurn({ projectId: project.projectId, sessionId: coordinator.sessionId, text: 'Next.' })).done).reason).toEqual({ kind: 'completed' })
    const other = await t.sdk.call('sessions.create', { projectId: project.projectId })
    expect((await (await t.sdk.startTurn({ projectId: project.projectId, sessionId: other.sessionId, text: 'Hi.' })).done).reason).toEqual({ kind: 'completed' })

    const calls = t.llm().calls
    const system = (index: number) => JSON.stringify(calls[index]!.request.messages.filter(message => message.role === 'system'))
    const tools = (index: number) => calls[index]!.request.tools?.map(tool => tool.name) ?? []
    expect(system(0)).toContain('Coordinating this project')
    expect(system(0)).toContain('(none yet)')
    expect(tools(0)).toContain('update_project_notes')
    // The notes are kept in the project's data directory and shown from the next turn on.
    const dataDir = (t.sdk as unknown as { projects: Map<string, { app: { ctx: { workspace: { layout: { dataDir: string } } } } }> }).projects.get(project.projectId)!.app.ctx.workspace.layout.dataDir
    expect(await readFile(nodePath.join(dataDir, COORDINATOR_NOTES_FILE), 'utf8')).toBe(`${notes}\n`)
    expect(system(2)).toContain('Keep the public API unchanged')
    // An ordinary conversation has neither.
    expect(system(3)).not.toContain('Coordinating this project')
    expect(tools(3)).not.toContain('update_project_notes')
    expect(tools(3)).toContain('start_thread')
    expect(tools(3)).toContain('write_file')
    expect(system(0)).toContain('do none of the work yourself')
    expect(system(3)).not.toContain('do none of the work yourself')
  })

  it('shows that a thread waits for the user to allow a tool call until it is answered there', async () => {
    const t = await threadSdk([
      { toolCalls: [{ name: 'start_thread', arguments: { title: 'Config', task: 'Write .env with A=1.' } }] },
      { content: 'Started.' },
      { content: 'The thread wrote .env.' },
    ], {
      Config: [
        { toolCalls: [{ name: 'write_file', arguments: { path: '.env', content: 'A=1\n' } }] },
        { content: report('wrote .env') },
      ],
    })
    const project = await t.sdk.call('projects.open', { root: nodePath.join(t.base, 'p'), create: true })
    const coordinator = await t.sdk.call('sessions.coordinator', { projectId: project.projectId })
    await t.sdk.startTurn({ projectId: project.projectId, sessionId: coordinator.sessionId, text: 'Set up the config' })
    const ask = (await waitForEvent(t, event => event.type === 'approval.request')) as Extract<SdkEvent, { type: 'approval.request' }>
    const threadId = ask.sessionId
    expect(await t.sdk.call('threads.list', { projectId: project.projectId, sessionId: coordinator.sessionId })).toEqual([expect.objectContaining({ threadId, status: 'running', needsApproval: true })])
    expect(await t.sdk.call('approvals.respond', { projectId: project.projectId, sessionId: threadId, decision: { id: ask.request.id, decision: 'allow', scope: 'once' } })).toBe(true)
    await waitForEvent(t, turnEnd(coordinator.sessionId, 2))
    const [thread] = await t.sdk.call('threads.list', { projectId: project.projectId, sessionId: coordinator.sessionId })
    expect(thread).toMatchObject({ threadId, status: 'done' })
    expect(thread!.needsApproval).toBeUndefined()
    expect(await readFile(nodePath.join(project.root, '.env'), 'utf8')).toBe('A=1\n')
  })

  it('names runs and reads a thread status from its records', () => {
    expect(threadRunName('Release notes', 1)).toBe('release-notes')
    expect(threadRunName('发布说明', 2)).toBe('thread-2')
    const at = '2026-10-20T00:00:00.000Z'
    const base = [
      { type: 'session.start', ts: at, seq: 1, thread: { coordinatorSessionId: 'c', title: 'x' } },
      { type: 'turn.start', ts: at, seq: 2, turn: 1 },
    ] as unknown as SessionRecord[]
    const reply = (content: string) => ({ type: 'assistant.message', ts: at, seq: 3, turn: 1, step: 1, content, usage: {} }) as unknown as SessionRecord
    const ended = (kind: string) => ({ type: 'turn.end', ts: at, seq: 4, turn: 1, reason: { kind } }) as unknown as SessionRecord
    expect(threadStatusOf(base, true)).toEqual({ status: 'running' })
    expect(threadStatusOf([...base, reply(report('x')), ended('completed')], false)).toEqual({ status: 'done' })
    expect(threadStatusOf([...base, reply(report('x', 'which file?')), ended('completed')], false)).toEqual({ status: 'waiting', blocker: 'which file?' })
    expect(threadStatusOf([...base, ended('cancelled')], false)).toEqual({ status: 'stopped' })
    expect(threadStatusOf([...base, ended('error')], false)).toEqual({ status: 'failed' })
  })
})
