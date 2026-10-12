/**
 * Preserved thinking when the tool list changes mid-turn (step 4:
 * `capability_try` registers a tool between two requests of one turn). The
 * fake below runs the API's conversation check the way Claude Sonnet 5.5
 * does: a thinking block is signed for the `system` and `tools` it was
 * created with; replaying it under different ones is HTTP 400 unless the
 * request sets `thinking.block_binding.prefix_mismatch_behavior:
 * 'drop_block'`, in which case the block is dropped and reported.
 */
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { DoneEvent, LLMMessage, LLMToolDefinition } from '@nexgent/kernel'
import { THINKING_BINDING_BETA } from '../src/index.js'
import { sseEvent, startFakeAnthropic, type CapturedRequest, type FakeAnthropic, type FakeReply } from './helpers/fake-anthropic.js'
import { collect, expectStreamInvariants, makeProvider, makeRequest, textOf } from './helpers/stream.js'

let fake: FakeAnthropic | undefined
afterEach(async () => {
  await fake?.close()
  fake = undefined
})

const READ: LLMToolDefinition = {
  name: 'read_file', description: 'Read a file.', parameters: { type: 'object', properties: { path: { type: 'string' } } }
}
const TRY: LLMToolDefinition = {
  name: 'capability_try', description: 'Try a draft component.', parameters: { type: 'object', properties: {} }
}
const DRAFT: LLMToolDefinition = {
  name: 'cap_orders-summary_summarize_orders', description: 'Summarize orders.', parameters: { type: 'object', properties: {} }
}

/** What a signature binds: the request's system prompt and tool list. */
function bindingOf(body: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify([body['system'] ?? null, body['tools'] ?? []])).digest('hex').slice(0, 16)
}

type Block = { type: string; signature?: string }

/** Replayed thinking blocks whose binding differs from this request's, as `messages.i.content.j` paths. */
function mismatches(body: Record<string, unknown>): string[] {
  const now = bindingOf(body)
  const paths: string[] = []
  for (const [i, message] of (body['messages'] as { role: string; content: unknown }[]).entries()) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue
    for (const [j, block] of (message.content as Block[]).entries()) {
      if (block.type === 'thinking' && block.signature !== `sig:${now}`) paths.push(`messages.${i}.content.${j}`)
    }
  }
  return paths
}

/** One streamed reply: a signed thinking block, then a tool call (or a text answer). */
function reply(request: CapturedRequest, call?: { id: string; name: string }): FakeReply {
  const body = request.body
  const failing = mismatches(body)
  const thinking = body['thinking'] as { block_binding?: { prefix_mismatch_behavior?: string } } | undefined
  const drop = thinking?.block_binding?.prefix_mismatch_behavior === 'drop_block' && String(request.headers['anthropic-beta'] ?? '').split(',').includes(THINKING_BINDING_BETA)
  if (failing.length > 0 && !drop) {
    return {
      status: 400,
      body: JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: `${failing[0]}: Invalid \`signature\` in \`thinking\` block. The block is bound to a different conversation.` } }),
    }
  }
  const sse = [
    sseEvent({ type: 'message_start', message: { id: 'msg', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } }),
    sseEvent({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }),
    sseEvent({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Plan.' } }),
    sseEvent({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: `sig:${bindingOf(body)}` } }),
    sseEvent({ type: 'content_block_stop', index: 0 }),
    ...call === undefined
      ? [
          sseEvent({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
          sseEvent({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Done.' } }),
        ]
      : [
          sseEvent({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} } }),
          sseEvent({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } }),
        ],
    sseEvent({ type: 'content_block_stop', index: 1 }),
    sseEvent({ type: 'message_delta', delta: { stop_reason: call === undefined ? 'end_turn' : 'tool_use' }, usage: { output_tokens: 5 } }),
    sseEvent({ type: 'message_stop' }),
  ]
  return { sse }
}

const doneOf = (events: Awaited<ReturnType<typeof collect>>): DoneEvent => events.at(-1) as DoneEvent

describe('preserved thinking across a mid-turn tool change', () => {
  it('replays the earlier thinking blocks verbatim and asks the API to drop, not reject, the ones the new tool list invalidates', async () => {
    fake = await startFakeAnthropic((index, request) => {
      if (index === 0) return reply(request, { id: 'toolu_1', name: 'capability_try' })
      if (index === 1) return reply(request, { id: 'toolu_2', name: DRAFT.name })
      return reply(request)
    })
    const { provider } = makeProvider(fake.baseUrl)
    const history: LLMMessage[] = [
      { role: 'system', content: 'You are a test.' },
      { role: 'user', content: 'Summarize the orders.' },
    ]
    const step = async (tools: readonly LLMToolDefinition[], result: { id: string; name: string; content: string } | undefined) => {
      const events = await collect(provider.complete(makeRequest({ messages: history, tools })))
      expectStreamInvariants(events)
      const done = doneOf(events)
      expect(done.type).toBe('done')
      const calls = events.flatMap(event => event.type === 'tool-call.end' ? [event.call] : [])
      history.push({ role: 'assistant', content: textOf(events), ...calls.length > 0 ? { toolCalls: calls } : {}, providerContent: done.providerContent! })
      if (result !== undefined) history.push({ role: 'tool', toolCallId: result.id, name: result.name, content: result.content, isError: false })
      return done
    }

    // Step 1 calls capability_try; the try registers the draft's tool, so step 2 has one more tool.
    await step([READ, TRY], { id: 'toolu_1', name: 'capability_try', content: 'draft attached' })
    await step([READ, TRY, DRAFT], { id: 'toolu_2', name: DRAFT.name, content: '3 orders' })
    const last = await step([READ, TRY, DRAFT], undefined)
    expect(last.finishReason).toBe('stop')

    expect(fake.requests).toHaveLength(3)
    const [, second, third] = fake.requests
    // The replay itself is unchanged: the step-1 block goes back verbatim, signature included.
    const firstBlocks = (history[2] as unknown as { providerContent: Block[] }).providerContent
    expect(firstBlocks[0]).toEqual({ type: 'thinking', thinking: 'Plan.', signature: `sig:${bindingOf(fake.requests[0]!.body)}` })
    expect((second!.body['messages'] as { content: unknown }[])[1]!.content).toEqual(firstBlocks)
    expect((third!.body['messages'] as { content: unknown }[])[1]!.content).toEqual(firstBlocks)
    // Both later requests carry a block that fails the check (it was signed for the old tool list) ...
    expect(mismatches(second!.body)).toEqual(['messages.1.content.0'])
    expect(mismatches(third!.body)).toEqual(['messages.1.content.0'])
    // ... and both ask the API to drop such blocks instead of failing with 400.
    for (const request of fake.requests) {
      expect(request.headers['anthropic-beta']).toBe(THINKING_BINDING_BETA)
      expect(request.body['thinking']).toEqual({ type: 'adaptive', display: 'summarized', block_binding: { prefix_mismatch_behavior: 'drop_block' } })
    }
  })

  it('leaves between_tools (thinking off) without block_binding, which that mode rejects', async () => {
    fake = await startFakeAnthropic((_index, request) => reply(request))
    const { provider } = makeProvider(fake.baseUrl)
    await collect(provider.complete(makeRequest({ thinking: 'off', tools: [READ] })))
    expect(fake.requests[0]?.body['thinking']).toEqual({ type: 'between_tools' })
    expect(fake.requests[0]?.headers['anthropic-beta']).toBeUndefined()
  })
})
