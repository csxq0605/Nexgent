/**
 * Obtain the SDK instance the main process holds.
 *
 * - `@nexgent/sdk` exporting `createSdk` (W4) is the normal path.
 * - Unpackaged builds may point `NEXGENT_DESKTOP_SDK_MODULE` at a module
 *   exporting `createSdk` (scripted SDKs for desktop E2E tests); packaged
 *   builds ignore it.
 * - Until W4 lands `createSdk`, a stand-in answers `app.info` and rejects
 *   every other method with `internal`, so the window and the IPC path can
 *   be exercised.
 */
import { pathToFileURL } from 'node:url'
import { NexgentError } from '@nexgent/kernel'
import { SDK_API_VERSION, type CreateSdkOptions, type NexgentSdk, type SdkMethodName, type SdkResult } from '@nexgent/sdk'

/** The factory shape both `@nexgent/sdk` and a test module export. */
export type CreateSdk = (options: CreateSdkOptions) => NexgentSdk | Promise<NexgentSdk>

/** Where the SDK came from (logged at start-up). */
export type SdkSource = 'sdk' | 'override' | 'unavailable'

/** The stand-in used while `@nexgent/sdk` has no implementation. */
export function createUnavailableSdk(options: CreateSdkOptions): NexgentSdk {
  return {
    apiVersion: SDK_API_VERSION,
    async call<M extends SdkMethodName>(method: M): Promise<SdkResult<M>> {
      if (method === 'app.info') {
        return { sdkVersion: SDK_API_VERSION, appVersion: options.appVersion, platform: process.platform } as SdkResult<M>
      }
      throw new NexgentError('internal', `SDK 尚未接通，无法调用 ${method}`, { details: { method } })
    },
    subscribe: () => () => {},
    dispose: async () => {},
  }
}

function factoryOf(module: unknown): CreateSdk | undefined {
  if (typeof module !== 'object' || module === null) return undefined
  const candidate = (module as { createSdk?: unknown }).createSdk
  return typeof candidate === 'function' ? (candidate as CreateSdk) : undefined
}

/**
 * Load and create the SDK.
 * @param override - absolute path of a test module (only honoured when the caller passes it, i.e. unpackaged).
 */
export async function loadSdk(options: CreateSdkOptions, override?: string): Promise<{ sdk: NexgentSdk; source: SdkSource }> {
  if (override !== undefined && override !== '') {
    const factory = factoryOf(await import(pathToFileURL(override).href))
    if (factory === undefined) throw new Error(`NEXGENT_DESKTOP_SDK_MODULE does not export createSdk: ${override}`)
    return { sdk: await factory(options), source: 'override' }
  }
  const factory = factoryOf(await import('@nexgent/sdk'))
  if (factory !== undefined) return { sdk: await factory(options), source: 'sdk' }
  return { sdk: createUnavailableSdk(options), source: 'unavailable' }
}
