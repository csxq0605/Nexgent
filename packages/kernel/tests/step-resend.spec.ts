/**
 * A step whose reply broke off on a transient failure (a dropped stream)
 * after part of it came is sent again from the same history: the partial
 * reply is never kept.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { renderWorkdirMerge, threadWakeNote, type AgentEvent, type LLMStreamEvent } from '../src/index.js'
import { textReply } from './helpers/fakes.js'
import { bootHarness, type Harness } from './helpers/harness.js'

let harness: Harness | undefined
afterEach(async () => {
  await harness?.dispose()
  harness = undefined
})

const dropped = (transient: boolean): LLMStreamEvent[] => [
  { type: 'text.delta', text: 'Half a rep' },
  { type: 'error', error: { name: 'NexgentError', code: 'llm/request-failed', message: 'stream ended before a stop reason', details: { attempts: 1, retryable: false, transient } } },
]

describe('resending a step after a transient failure', () => {
  it('sends the step again and keeps only the full reply', async () => {
    harness = await bootHarness({ script: [dropped(true), textReply('The whole reply.')] })
    const agent = await harness.app.agents.create()
    const events: AgentEvent[] = []
    agent.subscribe(event => events.push(event))
    const result = await agent.run('answer')
    expect(result.reason).toEqual({ kind: 'completed' })
    expect(result.text).toBe('The whole reply.')
    expect(harness.store.of(agent.sessionId, 'assistant.message').map(record => record.content)).toEqual(['The whole reply.'])
    expect(events.filter(event => event.type === 'request.retry')).toHaveLength(1)
  }, 15_000)

  it('ends the turn on a failure that is not transient', async () => {
    harness = await bootHarness({ script: [dropped(false), textReply('never')] })
    const agent = await harness.app.agents.create()
    expect((await agent.run('answer')).reason.kind).toBe('error')
  })
})

describe('a failed run with its own copy', () => {
  it('says its changes were not merged, in the member result and in the thread note', () => {
    const held = { applied: [], merged: [], conflicts: [], held: true as const }
    expect(renderWorkdirMerge(held)[0]).toContain('Not merged into the project')
    expect(threadWakeNote({ title: 'D', threadId: 't', status: 'failed', reply: '', merge: held })).toContain('Not merged into the project')
  })

  it('keeps a long reply\'s start and end in the thread note and asks for read_thread', () => {
    const reply = `${'a'.repeat(7000)}\nDone: x\nNot done: none\nChecks: ok\nBlockers: none`
    const note = threadWakeNote({ title: 'C', threadId: 't', status: 'done', reply })
    expect(note).toContain('Call read_thread for the whole reply yourself')
    expect(note).toContain('Blockers: none')
    expect(threadWakeNote({ title: 'C', threadId: 't', status: 'done', reply: 'ok', merge: { applied: ['a.ts'], merged: [], conflicts: [] }, mergedThreads: 2 })).toContain('have one thread check the whole project')
  })
})
