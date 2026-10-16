import { describe, expect, it } from 'vitest'
import { checkCommandShell, findPwsh, JOB_LAUNCHER, POWERSHELL_51_NOTICE, PWSH_MISSING_MESSAGE, resetPowerShellCache, selectPowerShell, startFailureMessage, takePowerShellNotice } from '../src/index.js'

const files = (...paths: string[]) => (path: string): boolean => paths.includes(path)

describe('checkCommandShell', () => {
  it('needs nothing outside Windows', () => {
    expect(checkCommandShell({ platform: 'linux', env: { PATH: '' }, isFile: () => false })).toEqual({ shell: 'bash', required: false, available: true })
  })

  it('finds pwsh.exe on the Windows PATH through PATHEXT', () => {
    const env = { Path: 'C:\\Windows\\System32;"C:\\Program Files\\PowerShell\\7\\"', PATHEXT: '.COM;.EXE;.BAT' }
    const status = checkCommandShell({ platform: 'win32', env, isFile: files('C:\\Program Files\\PowerShell\\7\\pwsh.exe') })
    expect(status).toEqual({ shell: 'pwsh', required: true, available: true, path: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', edition: 'pwsh' })
  })

  it('falls back to Windows PowerShell 5.1 with a notice when pwsh is missing', () => {
    const env = { PATH: 'C:\\Windows\\System32;C:\\Windows\\System32\\WindowsPowerShell\\v1.0', PATHEXT: '.EXE' }
    const status = checkCommandShell({ platform: 'win32', env, isFile: files('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe') })
    expect(status).toEqual({
      shell: 'pwsh', required: true, available: true, edition: 'windows-powershell', notice: POWERSHELL_51_NOTICE,
      path: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    })
    expect(POWERSHELL_51_NOTICE).toContain('winget install --id Microsoft.PowerShell')
  })

  it('prefers pwsh when both are installed', () => {
    const env = { PATH: 'C:\\ps7;C:\\ps5', PATHEXT: '.EXE' }
    const choice = selectPowerShell({ platform: 'win32', env, isFile: files('C:\\ps7\\pwsh.exe', 'C:\\ps5\\powershell.exe') })
    expect(choice).toMatchObject({ edition: 'pwsh', program: 'pwsh', path: 'C:\\ps7\\pwsh.exe' })
    expect(choice?.notice).toBeUndefined()
  })

  it('picks the 5.1 program name and says nothing when neither exists', () => {
    const env = { PATH: 'C:\\ps5', PATHEXT: '.EXE' }
    expect(selectPowerShell({ platform: 'win32', env, isFile: files('C:\\ps5\\powershell.exe') })).toMatchObject({ edition: 'windows-powershell', program: 'powershell' })
    expect(selectPowerShell({ platform: 'win32', env, isFile: () => false })).toBeUndefined()
  })

  it('does not fall back from an explicit launcher path', () => {
    const env = { PATH: 'C:\\ps5', PATHEXT: '.EXE' }
    expect(selectPowerShell({ platform: 'win32', env, pwshPath: 'D:\\x\\pwsh.exe', isFile: files('C:\\ps5\\powershell.exe') })).toBeUndefined()
  })

  it('shows the 5.1 notice once', () => {
    resetPowerShellCache()
    const choice = { edition: 'windows-powershell' as const, program: 'powershell', notice: POWERSHELL_51_NOTICE }
    expect(takePowerShellNotice(choice)).toBe(POWERSHELL_51_NOTICE)
    expect(takePowerShellNotice(choice)).toBeUndefined()
    resetPowerShellCache()
  })

  it('keeps the Job Object launcher usable under 5.1', () => {
    expect(JOB_LAUNCHER).toContain('$PSVersionTable.PSVersion.Major -ge 6')
    expect(JOB_LAUNCHER).toContain('$psi.Arguments')
    expect(JOB_LAUNCHER).toContain('$psi.EnvironmentVariables')
    expect(JOB_LAUNCHER).not.toContain('::new(')
    expect(JOB_LAUNCHER).toContain("-notmatch '[\\s\"]'")
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
