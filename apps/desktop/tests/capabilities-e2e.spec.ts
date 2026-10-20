/**
 * Desktop capability versions E2E (step 4, W4): Playwright drives the built
 * Electron app with the real renderer and the real `@nexgent/sdk` against the
 * scripted Claude Messages API server — no real model. A project with an
 * adopted function-module bundle, a rejected skill candidate and a plugin
 * candidate that waited for approval (old data; the approval dialog was
 * removed on 2026-10-20, nothing asks and the candidate stays not adopted);
 * the version and candidate data stay in the project, while the 能力 page no longer shows
 * the version panel, candidates, rollback button or offline parts (updated
 * 2026-10-19 when those entries left the UI); the model calls the module's
 * `cap_*` tool, which runs in the PTC process on Electron's own Node; at
 * 1024 px nothing overflows; a manual rollback (through the SDK call
 * `capabilities.rollback`, no button) returns to the baseline and survives a
 * restart (D18).
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CapabilityStore, writeCandidate, type BundleComponentInput } from '@nexgent/capabilities'
import { dataPath, homeOf, useHome } from './data-layout.js'
import type { CandidateRecord, ToolResultRecord, TrialVerdict } from '@nexgent/kernel'
import { listSessionIds, readSessionRecords, scriptedModelServer, type ScriptedModelServer } from '@nexgent/test-support'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { build } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fillProjectPath } from './fixtures/ui.js'

// Code passed to `page.evaluate` runs in the page; the tests' type program has no DOM lib.
declare const window: any
declare const document: any

const APP_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)))
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
    NEXGENT_API_KEY: 'sk-desktop-capabilities-e2e',
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

const ZERO = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
const COST = { usage: ZERO, requestCount: 0, estimatedUsd: 0 }

const ORDER_TOOLS: BundleComponentInput = {
  kind: 'function-module',
  name: 'order-tools',
  files: [
    {
      path: 'functions.json',
      content: JSON.stringify({ formatVersion: 1, name: 'order-tools', description: 'Order helpers.', functions: [{ name: 'total', description: 'Sum amounts.', inputSchema: { type: 'object' }, effects: [] }] }),
    },
    { path: 'index.mjs', content: 'export function total(input) { return { total: input.rows.reduce((a, r) => a + r.amount, 0) } }\n' },
  ],
}
const SUMMARY_SKILL: BundleComponentInput = {
  kind: 'skill',
  name: 'east-summary',
  files: [{ path: 'SKILL.md', content: '---\nname: east-summary\ndescription: Summarize the east region.\n---\n\n1. Read the CSV.\n' }],
}
const GREETER: BundleComponentInput = {
  kind: 'plugin',
  name: 'greeter',
  files: [
    { path: 'plugin.json', content: JSON.stringify({ formatVersion: 1, name: 'greeter', description: 'Greets.', permissions: 'Runs inside the app with its full rights.', tools: ['greet'] }) },
    { path: 'index.mjs', content: 'export function apply() { throw new Error(\'a denied plugin never runs\') }\n' },
  ],
}

/** A candidate on top of the adopted bundle, as `capability_propose` writes it. */
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

/** The gate's receipts and its conclusion (rejected / awaiting approval), as the gate writes them. */
async function gate(dir: string, store: CapabilityStore, candidate: CandidateRecord, verdict: TrialVerdict, detail: string): Promise<void> {
  const trialId = randomUUID()
  const ts = new Date().toISOString()
  const ref = (caseId: string) => ({ caseId, sessionId: randomUUID(), tree: 'a'.repeat(64), checks: [] })
  const lines = [
    { type: 'trial.start', format: 1, trialId, ts, candidateId: candidate.id, candidateVersion: candidate.version, baselineVersion: candidate.base, plan: { selection: [ref('s1'), ref('s2')], guard: [ref('g1')], repeats: 2, costRatioCap: 1.2, reviewer: { model: 'claude-sonnet-5-5', thinking: 'on' }, budget: { maxTokens: 100000 } } },
    { type: 'trial.end', format: 1, trialId, ts, status: verdict.outcome === 'reject' ? 'fail' : 'pass', verdict, cost: { candidate: COST, baseline: COST, review: COST } },
  ]
  mkdirSync(join(dir, 'trials'), { recursive: true })
  appendFileSync(join(dir, 'trials', `${trialId}.jsonl`), lines.map(line => `${JSON.stringify(line)}\n`).join(''))
  const current = (await store.activation()).version
  await store.recordDecision({
    outcome: verdict.outcome === 'reject' ? 'rejected' : 'awaiting-approval',
    reason: verdict.reason,
    trigger: 'gate',
    candidateId: candidate.id,
    trialId,
    fromVersion: current,
    toVersion: current,
    verdict,
    cost: { candidate: COST, baseline: COST, review: COST },
    detail,
  })
}

