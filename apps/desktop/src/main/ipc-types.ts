/**
 * The wire shapes of the desktop IPC boundary (`docs/spec/permissions.md`
 * §本地 IPC 与访问令牌). Shared by the main process and the preload; types
 * and constants only, so the sandboxed preload can import them as types.
 */
import type { ErrorInfo } from '@nexgent/kernel'
import type { SdkEvent, SdkInput, SdkMethodName, SdkResult } from '@nexgent/sdk'

/** The only channel the main process handles (`ipcMain.handle`). */
export const CALL_CHANNEL = 'nexgent:call'

/** The only channel the main process pushes events on (`webContents.send`). */
export const EVENT_CHANNEL = 'nexgent:event'

/** The `additionalArguments` switch that carries a window's token to its preload. */
export const TOKEN_ARG_PREFIX = '--nexgent-ipc-token='

/** What the preload sends on {@link CALL_CHANNEL}. */
export interface CallRequest {
  readonly token: string
  readonly method: string
  readonly input: unknown
}

/** What the main process answers on {@link CALL_CHANNEL}. */
export type CallResponse =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly error: ErrorInfo }

/** The guard checks, in the order the spec runs them; a denial names the first that failed. */
export type GuardCheck = 'sender' | 'token' | 'method' | 'input'

/**
 * What the page sees as `window.nexgent` (the renderer declares
 * `window.nexgent: NexgentBridge`). A failed `invoke` rejects with the
 * plain {@link ErrorInfo} object (`name`, `code`, `message`, `details?`), not
 * an `Error`: `contextBridge` would strip an `Error` down to its message.
 */
export interface NexgentBridge {
  invoke<M extends SdkMethodName>(method: M, input: SdkInput<M>): Promise<SdkResult<M>>
  onEvent(listener: (event: SdkEvent) => void): () => void
  readonly platform: string
  /** `invoke('dialogs.pickDirectory', {})`: the native folder picker; `null` when cancelled. */
  pickDirectory(): Promise<string | null>
  /** `invoke('dialogs.pickFiles', {})`: the native multi-file picker; empty when cancelled. */
  pickFiles(): Promise<readonly string[]>
}
