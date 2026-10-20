/**
 * Desktop members E2E (step 3, W6): Playwright drives the built Electron app
 * with the real renderer and the real `@nexgent/sdk` against the scripted
 * Claude Messages API server, routed per member — no real model. The main
 * conversation delegates to `writer`, whose `.env` write asks for approval
 * naming the member; its block, deliverable and read-only session show; the
 * deliverables tab separates member output; at 1024 px nothing overflows.
 * Then a second member streams, the main process is hard-killed, and after
 * the restart both member blocks are back (the killed one 已中断) and its
 * session still opens.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { routeByMember, scriptedModelServer, type MessagesRequestBody, type ScriptedModelServer } from '@nexgent/test-support'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { build } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDrawer, fillProjectPath, showTab } from './fixtures/ui.js'

// Code passed to `page.evaluate` runs in the page; the tests' type program has no DOM lib.
declare const window: any
declare const document: any

const APP_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)))
function hardKill(pid: number): void {
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
  else process.kill(pid, 'SIGKILL')
}
const TIMEOUT = 60_000
const ROOT = typeof process.getuid === 'function' && process.getuid() === 0
const usage = { inputTokens: 40, outputTokens: 8, totalTokens: 48, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }

createRequire(import.meta.url)('electron')

let xvfb: ChildProcess | undefined
let display = process.env['DISPLAY']
let rendererDir = ''
let server: ScriptedModelServer | undefined

async function ensureDisplay(): Promise<void> {
  if (process.platform !== 'linux' || (display !== undefined && display !== '')) return
  const child = spawn('Xvfb', ['-displayfd', '1', '-screen', '0', '1440x1000x24', '-nolisten', 'tcp'], { stdio: ['ignore', 'pipe', 'ignore'] })
  xvfb = child
  display = await new Promise<string>((resolve, reject) => {
    let out = ''
    child.once('error', error => reject(new Error(`no DISPLAY and Xvfb could not start: ${error.message}`)))
    child.stdout!.on('data', (chunk: Buffer) => {
      out += chunk.toString()
      if (out.includes('\n')) resolve(`:${out.trim()}`)
    })
  })
}

function appEnv(home: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !key.startsWith('NEXGENT_') && key !== 'ANTHROPIC_API_KEY') env[key] = value
  return {
    ...env,
    ...(display === undefined ? {} : { DISPLAY: display }),
    NEXGENT_HOME: home,
    NEXGENT_DESKTOP_RENDERER_DIR: rendererDir,
    NEXGENT_API_KEY: 'sk-desktop-members-e2e',
    NEXGENT_API_BASE_URL: server!.baseUrl,
  }
}

async function launch(home: string): Promise<{ app: ElectronApplication; page: Page; consoleErrors: string[] }> {
  const app = await electron.launch({ args: ROOT ? [APP_DIR, '--no-sandbox'] : [APP_DIR], env: appEnv(home), timeout: TIMEOUT })
  const page = await app.firstWindow({ timeout: TIMEOUT })
  const consoleErrors: string[] = []
  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', error => consoleErrors.push(error.message))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1280, 820))
  await page.waitForLoadState('load')
  return { app, page, consoleErrors }
}

const systemText = (body: MessagesRequestBody): string => {
  const system = (body as { system?: unknown }).system
  return typeof system === 'string' ? system : Array.isArray(system) ? system.map(block => (block as { text?: string }).text ?? '').join('\n') : ''
}

/** Elements of the three columns wider than their box at the current window size. */
async function overflowAt1024(app: ElectronApplication, page: Page): Promise<string[]> {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1024, 720))
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1024)
  return page.evaluate(() => {
    const out: string[] = []
    if (document.documentElement.scrollWidth > window.innerWidth) out.push(`document ${document.documentElement.scrollWidth}`)
    const middle = ['member-view', 'conversation', 'capabilities-page', 'settings-page'].find(id => document.querySelector(`[data-testid="${id}"]`) !== null) ?? 'conversation'
    const onPage = middle.endsWith('-page')
    for (const id of ['sidebar', middle, 'main', ...(onPage ? [] : ['timeline'])]) {
      const el = document.querySelector(`[data-testid="${id}"]`)
      if (el === null) out.push(`${id} missing`)
      else if (el.scrollWidth > el.clientWidth + 1) out.push(`${id} ${el.scrollWidth}>${el.clientWidth}`)
    }
    for (const el of document.querySelectorAll('[data-testid="member-block"]')) {
      if (el.scrollWidth > el.clientWidth + 1) out.push(`${el.dataset.testid} ${el.scrollWidth}>${el.clientWidth}`)
    }
    const right = document.querySelector('[data-testid="main"]').getBoundingClientRect()
    if (right.right > window.innerWidth + 1) out.push(`main area ends at ${right.right}`)
    return out
  })
}

