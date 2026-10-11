import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NexgentError } from '@nexgent/kernel'
import { EXIT, main, RESUME_DEFAULT_TASK } from '../src/index.js'
import { FakeRuntime, SID, testIo, writeFileTurn } from './helpers.js'

let tmp: string
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nexgent-cli-main-'))
})
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

const noKeyProbe = { env: {}, home: path.join(os.tmpdir(), 'nexgent-cli-main-no-home') }

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

  it('app exits 2 when the desktop app is not there', async () => {
    const t = testIo(tmp, { NEXGENT_DESKTOP_DIR: path.join(tmp, 'no-desktop') })
    expect(await main(['app', '--project', tmp], t.io)).toBe(2)
    expect(t.stderr.text).toContain('desktop app not found')
  })

  it('app starts the desktop app detached, with the project', async () => {
    const launched: unknown[] = []
    const t = testIo(tmp)
    expect(await main(['app', '--project', tmp], t.io, { launchDesktop: async options => void launched.push(options) })).toBe(EXIT.OK)
    expect(launched).toEqual([{ env: t.io.env, project: path.resolve(tmp) }])
    expect(await main(['app'], testIo(tmp).io, { launchDesktop: async options => void launched.push(options) })).toBe(EXIT.OK)
    expect(launched[1]).not.toHaveProperty('project')
  })

  it('stops with exit 3 when no API key is configured, after creating the layout', async () => {
    const t = testIo(tmp, {})
    const runtime = new FakeRuntime(writeFileTurn())
    expect(await main(['run', '--project', tmp, '--task', 't'], t.io, { credentials: noKeyProbe, loadRuntime: async () => runtime })).toBe(EXIT.ENVIRONMENT)
    expect(t.stderr.text).toContain('no model API key configured')
    expect(runtime.opened).toHaveLength(0)
    await fs.access(path.join(tmp, '.nexgent', 'sessions'))
  })

  it('passes --sandbox and --model through to the runtime', async () => {
    const t = testIo(tmp)
    const runtime = new FakeRuntime(writeFileTurn())
    const code = await main(['run', '--project', tmp, '--task', 'write hello', '--sandbox', 'read-only', '--model', 'm'], t.io, {
      credentials: { ...noKeyProbe, env: { NEXGENT_API_KEY: 'k' } },
      loadRuntime: async () => runtime,
    })
    expect(code).toBe(EXIT.OK)
    expect(runtime.opened[0]).toMatchObject({ sandboxMode: 'read-only', model: 'm' })
    expect(runtime.opened[0]?.layout.root).toBe(path.resolve(tmp))
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

  // The first Ctrl+C (cancel, exit 130) is covered against the real SDK in e2e.spec.ts.
  it('a second Ctrl+C before the turn can close forces the exit', async () => {
    const events = writeFileTurn()
    const t = testIo(tmp)
    const stuck = new FakeRuntime(events, { hangAfter: 3 })
    const running = main(['run', '--project', tmp, '--task', 'long'], t.io, {
      credentials: { ...noKeyProbe, env: { NEXGENT_API_KEY: 'k' } },
      loadRuntime: async () => stuck,
    })
    await vi.waitFor(() => expect(stuck.tasks).toHaveLength(1), { timeout: 5000 })
    t.raise('SIGINT')
    t.raise('SIGINT')
    expect(t.exits).toEqual([130])
    await running
  })
})
