/**
 * End to end, in process: `main()` drives the wired runtime (kernel + llm +
 * session + workspace) against the scripted Claude Messages API server on a
 * temp project. Covers run → write file → session + ledger, resume with the
 * history, and Ctrl+C mid-stream. Windows-safe: `path.join`, no shell.
 */
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LedgerRecord, SessionRecord } from '@nexgent/kernel'
import { readLedgerRecords, readSessionRecords, scriptedModelServer, type ScriptedModelServer } from '@nexgent/test-support'
import { EXIT, main } from '../src/index.js'
import { testIo } from './helpers.js'

const usage = { inputTokens: 100, outputTokens: 20, totalTokens: 120, cacheReadTokens: 0, reasoningTokens: 0 }
const FILE = { path: 'hello.txt', content: 'Hello from the CLI e2e test\n' }

let work: string
let project: string
let home: string
let server: ScriptedModelServer | undefined

beforeEach(async () => {
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'nexgent-cli-e2e-'))
  project = path.join(work, 'project')
  home = path.join(work, 'home')
  await fs.mkdir(project)
  await fs.mkdir(home)
})
afterEach(async () => {
  await server?.close()
  server = undefined
  await fs.rm(work, { recursive: true, force: true })
})

function env(s: ScriptedModelServer): Record<string, string> {
  return { NEXGENT_API_KEY: 'e2e-test-key', NEXGENT_API_BASE_URL: s.baseUrl, NEXGENT_HOME: home }
}

/** `--json` stdout as objects (CRLF tolerant). */
function jsonLines(text: string): Array<Record<string, unknown>> {
  return text.split(/\r?\n/).filter(line => line.trim() !== '').map(line => JSON.parse(line) as Record<string, unknown>)
}

async function lockExists(sessionId: string): Promise<boolean> {
  return fs.access(path.join(project, '.nexgent', 'sessions', sessionId, '.lock')).then(() => true, () => false)
}

