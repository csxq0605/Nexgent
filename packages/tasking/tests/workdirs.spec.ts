/**
 * Rework K4 D4: members' own copies of the project, merged back file by
 * file at the end of each member turn; overlapping changes are conflicts.
 */
import { existsSync, lstatSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import * as nodePath from 'node:path'
import { describe, expect, it } from 'vitest'
import { LocalMemberWorkdirs, mergeText } from '../src/index.js'
import { project, tempDir } from './helpers.js'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'

describe('mergeText', () => {
  it('combines changes to different lines and refuses overlapping ones', () => {
    const base = 'a\nb\nc\nd\ne\n'
    expect(mergeText(base, 'A\nb\nc\nd\ne\n', 'a\nb\nc\nd\nE\n')).toBe('A\nb\nc\nd\nE\n')
    expect(mergeText(base, 'a\nB1\nc\nd\ne\n', 'a\nB2\nc\nd\ne\n')).toBeUndefined()
    expect(mergeText(base, 'a\nX\nc\nd\ne\n', 'a\nX\nc\nd\ne\n')).toBe('a\nX\nc\nd\ne\n')
  })
})

describe('member workdirs (rework K4 D4)', () => {
  it('gives a member of a thread a copy of the thread\'s copy and merges it back there, not into the project', async () => {
    const p = await project()
    await p.write('a.txt', 'a1\n')
    const workdirs = new LocalMemberWorkdirs(p.root, { base: await tempDir('nxwd-') })
    const thread = (await workdirs.open({ sessionId: A, sandboxMode: 'workspace-write' }))!
    await writeFile(nodePath.join(thread.root, 'thread.txt'), 'from the thread\n')
    const member = (await workdirs.open({ sessionId: B, sandboxMode: 'workspace-write', from: thread }))!
    // The member sees the thread's work, which the project does not have yet.
    expect(await readFile(nodePath.join(member.root, 'thread.txt'), 'utf8')).toBe('from the thread\n')
    await writeFile(nodePath.join(member.root, 'member.txt'), 'from the member\n')
    expect(await member.merge()).toMatchObject({ applied: ['member.txt'], conflicts: [] })
    expect(await readFile(nodePath.join(thread.root, 'member.txt'), 'utf8')).toBe('from the member\n')
    expect(existsSync(p.abs('member.txt'))).toBe(false)
    // The thread's own merge brings both into the project.
    expect((await thread.merge()).applied).toEqual(['member.txt', 'thread.txt'])
    expect(await readFile(p.abs('member.txt'), 'utf8')).toBe('from the member\n')
    await member.close()
    await thread.close()
  })

  it('keeps two members apart, merges what each changed, and reports a conflict', async () => {
    const p = await project()
    await p.write('a.txt', 'a1\n')
    await p.write('b.txt', 'b1\n')
    await p.write('shared.md', 'one\ntwo\nthree\nfour\nfive\n')
    await p.write('gone.txt', 'x\n')
    await p.write('.gitignore', 'build/\nnode_modules/\n')
    await p.write('build/out.js', 'built')
    await p.write('node_modules/dep/index.js', 'dep')
    const workdirs = new LocalMemberWorkdirs(p.root, { base: await tempDir('nxwd-') })
    const a = (await workdirs.open({ sessionId: A, sandboxMode: 'workspace-write' }))!
    const b = (await workdirs.open({ sessionId: B, sandboxMode: 'workspace-write' }))!
    const inA = (path: string) => nodePath.join(a.root, ...path.split('/'))
    const inB = (path: string) => nodePath.join(b.root, ...path.split('/'))
    expect(await readFile(inA('a.txt'), 'utf8')).toBe('a1\n')
    expect(existsSync(inA('build/out.js'))).toBe(false)
    expect(lstatSync(inA('node_modules')).isSymbolicLink()).toBe(true)

    // Each writes its own file; both edit shared.md (different lines); A deletes a file.
    await writeFile(inA('a.txt'), 'a2\n')
    await writeFile(inB('b.txt'), 'b2\n')
    await writeFile(inA('shared.md'), 'ONE\ntwo\nthree\nfour\nfive\n')
    await writeFile(inB('shared.md'), 'one\ntwo\nthree\nfour\nFIVE\n')
    await rm(inA('gone.txt'))
    await mkdir(inB('new'), { recursive: true })
    await writeFile(inB('new/file.txt'), 'new\n')
    // Nothing reaches the project before a merge.
    expect(await readFile(p.abs('a.txt'), 'utf8')).toBe('a1\n')

    const first = await a.merge()
    expect(first).toEqual({ applied: ['a.txt', 'gone.txt', 'shared.md'], merged: [], conflicts: [] })
    const second = await b.merge()
    expect(second).toEqual({ applied: ['b.txt', 'new/file.txt', 'shared.md'], merged: ['shared.md'], conflicts: [] })
    expect(await readFile(p.abs('shared.md'), 'utf8')).toBe('ONE\ntwo\nthree\nfour\nFIVE\n')
    expect(existsSync(p.abs('gone.txt'))).toBe(false)
    // B's merge brought A's changes into B's copy; A gets B's at its next refresh.
    expect(await readFile(inB('a.txt'), 'utf8')).toBe('a2\n')
    await a.refresh()
    expect(await readFile(inA('b.txt'), 'utf8')).toBe('b2\n')
    expect(await readFile(inA('new/file.txt'), 'utf8')).toBe('new\n')

    // Overlapping edits: the project keeps its version, the member's is kept aside.
    await writeFile(p.abs('a.txt'), 'project\n')
    await writeFile(inA('a.txt'), 'member\n')
    const third = await a.merge()
    expect(third.applied).toEqual([])
    expect(third.conflicts).toHaveLength(1)
    expect(third.conflicts[0]).toMatchObject({ path: 'a.txt', kind: 'both-changed' })
    expect(await readFile(third.conflicts[0]!.copy!, 'utf8')).toBe('member\n')
    expect(await readFile(p.abs('a.txt'), 'utf8')).toBe('project\n')
    // The copy now has the project's version, and the conflict is not reported again.
    expect(await readFile(inA('a.txt'), 'utf8')).toBe('project\n')
    expect((await a.merge()).conflicts).toEqual([])

    await a.close()
    expect(existsSync(a.root)).toBe(false)
    expect(existsSync(third.conflicts[0]!.copy!)).toBe(true)
    await b.close()
  })

  it('gives a read-only member or a project over the limit no copy', async () => {
    const p = await project()
    await p.write('a.txt', 'a')
    await p.write('b.txt', 'b')
    const base = await tempDir('nxwd-')
    expect(await new LocalMemberWorkdirs(p.root, { base }).open({ sessionId: A, sandboxMode: 'read-only' })).toBeUndefined()
    expect(await new LocalMemberWorkdirs(p.root, { base, maxFiles: 1 }).open({ sessionId: A, sandboxMode: 'workspace-write' })).toBeUndefined()
  })
})
