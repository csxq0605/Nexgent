/**
 * The PTC process runtime: protocol, host calls, the empty environment, the
 * permission model, bounds, and that a stopped program leaves no process.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { processGroupAlive } from '@nexgent/workspace'
import { afterEach, describe, expect, it } from 'vitest'
import { parseProgramMessage, permissionFlag, programEnv, runProgram, type HostFunction } from '../src/index.js'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'nexgent-ptc-'))
  dirs.push(dir)
  return dir
}

/** Whether a program's process (group, on POSIX) is still alive; a zombie counts as gone. */
function leftover(pid: number | undefined): boolean {
  if (pid === undefined) return false
  if (process.platform !== 'win32') return processGroupAlive(pid)
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const add: HostFunction = { name: 'add', call: async ([a, b]) => (a as number) + (b as number) }

describe('runProgram', () => {
  it('runs the body, binds host functions and globals, captures output and returns the value', async () => {
    const result = await runProgram({
      cwd: await tempDir(),
      code: `console.log('sum', await add(2, 3)); process.stdout.write('raw\\n'); console.error('warn'); return { args, seen: typeof add }`,
      functions: [add],
      globals: { args: { n: 1 } },
    })
    expect(result).toMatchObject({ status: 'completed', value: { args: { n: 1 }, seen: 'function' }, calls: 1 })
    expect(result.output).toBe('sum 5\nraw\nwarn\n')
  })

  it('starts with an empty environment: no host variable, not even a secret, reaches the program', async () => {
    process.env.NEXGENT_API_KEY = 'sk-test-must-not-leak'
    process.env.PTC_PROBE = 'visible-to-host-only'
    try {
      const result = await runProgram({ cwd: await tempDir(), code: 'return { keys: Object.keys(process.env), key: process.env.NEXGENT_API_KEY ?? null, probe: process.env.PTC_PROBE ?? null }' })
      expect(result).toMatchObject({ status: 'completed', value: { keys: [], key: null, probe: null } })
      expect(JSON.stringify(result)).not.toContain('sk-test-must-not-leak')
    } finally {
      delete process.env.NEXGENT_API_KEY
      delete process.env.PTC_PROBE
    }
    expect(programEnv({ NEXGENT_API_KEY: 'x', PATH: '/bin' }, 'linux')).toEqual(process.versions.electron === undefined ? {} : { ELECTRON_RUN_AS_NODE: '1' })
    expect(programEnv({ NEXGENT_API_KEY: 'x', Path: 'C:\\Windows', SYSTEMROOT: 'C:\\Windows' }, 'win32')).toMatchObject({ PATH: 'C:\\Windows', SystemRoot: 'C:\\Windows' })
  })

  it('has no direct file system, child processes or worker threads (Node permission model)', async () => {
    const dir = await tempDir()
    const secret = join(dir, 'secret.txt')
    await writeFile(secret, 'top secret')
    const result = await runProgram({
      cwd: dir,
      code: `
        const out = {}
        const fs = await import('node:fs')
        try { out.read = fs.readFileSync(${JSON.stringify(secret)}, 'utf8') } catch (error) { out.read = error.code }
        try { fs.writeFileSync('x.txt', 'x'); out.write = 'written' } catch (error) { out.write = error.code }
        try { (await import('node:child_process')).spawnSync('node', ['-v']); out.spawn = 'spawned' } catch (error) { out.spawn = error.code }
        try { new (await import('node:worker_threads')).Worker('1', { eval: true }); out.worker = 'started' } catch (error) { out.worker = error.code }
        return out`,
    })
    expect(result).toMatchObject({ status: 'completed', value: { read: 'ERR_ACCESS_DENIED', write: 'ERR_ACCESS_DENIED', spawn: 'ERR_ACCESS_DENIED', worker: 'ERR_ACCESS_DENIED' } })
    expect(permissionFlag('22.12.0')).toBe('--experimental-permission')
    expect(permissionFlag('22.13.0')).toBe('--permission')
    expect(permissionFlag('24.1.0')).toBe('--permission')
  })

  it('stops a program at its deadline and leaves no process behind', async () => {
    const result = await runProgram({ cwd: await tempDir(), code: 'console.log("spinning"); while (true) {}', timeoutMs: 1_000 })
    expect(result.status).toBe('timeout')
    expect(result.error?.message).toContain('1000 ms')
    expect(result.output).toBe('spinning\n')
    expect(result.durationMs).toBeLessThan(10_000)
    expect(leftover(result.pid)).toBe(false)
  })

  it('stops a program when cancelled, also while it waits on a host call, and aborts that call', async () => {
    const controller = new AbortController()
    let callSignal: AbortSignal | undefined
    const wait: HostFunction = {
      name: 'wait',
      call: (_args, context) => {
        callSignal = context.signal
        setTimeout(() => controller.abort(), 50)
        return new Promise(() => {})
      },
    }
    const result = await runProgram({ cwd: await tempDir(), code: 'await wait(); return 1', functions: [wait], signal: controller.signal })
    expect(result.status).toBe('cancelled')
    expect(callSignal?.aborted).toBe(true)
    expect(leftover(result.pid)).toBe(false)
  })

  it('turns a host function error into a catchable HostError with its code', async () => {
    const fail: HostFunction = { name: 'fail', call: async () => { throw new Error('no such thing') } }
    const result = await runProgram({
      cwd: await tempDir(),
      code: 'try { await fail() } catch (error) { return { name: error.name, message: error.message } }',
      functions: [fail],
    })
    expect(result.value).toEqual({ name: 'HostError', message: 'no such thing' })
    const uncaught = await runProgram({ cwd: await tempDir(), code: 'await fail()', functions: [fail] })
    expect(uncaught).toMatchObject({ status: 'failed', error: { name: 'HostError', message: 'no such thing' } })
  })

  it('reports thrown errors, syntax errors, values that are not JSON and a process that exits on its own', async () => {
    const dir = await tempDir()
    expect(await runProgram({ cwd: dir, code: 'throw new TypeError("bad input")' })).toMatchObject({ status: 'failed', error: { name: 'TypeError', message: 'bad input' } })
    expect(await runProgram({ cwd: dir, code: 'return (' })).toMatchObject({ status: 'failed', error: { name: 'SyntaxError' } })
    expect(await runProgram({ cwd: dir, code: 'return 10n' })).toMatchObject({ status: 'failed', error: { name: 'TypeError' } })
    expect(await runProgram({ cwd: dir, code: 'return undefined' })).toMatchObject({ status: 'completed' })
    expect(await runProgram({ cwd: dir, code: 'Promise.reject(new Error("late")); await new Promise(() => {})' })).toMatchObject({ status: 'failed', error: { message: 'late' } })
    const exited = await runProgram({ cwd: dir, code: 'process.exit(3)' })
    expect(exited).toMatchObject({ status: 'crashed' })
    expect(exited.error?.message).toContain('exit code 3')
  })

  it('caps output and the returned value', async () => {
    const dir = await tempDir()
    const loud = await runProgram({ cwd: dir, code: 'for (let i = 0; i < 100; i++) console.log("x".repeat(99)); return "done"', maxOutputChars: 1_000 })
    expect(loud).toMatchObject({ status: 'completed', value: 'done', outputTruncated: true })
    expect(loud.output).toHaveLength(1_000)
    const big = await runProgram({ cwd: dir, code: 'return "y".repeat(5000)', maxValueChars: 1_000 })
    expect(big).toMatchObject({ status: 'failed', error: { name: 'RangeError' } })
    const huge = await runProgram({ cwd: dir, code: 'await add("z".repeat(50000), 1)', functions: [add], maxLineChars: 10_000 })
    expect(huge.status).toBe('failed')
    expect(huge.error?.message).toContain('exceeded 10000 characters')
    expect(leftover(huge.pid)).toBe(false)
  })

  it('runs host calls concurrently when the program does', async () => {
    let active = 0
    let peak = 0
    const slow: HostFunction = {
      name: 'slow',
      call: async ([value]) => {
        active += 1
        peak = Math.max(peak, active)
        await new Promise(resolve => setTimeout(resolve, 100))
        active -= 1
        return value ?? null
      },
    }
    const result = await runProgram({ cwd: await tempDir(), code: 'return await Promise.all([1, 2, 3].map(n => slow(n)))', functions: [slow] })
    expect(result.value).toEqual([1, 2, 3])
    expect(peak).toBe(3)
  })

  it('rejects host bindings that are not identifiers or are bound twice, and ignores non-frames', async () => {
    await expect(runProgram({ cwd: '.', code: '1', functions: [{ name: 'not ok', call: async () => null }] })).rejects.toMatchObject({ code: 'tool/invalid-input' })
    await expect(runProgram({ cwd: '.', code: '1', functions: [add], globals: { add: 1 } })).rejects.toMatchObject({ code: 'tool/invalid-input' })
    expect(parseProgramMessage('hello')).toBeUndefined()
    expect(parseProgramMessage('{"t":"call","id":"x","fn":"a","args":[]}')).toBeUndefined()
    expect(parseProgramMessage('{"t":"log","stream":"stdout","text":"a"}')).toEqual({ t: 'log', stream: 'stdout', text: 'a' })
  })
})
