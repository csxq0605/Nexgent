import { describe, expect, it } from 'vitest'
import { checkCommandShell, findPwsh, PWSH_MISSING_MESSAGE, startFailureMessage } from '../src/index.js'

const files = (...paths: string[]) => (path: string): boolean => paths.includes(path)

describe('checkCommandShell', () => {
  it('needs nothing outside Windows', () => {
    expect(checkCommandShell({ platform: 'linux', env: { PATH: '' }, isFile: () => false })).toEqual({ shell: 'bash', required: false, available: true })
  })

  it('finds pwsh.exe on the Windows PATH through PATHEXT', () => {
    const env = { Path: 'C:\\Windows\\System32;"C:\\Program Files\\PowerShell\\7\\"', PATHEXT: '.COM;.EXE;.BAT' }
    const status = checkCommandShell({ platform: 'win32', env, isFile: files('C:\\Program Files\\PowerShell\\7\\pwsh.exe') })
    expect(status).toEqual({ shell: 'pwsh', required: true, available: true, path: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' })
  })

  it('reports pwsh missing when only Windows PowerShell 5.1 is installed', () => {
    const env = { PATH: 'C:\\Windows\\System32;C:\\Windows\\System32\\WindowsPowerShell\\v1.0', PATHEXT: '.EXE' }
    const status = checkCommandShell({ platform: 'win32', env, isFile: files('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe') })
    expect(status).toEqual({ shell: 'pwsh', required: true, available: false })
  })

  it('checks an explicit launcher path instead of searching PATH', () => {
    const custom = 'D:\\tools\\pwsh\\pwsh.exe'
    expect(findPwsh({ platform: 'win32', env: { PATH: '' }, pwshPath: custom, isFile: files(custom) })).toBe(custom)
    expect(checkCommandShell({ platform: 'win32', env: { PATH: '' }, pwshPath: custom, isFile: () => false }).available).toBe(false)
  })

  it('never throws on an empty environment', () => {
    expect(checkCommandShell({ platform: 'win32', env: {}, isFile: () => false })).toEqual({ shell: 'pwsh', required: true, available: false })
  })
})

describe('startFailureMessage', () => {
  const enoent = Object.assign(new Error('spawn pwsh ENOENT'), { code: 'ENOENT' })

  it('names the missing PowerShell 7 when the job launcher cannot start', () => {
    const message = startFailureMessage('git', enoent, true)
    expect(message).toBe(`failed to start git: ${PWSH_MISSING_MESSAGE}`)
    expect(message).toContain('powershell.exe')
  })

  it('keeps the original error for a direct spawn', () => {
    expect(startFailureMessage('git', enoent, false)).toBe('failed to start git: spawn pwsh ENOENT')
  })
})
