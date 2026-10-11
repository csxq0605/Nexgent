/**
 * The checks behind the single `nexgent:call` handler (`permissions.md`
 * §本地 IPC 与访问令牌): sender frame and origin, per-window token, method
 * whitelist, input shape — in that order. A failed check never reaches the
 * SDK; it answers `approval/denied` and logs one line naming the window, the
 * method and the failed check, never the token or the arguments.
 *
 * Nothing here imports Electron, so the whole decision runs under plain
 * Node in tests; `index.ts` adapts Electron's `IpcMainInvokeEvent` into a
 * {@link CallerInfo}.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { NexgentError, toErrorInfo } from '@nexgent/kernel'
import type { NexgentSdk, SdkMethodName } from '@nexgent/sdk'
import type { CallResponse, GuardCheck } from './ipc-types.js'
import type { Logger } from './logger.js'
import { isPlainObject, isWhitelisted, validateInput } from './validate.js'

/** Per-window tokens: generated when a window is created, dropped when it closes; memory only. */
export class TokenRegistry {
  readonly #tokens = new Map<number, Buffer>()

  /** A fresh token: 32 random bytes as base64url text. */
  static generate(): string {
    return randomBytes(32).toString('base64url')
  }

  /** Bind a token to a window (the token is generated before the window, which needs it at construction). */
  register(windowId: number, token: string): void {
    this.#tokens.set(windowId, Buffer.from(token, 'utf8'))
  }

  /** Invalidate a window's token. */
  revoke(windowId: number): void {
    this.#tokens.delete(windowId)
  }

  /** Constant-time comparison; a missing window, a non-string or a length mismatch is a plain `false`. */
  verify(windowId: number, token: unknown): boolean {
    const expected = this.#tokens.get(windowId)
    if (expected === undefined || typeof token !== 'string') return false
    const given = Buffer.from(token, 'utf8')
    if (given.length !== expected.length) return false
    return timingSafeEqual(given, expected)
  }

  /** Number of live tokens (tests). */
  get size(): number {
    return this.#tokens.size
  }
}

/** Who sent a call, as the Electron adapter observed it. */
export interface CallerInfo {
  /** `BrowserWindow.id` of the window owning the sender, or `undefined` when the sender is not one of ours. */
  readonly windowId: number | undefined
  /** Whether the sending frame is that window's top-level frame. */
  readonly isTopFrame: boolean
  /** The sending frame's current URL. */
  readonly url: string
}

/** A method the main process answers itself before (or instead of) the SDK, e.g. to put a dialog in front. */
export type Interceptor = (input: Record<string, unknown>, caller: CallerInfo) => Promise<unknown>

/** Options of {@link createCallHandler}. */
export interface CallHandlerOptions {
  readonly sdk: Pick<NexgentSdk, 'call'>
  readonly tokens: TokenRegistry
  /** Whether a page origin may call (`app://nexgent`; plus the vite origin in development). */
  readonly isAllowedOrigin: (url: string) => boolean
  readonly log: Logger
  /** Whitelisted methods the main process wraps (still after every guard check). */
  readonly interceptors?: Partial<Record<SdkMethodName, Interceptor>>
}

/** Render a method name for the log without echoing arbitrary page data. */
export function methodForLog(method: unknown): string {
  return typeof method === 'string' && /^[A-Za-z][A-Za-z.]{0,63}$/.test(method) ? method : '<invalid>'
}

function denied(check: GuardCheck, message: string): CallResponse {
  return { ok: false, error: toErrorInfo(new NexgentError('approval/denied', message, { details: { check } })) }
}

/**
 * Build the handler the Electron adapter registers on `nexgent:call`.
 * @returns `(caller, payload) => response`; it never throws.
 */
export function createCallHandler(options: CallHandlerOptions): (caller: CallerInfo, payload: unknown) => Promise<CallResponse> {
  const { sdk, tokens, isAllowedOrigin, log } = options
  return async (caller, payload) => {
    const request = isPlainObject(payload) ? payload : {}
    const method = request['method']
    const deny = (check: GuardCheck, message: string, reason?: string): CallResponse => {
      log.warn(`ipc denied window=${caller.windowId ?? '-'} method=${methodForLog(method)} check=${check}${reason === undefined ? '' : ` reason=${reason}`}`)
      return denied(check, message)
    }

    if (caller.windowId === undefined || !caller.isTopFrame || !isAllowedOrigin(caller.url)) {
      return deny('sender', 'IPC 调用被拒绝：调用方不是本应用窗口的顶层页面')
    }
    if (!tokens.verify(caller.windowId, request['token'])) {
      return deny('token', 'IPC 调用被拒绝：访问令牌缺失或不正确')
    }
    if (!isWhitelisted(method)) {
      return deny('method', 'IPC 调用被拒绝：方法不在白名单内')
    }
    const input = request['input']
    const invalid = validateInput(method, input)
    if (invalid !== undefined || !isPlainObject(input)) {
      return deny('input', `IPC 调用被拒绝：参数不合法（${invalid ?? 'input'}）`, invalid?.replace(/\s+/g, '_'))
    }

    try {
      const interceptor = options.interceptors?.[method]
      const result = interceptor !== undefined ? await interceptor(input, caller) : await sdk.call(method, input as never)
      return { ok: true, result }
    } catch (error) {
      const info = toErrorInfo(error)
      log.debug(`ipc call failed window=${caller.windowId} method=${method} code=${info.code}`)
      return { ok: false, error: info }
    }
  }
}
