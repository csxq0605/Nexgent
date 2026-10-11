/**
 * The preload of every Nexgent window (`permissions.md` §本地 IPC 与访问令牌).
 *
 * Runs sandboxed, so it is one CommonJS file that requires nothing but
 * `electron`. It reads the window's IPC token from its own `process.argv`,
 * keeps it in this closure, and exposes exactly `window.nexgent =
 * { invoke, onEvent, platform, pickDirectory, pickFiles }` (the last two are
 * shorthands for `invoke('dialogs.*', {})`); the page never sees
 * `ipcRenderer` or the token.
 */
import electron = require('electron')
import type { SdkEvent, SdkInput, SdkMethodName, SdkResult } from '@nexgent/sdk'
import type { CallResponse } from '../main/ipc-types.js'

// Kept equal to `../main/ipc-types.ts` (a test compares them); a sandboxed preload cannot require local files.
const CALL_CHANNEL = 'nexgent:call'
const EVENT_CHANNEL = 'nexgent:event'
const TOKEN_ARG_PREFIX = '--nexgent-ipc-token='

const token = process.argv.find((arg) => arg.startsWith(TOKEN_ARG_PREFIX))?.slice(TOKEN_ARG_PREFIX.length) ?? ''

async function invoke<M extends SdkMethodName>(method: M, input: SdkInput<M>): Promise<SdkResult<M>> {
  const response = (await electron.ipcRenderer.invoke(CALL_CHANNEL, { token, method, input })) as CallResponse
  if (response.ok) return response.result as SdkResult<M>
  // `contextBridge` copies an `Error` with its message only (its `code` would be lost), so a
  // failed call rejects with the plain `ErrorInfo` object: `{ name, code, message, details? }`.
  throw response.error
}

function onEvent(listener: (event: SdkEvent) => void): () => void {
  const wrapped = (_event: unknown, payload: SdkEvent): void => listener(payload)
  electron.ipcRenderer.on(EVENT_CHANNEL, wrapped)
  return () => {
    electron.ipcRenderer.removeListener(EVENT_CHANNEL, wrapped)
  }
}

// Native pickers: shorthands for the whitelisted `dialogs.*` methods, through the same guarded call.
const pickDirectory = (): Promise<string | null> => invoke('dialogs.pickDirectory', {})
const pickFiles = (): Promise<readonly string[]> => invoke('dialogs.pickFiles', {})

electron.contextBridge.exposeInMainWorld('nexgent', {
  invoke,
  onEvent,
  platform: process.platform,
  pickDirectory,
  pickFiles,
})
