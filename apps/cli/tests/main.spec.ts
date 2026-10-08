import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NexgentError } from '@nexgent/kernel'
import { EXIT, main, RESUME_DEFAULT_TASK, RUNTIME_NOT_WIRED_MESSAGE } from '../src/index.js'
import { FakeRuntime, SID, testIo, writeFileTurn } from './helpers.js'

let tmp: string
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nexgent-cli-main-'))
})
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

const noKeyProbe = { env: {}, homedir: '/nowhere', readFile: async () => { throw new Error('ENOENT') } }

describe('main', () => {
  it('prints usage for no arguments and help / version on stdout', async () => {
    const t = testIo(tmp)
    expect(await main([], t.io)).toBe(EXIT.USAGE)
    expect(t.stderr.text).toContain('Usage: nexgent')
    expect(await main(['--help'], t.io)).toBe(EXIT.OK)
    expect(await main(['run', '--help'], t.io)).toBe(EXIT.OK)
    expect(t.stdout.text).toContain('Usage: nexgent run')
  })

  it('prints usage errors without a stack unless NEXGENT_DEBUG=1', async () => {
    const t = testIo(tmp)
    expect(await main(['run', '--project', tmp], t.io)).toBe(EXIT.USAGE)
    expect(t.stderr.text).toBe('nexgent: --task is required (see `nexgent --help`)\n')
    const d = testIo(tmp, { NEXGENT_DEBUG: '1' })
    await main(['run', '--project', tmp], d.io)
    expect(d.stderr.text).toContain('at parseCliArgs')
  })

  it('app is a step-2 placeholder with exit 2', async () => {
    const t = testIo(tmp)
    expect(await main(['app', '--project', tmp], t.io)).toBe(2)
    expect(t.stderr.text).toContain('step 2')
  })

  it('stops with exit 3 when no API key is configured, after creating the layout', async () => {
    const t = testIo(tmp, {})
    const runtime = new FakeRuntime(writeFileTurn())
    expect(await main(['run', '--project', tmp, '--task', 't'], t.io, { credentials: noKeyProbe, loadRuntime: async () => runtime })).toBe(EXIT.ENVIRONMENT)
    expect(t.stderr.text).toContain('no model API key configured')
    expect(runtime.opened).toHaveLength(0)
    await fs.access(path.join(tmp, '.nexgent', 'sessions'))
  })

  it('exits 2 with a clear message while the runtime is not wired', async () => {
    const t = testIo(tmp)
    const code = await main(['run', '--project', tmp, '--task', 't', '--json'], t.io, { credentials: { ...noKeyProbe, env: { NEXGENT_API_KEY: 'k' } } })
    expect(code).toBe(EXIT.USAGE)
    expect(t.stderr.text).toContain(RUNTIME_NOT_WIRED_MESSAGE)
    expect(JSON.parse(t.stdout.text)).toMatchObject({ type: 'error', error: { code: 'cli/runtime-not-wired' } })
  })

  it('runs a task through the runtime seam, renders it and records the outcome', async () => {
    const t = testIo(tmp)
    const runtime = new FakeRuntime(writeFileTurn())
    const code = await main(['run', '--project', tmp, '--task', 'write hello', '--sandbox', 'read-only', '--model', 'm'], t.io, {
      credentials: { ...noKeyProbe, env: { NEXGENT_API_KEY: 'k' } },
      loadRuntime: async () => runtime,
    })
    expect(code).toBe(EXIT.OK)
    expect(runtime.opened[0]).toMatchObject({ sandboxMode: 'read-only', model: 'm' })
    expect(runtime.opened[0]?.resumeSessionId).toBeUndefined()
    expect(runtime.opened[0]?.layout.root).toBe(path.resolve(tmp))
    expect(runtime.tasks).toEqual(['write hello'])
    expect(runtime.outcomes).toEqual([expect.objectContaining({ type: 'task.outcome', sessionId: SID, status: 'completed', toolsUsed: ['write_file'] })])
    expect(runtime.closed).toBe(1)
    expect(t.stdout.text).toBe('Created hello.txt.\n')
    expect(t.listenerCount()).toBe(0)
  })

  it('resumes with the default task when --task is omitted', async () => {
    const t = testIo(tmp)
    const runtime = new FakeRuntime(writeFileTurn(2))
    const code = await main(['resume', SID, '--project', tmp, '--json'], t.io, {
      credentials: { ...noKeyProbe, env: { NEXGENT_API_KEY: 'k' } },
      loadRuntime: async () => runtime,
    })
    expect(code).toBe(0)
    expect(runtime.opened[0]?.resumeSessionId).toBe(SID)
    expect(runtime.tasks).toEqual([RESUME_DEFAULT_TASK])
    const lines = t.stdout.text.trimEnd().split('\n').map(line => JSON.parse(line) as { type: string; resumed?: boolean })
    expect(lines[0]).toMatchObject({ type: 'session', resumed: true })
    expect(lines.at(-1)).toMatchObject({ type: 'final', status: 'completed' })
  })

  it('maps runtime open errors to exit codes', async () => {
    const t = testIo(tmp)
    const runtime = new FakeRuntime([], { openError: new NexgentError('session/locked', 'held by pid 1') })
    const code = await main(['resume', SID, '--project', tmp], t.io, {
      credentials: { ...noKeyProbe, env: { NEXGENT_API_KEY: 'k' } },
      loadRuntime: async () => runtime,
    })
    expect(code).toBe(EXIT.ENVIRONMENT)
    expect(t.stderr.text).toBe('nexgent: session/locked: held by pid 1\n')
  })

  it('cancels the turn on the first Ctrl+C and exits 130; a second Ctrl+C forces exit', async () => {
    const t = testIo(tmp)
    const events = writeFileTurn()
    const runtime = new FakeRuntime(events, { hangAfter: 10 })
    const running = main(['run', '--project', tmp, '--task', 'long'], t.io, {
      credentials: { ...noKeyProbe, env: { NEXGENT_API_KEY: 'k' } },
      loadRuntime: async () => runtime,
    })
    await vi.waitFor(() => expect(t.stdout.text).toBe('Created '), { timeout: 5000 })
    t.raise('SIGINT')
    expect(await running).toBe(EXIT.CANCELLED)
    expect(t.exits).toEqual([])
    expect(runtime.outcomes[0]).toMatchObject({ status: 'cancelled' })
    expect(t.stderr.text).toContain('press Ctrl+C again')
    expect(t.stderr.text).toContain('turn 1 cancelled (user)')
    expect(t.stdout.text).toBe('Created \n')

    const t2 = testIo(tmp)
    const stuck = new FakeRuntime(events, { hangAfter: 3 })
    // two Ctrl+C before the turn can close: the second one forces the exit
    const running2 = main(['run', '--project', tmp, '--task', 'long'], t2.io, {
      credentials: { ...noKeyProbe, env: { NEXGENT_API_KEY: 'k' } },
      loadRuntime: async () => stuck,
    })
    await vi.waitFor(() => expect(stuck.tasks).toHaveLength(1), { timeout: 5000 })
    t2.raise('SIGINT')
    t2.raise('SIGINT')
    expect(t2.exits).toEqual([130])
    await running2
  })
})
