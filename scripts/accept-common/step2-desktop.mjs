/**
 * The desktop layer of accept-step2 (D01–D10): Playwright drives the built
 * Electron app (apps/desktop, real renderer built here with vite, real
 * `@nexgent/sdk` in the main process) against the scripted Claude Messages
 * API server — no real model. One project goes through the chain the way a
 * user would, following apps/desktop/tests/ui-e2e.spec.ts: create project →
 * two materials → send with an @ mention (streamed text, tool blocks) →
 * approval → deliverable card → feedback → v2 and the diff → stop mid-stream
 * → settings → hard kill mid-turn → restart → everything is back → continue;
 * plus the IPC token checks.
 *
 * The scenario only observes; the D judges (step2-desktop-judges.mjs) decide.
 * A step that throws stops the scenario and is recorded in `obs.error`; the
 * items that depended on later steps then fail with that error as evidence.
 *
 * The app gets a fake key and a loopback base URL; NEXGENT_* and
 * ANTHROPIC_API_KEY from this process's environment are never passed on.
 */
import { spawn } from 'node:child_process'
import { access, copyFile, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isLoopbackUrl } from './step2-runtime.mjs'

// No trailing separator: on Windows a trailing backslash escapes the closing quote of the argument.
export const DESKTOP_DIR = resolve(fileURLToPath(new URL('../../apps/desktop/', import.meta.url)))
const MAIN_ENTRY = join(DESKTOP_DIR, 'dist', 'main', 'index.js')
const VITE_BIN = join(DESKTOP_DIR, 'node_modules', 'vite', 'bin', 'vite.js')
const XLSX_SOURCE = fileURLToPath(new URL('../../packages/skill/tests/fixtures/orders.xlsx', import.meta.url))
const TIMEOUT = 60_000
const WAIT = 20_000
const ROOT_USER = typeof process.getuid === 'function' && process.getuid() === 0

/** Fake key the app runs with; D09 checks it never reaches the page or config.json. */
export const DESKTOP_KEY = 'sk-accept-step2-desktop-5b8e2c71'
export const LONG_TEXT = Array.from({ length: 40 }, (_, i) => `第${i + 1}段说明。`)
export const TEXTS = {
  firstTurn: '写一份按地区的汇总。',
  feedbackDone: '已按反馈修改。',
  killStream: '重复订单的处理',
  continued: '重复订单按订单号只保留一条。',
}
export const ENV_CONTENT = 'REPORT_TZ=Asia/Shanghai\n'
export const SETTINGS = { model: 'claude-opus-5-5', thinking: 'off', perTaskTokens: 100000, perProjectRequests: 300 }

const usage = { inputTokens: 40, outputTokens: 8, totalTokens: 48, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }

const presentedId = (body) => {
  const match = /Presented deliverable ([0-9a-f-]{36})/.exec(JSON.stringify(body))
  if (match === null) throw new Error('no present result in the request')
  return match[1]
}

/** The scripted model's replies, in request order. */
export function desktopScript() {
  return [
    // turn 1: stream slowly (so the UI shows it streaming), write, ask approval (.env), present, close
    { reasoning: '先读资料再写汇总。', content: ['我先', '写一份', '按地区的汇总。'], chunkDelayMs: 250, toolCalls: [{ name: 'write_file', arguments: { path: 'report/summary.csv', content: 'region,total\nnorth,1200\nsouth,80\n' } }], usage },
    { toolCalls: [{ name: 'write_file', arguments: { path: '.env', content: ENV_CONTENT } }], usage },
    { toolCalls: [{ name: 'present', arguments: { paths: ['report/summary.csv'], summary: '按地区汇总的销售额' } }], usage },
    { content: '成果已交付，请查看。', usage },
    // turn 2 (feedback): edit in place, present v2
    { toolCalls: [{ name: 'str_replace', arguments: { path: 'report/summary.csv', old_str: 'north,1200', new_str: '华北,1200' } }], usage },
    body => ({ toolCalls: [{ name: 'present', arguments: { paths: ['report/summary.csv'], summary: '地区改为中文名', deliverableId: presentedId(body) } }], usage }),
    { content: TEXTS.feedbackDone, usage },
    // turn 3: a long slow stream, stopped by the user
    { content: LONG_TEXT, chunkDelayMs: 150, usage },
    // turn 4: two text chunks, then hangs; the main process is killed here
    { content: ['正在补充', TEXTS.killStream], fault: { kind: 'timeout', afterChunks: 4 } },
    // after restart
    { content: TEXTS.continued, usage },
  ]
}

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * Prerequisites, checked without starting anything.
 * @returns `{ ok: true }` or `{ ok: false, reason }`.
 */
