import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { readFile, utimes, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { isNexgentError, NexgentError, type NexgentErrorCode } from '@nexgent/kernel'
import { isProcessAlive, JsonlSessionStore, parseLockFile } from '../src/index.js'
import { SESSION_ID, sessionInit, tempDir } from './helpers.js'

const CHILD = fileURLToPath(new URL('./fixtures/lock-child.ts', import.meta.url))
const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url))

async function rejection(promise: Promise<unknown>): Promise<NexgentError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof NexgentError) return error
    throw error
  }
  throw new Error('expected a rejection')
}

async function newStores() {
  const root = await tempDir()
  const sessionsDir = `${root}/.nexgent/sessions`
  const a = new JsonlSessionStore({ sessionsDir, checkpointOnRelease: false })
  const b = new JsonlSessionStore({ sessionsDir, checkpointOnRelease: false })
  return { root, sessionsDir, a, b }
}

/** A pid that certainly belonged to a process that has exited. */
function deadPid(): number {
  const result = spawnSync(process.execPath, ['-e', ''])
  if (result.pid === undefined) throw new Error('could not spawn')
  return result.pid
}

function firstLine(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = ''
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk
      const end = buffer.indexOf('\n')
      if (end !== -1) resolve(buffer.slice(0, end))
    })
    child.on('error', reject)
    child.on('exit', code => {
      if (!buffer.includes('\n')) reject(new Error(`child exited (${code}) without output`))
    })
  })
}

function spawnChild(sessionsDir: string, mode: 'lock' | 'create'): ChildProcess {
  return spawn(process.execPath, ['--import', 'tsx', CHILD, sessionsDir, SESSION_ID, mode], {
    cwd: PACKAGE_DIR,
    stdio: ['pipe', 'pipe', 'inherit'],
  })
}

function exited(child: ChildProcess): Promise<void> {
  return new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) resolve()
    else child.once('exit', () => resolve())
  })
}

