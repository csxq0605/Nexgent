// Redesign 3.2 / 3.1 for the UI: a check-retry note and a rewind record become history items.
import { renderCheckRetryNote, type SessionRecord } from '@nexgent/kernel'
import { describe, expect, it } from 'vitest'
import * as nodePath from 'node:path'
import { checkRetryOf, historyItems } from '../src/index.js'
import { testSdk } from './helpers.js'

describe('check retries and rewinds in the history', () => {
  it('reads the failed checks back from the kernel note and leaves other injected notes out', () => {
    const note = renderCheckRetryNote([
      { spec: { id: 'c1', name: 'test-command', command: 'npm test', shell: 'bash' }, result: { name: 'test-command', passed: false, detail: 'exit 1' } },
      { spec: { id: 'c2', name: 'parses', path: 'out/data.json', format: 'json' }, result: { name: 'parses', passed: false } },
      { spec: { id: 'c3', name: 'file-exists', path: 'report.md' }, result: { name: 'file-exists', passed: false } },
      { spec: { id: 'check-1', name: 'test-command', command: 'make check', shell: 'bash' }, result: { name: 'test-command', passed: false, detail: 'exit code 2' }, output: 'lint: 3 problems' },
    ], 1, 2)
    expect(checkRetryOf(note)).toEqual({
      attempt: 1,
      max: 2,
      failed: [
        { check: 'test-command', target: 'npm test', detail: 'exit 1' },
        { check: 'parses', target: 'out/data.json', format: 'json' },
        { check: 'exists', target: 'report.md' },
        { check: 'check-command', target: 'make check', detail: 'exit code 2' },
      ],
    })
    const base = { formatVersion: 1, sessionId: 's', ts: '2026-10-17T00:00:00.000Z' }
    const records = [
      { ...base, seq: 1, type: 'user.message', turn: 1, content: 'other note', source: 'inject' },
      { ...base, seq: 2, type: 'user.message', turn: 1, content: note, source: 'inject' },
      { ...base, seq: 3, type: 'turn.rewind', toTurn: 1, restored: ['a.txt'], deleted: ['b.txt'] },
    ] as unknown as SessionRecord[]
    expect(historyItems(records).map(item => item.kind)).toEqual(['check.retry', 'rewind'])
    expect(historyItems(records)[1]).toEqual({ kind: 'rewind', rewind: { toTurn: 1, restored: ['a.txt'], deleted: ['b.txt'] } })
  })

  it('settings carry the retry count and the project check commands', async () => {
    const t = await testSdk([])
    const project = await t.sdk.call('projects.open', { root: nodePath.join(t.base, 'p'), create: true })
    expect(await t.sdk.call('settings.get', { projectId: project.projectId })).toMatchObject({ checkRetries: 2, checkCommands: [] })
    const updated = await t.sdk.call('settings.update', { projectId: project.projectId, patch: { checkRetries: 0, checkCommands: ['npm test'] } })
    expect(updated).toMatchObject({ checkRetries: 0, checkCommands: ['npm test'] })
    await expect(t.sdk.call('settings.update', { projectId: project.projectId, patch: { checkRetries: 9 } })).rejects.toMatchObject({ code: 'config/invalid' })
  })
})
