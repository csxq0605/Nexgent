/**
 * Desktop approval dialog E2E (step 5, ADR 0007): Playwright drives the built
 * Electron app with the real renderer and the real `@nexgent/sdk` (scripted
 * model server, never called). A skill candidate whose gate found it better
 * but 2.5× the baseline's estimated dollars waits for the user: the dialog
 * shows the ratio, both arms in dollars and the quality comparison, and no
 * plugin wording; allow adopts it. A plugin candidate above the cost limit
 * then shows both the cost part and the plugin part; deny leaves it not
 * adopted. Set `NEXGENT_UI_SCREENSHOTS=<dir>` to save screenshots.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CapabilityStore, writeCandidate, type BundleComponentInput } from '@nexgent/capabilities'
import type { CandidateRecord, TrialCost, TrialVerdict } from '@nexgent/kernel'
import { scriptedModelServer, type ScriptedModelServer } from '@nexgent/test-support'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { build } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

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
    NEXGENT_API_KEY: 'sk-desktop-approval-e2e',
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
  await page.screenshot({ path: join(SHOTS, `${name}.png`) })
}

const SKILL: BundleComponentInput = {
  kind: 'skill',
  name: 'region-table',
  files: [{ path: 'SKILL.md', content: '---\nname: region-table\ndescription: Region tables carry the average unit price.\n---\n\n1. Add the average unit price column.\n' }],
}
const GREETER: BundleComponentInput = {
  kind: 'plugin',
  name: 'greeter',
  files: [
    { path: 'plugin.json', content: JSON.stringify({ formatVersion: 1, name: 'greeter', description: 'Greets.', permissions: 'Runs inside the app with its full rights.', tools: ['greet'] }) },
    { path: 'index.mjs', content: 'export function apply() { throw new Error(\'a denied plugin never runs\') }\n' },
  ],
}

async function propose(dir: string, store: CapabilityStore, component: BundleComponentInput, summary: string): Promise<CandidateRecord> {
  const base = await store.load((await store.activation()).version)
  const { record } = await writeCandidate(dir, {
    sessionId: randomUUID(),
    taskId: randomUUID(),
    turn: 1,
    base,
    components: [{ kind: component.kind, name: component.name, files: new Map(component.files.map(file => [file.path, Buffer.from(file.content as string)])) }],
    proofs: [{ kind: component.kind, name: component.name, turn: 1, toolCallId: 'call-1' }],
    summary,
  })
  return record
}

const arm = (usd: number, tokens: number): TrialCost => ({
  usage: { inputTokens: tokens - 1000, outputTokens: 1000, totalTokens: tokens, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
  requestCount: 4,
  estimatedUsd: usd,
})

/** The gate's receipts and its "better but 2.5× the cost" conclusion, as the gate writes them (ADR 0007). */
async function costlyGate(dir: string, store: CapabilityStore, candidate: CandidateRecord): Promise<void> {
  const trialId = randomUUID()
  const ts = new Date().toISOString()
  const cost = { candidate: arm(0.25, 30_000), baseline: arm(0.1, 20_000), review: arm(0.01, 2_000) }
  const verdict: TrialVerdict = { outcome: 'await-approval', reason: 'quality-up', passRate: { candidate: 1, baseline: 0.5 }, feedbackPassRate: { candidate: 1, baseline: 0 }, costRatio: 2.5, costBasis: 'usd', decidedByReview: false }
  const ref = (caseId: string) => ({ caseId, sessionId: randomUUID(), tree: 'a'.repeat(64), checks: [] })
  const lines = [
    { type: 'trial.start', format: 1, trialId, ts, candidateId: candidate.id, candidateVersion: candidate.version, baselineVersion: candidate.base, plan: { selection: [ref('s1')], guard: [ref('g1')], repeats: 2, costRatioCap: 1.2, costApprovalRatio: 2, reviewer: { model: 'claude-sonnet-5-5', thinking: 'on' }, budget: { maxTokens: 100000 } } },
    { type: 'trial.end', format: 1, trialId, ts, status: 'pass', verdict, cost },
  ]
  mkdirSync(join(dir, 'trials'), { recursive: true })
  appendFileSync(join(dir, 'trials', `${trialId}.jsonl`), lines.map(line => `${JSON.stringify(line)}\n`).join(''))
  const current = (await store.activation()).version
  await store.recordDecision({
    outcome: 'awaiting-approval',
    reason: 'quality-up',
    trigger: 'gate',
    candidateId: candidate.id,
    trialId,
    fromVersion: current,
    toVersion: current,
    verdict,
    cost,
    detail: 'Cost candidate/baseline (estimated USD, cache included): 2.5× (about 0.25 vs 0.10 USD); above 2×, waits for approval.',
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

describe('desktop approval dialog over the real SDK (scripted model)', () => {
  it(
    'cost above the limit: ratio, dollars and quality, no plugin wording; allow adopts → plugin above the limit: both parts; deny',
    async () => {
      const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'nexgent-approval-e2e-')))
      const home = join(base, 'home')
      const root = join(base, 'orders')
      mkdirSync(home)
      server = await scriptedModelServer({ script: [] })
      const dir = join(root, '.nexgent', 'capabilities')
      const { app, page, consoleErrors } = await launch(home)
      try {
        await page.getByTestId('start-screen').waitFor()
        await page.getByTestId('project-path').fill(root)
        await page.getByTestId('create-project').click()
        await page.getByTestId('workspace').waitFor()
        const store = new CapabilityStore(dir)

        // a skill candidate, better but 2.5× the cost
        const skill = await propose(dir, store, SKILL, '地区表带均价')
        await costlyGate(dir, store, skill)
        await page.getByTestId('new-session').click()
        let dialog = page.getByTestId('plugin-approval-dialog')
        await dialog.waitFor({ timeout: 20_000 })
        expect(await dialog.textContent()).toContain('候选需要你的批准')
        expect(await dialog.getByTestId('approval-cost-ratio').textContent()).toBe('费用约为基线的 2.5 倍（超过 2 倍不自动采用）')
        expect(await dialog.getByTestId('approval-cost-amounts').textContent()).toBe('估算费用（含缓存）：候选约 $0.25，基线约 $0.10')
        expect(await dialog.getByTestId('approval-quality').textContent()).toBe('检查通过率：候选 100%，基线 50%')
        expect(await dialog.getByTestId('approval-feedback').textContent()).toBe('其中反馈检查（单独记）：候选 100%，基线 0%')
        expect(await dialog.getByTestId('approval-plugins').count()).toBe(0)
        expect(await dialog.textContent()).not.toContain('插件')
        expect(await dialog.getByTestId('plugin-approval-hash').textContent()).toBe(skill.version)
        await shot(page, 'step5-w4-approval-cost')
        await dialog.getByTestId('plugin-allow').click()
        await dialog.waitFor({ state: 'detached' })
        await page.getByTestId('tab-capabilities').click()
        await expect.poll(() => page.getByTestId('capability-current').getAttribute('data-version')).toBe(skill.version)
        expect((await store.activation()).version).toBe(skill.version)

        // a plugin candidate on top of it, also 2.5× the cost
        const plugin = await propose(dir, store, GREETER, '问候插件')
        await costlyGate(dir, store, plugin)
        await page.getByTestId('new-session').click()
        dialog = page.getByTestId('plugin-approval-dialog')
        await dialog.waitFor({ timeout: 20_000 })
        expect(await dialog.getByTestId('approval-cost-ratio').textContent()).toContain('2.5 倍')
        expect(await dialog.getByTestId('approval-plugins').textContent()).toContain('拥有应用的全部权限')
        expect(await dialog.getByTestId('plugin-approval-names').textContent()).toBe('greeter')
        expect(await dialog.getByTestId('plugin-approval-permissions').textContent()).toContain('Runs inside the app with its full rights.')
        expect(await dialog.getByTestId('plugin-approval-tools').textContent()).toContain('greet')
        expect(await dialog.getByTestId('plugin-approval-hash').count()).toBe(1)
        await shot(page, 'step5-w4-approval-plugin-cost')
        await dialog.getByTestId('plugin-deny').click()
        await dialog.waitFor({ state: 'detached' })
        const denied = page.locator(`[data-testid="capability-candidate"][data-candidate="${plugin.id}"]`)
        await expect.poll(() => denied.getAttribute('data-status')).toBe('rejected')
        expect((await store.activation()).version).toBe(skill.version)
        expect(consoleErrors).toEqual([])
      } finally {
        await app.close()
      }
    },
    120_000,
  )
})
