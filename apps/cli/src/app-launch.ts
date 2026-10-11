/**
 * `nexgent app`: find the desktop app and start it detached.
 *
 * Where the app is (first hit wins):
 * 1. `NEXGENT_DESKTOP_DIR`: a directory with the app's `package.json`;
 * 2. `apps/desktop` next to this package in the monorepo.
 *
 * Which Electron runs it: `NEXGENT_ELECTRON` (a binary path), else the
 * `electron` package resolved from the app directory, then from here (its
 * default export is the binary path). The app gets the directory as its
 * first argument and `--project <abs>` when a project was given; the
 * desktop main process owns everything after that (`apps/desktop`, W5).
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CliError, EXIT } from './exit-codes.js'

/** Environment variable naming the desktop app directory. */
export const NEXGENT_DESKTOP_DIR = 'NEXGENT_DESKTOP_DIR'

/** Environment variable naming the Electron binary. */
export const NEXGENT_ELECTRON = 'NEXGENT_ELECTRON'

/** `--json` error code when the desktop app cannot be found. */
export const APP_NOT_FOUND_CODE = 'cli/app-not-found'

/** What a launch needs. */
export interface AppLaunchOptions {
  readonly env: Readonly<Record<string, string | undefined>>
  /** Absolute project root to open, if any. */
  readonly project?: string
}

/** The command line that starts the app. */
export interface AppCommand {
  readonly electron: string
  readonly args: readonly string[]
  readonly appDir: string
}

/** The monorepo's `apps/desktop` (this file lives in `apps/cli/dist/`). */
function bundledDesktopDir(): string {
  return fileURLToPath(new URL('../../desktop/', import.meta.url))
}

function resolveElectron(appDir: string, env: AppLaunchOptions['env']): string | undefined {
  const explicit = env[NEXGENT_ELECTRON]
  if (explicit !== undefined && explicit !== '') return explicit
  for (const from of [path.join(appDir, 'package.json'), fileURLToPath(import.meta.url)]) {
    try {
      const binary = createRequire(from)('electron') as unknown
      if (typeof binary === 'string' && existsSync(binary)) return binary
    } catch {
      // not resolvable from here
    }
  }
  return undefined
}

/**
 * Work out how to start the app.
 * @throws {@link CliError} (exit 2, `cli/app-not-found`) when the app or Electron is missing.
 */
export function desktopCommand(options: AppLaunchOptions): AppCommand {
  const configured = options.env[NEXGENT_DESKTOP_DIR]
  const appDir = path.resolve(configured !== undefined && configured !== '' ? configured : bundledDesktopDir())
  if (!existsSync(path.join(appDir, 'package.json'))) {
    throw new CliError(EXIT.USAGE, `desktop app not found at ${appDir}; build apps/desktop (pnpm build) or set ${NEXGENT_DESKTOP_DIR}`, { code: APP_NOT_FOUND_CODE })
  }
  const electron = resolveElectron(appDir, options.env)
  if (electron === undefined) {
    throw new CliError(EXIT.USAGE, `Electron not found for ${appDir}; install the desktop app's dependencies or set ${NEXGENT_ELECTRON}`, { code: APP_NOT_FOUND_CODE })
  }
  return { electron, appDir, args: [appDir, ...(options.project === undefined ? [] : ['--project', options.project])] }
}

/** Start the app detached; resolves once the process has spawned. */
export function launchDesktop(options: AppLaunchOptions): Promise<AppCommand> {
  const command = desktopCommand(options)
  return new Promise((resolve, reject) => {
    const child = spawn(command.electron, [...command.args], {
      detached: true,
      stdio: 'ignore',
      env: Object.fromEntries(Object.entries(options.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
      windowsHide: false,
    })
    child.once('error', error => reject(new CliError(EXIT.ENVIRONMENT, `cannot start the desktop app: ${error.message}`, { cause: error })))
    child.once('spawn', () => {
      child.unref()
      resolve(command)
    })
  })
}
