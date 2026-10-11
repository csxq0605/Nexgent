/**
 * Nexgent desktop main process: holds the SDK, owns the window, serves the
 * UI from `app://nexgent/`, and answers the page only through the guarded
 * `nexgent:call` channel (`docs/spec/permissions.md` §本地 IPC 与访问令牌).
 *
 * Command line: `electron <appDir> [--project <abs>]` (packaged: `Nexgent [--project <abs>]`),
 * the `nexgent app` contract. The project is opened (and initialised) through
 * `projects.open` before the window loads, so it heads `projects.recent`; a
 * second launch hands its project to the running instance and exits.
 *
 * Environment (unpackaged builds only, except `NEXGENT_HOME` and `NEXGENT_LOG_LEVEL`):
 * - `NEXGENT_HOME`: overrides `~/.nexgent` (logs, Chromium profile, SDK home).
 * - `NEXGENT_LOG_LEVEL`: `debug` | `info` (default) | `warn` | `error`.
 * - `NEXGENT_DESKTOP_DEV_URL`: load the UI from a vite dev server on localhost.
 * - `NEXGENT_DESKTOP_RENDERER_DIR`: serve `app://nexgent/` from this directory instead of `dist/renderer`.
 * - `NEXGENT_DESKTOP_SDK_MODULE`: a module exporting `createSdk` (scripted SDKs in E2E tests).
 */
import { readFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, session, shell, type IpcMainInvokeEvent, type WebContents } from 'electron'
import type { NexgentSdk } from '@nexgent/sdk'
import { exportInterceptor } from './dialogs.js'
import { parseLaunchArgs } from './launch-args.js'
import { createCallHandler, TokenRegistry, type CallerInfo } from './ipc-guard.js'
import { CALL_CHANNEL, EVENT_CHANNEL } from './ipc-types.js'
import { createFileLogger, parseLogLevel } from './logger.js'
import { menuTemplate } from './menu.js'
import {
  APP_ENTRY_URL,
  APP_SCHEME,
  contentSecurityPolicy,
  contentTypeOf,
  devOrigin,
  navigationVerdict,
  openVerdict,
  originChecker,
  resolveAppFile,
} from './origin.js'
import { loadSdk } from './sdk-loader.js'
import { ShutdownCoordinator, type RunningTurn } from './shutdown.js'
import { preferenceViolations, secureWebPreferences } from './window-config.js'

const dev = !app.isPackaged
const devEnv = (name: string): string | undefined => (dev ? process.env[name] || undefined : undefined)

const home = process.env['NEXGENT_HOME'] || join(homedir(), '.nexgent')
const log = createFileLogger({ dir: join(home, 'logs'), level: parseLogLevel(process.env['NEXGENT_LOG_LEVEL']) ?? 'info', echo: dev })

const devUrl = devEnv('NEXGENT_DESKTOP_DEV_URL')
const allowedDevOrigin = devOrigin(devUrl)
const isAllowedOrigin = originChecker(allowedDevOrigin)
const rendererDir = devEnv('NEXGENT_DESKTOP_RENDERER_DIR') ?? fileURLToPath(new URL('../renderer/', import.meta.url))
const preloadPath = fileURLToPath(new URL('../preload/index.cjs', import.meta.url))

const launchArgs = parseLaunchArgs(process.argv)

const FALLBACK_PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Nexgent</title></head>
<body style="font-family:sans-serif;padding:2rem"><h1>Nexgent</h1><p id="nexgent-fallback">界面尚未构建（缺少 dist/renderer/index.html）。</p></body></html>`

process.on('uncaughtException', (error) => log.error(`uncaught exception: ${error.stack ?? error.message}`))
process.on('unhandledRejection', (reason) => log.error(`unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`))

// Must run before `ready`: the UI scheme behaves like https (standard, secure origin).
protocol.registerSchemesAsPrivileged([{ scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } }])

// Keep Chromium's profile (and with it the single-instance lock) under the Nexgent home.
app.setName('Nexgent')
app.setPath('userData', join(home, 'desktop-data'))

if (!app.requestSingleInstanceLock(launchArgs.project === undefined ? {} : { project: launchArgs.project })) {
  log.info('another instance is running; handing over and exiting')
  app.exit(0)
} else {
  void start().catch((error: unknown) => {
    log.error(`start-up failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
    dialog.showErrorBox('Nexgent 无法启动', error instanceof Error ? error.message : String(error))
    app.exit(1)
  })
}