const verdict = (outcome: TrialVerdict['outcome'], reason: TrialVerdict['reason'], candidate: number): TrialVerdict => ({ outcome, reason, passRate: { candidate, baseline: 0.5 }, costRatio: 1, decidedByReview: false })

/** The project's capabilities: `order-tools` adopted by the gate, a rejected skill candidate, a plugin candidate awaiting approval. */
async function seedCapabilities(root: string): Promise<{ bundle: string; plugin: CandidateRecord; skill: CandidateRecord }> {
  const dir = dataPath(root, 'capabilities')
  const store = new CapabilityStore(dir)
  const bundle = await store.write([ORDER_TOOLS])
  if ((await store.adopt(bundle.version, { trigger: 'gate', reason: 'quality-up', detail: 'Passed its gate.' })) === null) throw new Error('adopt raced')
  const skill = await propose(dir, store, SUMMARY_SKILL, '东区汇总')
  await gate(dir, store, skill, verdict('reject', 'quality-down', 0.25), 'The candidate passed fewer checks than the baseline.')
  const plugin = await propose(dir, store, GREETER, '问候插件')
  await gate(dir, store, plugin, verdict('adopt', 'quality-up', 1), 'Passed its gate; a plugin needs the user.')
  return { bundle: bundle.version, plugin, skill }
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
    for (const el of document.querySelectorAll('[data-testid="capability-candidate"], [data-testid="capability-current"]')) {
      if (el.scrollWidth > el.clientWidth + 1) out.push(`${el.dataset.testid} ${el.scrollWidth}>${el.clientWidth}`)
    }
    const right = document.querySelector('[data-testid="main"]').getBoundingClientRect()
    if (right.right > window.innerWidth + 1) out.push(`main area ends at ${right.right}`)
    return out
  })
}

