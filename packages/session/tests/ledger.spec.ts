import { appendFile, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  isNexgentError,
  LEDGER_FILE_NAME,
  resolveWorkspaceLayout,
  UNKNOWN_USAGE,
  type LedgerRecord,
  type LedgerRecordInput,
} from '@nexgent/kernel'
import { JsonlLedger } from '../src/index.js'
import { KNOWN_USAGE, tempDir } from './helpers.js'

function clock(...instants: string[]): () => Date {
  let index = 0
  return () => new Date(instants[Math.min(index++, instants.length - 1)] as string)
}

const start = (requestId: string, sessionId = 's1'): LedgerRecordInput => ({
  type: 'llm.request.start',
  sessionId,
  requestId,
  provider: 'mimo',
  endpoint: 'https://example.invalid/v1',
  model: 'mimo-v2.6-pro',
  purpose: 'task',
  thinking: 'off',
})

const end = (requestId: string, sessionId = 's1'): LedgerRecordInput => ({
  type: 'llm.request.end',
  sessionId,
  requestId,
  provider: 'mimo',
  endpoint: 'https://example.invalid/v1',
  model: 'mimo-v2.6-pro',
  status: 'ok',
  usage: KNOWN_USAGE,
  latencyMs: 12,
  httpStatus: 200,
  finishReason: 'stop',
})

async function collect(iterable: AsyncIterable<LedgerRecord>): Promise<LedgerRecord[]> {
  const out: LedgerRecord[] = []
  for await (const record of iterable) out.push(record)
  return out
}

