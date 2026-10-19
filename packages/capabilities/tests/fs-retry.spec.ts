import { mkdir, mkdtemp, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isTransientFsError, releaseTrialLock, renameRetrying, transientRenameCodes, writeTrialLock } from '../src/index.js'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })

const FAST = [1, 1, 1, 1]

describe('renameRetrying (Windows sharing violations)', () => {
  it('retries EPERM until the staged directory moves into place', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexgent-rename-'))
    dirs.push(root)
    await mkdir(join(root, '.staging'))
    await writeFile(join(root, '.staging', 'candidate.json'), '{}\n')
    let calls = 0
    await renameRetrying(join(root, '.staging'), join(root, 'c1'), {
      delays: FAST,
      rename: async (from, to) => {
        calls += 1
        if (calls <= 2) throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
        await rename(from, to)
      },
    })
    expect(calls).toBe(3)
    expect(await readdir(root)).toEqual(['c1'])
  })

  it('stops early when told to (another writer published the same version)', async () => {
    let calls = 0
    const failing = async () => { calls += 1; throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }) }
    await expect(renameRetrying('a', 'b', { delays: FAST, rename: failing, stop: async () => true })).rejects.toMatchObject({ code: 'EBUSY' })
    expect(calls).toBe(1)
    calls = 0
    await expect(renameRetrying('a', 'b', { delays: FAST, rename: failing })).rejects.toMatchObject({ code: 'EBUSY' })
    expect(calls).toBe(FAST.length + 1)
  })

  it('treats EACCES as transient only on Windows', async () => {
    const eacces = Object.assign(new Error('EACCES'), { code: 'EACCES' })
    expect([...transientRenameCodes('win32')].sort()).toEqual(['EACCES', 'EBUSY', 'EPERM'])
    expect([...transientRenameCodes('linux')].sort()).toEqual(['EBUSY', 'EPERM'])
    expect(isTransientFsError(eacces, 'win32')).toBe(true)
    expect(isTransientFsError(eacces, 'linux')).toBe(false)
    if (process.platform !== 'win32') {
      let calls = 0
      await expect(renameRetrying('a', 'b', { delays: FAST, rename: async () => { calls += 1; throw eacces } })).rejects.toBe(eacces)
      expect(calls).toBe(1)
    }
  })
})

describe('the trial lock on Windows (EPERM on create)', () => {
  it('writeTrialLock retries a transient EPERM and writes the pid', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexgent-triallock-'))
    dirs.push(root)
    await mkdir(join(root, 'trials'))
    let calls = 0
    const busy = (async (path: string, flags: string, mode: number) => {
      calls += 1
      if (calls <= 2) throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
      return open(path, flags, mode)
    }) as typeof open
    const trialId = '11111111-1111-4111-8111-111111111111'
    await writeTrialLock(root, trialId, 4242, { open: busy, delays: FAST })
    expect(calls).toBe(3)
    expect(await readFile(join(root, 'trials', `${trialId}.lock`), 'utf8')).toBe('4242\n')
    await releaseTrialLock(root, trialId)
    expect(await readdir(join(root, 'trials'))).toEqual([])
  })
})