export async function desktopPrerequisites() {
  if (!(await exists(join(DESKTOP_DIR, 'package.json')))) return { ok: false, reason: 'apps/desktop does not exist' }
  if (!(await exists(MAIN_ENTRY))) return { ok: false, reason: 'apps/desktop is not built (run `pnpm build`)' }
  if (!(await exists(VITE_BIN))) return { ok: false, reason: 'vite is not installed for apps/desktop (run `pnpm install`)' }
  try {
    createRequire(join(DESKTOP_DIR, 'package.json'))('electron')
  } catch (error) {
    return { ok: false, reason: `the electron binary is missing (${error instanceof Error ? error.message : String(error)})` }
  }
  try {
    await import('playwright-core')
  } catch (error) {
    return { ok: false, reason: `playwright-core failed to load (${error instanceof Error ? error.message : String(error)})` }
  }
  return { ok: true }
}

function run(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', chunk => (stderr += chunk.toString()))
    child.once('error', error => resolve({ code: -1, stderr: error.message }))
    child.once('exit', code => resolve({ code, stderr }))
  })
}

/** Linux without a display: start Xvfb. Returns `{ display, stop }`. */
async function ensureDisplay() {
  const current = process.env['DISPLAY']
  if (process.platform !== 'linux' || (current !== undefined && current !== '')) return { display: current, stop() {} }
  const child = spawn('Xvfb', ['-displayfd', '1', '-screen', '0', '1440x1000x24', '-nolisten', 'tcp'], { stdio: ['ignore', 'pipe', 'ignore'] })
  const display = await new Promise((resolve, reject) => {
    let out = ''
    const timer = setTimeout(() => reject(new Error('Xvfb did not report a display')), 15_000)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(new Error(`no DISPLAY and Xvfb could not start: ${error.message}`))
    })
    child.stdout.on('data', (chunk) => {
      out += chunk.toString()
      if (out.includes('\n')) {
        clearTimeout(timer)
        resolve(`:${out.trim()}`)
      }
    })
  })
  return { display, stop: () => child.kill() }
}

