/**
 * Desktop improver versions and meta jobs E2E (step 6, W5; rework R5, ADR
 * 0012: the improver and the meta settings are the user's): Playwright drives
 * the built Electron app with the real renderer and the real `@nexgent/sdk`
 * against the scripted Claude Messages API server — no real model. A project
 * whose meta job adopted a child improver: the 改进 tab shows the improver in
 * force, the meta job's marker and improver version, and its detail (meta
 * diagnosis, the change before / after, both arms, the verdict) (D24, D25);
 * at 1024 px nothing overflows; the improver is rolled back in the UI and the
 * next (meta) job, started with 立即元改进 as a real job process, runs on the
 * rolled-back version (D27); the rollback confirmation lists the projects
 * that ran on the improver (this one and another of the user's); the
 * settings page turns meta improvement on and sets its budget in the user
 * settings (`<home>/config.json`) without approval, turns this project's
 * 参与改进器学习 off in the project config, and everything stays after a
 * restart (D26). Set `NEXGENT_UI_SCREENSHOTS=<dir>` to save screenshots.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ImproverStore } from '@nexgent/capabilities'
import { countFinishedJobForUser, createJob, improvementsDir, jobPaths, readJob, transitionJob, updateJob } from '@nexgent/evolve'
import { layoutOf, useHome } from './data-layout.js'
import { applyImproverChange, IMPROVER_V0, type ComparisonArmResult, type ImproverChange, type ImproverChangeRecord, type ImproverComparison, type MetaDiagnosis } from '@nexgent/kernel'
import { scriptedModelServer, type ScriptedModelServer } from '@nexgent/test-support'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { build } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { commitSettings, showTab, fillProjectPath } from './fixtures/ui.js'

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
    NEXGENT_API_KEY: 'sk-desktop-meta-e2e',
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

const CHANGE: ImproverChange = { op: 'set-diagnosis-paragraph', index: 0, text: 'Before naming a failure, read every failed check of the task and quote its output; a diagnosis that ignores a failed check is wrong.' }

/** A finished capability job of `root` that ran on `version` of the user line (and is counted toward meta jobs). */
async function seedFinishedJob(home: string, root: string, version: string): Promise<string> {
  const layout = layoutOf(root)
  const dir = improvementsDir(layout)
  const job = await createJob(dir, { trigger: 'explicit', items: [] })
  await transitionJob(dir, job.id, 'diagnosing', { expect: ['queued'] })
  await updateJob(dir, job.id, { improverVersion: version, improverScope: 'user' } as never)
  const done = await transitionJob(dir, job.id, 'no-proposal', { expect: ['diagnosing'], detail: 'Nothing to change.' })
  await countFinishedJobForUser(home, layout, done!)
  return job.id
}