beforeAll(async () => {
  await ensureDisplay()
  rendererDir = mkdtempSync(join(tmpdir(), 'nexgent-renderer-'))
  await build({ configFile: join(APP_DIR, 'vite.config.ts'), logLevel: 'error', build: { outDir: rendererDir, emptyOutDir: true } })
}, TIMEOUT)

afterAll(async () => {
  await server?.close()
  xvfb?.kill()
})

describe('desktop members over the real SDK (scripted model)', () => {
  it(
    'delegate → member approval → member block and deliverable → read-only member view → 1024 px → kill while a member streams → restart',
    async () => {
      const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'nexgent-members-e2e-')))
      const home = join(base, 'home')
      const root = join(base, 'regions')
      mkdirSync(home)
      server = await scriptedModelServer({
        script: [
          // turn 1: delegate to writer, then close
          { toolCalls: [{ name: 'delegate', arguments: { name: 'writer', task: '写北区汇总 north.md，并设置时区' } }], usage },
          { content: '成员 writer 写好了北区汇总。', usage },
          // turn 2: delegate to slow, which streams until the kill
          { toolCalls: [{ name: 'delegate', arguments: { name: 'slow', task: '慢慢写南区说明' } }], usage },
        ],
        routeKey: routeByMember(systemText),
        routes: {
          writer: [
            { toolCalls: [{ name: 'write_file', arguments: { path: 'north.md', content: '# 北区\n1200\n' } }], usage },
            { toolCalls: [{ name: 'write_file', arguments: { path: '.env', content: 'REPORT_TZ=Asia/Shanghai\n' } }], usage },
            { toolCalls: [{ name: 'present', arguments: { paths: ['north.md'], summary: '北区汇总' } }], usage },
            { content: '北区写好了。', usage },
          ],
          slow: [{ content: Array.from({ length: 600 }, (_, i) => `第${i + 1}句。`), chunkDelayMs: 50 }],
        },
      })

      // ---- first run -------------------------------------------------------
      let { app, page, consoleErrors } = await launch(home)
      try {
        await page.getByTestId('start-screen').waitFor()
        await fillProjectPath(page, root)
        await page.getByTestId('create-project').click()
        await page.getByTestId('workspace').waitFor()
        await page.getByTestId('new-session').click()
        const input = page.getByTestId('composer-input')
        await input.click()
        await page.keyboard.type('让 writer 写北区汇总')
        await page.keyboard.press('Enter')

        // the member block shows while it runs; its approval names it
        const writer = page.locator('[data-testid="member-block"][data-member="writer"]')
        await writer.waitFor({ timeout: 20_000 })
        const dialog = page.getByTestId('approval-dialog')
        await dialog.waitFor({ timeout: 20_000 })
        expect(await dialog.getByTestId('approval-member').textContent()).toBe('成员 writer（委派）请求这一操作')
        expect(await writer.getAttribute('data-status')).toBe('running')
        await dialog.getByTestId('approval-once').click()
        await expect.poll(() => page.getByTestId('assistant-message').last().textContent(), { timeout: 20_000 }).toContain('成员 writer 写好了北区汇总。')
        await page.getByTestId('send').waitFor({ timeout: 20_000 })
        expect(readFileSync(join(root, '.env'), 'utf8')).toBe('REPORT_TZ=Asia/Shanghai\n')

        // finished block: status, deliverable link; the member's own tools stay out of the main conversation
        expect(await writer.getAttribute('data-status')).toBe('completed')
        expect(await page.getByTestId('tool-block').count()).toBe(1)
        expect(await writer.getByTestId('member-deliverable').textContent()).toContain('north.md · 第 1 版')
        await showTab(page, 'deliverables')
        expect(await page.getByTestId('member-deliverables').textContent()).toContain('来自成员 writer')
        expect(await page.getByTestId('final-deliverables').getByText('north.md').count()).toBe(0)
        await closeDrawer(page)

        // 1024 px with the 小组进度 card
        expect(await overflowAt1024(app, page)).toEqual([])

        // the member's session opens read-only
        await writer.getByTestId('open-member').click()
        const view = page.getByTestId('member-view')
        await view.waitFor()
        expect(await view.getByTestId('member-view-title').textContent()).toBe('成员 writer 的会话')
        await expect.poll(() => view.textContent()).toContain('北区写好了。')
        expect(await view.getByTestId('deliverable-card').count()).toBe(1)
        expect(await page.getByTestId('composer-input').count()).toBe(0)
        expect(await overflowAt1024(app, page)).toEqual([])
        await page.getByTestId('member-back').click()
        await page.getByTestId('composer-input').waitFor()
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1280, 820))
        await expect.poll(() => page.getByTestId('session-item').nth(1).getAttribute('title')).toContain('1 个成员')

        // turn 2: hard-kill the main process while the second member streams
        await input.click()
        await page.keyboard.type('让 slow 写南区说明')
        await page.keyboard.press('Enter')
        const slow = page.locator('[data-testid="member-block"][data-member="slow"]')
        await slow.waitFor({ timeout: 20_000 })
        await expect.poll(() => server!.requests.find(r => r.route === 'slow')?.chunksSent ?? 0, { timeout: 20_000 }).toBeGreaterThan(5)
        expect(consoleErrors).toEqual([])
      } finally {
        const exited = new Promise(resolve => app.process().once('exit', resolve).once('error', resolve))
        hardKill(app.process().pid!)
        await exited
      }

      // ---- restart ------------------------------------------------------------
      ;({ app, page, consoleErrors } = await launch(home))
      try {
        await page.getByTestId('workspace').waitFor()
        await expect.poll(() => page.getByTestId('session-item').count()).toBe(2)
        await expect.poll(() => page.getByTestId('session-item').nth(1).getAttribute('title')).toContain('2 个成员')
        await expect.poll(() => page.getByTestId('member-block').count(), { timeout: 20_000 }).toBe(2)
        const slow = page.locator('[data-testid="member-block"][data-member="slow"]')
        await expect.poll(() => slow.getAttribute('data-status'), { timeout: 20_000 }).toBe('interrupted')
        expect(await slow.getByTestId('member-status').textContent()).toBe('已中断')
        expect(await page.locator('[data-testid="member-block"][data-member="writer"]').getAttribute('data-status')).toBe('completed')

        // the killed member's session is still there, with what it streamed
        await slow.getByTestId('open-member').click()
        const view = page.getByTestId('member-view')
        await view.waitFor()
        expect(await view.getByTestId('member-view-title').textContent()).toBe('成员 slow 的会话')
        await expect.poll(() => view.textContent()).toContain('慢慢写南区说明')
        await page.getByTestId('member-back').click()
        await page.getByTestId('composer-input').waitFor()
        expect(consoleErrors).toEqual([])
      } finally {
        await app.close()
      }
    },
    240_000,
  )
})
