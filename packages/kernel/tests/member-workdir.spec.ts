/** A member of an agent that works in its own copy (a thread) gets its copy from that copy. */
import { afterEach, describe, expect, it } from 'vitest'
import type { MemberWorkdir, MemberWorkdirs } from '../src/index.js'
import { servicePlugin } from './helpers/fakes.js'
import { bootHarness, type Harness } from './helpers/harness.js'

let harness: Harness | undefined
afterEach(async () => {
  await harness?.dispose()
  harness = undefined
})

describe('member copies', () => {
  it('are made from the parent\'s own copy when it has one', async () => {
    harness = await bootHarness({ script: [] })
    const { app, root } = harness
    const opened: { sessionId: string; from?: string }[] = []
    const workdirs: MemberWorkdirs = {
      open: async input => {
        opened.push({ sessionId: input.sessionId, ...(input.from === undefined ? {} : { from: input.from.root }) })
        const copy: MemberWorkdir = { root: `${root}`, refresh: async () => undefined, merge: async () => ({ applied: [], merged: [], conflicts: [] }), close: async () => undefined }
        return copy
      },
    }
    await app.ctx.plugin(servicePlugin('workdirs', workdirs))
    const coordinator = await app.agents.create()
    const thread = await app.agents.create({ thread: { coordinatorSessionId: coordinator.sessionId, title: 'Part' } })
    const member = await app.agents.create({ child: { parentSessionId: thread.sessionId, member: { name: 'helper', executionForm: 'delegated' } } })
    const plain = await app.agents.create({ child: { parentSessionId: coordinator.sessionId, member: { name: 'other', executionForm: 'delegated' } } })
    // The thread copies the project; its member copies the thread's copy; a member of an agent without a copy copies the project.
    expect(opened).toEqual([{ sessionId: thread.sessionId }, { sessionId: member.sessionId, from: root }, { sessionId: plain.sessionId }])
    await thread.close()
    await coordinator.close()
  })
})
