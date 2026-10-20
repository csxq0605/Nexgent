/**
 * Desktop gate conclusions of ADR 0013 E2E (step 6 rework, R5): Playwright
 * drives the built Electron app with the real renderer and the real
 * `@nexgent/sdk` (scripted model server, never called). Three candidates
 * of one project and their decisions seeded as the gate
 * writes them: one rejected before any replay for carrying values of its
 * feedback task, one rejected because the similar cases got worse, and one
 * waiting because it was verified on the original case only (old data: the
 * approval dialog was removed on 2026-10-20, nothing asks any more). Updated 2026-10-19 when the job list and job details left
 * the 能力 page: the first two conclusions are checked in the decision
 * files (values found, both pass rates), and the 能力 page shows none of
 * the old entries. At 1024 px nothing overflows; after a restart the same
 * conclusions hold. Set `NEXGENT_UI_SCREENSHOTS=<dir>` to save screenshots.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CapabilityStore, listDecisions, writeCandidate, type BundleComponentInput } from '@nexgent/capabilities'
import { dataPath, useHome } from './data-layout.js'
import { type CandidateRecord, type DecisionReason, type InstanceLiteralHit, type TrialCost, type TrialVerdict } from '@nexgent/kernel'
import { scriptedModelServer, type ScriptedModelServer } from '@nexgent/test-support'
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

interface Seeded { readonly candidate: CandidateRecord }

/** A candidate of `root` (of the retired improvement flow) that the gate decided as given (receipts too when `verdict` is). */
async function seedJob(root: string, store: CapabilityStore, component: BundleComponentInput, summary: string, decision: {
  readonly outcome: 'rejected' | 'awaiting-approval'
  readonly reason: DecisionReason
  readonly verdict?: TrialVerdict
  readonly instanceLiterals?: readonly InstanceLiteralHit[]
  readonly detail: string
}): Promise<Seeded> {
  const dir = dataPath(root, 'capabilities')
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
    jobId: randomUUID(),
  })
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
  await store.recordDecision({
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
  return { candidate: record }
}

/** Elements of the three columns and the detail wider than their box at 1024 px. */
async function overflowAt1024(app: ElectronApplication, page: Page): Promise<string[]> {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1024, 720))
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1024)
  return page.evaluate(() => {
    const out: string[] = []
    if (document.documentElement.scrollWidth > window.innerWidth) out.push(`document ${document.documentElement.scrollWidth}`)
    const middle = ['member-view', 'conversation', 'capabilities-page', 'settings-page'].find(id => document.querySelector(`[data-testid="${id}"]`) !== null) ?? 'conversation'
    for (const id of ['sidebar', middle, 'main']) {
      const el = document.querySelector(`[data-testid="${id}"]`)
      if (el === null) out.push(`${id} missing`)
      else if (el.scrollWidth > el.clientWidth + 1) out.push(`${id} ${el.scrollWidth}>${el.clientWidth}`)
    }
    const right = document.querySelector('[data-testid="main"]').getBoundingClientRect()
    if (right.right > window.innerWidth + 1) out.push(`main area ends at ${right.right}`)
    return out
  })
}

const OLD_ENTRIES = ['tab-capabilities', 'tab-improvements', 'tab-offline', 'improvement-job', 'improvement-detail', 'improvement-literals', 'improvement-similar-rate', 'capability-candidate', 'candidate-status', 'capabilities-decide']

/** The 能力 page no longer shows jobs, candidates, versions or gate details. */
async function expectOldEntriesGone(page: Page): Promise<void> {
  await page.getByTestId('nav-capabilities').click()
  await page.getByTestId('capabilities-page').waitFor()
  for (const testId of OLD_ENTRIES) expect(await page.getByTestId(testId).count(), testId).toBe(0)
}

/** The gate's three conclusions as they stay in the project's decision files (what the job details used to show). */
async function expectConclusions(store: CapabilityStore, jobs: { literal: Seeded; similar: Seeded; original: Seeded }): Promise<void> {
  const decisions = await listDecisions(store.decisionsDirectory)
  const latest = (candidateId: string) => decisions.filter(decision => decision.candidateId === candidateId).at(-1)!

  // Rejected before replay: the values found, no trial.
  const literal = latest(jobs.literal.candidate.id)
  expect(literal).toMatchObject({ outcome: 'rejected', reason: 'instance-literal' })
  expect(literal.trialId).toBeUndefined()
  expect(literal.instanceLiterals).toHaveLength(2)
  expect(literal.instanceLiterals!.map(hit => hit.value).sort()).toEqual(['2026-09', '2384.13'])
  expect(literal.instanceLiterals!.every(hit => hit.path === 'skill/region-table/SKILL.md')).toBe(true)
  expect(literal.detail).toContain('rejected before any replay')

  // Similar cases got worse: both pass rates.
  const similar = latest(jobs.similar.candidate.id)
  expect(similar).toMatchObject({ outcome: 'rejected', reason: 'similar-regression' })
  expect(similar.verdict).toMatchObject({ outcome: 'reject', reason: 'similar-regression', similarPassRate: { candidate: 0.5, baseline: 1 } })

  // Verified on the original case only: old data that waited for approval.
  const original = latest(jobs.original.candidate.id)
  expect(original).toMatchObject({ outcome: 'awaiting-approval', reason: 'no-similar-cases' })
  expect(original.verdict).toMatchObject({ outcome: 'await-approval', reason: 'no-similar-cases' })
  expect(original.verdict!.similarPassRate).toBeUndefined()
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
    'rejected-before-replay, similar-worse and original-only conclusions in the background data, no job UI (2026-10-19) → 1024 px → restart',
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

        await page.getByTestId('new-session').click()
        expect(await overflowAt1024(app, page)).toEqual([])
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1280, 820))

        // The gate's conclusions are in the background data; the 能力 page shows no jobs, candidates or details.
        await expectConclusions(store, jobs)
        await expectOldEntriesGone(page)
        await shot(page, 'step6-r5-hidden')
        expect(await overflowAt1024(app, page)).toEqual([])
        expect(consoleErrors).toEqual([])
      } finally {
        await app.close()
      }

      // ---- restart ------------------------------------------------------------
      ;({ app, page, consoleErrors } = await launch(home))
      try {
        await page.getByTestId('workspace').waitFor()
        await expectConclusions(new CapabilityStore(dataPath(root, 'capabilities')), jobs)
        await expectOldEntriesGone(page)
        expect(consoleErrors).toEqual([])
      } finally {
        await app.close()
      }
    },
    180_000,
  )
})
