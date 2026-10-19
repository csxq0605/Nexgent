import { describe, expect, it } from 'vitest'
import { renderCompactionSummary, ZERO_USAGE, type CompactionCheckInput, type LLMUsage } from '@nexgent/kernel'
import { scriptedProvider } from '@nexgent/test-support'
import {
  applyCompaction,
  BasicCompactor,
  COMPACTION_THRESHOLD_ENV,
  DEFAULT_COMPACTION_THRESHOLD,
  planCompaction,
  renderTranscript,
  resolveCompactionThreshold,
  segmentStarts,
  SUMMARY_INSTRUCTION,
  SUMMARY_SYSTEM_PROMPT,
  type HistoryMessage,
} from '../src/index.js'
import { SESSION_ID } from './helpers.js'
import { turn } from './history.js'

const usage = (input: number, cacheRead = 0): LLMUsage => ({ ...ZERO_USAGE, inputTokens: input, cacheReadTokens: cacheRead })

function check(messages: readonly HistoryMessage[], overrides: Partial<CompactionCheckInput> = {}): CompactionCheckInput {
  return { sessionId: SESSION_ID, turn: 3, step: 2, model: 'claude-sonnet-5-5', messages, failedThisTurn: false, ...overrides }
}

/** Turns 1 and 2 complete, turn 3 in progress (user message + one tool round). */
function history(): HistoryMessage[] {
  return [...turn(1), ...turn(2, { inject: 'The user attached these materials.' }), ...turn(3).slice(0, 3)]
}

describe('compaction split', () => {
  it('finds turn boundaries: a run of user messages (injections + the user message) starts one segment', () => {
    const messages = history()
    expect(segmentStarts(messages)).toEqual([0, 4, 9])
    expect(messages[4]).toEqual({ role: 'user', content: 'The user attached these materials.' })
  })

  it('keeps the last two turns by default and the current turn whole', () => {
    const messages = history()
    expect(planCompaction(messages)).toEqual({ compactedMessages: 4, keepMessages: messages.length - 4 })
    expect(planCompaction(messages, 1)).toEqual({ compactedMessages: 9, keepMessages: messages.length - 9 })
    // The kept part starts with a user message, so no tool call is cut from its result.
    expect(messages[9]).toMatchObject({ role: 'user', content: 'request 3' })
  })

  it('keeps fewer turns when the configured number would leave nothing to summarize', () => {
    const two = [...turn(1), ...turn(2).slice(0, 2)]
    expect(planCompaction(two, 2)).toEqual({ compactedMessages: 4, keepMessages: 2 })
    expect(planCompaction(two, 5)).toEqual({ compactedMessages: 4, keepMessages: 2 })
  })

  it('does not compact the current turn alone, nor a previous summary on its own', () => {
    expect(planCompaction(turn(1))).toBeUndefined()
    const compacted = applyCompaction(history(), 'earlier work', history().length - 9)
    expect(segmentStarts(compacted)).toEqual([0, 1])
    expect(planCompaction(compacted)).toBeUndefined()
    // Once another turn completed after the summary, the summary and that turn are folded together.
    const later = [...compacted, ...turn(3).slice(3), ...turn(4).slice(0, 2)]
    expect(planCompaction(later, 1)).toEqual({ compactedMessages: later.length - 2, keepMessages: 2 })
  })

  it('applyCompaction builds exactly what the session projection builds', () => {
    const messages = history()
    const result = applyCompaction(messages, 'S', 6)
    expect(result).toEqual([{ role: 'user', content: renderCompactionSummary('S') }, ...messages.slice(-6)])
    expect(() => applyCompaction(messages, 'S', 0)).toThrow()
    expect(() => applyCompaction(messages, 'S', messages.length + 1)).toThrow()
  })
})

