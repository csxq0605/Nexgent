import { describe, expect, it } from 'vitest'
import { UNKNOWN_USAGE, type LLMStreamEvent } from '@nexgent/kernel'
import { ChunkAssembler, mapFinishReason, normalizeUsage, readSseData, redactSecrets, sanitizeUrl } from '../src/index.js'

async function* bytes(...parts: (string | Uint8Array)[]): AsyncGenerator<Uint8Array> {
  for (const part of parts) yield typeof part === 'string' ? new TextEncoder().encode(part) : part
}

async function sse(...parts: (string | Uint8Array)[]): Promise<string[]> {
  const out: string[] = []
  for await (const data of readSseData(bytes(...parts))) out.push(data)
  return out
}

describe('readSseData', () => {
  it('splits events across chunk boundaries and line-ending styles', async () => {
    expect(await sse('data: a\n\nda', 'ta: b\r\n\r\ndata: c\r', '\r', 'data: d\n')).toEqual(['a', 'b', 'c', 'd'])
  })

  it('joins multi-line data, ignores comments and other fields', async () => {
    expect(await sse(': keep-alive\n\nevent: x\nid: 1\ndata: one\ndata: two\n\ndata:nospace\n\n')).toEqual(['one\ntwo', 'nospace'])
  })

  it('reassembles a multi-byte character split between chunks', async () => {
    const encoded = new TextEncoder().encode('data: 你好\n\n')
    expect(await sse(encoded.slice(0, 7), encoded.slice(7))).toEqual(['你好'])
  })
})

describe('normalizeUsage', () => {
  it('subtracts cached input and keeps reasoning tokens', () => {
    expect(normalizeUsage({
      prompt_tokens: 100, completion_tokens: 20, total_tokens: 120,
      prompt_tokens_details: { cached_tokens: 40 }, completion_tokens_details: { reasoning_tokens: 3 },
    })).toEqual({ inputTokens: 60, outputTokens: 20, totalTokens: 120, cacheReadTokens: 40, reasoningTokens: 3 })
  })

  it('marks every unreported count unknown, never 0', () => {
    expect(normalizeUsage({ prompt_tokens: 10, completion_tokens: 2 })).toEqual({
      inputTokens: 10, outputTokens: 2, totalTokens: 'unknown', cacheReadTokens: 'unknown', reasoningTokens: 'unknown',
    })
    expect(normalizeUsage(null)).toEqual(UNKNOWN_USAGE)
    expect(normalizeUsage({ prompt_tokens: -1, completion_tokens: 1.5 })).toMatchObject({ inputTokens: 'unknown', outputTokens: 'unknown' })
  })
})

describe('ChunkAssembler', () => {
  it('maps finish reasons', () => {
    expect(mapFinishReason('stop')).toBe('stop')
    expect(mapFinishReason('tool_calls')).toBe('tool-calls')
    expect(mapFinishReason('function_call')).toBe('tool-calls')
    expect(mapFinishReason('length')).toBe('max-tokens')
    expect(mapFinishReason('content_filter')).toBe('stop')
  })

  it('emits reasoning deltas and buffers arguments until id and name are known', () => {
    const assembler = new ChunkAssembler()
    const events: LLMStreamEvent[] = [
      ...assembler.accept({ choices: [{ delta: { reasoning_content: 'hmm' } }] }),
      ...assembler.accept({ choices: [{ delta: { tool_calls: [{ index: 3, function: { arguments: '{"a"' } }] } }] }),
      ...assembler.accept({ choices: [{ delta: { tool_calls: [{ index: 3, id: 'c1', function: { name: 'f', arguments: ':1}' } }] } }] }),
      ...assembler.accept({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    ]
    expect(events).toEqual([
      { type: 'reasoning.delta', text: 'hmm' },
      { type: 'tool-call.start', index: 0, id: 'c1', name: 'f' },
      { type: 'tool-call.delta', index: 0, argumentsDelta: '{"a":1}' },
      { type: 'tool-call.end', index: 0, call: { id: 'c1', name: 'f', arguments: '{"a":1}' } },
    ])
    expect(assembler.finish).toBe('tool-calls')
  })

  it('rejects a tool call that never names its function', () => {
    const assembler = new ChunkAssembler()
    assembler.accept({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { arguments: '{}' } }] } }] })
    expect(() => assembler.closeCalls()).toThrow(expect.objectContaining({ code: 'llm/invalid-response' }))
  })
})

describe('redaction', () => {
  it('removes the key, bearer tokens and sk- shaped secrets', () => {
    const out = redactSecrets('key=abcd1234efgh Authorization: Bearer xyz.123 and sk-livekey123456', ['abcd1234efgh'])
    expect(out).toBe('key=[REDACTED] Authorization: Bearer [REDACTED] and [REDACTED]')
  })

  it('sanitizes URLs', () => {
    expect(sanitizeUrl('https://u:p@example.com/v1/?key=1#x')).toBe('https://example.com/v1')
    expect(sanitizeUrl('not a url')).toBe('[REDACTED]')
  })
})
