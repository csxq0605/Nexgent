/**
 * ADR 0022 through the SDK: plan mode and `exit_plan`, a host mode switch,
 * read-only commands in read-only mode, and the command sandbox status in
 * `session.start`.
 */
import { existsSync } from 'node:fs'
import * as nodePath from 'node:path'
import type { SessionRecord } from '@nexgent/kernel'
import { readSessionRecords } from '@nexgent/test-support'
import { describe, expect, it } from 'vitest'
import type { SdkEvent } from '../src/index.js'
import { testSdk, waitForEvent, type TestSdk } from './helpers.js'

type ToolResultEvent = Extract<SdkEvent, { type: 'tool.result' }>

function results(t: TestSdk): ToolResultEvent[] {
  return t.events.filter((event): event is ToolResultEvent => event.type === 'tool.result')
}

async function records(t: TestSdk, root: string, sessionId: string): Promise<SessionRecord[]> {
  return (await readSessionRecords(root, sessionId, { home: t.home })).records
}

const shell = process.platform === 'win32' ? 'pwsh' : 'bash'

describe('plan mode (ADR 0022 decision 4)', () => {
  it('works read-only until the user approves the plan through exit_plan, then runs in the execution mode', async () => {
    const t = await testSdk([
      { toolCalls: [{ name: 'write_file', arguments: { path: 'a.txt', content: 'early' } }] },
      { toolCalls: [{ name: 'exit_plan', arguments: { plan: 'Write a.txt, then read it back.' } }] },
      { toolCalls: [{ name: 'write_file', arguments: { path: 'a.txt', content: 'planned' } }] },
      { content: 'done' },
    ])
    const project = await t.sdk.call('projects.open', { root: nodePath.join(t.base, 'p'), create: true })
    const session = await t.sdk.call('sessions.create', { projectId: project.projectId, plan: true })
    expect(await t.sdk.call('sessions.view', { projectId: project.projectId, sessionId: session.sessionId })).toMatchObject({ plan: true, sandboxMode: 'workspace-write' })
    const asks: Array<Extract<SdkEvent, { type: 'approval.request' }>['request']> = []
    t.sdk.subscribe(event => {
      if (event.type !== 'approval.request') return
      asks.push(event.request)
      void t.sdk.call('approvals.respond', { projectId: project.projectId, sessionId: event.sessionId, decision: { id: event.request.id, decision: 'allow', scope: 'once' } })
    })
    await t.sdk.call('turns.send', { projectId: project.projectId, sessionId: session.sessionId, text: 'plan first' })
    await waitForEvent(t, event => event.type === 'turn.end')
    const [early, exit, planned] = results(t)
    expect(early).toMatchObject({ name: 'write_file', isError: true })
    expect(exit).toMatchObject({ name: 'exit_plan', isError: false })
    expect(planned).toMatchObject({ name: 'write_file', isError: false })
    // The approval question shows the plan itself.
    expect(asks).toHaveLength(1)
    expect(asks[0]).toMatchObject({ tool: 'exit_plan', risk: 'high', options: ['once'], detail: 'Write a.txt, then read it back.' })
    const all = await records(t, project.root, session.sessionId)
    expect(all.find(record => record.type === 'session.start')).toMatchObject({ plan: true })
    expect(all.filter(record => record.type === 'session.mode')).toMatchObject([{ sandboxMode: 'workspace-write', plan: false, reason: 'plan-approved' }])
    expect(await t.sdk.call('sessions.view', { projectId: project.projectId, sessionId: session.sessionId })).toMatchObject({ plan: false })
  })

  it('a resumed session keeps plan mode until a plan is approved', async () => {
    const t = await testSdk([
      { content: 'thinking about it' },
      { toolCalls: [{ name: 'write_file', arguments: { path: 'b.txt', content: 'x' } }] },
      { content: 'still planning' },
    ])
    const project = await t.sdk.call('projects.open', { root: nodePath.join(t.base, 'p'), create: true })
    const session = await t.sdk.call('sessions.create', { projectId: project.projectId, plan: true })
    await t.sdk.call('turns.send', { projectId: project.projectId, sessionId: session.sessionId, text: 'look around' })
    await waitForEvent(t, event => event.type === 'turn.end')
    await t.sdk.call('sessions.close', { projectId: project.projectId, sessionId: session.sessionId })
    expect(await t.sdk.call('sessions.open', { projectId: project.projectId, sessionId: session.sessionId })).toMatchObject({ plan: true })
    await t.sdk.call('turns.send', { projectId: project.projectId, sessionId: session.sessionId, text: 'now write' })
    await waitForEvent(t, event => event.type === 'turn.end' && event.turn === 2)
    expect(results(t)).toMatchObject([{ name: 'write_file', isError: true }])
    expect(existsSync(nodePath.join(project.root, 'b.txt'))).toBe(false)
  })
})

