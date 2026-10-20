// Redesign 3.1: sessions.rewind lists, then restores, the files a turn changed, from its snapshot.
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import * as nodePath from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { testSdk } from './helpers.js'

const usage = { inputTokens: 100, outputTokens: 10, totalTokens: 110, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }

describe('sessions.rewind', () => {
  it('previews, then puts the files of a turn back and records turn.rewind; the history stays', async () => {
    const t = await testSdk([
      { toolCalls: [{ name: 'write_file', arguments: { path: 'notes.md', content: 'new\n', overwrite: true } }, { name: 'write_file', arguments: { path: 'added.md', content: 'x\n' } }], usage },
      { content: 'Done.', usage },
      { content: 'Read them again.', usage },
    ])
    const root = nodePath.join(t.base, 'p')
    await mkdir(root, { recursive: true })
    await writeFile(nodePath.join(root, 'notes.md'), 'old\n')
    const project = await t.sdk.call('projects.open', { root, create: true })
    const session = await t.sdk.call('sessions.create', { projectId: project.projectId })
    await t.sdk.call('turns.send', { projectId: project.projectId, sessionId: session.sessionId, text: 'edit' })
    await vi.waitFor(() => expect(t.sdk.isRunning(project.projectId, session.sessionId)).toBe(false))
    expect(await readFile(nodePath.join(root, 'notes.md'), 'utf8')).toBe('new\n')

    const preview = await t.sdk.call('sessions.rewind', { projectId: project.projectId, sessionId: session.sessionId, turn: 1 })
    expect(preview).toMatchObject({ turn: 1, applied: false, changes: [{ path: 'added.md', action: 'delete' }, { path: 'notes.md', action: 'restore' }] })
    expect(await readFile(nodePath.join(root, 'notes.md'), 'utf8')).toBe('new\n')

    const done = await t.sdk.call('sessions.rewind', { projectId: project.projectId, sessionId: session.sessionId, turn: 1, apply: true })
    expect(done.applied).toBe(true)
    expect(await readFile(nodePath.join(root, 'notes.md'), 'utf8')).toBe('old\n')
    expect(existsSync(nodePath.join(root, 'added.md'))).toBe(false)
    const view = await t.sdk.call('sessions.view', { projectId: project.projectId, sessionId: session.sessionId })
    expect(view.items.some(item => item.kind === 'assistant')).toBe(true)
    await expect(t.sdk.call('sessions.rewind', { projectId: project.projectId, sessionId: session.sessionId, turn: 2 })).rejects.toMatchObject({ code: 'session/not-found' })

    // The next turn is told what changed; the timeline shows only the rewind line, no note.
    await t.sdk.call('turns.send', { projectId: project.projectId, sessionId: session.sessionId, text: 'what is in notes.md?' })
    await vi.waitFor(() => expect(t.sdk.isRunning(project.projectId, session.sessionId)).toBe(false))
    const sent = JSON.stringify(t.providers[0]!.llm.calls.at(-1)!.request.messages)
    expect(sent).toContain('The user took project files back to how they were before turn 1.')
    expect(sent).toContain('Restored: notes.md.')
    expect(sent).toContain('Deleted: added.md.')
    expect(sent.indexOf('took project files back')).toBeLessThan(sent.indexOf('what is in notes.md?'))
  })
})
