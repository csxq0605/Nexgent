/**
 * Redesign 3.1: put the files a session changed back to how they were
 * before a turn, from that turn's snapshot; other files are left alone.
 */
import { chmod, readFile, rm, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { applyRewind, LocalTaskRecorder, planRewind } from '../src/index.js'
import { project, SESSION_A } from './helpers.js'

const TASK = '0b6d7c1e-8f2a-4c3b-9d4e-5f6a7b8c9d0e'
const V1 = 'a'.repeat(64)

describe('rewind (redesign 3.1)', () => {
  it('restores changed and deleted files, deletes added ones, and leaves files outside the list alone', async () => {
    const p = await project()
    await p.write('keep.txt', 'v1')
    await p.write('edit.txt', 'v1')
    await p.write('gone.txt', 'was here')
    await p.write('run.sh', 'echo hi\n')
    if (process.platform !== 'win32') await chmod(p.abs('run.sh'), 0o755)
    await p.write('other.txt', 'v1')
    const recorder = new LocalTaskRecorder(p.workspace.layout)
    await recorder.begin({ taskId: TASK, sessionId: SESSION_A, capabilityVersion: V1, turn: 2 })

    await p.write('edit.txt', 'v2')
    await p.write('new/added.txt', 'new')
    await rm(p.abs('gone.txt'))
    if (process.platform !== 'win32') await chmod(p.abs('run.sh'), 0o644)
    await p.write('other.txt', 'changed by someone else')
    const layout = p.workspace.layout
    const paths = ['edit.txt', 'new/added.txt', 'gone.txt', 'keep.txt', ...(process.platform === 'win32' ? [] : ['run.sh'])]

    const plan = await planRewind({ layout, sessionId: SESSION_A, turn: 2, paths })
    expect(plan.changes).toEqual([
      { path: 'edit.txt', action: 'restore' },
      { path: 'gone.txt', action: 'restore' },
      { path: 'new/added.txt', action: 'delete' },
      ...(process.platform === 'win32' ? [] : [{ path: 'run.sh', action: 'restore' }]),
    ])
    expect(plan.unchanged).toEqual(['keep.txt'])
    // Planning writes nothing.
    expect(await readFile(p.abs('edit.txt'), 'utf8')).toBe('v2')

    await applyRewind(layout, plan)
    expect(await readFile(p.abs('edit.txt'), 'utf8')).toBe('v1')
    expect(await readFile(p.abs('gone.txt'), 'utf8')).toBe('was here')
    expect(existsSync(p.abs('new/added.txt'))).toBe(false)
    if (process.platform !== 'win32') expect((await stat(p.abs('run.sh'))).mode & 0o111).not.toBe(0)
    expect(await readFile(p.abs('other.txt'), 'utf8')).toBe('changed by someone else')
    expect((await planRewind({ layout, sessionId: SESSION_A, turn: 2, paths })).changes).toEqual([])
  })

  it('refuses a turn without a snapshot', async () => {
    const p = await project()
    await expect(planRewind({ layout: p.workspace.layout, sessionId: SESSION_A, turn: 1, paths: ['a.txt'] })).rejects.toMatchObject({ code: 'session/not-found' })
  })
})
