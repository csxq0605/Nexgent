/**
 * The present reminder (`agent-hooks.md` §成果提醒): a root task turn that
 * ran a file-writing tool and has presented nothing gets one hidden
 * `user.message { source: 'inject' }` with its next request, at most once
 * every PRESENT_REMINDER_EVERY steps. Real runs (step 6, experiment 1)
 * changed files and ended without `present`, so the user had no result to
 * open or comment on.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { PRESENT_REMINDER, PRESENT_REMINDER_EVERY, type Tool, type ToolEffect } from '../src/index.js'
import { conversation, textReply, toolCallReply, type ScriptStep } from './helpers/fakes.js'
import { bootHarness, type Harness } from './helpers/harness.js'

let harness: Harness | undefined
afterEach(async () => {
  await harness?.dispose()
  harness = undefined
})

function tool(name: string, effects: ToolEffect[], onCall?: () => Promise<void>): Tool {
  return {
    definition: { name, description: `${name}.`, inputSchema: { type: 'object', properties: {} }, effects, approval: 'never' },
    handler: async () => {
      await onCall?.()
      return { content: `${name} ran` }
    },
  }
}

/** Whether the n-th request ends with the reminder as its last user message. */
function reminded(h: Harness, n: number): boolean {
  const last = conversation(h.llm.requests[n]!).at(-1)
  return last?.role === 'user' && last.content === PRESENT_REMINDER
}

async function boot(script: ScriptStep[], withPresent = true) {
  harness = await bootHarness({ script })
  const { app } = harness
  app.ctx.tools.register(tool('write_file', ['write']))
  app.ctx.tools.register(tool('read_file', ['read']))
  if (withPresent) {
    app.ctx.tools.register({
      ...tool('present', ['read']),
      handler: async (_input, context) => {
        const ctx = context as unknown as { appendRecord(record: unknown): Promise<void>; turn: number; step: number; callId: string }
        await ctx.appendRecord({
          type: 'deliverable.presented', turn: ctx.turn, step: ctx.step, toolCallId: ctx.callId,
          deliverable: { deliverableId: 'd1', version: 1, title: 'Out', summary: 's', files: [{ path: 'out.js', size: 1, sha256: 'c'.repeat(64), mediaType: 'text/javascript' }] },
        })
        return { content: 'presented' }
      },
    })
  }
  return app
}

describe('present reminder', () => {
  it('reminds once, hidden, when a turn wrote files and is about to end without presenting', async () => {
    const app = await boot([toolCallReply('c1', 'write_file', {}), textReply('done'), textReply('second turn')])
    const agent = await app.agents.create()
    expect((await agent.run('fix the bug')).reason).toEqual({ kind: 'completed' })
    expect(reminded(harness!, 0)).toBe(false)
    expect(reminded(harness!, 1)).toBe(true)
    const injected = harness!.store.of(agent.sessionId, 'user.message').filter(record => record.source === 'inject')
    expect(injected).toEqual([expect.objectContaining({ turn: 1, content: PRESENT_REMINDER, source: 'inject' })])
    // A turn without tool calls gets nothing.
    await agent.run('thanks')
    expect(reminded(harness!, 2)).toBe(false)
    await agent.close()
  })

  it('stops reminding once the turn presented, and starts again next turn', async () => {
    const app = await boot([
      toolCallReply('c1', 'write_file', {}),
      toolCallReply('c2', 'present', {}),
      toolCallReply('c3', 'write_file', {}),
      textReply('done'),
      toolCallReply('c4', 'write_file', {}),
      textReply('done again'),
    ])
    const agent = await app.agents.create()
    await agent.run('make it')
    expect([0, 1, 2, 3].map(n => reminded(harness!, n))).toEqual([false, true, false, false])
    await agent.run('change it')
    expect([4, 5].map(n => reminded(harness!, n))).toEqual([false, true])
    await agent.close()
  })

  it('does not remind after read-only tools, without present in scope, or in a member or improvement session', async () => {
    const app = await boot([toolCallReply('c1', 'read_file', {}), textReply('read'), toolCallReply('c2', 'write_file', {}), textReply('proposed')])
    const root = await app.agents.create()
    await root.run('look')
    await root.close()
    const propose = await app.agents.create({ improvement: { jobId: '0f0f0f0f-0000-4000-8000-000000000001', phase: 'propose' } })
    await propose.run('redo')
    await propose.close()
    expect([0, 1, 2, 3].map(n => reminded(harness!, n))).toEqual([false, false, false, false])

    await harness!.dispose()
    const plain = await boot([toolCallReply('c1', 'write_file', {}), textReply('done')], false)
    const agent = await plain.agents.create()
    await agent.run('write')
    await agent.close()
    expect(reminded(harness!, 1)).toBe(false)
  })

  it('does not remind a member: the root delivers', async () => {
    const app = await boot([toolCallReply('c1', 'write_file', {}), textReply('member done')])
    const root = await app.agents.create()
    const member = await app.agents.create({ child: { parentSessionId: root.sessionId, member: { name: 'helper', executionForm: 'delegated' } } })
    await member.run('write a part')
    expect(reminded(harness!, 1)).toBe(false)
    await member.close()
    await root.close()
  })

  it(`reminds a long turn again after ${PRESENT_REMINDER_EVERY} steps, not on every step`, async () => {
    const writes = Array.from({ length: PRESENT_REMINDER_EVERY + 2 }, (_, i) => toolCallReply(`c${i}`, 'write_file', {}))
    const app = await boot([...writes, textReply('done')])
    const agent = await app.agents.create()
    await agent.run('long task')
    await agent.close()
    const at = harness!.llm.requests.map((_, n) => n).filter(n => reminded(harness!, n))
    // Requests are 0-based: the first reminder rides request 1 (step 2), the next PRESENT_REMINDER_EVERY steps later.
    expect(at).toEqual([1, 1 + PRESENT_REMINDER_EVERY])
  })
})