/** A meta job that adopted a child improver on the user line, as the flow leaves it (meta diagnosis, change, comparison, revision). */
async function seedAdoptedMetaJob(home: string, root: string): Promise<{ jobId: string; child: string }> {
  const layout = layoutOf(root)
  const dir = improvementsDir(layout)
  const store = ImproverStore.user({ home })
  const { version: child } = await store.write(applyImproverChange(IMPROVER_V0, CHANGE))
  const basis = [randomUUID(), randomUUID(), randomUUID()]
  const job = await createJob(dir, { trigger: 'job-count', items: [], kind: 'meta', meta: { parentVersion: 'v0', basis } })
  for (const [from, to] of [['queued', 'meta-diagnosing'], ['meta-diagnosing', 'meta-proposing'], ['meta-proposing', 'comparing']] as const) await transitionJob(dir, job.id, to, { expect: [from] })
  const at = new Date().toISOString()
  // As the meta job does it: the revision first, then the job's status.
  const commit = await store.adopt(child, { jobId: job.id })
  await transitionJob(dir, job.id, 'adopted', { expect: ['comparing'], detail: 'The child improver\'s offspring passed its gate; the parent\'s did not.' })
  await updateJob(dir, job.id, {
    improverVersion: 'v0',
    improverScope: 'user',
    meta: { parentVersion: 'v0', basis, childVersion: child, diagnosed: { at, attempts: 1, proposal: 'change' }, compared: { at, outcome: 'adopt', reason: 'gate-passed' }, ...(commit === null ? {} : { revision: commit.revision.revision }) },
    phases: { 'meta-diagnose': { usage: big, requestCount: 3 }, 'meta-propose': { usage: big, requestCount: 2 }, compare: { usage: big, requestCount: 14 } },
  } as never)
  const paths = jobPaths(dir, job.id)
  const metaDiagnosis: MetaDiagnosis = {
    formatVersion: 1, jobId: job.id, createdAt: at, sessionId: randomUUID(), attempts: 1, improverVersion: 'v0', basis, statusCounts: { adopted: 1, rejected: 2 },
    findings: [{ stage: 'diagnose', label: '诊断常漏读失败的检查', jobIds: basis.slice(0, 2) }, { stage: 'trial', label: '后代两次没通过门控', jobIds: basis.slice(1) }],
    hypothesis: '诊断策略没有要求先读失败的检查，所以诊断常把需求变化误判成能力缺口。',
    proposal: 'change',
  }
  const change: ImproverChangeRecord = { formatVersion: 1, jobId: job.id, createdAt: at, sessionId: randomUUID(), attempts: 1, parentVersion: 'v0', childVersion: child, change: CHANGE, rationale: '让诊断先读失败的检查。' }
  const origin = { kind: 'unresolved' as const, sourceJobId: basis[2]!, tree: 'a'.repeat(64), feedbackIds: [randomUUID()], capabilityVersion: 'baseline', epoch: 'e'.repeat(64) }
  const arm = (side: 'parent' | 'child'): ComparisonArmResult => side === 'parent'
    ? { arm: 'parent', improverVersion: 'v0', origin, jobId: randomUUID(), status: 'rejected', candidateId: randomUUID(), verdict: { outcome: 'reject', reason: 'quality-down', passRate: { candidate: 0.5, baseline: 0.75 }, costRatio: 1.1, costBasis: 'usd', decidedByReview: false }, cost: { usage: big, requestCount: 7, estimatedUsd: 0.52 } }
    : { arm: 'child', improverVersion: child, origin, jobId: randomUUID(), status: 'adopted', candidateId: randomUUID(), verdict: { outcome: 'adopt', reason: 'quality-up', passRate: { candidate: 1, baseline: 0.75 }, costRatio: 1.2, costBasis: 'usd', decidedByReview: false }, cost: { usage: big, requestCount: 7, estimatedUsd: 0.61 } }
  const comparison: ImproverComparison = { formatVersion: 1, jobId: job.id, createdAt: at, origin, parent: arm('parent'), child: arm('child'), verdict: { outcome: 'adopt', reason: 'gate-passed' } }
  writeFileSync(paths.metaDiagnosis, JSON.stringify(metaDiagnosis))
  writeFileSync(paths.change, JSON.stringify(change))
  writeFileSync(paths.comparison, JSON.stringify(comparison))
  return { jobId: job.id, child }
}

/** Elements of the three columns wider than their box at the current window size. */
function readUserConfig(home: string): any {
  try {
    return JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'))
  } catch {
    return undefined
  }
}

