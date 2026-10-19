// Rework D3: the CLI waits for learning after a run (Ctrl+C skips) and prints cost-cap warnings.
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EXIT, InterruptController, createRenderer, main, nextInterruptAction } from '../src/index.js'
import { Capture, FakeRuntime, testIo, writeFileTurn } from './helpers.js'

let tmp: string
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nexgent-cli-d3-'))
})
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

const credentials = { env: { NEXGENT_API_KEY: 'k' }, home: path.join(os.tmpdir(), 'nexgent-cli-d3-no-home') }

describe('waiting for learning', () => {
  it('waits for the learning this run started before it exits', async () => {
    const waits: number[] = []
    const runtime = new FakeRuntime(writeFileTurn(), {
      learning: { busy: () => true, wait: async (_signal, timeoutMs) => (waits.push(timeoutMs), 'idle') },
    })
    const t = testIo(tmp)
    expect(await main(['run', '--project', tmp, '--task', 't'], t.io, { credentials, loadRuntime: async () => runtime, learningWaitMs: 1234 })).toBe(EXIT.OK)
    expect(waits).toEqual([1234])
    expect(t.stderr.text).toContain('nexgent: learning from this run (Ctrl+C to skip; it continues the next time)')
    expect(runtime.closed).toBe(1)
  })

  it('does not wait when nothing is learning, and says so when the wait times out', async () => {
    const quiet = testIo(tmp)
    await main(['run', '--project', tmp, '--task', 't'], quiet.io, { credentials, loadRuntime: async () => new FakeRuntime(writeFileTurn(), { learning: { busy: () => false, wait: async () => 'idle' } }) })
    expect(quiet.stderr.text).not.toContain('learning')
    const slow = testIo(tmp)
    const code = await main(['run', '--project', tmp, '--task', 't'], slow.io, { credentials, loadRuntime: async () => new FakeRuntime(writeFileTurn(), { learning: { busy: () => true, wait: async () => 'timeout' } }) })
    expect(code).toBe(EXIT.OK)
    expect(slow.stderr.text).toContain('learning is taking long; it continues the next time Nexgent runs in this project')
  })

  it('Ctrl+C while waiting stops the wait, not the process', () => {
    expect(nextInterruptAction('waiting', 'SIGINT')).toEqual({ action: { kind: 'stop-wait' }, phase: 'idle' })
    const exits: number[] = []
    const notes: string[] = []
    const controller = new InterruptController({ exit: code => exits.push(code), notify: note => notes.push(note) })
    const signal = controller.beginWait()
    controller.handle('SIGINT')
    expect(signal.aborted).toBe(true)
    expect(exits).toEqual([])
    expect(notes[0]).toContain('not waiting for learning')
    // A second Ctrl+C exits as usual.
    controller.handle('SIGINT')
    expect(exits).toEqual([130])
  })
})

describe('cost warnings', () => {
  it('prints a warning and a reached cap on stderr', () => {
    const stdout = new Capture()
    const stderr = new Capture()
    const r = createRenderer('text', stdout, stderr)
    r.render({ type: 'cost.warning', turn: 1, scope: 'perTask', level: 'warning', limit: 'maxUsd', used: 0.8, cap: 1, estimated: false })
    r.render({ type: 'cost.warning', turn: 1, scope: 'perProject', level: 'reached', limit: 'maxTokens', used: 5000, cap: 5000, estimated: true })
    expect(stderr.text).toBe([
      'nexgent: used 80% of the per-task cost cap: 0.80 USD of 1.00 USD',
      'nexgent: reached the per-project cost cap: 5000 tokens of 5000 tokens (estimated)',
      '',
    ].join('\n'))
    expect(stdout.text).toBe('')
  })
})
