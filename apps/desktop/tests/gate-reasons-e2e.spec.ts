/**
 * Desktop gate conclusions of ADR 0013 E2E (step 6 rework, R5): Playwright
 * drives the built Electron app with the real renderer and the real
 * `@nexgent/sdk` (scripted model server, never called). Three improvement
 * jobs of one project, their candidates and decisions seeded as the gate
 * writes them: one rejected before any replay for carrying values of its
 * feedback task (the values are shown), one rejected because the similar
 * cases got worse (both pass rates shown), and one waiting because it was
 * verified on the original case only (the approval dialog and the job
 * detail say so). At 1024 px nothing overflows; after a restart the same
 * conclusions show. Set `NEXGENT_UI_SCREENSHOTS=<dir>` to save screenshots.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CapabilityStore, writeCandidate, type BundleComponentInput } from '@nexgent/capabilities'
import { createJob, improvementsDir, transitionJob, updateJob } from '@nexgent/evolve'
import { dataPath, layoutOf, useHome } from './data-layout.js'
import { type CandidateRecord, type DecisionReason, type InstanceLiteralHit, type TrialCost, type TrialVerdict } from '@nexgent/kernel'
import { scriptedModelServer, type ScriptedModelServer } from '@nexgent/test-support'
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
    NEXGENT_API_KEY: 'sk-desktop-gate-reasons-e2e',
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


const skill = (name: string, text: string): BundleComponentInput => ({
  kind: 'skill',
  name,
  files: [{ path: 'SKILL.md', content: `---\nname: ${name}\ndescription: ${text}\n---\n\n1. ${text}\n` }],
})

const arm = (usd: number, tokens: number): TrialCost => ({
  usage: { inputTokens: tokens - 1000, outputTokens: 1000, totalTokens: tokens, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
  requestCount: 4,
  estimatedUsd: usd,
})

const LITERALS: InstanceLiteralHit[] = [
  { value: '2384.13', kind: 'decimal', path: 'skill/region-table/SKILL.md', source: 'feedback:0b7a6c1e' },
  { value: '2026-09', kind: 'date', path: 'skill/region-table/SKILL.md', source: 'deliverable:4f2d/v2/regions.csv' },
]

interface Seeded { readonly jobId: string; readonly candidate: CandidateRecord }

/** An improvement job of `root` whose candidate the gate decided as given (receipts too when `verdict` is). */
async function seedJob(root: string, store: CapabilityStore, component: BundleComponentInput, summary: string, decision: {
  readonly outcome: 'rejected' | 'awaiting-approval'
  readonly reason: DecisionReason
  readonly verdict?: TrialVerdict
  readonly instanceLiterals?: readonly InstanceLiteralHit[]
  readonly detail: string
}): Promise<Seeded> {
  const layout = layoutOf(root)
  const jobs = improvementsDir(layout)
  const dir = dataPath(root, 'capabilities')
  const job = await createJob(jobs, { trigger: 'explicit', items: [] })
  await transitionJob(jobs, job.id, 'diagnosing', { expect: ['queued'] })
  await transitionJob(jobs, job.id, 'proposing', { expect: ['diagnosing'] })
  const base = await store.load((await store.activation()).version)
  const { record } = await writeCandidate(dir, {
    sessionId: randomUUID(),
    taskId: randomUUID(),
    turn: 1,
    base,
    components: [{ kind: component.kind, name: component.name, files: new Map(component.files.map(file => [file.path, Buffer.from(file.content as string)])) }],
    proofs: [{ kind: component.kind, name: component.name, turn: 1, toolCallId: 'call-1' }],
    summary,
    origin: 'improvement',
    jobId: job.id,
  })
  await transitionJob(jobs, job.id, 'trialing', { expect: ['proposing'] })
  let trialId: string | undefined
  const cost = { candidate: arm(0.12, 20_000), baseline: arm(0.1, 18_000), review: arm(0.01, 2_000) }
  if (decision.verdict !== undefined) {
    trialId = randomUUID()
    const ts = new Date().toISOString()
    const ref = (caseId: string) => ({ caseId, sessionId: randomUUID(), tree: 'a'.repeat(64), checks: [] })
    const lines = [
      { type: 'trial.start', format: 1, trialId, ts, candidateId: record.id, candidateVersion: record.version, baselineVersion: record.base, plan: { selection: [ref('s1'), ref('s2')], guard: [ref('g1')], repeats: 2, costRatioCap: 1.2, costApprovalRatio: 2, reviewer: { model: 'claude-sonnet-5-5', thinking: 'on' }, budget: { maxTokens: 100000 } } },
      { type: 'trial.end', format: 1, trialId, ts, status: decision.outcome === 'rejected' ? 'fail' : 'pass', verdict: decision.verdict, cost },
    ]
    mkdirSync(join(dir, 'trials'), { recursive: true })
    appendFileSync(join(dir, 'trials', `${trialId}.jsonl`), lines.map(line => `${JSON.stringify(line)}\n`).join(''))
  }
  const current = (await store.activation()).version
  const written = await store.recordDecision({
    outcome: decision.outcome,
    reason: decision.reason,
    trigger: 'gate',
    candidateId: record.id,
    ...(trialId === undefined ? {} : { trialId, verdict: decision.verdict!, cost }),
    fromVersion: current,
    toVersion: current,
    ...(decision.instanceLiterals === undefined ? {} : { instanceLiterals: decision.instanceLiterals }),
    detail: decision.detail,
  })
  await updateJob(jobs, job.id, { improverVersion: 'v0', improverScope: 'user', candidateId: record.id, decisionId: written.id, ...(trialId === undefined ? {} : { trialId }) } as never)
  await transitionJob(jobs, job.id, decision.outcome, { expect: ['trialing'], detail: decision.detail })
  return { jobId: job.id, candidate: record }
}

