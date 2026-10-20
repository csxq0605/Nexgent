import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { isNexgentError } from '@nexgent/kernel'
import { SDK_API_VERSION } from '@nexgent/sdk'
import { exportInterceptor, pickExportDirectory, pickMaterialFiles, pickProjectDirectory } from '../src/main/dialogs.js'
import { parseLaunchArgs } from '../src/main/launch-args.js'
import { loadSdk } from '../src/main/sdk-loader.js'

const FIXTURE_SDK = fileURLToPath(new URL('./fixtures/scripted-sdk.mjs', import.meta.url))

describe('sdk loader', () => {
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
    const home = mkdtempSync(join(tmpdir(), 'nexgent-desktop-sdk-'))
    const { sdk, source } = await loadSdk({ home, appVersion: '0.0.2' })
    try {
      expect(source).toBe('sdk')
      expect(sdk.apiVersion).toBe(SDK_API_VERSION)
      expect(await sdk.call('app.info', {})).toMatchObject({ sdkVersion: SDK_API_VERSION, appVersion: '0.0.2', platform: process.platform, commandShell: { required: process.platform === 'win32' } })
      expect(await sdk.call('projects.recent', {})).toEqual([])
      // The SDK's capabilities row is installed: a project opens and reports its version.
      const project = await sdk.call('projects.open', { root: join(home, 'project'), create: true })
      expect(await sdk.call('capabilities.current', { projectId: project.projectId })).toEqual({ version: 'baseline', revision: 0, components: [] })
    } finally {
      await sdk.dispose()
    }
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

describe('launch arguments', () => {
  const abs = process.platform === 'win32' ? 'C:\\work\\proj' : '/work/proj'

  it('reads --project <abs> and --project=<abs> after the app directory and Chromium switches', () => {
    expect(parseLaunchArgs(['/electron', '/repo/apps/desktop', '--project', abs])).toEqual({ project: abs })
    expect(parseLaunchArgs(['/opt/Nexgent/nexgent-desktop', '--no-sandbox', `--project=${abs}`])).toEqual({ project: abs })
    expect(parseLaunchArgs(['/electron', '/repo/apps/desktop'])).toEqual({})
  })

  it('reports relative or empty projects instead of opening them', () => {
    expect(parseLaunchArgs(['/electron', '.', '--project', 'relative/dir'])).toEqual({ invalidProject: 'relative/dir' })
    expect(parseLaunchArgs(['/electron', '.', '--project'])).toEqual({ invalidProject: '' })
  })
})
