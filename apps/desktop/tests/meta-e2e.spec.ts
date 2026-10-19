/**
 * Desktop improver versions and meta jobs E2E (step 6, W5; rework R5, ADR
 * 0012; updated 2026-10-19 when the old improvement entries left the UI):
 * Playwright drives the built Electron app with the real renderer and the
 * real `@nexgent/sdk` against the scripted Claude Messages API server — no
 * real model, no model request. A meta job that adopted a child improver is
 * seeded: the improver and the job stay in the user's and the project's data,
 * the 能力 page shows no improver, meta job or rollback, the settings page no
 * meta improvement or improver sharing, at 1024 px nothing overflows, and
 * after a restart the improver line is unchanged.
 * Set `NEXGENT_UI_SCREENSHOTS=<dir>` to save screenshots.
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
    'an adopted child improver stays in the user\'s data: the 能力 page and settings no longer show improvers or meta settings (2026-10-19) → 1024 px → restart',
    async () => {
      const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'nexgent-meta-e2e-')))
      const home = join(base, 'home')
      const root = useHome(join(base, 'orders'), home)
      mkdirSync(home)
      server = await scriptedModelServer({ script: [] })
      const store = ImproverStore.user({ home })

      // ---- first run -------------------------------------------------------
      let { app, page, consoleErrors } = await launch(home)
      let seeded: Awaited<ReturnType<typeof seedAdoptedMetaJob>>
      try {
        await page.getByTestId('start-screen').waitFor()
        await fillProjectPath(page, root)
        await page.getByTestId('create-project').click()
        await page.getByTestId('workspace').waitFor()
        seeded = await seedAdoptedMetaJob(home, root)
        await seedFinishedJob(home, root, seeded.child)
        expect((await store.activation()).version).toBe(seeded.child)
        expect((await readJob(improvementsDir(layoutOf(root)), seeded.jobId))?.status).toBe('adopted')

        // The 能力 page shows no improver, meta job or rollback.
        await page.getByTestId('nav-capabilities').click()
        await page.getByTestId('capabilities-page').waitFor()
        for (const testId of ['tab-improvements', 'improver-current', 'improver-rollback', 'improvement-run-meta', 'improvement-job']) expect(await page.getByTestId(testId).count()).toBe(0)
        await shot(page, 'meta-hidden')
        expect(await overflowAt1024(app, page)).toEqual([])
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1280, 820))

        // Settings: no meta improvement or improver sharing; the user settings are left as they were.
        await page.getByTestId('open-settings').click()
        await page.getByTestId('settings-page').waitFor()
        for (const testId of ['settings-user-section', 'settings-meta-enabled', 'settings-meta-budget', 'settings-share-improver']) expect(await page.getByTestId(testId).count()).toBe(0)
        expect(readUserConfig(home)?.improvement?.meta).toBeUndefined()
        await page.keyboard.press('Escape')
        expect(consoleErrors).toEqual([])
      } finally {
        await app.close()
      }

      // ---- restart ------------------------------------------------------------
      ;({ app, page, consoleErrors } = await launch(home))
      try {
        await page.getByTestId('workspace').waitFor()
        expect((await store.activation()).version).toBe(seeded.child)
        expect((await store.chain()).revisions.map(revision => revision.type)).toEqual(['adopt'])
        expect(consoleErrors).toEqual([])
      } finally {
        await app.close()
      }
    },
    240_000,
  )
})
