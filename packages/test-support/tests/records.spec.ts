import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { LedgerRecord } from '@nexgent/kernel'
import {
  appendPartialLine,
  ledgerStats,
  listSessionIds,
  readJsonlFile,
  readLedgerRecords,
  readSessionRecords,
  sessionFilePath,
  truncateFile,
} from '../src/index.js'

const SID = '6f1c0000-0000-4000-8000-000000000001'
const unknown = { inputTokens: 'unknown', outputTokens: 'unknown', totalTokens: 'unknown', cacheReadTokens: 'unknown', reasoningTokens: 'unknown' }
const sessionLines = [
  { type: 'session.start', seq: 1, ts: '2026-10-07T08:00:00.000Z', sessionId: SID, version: 1, projectRoot: '/p', model: 'm', sandboxMode: 'workspace-write' },
  { type: 'turn.start', seq: 2, ts: '2026-10-07T08:00:01.000Z', sessionId: SID, turn: 1 },
  { type: 'user.message', seq: 3, ts: '2026-10-07T08:00:02.000Z', sessionId: SID, turn: 1, content: 'hi', source: 'user' },
]

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nexgent-ts-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function writeSession(lines: unknown[]): Promise<string> {
  const path = sessionFilePath(root, SID)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, lines.map((l) => `${JSON.stringify(l)}\n`).join(''))
  return path
}

describe('readSessionRecords', () => {
  it('reads every complete record from the spec layout', async () => {
    const path = await writeSession(sessionLines)
    expect(path).toBe(join(root, '.nexgent', 'sessions', SID, 'session.jsonl'))
    const result = await readSessionRecords(root, SID)
    expect(result.exists).toBe(true)
    expect(result.records.map((r) => r.seq)).toEqual([1, 2, 3])
    expect(result.truncation).toBeUndefined()
    expect(await listSessionIds(root)).toEqual([SID])
  })

  it('tolerates a truncated last line (kill -9 mid-write)', async () => {
    const path = await writeSession(sessionLines)
    await truncateFile(path, { dropLastBytes: 10 })
    const result = await readSessionRecords(root, SID)
    expect(result.records.map((r) => r.seq)).toEqual([1, 2])
    expect(result.truncation).toMatchObject({ line: 3, reason: 'unterminated', ignoredLines: 0 })
    const firstTwo = sessionLines.slice(0, 2).map((l) => `${JSON.stringify(l)}\n`).join('')
    expect(result.truncation!.byteOffset).toBe(Buffer.byteLength(firstTwo))
  })

  it('stops at the first invalid line and counts what it ignored', async () => {
    const path = await writeSession(sessionLines)
    await writeFile(path, `${JSON.stringify(sessionLines[0])}\n{broken\n${JSON.stringify(sessionLines[1])}\n`)
    const result = await readJsonlFile(path)
    expect(result.records).toHaveLength(1)
    expect(result.truncation).toMatchObject({ line: 2, reason: 'invalid-json', ignoredLines: 1 })
  })

  it('accepts CRLF line endings and reports a missing file', async () => {
    const path = await writeSession([])
    await writeFile(path, `${JSON.stringify(sessionLines[0])}\r\n`)
    expect((await readJsonlFile(path)).records).toHaveLength(1)
    const missing = await readSessionRecords(root, 'nope')
    expect(missing).toMatchObject({ exists: false, records: [] })
    expect(await listSessionIds(join(root, 'none'))).toEqual([])
  })
})

describe('readLedgerRecords / ledgerStats', () => {
  const records: LedgerRecord[] = [
    { type: 'llm.request.start', ts: '2026-09-30T23:59:59.000Z', requestId: 'a', provider: 'p', endpoint: 'e', model: 'm', purpose: 'task', thinking: 'off' },
    { type: 'llm.request.end', ts: '2026-10-01T00:00:01.000Z', requestId: 'a', provider: 'p', endpoint: 'e', model: 'm', status: 'ok', latencyMs: 5,
      usage: { inputTokens: 10, outputTokens: 3, totalTokens: 15, cacheReadTokens: 2, reasoningTokens: 0 }, finishReason: 'stop' },
    { type: 'llm.request.start', ts: '2026-10-01T00:00:02.000Z', requestId: 'b', provider: 'p', endpoint: 'e', model: 'm', purpose: 'task', thinking: 'off' },
    { type: 'llm.request.end', ts: '2026-10-01T00:00:03.000Z', requestId: 'b', provider: 'p', endpoint: 'e', model: 'm', status: 'error', latencyMs: 5,
      usage: unknown as never, httpStatus: 503, errorCode: 'llm/request-failed' },
    { type: 'llm.request.start', ts: '2026-10-01T00:00:04.000Z', requestId: 'c', provider: 'p', endpoint: 'e', model: 'm', purpose: 'task', thinking: 'off' },
    { type: 'tool.call', ts: '2026-10-01T00:00:05.000Z', sessionId: SID, turn: 1, callId: 'c1', name: 'write_file', effects: ['write'],
      approval: { required: false, decision: 'auto' }, isError: false, durationMs: 3 },
  ]

  it('reads month files in order, tolerating a truncated tail', async () => {
    const sep = join(root, '.nexgent', 'ledgers', '2026-09')
    const oct = join(root, '.nexgent', 'ledgers', '2026-10')
    await mkdir(sep, { recursive: true })
    await mkdir(oct, { recursive: true })
    await writeFile(join(sep, 'requests.jsonl'), `${JSON.stringify(records[0])}\n`)
    await writeFile(join(oct, 'requests.jsonl'), records.slice(1).map((r) => `${JSON.stringify(r)}\n`).join(''))
    await appendPartialLine(join(oct, 'requests.jsonl'), '{"type":"task.outcome","ts"')
    const result = await readLedgerRecords(root)
    expect(result.records).toEqual(records)
    expect(result.files).toHaveLength(2)
    expect(result.files[1]!.truncation?.reason).toBe('unterminated')
    expect((await readLedgerRecords(root, { month: '2026-09' })).records).toHaveLength(1)
    expect((await readLedgerRecords(join(root, 'none'))).records).toEqual([])
  })

  it('pairs start/end by requestId; unpaired starts count as unknown', () => {
    expect(ledgerStats(records)).toEqual({
      requestCount: 3,
      statusCounts: { ok: 1, error: 1, aborted: 0, unknown: 1 },
      unknownUsageCount: 2,
      knownInputTokens: 12,
      knownOutputTokens: 3,
      toolCallCount: 1,
      taskOutcomes: 0,
    })
  })
})