async function poll(read, ok, what, ms = WAIT) {
  const deadline = Date.now() + ms
  let last
  for (;;) {
    try {
      last = await read()
      if (ok(last)) return last
    } catch {
      // not there yet
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what} (last ${JSON.stringify(last)?.slice(0, 200)})`)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

async function sessionRecords(root) {
  const dir = join(root, '.nexgent', 'sessions')
  const [id] = await readdir(dir)
  return (await readFile(join(dir, id, 'session.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
}

async function readLogs(home) {
  const dir = join(home, 'logs')
  if (!(await exists(dir))) return ''
  const names = await readdir(dir)
  return (await Promise.all(names.map(name => readFile(join(dir, name), 'utf8')))).join('')
}

/**
 * Run the desktop scenario.
 * @param harness - @nexgent/test-support (scriptedModelServer).
 * @param work - an empty work directory.
 * @param options - `log(line)`.
 * @returns observations for the D judges.
 */
export async function runDesktopScenario(harness, work, { log = () => {} } = {}) {
  const { _electron: electron } = await import('playwright-core')
  // The long path: on Windows tmpdir() can be an 8.3 short path, and the app reports canonical ones.
  work = await realpath(work)
  const obs = { consoleErrors: { first: [], second: [] } }
  const rendererDir = join(work, 'renderer')
  const home = join(work, 'home')
  const root = join(work, 'sales')
  const csv = join(work, 'orders.csv')
  const xlsx = join(work, 'regions.xlsx')
  await mkdir(home, { recursive: true })
  await writeFile(csv, 'order,region,amount\n1,north,"1,200"\n2,south,80\n2,south,80\n')
  await copyFile(XLSX_SOURCE, xlsx)

  let server
  let display
  let app
  let step = 'setup'
  const launch = async (which) => {
    const env = {}
    for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !key.startsWith('NEXGENT_') && key !== 'ANTHROPIC_API_KEY') env[key] = value
    Object.assign(env, display.display === undefined ? {} : { DISPLAY: display.display }, {
      NEXGENT_HOME: home,
      NEXGENT_DESKTOP_RENDERER_DIR: rendererDir,
      NEXGENT_API_KEY: DESKTOP_KEY,
      NEXGENT_API_BASE_URL: server.baseUrl,
    })
    const launched = await electron.launch({ args: ROOT_USER ? [DESKTOP_DIR, '--no-sandbox'] : [DESKTOP_DIR], env, timeout: TIMEOUT })
    app = launched
    const page = await launched.firstWindow({ timeout: TIMEOUT })
    page.on('console', (message) => {
      if (message.type() === 'error') obs.consoleErrors[which].push(message.text())
    })
    page.on('pageerror', error => obs.consoleErrors[which].push(error.message))
    await launched.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 820))
    await page.waitForLoadState('load')
    return { app: launched, page }
  }
  // Descendants of every killed main process, so none outlives the run (on
  // Windows they kept the stdio pipes open and the script never exited).
  const orphans = new Set()
  const kill = async (target) => {
    if (target === undefined) return
    const child = target.process()
    if (child.exitCode !== null || child.signalCode !== null) return
    const descendants = await harness.descendantPids(child.pid).catch(() => [])
    for (const pid of descendants) orphans.add(pid)
    const exited = new Promise(resolve => child.once('exit', resolve).once('error', resolve))
    // Windows: the whole tree, as a crash would; killing electron.exe alone left its
    // children running and the restart was refused as a second instance.
    if (process.platform === 'win32') await harness.killProcessTree(child.pid)
    else child.kill('SIGKILL')
    await exited
    return descendants
  }
  // Wait for the killed main process's children to go away by themselves; returns those still alive.
  const lingering = async (pids, ms) => {
    const until = Date.now() + ms
    let alive = pids.filter(pid => harness.isProcessAlive(pid))
    while (alive.length > 0 && Date.now() < until) {
      await new Promise(resolve => setTimeout(resolve, 250))
      alive = alive.filter(pid => harness.isProcessAlive(pid))
    }
    return alive
  }

  try {
    step = 'build renderer'
    log('building the renderer')
    const built = await run(process.execPath, [VITE_BIN, 'build', '--outDir', rendererDir, '--emptyOutDir', '--logLevel', 'error'], { cwd: DESKTOP_DIR })
    if (built.code !== 0) throw new Error(`vite build exited ${built.code}: ${built.stderr.slice(0, 400)}`)

    step = 'start display and scripted server'
    display = await ensureDisplay()
    server = await harness.scriptedModelServer({ script: desktopScript() })
    if (!isLoopbackUrl(server.baseUrl)) throw new Error(`scripted server is not on loopback: ${server.baseUrl}`)

    // ---- first run -----------------------------------------------------------
    step = 'D01 launch'
    log('launching the app')
    let { page } = await launch('first')
    obs.window = await app.evaluate(({ BrowserWindow, session }) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents
      const prefs = contents.getLastWebPreferences()
      return {
        url: contents.getURL(),
        prefs: {
          contextIsolation: prefs.contextIsolation,
          sandbox: prefs.sandbox,
          nodeIntegration: prefs.nodeIntegration,
          nodeIntegrationInWorker: prefs.nodeIntegrationInWorker,
          nodeIntegrationInSubFrames: prefs.nodeIntegrationInSubFrames,
          webSecurity: prefs.webSecurity,
          allowRunningInsecureContent: prefs.allowRunningInsecureContent,
          webviewTag: prefs.webviewTag,
        },
        spellcheck: session.defaultSession.isSpellCheckerEnabled(),
      }
    })
    obs.window.pageGlobals = await page.evaluate(() => [typeof globalThis.require, typeof globalThis.process])
    obs.window.bridgeKeys = await page.evaluate(() => Object.keys(globalThis.nexgent ?? {}).sort())
    await page.getByTestId('start-screen').waitFor({ timeout: WAIT })
    obs.window.startScreen = true

    step = 'D02 create project'
    await page.getByTestId('project-path').fill(root)
    await page.getByTestId('create-project').click()
    await page.getByTestId('workspace').waitFor({ timeout: WAIT })
    await page.getByTestId('new-session').click()
    await page.getByTestId('composer-input').waitFor({ timeout: WAIT })
    obs.project = { created: true, config: JSON.parse(await readFile(join(root, '.nexgent', 'config.json'), 'utf8')) }

    step = 'D03 add materials'
    // The native file dialog is stubbed in the main process: it returns both files at once.
    await app.evaluate(({ dialog }, files) => {
      const calls = []
      globalThis.acceptDialogCalls = calls
      dialog.showOpenDialog = async (...args) => {
        calls.push(args.at(-1)?.properties ?? [])
        return { canceled: false, filePaths: files }
      }
    }, [csv, xlsx])
    await page.getByTestId('materials-panel').locator('button.primary.full').click()
    obs.materials = {
      dialogCalls: await poll(() => app.evaluate(() => globalThis.acceptDialogCalls), calls => calls.length >= 1, 'the file dialog'),
      count: await poll(() => page.getByTestId('material-item').count(), n => n === 2, 'two material items'),
      listText: await page.getByTestId('material-list').textContent(),
      onDisk: (await readdir(join(root, '.nexgent', 'materials'))).length,
    }

    step = 'D04 send and stream'
    log('turn 1: send, stream, approve, present')
    const input = page.getByTestId('composer-input')
    await input.click()
    await page.keyboard.type('按地区汇总订单 @orders')
    await page.getByTestId('mention-menu').waitFor({ timeout: WAIT })
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')
    const streaming = page.locator('[data-testid="assistant-message"][data-streaming="true"]')
    const partialText = await poll(() => streaming.first().textContent({ timeout: 200 }), text => typeof text === 'string' && text.length > 0, 'a streaming assistant message')
    obs.stream = {
      partialText,
      finalText: await poll(() => page.getByTestId('assistant-message').first().textContent(), text => (text ?? '').includes(TEXTS.firstTurn), 'the full first reply'),
      toolBlocksDuringTurn: await poll(() => page.getByTestId('tool-block').count(), n => n >= 1, 'a tool block'),
      userMessage: await page.getByTestId('user-message').first().textContent(),
      firstRequestMentionsBoth: ['orders.csv', 'regions.xlsx'].every(name => JSON.stringify(server.requests[0]?.body?.messages ?? []).includes(name)),
    }

    step = 'D05 approval'
    await page.getByTestId('approval-dialog').waitFor({ timeout: WAIT })
    obs.approval = { dialogShown: true, envBefore: await exists(join(root, '.env')) }
    await page.getByTestId('approval-once').click()
    await page.getByTestId('deliverable-card').waitFor({ timeout: WAIT })
    await page.getByTestId('send').waitFor({ timeout: WAIT })
    obs.approval.dialogGone = (await page.getByTestId('approval-dialog').count()) === 0
    obs.approval.envAfter = await readFile(join(root, '.env'), 'utf8').catch(() => null)
    obs.approval.toolBlocks = await page.getByTestId('tool-block').count()
    obs.approval.turnEnds = (await sessionRecords(root)).filter(r => r.type === 'turn.end').map(r => r.reason?.kind)

    step = 'D06 feedback and diff'
    log('turn 2: feedback → v2 → diff')
    obs.deliverable = { cardsAfterFirst: await page.getByTestId('deliverable-card').count() }
    await page.getByTestId('give-feedback').click()
    const view = page.getByTestId('deliverable-view')
    obs.deliverable.v1Content = await poll(() => view.getByTestId('file-content').textContent(), text => (text ?? '').includes('north,1200'), 'v1 content in the viewer')
    await view.getByLabel('3', { exact: true }).click()
    await view.getByTestId('feedback-comment').fill('地区要用中文名')
    await view.getByTestId('submit-feedback').click()
    obs.deliverable.cardsAfterFeedback = await poll(() => page.getByTestId('deliverable-card').count(), n => n === 2, 'the v2 card')
    await page.getByTestId('send').waitFor({ timeout: WAIT })
    await page.getByTestId('open-diff').click()
    const diff = page.getByTestId('diff-view')
    await diff.waitFor({ timeout: WAIT })
    obs.deliverable.diffText = await diff.textContent()
    obs.deliverable.removed = await diff.locator('[data-op="remove"]').allTextContents()
    obs.deliverable.added = await diff.locator('[data-op="add"]').allTextContents()
    await page.keyboard.press('Escape')
    await page.getByTestId('tab-deliverables').click()
    obs.deliverable.items = await page.getByTestId('deliverable-item').count()
    await page.getByTestId('tab-materials').click()
    const afterFeedback = await sessionRecords(root)
    obs.deliverable.feedback = afterFeedback.filter(r => r.type === 'feedback').map(r => ({ version: r.feedback?.version, rating: r.feedback?.rating }))
    obs.deliverable.versions = afterFeedback.filter(r => r.type === 'deliverable.presented').map(r => r.deliverable?.version)

    step = 'D07 stop'
    log('turn 3: stop mid-stream')
    await input.click()
    await page.keyboard.type('解释一下清洗规则')
    await page.keyboard.press('Enter')
    await poll(() => streaming.textContent({ timeout: 200 }), text => (text ?? '').includes('第3段说明。'), 'three streamed paragraphs')
    await page.getByTestId('stop').click()
    const records = async () => sessionRecords(root)
    obs.stop = {
      turnEndLabel: await poll(() => page.getByTestId('turn-end').last().textContent(), text => text === '已停止', 'the stopped marker'),
      kept: (await page.getByTestId('assistant-message').last().textContent()) ?? '',
    }
    const stopped = await records()
    obs.stop.interrupted = stopped.filter(r => r.type === 'assistant.message' && r.interrupted === true).map(r => String(r.content))
    obs.stop.turnEnds = stopped.filter(r => r.type === 'turn.end').map(r => r.reason?.kind)

    step = 'D09 settings'
    log('settings')
    await page.getByTestId('open-settings').click()
    const settings = page.getByTestId('settings-page')
    await settings.getByTestId('setting-model').fill(SETTINGS.model)
    await settings.getByTestId('setting-thinking').selectOption(SETTINGS.thinking)
    await settings.getByTestId('cap-task-tokens').fill(String(SETTINGS.perTaskTokens))
    await settings.getByTestId('cap-project-requests').fill(String(SETTINGS.perProjectRequests))
    obs.settings = { keyStatus: await settings.getByTestId('api-key-status').textContent() }
    await settings.getByTestId('settings-save').click()
    await settings.getByTestId('settings-saved').waitFor({ timeout: WAIT })
    const configText = await readFile(join(root, '.nexgent', 'config.json'), 'utf8')
    obs.settings.config = JSON.parse(configText)
    obs.settings.configHasKey = configText.includes(DESKTOP_KEY)
    obs.settings.pageHasKey = (await page.content()).includes(DESKTOP_KEY)
    await page.keyboard.press('Escape')

    step = 'D10 IPC tokens'
    obs.ipc = await app.evaluate(async ({ BrowserWindow, ipcMain }) => {
      const window = BrowserWindow.getAllWindows()[0]
      const handler = ipcMain._invokeHandlers.get('nexgent:call')
      const call = payload => handler({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, payload)
      return {
        missing: await call({ method: 'projects.recent', input: {} }),
        wrong: await call({ token: 'x'.repeat(43), method: 'projects.recent', input: {} }),
        empty: await call({ token: '', method: 'projects.recent', input: {} }),
      }
    })
    obs.ipc.unlisted = await page.evaluate(() => globalThis.nexgent.invoke('fs.readFile', { path: '/etc/passwd' }).then(() => 'resolved', error => error))
    obs.ipc.valid = await page.evaluate(() => globalThis.nexgent.invoke('projects.recent', {}).then(value => value, error => ({ rejected: error })))
    const logs = await readLogs(home)
    obs.ipc.loggedTokenDenials = (logs.match(/ipc denied window=\d+ method=projects\.recent check=token/g) ?? []).length
    obs.ipc.logHasToken = /[A-Za-z0-9_-]{43}/.test(logs)

    step = 'D08 kill mid-turn'
    log('turn 4: hard kill mid-stream')
    await input.click()
    await page.keyboard.type('把重复订单的处理也写清楚')
    await page.keyboard.press('Enter')
    obs.kill = { streamedBeforeKill: await poll(() => page.getByTestId('assistant-message').last().textContent(), text => (text ?? '').includes(TEXTS.killStream), 'the turn-4 stream') }
    obs.kill.runningBeforeKill = (await page.getByTestId('stop').count()) > 0
    const descendants = (await kill(app)) ?? []
    obs.kill.descendants = descendants.length
    obs.kill.lingering = (await lingering(descendants, 15_000)).length
    if (obs.kill.lingering > 0) log(`hard kill: ${obs.kill.lingering} of ${descendants.length} child process(es) still alive 15 s after the main process died`)
    app = undefined

    // ---- restart -------------------------------------------------------------
    step = 'D08 restart'
    log('restart')
    ;({ page } = await launch('second'))
    await page.getByTestId('workspace').waitFor({ timeout: WAIT })
    obs.restart = {
      reopened: true,
      sessions: await poll(() => page.getByTestId('session-item').count(), n => n === 1, 'one session in the sidebar'),
      turnEndLabel: await poll(() => page.getByTestId('turn-end').last().textContent(), text => text === '上次运行被中断（应用曾意外退出）', 'the interrupted marker'),
      materials: await page.getByTestId('material-item').count(),
      cards: await page.getByTestId('deliverable-card').count(),
      recent: await page.evaluate(() => globalThis.nexgent.invoke('projects.recent', {}).then(value => value.map(entry => entry.root), () => null)),
    }
    await page.getByTestId('composer-input').click()
    await page.keyboard.type('继续')
    await page.keyboard.press('Enter')
    obs.restart.continued = await poll(() => page.getByTestId('assistant-message').last().textContent(), text => (text ?? '').includes(TEXTS.continued), 'the continued reply')
    await page.getByTestId('send').waitFor({ timeout: WAIT })
    obs.restart.turnEnds = (await records()).filter(r => r.type === 'turn.end').map(r => r.reason?.kind)
    try {
      server.assertConsumed()
      obs.restart.scriptConsumed = true
    } catch (error) {
      obs.restart.scriptConsumed = false
      obs.restart.scriptError = error instanceof Error ? error.message : String(error)
    }
    obs.projectRoot = root

    step = 'close'
    const closing = app
    app = undefined
    await closing.close()
  } catch (error) {
    obs.error = { step, message: error instanceof Error ? (error.stack ?? error.message) : String(error) }
    log(`scenario stopped at ${step}: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    await kill(app).catch(() => undefined)
    for (const pid of orphans) if (harness.isProcessAlive(pid)) await harness.killProcessTree(pid).catch(() => undefined)
    await server?.close().catch(() => undefined)
    display?.stop()
  }
  return obs
}
