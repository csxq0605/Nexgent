import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ZERO_USAGE, type CompactionCheckInput, type Credentials, type LedgerRecord } from '@nexgent/kernel'
import { createProvider } from '@nexgent/llm'
import { JsonlLedger } from '@nexgent/session'
import { scriptedModelServer, type ScriptedModelServer } from '@nexgent/test-support'
import { BasicCompactor } from '../src/index.js'
import { SESSION_ID, tempDir } from './helpers.js'
import { turn } from './history.js'

const credentials: Credentials = {
  async get(name) { return name === 'NEXGENT_API_KEY' ? 'test-key-not-secret' : undefined },
  async describe(name) { return name === 'NEXGENT_API_KEY' ? { configured: true, source: 'env' } : { configured: false } },
}

let server: ScriptedModelServer | undefined
afterEach(async () => {
  await server?.close()
  server = undefined
})

describe('compaction through the real model route', () => {
  it('records the summary request in the ledger as auxiliary, whether it fails or succeeds', async () => {
    const root = await tempDir()
    server = await scriptedModelServer({
      script: [
        { fault: { kind: 'http-error', status: 500 } },
        { reasoning: 'considering', content: '## User requests\n- request 1', usage: { inputTokens: 700, outputTokens: 40 } },
      ],
    })
    const ledger = new JsonlLedger({ ledgersDir: join(root, 'ledgers') })
    const llm = createProvider({ credentials, ledger, endpoint: server.baseUrl, env: {} })
    const compactor = new BasicCompactor({ llm, thresholdTokens: 100, settings: { thinking: 'on' }, env: {} })
    const messages = [...turn(1), ...turn(2), ...turn(3).slice(0, 2)]
    const input: CompactionCheckInput = {
      sessionId: SESSION_ID, turn: 3, step: 1, model: 'claude-sonnet-5-5', messages, failedThisTurn: false,
      lastUsage: { ...ZERO_USAGE, inputTokens: 150 },
    }

    expect(compactor.shouldCompact(input)).toBe(true)
    await expect(compactor.compact(input, new AbortController().signal)).rejects.toMatchObject({ code: 'llm/request-failed' })
    // The loop passes failedThisTurn after a failure: no second attempt in the same turn.
    expect(compactor.shouldCompact({ ...input, failedThisTurn: true })).toBe(false)
    const result = await compactor.compact({ ...input, turn: 4 }, new AbortController().signal)
    expect(result.summary).toBe('## User requests\n- request 1')

    const records: LedgerRecord[] = []
    for await (const record of ledger.read({ sessionId: SESSION_ID })) records.push(record)
    expect(records.map(record => record.type)).toEqual(['llm.request.start', 'llm.request.end', 'llm.request.start', 'llm.request.end'])
    expect(records[0]).toMatchObject({ purpose: 'auxiliary', thinking: 'on', model: 'claude-sonnet-5-5' })
    expect(records[1]).toMatchObject({ status: 'error', httpStatus: 500 })
    expect(records[2]).toMatchObject({ purpose: 'auxiliary', requestId: result.requestId })
    expect(records[3]).toMatchObject({ status: 'ok', requestId: result.requestId, usage: { inputTokens: 700, outputTokens: 40 } })

    // On the wire: no tools, adaptive thinking, and no thinking blocks of the summarized replies.
    const body = server.requests[1]!.body as Record<string, unknown>
    expect(body['tools']).toBeUndefined()
    expect(body['thinking']).toMatchObject({ type: 'adaptive' })
    expect(JSON.stringify(body)).not.toContain('secret reasoning')
  })
})
