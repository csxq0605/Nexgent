import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { LEDGER_RECORD_TYPES, UNKNOWN_USAGE, type LedgerRecord, type LLMRequestEndRecord } from '@nexgent/kernel'
import { closedPort, loadSseFixture, startFakeOpenAI, type FakeOpenAI, type FakeReply } from './helpers/fake-openai.js'
import { validate } from './helpers/json-schema.js'
import { collect, makeProvider, makeRequest } from './helpers/stream.js'
import type { MemoryLedger } from './helpers/fakes.js'

const schema = JSON.parse(readFileSync(fileURLToPath(new URL('../schema/ledger.v1.schema.json', import.meta.url)), 'utf8')) as Record<string, unknown>
const spec = readFileSync(fileURLToPath(new URL('../../../docs/spec/data-formats.md', import.meta.url)), 'utf8').replace(/\r\n/g, '\n')

/** The example JSONL block of the spec's 账本记录 section. */
function specExampleLines(): unknown[] {
  const section = spec.slice(spec.indexOf('## 账本记录'))
  const block = /```jsonl\n([\s\S]*?)```/.exec(section)?.[1]
  expect(block).toBeDefined()
  return (block ?? '').split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line) as unknown)
}

let fake: FakeOpenAI | undefined
afterEach(async () => {
  await fake?.close()
  fake = undefined
})

async function recordsFor(reply: FakeReply | 'refused' | 'abort', options: { timeoutMs?: number } = {}): Promise<LedgerRecord[]> {
  let endpoint: string
  if (reply === 'refused') {
    endpoint = `http://127.0.0.1:${await closedPort()}/v1`
  } else {
    fake = await startFakeOpenAI([reply === 'abort' ? { sse: loadSseFixture('text'), hangAfter: 2 } : reply])
    endpoint = fake.baseUrl
  }
  const { provider, ledger } = makeProvider(endpoint, options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs })
  const controller = new AbortController()
  for await (const event of provider.complete(makeRequest({ signal: controller.signal }), { sessionId: 'sess-schema' })) {
    if (reply === 'abort' && event.type === 'text.delta') controller.abort()
  }
  await fake?.close()
  fake = undefined
  return (ledger as MemoryLedger).records
}

describe('ledger.v1.schema.json', () => {
  it('covers every contract record type', () => {
    const defs = schema['$defs'] as Record<string, Record<string, unknown>>
    const consts = Object.values(defs).flatMap(def => {
      const allOf = def['allOf'] as Record<string, unknown>[] | undefined
      return (allOf ?? []).flatMap(part => {
        const type = (part['properties'] as Record<string, Record<string, unknown>> | undefined)?.['type']
        return typeof type?.['const'] === 'string' ? [type['const']] : []
      })
    })
    expect(consts.sort()).toEqual([...LEDGER_RECORD_TYPES].sort())
  })

  it('accepts every example line of the spec', () => {
    const lines = specExampleLines()
    expect(lines.length).toBeGreaterThanOrEqual(6)
    for (const line of lines) expect(validate(schema, line)).toEqual([])
  })

  it('rejects malformed records and tolerates unknown optional fields', () => {
    const [start, end] = specExampleLines() as Record<string, unknown>[]
    expect(validate(schema, { ...start, futureField: 1 })).toEqual([])
    expect(validate(schema, { ...end, usage: { inputTokens: 1 } })).not.toEqual([])
    expect(validate(schema, { ...end, usage: { ...UNKNOWN_USAGE, outputTokens: -1 } })).not.toEqual([])
    expect(validate(schema, { ...start, endpoint: 'https://user:pw@example.com/v1' })).not.toEqual([])
    expect(validate(schema, { ...start, thinking: 'maybe' })).not.toEqual([])
    expect(validate(schema, { ...start, type: 'llm.request.middle' })).not.toEqual([])
    const { ts: _ts, ...noTs } = start ?? {}
    expect(validate(schema, noTs)).not.toEqual([])
  })
})

describe('records written by the provider (必产生记录的失败路径)', { timeout: 15_000 }, () => {
  const cases: [string, FakeReply | 'refused' | 'abort', Partial<LLMRequestEndRecord>, { timeoutMs?: number }][] = [
    ['success', { sse: loadSseFixture('text') }, { status: 'ok', httpStatus: 200, finishReason: 'stop' }, {}],
    ['network down', 'refused', { status: 'error', errorCode: 'llm/request-failed', usage: UNKNOWN_USAGE }, {}],
    ['timeout', { hangBeforeHeaders: true }, { status: 'error', errorCode: 'llm/timeout', usage: UNKNOWN_USAGE }, { timeoutMs: 100 }],
    ['HTTP 4xx', { status: 404, body: '{}' }, { status: 'error', httpStatus: 404, errorCode: 'llm/request-failed', usage: UNKNOWN_USAGE }, {}],
    ['HTTP 5xx', { status: 500, body: '{}' }, { status: 'error', httpStatus: 500, errorCode: 'llm/request-failed', usage: UNKNOWN_USAGE }, {}],
    ['abort', 'abort', { status: 'aborted', finishReason: 'aborted', usage: UNKNOWN_USAGE }, {}],
  ]

  it.each(cases)('%s → exactly one valid start/end pair', async (_name, reply, expected, options) => {
    const records = await recordsFor(reply, options)
    expect(records.map(record => record.type)).toEqual(['llm.request.start', 'llm.request.end'])
    for (const record of records) {
      expect(validate(schema, JSON.parse(JSON.stringify(record)))).toEqual([])
      expect(record.sessionId).toBe('sess-schema')
    }
    const [start, end] = records as [LedgerRecord & { requestId: string }, LLMRequestEndRecord]
    expect(end.requestId).toBe(start.requestId)
    expect(end).toMatchObject(expected)
    if (reply === 'refused' || (typeof reply === 'object' && reply.hangBeforeHeaders === true)) expect(end).not.toHaveProperty('httpStatus')
    if (end.status !== 'error') expect(end).not.toHaveProperty('errorCode')
    if (end.status === 'error') expect(end).not.toHaveProperty('finishReason')
  })
})
