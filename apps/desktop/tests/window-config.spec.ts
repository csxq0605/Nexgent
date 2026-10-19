import { describe, expect, it } from 'vitest'
import { menuTemplate } from '../src/main/menu.js'
import { preferenceViolations, REQUIRED_PREFERENCES, secureWebPreferences } from '../src/main/window-config.js'

describe('secureWebPreferences', () => {
  it('isolates the renderer and passes the token only through additionalArguments', () => {
    const prefs = secureWebPreferences({ preload: '/app/dist/preload/index.cjs', token: 'tok', dev: false })
    expect(prefs).toMatchObject({
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: false,
      devTools: false,
      preload: '/app/dist/preload/index.cjs',
      additionalArguments: ['--nexgent-ipc-token=tok'],
    })
  })

  it('enables developer tools only in development', () => {
    expect(secureWebPreferences({ preload: 'p', token: 't', dev: true }).devTools).toBe(true)
  })
})

describe('preferenceViolations', () => {
  it('is empty for compliant preferences', () => {
    expect(preferenceViolations({ ...REQUIRED_PREFERENCES, devTools: false }, false)).toEqual([])
  })

  it('names every relaxed setting', () => {
    expect(preferenceViolations({ ...REQUIRED_PREFERENCES, sandbox: false, nodeIntegration: true, devTools: true }, false)).toEqual([
      'sandbox',
      'nodeIntegration',
      'devTools',
    ])
    expect(preferenceViolations({}, true)).toEqual(Object.keys(REQUIRED_PREFERENCES).filter((key) => key !== 'spellcheck'))
    expect(preferenceViolations({ ...REQUIRED_PREFERENCES, spellcheck: true }, false)).toEqual([])
  })
})

describe('menuTemplate', () => {
  const roles = (dev: boolean): string[] =>
    JSON.stringify(menuTemplate({ dev, platform: 'linux' }))
      .match(/"role":"[^"]+"/g)!
      .map((match) => match.slice(8, -1))

  it('has no reload or developer tools in packaged builds', () => {
    expect(roles(false)).not.toContain('toggleDevTools')
    expect(roles(false)).not.toContain('reload')
    expect(roles(true)).toContain('toggleDevTools')
  })

  it('adds the app menu only on macOS', () => {
    expect(menuTemplate({ dev: false, platform: 'darwin' })[0]).toMatchObject({ role: 'appMenu' })
    expect(menuTemplate({ dev: false, platform: 'win32' })[0]).toMatchObject({ label: '文件' })
  })
})
