import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  appendPartialLine,
  deadline,
  isProcessAlive,
  killProcessTree,
  TimeoutError,
  truncateFile,
  waitFor,
  withTimeout,
} from '../src/index.js'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})
async function tempFile(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'nexgent-ts-'))
  dirs.push(dir)
  const path = join(dir, 'f.jsonl')
  await writeFile(path, content)
  return path
}

describe('truncateFile', () => {
  it('cuts at a byte or drops trailing bytes, clamped', async () => {
    const path = await tempFile('0123456789')
    expect(await truncateFile(path, { atByte: 7 })).toEqual({ originalSize: 10, newSize: 7 })
    expect(await readFile(path, 'utf8')).toBe('0123456')
    expect(await truncateFile(path, { dropLastBytes: 2 })).toEqual({ originalSize: 7, newSize: 5 })
    expect(await readFile(path, 'utf8')).toBe('01234')
    expect((await truncateFile(path, { dropLastBytes: 99 })).newSize).toBe(0)
    expect((await truncateFile(path, { atByte: 99 })).newSize).toBe(0)
  })

  it('appendPartialLine leaves an unterminated line', async () => {
    const path = await tempFile('{"a":1}\n')
    await appendPartialLine(path, '{"b":\n')
    expect(await readFile(path, 'utf8')).toBe('{"a":1}\n{"b":')
  })
})

describe('killProcessTree', () => {
  it('kills a process and ignores already-dead pids', async () => {
    const proc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    const exited = new Promise((resolve) => proc.on('exit', resolve))
    expect(isProcessAlive(proc.pid!)).toBe(true)
    await killProcessTree(proc.pid!)
    await withTimeout(exited, 5000, 'child exit')
    await waitFor(() => !isProcessAlive(proc.pid!), { timeoutMs: 2000 })
    await expect(killProcessTree(proc.pid!)).resolves.toBeUndefined()
  })
})

describe('withTimeout / deadline / waitFor', () => {
  it('withTimeout passes values through and rejects late work', async () => {
    expect(await withTimeout(Promise.resolve(5), 100)).toBe(5)
    await expect(withTimeout(new Promise(() => {}), 20, 'stuck')).rejects.toThrow(/stuck timed out after 20ms/)
    await expect(withTimeout(Promise.reject(new Error('boom')), 100)).rejects.toThrow('boom')
  })

  it('deadline aborts its signal and bounds race()', async () => {
    const d = deadline(40)
    expect(d.remainingMs()).toBeGreaterThan(0)
    await expect(d.race(new Promise(() => {}), 'step')).rejects.toBeInstanceOf(TimeoutError)
    await waitFor(() => d.signal.aborted, { timeoutMs: 1000 })
    expect(d.expired()).toBe(true)
    expect(d.signal.reason).toBeInstanceOf(TimeoutError)
    d.clear()
  })

  it('waitFor returns the truthy value or times out', async () => {
    let n = 0
    expect(await waitFor(() => (++n >= 3 ? n : undefined), { intervalMs: 1 })).toBe(3)
    await expect(waitFor(() => false, { timeoutMs: 20, label: 'never' })).rejects.toThrow(/never not met/)
  })
})