describe('compaction trigger', () => {
  const compactor = new BasicCompactor({ llm: scriptedProvider([]), thresholdTokens: 1000, env: {} })

  it('triggers on billed input (input + cache read + cache write) at or above the threshold', () => {
    expect(compactor.shouldCompact(check(history(), { lastUsage: usage(999) }))).toBe(false)
    expect(compactor.shouldCompact(check(history(), { lastUsage: usage(1000) }))).toBe(true)
    expect(compactor.shouldCompact(check(history(), { lastUsage: usage(400, 600) }))).toBe(true)
  })

  it('never triggers with unknown usage, no usage, after a failure in this turn, or with nothing to summarize', () => {
    expect(compactor.shouldCompact(check(history()))).toBe(false)
    expect(compactor.shouldCompact(check(history(), { lastUsage: { ...usage(5000), cacheWriteTokens: 'unknown' } }))).toBe(false)
    expect(compactor.shouldCompact(check(history(), { lastUsage: usage(5000), failedThisTurn: true }))).toBe(false)
    expect(compactor.shouldCompact(check(turn(1), { lastUsage: usage(5000) }))).toBe(false)
  })

  it('defaults to 160 000 tokens; NEXGENT_COMPACTION_THRESHOLD overrides the configured value; a bad value is a config error', () => {
    expect(resolveCompactionThreshold(undefined, {})).toBe(DEFAULT_COMPACTION_THRESHOLD)
    expect(DEFAULT_COMPACTION_THRESHOLD).toBe(160_000)
    expect(resolveCompactionThreshold(5000, {})).toBe(5000)
    expect(resolveCompactionThreshold(5000, { [COMPACTION_THRESHOLD_ENV]: '300' })).toBe(300)
    expect(new BasicCompactor({ llm: scriptedProvider([]), env: { [COMPACTION_THRESHOLD_ENV]: '42' } }).thresholdTokens).toBe(42)
    for (const bad of ['0', '-5', '1.5', 'abc']) {
      expect(() => resolveCompactionThreshold(undefined, { [COMPACTION_THRESHOLD_ENV]: bad })).toThrow(expect.objectContaining({ code: 'config/invalid' }))
    }
    expect(() => new BasicCompactor({ llm: scriptedProvider([]), keepRecentTurns: 0, env: {} })).toThrow(expect.objectContaining({ code: 'config/invalid' }))
  })
})

