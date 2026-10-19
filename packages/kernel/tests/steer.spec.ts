/**
 * New direction step 1: what the user says while a turn runs reaches the
 * turn's next model request (and the members working now); a compaction
 * keeps the user's own words verbatim.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  relayedUserNote,
  renderCompactionSummary,
  renderUserWords,
  USER_WORDS_HEADING,
  type Agent,
  type CompactionCheckInput,
  type CompactionResult,
  type ContextService,
  type KernelToolContext,
  type LLMRequest,
  type LLMStreamEvent,
  type Tool,
} from '../src/index.js'
import { conversation, servicePlugin, textReply, toolCallReply, usage } from './helpers/fakes.js'
import { bootHarness, type Harness } from './helpers/harness.js'

let harness: Harness | undefined
afterEach(async () => {
  await harness?.dispose()
  harness = undefined
})

const echo: Tool = {
  definition: { name: 'echo', description: 'Echo.', inputSchema: { type: 'object', properties: {} }, effects: ['read'], approval: 'never' },
  handler: async () => ({ content: 'echoed' }),
}

/** A scripted reply that first runs `before` (while the request is in flight). */
function during(before: () => void, events: LLMStreamEvent[]): (request: LLMRequest) => AsyncIterable<LLMStreamEvent> {
  return async function* () {
    before()
    yield* events
  }
}

describe('messages sent while a turn runs', () => {
  it('go out with the next request, and the turn goes on until they are answered', async () => {
    let agent: Agent | undefined
    const accepted: boolean[] = []
    harness = await bootHarness({
      script: [
        during(() => accepted.push(agent!.steer('also add a header')), toolCallReply('c1', 'echo', {})),
        during(() => accepted.push(agent!.steer('and keep it short')), textReply('added')),
        textReply('short now'),
      ],
    })
    const { app, llm, store } = harness
    app.ctx.tools.register(echo)
    agent = await app.agents.create()
    const result = await agent.run('write the report')
    expect(accepted).toEqual([true, true])
    expect(result).toMatchObject({ turn: 1, reason: { kind: 'completed' }, text: 'short now' })
    expect(conversation(llm.requests[1]!).map(message => message.role)).toEqual(['user', 'assistant', 'tool', 'user'])
    expect(conversation(llm.requests[1]!).at(-1)).toEqual({ role: 'user', content: 'also add a header' })
    // A reply without tool calls does not end the turn while a message waits.
    expect(llm.requests).toHaveLength(3)
    expect(conversation(llm.requests[2]!).at(-1)).toEqual({ role: 'user', content: 'and keep it short' })
    expect(store.of(agent.sessionId, 'user.message').map(record => [record.turn, record.source, record.content])).toEqual([
      [1, 'user', 'write the report'], [1, 'user', 'also add a header'], [1, 'user', 'and keep it short'],
    ])
    // No turn runs: the caller starts a new one.
    expect(agent.steer('late')).toBe(false)
    await agent.close()
  })

  it('reach the members working now', async () => {
    let root: Agent | undefined
    harness = await bootHarness({
      script: [
        toolCallReply('c1', 'delegate', {}),
        during(() => root!.steer('use metric units'), textReply('measured')),
        textReply('measured in metres'),
        textReply('done'),
      ],
    })
    const { app, llm, store } = harness
    let child: Agent | undefined
    app.ctx.tools.register({
      definition: { name: 'delegate', description: 'Delegate.', inputSchema: { type: 'object', properties: {} }, effects: ['read'], approval: 'never' },
      handler: async (_input, context) => {
        const ctx = context as KernelToolContext
        child = await app.agents.create({ child: { parentSessionId: ctx.sessionId, member: { name: 'helper', executionForm: 'delegated' } } })
        const result = await child.run('measure the room', { signal: context.signal })
        await child.close()
        return { content: result.text }
      },
    })
    root = await app.agents.create()
    expect((await root.run('plan the room')).reason).toEqual({ kind: 'completed' })
    // The member's next request carries the relayed message; the root's next request carries it as the user's own.
    expect(conversation(llm.requests[2]!).at(-1)).toEqual({ role: 'user', content: relayedUserNote('use metric units') })
    expect(store.of(child!.sessionId, 'user.message').at(-1)).toMatchObject({ source: 'inject', content: relayedUserNote('use metric units') })
    expect(conversation(llm.requests[3]!).slice(-2)).toEqual([
      { role: 'tool', toolCallId: 'c1', name: 'delegate', content: 'measured in metres', isError: false },
      { role: 'user', content: 'use metric units' },
    ])
    await root.close()
  })
})

describe("the user's own words through a compaction", () => {
  it('are kept verbatim after the summary, except those still in the kept tail', async () => {
    harness = await bootHarness({ script: [textReply('ok'), textReply('fine'), textReply('done')] })
    const { app, llm, store } = harness
    const compactor = {
      shouldCompact: (input: CompactionCheckInput) => input.turn === 3,
      async compact(input: CompactionCheckInput): Promise<CompactionResult> {
        return { summary: 'The user wants a report.', keepMessages: 1, compactedMessages: input.messages.length - 1, requestId: 'aux', usage: usage(5, 5), trigger: { inputTokens: 0, threshold: 1 } }
      },
    }
    await app.ctx.plugin(servicePlugin('context', { providers: [], register: () => () => undefined, compactor } satisfies ContextService))
    const agent = await app.agents.create()
    await agent.run('Indent with tabs, never spaces.\nAnd name files in lower case.')
    await agent.run('Now the summary table.')
    await agent.run('Go on.')
    const summary = 'The user wants a report.' + renderUserWords([
      { turn: 1, text: 'Indent with tabs, never spaces.\nAnd name files in lower case.' },
      { turn: 2, text: 'Now the summary table.' },
    ])
    expect(summary).toContain(USER_WORDS_HEADING)
    expect(store.of(agent.sessionId, 'compaction')[0]).toMatchObject({ turn: 3, summary })
    expect(conversation(llm.requests[2]!)).toEqual([
      { role: 'user', content: renderCompactionSummary(summary) },
      { role: 'user', content: 'Go on.' },
    ])
    const before = agent.history()
    await agent.close()
    const resumed = await app.agents.resume(agent.sessionId)
    expect(resumed.history()).toEqual(before)
    await resumed.close()
  })

  it('keep the newest when they are too long', () => {
    const text = renderUserWords([{ turn: 1, text: 'a'.repeat(10) }, { turn: 2, text: 'b'.repeat(10) }, { turn: 3, text: 'c'.repeat(5) }], 12)
    expect(text).toContain('(1 older message left out for length.)')
    expect(text).toContain(`[turn 2]\n…${'b'.repeat(7)}`)
    expect(text).toContain(`[turn 3]\n${'c'.repeat(5)}`)
    expect(text).not.toContain('[turn 1]')
    expect(renderUserWords([])).toBe('')
  })
})
