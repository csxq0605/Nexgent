import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { CALL_CHANNEL, EVENT_CHANNEL, TOKEN_ARG_PREFIX } from '../src/main/ipc-types.js'

// The compiled preload (`pnpm build` runs before the tests), run the way Electron runs a
// sandboxed preload: a CommonJS function whose `require` only knows `electron`.
const PRELOAD = fileURLToPath(new URL('../dist/preload/index.cjs', import.meta.url))

function loadPreload(argv: string[]) {
  const exposed: Record<string, unknown> = {}
  const sent: Array<{ channel: string; payload: unknown }> = []
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  let reply: unknown = { ok: true, result: 'r' }
  const electron = {
    contextBridge: {
      exposeInMainWorld: (key: string, api: unknown) => {
        exposed[key] = api
      },
    },
    ipcRenderer: {
      invoke: async (channel: string, payload: unknown) => {
        sent.push({ channel, payload })
        return reply
      },
      on: (channel: string, listener: (...args: unknown[]) => void) => {
        if (!listeners.has(channel)) listeners.set(channel, new Set())
        listeners.get(channel)!.add(listener)
      },
      removeListener: (channel: string, listener: (...args: unknown[]) => void) => {
        listeners.get(channel)?.delete(listener)
      },
    },
  }
  const required: string[] = []
  const fakeRequire = (id: string): unknown => {
    required.push(id)
    if (id === 'electron') return electron
    throw new Error(`sandboxed preload cannot require ${id}`)
  }
  const module = { exports: {} }
  const source = readFileSync(PRELOAD, 'utf8')
  const wrapper = runInNewContext(`(function (exports, require, module, process) {${source}\n})`, {}) as (...args: unknown[]) => void
  wrapper(module.exports, fakeRequire, module, { argv, platform: 'linux' })
  return {
    bridge: exposed['nexgent'] as {
      invoke: (method: string, input: unknown) => Promise<unknown>
      onEvent: (listener: (event: unknown) => void) => () => void
      platform: string
    },
    exposedKeys: Object.keys(exposed),
    sent,
    listeners,
    required,
    setReply: (value: unknown) => {
      reply = value
    },
  }
}

describe('preload', () => {
  const argv = ['/electron', '--type=renderer', `${TOKEN_ARG_PREFIX}the-token`, '--other']

  it('requires nothing but electron', () => {
    expect(loadPreload(argv).required).toEqual(['electron'])
    // Plain `require` would also resolve local files outside the sandbox; make sure none is referenced.
    expect(readFileSync(PRELOAD, 'utf8').match(/require\(["'][^"']+["']\)/g)).toEqual(['require("electron")'])
  })

  it('exposes exactly invoke, onEvent and platform under window.nexgent', () => {
    const { bridge, exposedKeys } = loadPreload(argv)
    expect(exposedKeys).toEqual(['nexgent'])
    expect(Object.keys(bridge).sort()).toEqual(['invoke', 'onEvent', 'platform'])
    expect(bridge.platform).toBe('linux')
    expect(JSON.stringify(bridge)).not.toContain('the-token')
  })

  it('sends the token from argv with every call on the call channel', async () => {
    const { bridge, sent } = loadPreload(argv)
    expect(await bridge.invoke('app.info', {})).toBe('r')
    expect(sent).toEqual([{ channel: CALL_CHANNEL, payload: { token: 'the-token', method: 'app.info', input: {} } }])
  })

  it('sends an empty token when argv carries none (the main process then denies)', async () => {
    const { bridge, sent } = loadPreload(['/electron'])
    await bridge.invoke('app.info', {})
    expect(sent[0]?.payload).toMatchObject({ token: '' })
  })

  it('rejects with the plain ErrorInfo of a failed call', async () => {
    const { bridge, setReply } = loadPreload(argv)
    const error = { name: 'NexgentError', code: 'approval/denied', message: 'denied', details: { check: 'token' } }
    setReply({ ok: false, error })
    await expect(bridge.invoke('app.info', {})).rejects.toEqual(error)
  })

  it('delivers events from the event channel and unsubscribes', () => {
    const { bridge, listeners } = loadPreload(argv)
    const seen: unknown[] = []
    const off = bridge.onEvent((event) => seen.push(event))
    const [listener] = [...listeners.get(EVENT_CHANNEL)!]
    listener!({ sender: 'ipc' }, { type: 'turn.start' })
    expect(seen).toEqual([{ type: 'turn.start' }])
    off()
    expect(listeners.get(EVENT_CHANNEL)!.size).toBe(0)
  })

  it('uses the same channel names and token switch as the main process', () => {
    const source = readFileSync(PRELOAD, 'utf8')
    expect(source).toContain(`const CALL_CHANNEL = '${CALL_CHANNEL}'`)
    expect(source).toContain(`const EVENT_CHANNEL = '${EVENT_CHANNEL}'`)
    expect(source).toContain(`const TOKEN_ARG_PREFIX = '${TOKEN_ARG_PREFIX}'`)
  })
})
