/**
 * Obtain the SDK instance the main process holds: `createSdk` from
 * `@nexgent/sdk`, or — unpackaged builds only — the `createSdk` of the module
 * named by `NEXGENT_DESKTOP_SDK_MODULE` (scripted SDKs for desktop E2E tests;
 * the caller passes the override only when the app is not packaged).
 */
import { pathToFileURL } from 'node:url'
import { createSdk, type CreateSdkOptions, type NexgentSdk } from '@nexgent/sdk'

/** The factory shape both `@nexgent/sdk` and a test module export. */
export type CreateSdk = (options: CreateSdkOptions) => NexgentSdk | Promise<NexgentSdk>

/** Where the SDK came from (logged at start-up). */
export type SdkSource = 'sdk' | 'override'

/**
 * Load and create the SDK.
 * @param override - absolute path of a module exporting `createSdk`.
 */
export async function loadSdk(options: CreateSdkOptions, override?: string): Promise<{ sdk: NexgentSdk; source: SdkSource }> {
  if (override === undefined || override === '') return { sdk: createSdk(options), source: 'sdk' }
  const module = (await import(pathToFileURL(override).href)) as { createSdk?: unknown }
  if (typeof module.createSdk !== 'function') throw new Error(`NEXGENT_DESKTOP_SDK_MODULE does not export createSdk: ${override}`)
  return { sdk: await (module.createSdk as CreateSdk)(options), source: 'override' }
}
