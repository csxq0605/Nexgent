/**
 * Whether the host can run commands. On Windows every command goes through
 * PowerShell 7 (`pwsh`): the shell tool is `pwsh -Command`, and the Job
 * Object launcher (`windows-job.ts`) is a `pwsh` script. Windows PowerShell
 * 5.1 (`powershell.exe`) is not a fallback: the launcher uses
 * `ProcessStartInfo.ArgumentList` (.NET Core only), and the model writes
 * PowerShell 7 syntax (`&&`, `||`, `-Parallel`, UTF-8 output by default)
 * that 5.1 rejects or reads differently. So the host is checked once at
 * start-up and the user is told to install PowerShell 7 when it is missing.
 */
import { statSync } from 'node:fs'
import { delimiter, join } from 'node:path'

/** The result of {@link checkCommandShell}. */
export interface CommandShellStatus {
  /** The executable commands need on this platform (`pwsh` on Windows). */
  readonly shell: 'pwsh' | 'bash'
  /** Whether Nexgent depends on finding it at start-up (only on Windows). */
  readonly required: boolean
  /** Whether it was found; always `true` when not {@link required}. */
  readonly available: boolean
  /** Where it was found, when it was looked up and found. */
  readonly path?: string
}

/** Inputs of {@link checkCommandShell}; defaults are the current process. */
export interface CommandShellCheckOptions {
  readonly platform?: NodeJS.Platform
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Explicit launcher path (`ProcessRunnerOptions.pwshPath`); checked instead of searching `PATH`. */
  readonly pwshPath?: string
  /** Whether a path is an existing file (tests inject this). */
  readonly isFile?: (path: string) => boolean
}

/** Message shown when {@link CommandShellStatus.available} is `false`. */
export const PWSH_MISSING_MESSAGE =
  'PowerShell 7 (pwsh) was not found. Nexgent runs every command through it on Windows; ' +
  'Windows PowerShell 5.1 (powershell.exe) does not work. Install PowerShell 7 ' +
  '(for example `winget install --id Microsoft.PowerShell`) and restart Nexgent.'

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function envValue(env: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  const key = Object.keys(env).find(key => key.toLowerCase() === name.toLowerCase())
  return key === undefined ? undefined : env[key]
}

/** Find `pwsh` the way Windows `CreateProcess` + `PATHEXT` would, or `undefined`. */
export function findPwsh(options: CommandShellCheckOptions = {}): string | undefined {
  const env = options.env ?? process.env
  const exists = options.isFile ?? isFile
  const platform = options.platform ?? process.platform
  const sep = platform === 'win32' ? ';' : delimiter
  const join2 = (dir: string, name: string): string => (platform === 'win32' ? `${dir.replace(/[\\/]+$/, '')}\\${name}` : join(dir, name))
  if (options.pwshPath !== undefined && /[\\/]/.test(options.pwshPath)) {
    return exists(options.pwshPath) ? options.pwshPath : undefined
  }
  const name = options.pwshPath ?? 'pwsh'
  const exts = platform === 'win32'
    ? (/\.[^\\/.]+$/.test(name) ? [''] : (envValue(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(ext => ext !== ''))
    : ['']
  for (const raw of (envValue(env, 'PATH') ?? '').split(sep)) {
    const dir = raw.trim().replace(/^"(.*)"$/, '$1')
    if (dir === '') continue
    for (const ext of exts) {
      const candidate = join2(dir, name + ext.toLowerCase())
      if (exists(candidate)) return candidate
    }
  }
  return undefined
}

/** Check, once at start-up, that commands can run on this host. Never throws. */
export function checkCommandShell(options: CommandShellCheckOptions = {}): CommandShellStatus {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') return { shell: 'bash', required: false, available: true }
  const path = findPwsh({ ...options, platform })
  return path === undefined ? { shell: 'pwsh', required: true, available: false } : { shell: 'pwsh', required: true, available: true, path }
}
