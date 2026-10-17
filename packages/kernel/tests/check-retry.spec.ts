/**
 * Redesign 3.2: a root turn whose deterministic check of this turn's work
 * failed goes on by itself, at most `checkRetries` (default 2) times, with
 * a note naming the failed checks; a failure from an earlier turn does not.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { CHECK_RETRY_NOTE_PREFIX, type Context, type NexgentApp, type TaskRecorder, type Tool } from '../src/index.js'
import { textReply, toolCallReply } from './helpers/fakes.js'
import { bootHarness, type Harness } from './helpers/harness.js'

let harness: Harness | undefined
afterEach(async () => {
  await harness?.dispose()
  harness = undefined
})

/** A shell stand-in: exits with the code it is given. */
const bash: Tool = {
  definition: { name: 'bash', description: 'run', inputSchema: { type: 'object', properties: { command: { type: 'string' }, code: { type: 'number' } } }, effects: ['execute'], approval: 'never' },
  handler: async input => {
    const { code } = input as { code: number }
    return { content: `exit ${code}`, meta: { exitCode: code } }
  },
}

/** Like the tasking recorder: one `test-command` check per command, decided by its latest run. */
const recorder: TaskRecorder = {
  begin: async () => undefined,
  end: async input => {
    const latest = new Map(input.commands.map(command => [command.command, command]))
    const runs = [...latest.values()]
    return {
      specs: runs.map((run, index) => ({ id: `test-${index + 1}`, name: 'test-command' as const, command: run.command, shell: run.shell })),
      results: runs.map((run, index) => ({ name: 'test-command', passed: run.exitCode === 0, detail: `exit code ${run.exitCode}`, target: `test-${index + 1}` })),
    }
  },
}

async function setup(app: NexgentApp): Promise<void> {
  app.ctx.tools.register(bash)
  await app.ctx.plugin({ name: 'fake-recorder', apply: (ctx: Context) => { ctx.provide('taskRecorder', recorder) } })
}

const notes = (harness: Harness, sessionId: string) =>
  harness.store.of(sessionId, 'user.message').filter(record => record.source === 'inject' && record.content.startsWith(CHECK_RETRY_NOTE_PREFIX))

describe('check retry (redesign 3.2)', () => {
  it('sends the model back when its test run failed, and stops once it passes', async () => {
    harness = await bootHarness({
      script: [
        toolCallReply('c1', 'bash', { command: 'npm test', code: 1 }),
        textReply('done'),
        toolCallReply('c2', 'bash', { command: 'npm test', code: 0 }),
        textReply('fixed'),
      ],
    })
    await setup(harness.app)
    const agent = await harness.app.agents.create()
    const result = await agent.run('make the tests pass')
    expect(result.reason).toEqual({ kind: 'completed' })
    expect(result.text).toBe('fixed')
    const sent = notes(harness, agent.sessionId)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.content).toContain('(retry 1 of 2)')
    expect(sent[0]!.content).toContain('test command `npm test`: failed (exit code 1)')
    // The retry continues the turn: steps count on.
    expect(harness.store.of(agent.sessionId, 'assistant.message').map(record => [record.turn, record.step])).toEqual([[1, 1], [1, 2], [1, 3], [1, 4]])
    expect(harness.store.of(agent.sessionId, 'turn.end')).toHaveLength(1)
    await agent.close()
  })

  it('retries at most twice, and an earlier turn\'s failure does not start a retry', async () => {
    harness = await bootHarness({
      script: [
        toolCallReply('c1', 'bash', { command: 'npm test', code: 1 }),
        textReply('one'),
        textReply('two'),
        textReply('three'),
        // turn 2 runs no test: the failing run of turn 1 is not this turn's
        textReply('next turn'),
      ],
    })
    await setup(harness.app)
    const agent = await harness.app.agents.create()
    const first = await agent.run('make the tests pass')
    expect(first.text).toBe('three')
    expect(notes(harness, agent.sessionId).map(record => record.content.match(/retry \d of \d/)?.[0])).toEqual(['retry 1 of 2', 'retry 2 of 2'])
    const second = await agent.run('something else')
    expect(second.text).toBe('next turn')
    expect(notes(harness, agent.sessionId)).toHaveLength(2)
    await agent.close()
  })
})