describe('session lock: in-process', () => {
  it('a second store cannot lock or append while the first holds the lock', async () => {
    const { root, a, b } = await newStores()
    const lock = await a.create(sessionInit(root))
    const error = await rejection(b.lock(SESSION_ID))
    expect(error.code).toBe('session/locked')
    expect(error.details).toMatchObject({ pid: process.pid, host: hostname(), ts: lock.info.ts })
    expect((await rejection(b.append(SESSION_ID, { type: 'turn.start', turn: 1 }))).code).toBe('session/locked')
    expect((await rejection(a.lock(SESSION_ID))).code).toBe('session/locked')
    await a.release(lock)
    const lock2 = await b.lock(SESSION_ID)
    expect(lock2.info.pid).toBe(process.pid)
    await b.release(lock2)
  })

  it('concurrent create/lock from two stores: exactly one succeeds', async () => {
    const { root, a, b } = await newStores()
    const results = await Promise.allSettled([a.create(sessionInit(root)), b.create(sessionInit(root))])
    const ok = results.filter(result => result.status === 'fulfilled')
    expect(ok).toHaveLength(1)
    const failed = results.find(result => result.status === 'rejected')
    expect(['session/locked', 'session/exists']).toContain((failed?.reason as NexgentError).code)
    await a.close()
    await b.close()

    const locks = await Promise.allSettled([a.lock(SESSION_ID), b.lock(SESSION_ID)])
    expect(locks.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(isNexgentError(locks.find(result => result.status === 'rejected')?.reason, 'session/locked')).toBe(true)
    await a.close()
    await b.close()
  })

  it('takes over a stale lock left by a dead pid on this host', async () => {
    const { root, a, b } = await newStores()
    await a.release(await a.create(sessionInit(root)))
    const path = a.lockFile(SESSION_ID)
    const pid = deadPid()
    expect(isProcessAlive(pid)).toBe(false)
    await writeFile(path, JSON.stringify({ pid, ts: '2026-01-01T00:00:00.000Z', host: hostname() }))
    const lock = await b.lock(SESSION_ID)
    expect(parseLockFile(await readFile(path, 'utf8'))).toEqual(lock.info)
    expect(lock.info.pid).toBe(process.pid)
    await b.release(lock)
  })

  it('never takes over a lock from another host, even with a dead pid', async () => {
    const { root, a, b } = await newStores()
    await a.release(await a.create(sessionInit(root)))
    await writeFile(a.lockFile(SESSION_ID), JSON.stringify({ pid: deadPid(), ts: '2026-01-01T00:00:00.000Z', host: 'elsewhere' }))
    const error = await rejection(b.lock(SESSION_ID))
    expect(error.code).toBe('session/locked')
    expect(error.details).toMatchObject({ host: 'elsewhere' })
  })

  it('uses the injected liveness probe and identity', async () => {
    const { root, sessionsDir, a } = await newStores()
    await a.release(await a.create(sessionInit(root)))
    const ghost = new JsonlSessionStore({ sessionsDir, pid: 424242, host: 'h', checkpointOnRelease: false })
    await ghost.lock(SESSION_ID) // never released: simulates a crashed holder
    const alive = new JsonlSessionStore({ sessionsDir, host: 'h', isAlive: () => true })
    expect((await rejection(alive.lock(SESSION_ID))).code).toBe('session/locked')
    const dead = new JsonlSessionStore({ sessionsDir, host: 'h', isAlive: pid => pid !== 424242 })
    const lock = await dead.lock(SESSION_ID)
    expect(lock.info).toMatchObject({ pid: process.pid, host: 'h' })
    await dead.release(lock)
  })

  it('an unparsable lock file is respected while fresh and taken over once abandoned', async () => {
    const { root, a, b } = await newStores()
    await a.release(await a.create(sessionInit(root)))
    const path = a.lockFile(SESSION_ID)
    await writeFile(path, '')
    expect((await rejection(b.lock(SESSION_ID))).code).toBe('session/locked')
    const old = new Date(Date.now() - 60_000)
    await utimes(path, old, old)
    await b.release(await b.lock(SESSION_ID))
  })

  it('release leaves a lock that another process has taken over', async () => {
    const { root, a } = await newStores()
    const lock = await a.create(sessionInit(root))
    const foreign = JSON.stringify({ pid: 1, ts: '2026-01-01T00:00:00.000Z', host: 'other' })
    await writeFile(lock.path, foreign)
    await a.release(lock)
    expect(await readFile(lock.path, 'utf8')).toBe(foreign)
  })
})

describe('session lock: cross-process', () => {
  it('a lock held by a live child process rejects session/locked; once it is killed the lock is taken over', async () => {
    const { root, a, sessionsDir } = await newStores()
    await a.release(await a.create(sessionInit(root)))
    const child = spawnChild(sessionsDir, 'lock')
    try {
      const line = await firstLine(child)
      expect(line).toBe(`ok ${child.pid}`)
      const error = await rejection(a.lock(SESSION_ID))
      expect(error.code satisfies NexgentErrorCode).toBe('session/locked')
      expect(error.details).toMatchObject({ pid: child.pid })
    } finally {
      child.kill('SIGKILL')
      await exited(child)
    }
    // The child died holding the lock: its file is stale and is taken over.
    const lock = await a.lock(SESSION_ID)
    expect(lock.info.pid).toBe(process.pid)
    await a.release(lock)
  }, 30_000)

  it('two processes creating the same session: exactly one succeeds', async () => {
    const { sessionsDir } = await newStores()
    const children = [spawnChild(sessionsDir, 'create'), spawnChild(sessionsDir, 'create')]
    try {
      const lines = await Promise.all(children.map(firstLine))
      expect(lines.filter(line => line.startsWith('ok '))).toHaveLength(1)
      expect(['session/locked', 'session/exists']).toContain(lines.find(line => !line.startsWith('ok ')))
    } finally {
      for (const child of children) child.stdin?.end()
      await Promise.all(children.map(exited))
    }
  }, 30_000)

  it('respects a lock file written by a plain node process in the spec format', async () => {
    const { root, a } = await newStores()
    await a.release(await a.create(sessionInit(root)))
    const script = [
      "const fs = require('node:fs'), os = require('node:os')",
      "fs.writeFileSync(process.argv[1], JSON.stringify({ pid: process.pid, ts: new Date().toISOString(), host: os.hostname() }), { flag: 'wx' })",
      "process.stdout.write('ok ' + process.pid + '\\n')",
      'process.stdin.resume()',
    ].join('\n')
    const child = spawn(process.execPath, ['-e', script, a.lockFile(SESSION_ID)], { stdio: ['pipe', 'pipe', 'inherit'] })
    try {
      expect(await firstLine(child)).toBe(`ok ${child.pid}`)
      expect((await rejection(a.lock(SESSION_ID))).details).toMatchObject({ pid: child.pid })
    } finally {
      child.kill('SIGKILL')
      await exited(child)
    }
    await a.release(await a.lock(SESSION_ID))
  }, 30_000)
})
