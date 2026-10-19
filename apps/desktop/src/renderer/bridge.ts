/**
 * The renderer's only way to the backend: the `window.nexgent` object the
 * preload exposes (`docs/spec/permissions.md` §本地 IPC 与访问令牌). The page
 * never sees the IPC token or `ipcRenderer`; it calls `invoke(method, input)`
 * and listens with `onEvent`. The preload resolves with the result and
 * rejects with a plain `ErrorInfo` object (`src/main/ipc-types.ts`); the
 * client below turns every failure into an {@link SdkCallError}.
 */
import type { ErrorInfo } from '@nexgent/kernel'
import type { SdkEvent, SdkInput, SdkMethodName, SdkResult, Unsubscribe } from '@nexgent/sdk'

/** The object the preload puts on `window.nexgent` (structurally `NexgentBridge` of `src/main/ipc-types.ts`). */
export interface NexgentBridge {
  invoke(method: string, input: unknown): Promise<unknown>
  onEvent(listener: (event: SdkEvent) => void): Unsubscribe
  readonly platform: string
  /** Optional desktop extras: native pickers. Absent → the UI asks for a typed absolute path. */
  pickDirectory?(): Promise<string | null>
  pickFiles?(): Promise<readonly string[]>
}

declare global {
  interface Window {
    nexgent?: NexgentBridge
  }
}

/** A rejected SDK call, carrying the backend's `ErrorInfo`. */
export class SdkCallError extends Error {
  readonly info: ErrorInfo
  constructor(info: ErrorInfo) {
    super(info.message)
    this.name = 'SdkCallError'
    this.info = info
  }
}

function isErrorInfo(value: unknown): value is ErrorInfo {
  return typeof value === 'object' && value !== null && typeof (value as { code?: unknown }).code === 'string' && typeof (value as { message?: unknown }).message === 'string'
}

/** Project anything thrown into an `ErrorInfo` for display. */
export function errorInfoOf(error: unknown): ErrorInfo {
  if (error instanceof SdkCallError) return error.info
  if (isErrorInfo(error) && !(error instanceof Error)) {
    const name = typeof (error as { name?: unknown }).name === 'string' ? error.name : 'NexgentError'
    return error.details === undefined ? { name, code: error.code, message: error.message } : { name, code: error.code, message: error.message, details: error.details }
  }
  if (error instanceof Error) return { name: error.name, code: 'internal', message: error.message }
  return { name: 'Error', code: 'internal', message: String(error) }
}

/** Typed client over a bridge. */
export class SdkClient {
  readonly bridge: NexgentBridge
  constructor(bridge: NexgentBridge) {
    this.bridge = bridge
  }

  async call<M extends SdkMethodName>(method: M, input: SdkInput<M>): Promise<SdkResult<M>> {
    try {
      return (await this.bridge.invoke(method, input)) as SdkResult<M>
    } catch (error) {
      // A rejected call (plain ErrorInfo) or a broken IPC (main process gone): always an error the UI can show.
      throw new SdkCallError(errorInfoOf(error))
    }
  }

  onEvent(listener: (event: SdkEvent) => void): Unsubscribe {
    return this.bridge.onEvent(listener)
  }

  get canPickDirectory(): boolean {
    return typeof this.bridge.pickDirectory === 'function'
  }

  get canPickFiles(): boolean {
    return typeof this.bridge.pickFiles === 'function'
  }

  async pickDirectory(): Promise<string | null> {
    return this.bridge.pickDirectory ? this.bridge.pickDirectory() : null
  }

  async pickFiles(): Promise<readonly string[]> {
    return this.bridge.pickFiles ? this.bridge.pickFiles() : []
  }
}
