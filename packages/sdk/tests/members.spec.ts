/**
 * Step 3 through the SDK (W6): the collaboration plugins are loaded; a
 * member started by `delegate` is tracked (its events carry
 * `parentSessionId`, the parent gets `member.start` / `member.end`), its
 * approvals are answered through `approvals.respond`, it is cancelled with
 * its parent; `sessions.list` shows root sessions with their member count,
 * `sessions.children` / `sessions.view` / `sessions.collaboration` show the
 * members read-only; reopening the parent after a hard kill closes the open
 * run as `interrupted` (H21).
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import * as nodePath from 'node:path'
import { fileURLToPath } from 'node:url'
import type { LLMRequest, SessionRecord } from '@nexgent/kernel'
import type { ScriptEntry } from '@nexgent/test-support'
import { describe, expect, it } from 'vitest'
import { collaborationView, historyItems, type SdkEvent } from '../src/index.js'
import { tempDir, testSdk, waitForEvent } from './helpers.js'

const CHILD = fileURLToPath(new URL('./fixtures/member-crash-child.ts', import.meta.url))
const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url))

const writeAndPresent = (path: string, text: string): ScriptEntry<LLMRequest>[] => [
  { toolCalls: [{ name: 'write_file', arguments: { path, content: text } }] },
  { toolCalls: [{ name: 'present', arguments: { paths: [path], summary: text } }] },
  { content: `${text}: wrote ${path}` },
]

type Ev<T extends SdkEvent['type']> = Extract<SdkEvent, { type: T }>
const ofType = <T extends SdkEvent['type']>(events: readonly SdkEvent[], type: T) => events.filter((event): event is Ev<T> => event.type === type)

describe('members through the SDK', () => {
  it('loads the step-3 tools and tracks a delegated member from start to deliverable', async () => {
    const t = await testSdk([
      { toolCalls: [{ name: 'delegate', arguments: { name: 'analyst', task: 'Write the north summary', expectedOutput: 'out/north.md' } }] },
      { content: 'The analyst presented out/north.md.' },
    ], { routes: { analyst: writeAndPresent('out/north.md', 'north 10') } })
    const project = await t.sdk.call('projects.open', { root: nodePath.join(t.base, 'p'), create: true })
    const root = await t.sdk.call('sessions.create', { projectId: project.projectId, title: 'orders' })
    const started = await t.sdk.startTurn({ projectId: project.projectId, sessionId: root.sessionId, text: 'Delegate the north summary' })
    expect((await started.done).reason).toEqual({ kind: 'completed' })

    const tools = t.providers[0]!.llm.calls[0]!.request.tools?.map(tool => tool.name) ?? []
    expect(tools).toEqual(expect.arrayContaining(['delegate', 'workflow', 'run_code', 'read_spreadsheet', 'write_spreadsheet', 'web_fetch']))

    const memberStart = ofType(t.eventsOf(root.sessionId), 'member.start')
    const memberEnd = ofType(t.eventsOf(root.sessionId), 'member.end')
    expect(memberStart).toHaveLength(1)
    expect(memberStart[0]!.run).toMatchObject({ name: 'analyst', executionForm: 'delegated', status: 'running', deliverables: [] })
    expect(memberEnd).toHaveLength(1)
    expect(memberEnd[0]!.run).toMatchObject({ name: 'analyst', status: 'completed', deliverables: [{ memberName: 'analyst', files: [{ path: 'out/north.md' }] }] })
    const childId = memberStart[0]!.run.childSessionId

    // The member's own stream reached subscribers, stamped with its parent.
    const childEvents = t.eventsOf(childId)
    expect(childEvents.map(event => event.type)).toEqual(expect.arrayContaining(['turn.start', 'tool.start', 'deliverable.presented', 'assistant.message', 'turn.end']))
    expect(childEvents.every(event => event.parentSessionId === root.sessionId)).toBe(true)
    expect(childEvents.map(event => event.eventSeq)).toEqual(childEvents.map((_, index) => index + 1))
    expect(ofType(childEvents, 'turn.end')[0]!.usage).toBeDefined()
    // The root's own events carry no parent; its turn still ends exactly once.
    expect(t.eventsOf(root.sessionId).every(event => event.parentSessionId === undefined)).toBe(true)
    expect(ofType(t.eventsOf(root.sessionId), 'turn.end')).toHaveLength(1)

    // Lists: root sessions only with their member count; the member on request.
    const list = await t.sdk.call('sessions.list', { projectId: project.projectId })
    expect(list.map(summary => summary.sessionId)).toEqual([root.sessionId])
    expect(list[0]).toMatchObject({ childCount: 1 })
    expect(list[0]!.parentSessionId).toBeUndefined()
    const all = await t.sdk.call('sessions.list', { projectId: project.projectId, includeChildren: true })
    expect(all.map(summary => summary.sessionId).sort()).toEqual([root.sessionId, childId].sort())
    const children = await t.sdk.call('sessions.children', { projectId: project.projectId, sessionId: root.sessionId })
    expect(children).toEqual([expect.objectContaining({ sessionId: childId, parentSessionId: root.sessionId, member: expect.objectContaining({ name: 'analyst', executionForm: 'delegated' }) })])
    expect(children[0]!.childCount).toBeUndefined()

    // Read-only views of the member: view, and open (which takes no lock and cannot run turns).
    const view = await t.sdk.call('sessions.view', { projectId: project.projectId, sessionId: childId })
    expect(view.summary).toMatchObject({ sessionId: childId, parentSessionId: root.sessionId, running: false })
    expect(view.items.filter(item => item.kind === 'deliverable')).toHaveLength(1)
    expect(view.items.find(item => item.kind === 'assistant' && item.text.includes('north 10: wrote'))).toBeDefined()
    const opened = await t.sdk.call('sessions.open', { projectId: project.projectId, sessionId: childId })
    expect(opened.summary.sessionId).toBe(childId)
    await expect(t.sdk.call('turns.send', { projectId: project.projectId, sessionId: childId, text: 'more' })).rejects.toMatchObject({ code: 'tool/denied' })
    await expect(t.sdk.call('sessions.rename', { projectId: project.projectId, sessionId: childId, title: 'x' })).rejects.toMatchObject({ code: 'tool/denied' })
    await t.sdk.call('sessions.close', { projectId: project.projectId, sessionId: childId })

    // The parent's history and collaboration view.
    const parentView = await t.sdk.call('sessions.view', { projectId: project.projectId, sessionId: root.sessionId })
    const members = parentView.items.filter(item => item.kind === 'member')
    expect(members).toEqual([expect.objectContaining({ turn: 1, run: expect.objectContaining({ childSessionId: childId, status: 'completed' }) })])
    const collaboration = await t.sdk.call('sessions.collaboration', { projectId: project.projectId, sessionId: root.sessionId })
    expect(collaboration).toMatchObject({ sessionId: root.sessionId, runs: [{ childSessionId: childId, name: 'analyst', status: 'completed' }], workflows: [] })
    expect(collaboration.team).toBeUndefined()

    // The member's deliverable is marked as a member's in the project list.
    const deliverables = await t.sdk.call('deliverables.list', { projectId: project.projectId })
    expect(deliverables[0]?.versions[0]).toMatchObject({ memberName: 'analyst', memberId: childId, sessionId: childId })
  })

  it('asks the member\'s approvals through approval.request, answerable under the parent session', async () => {
    const t = await testSdk([
      { toolCalls: [{ name: 'delegate', arguments: { name: 'writer', task: 'Write .env' } }] },
      { content: 'Done.' },
    ], {
      routes: {
        writer: [
          { toolCalls: [{ name: 'write_file', arguments: { path: '.env', content: 'A=1\n' } }] },
          { content: 'wrote .env' },
        ],
      },
    })
    const project = await t.sdk.call('projects.open', { root: nodePath.join(t.base, 'p'), create: true })
    const root = await t.sdk.call('sessions.create', { projectId: project.projectId })
    const started = await t.sdk.startTurn({ projectId: project.projectId, sessionId: root.sessionId, text: 'go' })
    const ask = (await waitForEvent(t, event => event.type === 'approval.request')) as Ev<'approval.request'>
    expect(ask.parentSessionId).toBe(root.sessionId)
    expect(ask.sessionId).not.toBe(root.sessionId)
    expect(ask.request.member).toMatchObject({ name: 'writer', executionForm: 'delegated', parentSessionId: root.sessionId })
    expect(await t.sdk.call('approvals.respond', { projectId: project.projectId, sessionId: 'other', decision: { id: ask.request.id, decision: 'allow', scope: 'once' } })).toBe(false)
    expect(await t.sdk.call('approvals.respond', { projectId: project.projectId, sessionId: root.sessionId, decision: { id: ask.request.id, decision: 'allow', scope: 'once' } })).toBe(true)
    expect((await started.done).reason).toEqual({ kind: 'completed' })
    expect(await readFile(nodePath.join(project.root, '.env'), 'utf8')).toBe('A=1\n')
    expect(t.events.find(event => event.type === 'approval.decision')).toMatchObject({ sessionId: ask.sessionId, parentSessionId: root.sessionId, decision: { decision: 'allow', decidedBy: 'user' } })
  })

  it('cancelling the parent cancels the member (cause parent) and the run ends cancelled', async () => {
    const t = await testSdk([
      { toolCalls: [{ name: 'delegate', arguments: { name: 'slow', task: 'Take your time' } }] },
    ], { routes: { slow: [{ content: Array.from({ length: 200 }, (_, i) => `part ${i} `), chunkDelayMs: 25 }] } })
    const project = await t.sdk.call('projects.open', { root: nodePath.join(t.base, 'p'), create: true })
    const root = await t.sdk.call('sessions.create', { projectId: project.projectId })
    const started = await t.sdk.startTurn({ projectId: project.projectId, sessionId: root.sessionId, text: 'go' })
    const delta = await waitForEvent(t, event => event.type === 'text.delta' && event.parentSessionId === root.sessionId)
    const memberId = delta.sessionId!
    expect(t.sdk.isRunning(project.projectId, memberId)).toBe(true)
    await t.sdk.call('turns.cancel', { projectId: project.projectId, sessionId: root.sessionId })
    expect((await started.done).reason).toEqual({ kind: 'cancelled', cause: 'user' })
    expect(ofType(t.eventsOf(memberId), 'turn.end')[0]!.reason).toEqual({ kind: 'cancelled', cause: 'parent' })
    expect(ofType(t.eventsOf(root.sessionId), 'member.end')[0]!.run).toMatchObject({ name: 'slow', status: 'cancelled' })
    expect(t.sdk.isRunning(project.projectId, memberId)).toBe(false)
  })

  it('reports a team: teammate runs, mail as team.message events, the roster in sessions.collaboration', async () => {
    const t = await testSdk([
      { toolCalls: [{ name: 'spawn_teammate', arguments: { name: 'bob', task: 'Say hello to the lead.' } }] },
      { toolCalls: [{ name: 'wait_teammates', arguments: {} }] },
      { content: 'Bob said hello.' },
    ], { routes: { bob: [{ toolCalls: [{ name: 'send_message', arguments: { to: 'lead', text: 'hello lead' } }] }, { content: 'sent' }] } })
    const project = await t.sdk.call('projects.open', { root: nodePath.join(t.base, 'p'), create: true })
    const lead = await t.sdk.call('sessions.create', { projectId: project.projectId })
    const started = await t.sdk.startTurn({ projectId: project.projectId, sessionId: lead.sessionId, text: 'Work as a team' })
    expect((await started.done).reason).toEqual({ kind: 'completed' })

    const ends = ofType(t.eventsOf(lead.sessionId), 'member.end')
    expect(ends.map(event => [event.run.name, event.run.executionForm, event.run.status])).toEqual([['bob', 'team', 'completed']])
    const mail = ofType(t.eventsOf(lead.sessionId), 'team.message')
    expect(mail.map(event => [event.message.from, event.message.to, event.message.state])).toEqual([['bob', 'lead', 'queued'], ['bob', 'lead', 'delivered']])
    const collaboration = await t.sdk.call('sessions.collaboration', { projectId: project.projectId, sessionId: lead.sessionId })
    expect(collaboration.team?.members).toEqual([expect.objectContaining({ name: 'bob', sessionId: ends[0]!.run.childSessionId })])
    expect(collaboration.team?.messages).toEqual([expect.objectContaining({ text: 'hello lead', state: 'delivered' })])
    const view = await t.sdk.call('sessions.view', { projectId: project.projectId, sessionId: lead.sessionId })
    expect(view.items.filter(item => item.kind === 'team.message')).toEqual([expect.objectContaining({ message: expect.objectContaining({ state: 'delivered' }) })])
  })

  it.skipIf(process.platform === 'win32')('after a hard kill, reopening the parent closes the open run as interrupted; members stay visible', async () => {
    const base = await tempDir('nexgent-sdk-members-')
    const root = nodePath.join(base, 'project')
    const home = nodePath.join(base, 'home')
    await mkdir(root)
    await mkdir(home)
    const child = await new Promise<{ ids: string[]; signal: NodeJS.Signals | null }>((resolve, reject) => {
      const proc = spawn(process.execPath, ['--import', 'tsx', CHILD, root, home], { cwd: PACKAGE_DIR, stdio: ['ignore', 'pipe', 'inherit'] })
      let out = ''
      let ids: string[] = []
      proc.stdout.setEncoding('utf8')
      proc.stdout.on('data', (chunk: string) => {
        out += chunk
        const match = /^streaming (\S+) (\S+)$/m.exec(out)
        if (match !== null && ids.length === 0) {
          ids = [match[1]!, match[2]!]
          proc.kill('SIGKILL')
        }
      })
      proc.on('error', reject)
      proc.on('exit', (_code, signal) => resolve({ ids, signal }))
    })
    expect(child.signal).toBe('SIGKILL')
    const [parentId, childId] = child.ids as [string, string]

    const t = await testSdk([], { home, env: { NEXGENT_API_KEY: 'sk-test', NEXGENT_HOME: home } })
    const project = await t.sdk.call('projects.open', { root })
    const list = await t.sdk.call('sessions.list', { projectId: project.projectId })
    expect(list).toEqual([expect.objectContaining({ sessionId: parentId, childCount: 1, interrupted: true })])
    const opened = await t.sdk.call('sessions.open', { projectId: project.projectId, sessionId: parentId })
    expect(opened.items.find(item => item.kind === 'member')).toMatchObject({ run: { childSessionId: childId, name: 'slow', status: 'interrupted' } })
    expect(ofType(t.eventsOf(parentId), 'member.end')[0]!.run).toMatchObject({ childSessionId: childId, status: 'interrupted' })
    const collaboration = await t.sdk.call('sessions.collaboration', { projectId: project.projectId, sessionId: parentId })
    expect(collaboration.runs).toEqual([expect.objectContaining({ childSessionId: childId, status: 'interrupted' })])
    // The member stays readable (its streamed text up to the kill) without being locked.
    const view = await t.sdk.call('sessions.view', { projectId: project.projectId, sessionId: childId })
    expect(view.summary).toMatchObject({ parentSessionId: parentId, member: { name: 'slow' } })
    expect(existsSync(nodePath.join(root, '.nexgent', 'sessions', childId, 'session.lock'))).toBe(false)
    expect(await t.sdk.call('sessions.children', { projectId: project.projectId, sessionId: parentId })).toEqual([expect.objectContaining({ sessionId: childId })])
  })
})

describe('workflow history (pure)', () => {
  const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
  const base = { v: 1, ts: '2026-10-11T00:00:00.000Z', sessionId: 'p' }
  const records = [
    { ...base, seq: 2, type: 'workflow.start', turn: 1, toolCallId: 'c1', workflowId: 'w', kind: 'script', title: 'regions' },
    { ...base, seq: 3, type: 'workflow.phase', turn: 1, workflowId: 'w', phase: 'parts' },
    { ...base, seq: 4, type: 'subagent.start', turn: 1, toolCallId: 'c1', childSessionId: 'a', childTurn: 1, name: 'north', executionForm: 'workflow', workflowId: 'w', task: 't' },
    { ...base, seq: 5, type: 'subagent.start', turn: 1, toolCallId: 'c1', childSessionId: 'b', childTurn: 1, name: 'south', executionForm: 'workflow', workflowId: 'w', task: 't' },
    { ...base, seq: 6, type: 'subagent.end', turn: 1, childSessionId: 'a', childTurn: 1, result: { status: 'completed', text: 'ok', deliverables: [], usage, requestCount: 1 } },
    { ...base, seq: 7, type: 'workflow.end', turn: 1, workflowId: 'w', status: 'interrupted', members: 2, error: { name: 'NexgentError', code: 'internal', message: 'stopped' } },
  ] as unknown as SessionRecord[]

  it('shows one workflow item with its phases and final state, and one item per member run at its start', () => {
    const items = historyItems(records)
    expect(items.map(item => item.kind)).toEqual(['workflow', 'member', 'member'])
    expect(items[0]).toMatchObject({ kind: 'workflow', workflow: { workflowId: 'w', title: 'regions', phases: ['parts'], status: 'interrupted', members: 2 } })
    expect(items[1]).toMatchObject({ run: { name: 'north', status: 'completed', workflowId: 'w' } })
    expect(items[2]).toMatchObject({ run: { name: 'south', status: 'running' } })
    const view = collaborationView('p', records)
    expect(view.workflows).toEqual([expect.objectContaining({ status: 'interrupted', members: 2, phases: ['parts'] })])
    expect(view.runs.map(run => run.status)).toEqual(['completed', 'running'])
  })
})
