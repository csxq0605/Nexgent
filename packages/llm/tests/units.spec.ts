import { describe, expect, it } from 'vitest'
import { UNKNOWN_USAGE } from '@nexgent/kernel'
import { buildMessageParams, mapStopReason, normalizeUsage, redactSecrets, sanitizeUrl, thinkingParam, toWireMessages } from '../src/index.js'
import { makeRequest } from './helpers/stream.js'

describe('normalizeUsage', () => {
  it('merges message_start and message_delta usage and sums the total', () => {
    expect(normalizeUsage(
      { input_tokens: 100, cache_read_input_tokens: 40, cache_creation_input_tokens: 7, output_tokens: 1 },
      { output_tokens: 20 },
    )).toEqual({ inputTokens: 100, outputTokens: 20, totalTokens: 160, cacheReadTokens: 40, reasoningTokens: 'unknown' })
  })

  it('marks every unreported count unknown, never 0', () => {
    expect(normalizeUsage({ input_tokens: 10 }, undefined)).toEqual({
      inputTokens: 10, outputTokens: 'unknown', totalTokens: 'unknown', cacheReadTokens: 'unknown', reasoningTokens: 'unknown',
    })
    expect(normalizeUsage(undefined, undefined)).toEqual(UNKNOWN_USAGE)
    expect(normalizeUsage({ input_tokens: -1, output_tokens: 1.5, cache_read_input_tokens: null }, undefined))
      .toMatchObject({ inputTokens: 'unknown', outputTokens: 'unknown', cacheReadTokens: 'unknown' })
  })
})

describe('stop reasons and thinking', () => {
  it('maps stop reasons', () => {
    expect(mapStopReason('end_turn')).toBe('stop')
    expect(mapStopReason('tool_use')).toBe('tool-calls')
    expect(mapStopReason('max_tokens')).toBe('max-tokens')
    expect(mapStopReason('model_context_window_exceeded')).toBe('max-tokens')
    expect(mapStopReason('refusal')).toBe('refusal')
    expect(mapStopReason('stop_sequence')).toBe('stop')
    expect(mapStopReason('pause_turn')).toBe('stop')
    expect(mapStopReason('whatever')).toBe('stop')
  })

  it('maps thinking mode and effort to the thinking parameter', () => {
    expect(thinkingParam('off', 'low')).toEqual({ type: 'between_tools' })
    expect(thinkingParam('off', 'high')).toEqual({ type: 'between_tools' })
    expect(thinkingParam('off', 'xhigh')).toBeUndefined()
    expect(thinkingParam('off', 'max')).toBeUndefined()
    expect(thinkingParam('on', 'low')).toEqual({ type: 'adaptive', display: 'summarized' })
  })
})

describe('buildMessageParams', () => {
  it('builds the request shape with defaults and no sampling parameters', () => {
    const params = buildMessageParams(makeRequest({ temperature: 0.1 }), 'claude-sonnet-5-5')
    expect(params).toEqual({
      model: 'claude-sonnet-5-5',
      max_tokens: 16000,
      system: 'You are a test.',
      messages: [{ role: 'user', content: 'Say hello.' }],
      thinking: { type: 'between_tools' },
      output_config: { effort: 'medium' },
      cache_control: { type: 'ephemeral' },
    })
  })

  it('keeps message order and drops nothing', () => {
    const { system, messages } = toWireMessages([
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' },
    ])
    expect(system).toBeUndefined()
    expect(messages.map(message => message.role)).toEqual(['user', 'assistant', 'user'])
  })
})

describe('redaction', () => {
  it('removes the key, bearer tokens, x-api-key values and sk- shaped secrets', () => {
    const out = redactSecrets('key=abcd1234efgh Authorization: Bearer xyz.123 x-api-key: hunter22 and sk-ant-livekey123456', ['abcd1234efgh'])
    expect(out).toBe('key=[REDACTED] Authorization: Bearer [REDACTED] x-api-key: [REDACTED] and [REDACTED]')
  })

  it('sanitizes URLs', () => {
    expect(sanitizeUrl('https://u:p@example.com/v1/?key=1#x')).toBe('https://example.com/v1')
    expect(sanitizeUrl('not a url')).toBe('[REDACTED]')
  })
})
