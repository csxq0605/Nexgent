/** A completed member whose report names a blocker reads as stuck (`MemberRunView.blocker`). */
import { describe, expect, it } from 'vitest'
import { memberRunView } from '../src/index.js'

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
const start = { type: 'subagent.start', seq: 1, at: '2026-10-19T00:00:00.000Z', sessionId: 's1', turn: 1, childSessionId: 'c1', childTurn: 1, name: 'tester', executionForm: 'workflow' } as never
const end = (status: string, text: string) =>
  ({ type: 'subagent.end', seq: 2, at: '2026-10-19T00:01:00.000Z', sessionId: 's1', turn: 1, childSessionId: 'c1', childTurn: 1, result: { status, text, deliverables: [], usage, requestCount: 1 } }) as never

describe('member blocker', () => {
  it('takes the Blockers line of a completed member, and nothing when it says none', () => {
    expect(memberRunView(start, end('completed', 'Done: wrote tests\nNot done: none\nChecks: npm test failed\nBlockers: the build script is missing')).blocker).toBe('the build script is missing')
    expect(memberRunView(start, end('completed', 'Done: all\nBlockers: none')).blocker).toBeUndefined()
    expect(memberRunView(start, end('completed', 'no report')).blocker).toBeUndefined()
    expect(memberRunView(start, end('failed', 'Blockers: crashed')).blocker).toBeUndefined()
    expect(memberRunView(start).blocker).toBeUndefined()
  })
})
