/**
 * Redesign 3.2: a root turn whose deterministic check of this turn's work
 * failed goes on by itself, at most `checkRetries` (default 2) times, with
 * a note naming the failed checks; a failure from an earlier turn does not.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BASELINE_VERSION, CHECK_RETRY_NOTE_PREFIX, HANDBOOK_RULES_HEADER, RULE_CONFLICT_AFTER_CHECKS_NOTE, type CapabilityHost, type Context, type NexgentApp, type TaskRecorder, type Tool } from '../src/index.js'
import { textReply, toolCallReply } from './helpers/fakes.js'
import { bootHarness, type Harness } from './helpers/harness.js'

let harness: Harness | undefined
afterEach(async () => {
  await harness?.dispose()
  harness = undefined
})

/** Exit codes the project check command `make check` gives, in order (redesign 3.2 check commands). */
let checkExits: number[] = []

/** A shell stand-in: exits with the code it is given (`make check` takes the next of {@link checkExits}). */
const bash: Tool = {
  definition: { name: 'bash', description: 'run', inputSchema: { type: 'object', properties: { command: { type: 'string' }, code: { type: 'number' } } }, effects: ['execute'], approval: 'never' },
  handler: async input => {
    const { command, code } = input as { command: string; code?: number }
    const exit = command === 'make check' ? checkExits.shift() ?? 0 : code ?? 0
    return { content: `${command}: exit ${exit}`, meta: { exitCode: exit } }
  },
}

/** Like the tasking recorder: one `test-command` check per command, decided by its latest run. */
const recorder: TaskRecorder = {
  begin: async () => undefined,
  end: async input => {
    const latest = new Map(input.commands.map(command => [command.command, command]))
    const runs = [...latest.values()]
    const own = input.checkRuns ?? []
    return {
      specs: [
        ...runs.map((run, index) => ({ id: `test-${index + 1}`, name: 'test-command' as const, command: run.command, shell: run.shell })),
        ...own.map((run, index) => ({ id: `check-${index + 1}`, name: 'test-command' as const, command: run.command, shell: run.shell })),
      ],
      results: [
        ...runs.map((run, index) => ({ name: 'test-command', passed: run.exitCode === 0, detail: `exit code ${run.exitCode}`, target: `test-${index + 1}` })),
        ...own.map((run, index) => ({ name: 'test-command', passed: run.exitCode === 0, detail: `exit code ${run.exitCode}`, target: `check-${index + 1}` })),
      ],
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
        toolCallReply('c2', 'bash', { command: 'npm test', code: 1 }),
        textReply('two'),
        toolCallReply('c3', 'bash', { command: 'npm test', code: 1 }),
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

  it('stops retrying once the model answers a retry in words only (ADR 0029 decision 4)', async () => {
    harness = await bootHarness({
      script: [
        toolCallReply('c1', 'bash', { command: 'npm test', code: 1 }),
        textReply('done'),
        textReply('the old test expects the opposite; which should win?'),
      ],
    })
    await setup(harness.app)
    const agent = await harness.app.agents.create()
    const result = await agent.run('make the tests pass')
    expect(result.text).toBe('the old test expects the opposite; which should win?')
    expect(notes(harness, agent.sessionId)).toHaveLength(1)
    expect(notes(harness, agent.sessionId)[0]!.content).not.toContain(RULE_CONFLICT_AFTER_CHECKS_NOTE)
    await agent.close()
  })

  it('reminds a task that was given project rules that an old test may contradict one (ADR 0029 decision 3)', async () => {
    harness = await bootHarness({
      script: [
        toolCallReply('c1', 'bash', { command: 'npm test', code: 1 }),
        textReply('done'),
        textReply('asked'),
      ],
    })
    await setup(harness.app)
    const host: CapabilityHost = {
      current: async () => BASELINE_VERSION,
      verify: async () => ({ ok: true }),
      attach: async () => ({ components: [] }),
      handbookForTurn: async () => ({ ids: ['r1'], text: `${HANDBOOK_RULES_HEADER}\n- [r1] Keep amounts in whole units.` }),
    }
    await harness.app.ctx.plugin({ name: 'fake-capabilities', apply: (ctx: Context) => { ctx.provide('capabilityHost', host) } })
    const agent = await harness.app.agents.create()
    await agent.run('make the tests pass')
    expect(notes(harness, agent.sessionId)[0]!.content).toContain(RULE_CONFLICT_AFTER_CHECKS_NOTE)
    await agent.close()
  })

  it('runs the project check commands after a turn that changed something, and records the before/after pair', async () => {
    checkExits = [1, 0]
    harness = await bootHarness({
      script: [
        toolCallReply('c1', 'bash', { command: 'touch report.md', code: 0 }),
        textReply('done'),
        textReply('fixed'),
        // turn 2 changes nothing: the check command does not run
        textReply('just talking'),
      ],
    })
    mkdirSync(join(harness.root, '.nexgent'), { recursive: true })
    writeFileSync(join(harness.root, '.nexgent', 'config.json'), JSON.stringify({ checkCommands: ['make check'] }))
    await setup(harness.app)
    const agent = await harness.app.agents.create()
    expect((await agent.run('write the report')).text).toBe('fixed')
    const sent = notes(harness, agent.sessionId)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.content).toContain('project check command `make check`: failed (exit code 1)')
    expect(sent[0]!.content).toContain('make check: exit 1')
    const pairs = harness.ledger.of('check.retry')
    expect(pairs).toHaveLength(1)
    expect(pairs[0]).toMatchObject({ sessionId: agent.sessionId, turn: 1, retry: 1, max: 2 })
    expect(pairs[0]!.before.find(check => check.target === 'check-1')).toMatchObject({ passed: false })
    expect(pairs[0]!.after.find(check => check.target === 'check-1')).toMatchObject({ passed: true })
    expect((await agent.run('thanks')).text).toBe('just talking')
    expect(checkExits).toEqual([])
    expect(harness.ledger.of('check.retry')).toHaveLength(1)
    await agent.close()
  })
})