/** Elements of the three columns and the detail wider than their box at 1024 px. */
async function overflowAt1024(app: ElectronApplication, page: Page): Promise<string[]> {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1024, 720))
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1024)
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
    for (const el of document.querySelectorAll('[data-testid="improvement-job"], [data-testid="improvement-detail"], [data-testid="improvement-literals"], [data-testid="improvement-literal"], [data-testid="improvement-similar-rate"]')) {
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

describe('desktop ADR 0013 gate conclusions over the real SDK (scripted model)', () => {
  it(
    'rejected before replay with the values → similar cases worse with both rates → verified on the original case only (dialog, detail) → 1024 px → restart',
    async () => {
      const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'nexgent-gate-reasons-e2e-')))
      const home = join(base, 'home')
      const root = useHome(join(base, 'orders'), home)
      mkdirSync(home)
      server = await scriptedModelServer({ script: [] })
      let jobs: { literal: Seeded; similar: Seeded; original: Seeded }
      let { app, page, consoleErrors } = await launch(home)
      try {
        await page.getByTestId('start-screen').waitFor()
        await fillProjectPath(page, root)
        await page.getByTestId('create-project').click()
        await page.getByTestId('workspace').waitFor()
        const store = new CapabilityStore(dataPath(root, 'capabilities'))
        const literal = await seedJob(root, store, skill('region-table', 'Region tables show the average order value 2384.13 for 2026-09.'), '地区表带均价', {
          outcome: 'rejected',
          reason: 'instance-literal',
          instanceLiterals: LITERALS,
          detail: 'The candidate carries values of its feedback task (2384.13, 2026-09); rejected before any replay.',
        })
        const similar = await seedJob(root, store, skill('sort-rows', 'Sort every table by its first column.'), '表格按首列排序', {
          outcome: 'rejected',
          reason: 'similar-regression',
          verdict: { outcome: 'reject', reason: 'similar-regression', passRate: { candidate: 0.75, baseline: 0.5 }, feedbackPassRate: { candidate: 1, baseline: 0 }, similarPassRate: { candidate: 0.5, baseline: 1 }, costRatio: 1.2, costBasis: 'usd', decidedByReview: false },
          detail: 'Similar cases (1) passed: candidate 50%, baseline 100%; rejected.',
        })
        const original = await seedJob(root, store, skill('units-note', 'State the unit of every numeric column in its header.'), '列名带单位', {
          outcome: 'awaiting-approval',
          reason: 'no-similar-cases',
          verdict: { outcome: 'await-approval', reason: 'no-similar-cases', passRate: { candidate: 1, baseline: 0.5 }, feedbackPassRate: { candidate: 1, baseline: 0 }, costRatio: 1.2, costBasis: 'usd', decidedByReview: false },
          detail: 'Checked on the feedback task only; waits for approval.',
        })
        jobs = { literal, similar, original }

        // Verified on the original case only: the approval dialog says so.
        await page.getByTestId('new-session').click()
        const dialog = page.getByTestId('plugin-approval-dialog')
        await dialog.waitFor({ timeout: 20_000 })
        expect(await dialog.textContent()).toContain('候选需要你的批准')
        expect(await dialog.getByTestId('approval-original-only').textContent()).toContain('只在原题上验证过')
        expect(await dialog.getByTestId('plugin-approval-hash').textContent()).toBe(original.candidate.version)
        await shot(page, 'step6-r5-approval-original-only')
        await page.keyboard.press('Escape')
        await dialog.waitFor({ state: 'detached' })
        await showTab(page, 'improvements')
        await expect.poll(() => page.getByTestId('improvement-job').count(), { timeout: 20_000 }).toBe(3)

        // Rejected before replay: the values found.
        const card = (id: string) => page.locator(`[data-testid="improvement-job"][data-job="${id}"]`)
        await card(literal.jobId).getByTestId('improvement-trigger').click()
        let detail = page.getByTestId('improvement-detail')
        await detail.waitFor()
        await expect.poll(() => detail.getByTestId('improvement-refused').count()).toBe(1)
        expect(await detail.getByTestId('improvement-refused').textContent()).toContain('回放前已拒绝')
        expect(await detail.getByTestId('improvement-literal').count()).toBe(2)
        const values = await detail.getByTestId('improvement-literals').textContent()
        expect(values).toContain('2384.13')
        expect(values).toContain('2026-09')
        expect(values).toContain('skill/region-table/SKILL.md')
        await detail.getByTestId('improvement-refused').evaluate((el: any) => el.scrollIntoView({ block: 'start' }))
        await shot(page, 'step6-r5-refused-literals')
        expect(await overflowAt1024(app, page)).toEqual([])
        await shot(page, 'step6-r5-refused-1024')
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1280, 820))

        // Similar cases got worse: both pass rates.
        await card(similar.jobId).getByTestId('improvement-trigger').click()
        detail = page.getByTestId('improvement-detail')
        await expect.poll(() => detail.getByTestId('improvement-similar-rate').count()).toBe(1)
        const rate = await detail.getByTestId('improvement-similar-rate').textContent()
        expect(rate).toContain('50%')
        expect(rate).toContain('100%')
        expect(await detail.textContent()).toContain('同类题变差')
        await detail.getByTestId('improvement-similar-rate').evaluate((el: any) => el.scrollIntoView({ block: 'center' }))
        await shot(page, 'step6-r5-similar-regression')

        // Verified on the original case only, in the job detail.
        await card(original.jobId).getByTestId('improvement-trigger').click()
        detail = page.getByTestId('improvement-detail')
        await expect.poll(async () => detail.textContent()).toContain('只在原题上验证过')
        await shot(page, 'step6-r5-original-only-detail')
        expect(await overflowAt1024(app, page)).toEqual([])
        expect(consoleErrors).toEqual([])
      } finally {
        await app.close()
      }

      // ---- restart ------------------------------------------------------------
      ;({ app, page, consoleErrors } = await launch(home))
      try {
        await page.getByTestId('workspace').waitFor()
        // The candidate still waits: the dialog comes back; close it for now.
        const dialog = page.getByTestId('plugin-approval-dialog')
        await dialog.waitFor({ timeout: 20_000 })
        await page.keyboard.press('Escape')
        await dialog.waitFor({ state: 'detached' })
        await showTab(page, 'improvements')
        await expect.poll(() => page.getByTestId('improvement-job').count(), { timeout: 20_000 }).toBe(3)
        await page.locator(`[data-testid="improvement-job"][data-job="${jobs.literal.jobId}"]`).getByTestId('improvement-trigger').click()
        await expect.poll(() => page.getByTestId('improvement-literal').count()).toBe(2)
        expect(consoleErrors).toEqual([])
      } finally {
        await app.close()
      }
    },
    180_000,
  )
})
