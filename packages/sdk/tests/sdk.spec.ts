/**
 * `createSdk` over the real kernel, session, workspace, context, skill and
 * tasking plugins with a scripted model: projects, sessions and history,
 * the event stream (one `turn.end` per turn on completion, cancel, approval
 * timeout and crash recovery), approvals, settings and the per-turn
 * `task.outcome`.
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import * as nodePath from 'node:path'
import { readLedgerRecords, readSessionRecords } from '@nexgent/test-support'
import { describe, expect, it, vi } from 'vitest'
import { SDK_METHOD_NAMES, type SdkEvent } from '../src/index.js'
import { systemOf, TEST_KEY, testSdk, waitForEvent } from './helpers.js'

const usage = { inputTokens: 100, outputTokens: 10, totalTokens: 110, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }

function turnEnds(events: readonly SdkEvent[], turn?: number): SdkEvent[] {
  return events.filter(event => event.type === 'turn.end' && (turn === undefined || event.turn === turn))
}

describe('projects', () => {
  it('opens (creating the directory and .nexgent/), lists recent projects, closes and forgets', async () => {
    const t = await testSdk([])
    const root = nodePath.join(t.base, 'new-project')
    await expect(t.sdk.call('projects.open', { root })).rejects.toMatchObject({ code: 'workspace/not-found' })

    const info = await t.sdk.call('projects.open', { root, create: true })
    expect(info).toMatchObject({ name: 'new-project', exists: true })
    const config = JSON.parse(await readFile(nodePath.join(info.root, '.nexgent', 'config.json'), 'utf8')) as Record<string, unknown>
    expect(config).toMatchObject({ version: 1, thinking: 'on', sandboxMode: 'workspace-write' })
    for (const dir of ['sessions', 'materials', 'outputs', 'ledgers']) expect(existsSync(nodePath.join(info.root, '.nexgent', dir))).toBe(true)

    // the same root again is the same project
    expect((await t.sdk.call('projects.open', { root })).projectId).toBe(info.projectId)
    const recent = await t.sdk.call('projects.recent', {})
    expect(recent.map(entry => entry.root)).toEqual([info.root])
    expect(recent[0]!.projectId).toBe(info.projectId)
    expect(JSON.parse(await readFile(nodePath.join(t.home, 'recent-projects.json'), 'utf8'))).toMatchObject({ version: 1, projects: [{ root: info.root }] })

    await t.sdk.call('projects.close', { projectId: info.projectId })
    await expect(t.sdk.call('sessions.list', { projectId: info.projectId })).rejects.toMatchObject({ code: 'workspace/not-found' })
    await t.sdk.call('projects.forget', { root: info.root })
    expect(await t.sdk.call('projects.recent', {})).toEqual([])
  })

  it('runs one turn in each of two open projects at once without interference', async () => {
    const t = await testSdk(() => [
      request => ({ toolCalls: [{ name: 'write_file', arguments: { path: 'who.txt', content: nodePath.basename(/directory is (.*)\.?$/m.exec(systemOf(request))![1]!.replace(/\.$/, '')) } }], chunkDelayMs: 5 }),
      { content: ['done ', 'here'], chunkDelayMs: 5, usage },
    ])
    const a = await t.sdk.call('projects.open', { root: nodePath.join(t.base, 'alpha'), create: true })
    const b = await t.sdk.call('projects.open', { root: nodePath.join(t.base, 'beta'), create: true })
    const sa = await t.sdk.call('sessions.create', { projectId: a.projectId })
    const sb = await t.sdk.call('sessions.create', { projectId: b.projectId })
    const [ra, rb] = await Promise.all([
      t.sdk.startTurn({ projectId: a.projectId, sessionId: sa.sessionId, text: 'write who.txt' }),
      t.sdk.startTurn({ projectId: b.projectId, sessionId: sb.sessionId, text: 'write who.txt' }),
    ])
    const [da, db] = await Promise.all([ra.done, rb.done])
    expect(da.reason).toEqual({ kind: 'completed' })
    expect(db.reason).toEqual({ kind: 'completed' })
    expect(await readFile(nodePath.join(a.root, 'who.txt'), 'utf8')).toBe('alpha')
    expect(await readFile(nodePath.join(b.root, 'who.txt'), 'utf8')).toBe('beta')
    expect((await t.sdk.call('sessions.list', { projectId: a.projectId })).map(s => s.sessionId)).toEqual([sa.sessionId])
    expect((await t.sdk.call('sessions.list', { projectId: b.projectId })).map(s => s.sessionId)).toEqual([sb.sessionId])
    for (const [project, session] of [[a, sa], [b, sb]] as const) {
      const events = t.eventsOf(session.sessionId)
      expect(events.every(event => event.projectId === project.projectId)).toBe(true)
      expect(events.map(event => event.eventSeq)).toEqual(events.map((_, index) => index + 1))
      expect(turnEnds(events)).toHaveLength(1)
      expect(events.at(-1)?.type).toBe('turn.end')
    }
  })
})

describe('sessions, events and history', () => {
  it('streams a turn, ends it with one turn.end, writes one task.outcome and shows the history', async () => {
    const t = await testSdk([
      { content: 'Writing.', toolCalls: [{ name: 'write_file', arguments: { path: 'notes.md', content: '# Notes\n' } }], usage },
      { content: ['All ', 'done.'], usage },
    ])
    const project = await t.sdk.call('projects.open', { root: nodePath.join(t.base, 'p'), create: true })
    const session = await t.sdk.call('sessions.create', { projectId: project.projectId, title: 'first' })
    expect(session).toMatchObject({ title: 'first', lastTurn: 0, running: false, interrupted: false })

    const handle = await t.sdk.call('turns.send', { projectId: project.projectId, sessionId: session.sessionId, text: 'Write notes' })
    expect(handle).toEqual({ sessionId: session.sessionId, turn: 1 })
    const end = await waitForEvent(t, event => event.type === 'turn.end')
    expect(end).toMatchObject({ turn: 1, reason: { kind: 'completed' }, usage: { inputTokens: 200, outputTokens: 20 } })

    const types = t.eventsOf(session.sessionId).map(event => event.type)
    expect(types[0]).toBe('turn.start')
    expect(types.at(-1)).toBe('turn.end')
    expect(types).toEqual(expect.arrayContaining(['text.delta', 'tool.start', 'tool.result', 'assistant.message', 'turn.files']))
    expect(types.filter(type => type === 'turn.end')).toHaveLength(1)
    expect(t.events.find(event => event.type === 'turn.files')).toMatchObject({ changes: [{ path: 'notes.md', change: 'added' }] })

    await vi.waitFor(() => expect(t.sdk.isRunning(project.projectId, session.sessionId)).toBe(false))
    const view = await t.sdk.call('sessions.open', { projectId: project.projectId, sessionId: session.sessionId })
    expect(view.items.map(item => item.kind)).toEqual(['user', 'assistant', 'tool', 'assistant', 'files', 'turn.end'])
    expect(view.items[0]).toMatchObject({ kind: 'user', text: 'Write notes', source: 'user', materials: [] })
    expect(view.items[2]).toMatchObject({ kind: 'tool', call: { name: 'write_file' }, isError: false })
    expect(view.summary).toMatchObject({ lastTurn: 1, running: false, interrupted: false })

    const ledger = await readLedgerRecords(project.root)
    const outcomes = ledger.records.filter(record => record.type === 'task.outcome')
    expect(outcomes).toEqual([expect.objectContaining({ sessionId: session.sessionId, status: 'completed', requestCount: 2, toolCallCount: 1, turns: 1, toolsUsed: ['write_file'] })])
  })

  it('cancels a streaming turn: text so far is kept, one turn.end { cancelled }', async () => {
    const t = await testSdk([{ content: Array.from({ length: 200 }, (_, i) => `w${i} `), chunkDelayMs: 10 }])
    const project = await t.sdk.call('projects.open', { root: nodePath.join(t.base, 'p'), create: true })
    const session = await t.sdk.call('sessions.create', { projectId: project.projectId })
    await t.sdk.call('turns.send', { projectId: project.projectId, sessionId: session.sessionId, text: 'talk' })
    await waitForEvent(t, event => event.type === 'text.delta' && event.text === 'w3 ')
    await expect(t.sdk.call('turns.send', { projectId: project.projectId, sessionId: session.sessionId, text: 'again' })).rejects.toMatchObject({ code: 'session/locked' })
    await t.sdk.call('turns.cancel', { projectId: project.projectId, sessionId: session.sessionId })
    // resolved after turn.end
    expect(turnEnds(t.events)).toEqual([expect.objectContaining({ reason: { kind: 'cancelled', cause: 'user' } })])
    const message = t.events.find(event => event.type === 'assistant.message')
    expect(message).toMatchObject({ interrupted: true })
    expect((message as { text: string }).text.startsWith('w0 w1 w2 w3 ')).toBe(true)
    // idle cancel is a no-op
    await t.sdk.call('turns.cancel', { projectId: project.projectId, sessionId: session.sessionId })
    expect(turnEnds(t.events)).toHaveLength(1)
    const outcomes = (await readLedgerRecords(project.root)).records.filter(record => record.type === 'task.outcome')
    expect(outcomes.map(record => record.type === 'task.outcome' && record.status)).toEqual(['cancelled'])
  })

  it('closing a session with a running turn cancels it (shutdown) and releases the lock', async () => {
    const t = await testSdk([{ content: Array.from({ length: 200 }, (_, i) => `w${i} `), chunkDelayMs: 10 }])
    const project = await t.sdk.call('projects.open', { root: nodePath.join(t.base, 'p'), create: true })
    const session = await t.sdk.call('sessions.create', { projectId: project.projectId })
    await t.sdk.call('turns.send', { projectId: project.projectId, sessionId: session.sessionId, text: 'talk' })
    await waitForEvent(t, event => event.type === 'text.delta')
    await t.sdk.call('sessions.close', { projectId: project.projectId, sessionId: session.sessionId })
    expect(turnEnds(t.events)).toEqual([expect.objectContaining({ reason: { kind: 'cancelled', cause: 'shutdown' } })])
    expect(existsSync(nodePath.join(project.root, '.nexgent', 'sessions', session.sessionId, '.lock'))).toBe(false)
  })
})

describe('approvals', () => {
  // Writing a sensitive file (`.env`) asks in workspace-write mode; a write outside the project is denied without asking.
  const sensitiveWrite = [
    { toolCalls: [{ name: 'write_file', arguments: { path: '.env', content: 'x' } }] },
    { content: 'ok' },
  ]

  it('asks through approval.request; a deny is a refused tool result; late answers resolve false', async () => {
    const t = await testSdk(sensitiveWrite)
    const project = await t.sdk.call('projects.open', { root: nodePath.join(t.base, 'p'), create: true })
    const session = await t.sdk.call('sessions.create', { projectId: project.projectId })
    await t.sdk.call('turns.send', { projectId: project.projectId, sessionId: session.sessionId, text: 'write .env' })
    const ask = await waitForEvent(t, event => event.type === 'approval.request')
    const request = (ask as Extract<SdkEvent, { type: 'approval.request' }>).request
    expect(await t.sdk.call('approvals.respond', { projectId: project.projectId, sessionId: 'other', decision: { id: request.id, decision: 'allow', scope: 'once' } })).toBe(false)
    expect(await t.sdk.call('approvals.respond', { projectId: project.projectId, sessionId: session.sessionId, decision: { id: request.id, decision: 'deny', scope: 'once' } })).toBe(true)
    expect(await t.sdk.call('approvals.respond', { projectId: project.projectId, sessionId: session.sessionId, decision: { id: request.id, decision: 'allow', scope: 'once' } })).toBe(false)
    await waitForEvent(t, event => event.type === 'turn.end')
    expect(t.events.find(event => event.type === 'approval.decision')).toMatchObject({ decision: { decision: 'deny', decidedBy: 'user' } })
    expect(t.events.find(event => event.type === 'tool.result')).toMatchObject({ name: 'write_file', isError: true })
    expect(existsSync(nodePath.join(project.root, '.env'))).toBe(false)
    expect(turnEnds(t.events)).toHaveLength(1)
  })

  it('accepts an answer given synchronously from the approval.request callback', async () => {
    const t = await testSdk(sensitiveWrite)
    const project = await t.sdk.call('projects.open', { root: nodePath.join(t.base, 'p'), create: true })
    const session = await t.sdk.call('sessions.create', { projectId: project.projectId })
    const answers: Promise<boolean>[] = []
    t.sdk.subscribe(event => {
      if (event.type !== 'approval.request') return
      answers.push(t.sdk.call('approvals.respond', { projectId: project.projectId, sessionId: event.sessionId, decision: { id: event.request.id, decision: 'allow', scope: 'once' } }))
    })
    await t.sdk.call('turns.send', { projectId: project.projectId, sessionId: session.sessionId, text: 'write .env' })
    await waitForEvent(t, event => event.type === 'turn.end')
    expect(await Promise.all(answers)).toEqual([true])
    expect(t.events.find(event => event.type === 'approval.decision')).toMatchObject({ decision: { decision: 'allow', decidedBy: 'user' } })
    expect(t.events.find(event => event.type === 'tool.result')).toMatchObject({ name: 'write_file', isError: false })
    expect(existsSync(nodePath.join(project.root, '.env'))).toBe(true)
  })

  it('an allow-once lets the call run', async () => {
    const t = await testSdk(sensitiveWrite)
    const project = await t.sdk.call('projects.open', { root: nodePath.join(t.base, 'p'), create: true })
    const session = await t.sdk.call('sessions.create', { projectId: project.projectId })
    await t.sdk.call('turns.send', { projectId: project.projectId, sessionId: session.sessionId, text: 'write .env' })
    const ask = (await waitForEvent(t, event => event.type === 'approval.request')) as Extract<SdkEvent, { type: 'approval.request' }>
    await t.sdk.call('approvals.respond', { projectId: project.projectId, sessionId: session.sessionId, decision: { id: ask.request.id, decision: 'allow', scope: 'once' } })
    await waitForEvent(t, event => event.type === 'turn.end')
    expect(await readFile(nodePath.join(project.root, '.env'), 'utf8')).toBe('x')
  })

  it('an unanswered request times out and the turn still ends with one turn.end', async () => {
    const t = await testSdk(sensitiveWrite, { approvalTimeoutMs: 100 })
    const project = await t.sdk.call('projects.open', { root: nodePath.join(t.base, 'p'), create: true })
    const session = await t.sdk.call('sessions.create', { projectId: project.projectId })
    await t.sdk.call('turns.send', { projectId: project.projectId, sessionId: session.sessionId, text: 'write .env' })
    await waitForEvent(t, event => event.type === 'turn.end')
    expect(t.events.find(event => event.type === 'approval.decision')).toMatchObject({ decision: { decision: 'deny', decidedBy: 'timeout' } })
    expect(turnEnds(t.events)).toEqual([expect.objectContaining({ reason: { kind: 'completed' } })])
  })
})

describe('settings', () => {
  it('reads and patches config.json keeping unknown-to-the-page fields; reports the key without its value', async () => {
    const t = await testSdk([])
    const project = await t.sdk.call('projects.open', { root: nodePath.join(t.base, 'p'), create: true })
    const configFile = nodePath.join(project.root, '.nexgent', 'config.json')
    const raw = JSON.parse(await readFile(configFile, 'utf8')) as Record<string, unknown>
    await writeFile(configFile, JSON.stringify({ ...raw, extraReadRoots: ['/data'] }))

    const settings = await t.sdk.call('settings.get', { projectId: project.projectId })
    expect(settings).toMatchObject({ model: 'claude-sonnet-5-5', thinking: 'on', effort: 'medium', apiKey: { configured: true, source: 'env' } })
    expect(JSON.stringify(settings)).not.toContain(TEST_KEY)

    const next = await t.sdk.call('settings.update', { projectId: project.projectId, patch: { thinking: 'off', costCaps: { perTask: { maxRequests: 9 } } } })
    expect(next).toMatchObject({ thinking: 'off', costCaps: { perTask: { maxRequests: 9 } } })
    const written = JSON.parse(await readFile(configFile, 'utf8')) as Record<string, unknown>
    expect(written).toMatchObject({ thinking: 'off', extraReadRoots: ['/data'], costCaps: { perTask: { maxRequests: 9 } } })
    await expect(t.sdk.call('settings.update', { projectId: project.projectId, patch: { effort: 'huge' as 'high' } })).rejects.toMatchObject({ code: 'config/invalid' })
    await expect(t.sdk.call('settings.update', { projectId: project.projectId, patch: { approvals: [] } as never })).rejects.toMatchObject({ code: 'config/invalid' })
    expect(JSON.parse(await readFile(configFile, 'utf8'))).toEqual(written)

    // step 5: the settings page owns autoImprove and the improvement settings (a user action)
    expect(settings).toMatchObject({ autoImprove: true, improvement: { feedbackThreshold: 3, budget: { maxTokens: 3_000_000, windowDays: 30 }, model: 'claude-sonnet-5-5', thinking: 'on' } })
    const off = await t.sdk.call('settings.update', { projectId: project.projectId, patch: { autoImprove: false, improvement: { budget: { windowDays: 7 } } } })
    expect(off).toMatchObject({ autoImprove: false, improvement: { feedbackThreshold: 3, budget: { maxTokens: 3_000_000, windowDays: 7 } } })
    await expect(t.sdk.call('settings.update', { projectId: project.projectId, patch: { improvement: { feedbackThreshold: 0 } } })).rejects.toMatchObject({ code: 'config/invalid' })
  })

  it('stores the key in credentials.json (0600) and removes it with an empty value; never returns it', async () => {
    const t = await testSdk([], { env: {} })
    const info = await t.sdk.call('settings.setApiKey', { value: 'sk-stored-1234' })
    expect(info).toEqual({ configured: true, source: 'file' })
    const file = nodePath.join(t.home, 'credentials.json')
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ version: 1, credentials: { NEXGENT_API_KEY: 'sk-stored-1234' } })
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect(await t.sdk.call('settings.setApiKey', { value: '' })).toEqual({ configured: false })
  })
})

describe('method table', () => {
  it('reports a missing PowerShell 7 through app.info, checked once', async () => {
    let checks = 0
    const t = await testSdk([], { checkShell: () => { checks++; return { shell: 'pwsh', required: true, available: false } } })
    expect((await t.sdk.call('app.info', {})).commandShell).toEqual({ shell: 'pwsh', required: true, available: false })
    await t.sdk.call('app.info', {})
    expect(checks).toBe(1)
  })

  it('implements every whitelisted method and rejects others', async () => {
    const t = await testSdk([])
    const info = await t.sdk.call('app.info', {})
    expect(info).toMatchObject({ sdkVersion: 8, appVersion: '0.0.0-test', platform: process.platform })
    expect(info.commandShell).toEqual(process.platform === 'win32' ? { shell: 'pwsh', required: true, available: info.commandShell.available } : { shell: 'bash', required: false, available: true })
    await expect(t.sdk.call('nope' as never, {} as never)).rejects.toMatchObject({ code: 'internal' })
    for (const method of SDK_METHOD_NAMES) expect(typeof (t.sdk as unknown as { methods: Record<string, unknown> }).methods[method]).toBe('function')
    // step 5: the improvement methods work on open projects (tests/improvements.spec.ts)
    await expect(t.sdk.call('improvements.list', { projectId: 'p' })).rejects.toMatchObject({ code: 'workspace/not-found' })
  })

  it('deliverables.reveal needs the host hook', async () => {
    const t = await testSdk([])
    const project = await t.sdk.call('projects.open', { root: nodePath.join(t.base, 'p'), create: true })
    await expect(t.sdk.call('deliverables.reveal', { projectId: project.projectId, deliverableId: 'x', version: 1, path: 'a' })).rejects.toMatchObject({ code: 'internal' })
  })
})

describe('rename, project files and dialogs', () => {
  it('renames a session with a session.title record that survives a restart', async () => {
    const t = await testSdk([])
    const project = await t.sdk.call('projects.open', { root: nodePath.join(t.base, 'p'), create: true })
    const created = await t.sdk.call('sessions.create', { projectId: project.projectId, title: '草稿' })
    const renamed = await t.sdk.call('sessions.rename', { projectId: project.projectId, sessionId: created.sessionId, title: '  六月订单汇总  ' })
    expect(renamed).toMatchObject({ sessionId: created.sessionId, title: '六月订单汇总' })
    await expect(t.sdk.call('sessions.rename', { projectId: project.projectId, sessionId: created.sessionId, title: '   ' })).rejects.toMatchObject({ code: 'tool/invalid-input' })
    expect((await t.sdk.call('sessions.list', { projectId: project.projectId }))[0]).toMatchObject({ title: '六月订单汇总' })
    const { records } = await readSessionRecords(project.root, created.sessionId)
    expect(records.filter(record => record.type === 'session.title')).toEqual([expect.objectContaining({ title: '六月订单汇总' })])

    await t.sdk.dispose()
    const again = await testSdk([], { home: t.home, env: { NEXGENT_API_KEY: TEST_KEY, NEXGENT_HOME: t.home } })
    const reopened = await again.sdk.call('projects.open', { root: project.root })
    expect((await again.sdk.call('sessions.open', { projectId: reopened.projectId, sessionId: created.sessionId })).summary.title).toBe('六月订单汇总')
  })

  it('lists project files without host data, VCS, dependencies or symlinked directories', async () => {
    const t = await testSdk([])
    const project = await t.sdk.call('projects.open', { root: nodePath.join(t.base, 'p'), create: true })
    const root = project.root
    for (const dir of ['src/lib', '.git/objects', 'node_modules/x', 'pkg/node_modules/y', 'docs/.nexgent']) await mkdir(nodePath.join(root, dir), { recursive: true })
    for (const file of ['README.md', 'src/main.ts', 'src/lib/util.ts', '.git/objects/a', 'node_modules/x/i.js', 'pkg/node_modules/y/i.js', 'docs/.nexgent/kept.md', '.env']) {
      await writeFile(nodePath.join(root, file), 'x')
    }
    if (process.platform !== 'win32') await (await import('node:fs/promises')).symlink(nodePath.join(root, 'src'), nodePath.join(root, 'linked'))
    const listing = await t.sdk.call('files.list', { projectId: project.projectId })
    expect(listing.truncated).toBe(false)
    expect(listing.files.map(file => file.path)).toEqual(['.env', 'README.md', 'docs/.nexgent/kept.md', 'src/lib/util.ts', 'src/main.ts'])
    expect(listing.files[1]).toMatchObject({ size: 1, modifiedAt: expect.stringMatching(/^\d{4}-/) })
  })

  it('stops listing at the limit and says so', async () => {
    const { listProjectFiles } = await import('../src/index.js')
    const t = await testSdk([])
    for (const name of ['a', 'b', 'c']) await writeFile(nodePath.join(t.base, `${name}.txt`), name)
    const listing = await listProjectFiles(t.base, 2)
    expect(listing).toMatchObject({ truncated: true })
    expect(listing.files).toHaveLength(2)
  })

  it('dialogs go to the host pickers, and reject without them', async () => {
    const bare = await testSdk([])
    await expect(bare.sdk.call('dialogs.pickDirectory', {})).rejects.toMatchObject({ code: 'internal' })
    await expect(bare.sdk.call('dialogs.pickFiles', {})).rejects.toMatchObject({ code: 'internal' })
    const desk = await testSdk([], { pickDirectory: async () => '/picked', pickFiles: async () => ['/a.csv', '/b.csv'] })
    expect(await desk.sdk.call('dialogs.pickDirectory', {})).toBe('/picked')
    expect(await desk.sdk.call('dialogs.pickFiles', {})).toEqual(['/a.csv', '/b.csv'])
  })
})

describe('session files', () => {
  it('records are valid and seq is continuous after several SDK operations', async () => {
    const t = await testSdk([{ content: 'hi' }])
    const project = await t.sdk.call('projects.open', { root: nodePath.join(t.base, 'p'), create: true })
    const session = await t.sdk.call('sessions.create', { projectId: project.projectId })
    await t.sdk.call('goals.set', { projectId: project.projectId, sessionId: session.sessionId, text: 'Say hi' })
    const started = await t.sdk.startTurn({ projectId: project.projectId, sessionId: session.sessionId, text: 'hi' })
    await started.done
    await t.sdk.call('goals.update', { projectId: project.projectId, sessionId: session.sessionId, status: 'completed', note: 'said' })
    expect(t.events.filter(event => event.type === 'goal').map(event => event.type === 'goal' && event.goal.status)).toEqual(['active', 'completed'])
    const { records } = await readSessionRecords(project.root, session.sessionId)
    expect(records.map(record => record.seq)).toEqual(records.map((_, index) => index + 1))
    expect((await t.sdk.call('sessions.list', { projectId: project.projectId }))[0]!.goal).toMatchObject({ status: 'completed', note: 'said' })
    await mkdir(nodePath.join(project.root, '.nexgent', 'sessions', 'not-a-session'))
    expect(await t.sdk.call('sessions.list', { projectId: project.projectId })).toHaveLength(1)
  })
})

describe('export', () => {
  it('redacts a key value that leaked into the session and refuses a non-empty target', async () => {
    const t = await testSdk([{ content: `the key is ${TEST_KEY}` }])
    const project = await t.sdk.call('projects.open', { root: nodePath.join(t.base, 'p'), create: true })
    const session = await t.sdk.call('sessions.create', { projectId: project.projectId })
    await (await t.sdk.startTurn({ projectId: project.projectId, sessionId: session.sessionId, text: 'say the key' })).done
    expect(await readFile(nodePath.join(project.root, '.nexgent', 'sessions', session.sessionId, 'session.jsonl'), 'utf8')).toContain(TEST_KEY)

    const out = nodePath.join(t.base, 'bundle')
    const bundle = await t.sdk.call('sessions.export', { projectId: project.projectId, sessionId: session.sessionId, outDir: out })
    expect(bundle.path).toBe(out)
    for (const file of bundle.files) expect(await readFile(nodePath.join(out, file), 'utf8')).not.toContain(TEST_KEY)
    expect(await readFile(nodePath.join(out, 'session.jsonl'), 'utf8')).toContain('the key is [REDACTED]')
    const manifest = JSON.parse(await readFile(nodePath.join(out, 'manifest.json'), 'utf8')) as Record<string, unknown>
    expect(manifest).toMatchObject({ formatVersion: 1, sessionId: session.sessionId, appVersion: '0.0.0-test', sdkVersion: 8, redactions: 1, counts: { ledgerRecords: 1 } })
    await expect(t.sdk.call('sessions.export', { projectId: project.projectId, sessionId: session.sessionId, outDir: out })).rejects.toMatchObject({ code: 'tool/invalid-input' })
  })
})

describe('packaging', () => {
  it('runs in plain Node: no Electron import in the sources or dependencies', async () => {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { dependencies: Record<string, string> }
    expect(Object.keys(pkg.dependencies).some(name => name.includes('electron'))).toBe(false)
    const { readdir } = await import('node:fs/promises')
    const dir = new URL('../src/', import.meta.url)
    for (const file of await readdir(dir)) {
      expect(await readFile(new URL(file, dir), 'utf8')).not.toMatch(/from ['"]electron['"]|require\(['"]electron['"]\)/)
    }
  })
})