describe('sessions.setMode', () => {
  it('switches the mode mid-session with a session.mode record; the next call follows it', async () => {
    const t = await testSdk([
      { toolCalls: [{ name: 'write_file', arguments: { path: 'c.txt', content: 'x' } }] },
      { content: 'ok' },
    ])
    const project = await t.sdk.call('projects.open', { root: nodePath.join(t.base, 'p'), create: true })
    const session = await t.sdk.call('sessions.create', { projectId: project.projectId })
    const view = await t.sdk.call('sessions.setMode', { projectId: project.projectId, sessionId: session.sessionId, sandboxMode: 'read-only' })
    expect(view).toMatchObject({ sandboxMode: 'read-only', plan: false })
    await t.sdk.call('turns.send', { projectId: project.projectId, sessionId: session.sessionId, text: 'write c' })
    await waitForEvent(t, event => event.type === 'turn.end')
    expect(results(t)).toMatchObject([{ name: 'write_file', isError: true }])
    const all = await records(t, project.root, session.sessionId)
    expect(all.filter(record => record.type === 'session.mode')).toMatchObject([{ sandboxMode: 'read-only', plan: false, reason: 'host' }])
    await expect(t.sdk.call('sessions.setMode', { projectId: project.projectId, sessionId: session.sessionId, sandboxMode: 'everything' as never })).rejects.toThrow(/sandbox mode/)
  })
})

describe('commands in read-only mode (ADR 0022 decision 4)', () => {
  it.skipIf(process.platform === 'win32')('runs read-only commands and refuses the rest', async () => {
    const t = await testSdk([
      { toolCalls: [{ name: shell, arguments: { command: 'ls -a' } }] },
      { toolCalls: [{ name: shell, arguments: { command: 'touch made.txt' } }] },
      { content: 'ok' },
    ])
    const project = await t.sdk.call('projects.open', { root: nodePath.join(t.base, 'p'), create: true })
    const session = await t.sdk.call('sessions.create', { projectId: project.projectId, sandboxMode: 'read-only' })
    await t.sdk.call('turns.send', { projectId: project.projectId, sessionId: session.sessionId, text: 'look' })
    await waitForEvent(t, event => event.type === 'turn.end')
    const [ls, touch] = results(t)
    expect(ls).toMatchObject({ name: shell, isError: false })
    expect(ls!.content).toContain('.nexgent')
    expect(touch).toMatchObject({ name: shell, isError: true })
    expect(existsSync(nodePath.join(project.root, 'made.txt'))).toBe(false)
  })
})

describe('command sandbox status (ADR 0022 decision 1)', () => {
  it('session.start records whether commands run in an OS sandbox', async () => {
    const t = await testSdk([{ content: 'hi' }])
    const project = await t.sdk.call('projects.open', { root: nodePath.join(t.base, 'p'), create: true })
    const session = await t.sdk.call('sessions.create', { projectId: project.projectId })
    const start = (await records(t, project.root, session.sessionId)).find(record => record.type === 'session.start')
    const status = start?.type === 'session.start' ? start.commandSandbox : undefined
    expect(status?.kind).toMatch(/^(active|none|off)$/)
    // Windows never claims one.
    if (process.platform === 'win32') expect(status?.kind).not.toBe('active')
  })
})
