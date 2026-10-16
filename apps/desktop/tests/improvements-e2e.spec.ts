/**
 * Desktop improvement jobs E2E (step 5, W4): Playwright drives the built
 * Electron app with the real renderer and the real `@nexgent/sdk` (which
 * installs `@nexgent/evolve`) against the scripted Claude Messages API
 * server — no real model. A project with one finished job (diagnosis,
 * candidate, gate decision, first use): the 改进 tab lists it with its cost
 * and shows the chain; "立即改进" starts a real job process (the SDK's improve
 * entry) whose diagnose session reports "not a capability problem", and the
 * tab follows it to 不是能力问题; at 1024 px nothing overflows; the settings
 * page turns automatic improvement off and sets the budget without any
 * approval; everything is still there after a restart.
 * Set `NEXGENT_UI_SCREENSHOTS=<dir>` to save screenshots.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CapabilityStore, writeCandidate } from '@nexgent/capabilities'
import { createJob, improvementsDir, transitionJob, updateJob } from '@nexgent/evolve'
import { resolveWorkspaceLayout } from '@nexgent/kernel'
import { listSessionIds, readSessionRecords, scriptedModelServer, type ScriptedModelServer } from '@nexgent/test-support'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { build } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { showTab, fillProjectPath } from './fixtures/ui.js'

// Code passed to `page.evaluate` runs in the page; the tests' type program has no DOM lib.
declare const window: any
declare const document: any

const APP_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)))
const TIMEOUT = 60_000
const ROOT = typeof process.getuid === 'function' && process.getuid() === 0
const SHOTS = process.env['NEXGENT_UI_SCREENSHOTS']
const usage = { inputTokens: 40, outputTokens: 8, totalTokens: 48, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
const big = { inputTokens: 120_000, outputTokens: 6_000, totalTokens: 126_000, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS === undefined || SHOTS === '') return
  mkdirSync(SHOTS, { recursive: true })
  await page.screenshot({ path: join(SHOTS, `${name}.png`) })
}

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
    NEXGENT_API_KEY: 'sk-desktop-improvements-e2e',
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

/** A finished job as the flow leaves it: diagnosis, a skill candidate adopted by the gate, first use. */
async function seedAdoptedJob(root: string, sessionId: string): Promise<string> {
  const layout = resolveWorkspaceLayout(root)
  const dir = improvementsDir(layout)
  const store = new CapabilityStore(layout.capabilities)
  const base = await store.load((await store.activation()).version)
  const skill = '---\nname: region-table-convention\ndescription: Region tables carry the average order value.\n---\n\nAdd avg_order_value = revenue / orders.\n'
  const { record } = await writeCandidate(layout.capabilities, {
    sessionId: randomUUID(), taskId: randomUUID(), turn: 1, base,
    components: [{ kind: 'skill', name: 'region-table-convention', files: new Map([['SKILL.md', Buffer.from(skill)]]) }],
    proofs: [{ kind: 'skill', name: 'region-table-convention', turn: 1, toolCallId: 'call-1' }],
    summary: '地区表总带每单均价一列',
    origin: 'improvement',
  } as never)
  const feedback = [1, 2, 3].map(n => ({ kind: 'feedback' as const, feedbackId: randomUUID(), sessionId, deliverableId: randomUUID(), rating: 2 as const, at: new Date(Date.now() - n * 60_000).toISOString() }))
  const job = await createJob(dir, { trigger: 'feedback-count', items: feedback })
  await transitionJob(dir, job.id, 'diagnosing', { expect: ['queued'] })
  await transitionJob(dir, job.id, 'proposing', { expect: ['diagnosing'] })
  await transitionJob(dir, job.id, 'trialing', { expect: ['proposing'] })
  const decided = await store.adopt(record.version, { trigger: 'gate', reason: 'quality-up', detail: 'The candidate passed the feedback check on both runs; the baseline did not.', candidateId: record.id })
  await transitionJob(dir, job.id, 'adopted', { expect: ['trialing'], detail: 'The candidate passed the feedback check on both runs; the baseline did not.' })
  const at = new Date().toISOString()
  await updateJob(dir, job.id, {
    candidateId: record.id,
    ...(decided === null ? {} : { decisionId: decided.decision.id }),
    diagnosed: { at, proposalKind: 'skill', attempts: 1 },
    phases: { diagnose: { usage: big, requestCount: 3 }, propose: { usage: big, requestCount: 6 }, trial: { usage: big, requestCount: 8 } },
    firstUse: { taskId: randomUUID(), sessionId, at, version: record.version },
  } as never)
  writeFileSync(join(dir, job.id, 'diagnosis.json'), JSON.stringify({
    formatVersion: 1, jobId: job.id, createdAt: at, attempts: 1,
    failureTypes: [{ category: 'task-verification', label: '交付前没有按用户约定核对列', evidence: [{ sessionId, seq: 1 }] }],
    involved: { members: ['root'], tools: ['write_file'], skills: [], components: [] },
    memberCosts: [],
    hypothesis: '项目里没有记录“地区表要带每单均价”这一约定，所以每月都会漏掉这一列。',
    proposalKind: 'skill',
  }))
  return job.id
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
    for (const el of document.querySelectorAll('[data-testid="improvement-job"], [data-testid="improvement-detail"]')) {
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

describe('desktop improvement jobs over the real SDK (scripted model)', () => {
  it(
    '改进 tab: a finished job and its chain → 立即改进 runs a real job process → 1024 px → settings without approval → restart',
    async () => {
      const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'nexgent-improvements-e2e-')))
      const home = join(base, 'home')
      const root = join(base, 'orders')
      mkdirSync(home)
      let evidence: { sessionId: string; seq: number } | undefined
      server = await scriptedModelServer({
        script: [
          { content: '地区表已写好。', usage },
          // The job process's diagnose session: not a capability problem.
          () => ({ toolCalls: [{ name: 'improve_report_diagnosis', arguments: {
            failureTypes: [{ category: 'system-design', label: 'requirement changed after delivery', evidence: [evidence!] }],
            involved: { members: ['root'], tools: [], skills: [], components: [] },
            hypothesis: 'The user changed what they want; no capability was missing.',
            proposalKind: 'none',
          } }], usage }),
          { content: 'Diagnosis reported.', usage },
        ],
      })

      // ---- first run -------------------------------------------------------
      let { app, page, consoleErrors } = await launch(home)
      let seeded = ''
      try {
        await page.getByTestId('start-screen').waitFor()
        await fillProjectPath(page, root)
        await page.getByTestId('create-project').click()
        await page.getByTestId('workspace').waitFor()
        await page.getByTestId('new-session').click()
        await page.getByTestId('composer-input').click()
        await page.keyboard.type('写四月的地区表')
        await page.keyboard.press('Enter')
        await expect.poll(() => page.getByTestId('assistant-message').last().textContent(), { timeout: 20_000 }).toContain('地区表已写好。')
        await page.getByTestId('send').waitFor({ timeout: 20_000 })
        const [sessionId] = await listSessionIds(root)
        const user = (await readSessionRecords(root, sessionId!)).records.find(record => record.type === 'user.message')!
        evidence = { sessionId: sessionId!, seq: user.seq }
        seeded = await seedAdoptedJob(root, sessionId!)

        // The tab picks the job up (job events) with its cost; the chain opens with it.
        await showTab(page, 'improvements')
        const job = page.locator(`[data-testid="improvement-job"][data-job="${seeded}"]`)
        await job.waitFor({ timeout: 20_000 })
        expect(await job.getAttribute('data-status')).toBe('adopted')
        expect(await job.getByTestId('improvement-status').textContent()).toBe('已采用')
        expect(await job.getByTestId('improvement-cost').textContent()).toMatch(/≈ \$\d+\.\d\d|费用未知/)
        expect(await page.getByTestId('improvement-pending').textContent()).toContain('3')
        await job.getByTestId('improvement-trigger').click()
        const detail = page.getByTestId('improvement-detail')
        await detail.waitFor()
        expect(await detail.getByTestId('improvement-diagnosis').textContent()).toContain('每单均价')
        expect(await detail.getByTestId('improvement-candidate').textContent()).toContain('region-table-convention')
        expect(await detail.getByTestId('improvement-first-use').count()).toBe(1)
        await shot(page, 'step5-w4-improvements-detail')

        // 立即改进: the SDK's improve entry runs a real job process; its diagnosis says "not a capability problem".
        await page.getByTestId('improvement-run').click()
        const started = page.locator('[data-testid="improvement-job"]').first()
        await expect.poll(() => started.getAttribute('data-job')).not.toBe(seeded)
        await expect.poll(() => started.getAttribute('data-status'), { timeout: 30_000 }).toBe('no-proposal')
        expect(await started.getByTestId('improvement-status').textContent()).toBe('不是能力问题')
        server.assertConsumed()
        await shot(page, 'step5-w4-improvements-list')

        // 1024 px with the 改进 tab open
        expect(await overflowAt1024(app, page)).toEqual([])
        await shot(page, 'step5-w4-improvements-1024')
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1280, 820))

        // Settings: automatic improvement off, budget 1M tokens over 14 days; no approval asked.
        await page.getByTestId('open-settings').click()
        const settings = page.getByTestId('settings-page')
        await settings.getByTestId('settings-auto-improve').uncheck()
        await settings.getByTestId('settings-improvement-budget').fill('1000000')
        await settings.getByTestId('settings-improvement-window').fill('14')
        await shot(page, 'step5-w4-settings')
        await settings.getByTestId('settings-save').click()
        await settings.getByTestId('settings-saved').waitFor()
        expect(await page.getByTestId('approval-dialog').count()).toBe(0)
        const config = JSON.parse(readFileSync(join(root, '.nexgent', 'config.json'), 'utf8'))
        expect(config).toMatchObject({ autoImprove: false, improvement: { budget: { maxTokens: 1_000_000, windowDays: 14 } } })
        await page.keyboard.press('Escape')
        expect(consoleErrors).toEqual([])
      } finally {
        await app.close()
      }

      // ---- restart ------------------------------------------------------------
      ;({ app, page, consoleErrors } = await launch(home))
      try {
        await page.getByTestId('workspace').waitFor()
        await showTab(page, 'improvements')
        await expect.poll(() => page.getByTestId('improvement-job').count(), { timeout: 20_000 }).toBe(2)
        expect(await page.locator(`[data-testid="improvement-job"][data-job="${seeded}"]`).getAttribute('data-status')).toBe('adopted')
        expect(await page.getByTestId('improvement-budget').textContent()).toContain('14')
        // The improvement sessions stay out of the conversation list.
        expect(await page.getByTestId('session-item').count()).toBe(1)
        await page.getByTestId('open-settings').click()
        expect(await page.getByTestId('settings-auto-improve').isChecked()).toBe(false)
        await page.keyboard.press('Escape')
        expect(consoleErrors).toEqual([])
      } finally {
        await app.close()
      }
    },
    240_000,
  )
})
