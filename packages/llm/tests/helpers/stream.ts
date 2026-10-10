/** Helpers for consuming and checking provider streams in tests. */
import { randomUUID } from 'node:crypto'
import { expect } from 'vitest'
import {
  isTerminalEvent,
  NEXGENT_API_KEY,
  type LLMRequest,
  type LLMStreamEvent,
} from '@nexgent/kernel'
import { createProvider, type AnthropicProviderOptions } from '../../src/index.js'
import { memoryCredentials, MemoryLedger } from './fakes.js'

/** The fake API key used throughout; must never appear in output. */
export const TEST_KEY = 'sk-ant-nexgent-test-0123456789abcdef'

/** Drain a stream into an array. */
export async function collect(stream: AsyncIterable<LLMStreamEvent>): Promise<LLMStreamEvent[]> {
  const events: LLMStreamEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}

/** A minimal request. */
export function makeRequest(overrides: Partial<LLMRequest> = {}): LLMRequest {
  return {
    requestId: randomUUID(),
    model: 'claude-sonnet-5-5',
    messages: [
      { role: 'system', content: 'You are a test.' },
      { role: 'user', content: 'Say hello.' },
    ],
    thinking: 'off',
    ...overrides,
  }
}

/** A provider wired to a memory ledger and the test key, with an empty env. */
export function makeProvider(endpoint: string, overrides: Partial<AnthropicProviderOptions> = {}) {
  const ledger = overrides.ledger instanceof MemoryLedger ? overrides.ledger : new MemoryLedger()
  const provider = createProvider({
    credentials: memoryCredentials({ [NEXGENT_API_KEY]: TEST_KEY }),
    endpoint,
    env: {},
    ...overrides,
    ledger: overrides.ledger ?? ledger,
  })
  return { provider, ledger }
}

/** Concatenated `text.delta` text. */
export function textOf(events: readonly LLMStreamEvent[]): string {
  return events.flatMap(event => event.type === 'text.delta' ? [event.text] : []).join('')
}

/** Assert the contract's stream invariants (llm.ts `LLMStreamEvent` doc). */
export function expectStreamInvariants(events: readonly LLMStreamEvent[]): void {
  const terminals = events.filter(isTerminalEvent)
  expect(terminals).toHaveLength(1)
  expect(isTerminalEvent(events[events.length - 1] as LLMStreamEvent)).toBe(true)
  expect(events.filter(event => event.type === 'usage').length).toBeLessThanOrEqual(1)
  const started = new Set<number>()
  const ended = new Set<number>()
  for (const event of events) {
    if (event.type === 'tool-call.start') {
      expect(started.has(event.index)).toBe(false)
      started.add(event.index)
    }
    if (event.type === 'tool-call.delta') {
      expect(started.has(event.index)).toBe(true)
      expect(ended.has(event.index)).toBe(false)
    }
    if (event.type === 'tool-call.end') {
      expect(started.has(event.index)).toBe(true)
      expect(ended.has(event.index)).toBe(false)
      ended.add(event.index)
    }
  }
  if (events[events.length - 1]?.type === 'done') expect([...ended].sort()).toEqual([...started].sort())
}