async function serveAppFile(request: Request): Promise<Response> {
  const csp = contentSecurityPolicy(undefined)
  const headers = (file: string): Record<string, string> => ({
    'content-type': contentTypeOf(file),
    'content-security-policy': csp,
    'x-content-type-options': 'nosniff',
  })
  const file = resolveAppFile(rendererDir, request.url)
  if (file === undefined) {
    log.warn(`app protocol refused ${new URL(request.url).pathname.slice(0, 200)}`)
    return new Response('not found', { status: 404 })
  }
  try {
    // A symlink inside the renderer directory must not lead outside it.
    const [realRoot, realFile] = await Promise.all([realpath(rendererDir), realpath(file)])
    const rel = relative(realRoot, realFile)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return new Response('not found', { status: 404 })
    return new Response(await readFile(realFile), { status: 200, headers: headers(realFile) })
  } catch {
    if (request.url === APP_ENTRY_URL || new URL(request.url).pathname === '/') {
      return new Response(FALLBACK_PAGE, { status: 200, headers: headers('index.html') })
    }
    return new Response('not found', { status: 404 })
  }
}

function hardenSession(): void {
  const ses = session.defaultSession
  ses.setPermissionRequestHandler((_contents, permission, callback) => {
    log.info(`permission request denied: ${permission}`)
    callback(false)
  })
  ses.setPermissionCheckHandler(() => false)
  ses.setSpellCheckerEnabled(false)
  if (allowedDevOrigin !== undefined) {
    const csp = contentSecurityPolicy(allowedDevOrigin)
    ses.webRequest.onHeadersReceived({ urls: [`${allowedDevOrigin}/*`] }, (details, callback) => {
      callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } })
    })
  }
}

function guardNavigation(contents: WebContents): void {
  const refuse = (kind: string, url: string, event: { preventDefault(): void }): void => {
    if (navigationVerdict(url, contents.getURL(), isAllowedOrigin) === 'allow') return
    event.preventDefault()
    log.warn(`${kind} refused: ${url.slice(0, 200)}`)
  }
  contents.on('will-navigate', (event) => refuse('navigation', event.url, event))
  contents.on('will-redirect', (event) => refuse('redirect', event.url, event))
  contents.on('will-frame-navigate', (event) => refuse('frame navigation', event.url, event))
  contents.on('will-attach-webview', (event) => {
    event.preventDefault()
    log.warn('webview refused')
  })
  contents.setWindowOpenHandler(({ url }) => {
    if (openVerdict(url) === 'external') {
      void shell.openExternal(url).catch((error: unknown) => log.warn(`openExternal failed: ${String(error)}`))
    } else {
      log.warn(`window.open refused: ${url.slice(0, 200)}`)
    }
    return { action: 'deny' }
  })
}

function callerOf(event: IpcMainInvokeEvent): CallerInfo {
  const window = BrowserWindow.fromWebContents(event.sender)
  const frame = event.senderFrame
  return {
    windowId: window === null || window.isDestroyed() ? undefined : window.id,
    isTopFrame: frame !== null && frame === event.sender.mainFrame,
    url: frame?.url ?? '',
  }
}

async function confirmQuit(running: readonly RunningTurn[]): Promise<boolean> {
  const parent = BrowserWindow.getAllWindows().find((window) => !window.isDestroyed())
  const options = {
    type: 'warning' as const,
    buttons: ['停止并退出', '取消'],
    defaultId: 1,
    cancelId: 1,
    title: 'Nexgent',
    message: `有 ${running.length} 个对话正在运行`,
    detail: '退出前会先停止正在进行的轮次，已经输出的内容会保留在会话里。',
    noLink: true,
  }
  const { response } = parent === undefined ? await dialog.showMessageBox(options) : await dialog.showMessageBox(parent, options)
  return response === 0
}