/** Elements of the three columns (or `only`) wider than their box at 1024 px. */
async function overflowAt1024(app: ElectronApplication, page: Page, only?: readonly string[]): Promise<string[]> {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1024, 720))
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1024)
  if (only !== undefined) {
    return page.evaluate((ids: readonly string[]) => {
      const out: string[] = []
      if (document.documentElement.scrollWidth > window.innerWidth) out.push(`document ${document.documentElement.scrollWidth}`)
      for (const id of ids) {
        const el = document.querySelector(`[data-testid="${id}"]`)
        if (el === null) out.push(`${id} missing`)
        else if (el.scrollWidth > el.clientWidth + 1) out.push(`${id} ${el.scrollWidth}>${el.clientWidth}`)
        else if (el.getBoundingClientRect().right > window.innerWidth + 1) out.push(`${id} ends at ${el.getBoundingClientRect().right}`)
      }
      return out
    }, only)
  }
  return page.evaluate(() => {
    const out: string[] = []
    if (document.documentElement.scrollWidth > window.innerWidth) out.push(`document ${document.documentElement.scrollWidth}`)
    const middle = ['member-view', 'conversation', 'capabilities-page', 'settings-page'].find(id => document.querySelector(`[data-testid="${id}"]`) !== null) ?? 'conversation'
    const onPage = middle.endsWith('-page')
    for (const id of ['sidebar', middle, 'main']) {
      const el = document.querySelector(`[data-testid="${id}"]`)
      if (el === null) out.push(`${id} missing`)
      else if (el.scrollWidth > el.clientWidth + 1) out.push(`${id} ${el.scrollWidth}>${el.clientWidth}`)
    }
    for (const el of document.querySelectorAll('[data-testid="improvement-job"], [data-testid="improvement-detail"], [data-testid="improver-section"], [data-testid="improvement-arm"], [data-testid="improvement-change"], [data-testid="improver-rollback-projects"]')) {
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

describe('desktop improver versions and meta jobs over the real SDK (scripted model)', () => {
  it(
    'meta job and improver in the 改进 tab → 1024 px → rollback in the UI → 立即元改进 runs on the rolled-back version → meta settings → restart',
    async () => {
      const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'nexgent-meta-e2e-')))
      const home = join(base, 'home')
      const root = useHome(join(base, 'orders'), home)
      const reports = useHome(join(base, 'reports'), home)
      mkdirSync(home)
      mkdirSync(reports)
      server = await scriptedModelServer({
        script: [
          // The meta job process's meta-diagnose session: no improver problem.
          { toolCalls: [{ name: 'improve_report_meta_diagnosis', arguments: { findings: [], hypothesis: 'No improver problem is visible yet.', proposal: 'none' } }], usage },
          { content: 'Reported.', usage },
        ],
      })
      const layout = () => layoutOf(root)

      // ---- first run -------------------------------------------------------
      let { app, page, consoleErrors } = await launch(home)
      let seeded: Awaited<ReturnType<typeof seedAdoptedMetaJob>>
      try {
        await page.getByTestId('start-screen').waitFor()
        await fillProjectPath(page, root)
        await page.getByTestId('create-project').click()
        await page.getByTestId('workspace').waitFor()
        seeded = await seedAdoptedMetaJob(home, root)
        // This project and another of the user's ran jobs on the child improver.
        await seedFinishedJob(home, root, seeded.child)
        await seedFinishedJob(home, reports, seeded.child)

        // D24: the improver in force and the meta job's marker and improver version.
        await page.getByTestId('new-session').click()
        await showTab(page, 'improvements')
        const current = page.getByTestId('improver-current')
        await expect.poll(() => current.getAttribute('data-version'), { timeout: 20_000 }).toBe(seeded.child)
        expect(await page.getByTestId('improver-version').textContent()).toContain(seeded.child.slice(0, 12))
        const job = page.locator(`[data-testid="improvement-job"][data-job="${seeded.jobId}"]`)
        await job.waitFor({ timeout: 20_000 })
        expect(await job.getAttribute('data-kind')).toBe('meta')
        expect(await job.getByTestId('improvement-meta-badge').count()).toBe(1)
        expect(await job.getByTestId('improvement-improver').getAttribute('data-version')).toBe('v0')
        expect(await job.getByTestId('improvement-improver').getAttribute('data-scope')).toBe('user')
        expect(await page.getByTestId('improver-shared-note').count()).toBe(1)
        expect(await job.getByTestId('improvement-cost').textContent()).toMatch(/≈ \$\d+\.\d\d|费用未知/)

        // D25: the meta job's detail.
        await job.getByTestId('improvement-trigger').click()
        const detail = page.getByTestId('improvement-detail')
        await detail.waitFor()
        expect(await detail.getByTestId('improvement-meta-diagnosis').textContent()).toContain('诊断常漏读失败的检查')
        await expect.poll(() => detail.getByTestId('improvement-change-before').textContent()).toContain(IMPROVER_V0.diagnosis.paragraphs[0]!.slice(0, 40))
        expect(await detail.getByTestId('improvement-change-after').textContent()).toContain('read every failed check')
        const arms = detail.getByTestId('improvement-arm')
        expect(await arms.count()).toBe(2)
        expect(await detail.locator('[data-testid="improvement-arm"][data-arm="child"]').textContent()).toContain('$0.61')
        expect(await detail.getByTestId('improvement-comparison-verdict').getAttribute('data-reason')).toBe('gate-passed')
        await detail.getByTestId('improvement-meta-diagnosis').evaluate((el: any) => el.scrollIntoView({ block: 'start' }))
        await shot(page, 'step6-r5-meta-detail')
        await detail.getByTestId('improvement-comparison').evaluate((el: any) => el.scrollIntoView({ block: 'start' }))
        await shot(page, 'step6-r5-meta-arms')

        // 1024 px with the 改进 tab and the meta detail open
        expect(await overflowAt1024(app, page)).toEqual([])
        await shot(page, 'step6-r5-meta-1024')
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1280, 820))

        // D27: roll back in the UI; the confirmation names the projects that ran on it; the next job runs on the rolled-back improver.
        await page.getByTestId('improver-rollback').click()
        const used = page.getByTestId('improver-rollback-project')
        await expect.poll(() => used.count()).toBe(2)
        const usedText = await page.getByTestId('improver-rollback-projects').textContent()
        expect(usedText).toContain('orders')
        expect(usedText).toContain('reports')
        await shot(page, 'step6-r5-improver-rollback-confirm')
        await page.getByTestId('improver-rollback-reason').fill('子改进器的诊断太慢')
        await page.getByTestId('improver-rollback-confirm').click()
        await expect.poll(() => current.getAttribute('data-version')).toBe('v0')
        const store = ImproverStore.user({ home })
        expect((await store.activation()).version).toBe('v0')
        expect((await store.chain()).revisions.map(revision => [revision.type, revision.trigger, revision.reason])).toEqual([['adopt', 'meta-job', undefined], ['rollback', 'manual', '子改进器的诊断太慢']])
        await expect.poll(() => page.getByTestId('improver-revision').count()).toBe(2)
        await shot(page, 'step6-r5-improver-rollback')
        await page.getByTestId('improvement-run-meta').click()
        const started = page.locator('[data-testid="improvement-job"][data-kind="meta"]').first()
        await expect.poll(() => started.getAttribute('data-job')).not.toBe(seeded.jobId)
        await expect.poll(() => started.getAttribute('data-status'), { timeout: 30_000 }).toBe('no-proposal')
        expect(await started.getAttribute('data-kind')).toBe('meta')
        const ran = await readJob(improvementsDir(layout()), (await started.getAttribute('data-job'))!)
        expect(ran).toMatchObject({ kind: 'meta', trigger: 'explicit', improverVersion: 'v0', improverScope: 'user', status: 'no-proposal' })
        expect(await started.getByTestId('improvement-improver').getAttribute('data-version')).toBe('v0')
        server.assertConsumed()
        await shot(page, 'step6-r5-meta-list')

        // D26: meta improvement on, its budget 2M tokens over 15 days (user settings); this project stops sharing; no approval asked.
        await page.getByTestId('open-settings').click()
        const settings = page.getByTestId('settings-page')
        await settings.getByTestId('settings-user-section').waitFor()
        await expect.poll(() => settings.getByTestId('settings-meta-budget').inputValue()).toBe('6000000')
        expect(await settings.getByTestId('settings-meta-enabled').isChecked()).toBe(false)
        expect(await settings.getByTestId('settings-share-improver').isChecked()).toBe(true)
        await settings.getByTestId('settings-meta-enabled').check()
        await settings.getByTestId('settings-meta-budget').fill('2000000')
        await settings.getByTestId('settings-meta-window').fill('15')
        await settings.getByTestId('settings-share-improver').uncheck()
        await settings.getByTestId('settings-meta-budget').scrollIntoViewIfNeeded()
        await shot(page, 'step6-r5-settings-meta')
        expect(await overflowAt1024(app, page, ['settings-page'])).toEqual([])
        await shot(page, 'step6-r5-settings-1024')
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1280, 820))
        await commitSettings(page, true)
        await commitSettings(page)
        expect(await page.getByTestId('approval-dialog').count()).toBe(0)
        await expect.poll(() => readUserConfig(home)?.improvement?.meta).toMatchObject({ enabled: true, budget: { maxTokens: 2_000_000, windowDays: 15 } })
        const config = JSON.parse(readFileSync(join(root, '.nexgent', 'config.json'), 'utf8'))
        expect(config.improvement?.shareImproverEvidence).toBe(false)
        expect(config.improvement?.meta).toBeUndefined()
        await page.keyboard.press('Escape')
        await showTab(page, 'improvements')
        await expect.poll(() => page.getByTestId('improvement-meta-status').textContent()).toMatch(/开/)
        expect(consoleErrors).toEqual([])
      } finally {
        await app.close()
      }

      // ---- restart ------------------------------------------------------------
      ;({ app, page, consoleErrors } = await launch(home))
      try {
        await page.getByTestId('workspace').waitFor()
        await showTab(page, 'improvements')
        await expect.poll(() => page.getByTestId('improvement-job').count(), { timeout: 20_000 }).toBe(3)
        expect(await page.getByTestId('improver-current').getAttribute('data-version')).toBe('v0')
        await expect.poll(() => page.getByTestId('improver-revision').count()).toBe(2)
        expect(await page.getByTestId('improvement-meta-budget').textContent()).toContain('15')
        await page.getByTestId('open-settings').click()
        expect(await page.getByTestId('settings-meta-enabled').isChecked()).toBe(true)
        await expect.poll(() => page.getByTestId('settings-meta-budget').inputValue()).toBe('2000000')
        expect(await page.getByTestId('settings-meta-window').inputValue()).toBe('15')
        expect(await page.getByTestId('settings-share-improver').isChecked()).toBe(false)
        await page.keyboard.press('Escape')
        expect(consoleErrors).toEqual([])
      } finally {
        await app.close()
      }
    },
    240_000,
  )
})
