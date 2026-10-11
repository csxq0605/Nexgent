import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { renderCompactionSummary } from '@nexgent/kernel'
import { JsonlSessionStore } from '@nexgent/session'
import { killAllSpawned, spawnNode } from '@nexgent/test-support'
import { SESSION_ID, tempDir } from './helpers.js'

const CHILD = fileURLToPath(new URL('./fixtures/compact-then-hang.mjs', import.meta.url))

afterEach(async () => {
  await killAllSpawned()
})

describe('compaction survives a hard kill', () => {
  it('rebuilds after kill -9 exactly the history the process held, and replays thinking only for kept replies', async () => {
    const root = await tempDir()
    const sessionsDir = join(root, '.nexgent', 'sessions')
    const child = spawnNode([CHILD, sessionsDir, SESSION_ID, root], { cwd: fileURLToPath(new URL('..', import.meta.url)) })
    const { text } = await child.waitForOutput(/\}\n/, 30_000, 'stdout')
    const before = JSON.parse(text.trim()) as { memory: unknown[]; compactedMessages: number; keepMessages: number }
    const exit = await child.kill('SIGKILL')
    expect(exit.code === 0).toBe(false)

    // Turn 1 (4 messages) is summarized; turn 2 (inject + user + 3) and turn 3 so far are kept.
    expect(before.compactedMessages).toBe(4)
    const store = new JsonlSessionStore({ sessionsDir })
    const state = await store.resume(SESSION_ID)
    expect(state.messages).toEqual(before.memory)
    expect(state.messages[0]).toEqual({ role: 'user', content: renderCompactionSummary('Summary of turn 1.') })
    expect(state.metadata.openTurn).toBe(3)

    const replies = state.messages.filter(message => message.role === 'assistant')
    // Kept replies of turns 2 and 3 still carry their thinking blocks; turn 1's are gone with the summary.
    expect(replies.map(reply => JSON.stringify(reply.providerContent))).toEqual([
      expect.stringContaining('sig-2-1'),
      expect.stringContaining('sig-2-2'),
      expect.stringContaining('sig-3-1'),
      expect.stringContaining('sig-3-2'),
    ])
    expect(JSON.stringify(state.messages)).not.toContain('sig-1-')

    // The dead writer's lock is taken over and the session continues from the same history.
    const lock = await store.lock(SESSION_ID)
    await store.append(SESSION_ID, { type: 'turn.end', turn: 3, reason: { kind: 'interrupted' } })
    await store.release(lock)
    expect((await store.resume(SESSION_ID)).messages).toEqual(before.memory)
    const raw = await readFile(join(sessionsDir, SESSION_ID, 'session.jsonl'), 'utf8')
    expect(raw.split('\n').filter(line => line.includes('"type":"compaction"'))).toHaveLength(1)
  }, 60_000)
})