function createWindow(tokens: TokenRegistry): BrowserWindow {
  const token = TokenRegistry.generate()
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 640,
    title: 'Nexgent',
    show: false,
    backgroundColor: '#ffffff',
    webPreferences: secureWebPreferences({ preload: preloadPath, token, dev }),
  })
  tokens.register(window.id, token)
  const windowId = window.id
  window.on('closed', () => tokens.revoke(windowId))
  window.once('ready-to-show', () => window.show())
  guardNavigation(window.webContents)
  window.webContents.on('render-process-gone', (_event, details) => log.error(`renderer gone: ${details.reason} (exit ${details.exitCode})`))
  window.webContents.once('did-finish-load', () => {
    // `getLastWebPreferences` is Electron's internal view of the effective preferences (not in its typings).
    const contents = window.webContents as WebContents & { getLastWebPreferences?: () => Record<string, unknown> | null }
    const violations = preferenceViolations(contents.getLastWebPreferences?.() ?? {}, dev)
    if (violations.length > 0) log.error(`window ${windowId} webPreferences violate the spec: ${violations.join(', ')}`)
  })
  void window.loadURL(devUrl !== undefined && allowedDevOrigin !== undefined ? devUrl : APP_ENTRY_URL)
  return window
}

/** Open (creating `.nexgent/` when needed) a project named on a command line; failures are logged, not fatal. */
async function openProjectFromCommandLine(sdk: NexgentSdk, root: string): Promise<void> {
  try {
    const project = await sdk.call('projects.open', { root, create: true })
    log.info(`opened project from the command line: ${project.root}`)
  } catch (error) {
    log.error(`could not open project ${root}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function start(): Promise<void> {
  log.info(`start version=${app.getVersion()} electron=${process.versions.electron} platform=${process.platform} packaged=${app.isPackaged}`)
  await app.whenReady()
  protocol.handle(APP_SCHEME, serveAppFile)
  hardenSession()
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate({ dev, platform: process.platform })))

  const loaded = await loadSdk(
    { home, appVersion: app.getVersion(), reveal: async (absolutePath) => shell.showItemInFolder(absolutePath) },
    devEnv('NEXGENT_DESKTOP_SDK_MODULE'),
  )
  const sdk: NexgentSdk = loaded.sdk
  log.info(`sdk source=${loaded.source} apiVersion=${sdk.apiVersion}`)
  if (launchArgs.invalidProject !== undefined) log.warn(`ignored --project (not an absolute path): ${launchArgs.invalidProject.slice(0, 200)}`)
  if (launchArgs.project !== undefined) await openProjectFromCommandLine(sdk, launchArgs.project)

  const tokens = new TokenRegistry()
  const shutdown = new ShutdownCoordinator({ sdk, confirm: confirmQuit, log })
  const handle = createCallHandler({
    sdk,
    tokens,
    isAllowedOrigin,
    log,
    interceptors: {
      'sessions.export': exportInterceptor(
        (options) => {
          const parent = BrowserWindow.getFocusedWindow()
          return parent === null ? dialog.showOpenDialog(options) : dialog.showOpenDialog(parent, options)
        },
        (input) => sdk.call('sessions.export', input),
      ),
    },
  })
  ipcMain.handle(CALL_CHANNEL, (event, payload: unknown) => handle(callerOf(event), payload))

  sdk.subscribe((event) => {
    shutdown.observe(event)
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed() || !isAllowedOrigin(window.webContents.getURL())) continue
      window.webContents.send(EVENT_CHANNEL, event)
    }
  })

  const quit = (event: { preventDefault(): void }): void => {
    if (shutdown.done) return
    event.preventDefault()
    void shutdown.requestQuit().then((decision) => {
      if (decision === 'quit') app.quit()
    })
  }
  app.on('before-quit', quit)
  app.on('window-all-closed', () => app.quit())
  app.on('second-instance', (_event, _argv, _cwd, additionalData) => {
    // The second instance passes its parsed `--project` as lock data (argv order is not reliable there).
    const project = (additionalData as { project?: unknown } | null)?.project
    if (typeof project === 'string' && isAbsolute(project)) void openProjectFromCommandLine(sdk, project)
    const window = BrowserWindow.getAllWindows()[0]
    if (window === undefined) return
    if (window.isMinimized()) window.restore()
    window.focus()
  })

  const window = createWindow(tokens)
  window.on('close', quit)
}
