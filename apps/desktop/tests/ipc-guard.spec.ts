import { describe, expect, it, vi } from 'vitest'
import { NexgentError } from '@nexgent/kernel'
import { createCallHandler, methodForLog, TokenRegistry, type CallerInfo } from '../src/main/ipc-guard.js'
import type { Logger } from '../src/main/logger.js'
import { originChecker } from '../src/main/origin.js'

function memoryLogger(): Logger & { lines: string[] } {
  const lines: string[] = []
  const push = (level: string) => (message: string) => lines.push(`${level} ${message}`)
  return { lines, debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') }
}

function setup(options: { interceptors?: Parameters<typeof createCallHandler>[0]['interceptors'] } = {}) {
  const tokens = new TokenRegistry()
  const token = TokenRegistry.generate()
  tokens.register(7, token)
  const call = vi.fn(async (method: string, input: unknown) => ({ method, input }))
  const log = memoryLogger()
  const handle = createCallHandler({
    sdk: { call: call as never },
    tokens,
    isAllowedOrigin: originChecker(undefined),
    log,
    ...(options.interceptors === undefined ? {} : { interceptors: options.interceptors }),
  })
  const caller: CallerInfo = { windowId: 7, isTopFrame: true, url: 'app://nexgent/index.html' }
  return { tokens, token, call, log, handle, caller }
}

describe('TokenRegistry', () => {
  it('generates 32 random bytes as base64url', () => {
    const a = TokenRegistry.generate()
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(Buffer.from(a, 'base64url')).toHaveLength(32)
    expect(TokenRegistry.generate()).not.toBe(a)
  })

  it('verifies only the token bound to that window, and forgets it on revoke', () => {
    const tokens = new TokenRegistry()
    const a = TokenRegistry.generate()
    const b = TokenRegistry.generate()
    tokens.register(1, a)
    tokens.register(2, b)
    expect(tokens.verify(1, a)).toBe(true)
    expect(tokens.verify(1, b)).toBe(false)
    expect(tokens.verify(3, a)).toBe(false)
    expect(tokens.verify(1, a.slice(1))).toBe(false)
    expect(tokens.verify(1, undefined)).toBe(false)
    expect(tokens.verify(1, { toString: () => a })).toBe(false)
    tokens.revoke(1)
    expect(tokens.verify(1, a)).toBe(false)
    expect(tokens.size).toBe(1)
  })
})

describe('nexgent:call handler', () => {
  it('passes a valid call to the SDK and wraps the result', async () => {
    const { handle, caller, token, call } = setup()
    const response = await handle(caller, { token, method: 'sessions.list', input: { projectId: 'p1' } })
    expect(response).toEqual({ ok: true, result: { method: 'sessions.list', input: { projectId: 'p1' } } })
    expect(call).toHaveBeenCalledOnce()
  })

  it.each([
    ['no token', (t: string) => ({ method: 'app.info', input: {} }), 'token'],
    ['empty token', () => ({ token: '', method: 'app.info', input: {} }), 'token'],
    ['wrong token', () => ({ token: TokenRegistry.generate(), method: 'app.info', input: {} }), 'token'],
    ['truncated token', (t: string) => ({ token: t.slice(0, 20), method: 'app.info', input: {} }), 'token'],
    ['method off the whitelist', (t: string) => ({ token: t, method: 'fs.readFile', input: {} }), 'method'],
    ['prototype key as method', (t: string) => ({ token: t, method: 'constructor', input: {} }), 'method'],
    ['bad input', (t: string) => ({ token: t, method: 'projects.open', input: { root: 'relative' } }), 'input'],
    ['input not an object', (t: string) => ({ token: t, method: 'app.info', input: 'x' }), 'input'],
    ['payload not an object', () => 'nexgent', 'token'],
  ] as const)('denies %s without reaching the SDK', async (_name, payload, check) => {
    const { handle, caller, token, call, log } = setup()
    const response = await handle(caller, payload(token))
    expect(response.ok).toBe(false)
    if (response.ok) return
    expect(response.error.code).toBe('approval/denied')
    expect(response.error.details).toEqual({ check })
    expect(call).not.toHaveBeenCalled()
    expect(log.lines).toHaveLength(1)
    expect(log.lines[0]).toMatch(new RegExp(`^warn ipc denied window=7 method=\\S+ check=${check}`))
    expect(log.lines[0]).not.toContain(token)
  })

  it.each([
    ['another origin', { windowId: 7, isTopFrame: true, url: 'https://example.com/' }],
    ['a file:// page', { windowId: 7, isTopFrame: true, url: 'file:///tmp/index.html' }],
    ['a sub-frame', { windowId: 7, isTopFrame: false, url: 'app://nexgent/index.html' }],
    ['a sender that is not our window', { windowId: undefined, isTopFrame: true, url: 'app://nexgent/index.html' }],
  ])('denies calls from %s even with the right token', async (_name, caller) => {
    const { handle, token, call, log } = setup()
    const response = await handle(caller, { token, method: 'app.info', input: {} })
    expect(response.ok === false && response.error.details).toEqual({ check: 'sender' })
    expect(call).not.toHaveBeenCalled()
    expect(log.lines[0]).toContain('check=sender')
  })

  it('denies a token issued to another window', async () => {
    const { handle, tokens, call } = setup()
    const other = TokenRegistry.generate()
    tokens.register(8, other)
    const response = await handle({ windowId: 7, isTopFrame: true, url: 'app://nexgent/' }, { token: other, method: 'app.info', input: {} })
    expect(response.ok).toBe(false)
    expect(call).not.toHaveBeenCalled()
  })

  it('accepts the dev origin only when configured', async () => {
    const tokens = new TokenRegistry()
    const token = TokenRegistry.generate()
    tokens.register(1, token)
    const call = vi.fn(async () => 'ok')
    const caller = { windowId: 1, isTopFrame: true, url: 'http://localhost:5173/' }
    const withDev = createCallHandler({ sdk: { call: call as never }, tokens, isAllowedOrigin: originChecker('http://localhost:5173'), log: memoryLogger() })
    const withoutDev = createCallHandler({ sdk: { call: call as never }, tokens, isAllowedOrigin: originChecker(undefined), log: memoryLogger() })
    expect((await withDev(caller, { token, method: 'app.info', input: {} })).ok).toBe(true)
    expect((await withoutDev(caller, { token, method: 'app.info', input: {} })).ok).toBe(false)
  })

  it('returns SDK errors as ErrorInfo', async () => {
    const { handle, caller, token, call } = setup()
    call.mockRejectedValueOnce(new NexgentError('session/locked', 'locked', { details: { pid: 1 } }))
    expect(await handle(caller, { token, method: 'turns.send', input: { projectId: 'p', sessionId: 's', text: 'x' } })).toEqual({
      ok: false,
      error: { name: 'NexgentError', code: 'session/locked', message: 'locked', details: { pid: 1 } },
    })
    call.mockRejectedValueOnce(new TypeError('boom'))
    expect(await handle(caller, { token, method: 'app.info', input: {} })).toEqual({ ok: false, error: { name: 'TypeError', code: 'internal', message: 'boom' } })
  })

  it('never logs the API key value, also when its call is denied', async () => {
    const { handle, caller, token, log } = setup()
    const key = 'sk-ant-should-never-appear'
    await handle(caller, { token, method: 'settings.setApiKey', input: { value: key, extra: key } })
    await handle(caller, { token: 'bad', method: 'settings.setApiKey', input: { value: key } })
    expect(log.lines).toHaveLength(2)
    for (const line of log.lines) expect(line).not.toContain(key)
  })

  it('runs interceptors only after every guard check', async () => {
    const interceptor = vi.fn(async (input: Record<string, unknown>) => ({ intercepted: input['outDir'] }))
    const { handle, caller, token, call } = setup({ interceptors: { 'sessions.export': interceptor } })
    const input = { projectId: 'p', sessionId: 's', outDir: process.platform === 'win32' ? 'C:\\out' : '/out' }
    expect(await handle(caller, { token: 'bad', method: 'sessions.export', input })).toMatchObject({ ok: false })
    expect(interceptor).not.toHaveBeenCalled()
    expect(await handle(caller, { token, method: 'sessions.export', input })).toEqual({ ok: true, result: { intercepted: input.outDir } })
    expect(call).not.toHaveBeenCalled()
  })

  it('renders only well-formed method names into the log', () => {
    expect(methodForLog('turns.send')).toBe('turns.send')
    expect(methodForLog('x\ny')).toBe('<invalid>')
    expect(methodForLog('a'.repeat(100))).toBe('<invalid>')
    expect(methodForLog(undefined)).toBe('<invalid>')
  })
})