describe('nexgent run / resume against the scripted model server (in process)', () => {
  it('runs a write-file task: file, --json events, session records, one task.outcome', async () => {
    server = await scriptedModelServer({
      script: [
        { toolCalls: [{ name: 'write_file', arguments: FILE }], usage },
        { content: ['Created ', 'hello.txt.'], usage },
      ],
    })
    const t = testIo(work, env(server))
    const code = await main(['run', '--project', project, '--task', `Create ${FILE.path}`, '--json'], t.io)
    expect(code, t.stderr.text).toBe(EXIT.OK)
    expect(await fs.readFile(path.join(project, FILE.path), 'utf8')).toBe(FILE.content)

    const events = jsonLines(t.stdout.text)
    const types = events.map(e => e.type)
    expect(types[0]).toBe('session')
    expect(types.at(-1)).toBe('final')
    expect(types.filter(type => type === 'turn.end')).toHaveLength(1)
    expect(types.indexOf('turn.end')).toBe(types.length - 2)
    expect(types.filter(type => type === 'step.start')).toHaveLength(2)
    expect(types).toEqual(expect.arrayContaining(['turn.start', 'tool-call.start', 'tool-call.end', 'usage', 'tool.start', 'tool.end', 'text.delta']))
    expect(types.indexOf('tool.start')).toBeLessThan(types.indexOf('tool.end'))
    expect(events.find(e => e.type === 'tool.end')).toMatchObject({ name: 'write_file', isError: false })
    const session = events[0] as { sessionId: string; model: string; sandboxMode: string; resumed: boolean; projectRoot: string }
    expect(session).toMatchObject({ model: 'claude-sonnet-5-5', sandboxMode: 'workspace-write', resumed: false })
    expect(session.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(events.at(-1)).toMatchObject({ type: 'final', status: 'completed', exitCode: 0, requestCount: 2, toolCallCount: 1, text: 'Created hello.txt.' })

    const records = (await readSessionRecords(project, session.sessionId)).records as SessionRecord[]
    // The store may append a `checkpoint` after `turn.end` (data-formats.md policy).
    expect(records.map(r => r.type).filter(type => type !== 'checkpoint')).toEqual([
      'session.start', 'turn.start', 'user.message', 'assistant.message', 'tool.result', 'assistant.message', 'turn.end',
    ])
    expect(records.every((r, i) => r.seq === i + 1)).toBe(true)
    expect(records.filter(r => r.type === 'turn.end')).toEqual([expect.objectContaining({ turn: 1, reason: { kind: 'completed' } })])
    expect(await lockExists(session.sessionId)).toBe(false)

    const ledger = (await readLedgerRecords(project)).records as LedgerRecord[]
    expect(ledger.filter(r => r.type === 'llm.request.start')).toHaveLength(2)
    expect(ledger.filter(r => r.type === 'llm.request.end')).toHaveLength(2)
    expect(ledger.filter(r => r.type === 'tool.call')).toHaveLength(1)
    const outcomes = ledger.filter(r => r.type === 'task.outcome')
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]).toMatchObject({ sessionId: session.sessionId, status: 'completed', requestCount: 2, toolCallCount: 1, turns: 1, toolsUsed: ['write_file'] })

    expect(server.requests).toHaveLength(2)
    expect(server.requests[0]?.hasApiKey).toBe(true)
    expect(JSON.stringify(server.requests[1]?.body)).toContain('tool_result')
    server.assertConsumed()
  })

  it('resumes the session with its history and keeps the header sandbox mode', async () => {
    server = await scriptedModelServer({
      script: [
        { content: ['First answer.'], usage },
        { content: ['Second answer.'], usage },
      ],
    })
    const first = testIo(work, env(server))
    expect(await main(['run', '--project', project, '--task', 'first task', '--sandbox', 'read-only', '--json'], first.io)).toBe(EXIT.OK)
    const sessionId = (jsonLines(first.stdout.text)[0] as { sessionId: string }).sessionId

    // Simulate a crash inside turn 2: a `turn.start` with no `turn.end` (as the kill in accept-step1 leaves behind).
    const file = path.join(project, '.nexgent', 'sessions', sessionId, 'session.jsonl')
    const lines = (await fs.readFile(file, 'utf8')).split(/\r?\n/).filter(line => line !== '')
    const last = JSON.parse(lines.at(-1) ?? '{}') as { seq: number }
    await fs.appendFile(file, `${JSON.stringify({ type: 'turn.start', seq: last.seq + 1, ts: new Date().toISOString(), sessionId, turn: 2 })}\n`)

    const second = testIo(work, env(server))
    expect(await main(['resume', sessionId, '--project', project, '--task', 'second task', '--json'], second.io)).toBe(EXIT.OK)
    const events = jsonLines(second.stdout.text)
    expect(events[0]).toMatchObject({ type: 'session', sessionId, resumed: true, sandboxMode: 'read-only' })
    // the interrupted turn is reported first, then exactly one turn.end for the new turn, last before `final`
    expect(events[1]).toEqual({ type: 'turn.end', turn: 2, reason: { kind: 'interrupted' } })
    expect(events.filter(e => e.type === 'turn.end')).toEqual([
      { type: 'turn.end', turn: 2, reason: { kind: 'interrupted' } },
      { type: 'turn.end', turn: 3, reason: { kind: 'completed' } },
    ])
    expect(events.at(-2)).toMatchObject({ type: 'turn.end', turn: 3 })
    const records = (await readSessionRecords(project, sessionId)).records as SessionRecord[]
    expect(records.filter(r => r.type === 'turn.end').map(r => (r as { turn: number; reason: { kind: string } }).reason.kind)).toEqual(['completed', 'interrupted', 'completed'])
    expect(records.every((r, i) => r.seq === i + 1)).toBe(true)

    const body = JSON.stringify(server.requests[1]?.body)
    expect(body).toContain('first task')
    expect(body).toContain('First answer.')
    expect(body).toContain('second task')
    const outcomes = (await readLedgerRecords(project)).records.filter(r => r.type === 'task.outcome')
    expect(outcomes.map(r => r.status)).toEqual(['completed', 'completed'])
    expect(await lockExists(sessionId)).toBe(false)
  })

  it('Ctrl+C mid-stream ends the turn cancelled (user), exits 130 and records a cancelled outcome', async () => {
    server = await scriptedModelServer({
      script: [{ content: ['part one ', 'part two ', 'part three ', 'part four'], chunkDelayMs: 300, usage }],
    })
    const t = testIo(work, env(server))
    const running = main(['run', '--project', project, '--task', 'slow task', '--json'], t.io)
    await vi.waitFor(() => expect(t.stdout.text).toContain('"type":"text.delta"'), { timeout: 15_000 })
    t.raise('SIGINT')
    expect(await running).toBe(EXIT.CANCELLED)
    const events = jsonLines(t.stdout.text)
    expect(events.filter(e => e.type === 'turn.end')).toEqual([{ type: 'turn.end', turn: 1, reason: { kind: 'cancelled', cause: 'user' } }])
    expect(events.at(-1)).toMatchObject({ type: 'final', status: 'cancelled', exitCode: EXIT.CANCELLED })
    const sessionId = (events[0] as { sessionId: string }).sessionId
    const records = (await readSessionRecords(project, sessionId)).records as SessionRecord[]
    expect(records.find(r => r.type === 'assistant.message')).toMatchObject({ interrupted: true })
    expect(records.filter(r => r.type === 'turn.end')).toEqual([expect.objectContaining({ turn: 1, reason: { kind: 'cancelled', cause: 'user' } })])
    const outcomes = (await readLedgerRecords(project)).records.filter(r => r.type === 'task.outcome')
    expect(outcomes).toEqual([expect.objectContaining({ status: 'cancelled' })])
    expect(await lockExists(sessionId)).toBe(false)
  }, 30_000)

  it('exits 3 without touching the model when the session does not exist', async () => {
    server = await scriptedModelServer({ script: [] })
    const t = testIo(work, env(server))
    const code = await main(['resume', '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b', '--project', project], t.io)
    expect(code).toBe(EXIT.ENVIRONMENT)
    expect(t.stderr.text).toMatch(/session\/not-found/)
    expect(server.requests).toHaveLength(0)
  })
})
