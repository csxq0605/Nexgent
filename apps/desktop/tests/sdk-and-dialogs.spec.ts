import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { isNexgentError } from '@nexgent/kernel'
import { SDK_API_VERSION } from '@nexgent/sdk'
import { exportInterceptor, pickExportDirectory, pickMaterialFiles, pickProjectDirectory } from '../src/main/dialogs.js'
import { createUnavailableSdk, loadSdk } from '../src/main/sdk-loader.js'

const FIXTURE_SDK = fileURLToPath(new URL('./fixtures/scripted-sdk.mjs', import.meta.url))

describe('sdk loader', () => {
  it('answers app.info and refuses the rest while the SDK is not implemented', async () => {
    const sdk = createUnavailableSdk({ appVersion: '1.2.3' })
    expect(await sdk.call('app.info', {})).toEqual({ sdkVersion: SDK_API_VERSION, appVersion: '1.2.3', platform: process.platform })
    await expect(sdk.call('projects.recent', {})).rejects.toSatisfy((error) => isNexgentError(error, 'internal'))
  })

  it('loads an override module exporting createSdk', async () => {
    const home = mkdtempSync(join(tmpdir(), 'nexgent-desktop-sdk-'))
    const { sdk, source } = await loadSdk({ home, appVersion: '0.0.1' }, FIXTURE_SDK)
    expect(source).toBe('override')
    expect(await sdk.call('app.info', {})).toMatchObject({ appVersion: '0.0.1' })
  })

  it('rejects an override without createSdk', async () => {
    await expect(loadSdk({ appVersion: '0' }, fileURLToPath(new URL('../src/main/menu.ts', import.meta.url)))).rejects.toThrow(/does not export createSdk/)
  })

  it('uses @nexgent/sdk when nothing overrides it', async () => {
    const { sdk, source } = await loadSdk({ appVersion: '0' })
    expect(['sdk', 'unavailable']).toContain(source)
    expect(sdk.apiVersion).toBe(SDK_API_VERSION)
  })
})

describe('dialogs', () => {
  const show = (result: { canceled: boolean; filePaths: string[] }) => vi.fn(async () => result)

  it('returns picked paths or nothing on cancel', async () => {
    expect(await pickProjectDirectory(show({ canceled: false, filePaths: ['/p'] }))).toBe('/p')
    expect(await pickProjectDirectory(show({ canceled: true, filePaths: [] }))).toBeUndefined()
    expect(await pickMaterialFiles(show({ canceled: false, filePaths: ['/a', '/b'] }))).toEqual(['/a', '/b'])
    expect(await pickMaterialFiles(show({ canceled: true, filePaths: ['/a'] }))).toEqual([])
    expect(await pickExportDirectory(show({ canceled: false, filePaths: ['/out'] }))).toBe('/out')
  })

  it('asks for directories or multiple files', async () => {
    const dialog = show({ canceled: true, filePaths: [] })
    await pickProjectDirectory(dialog, '/start')
    await pickMaterialFiles(dialog)
    expect(dialog.mock.calls[0]).toEqual([expect.objectContaining({ properties: ['openDirectory', 'createDirectory'], defaultPath: '/start' })])
    expect(dialog.mock.calls[1]).toEqual([expect.objectContaining({ properties: ['openFile', 'multiSelections'] })])
  })

  it('exports into the directory the user picked, not the one the page passed', async () => {
    const exportTo = vi.fn(async (input: unknown) => input)
    const intercept = exportInterceptor(show({ canceled: false, filePaths: ['/picked'] }), exportTo)
    expect(await intercept({ projectId: 'p', sessionId: 's', outDir: '/page-chose' })).toEqual({ projectId: 'p', sessionId: 's', outDir: '/picked' })
  })

  it('rejects the export as denied when the dialog is cancelled', async () => {
    const exportTo = vi.fn()
    const intercept = exportInterceptor(show({ canceled: true, filePaths: [] }), exportTo)
    await expect(intercept({ projectId: 'p', sessionId: 's', outDir: '/x' })).rejects.toSatisfy((error) => isNexgentError(error, 'approval/denied'))
    expect(exportTo).not.toHaveBeenCalled()
  })
})
