/**
 * Desktop E2E: Playwright's Electron driver starts the built main process
 * (`dist/main/index.js`) with a fixture page and a scripted SDK, then checks
 * the window, the IPC round trip, the guard, navigation, the close protocol
 * and a restart after a hard kill. Linux without a display gets its own Xvfb.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Code passed to `page.evaluate` runs in the page; the tests' type program has no DOM lib.
declare const window: any

// No trailing separator: on Windows a trailing backslash escapes the closing quote of the argument.
const APP_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)))
const RENDERER = fileURLToPath(new URL('./fixtures/renderer', import.meta.url))
const SCRIPTED_SDK = fileURLToPath(new URL('./fixtures/scripted-sdk.mjs', import.meta.url))
const ELECTRON_BIN = createRequire(import.meta.url)('electron') as unknown as string
const TIMEOUT = 60_000
const ROOT = typeof process.getuid === 'function' && process.getuid() === 0

let xvfb: ChildProcess | undefined
let display = process.env['DISPLAY']

async function ensureDisplay(): Promise<void> {
  if (process.platform !== 'linux' || (display !== undefined && display !== '')) return
  const child = spawn('Xvfb', ['-displayfd', '1', '-screen', '0', '1280x1024x24', '-nolisten', 'tcp'], { stdio: ['ignore', 'pipe', 'ignore'] })
  xvfb = child
  display = await new Promise<string>((resolve, reject) => {
    let out = ''
    child.once('error', (error) => reject(new Error(`no DISPLAY and Xvfb could not start: ${error.message}`)))
    child.stdout!.on('data', (chunk: Buffer) => {
      out += chunk.toString()
      if (out.includes('\n')) resolve(`:${out.trim()}`)
    })
  })
}

function appEnv(home: string, realSdk = false): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !key.startsWith('NEXGENT_')) env[key] = value
  return {
    ...env,
    ...(display === undefined ? {} : { DISPLAY: display }),
    NEXGENT_HOME: home,
    NEXGENT_LOG_LEVEL: 'debug',
    NEXGENT_DESKTOP_RENDERER_DIR: RENDERER,
    ...(realSdk ? {} : { NEXGENT_DESKTOP_SDK_MODULE: SCRIPTED_SDK }),
  }
}

const appArgs = (): string[] => (ROOT ? [APP_DIR, '--no-sandbox'] : [APP_DIR])

interface LaunchOptions {
  /** Use the real `@nexgent/sdk` instead of the scripted one. */
  readonly realSdk?: boolean
  /** Extra command-line arguments after the app directory. */
  readonly args?: readonly string[]
}

async function launch(home: string, options: LaunchOptions = {}): Promise<{ app: ElectronApplication; page: Page; consoleErrors: string[] }> {
  const app = await electron.launch({ args: [...appArgs(), ...(options.args ?? [])], env: appEnv(home, options.realSdk), timeout: TIMEOUT })
  const page = await app.firstWindow({ timeout: TIMEOUT })
  const consoleErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  await page.waitForLoadState('load')
  return { app, page, consoleErrors }
}

// The long path: on Windows tmpdir() can be an 8.3 short path, and the app reports canonical ones.
function newHome(): string {
  return realpathSync.native(mkdtempSync(join(tmpdir(), 'nexgent-desktop-e2e-')))
}

/** Hard-kill the app as a crash would. Windows: the whole tree (`taskkill /T /F`); the app's child processes otherwise outlive it and the restart is refused as a second instance. */
function hardKill(pid: number): void {
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
  else process.kill(pid, 'SIGKILL')
}

function readLog(home: string): string {
  const dir = join(home, 'logs')
  return readdirSync(dir)
    .map((name) => readFileSync(join(dir, name), 'utf8'))
    .join('')
}

function sdkCalls(home: string): string[] {
  const file = join(home, 'sdk-calls.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((line) => (JSON.parse(line) as { method: string }).method)
}

/** Call the registered `nexgent:call` handler from the main process with a hand-made payload, as if the page had sent it. */
async function rawCall(app: ElectronApplication, payload: unknown): Promise<unknown> {
  return app.evaluate(async ({ BrowserWindow, ipcMain }, body) => {
    const window = BrowserWindow.getAllWindows()[0]!
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (event: unknown, payload: unknown) => Promise<unknown>> })._invokeHandlers
    const handler = handlers.get('nexgent:call')!
    return handler({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, body)
  }, payload)
}