describe('compaction request', () => {
  it('sends one auxiliary request without tools: a transcript of the summarized part plus the fixed instruction, never the thinking blocks', async () => {
    const llm = scriptedProvider([{ reasoning: 'thinking about it', content: ['## User requests\n', '- request 1'], usage: { inputTokens: 900, outputTokens: 80 } }])
    const compactor = new BasicCompactor({ llm, thresholdTokens: 1000, settings: { thinking: 'on', effort: 'medium' }, env: {} })
    const messages = history()
    const result = await compactor.compact(check(messages, { lastUsage: usage(1500) }), new AbortController().signal)

    expect(result).toMatchObject({
      summary: '## User requests\n- request 1',
      keepMessages: messages.length - 4,
      compactedMessages: 4,
      trigger: { inputTokens: 1500, threshold: 1000 },
      usage: { inputTokens: 900, outputTokens: 80 },
    })
    llm.assertConsumed()
    const [call] = llm.calls
    expect(call!.options).toEqual({ sessionId: SESSION_ID, purpose: 'auxiliary' })
    expect(call!.request.requestId).toBe(result.requestId)
    expect(call!.request).toMatchObject({ model: 'claude-sonnet-5-5', thinking: 'on', effort: 'medium', maxTokens: 16000 })
    expect(call!.request.tools).toBeUndefined()
    expect(call!.request.messages.map(message => message.role)).toEqual(['system', 'user'])
    expect(call!.request.messages[0]!.content).toBe(SUMMARY_SYSTEM_PROMPT)
    const prompt = call!.request.messages[1]!.content
    expect(prompt).toBe(`<conversation>\n${renderTranscript(messages.slice(0, 4))}\n</conversation>\n\n${SUMMARY_INSTRUCTION}`)
    expect(prompt).toContain('[user]\nrequest 1')
    expect(prompt).toContain('[assistant called read_file]\n{"path":"file-1.txt"}')
    expect(prompt).toContain('[read_file result]\ncontents of file 1')
    expect(prompt).not.toContain('request 2')
    expect(prompt).not.toContain('secret reasoning')
    expect(prompt).not.toContain('sig-')
  })

  it('follows the project thinking setting (off) when configured that way', async () => {
    const llm = scriptedProvider([{ content: 'S' }])
    const compactor = new BasicCompactor({ llm, settings: async () => ({ thinking: 'off' }), env: {} })
    await compactor.compact(check(history(), { lastUsage: usage(1) }), new AbortController().signal)
    expect(llm.requests[0]!.thinking).toBe('off')
    expect(llm.requests[0]!.effort).toBeUndefined()
  })

  it('clips long tool arguments and results in the transcript and folds an earlier summary in as is', () => {
    const long = 'z'.repeat(20_000)
    const messages: HistoryMessage[] = [
      { role: 'user', content: renderCompactionSummary('older summary') },
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c', name: 'bash', arguments: long }] },
      { role: 'tool', toolCallId: 'c', name: 'bash', content: long, isError: true },
    ]
    const transcript = renderTranscript(messages, 1000)
    expect(transcript.startsWith(renderCompactionSummary('older summary'))).toBe(true)
    expect(transcript).toContain('[bash failed]')
    expect(transcript.length).toBeLessThan(3000)
    expect(transcript).toContain('characters omitted')
  })

  it('pins the instruction text (changes need a deliberate snapshot update)', () => {
    expect({ system: SUMMARY_SYSTEM_PROMPT, instruction: SUMMARY_INSTRUCTION }).toMatchInlineSnapshot(`
      {
        "instruction": "Summarize the conversation above into a checkpoint that lets the agent continue the work without the original messages.

      Use exactly these Markdown sections, in this order; write "(none)" for an empty section:

      ## User requests
      - what the user asked for, including later changes and feedback; quote exact wording where it matters

      ## Materials and files
      - project paths that were read, created or changed, and what each holds or why it matters

      ## Work done
      - results so far: deliverables presented (with ids and versions), commands run, checks passed or failed

      ## Errors and fixes
      - problems met and how they were resolved

      ## Open items
      - requested work not finished yet, and the next step

      ## Key facts
      - decisions, constraints, user preferences, exact identifiers, numbers and paths needed to continue

      Rules:
      - Keep exact file paths, identifiers, numbers and error messages.
      - If the conversation starts with an earlier <conversation-summary>, merge it: keep what is still true, drop what is stale.
      - Write only the checkpoint. Do not mention this request and do not call tools.",
        "system": "You write checkpoint summaries of conversations between a user and Nexgent, a general task agent, so that the work can continue after the older messages are removed.",
      }
    `)
  })

  it.each([
    ['an error event', { fault: { kind: 'http-error', status: 500 } }, 'llm/request-failed'],
    ['an empty summary', { content: '   ' }, 'llm/invalid-response'],
    ['a summary cut by max-tokens', { content: 'partial', finishReason: 'max-tokens' }, 'llm/invalid-response'],
  ] as const)('rejects on %s (the loop keeps the history and records the error)', async (_label, entry, code) => {
    const llm = scriptedProvider([entry as never])
    const compactor = new BasicCompactor({ llm, env: {} })
    await expect(compactor.compact(check(history(), { lastUsage: usage(1) }), new AbortController().signal)).rejects.toMatchObject({ code })
  })

  it('rejects when aborted mid-stream', async () => {
    const controller = new AbortController()
    const llm = scriptedProvider([{ content: ['a', 'b', 'c', 'd'], chunkDelayMs: 50 }])
    const compactor = new BasicCompactor({ llm, env: {} })
    const pending = compactor.compact(check(history(), { lastUsage: usage(1) }), controller.signal)
    setTimeout(() => controller.abort(), 60)
    await expect(pending).rejects.toMatchObject({ code: 'llm/aborted' })
  })

  it('refuses to compact when there is nothing to summarize', async () => {
    const compactor = new BasicCompactor({ llm: scriptedProvider([]), env: {} })
    await expect(compactor.compact(check(turn(1)), new AbortController().signal)).rejects.toMatchObject({ code: 'internal' })
  })
})