/** The old 能力-page parts (versions, candidates, rollback, revisions, offline jobs) are not shown (2026-10-19). */
async function expectOldEntriesGone(page: Page): Promise<void> {
  for (const testId of ['tab-capabilities', 'tab-improvements', 'tab-offline', 'capability-current', 'candidate-status', 'capability-rollback']) expect(await page.getByTestId(testId).count(), testId).toBe(0)
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

describe('desktop capability versions over the real SDK (scripted model)', () => {
  it(
    'no approval dialog → data kept, old 能力-page entries gone (2026-10-19) → cap_* tool in Electron → 1024 px → rollback via the SDK → restart',
    async () => {
      const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'nexgent-capabilities-e2e-')))
      const home = join(base, 'home')
      const root = useHome(join(base, 'orders'), home)
      mkdirSync(home)
      server = await scriptedModelServer({
        script: [
          { toolCalls: [{ name: 'cap_order-tools_total', arguments: { rows: [{ amount: 1200 }, { amount: 30.5 }] } }], usage },
          { content: '合计 1230.5。', usage },
        ],
      })

      // ---- first run -------------------------------------------------------
      let { app, page, consoleErrors } = await launch(home)
      let seeded: Awaited<ReturnType<typeof seedCapabilities>>
      try {
        await page.getByTestId('start-screen').waitFor()
        await fillProjectPath(page, root)
        await page.getByTestId('create-project').click()
        await page.getByTestId('workspace').waitFor()
        seeded = await seedCapabilities(root)

        await page.getByTestId('new-session').click()

        // 2026-10-19: the capability version panel and the candidate list left the UI; the data is still in the project.
        const store = new CapabilityStore(dataPath(root, 'capabilities'))
        expect((await store.activation()).version).toBe(seeded.bundle)
        expect(await store.history()).toHaveLength(1)
        await page.getByTestId('nav-capabilities').click()
        await page.getByTestId('capabilities-page').waitFor()
        await expectOldEntriesGone(page)

        // the plugin candidate is not adopted: the active version is unchanged and its code never ran
        expect((await store.activation()).version).toBe(seeded.bundle)

        // the module's cap_* tool runs in Electron (PTC on Electron's Node)
        await page.getByTestId('page-back').click()
        const input = page.getByTestId('composer-input')
        await input.click()
        await page.keyboard.type('算一下订单合计')
        await page.keyboard.press('Enter')
        await expect.poll(() => page.getByTestId('assistant-message').last().textContent(), { timeout: 30_000 }).toContain('合计 1230.5。')
        await page.getByTestId('send').waitFor({ timeout: 20_000 })
        const [sessionId] = await listSessionIds(root, { home: homeOf(root) })
        const { records } = await readSessionRecords(root, sessionId!, { home: homeOf(root) })
        const start = records.find(record => record.type === 'session.start') as { capabilityVersion?: string } | undefined
        expect(start?.capabilityVersion).toBe(seeded.bundle)
        const result = records.find((record): record is ToolResultRecord => record.type === 'tool.result' && record.name === 'cap_order-tools_total')
        expect(result?.isError, result?.content).toBe(false)
        expect(result?.content).toContain('1230.5')

        // 1024 px with the 能力 page open
        await page.getByTestId('nav-capabilities').click()
        await page.getByTestId('capabilities-page').waitFor()
        expect(await overflowAt1024(app, page)).toEqual([])
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1280, 820))
        await expectOldEntriesGone(page)

        // D18: the manual rollback has no button now; the SDK call the app exposes still returns to the baseline
        const project = await page.evaluate((path: string) => window.nexgent.invoke('projects.open', { root: path }), root)
        const rolled = await page.evaluate((projectId: string) => window.nexgent.invoke('capabilities.rollback', { projectId, reason: '合计口径要改' }), project.projectId)
        expect(rolled.version).toBe('baseline')
        expect(rolled.revision).toBe(2)
        const history = await store.history()
        expect(history.map(revision => [revision.type, revision.trigger, revision.version])).toEqual([['adopt', 'gate', seeded.bundle], ['rollback', 'manual', 'baseline']])
        expect(consoleErrors).toEqual([])
      } finally {
        await app.close()
      }

      // ---- restart ------------------------------------------------------------
      ;({ app, page, consoleErrors } = await launch(home))
      try {
        await page.getByTestId('workspace').waitFor()
        const store = new CapabilityStore(dataPath(root, 'capabilities'))
        const activation = await store.activation()
        expect([activation.version, activation.revision]).toEqual(['baseline', 2])
        expect((await store.history()).map(revision => [revision.type, revision.trigger, revision.version])).toEqual([['adopt', 'gate', seeded.bundle], ['rollback', 'manual', 'baseline']])
        const project = await page.evaluate((path: string) => window.nexgent.invoke('projects.open', { root: path }), root)
        const view = await page.evaluate((projectId: string) => window.nexgent.invoke('capabilities.current', { projectId }), project.projectId)
        expect([view.version, view.revision]).toEqual(['baseline', 2])
        await page.getByTestId('nav-capabilities').click()
        await page.getByTestId('capabilities-page').waitFor()
        await expectOldEntriesGone(page)
        server.assertConsumed()
        expect(consoleErrors).toEqual([])
      } finally {
        await app.close()
      }
    },
    240_000,
  )
})
