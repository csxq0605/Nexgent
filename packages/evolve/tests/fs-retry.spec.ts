import { open, readdir, readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isTransientFsError, retryTransient, TRANSIENT_FS_CODES, transientFsCodes, tryCreateLock, withFileLock, writeJsonAtomic } from '../src/index.js'
import { tempDir } from './helpers.js'

/** A rename that fails like Windows does while another process has the target open, `failures` times. */
function lockedRename(failures: number, code = 'EPERM') {
  const calls = { count: 0 }
  const fn = async (from: string, to: string) => {
    calls.count += 1
    if (calls.count <= failures) throw Object.assign(new Error(`${code}: operation not permitted, rename '${from}' -> '${to}'`), { code })
    await rename(from, to)
  }
  return { fn, calls }
}

const FAST = [1, 1, 1, 1]

describe('atomic JSON writes over a file another process holds open (Windows)', () => {
  it('retries a rename that fails with EPERM, EBUSY (or EACCES on Windows) and then lands', async () => {
    for (const code of TRANSIENT_FS_CODES) {
      const dir = await tempDir()
      const path = join(dir, 'job.json')
      await writeJsonAtomic(path, { status: 'queued' })
      const locked = lockedRename(3, code)
      await writeJsonAtomic(path, { status: 'trialing' }, { rename: locked.fn, delays: FAST })
      expect(locked.calls.count).toBe(4)
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ status: 'trialing' })
      expect((await readdir(dir)).filter(name => name.endsWith('.tmp'))).toEqual([])
    }
  })

  it('throws once the retries run out, keeps the old content and removes the temp file', async () => {
    const dir = await tempDir()
    const path = join(dir, 'job.json')
    await writeJsonAtomic(path, { status: 'queued' })
    const locked = lockedRename(100)
    await expect(writeJsonAtomic(path, { status: 'failed' }, { rename: locked.fn, delays: FAST })).rejects.toMatchObject({ code: 'EPERM' })
    expect(locked.calls.count).toBe(FAST.length + 1)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ status: 'queued' })
    expect(await readdir(dir)).toEqual(['job.json'])
  })

  it('does not retry other errors', async () => {
    let calls = 0
    await expect(retryTransient(async () => { calls += 1; throw Object.assign(new Error('gone'), { code: 'ENOENT' }) }, { delays: FAST })).rejects.toMatchObject({ code: 'ENOENT' })
    expect(calls).toBe(1)
  })
})

describe('EACCES is transient only on Windows', () => {
  it('counts EACCES as a sharing violation on win32 and as a real permission error elsewhere', () => {
    const eacces = Object.assign(new Error('EACCES'), { code: 'EACCES' })
    expect([...transientFsCodes('win32')].sort()).toEqual(['EACCES', 'EBUSY', 'EPERM'])
    expect([...transientFsCodes('linux')].sort()).toEqual(['EBUSY', 'EPERM'])
    expect(isTransientFsError(eacces, 'win32')).toBe(true)
    expect(isTransientFsError(eacces, 'linux')).toBe(false)
    expect(isTransientFsError(eacces, 'darwin')).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('on POSIX a lock that cannot be created for lack of permission fails at once instead of waiting out its deadline', async () => {
    const dir = await tempDir()
    let calls = 0
    const denied = async () => { calls += 1; throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }) }
    const started = Date.now()
    await expect(withFileLock(join(dir, 'queue.lock'), async () => 1, { timeoutMs: 5_000, pollMs: 5, io: { open: denied, delays: FAST } })).rejects.toMatchObject({ code: 'EACCES' })
    expect(calls).toBe(1)
    expect(Date.now() - started).toBeLessThan(1_000)
  })
})

describe('taking a lock while the old lock file is being deleted (Windows EPERM)', () => {
  /** An exclusive create that fails like Windows does `failures` times, then creates. */
  function busyOpen(failures: number, code = 'EPERM') {
    const calls = { count: 0 }
    const fn = async (path: string, flags: string, mode: number) => {
      calls.count += 1
      if (calls.count <= failures) throw Object.assign(new Error(`${code}: operation not permitted, open '${path}'`), { code })
      return open(path, flags, mode)
    }
    return { fn, calls }
  }

  it('tryCreateLock retries a transient EPERM and takes the lock; a persistent one counts as held', async () => {
    const dir = await tempDir()
    const path = join(dir, 'queue.lock')
    const busy = busyOpen(2)
    expect(await tryCreateLock(path, 4242, { open: busy.fn, delays: FAST })).toBe(true)
    expect(busy.calls.count).toBe(3)
    expect(await readFile(path, 'utf8')).toBe('4242\n')
    const always = busyOpen(1_000, 'EBUSY')
    expect(await tryCreateLock(join(dir, 'other.lock'), 4242, { open: always.fn, delays: FAST })).toBe(false)
  })

  it('withFileLock keeps waiting through EPERM and runs once the lock can be created', async () => {
    const dir = await tempDir()
    const path = join(dir, 'queue.lock')
    const busy = busyOpen(6, 'EBUSY')
    const result = await withFileLock(path, async () => {
      expect(await readFile(path, 'utf8')).toBe(`${process.pid}\n`)
      return 'ran'
    }, { pollMs: 1, timeoutMs: 5_000, io: { open: busy.fn, delays: [] } })
    expect(result).toBe('ran')
    expect(busy.calls.count).toBe(7)
    expect(await readdir(dir)).toEqual([])
  })

  it('withFileLock still gives up at its deadline when the lock never becomes available', async () => {
    const dir = await tempDir()
    const busy = busyOpen(1_000_000)
    await expect(withFileLock(join(dir, 'queue.lock'), async () => 'ran', { pollMs: 1, timeoutMs: 50, io: { open: busy.fn, delays: [] } })).rejects.toThrow(/could not take the lock/)
  })
})
