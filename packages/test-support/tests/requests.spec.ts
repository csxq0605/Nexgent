import { afterEach, describe, expect, it } from 'vitest'
import {
  compactionSummary,
  expectRequest,
  failCompaction,
  isAuxiliaryRequest,
  requestText,
  scriptedModelServer,
  type MessagesRequestBody,
  type ScriptedModelServer,
} from '../src/index.js'

const withTools: MessagesRequestBody = {
  system: [{ type: 'text', text: 'You are Nexgent.' }],
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'Summarise orders.csv' }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'row count 300' }] }] },
  ],
  tools: [{ name: 'read_file' }],
}
const summaryRequest: MessagesRequestBody = { system: 'Summarise the conversation.', messages: [{ role: 'user', content: 'history' }] }

describe('request-aware script entries', () => {
  let server: ScriptedModelServer | undefined
  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  it('requestText collects the system prompt, text blocks and tool results', () => {
    expect(requestText(withTools)).toBe('You are Nexgent.\nSummarise orders.csv\nrow count 300')
    expect(requestText(summaryRequest)).toBe('Summarise the conversation.\nhistory')
    expect(requestText(undefined)).toBe('')
  })

  it('a request without tools is the auxiliary (compaction summary) request', () => {
    expect(isAuxiliaryRequest(summaryRequest)).toBe(true)
    expect(isAuxiliaryRequest({ ...summaryRequest, tools: [] })).toBe(true)
    expect(isAuxiliaryRequest(withTools)).toBe(false)
  })

  it('expectRequest answers when the predicate holds and fails loudly (418) when it does not', () => {
    const entry = expectRequest('turn about orders', body => requestText(body).includes('orders'), { content: 'ok' })
    expect(entry(withTools, 0)).toEqual({ content: 'ok' })
    expect(entry(summaryRequest, 2)).toEqual({
      fault: { kind: 'http-error', status: 418, message: 'scripted server: request #3 is not the expected turn about orders' },
    })
  })

  it('failCompaction fails only the summary request; compactionSummary answers it', async () => {
    server = await scriptedModelServer({ script: [failCompaction(), compactionSummary('S'), failCompaction()] })
    const post = (body: MessagesRequestBody) => fetch(`${server!.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'k', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'm', max_tokens: 10, ...body }),
    })
    const failed = await post(summaryRequest)
    expect(failed.status).toBe(500)
    const answered = await post(summaryRequest)
    expect(answered.status).toBe(200)
    expect(((await answered.json()) as { content: Array<{ text?: string }> }).content[0]?.text).toBe('S')
    const offScript = await post(withTools)
    expect(offScript.status).toBe(418)
    expect(await offScript.text()).toContain('compaction summary request')
  })
})
