import { describe, expect, it } from 'vitest'
import { addUsage } from '@nexgent/kernel'
import { EXIT, exitCodeFor, TaskTally, taskStatus } from '../src/index.js'
import { sessionEvent, SID, UNKNOWN_USAGE, USAGE, writeFileTurn } from './helpers.js'

describe('TaskTally', () => {
  it('builds the task.outcome of a completed write-file task', () => {
    const tally = new TaskTally()
    for (const event of [sessionEvent(), ...writeFileTurn()]) tally.observe(event)
    // step 2 reported no usage, so the sum is unknown (never 0)
    expect(tally.outcome()).toEqual({
      type: 'task.outcome',
      sessionId: SID,
      status: 'completed',
      totalUsage: addUsage(USAGE, UNKNOWN_USAGE),
      requestCount: 2,
      toolCallCount: 1,
      turns: 1,
      toolsUsed: ['write_file'],
    })
    expect(tally.totalUsage.inputTokens).toBe('unknown')
    expect(tally.finalText).toBe('Created hello.txt.')
    expect(tally.exitCode).toBe(EXIT.OK)
  })

  it('sums usage when every step reports it', () => {
    const tally = new TaskTally()
    tally.observe(sessionEvent())
    tally.observe({ type: 'step.start', turn: 1, step: 1, requestId: 'a' })
    tally.observe({ type: 'usage', usage: USAGE })
    tally.observe({ type: 'step.start', turn: 1, step: 2, requestId: 'b' })
    tally.observe({ type: 'usage', usage: USAGE })
    expect(tally.totalUsage.inputTokens).toBe(1624)
  })

  it('carries the error of a failed turn', () => {
    const tally = new TaskTally()
    const error = { name: 'NexgentError', code: 'budget/exhausted' as const, message: 'cap' }
    tally.observe(sessionEvent())
    tally.observe({ type: 'turn.end', turn: 1, reason: { kind: 'cancelled', cause: 'cost-cap' } })
    tally.observe({ type: 'run.error', error, fatal: true })
    expect(tally.outcome()).toMatchObject({ status: 'cancelled', error, requestCount: 0 })
    expect(tally.exitCode).toBe(EXIT.TASK_FAILED)
  })

  it('reports failed when no turn ended, and requires a session', () => {
    const tally = new TaskTally()
    expect(() => tally.outcome()).toThrow('no session')
    tally.observe(sessionEvent())
    expect(tally.outcome().status).toBe('failed')
    expect(tally.exitCode).toBe(EXIT.TASK_FAILED)
  })
})

describe('exit codes', () => {
  it.each([
    [{ kind: 'completed' } as const, 0, 'completed'],
    [{ kind: 'cancelled', cause: 'user' } as const, 130, 'cancelled'],
    [{ kind: 'cancelled', cause: 'shutdown' } as const, 143, 'cancelled'],
    [{ kind: 'cancelled', cause: 'timeout' } as const, 1, 'cancelled'],
    [{ kind: 'max-tokens' } as const, 1, 'failed'],
    [{ kind: 'interrupted' } as const, 1, 'failed'],
  ])('%j -> %i', (reason, code, status) => {
    expect(exitCodeFor(reason)).toBe(code)
    expect(taskStatus(reason)).toBe(status)
  })
})