/** `window.nexgent.invoke` from the page; a rejection comes back as `{ rejected: ErrorInfo }`. */
async function invoke<T = any>(page: Page, method: string, input: unknown): Promise<T> {
  return page.evaluate(
    ([m, i]) => window.nexgent.invoke(m, i).catch((error: unknown) => ({ rejected: error })),
    [method, input] as const,
  ) as Promise<T>
}

async function waitFor(predicate: () => boolean | Promise<boolean>, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

beforeAll(async () => {
  await ensureDisplay()
}, TIMEOUT)

afterAll(() => {
  xvfb?.kill()
})

describe('desktop app (Electron)', () => {
  it(
    'loads the window isolated and answers IPC through the preload',
    async () => {
      const home = newHome()
      const { app, page, consoleErrors } = await launch(home)
      try {
        expect(page.url()).toBe('app://nexgent/index.html')
        expect(await page.title()).toBe('nexgent-desktop-fixture')

        const prefs = await app.evaluate(({ BrowserWindow }) => {
          const contents = BrowserWindow.getAllWindows()[0]!.webContents as unknown as { getLastWebPreferences(): Record<string, unknown> }
          return contents.getLastWebPreferences()
        })
        expect(prefs).toMatchObject({
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
          nodeIntegrationInWorker: false,
          nodeIntegrationInSubFrames: false,
          webSecurity: true,
          allowRunningInsecureContent: false,
          webviewTag: false,
        })
        // `spellcheck` is not among the reported preferences; the session's checker is off.
        expect(await app.evaluate(({ session }) => session.defaultSession.isSpellCheckerEnabled())).toBe(false)
        expect(readLog(home)).not.toContain('webPreferences violate')

        // The page has no Node and sees only the three bridge members, no token.
        expect(await page.evaluate(() => [typeof (globalThis as { require?: unknown }).require, typeof (globalThis as { process?: unknown }).process])).toEqual(['undefined', 'undefined'])
        const bridge = await page.evaluate(() => {
          const api = (window as unknown as { nexgent: Record<string, unknown> }).nexgent
          return { keys: Object.keys(api).sort(), platform: api['platform'] }
        })
        expect(bridge).toEqual({ keys: ['invoke', 'onEvent', 'pickDirectory', 'pickFiles', 'platform'], platform: process.platform })

        // Round trip.
        const info = await page.evaluate(() => (window as unknown as { nexgent: { invoke(m: string, i: unknown): Promise<unknown> } }).nexgent.invoke('app.info', {}))
        expect(info).toEqual({ sdkVersion: 1, appVersion: '0.0.0', platform: process.platform })

        // SDK errors arrive as plain ErrorInfo with their code.
        const failure = await page.evaluate(() =>
          (window as unknown as { nexgent: { invoke(m: string, i: unknown): Promise<unknown> } }).nexgent.invoke('projects.open', { root: '/no/such/project' }).then(
            () => 'resolved',
            (error: unknown) => error,
          ),
        )
        expect(failure).toMatchObject({ name: 'NexgentError', code: 'workspace/not-found', details: { root: '/no/such/project' } })

        // Invalid input from the page is stopped by the guard.
        const denied = await page.evaluate(() =>
          (window as unknown as { nexgent: { invoke(m: string, i: unknown): Promise<unknown> } }).nexgent.invoke('projects.open', { root: 'relative' }).catch((error: unknown) => error),
        )
        expect(denied).toMatchObject({ code: 'approval/denied', details: { check: 'input' } })

        // Events flow main → page.
        await page.evaluate(() => {
          const w = window as unknown as { nexgent: { onEvent(l: (e: unknown) => void): () => void }; seen: unknown[] }
          w.seen = []
          w.nexgent.onEvent((event) => w.seen.push(event))
        })
        await page.evaluate(() =>
          (window as unknown as { nexgent: { invoke(m: string, i: unknown): Promise<unknown> } }).nexgent.invoke('turns.send', { projectId: 'p', sessionId: 's1', text: '你好' }),
        )
        await waitFor(async () => (await page.evaluate(() => (window as unknown as { seen: unknown[] }).seen.length)) >= 2, 'events')
        const seen = await page.evaluate(() => (window as unknown as { seen: unknown[] }).seen)
        expect(seen).toEqual([
          { projectId: 'p', sessionId: 's1', eventSeq: 1, type: 'turn.start', turn: 1, source: 'user' },
          { projectId: 'p', sessionId: 's1', eventSeq: 2, type: 'text.delta', turn: 1, step: 1, text: 'echo: 你好' },
        ])
        await page.evaluate(() =>
          (window as unknown as { nexgent: { invoke(m: string, i: unknown): Promise<unknown> } }).nexgent.invoke('turns.cancel', { projectId: 'p', sessionId: 's1' }),
        )
        expect(consoleErrors).toEqual([])
      } finally {
        await app.close()
      }
    },
    TIMEOUT * 2,
  )

  it(
    'denies calls with a missing or wrong token or an unlisted method, and logs them without the token',
    async () => {
      const home = newHome()
      const { app, page } = await launch(home)
      try {
        const before = sdkCalls(home).length
        for (const [payload, check] of [
          [{ method: 'app.info', input: {} }, 'token'],
          [{ token: 'x'.repeat(43), method: 'app.info', input: {} }, 'token'],
          [{ token: '', method: 'app.info', input: {} }, 'token'],
        ] as const) {
          expect(await rawCall(app, payload)).toMatchObject({ ok: false, error: { code: 'approval/denied', details: { check } } })
        }
        // The page's own (valid) token through the preload, with a method off the whitelist.
        const unlisted = await page.evaluate(() =>
          (window as unknown as { nexgent: { invoke(m: string, i: unknown): Promise<unknown> } }).nexgent.invoke('fs.readFile', { path: '/etc/passwd' }).catch((error: unknown) => error),
        )
        expect(unlisted).toMatchObject({ code: 'approval/denied', details: { check: 'method' } })
        const info = await page.evaluate(() => (window as unknown as { nexgent: { invoke(m: string, i: unknown): Promise<unknown> } }).nexgent.invoke('app.info', {}))
        expect(info).toMatchObject({ sdkVersion: 1 })
        expect(sdkCalls(home).slice(before)).toEqual(['app.info'])

        const log = readLog(home)
        expect(log.match(/ipc denied window=\d+ method=app\.info check=token/g)).toHaveLength(3)
        expect(log).toMatch(/ipc denied window=\d+ method=fs\.readFile check=method/)
        expect(log).not.toMatch(/[A-Za-z0-9_-]{43}/)
      } finally {
        await app.close()
      }
    },
    TIMEOUT * 2,
  )

  it(
    'refuses external and file:// navigation, new windows, and paths outside the UI directory',
    async () => {
      const home = newHome()
      const { app, page } = await launch(home)
      try {
        await app.evaluate(({ shell }) => {
          const opened: string[] = []
          ;(globalThis as { opened?: string[] }).opened = opened
          shell.openExternal = async (url: string) => {
            opened.push(url)
          }
        })
        for (const target of ['https://example.com/', 'file:///etc/passwd', 'data:text/html,<p>x</p>']) {
          await page.evaluate((url) => {
            window.location.href = url
          }, target)
          await new Promise((resolve) => setTimeout(resolve, 300))
          expect(page.url()).toBe('app://nexgent/index.html')
        }
        await page.evaluate(() => {
          window.open('https://example.com/docs', '_blank')
          window.open('file:///etc/passwd', '_blank')
        })
        await waitFor(async () => (await app.evaluate(() => (globalThis as { opened?: string[] }).opened!.length)) === 1, 'openExternal')
        expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
        expect(await app.evaluate(() => (globalThis as { opened?: string[] }).opened)).toEqual(['https://example.com/docs'])

        const statuses = await page.evaluate(async () => {
          const status = async (url: string): Promise<number> => (await fetch(url)).status
          return [await status('app://nexgent/index.html'), await status('app://nexgent/..%2f..%2fpackage.json'), await status('app://nexgent/missing.js')]
        })
        expect(statuses).toEqual([200, 404, 404])
        const csp = await page.evaluate(async () => (await fetch('app://nexgent/index.html')).headers.get('content-security-policy'))
        expect(csp).toContain("script-src 'self'")

        const log = readLog(home)
        expect(log).toContain('navigation refused: https://example.com/')
        // Chromium itself blocks app:// → file:// and top-level data: (navigation and window.open) before our handlers run;
        // the URL, window-count and openExternal checks above cover them.
      } finally {
        await app.close()
      }
    },
    TIMEOUT * 2,
  )

  it(
    'opens the native pickers for the page through the real SDK',
    async () => {
      const home = newHome()
      const { app, page } = await launch(home, { realSdk: true })
      try {
        const asked: string[] = []
        await app.evaluate(({ dialog }, { dir, files }) => {
          const seen: string[] = []
          ;(globalThis as { pickerCalls?: string[] }).pickerCalls = seen
          dialog.showOpenDialog = (async (...args: unknown[]) => {
            const options = args.at(-1) as { properties: string[] }
            seen.push(options.properties.join(','))
            return options.properties.includes('openDirectory')
              ? { canceled: false, filePaths: [dir] }
              : { canceled: false, filePaths: files }
          }) as typeof dialog.showOpenDialog
        }, { dir: join(home, 'chosen'), files: [join(home, 'chosen', 'a.csv'), join(home, 'chosen', 'b.csv')] })
        expect(await page.evaluate(() => window.nexgent.pickDirectory())).toBe(join(home, 'chosen'))
        expect(await page.evaluate(() => window.nexgent.pickFiles())).toEqual([join(home, 'chosen', 'a.csv'), join(home, 'chosen', 'b.csv')])
        asked.push(...(await app.evaluate(() => (globalThis as { pickerCalls?: string[] }).pickerCalls!)))
        expect(asked).toEqual(['openDirectory,createDirectory', 'openFile,multiSelections'])
        await app.evaluate(({ dialog }) => {
          dialog.showOpenDialog = (async () => ({ canceled: true, filePaths: [] })) as typeof dialog.showOpenDialog
        })
        expect(await page.evaluate(() => window.nexgent.pickDirectory())).toBeNull()
        expect(await page.evaluate(() => window.nexgent.pickFiles())).toEqual([])
      } finally {
        await app.close()
      }
    },
    TIMEOUT * 2,
  )

  it(
    'exports only into the directory picked in the main-process dialog',
    async () => {
      const home = newHome()
      const { app, page } = await launch(home)
      try {
        const picked = join(home, 'picked')
        await app.evaluate(({ dialog }, dir) => {
          dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [dir] })) as typeof dialog.showOpenDialog
        }, picked)
        const result = await page.evaluate(
          (outDir) =>
            (window as unknown as { nexgent: { invoke(m: string, i: unknown): Promise<unknown> } }).nexgent.invoke('sessions.export', { projectId: 'p', sessionId: 's', outDir }),
          join(home, 'page-chose'),
        )
        expect(result).toEqual({ path: picked, files: [] })
      } finally {
        await app.close()
      }
    },
    TIMEOUT * 2,
  )

  it(
    'asks before quitting with a running turn, then cancels it and waits for it before exiting',
    async () => {
      const home = newHome()
      const { app, page } = await launch(home)
      const exited = new Promise<void>((resolve) => app.process().once('exit', () => resolve()))
      await page.evaluate(() =>
        (window as unknown as { nexgent: { invoke(m: string, i: unknown): Promise<unknown> } }).nexgent.invoke('turns.send', { projectId: 'p', sessionId: 's1', text: 'long task' }),
      )
      await new Promise((resolve) => setTimeout(resolve, 200))

      // The user picks "取消": the app stays and the turn keeps running.
      await app.evaluate(({ dialog }) => {
        const asked: string[] = []
        ;(globalThis as { asked?: string[] }).asked = asked
        dialog.showMessageBox = (async (...args: unknown[]) => {
          const options = args.at(-1) as { message: string }
          asked.push(options.message)
          return { response: 1, checkboxChecked: false }
        }) as typeof dialog.showMessageBox
      })
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close())
      await waitFor(async () => (await app.evaluate(() => (globalThis as { asked?: string[] }).asked!.length)) === 1, 'confirmation')
      expect(await app.evaluate(() => (globalThis as { asked?: string[] }).asked)).toEqual(['有 1 个对话正在运行'])
      expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
      expect(existsSync(join(home, 'cancelled.jsonl'))).toBe(false)

      // Now "停止并退出": the turn is cancelled, the SDK disposed, then the process exits.
      await app.evaluate(({ dialog }) => {
        dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as typeof dialog.showMessageBox
      })
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close()).catch(() => undefined)
      await exited
      expect(readFileSync(join(home, 'cancelled.jsonl'), 'utf8')).toContain('"sessionId":"s1"')
      expect(existsSync(join(home, 'disposed.json'))).toBe(true)
      expect(statSync(join(home, 'cancelled.jsonl')).mtimeMs).toBeLessThanOrEqual(statSync(join(home, 'disposed.json')).mtimeMs)
      expect(readLog(home)).toContain('shutdown complete')
    },
    TIMEOUT * 2,
  )

  it(
    'starts again after the main process is killed, and a second instance hands over',
    async () => {
      const home = newHome()
      const first = await launch(home)
      const pid = first.app.process().pid!
      const killed = new Promise<void>((resolve) => first.app.process().once('exit', () => resolve()))
      hardKill(pid)
      await killed

      const second = await launch(home)
      try {
        const info = await second.page.evaluate(() =>
          (window as unknown as { nexgent: { invoke(m: string, i: unknown): Promise<unknown> } }).nexgent.invoke('app.info', {}),
        )
        expect(info).toMatchObject({ sdkVersion: 1 })

        // A further launch on the same home exits at once and leaves the running one alone.
        const third = spawn(ELECTRON_BIN, appArgs(), { env: appEnv(home), stdio: 'ignore' })
        const code = await new Promise<number | null>((resolve) => third.once('exit', resolve))
        expect(code).toBe(0)
        expect(await second.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
        expect(readLog(home)).toContain('another instance is running')
      } finally {
        await second.app.close()
      }
    },
    TIMEOUT * 3,
  )

  it(
    'opens --project through the real SDK, and reopens a session after the main process is killed',
    async () => {
      const home = newHome()
      const project = join(home, 'project')
      mkdirSync(project)
      const first = await launch(home, { realSdk: true, args: ['--project', project] })
      let sessionId: string
      try {
        const recent = await invoke(first.page, 'projects.recent', {})
        expect(recent[0]).toMatchObject({ root: project, exists: true })
        expect(existsSync(join(project, '.nexgent', 'config.json'))).toBe(true)
        const { projectId } = await invoke(first.page, 'projects.open', { root: project })
        const summary = await invoke(first.page, 'sessions.create', { projectId, title: '桌面测试' })
        sessionId = summary.sessionId
        expect(await invoke(first.page, 'sessions.open', { projectId, sessionId })).toMatchObject({ summary: { sessionId, title: '桌面测试' } })
        expect(readLog(home)).toContain(`opened project from the command line: ${project}`)
      } catch (error) {
        await first.app.close()
        throw error
      }
      // Hard kill while the session is open (its lock file names the dead process).
      const killed = new Promise<void>((resolve) => first.app.process().once('exit', () => resolve()))
      hardKill(first.app.process().pid!)
      await killed

      const second = await launch(home, { realSdk: true })
      try {
        const recent = await invoke(second.page, 'projects.recent', {})
        expect(recent[0]).toMatchObject({ root: project })
        const { projectId } = await invoke(second.page, 'projects.open', { root: project })
        const sessions = await invoke<Array<{ sessionId: string }>>(second.page, 'sessions.list', { projectId })
        expect(sessions.map((entry) => entry.sessionId)).toContain(sessionId)
        const view = await invoke(second.page, 'sessions.open', { projectId, sessionId })
        expect(view).toMatchObject({ summary: { sessionId, title: '桌面测试' } })
        expect(view).not.toHaveProperty('rejected')
      } finally {
        await second.app.close()
      }
    },
    TIMEOUT * 3,
  )
})
