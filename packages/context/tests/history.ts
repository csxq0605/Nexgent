import type { JsonValue } from '@nexgent/kernel'
import type { HistoryMessage } from '../src/index.js'

/** A thinking block as the Claude provider stores it in `providerContent`. */
export function thinkingBlocks(tag: string, text = ''): JsonValue[] {
  return [
    { type: 'thinking', thinking: `secret reasoning ${tag}`, signature: `sig-${tag}` },
    ...(text === '' ? [] : [{ type: 'text', text }]),
  ]
}

/**
 * One complete turn: injected context (optional), the user message, a
 * thinking reply with a tool call, its result, and a final thinking reply.
 */
export function turn(n: number, options: { inject?: string } = {}): HistoryMessage[] {
  return [
    ...(options.inject === undefined ? [] : [{ role: 'user', content: options.inject } as const]),
    { role: 'user', content: `request ${n}` },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: `call_${n}`, name: 'read_file', arguments: `{"path":"file-${n}.txt"}` }],
      providerContent: thinkingBlocks(`${n}a`),
    },
    { role: 'tool', toolCallId: `call_${n}`, name: 'read_file', content: `contents of file ${n}`, isError: false },
    { role: 'assistant', content: `answer ${n}`, providerContent: thinkingBlocks(`${n}b`, `answer ${n}`) },
  ]
}
