import { readdir, readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { retryTransient, writeJsonAtomic } from '../src/index.js'
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
  it('retries a rename that fails with EPERM, EBUSY or EACCES and then lands', async () => {
    for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
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