describe('JsonlLedger', () => {
  it('writes .nexgent/ledgers/<yyyy-mm>/requests.jsonl, stamping ts, one fsynced line per record', async () => {
    const root = await tempDir()
    const layout = resolveWorkspaceLayout(root)
    const ledger = new JsonlLedger({ layout, now: clock('2026-10-07T08:00:01.000Z') })
    const record = await ledger.append(start('r1'))
    expect(record).toEqual({ ...start('r1'), ts: '2026-10-07T08:00:01.000Z' })
    const file = join(root, '.nexgent', 'ledgers', '2026-10', LEDGER_FILE_NAME)
    expect(ledger.fileFor(record.ts)).toBe(file)
    const text = await readFile(file, 'utf8')
    expect(text).toBe(`${JSON.stringify(record)}\n`)
    expect(Object.keys(JSON.parse(text) as object).slice(0, 2)).toEqual(['type', 'ts'])
    expect(ledger.writeFailures).toBe(0)
  })

  it('rolls over to a new month directory by the UTC month of ts', async () => {
    const root = await tempDir()
    const ledger = new JsonlLedger({
      layout: resolveWorkspaceLayout(root),
      // 2026-10-31T23:30-05:00 is already November in UTC.
      now: clock('2026-09-30T23:59:59.999Z', '2026-10-01T00:00:00.000Z', '2026-11-01T04:30:00.000Z'),
    })
    await ledger.append(start('r1'))
    await ledger.append(end('r1'))
    await ledger.append(start('r2'))
    expect((await readdir(ledger.ledgersDir)).sort()).toEqual(['2026-09', '2026-10', '2026-11'])
    const all = await collect(ledger.read())
    expect(all.map(record => record.ts)).toEqual([
      '2026-09-30T23:59:59.999Z',
      '2026-10-01T00:00:00.000Z',
      '2026-11-01T04:30:00.000Z',
    ])
  })

  it('read filters by from/to (inclusive), types and sessionId', async () => {
    const root = await tempDir()
    const ledger = new JsonlLedger({
      ledgersDir: resolveWorkspaceLayout(root).ledgers,
      now: clock(
        '2026-09-10T00:00:00.000Z',
        '2026-10-01T00:00:00.000Z',
        '2026-10-02T00:00:00.000Z',
        '2026-10-03T00:00:00.000Z',
        '2026-11-05T00:00:00.000Z',
      ),
    })
    await ledger.append(start('a'))
    await ledger.append(end('a'))
    await ledger.append(start('b', 's2'))
    await ledger.append({
      type: 'tool.call', sessionId: 's2', turn: 1, callId: 'c', name: 'bash', effects: ['execute'],
      approval: { required: true, decision: 'deny', scope: 'once', requestId: 'ap' }, isError: true, durationMs: 0,
    })
    await ledger.append({
      type: 'task.outcome', sessionId: 's1', status: 'completed', totalUsage: UNKNOWN_USAGE, requestCount: 2,
      toolCallCount: 1, turns: 1, toolsUsed: ['bash'], checks: [{ name: 'file-exists', passed: true }],
    })
    const ids = (records: LedgerRecord[]) => records.map(record => record.ts.slice(5, 10))
    expect(ids(await collect(ledger.read()))).toEqual(['09-10', '10-01', '10-02', '10-03', '11-05'])
    expect(ids(await collect(ledger.read({ from: '2026-10-01T00:00:00.000Z', to: '2026-10-02T00:00:00.000Z' })))).toEqual([
      '10-01',
      '10-02',
    ])
    expect(ids(await collect(ledger.read({ from: '2026-10-02T12:00:00.000Z' })))).toEqual(['10-03', '11-05'])
    expect(ids(await collect(ledger.read({ to: '2026-09-30T00:00:00.000Z' })))).toEqual(['09-10'])
    expect(ids(await collect(ledger.read({ types: ['llm.request.start'] })))).toEqual(['09-10', '10-02'])
    expect(ids(await collect(ledger.read({ sessionId: 's2' })))).toEqual(['10-02', '10-03'])
    expect(ids(await collect(ledger.read({ sessionId: 's2', types: ['tool.call'] })))).toEqual(['10-03'])
  })

  it('tolerates a torn last line, and a later append still lands on its own line', async () => {
    const root = await tempDir()
    const ledger = new JsonlLedger({ layout: resolveWorkspaceLayout(root), now: clock('2026-10-07T08:00:00.000Z') })
    await ledger.append(start('r1'))
    const file = ledger.fileFor('2026-10-07T08:00:00.000Z')
    await appendFile(file, '{"type":"llm.request.end","ts":"2026-10')
    expect((await collect(ledger.read())).map(record => record.type)).toEqual(['llm.request.start'])
    await ledger.append(end('r1'))
    const records = await collect(ledger.read())
    expect(records.map(record => record.type)).toEqual(['llm.request.start', 'llm.request.end'])
    expect(ledger.skippedRecords).toBe(1) // the torn fragment, now a complete but invalid line
  })

  it('skips unknown types and invalid lines instead of failing the read', async () => {
    const root = await tempDir()
    const ledger = new JsonlLedger({ layout: resolveWorkspaceLayout(root), now: clock('2026-10-07T08:00:00.000Z') })
    await ledger.append(start('r1'))
    const file = ledger.fileFor('2026-10-07T08:00:00.000Z')
    await appendFile(file, '{"type":"llm.request.retry","ts":"2026-10-07T08:00:00.000Z"}\nnot json\n')
    await ledger.append(end('r1'))
    expect((await collect(ledger.read())).map(record => record.type)).toEqual(['llm.request.start', 'llm.request.end'])
    expect(ledger.skippedRecords).toBe(2)
  })

  it('a write failure rejects ledger/write-failed and increments writeFailures', async () => {
    const root = await tempDir()
    const blocker = join(root, 'not-a-dir')
    await writeFile(blocker, 'x')
    const ledger = new JsonlLedger({ ledgersDir: blocker, now: clock('2026-10-07T08:00:00.000Z') })
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        await ledger.append(start('r1'))
        expect.unreachable()
      } catch (error) {
        expect(isNexgentError(error, 'ledger/write-failed')).toBe(true)
      }
      expect(ledger.writeFailures).toBe(attempt)
    }
  })

  it('rejects records with unknown fields or bad shapes (ledger/invalid-record), not counted as write failures', async () => {
    const root = await tempDir()
    const ledger = new JsonlLedger({ layout: resolveWorkspaceLayout(root) })
    const bad: unknown[] = [
      { ...start('r1'), prompt: 'secret prompt text' },
      { ...start('r1'), purpose: 'fun' },
      { ...end('r1'), usage: { inputTokens: 0 } },
      { type: 'llm.request.retry' },
      { ...start('r1'), model: undefined },
    ]
    for (const record of bad) {
      try {
        await ledger.append(record as LedgerRecordInput)
        expect.unreachable()
      } catch (error) {
        expect(isNexgentError(error, 'ledger/invalid-record')).toBe(true)
      }
    }
    expect(ledger.writeFailures).toBe(0)
    expect(await collect(ledger.read())).toEqual([])
  })

  it('serializes concurrent appends into whole lines', async () => {
    const root = await tempDir()
    const ledger = new JsonlLedger({ layout: resolveWorkspaceLayout(root), now: () => new Date('2026-10-07T08:00:00.000Z') })
    await Promise.all(Array.from({ length: 50 }, (_, index) => ledger.append(start(`r${index}`))))
    const records = await collect(ledger.read())
    expect(records).toHaveLength(50)
    expect(records.map(record => (record as { requestId: string }).requestId)).toEqual(
      Array.from({ length: 50 }, (_, index) => `r${index}`),
    )
  })
})
