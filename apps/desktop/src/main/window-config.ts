/**
 * The `webPreferences` every Nexgent window is created with
 * (`permissions.md` §本地 IPC 与访问令牌, 窗口配置), and the check that a
 * live window still has them.
 */
import type { WebPreferences } from 'electron'
import { TOKEN_ARG_PREFIX } from './ipc-types.js'

/** Options of {@link secureWebPreferences}. */
export interface WindowPrefsOptions {
  /** Absolute path of the compiled preload (`dist/preload/index.cjs`). */
  readonly preload: string
  /** The window's IPC token, handed to its preload through `additionalArguments`. */
  readonly token: string
  /** Development build (unpackaged): developer tools allowed. */
  readonly dev: boolean
}

/** The fixed isolation settings; {@link secureWebPreferences} adds the per-window fields. */
export const REQUIRED_PREFERENCES = {
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
  spellcheck: false,
} as const satisfies WebPreferences

/** The full `webPreferences` of a window. */
export function secureWebPreferences(options: WindowPrefsOptions): WebPreferences {
  return {
    ...REQUIRED_PREFERENCES,
    preload: options.preload,
    additionalArguments: [`${TOKEN_ARG_PREFIX}${options.token}`],
    devTools: options.dev,
  }
}

/**
 * Compare a window's effective preferences (`webContents.getLastWebPreferences()`)
 * with {@link REQUIRED_PREFERENCES}. Electron does not report `spellcheck` or
 * `devTools` there, so `spellcheck` is not compared (the session's spell
 * checker is switched off as well) and `devTools` only when present.
 * @returns the names of the settings that differ; empty when the window is compliant.
 */
export function preferenceViolations(actual: Readonly<Record<string, unknown>>, dev: boolean): string[] {
  const violations = Object.entries(REQUIRED_PREFERENCES)
    .filter(([key, value]) => key !== 'spellcheck' && actual[key] !== value)
    .map(([key]) => key)
  if (!dev && 'devTools' in actual && actual['devTools'] !== false) violations.push('devTools')
  return violations
}

/**
 * macOS keeps an app running with no window: closing the window only hides
 * it (the Dock icon brings it back) unless the app is quitting. Elsewhere
 * closing the window quits.
 */
export function keepOnClose(platform: NodeJS.Platform, quitting: boolean): boolean {
  return platform === 'darwin' && !quitting
}
