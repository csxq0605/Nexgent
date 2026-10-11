/**
 * Desktop UI E2E (W6): Playwright drives the built Electron app with the
 * real renderer (`src/renderer`, built here with vite) and the real
 * `@nexgent/sdk`, against the scripted Claude Messages API server — no real
 * model. One project goes through the whole chain the way a user would:
 * create project → add two materials → send with an @ mention → streamed
 * text and tool blocks → approval → deliverable card → feedback → v2 and the
 * v1→v2 diff → stop mid-stream → settings written to config.json → hard kill
 * mid-turn → restart → everything is back → continue.
 *
 * Set `NEXGENT_UI_SCREENSHOTS=<dir>` to save screenshots of the main views.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scriptedModelServer, type MessagesRequestBody, type ScriptedModelServer } from '@nexgent/test-support'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { build } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Code passed to `page.evaluate` runs in the page; the tests' type program has no DOM lib.
declare const window: any
declare const document: any

const APP_DIR = fileURLToPath(new URL('..', import.meta.url))
const XLSX = fileURLToPath(new URL('../../../packages/skill/tests/fixtures/orders.xlsx', import.meta.url))
const TIMEOUT = 60_000
const ROOT = typeof process.getuid === 'function' && process.getuid() === 0
const KEY = 'sk-desktop-ui-e2e-7f3a9c1d'
const SHOTS = process.env['NEXGENT_UI_SCREENSHOTS']
const usage = { inputTokens: 40, outputTokens: 8, totalTokens: 48, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }

// Resolved for its side effect: fails early when the electron binary is missing.
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
    NEXGENT_API_KEY: KEY,
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

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS === undefined || SHOTS === '') return
  mkdirSync(SHOTS, { recursive: true })
  await page.screenshot({ path: join(SHOTS, `${name}.png`) })
}

const presentedId = (body: MessagesRequestBody): string => {
  const match = /Presented deliverable ([0-9a-f-]{36})/.exec(JSON.stringify(body))
  if (match === null) throw new Error('no present result in the request')
  return match[1]!
}

function sessionRecords(root: string): Array<Record<string, any>> {
  const dir = join(root, '.nexgent', 'sessions')
  const [id] = readdirSync(dir)
  return readFileSync(join(dir, id!, 'session.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as Record<string, any>)
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

describe('desktop UI over the real SDK (scripted model)', () => {
  it(
    'runs materials → execute → approve → present → feedback → v2 → stop → settings → kill → restart → continue',
    async () => {
      const base = mkdtempSync(join(tmpdir(), 'nexgent-ui-e2e-'))
      const home = join(base, 'home')
      const root = join(base, 'sales')
      mkdirSync(home)
      const csv = join(base, 'orders.csv')
      const xlsx = join(base, 'regions.xlsx')
      writeFileSync(csv, 'order,region,amount\n1,north,"1,200"\n2,south,80\n2,south,80\n')
      copyFileSync(XLSX, xlsx)

      const longText = Array.from({ length: 40 }, (_, i) => `第${i + 1}段说明。`)
      server = await scriptedModelServer({
        script: [
          // turn 1: stream, write, ask approval (.env), present, close
          { reasoning: '先读资料再写汇总。', content: ['我先', '写一份', '按地区的汇总。'], chunkDelayMs: 40, toolCalls: [{ name: 'write_file', arguments: { path: 'report/summary.csv', content: 'region,total\nnorth,1200\nsouth,80\n' } }], usage },
          { toolCalls: [{ name: 'write_file', arguments: { path: '.env', content: 'REPORT_TZ=Asia/Shanghai\n' } }], usage },
          { toolCalls: [{ name: 'present', arguments: { paths: ['report/summary.csv'], summary: '按地区汇总的销售额' } }], usage },
          { content: '成果已交付，请查看。', usage },
          // turn 2 (feedback): edit in place, present v2
          { toolCalls: [{ name: 'str_replace', arguments: { path: 'report/summary.csv', old_str: 'north,1200', new_str: '华北,1200' } }], usage },
          body => ({ toolCalls: [{ name: 'present', arguments: { paths: ['report/summary.csv'], summary: '地区改为中文名', deliverableId: presentedId(body) } }], usage }),
          { content: '已按反馈修改。', usage },
          // turn 3: a long slow stream, stopped by the user
          { content: longText, chunkDelayMs: 150, usage },
          // turn 4: streams two text chunks (SSE events 3 and 4), then hangs; the main process is killed here
          { content: ['正在补充', '重复订单的处理'], fault: { kind: 'timeout', afterChunks: 4 } },
          // after restart: the continued conversation
          { content: '重复订单按订单号只保留一条。', usage },
        ],
      })

      // ---- first run -------------------------------------------------------
      let { app, page, consoleErrors } = await launch(home)
      try {
        await page.getByTestId('start-screen').waitFor()
        // the real preload has the native pickers, so their buttons show
        await page.getByTestId('pick-directory').waitFor()
        await shot(page, '01-start')
        // D02: create the project by path
        await page.getByTestId('project-path').fill(root)
        await page.getByTestId('create-project').click()
        await page.getByTestId('workspace').waitFor()
        await page.getByTestId('new-session').click()
        await page.getByTestId('composer-input').waitFor()
        expect(JSON.parse(readFileSync(join(root, '.nexgent', 'config.json'), 'utf8'))).toMatchObject({ version: 1 })

        // D03: two materials appear in the right column
        for (const file of [csv, xlsx]) {
          await page.getByTestId('material-path').fill(file)
          await page.getByTestId('add-material').click()
        }
        await expect.poll(() => page.getByTestId('material-item').count()).toBe(2)
        expect(await page.getByTestId('material-list').textContent()).toContain('regions.xlsx')

        // D04: send with an @ mention; text streams in and tool blocks appear
        const input = page.getByTestId('composer-input')
        await input.click()
        await page.keyboard.type('按地区汇总订单 @orders')
        await page.getByTestId('mention-menu').waitFor()
        await page.keyboard.press('Enter')
        await page.keyboard.press('Enter')
        await expect.poll(() => page.getByTestId('assistant-message').first().textContent()).toContain('按地区的汇总')
        await expect.poll(() => page.getByTestId('tool-block').count()).toBeGreaterThanOrEqual(1)
        const userMessage = await page.getByTestId('user-message').first().textContent()
        expect(userMessage).toContain('@orders.csv')
        // both materials were referenced (the mention plus the one added since the last turn)
        expect(JSON.stringify(server.requests[0]!.body!.messages)).toContain('regions.xlsx')

        // D05: approval dialog; allowing once lets the turn continue
        await page.getByTestId('approval-dialog').waitFor({ timeout: 20_000 })
        await shot(page, '02-approval')
        await page.getByTestId('approval-once').click()
        await page.getByTestId('deliverable-card').waitFor({ timeout: 20_000 })
        await page.getByTestId('send').waitFor({ timeout: 20_000 })
        expect(readFileSync(join(root, '.env'), 'utf8')).toBe('REPORT_TZ=Asia/Shanghai\n')
        expect(await page.getByTestId('tool-block').count()).toBe(3)
        await shot(page, '03-deliverable')

        // D06: feedback from the card → v2 → the diff shows the change
        await page.getByTestId('give-feedback').click()
        const view = page.getByTestId('deliverable-view')
        await expect.poll(() => view.getByTestId('file-content').textContent()).toContain('north,1200')
        await view.getByLabel('3', { exact: true }).click()
        await view.getByTestId('feedback-comment').fill('地区要用中文名')
        await shot(page, '04-feedback')
        await view.getByTestId('submit-feedback').click()
        await expect.poll(() => page.getByTestId('deliverable-card').count(), { timeout: 20_000 }).toBe(2)
        await page.getByTestId('send').waitFor({ timeout: 20_000 })
        await page.getByTestId('open-diff').click()
        const diff = page.getByTestId('diff-view')
        await diff.waitFor()
        expect(await diff.textContent()).toContain('v1 → v2')
        expect(await diff.locator('[data-op="remove"]').allTextContents()).toEqual(['-north,1200'])
        expect(await diff.locator('[data-op="add"]').allTextContents()).toEqual(['+华北,1200'])
        await shot(page, '05-diff')
        await page.keyboard.press('Escape')
        await page.getByTestId('tab-deliverables').click()
        expect(await page.getByTestId('deliverable-item').count()).toBe(1)
        await page.getByTestId('tab-materials').click()

        // D07: stop mid-stream; the streamed text stays in the UI and in the session
        await input.click()
        await page.keyboard.type('解释一下清洗规则')
        await page.keyboard.press('Enter')
        const streaming = page.locator('[data-testid="assistant-message"][data-streaming="true"]')
        await expect.poll(() => streaming.textContent().catch(() => ''), { timeout: 20_000 }).toContain('第3段说明。')
        await page.getByTestId('stop').click()
        await expect.poll(() => page.getByTestId('turn-end').last().textContent(), { timeout: 20_000 }).toBe('已停止')
        const kept = (await page.getByTestId('assistant-message').last().textContent()) ?? ''
        expect(kept).toContain('第1段说明。第2段说明。第3段说明。')
        expect(kept).toContain('已中断')
        const interrupted = sessionRecords(root).filter(r => r['type'] === 'assistant.message' && r['interrupted'] === true)
        expect(interrupted).toHaveLength(1)
        expect(String(interrupted[0]!['content'])).toContain('第1段说明。第2段说明。第3段说明。')
        expect(kept).toContain(String(interrupted[0]!['content']))
        expect(sessionRecords(root).filter(r => r['type'] === 'turn.end').map(r => r['reason']['kind'])).toEqual(['completed', 'completed', 'cancelled'])

        // 1024 px: the three columns fit without horizontal overflow
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1024, 720))
        await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1024)
        const overflow = await page.evaluate(() => {
          const out: string[] = []
          if (document.documentElement.scrollWidth > window.innerWidth) out.push(`document ${document.documentElement.scrollWidth}`)
          for (const id of ['sidebar', 'conversation', 'right-panel', 'timeline', 'composer']) {
            const el = document.querySelector(`[data-testid="${id}"]`)
            if (el === null) out.push(`${id} missing`)
            else if (el.scrollWidth > el.clientWidth + 1) out.push(`${id} ${el.scrollWidth}>${el.clientWidth}`)
          }
          const right = document.querySelector('[data-testid="right-panel"]').getBoundingClientRect()
          if (right.right > window.innerWidth + 1) out.push(`right panel ends at ${right.right}`)
          return out
        })
        expect(overflow).toEqual([])
        await shot(page, '06-workspace-1024')
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1280, 820))

        // D09: settings land in config.json; the key shows only configured / source
        await page.getByTestId('open-settings').click()
        const settings = page.getByTestId('settings-page')
        await settings.getByTestId('setting-model').fill('claude-opus-5-5')
        await settings.getByTestId('setting-thinking').selectOption('off')
        await settings.getByTestId('cap-task-tokens').fill('100000')
        await settings.getByTestId('cap-project-requests').fill('300')
        expect(await settings.getByTestId('api-key-status').textContent()).toBe('已配置（来源：环境变量）')
        await shot(page, '07-settings')
        await settings.getByTestId('settings-save').click()
        await settings.getByTestId('settings-saved').waitFor()
        const config = JSON.parse(readFileSync(join(root, '.nexgent', 'config.json'), 'utf8'))
        expect(config).toMatchObject({ model: 'claude-opus-5-5', thinking: 'off', costCaps: { perTask: { maxTokens: 100000 }, perProject: { maxRequests: 300 } } })
        expect(await page.content()).not.toContain(KEY)
        await page.keyboard.press('Escape')

        // D08 (part 1): hard-kill the main process while a turn streams
        await input.click()
        await page.keyboard.type('把重复订单的处理也写清楚')
        await page.keyboard.press('Enter')
        await expect.poll(() => page.getByTestId('assistant-message').last().textContent(), { timeout: 20_000 }).toContain('重复订单的处理')
        expect(consoleErrors).toEqual([])
      } finally {
        app.process().kill('SIGKILL')
        await new Promise(resolve => app.process().once('exit', resolve).once('error', resolve))
      }

      // ---- restart ------------------------------------------------------------
      ;({ app, page, consoleErrors } = await launch(home))
      try {
        // the last project reopens by itself with its conversation, materials and deliverables
        await page.getByTestId('workspace').waitFor()
        await expect.poll(() => page.getByTestId('session-item').count()).toBe(1)
        await expect.poll(() => page.getByTestId('turn-end').last().textContent(), { timeout: 20_000 }).toBe('上次运行被中断（应用曾意外退出）')
        expect(await page.getByTestId('material-item').count()).toBe(2)
        expect(await page.getByTestId('deliverable-card').count()).toBe(2)
        expect(await page.getByTestId('tab-deliverables').textContent()).toContain('1')
        await shot(page, '08-after-restart')

        // replayed deliverable cards come right after their present blocks
        const order = await page.evaluate(() =>
          [...document.querySelectorAll('[data-testid="tool-block"], [data-testid="deliverable-card"]')].map((el: any) =>
            el.dataset.testid === 'deliverable-card' ? 'card' : String(el.textContent).includes('present') ? 'present' : 'tool',
          ),
        )
        expect(order).toEqual(['tool', 'tool', 'present', 'card', 'tool', 'present', 'card'])
        expect(await page.getByTestId('pick-files').count()).toBe(1)
        expect(await page.getByTestId('attach-files').count()).toBe(1)

        // the 文件 tab lists the project folder (not .nexgent) and marks this conversation's changes
        await page.getByTestId('tab-files').click()
        await expect.poll(() => page.getByTestId('file-item').count()).toBe(2)
        const files = await page.getByTestId('file-item').allTextContents()
        expect(files[0]).toContain('.env')
        expect(files[1]).toContain('report/summary.csv')
        expect(files[1]).toContain('修改')
        await page.getByTestId('tab-materials').click()

        // rename the conversation; the title survives in the session file
        await page.getByTestId('rename-session').click()
        await page.getByTestId('rename-input').fill('订单汇总')
        await page.keyboard.press('Enter')
        await expect.poll(() => page.getByTestId('session-item').textContent()).toContain('订单汇总')
        expect(sessionRecords(root).filter(r => r['type'] === 'session.title').map(r => r['title'])).toEqual(['订单汇总'])

        await page.getByTestId('composer-input').click()
        await page.keyboard.type('继续')
        await page.keyboard.press('Enter')
        await expect.poll(() => page.getByTestId('assistant-message').last().textContent(), { timeout: 20_000 }).toContain('重复订单按订单号只保留一条。')
        await page.getByTestId('send').waitFor({ timeout: 20_000 })
        expect(sessionRecords(root).filter(r => r['type'] === 'turn.end').map(r => r['reason']['kind'])).toEqual(['completed', 'completed', 'cancelled', 'interrupted', 'completed'])
        server.assertConsumed()
        expect(consoleErrors).toEqual([])
      } finally {
        await app.close()
      }
    },
    240_000,
  )
})
