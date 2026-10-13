/**
 * The step-6 desktop items D24–D27: Playwright drives the built Electron app
 * (real renderer, real `@nexgent/sdk` in the main process) against the scripted
 * Claude Messages API server — no real model, only the scripted key. Follows
 * step5-desktop.mjs; the improver-version and meta screens are W5's
 * (apps/desktop/tests/meta-e2e.spec.ts shows the same screens in one test).
 *
 * What is the product's own path and what is seeded:
 *
 *   real      every capability job (explicit jobs started through the SDK, and one started with
 *             "改进" on the deliverable card) and the meta jobs started with 立即元改进 and by the
 *             job-count rule: each runs in the SDK's improve entry as its own process, with its
 *             own sessions and ledger records; the improver rollback is clicked in the UI and
 *             written by the host; the settings are typed into the settings page and written
 *             to `.nexgent/config.json` by the host
 *   seeded    ONE adopted meta job (D25's detail needs a finished comparison): its job file,
 *             `meta-diagnosis.json`, `change.json` and `comparison.json` are written here in the
 *             shape the flow leaves them, the child improver is written and adopted through
 *             `ImproverStore` (as the meta job does it: revision first, then the job's status).
 *             The scripted evaluator would need two full arm projects to produce them for
 *             real (partition W7, headless H04–H16); this scenario is about the screens. The
 *             seeded ids are in `obs.seeded` so the judges say what was seeded.
 *
 *   prep      the step-5 feedback project (headless, autoImprove off); real explicit job J1
 *             (no-proposal, improver v0); seed the adopted meta job (child improver C in force);
 *             real explicit job J2 (no-proposal, pinned on C)
 *   launch 1  D24 cards and the improver section; D25 the seeded meta job's detail against its
 *             files; D27 rollback with a reason → revision 2, then the next jobs (J3 from the
 *             deliverable card, then 立即元改进) pin the rolled-back improver; D25 again for the
 *             real meta job (diagnosis only, ledger-priced); D26 meta switch on, K = 2, budget
 *             and window typed in and saved (no approval)
 *   launch 2  D26 the values survived; switched off with another budget
 *   launch 3  D26 the values survived again (switch off)
 *   after     D26 switch off, K = 2 finished jobs (J4, J5) are counted by the queue: no meta job
 *             starts; as a control the switch is turned on and one more finished job (J6)
 *             starts one on the job-count rule
 *
 * The scenario only observes; step6-desktop-judges.mjs decides. A step that throws is
 * recorded under `obs.errors.<item>` and stops what depends on it.
 */
import { mkdir, readFile, readdir, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { isLoopbackUrl } from './step2-runtime.mjs'
import { DESKTOP_DIR, VITE_BIN, ensureDisplay, poll, run } from './step2-desktop.mjs'
import { ledgerOf } from './step4-headless.mjs'
import { FEEDBACK_TASK, runFeedbackProject, SCRIPTED_API_KEY, TERMINAL_STATES } from './step5-fixtures.mjs'
import { Step5Model, USAGE } from './step5-model.mjs'
import { createStep5Sdk, improvementsPath, loadStep5Packages, readImprovements, scriptedEnvironment } from './step5-runtime.mjs'
import { loadCapabilities } from './step6-headless.mjs'

const TIMEOUT = 60_000
const WAIT = 45_000
const JOB_WAIT = 240_000
const ROOT_USER = typeof process.getuid === 'function' && process.getuid() === 0
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const errorText = error => (error instanceof Error ? (error.stack ?? error.message) : String(error))
const readJson = path => readFile(path, 'utf8').then(text => JSON.parse(text), () => undefined)
const SETTLED = new Set(TERMINAL_STATES)

/** Fake key the desktop app runs with. */
export const META_DESKTOP_KEY = 'sk-accept-step6-desktop'
/** What the scenario types into the settings page (everyJobs, budget tokens, window days). */
export const META_SETTINGS = {
  on: { enabled: true, every: 2, budget: 2_000_000, window: 15 },
  off: { enabled: false, every: 2, budget: 1_500_000, window: 20 },
}
/** The paragraph the seeded child improver rewrites. */
export const SEEDED_CHANGE = { op: 'set-diagnosis-paragraph', index: 0, text: 'Before naming a failure, read every failed check of the task and quote its output; a diagnosis that ignores a failed check is wrong.' }

/**
 * Step 5's scripted model plus the meta-diagnose session of a meta job: it reports
 * `proposal: none` (the improver is fine), so a real meta job ends `no-proposal`.
 */
class MetaStep6Model extends Step5Model {
  respond(body) {
    const tools = (body?.tools ?? []).map(tool => tool?.name)
    if (tools.includes('improve_report_meta_diagnosis')) {
      const reported = (body?.messages ?? []).some(message => message.role === 'assistant')
      this.requests.push({ phase: this.phase, kind: 'meta-diagnose', step: reported ? 1 : 0 })
      if (reported) return { content: 'Reported.', usage: USAGE }
      return { toolCalls: [{ name: 'improve_report_meta_diagnosis', arguments: { findings: [], hypothesis: 'No improver problem is visible in the recent jobs.', proposal: 'none' } }], usage: USAGE }
    }
    return super.respond(body)
  }
}

// ---- files -----------------------------------------------------------------------------

/** The improver revisions (`.nexgent/improvers/activation/<n>.json`) in order. */
async function revisionsOf(root) {
  const dir = join(root, '.nexgent', 'improvers', 'activation')
  const names = (await readdir(dir).catch(() => [])).filter(name => /^\d+\.json$/.test(name)).sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10))
  const out = []
  for (const name of names) {
    const revision = await readJson(join(dir, name))
    out.push(revision === undefined ? { file: name, error: 'unreadable' } : { file: name, revision: revision.revision, type: revision.type, version: revision.version, from: revision.from, trigger: revision.trigger, reason: revision.reason, jobId: revision.jobId, committedAt: revision.committedAt })
  }
  return out
}

/** The meta settings the host wrote. */
async function metaConfigOf(root) {
  const config = await readJson(join(root, '.nexgent', 'config.json'))
  const meta = config?.improvement?.meta
  return { enabled: meta?.enabled, every: meta?.everyJobs, budget: meta?.budget?.maxTokens, window: meta?.budget?.windowDays }
}

/** A job file as the judges compare it with the screen. */
function jobFile(job) {
  return {
    id: job.id,
    kind: job.kind === 'meta' ? 'meta' : 'capability',
    trigger: job.trigger,
    status: job.status,
    improverVersion: job.improverVersion,
    createdAt: job.createdAt,
    arm: job.arm !== undefined,
    meta: job.meta === undefined ? undefined : {
      parentVersion: job.meta.parentVersion,
      childVersion: job.meta.childVersion,
      basis: (job.meta.basis ?? []).length,
      outcome: job.meta.compared?.outcome,
      reason: job.meta.compared?.reason,
      revision: job.meta.revision,
    },
  }
}

/** The job files, the queue, the improver chain and the meta settings of a project right now. */
async function snapshot(pkgs, root) {
  const { queue, jobs } = await readImprovements(pkgs, root)
  return {
    jobs: jobs.map(jobFile),
    queue: { metaPending: [...(queue?.metaPending ?? [])], metaCounted: [...(queue?.metaCounted ?? [])], activeJobId: queue?.activeJobId },
    revisions: await revisionsOf(root),
    config: await metaConfigOf(root),
  }
}

/** Wait until job `jobId` has a final status. */
async function waitJob(pkgs, root, jobId, timeoutMs = JOB_WAIT) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const job = (await readImprovements(pkgs, root)).jobs.find(item => item.id === jobId)
    if (job !== undefined && SETTLED.has(job.status)) return job
    if (Date.now() > deadline) throw new Error(`job ${jobId} did not settle within ${timeoutMs / 1000}s (status ${job?.status ?? 'none'})`)
    await sleep(200)
  }
}

/** Wait until the queue counted job `jobId` (its process released the slot: the meta rule has run). */
async function waitCounted(pkgs, root, jobId, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const { queue } = await readImprovements(pkgs, root)
    if ((queue?.metaCounted ?? []).includes(jobId)) return
    if (Date.now() > deadline) throw new Error(`job ${jobId} was not counted by the queue within ${timeoutMs / 1000}s`)
    await sleep(200)
  }
}

/** Kill every job process still named in a job lock under `root` (cleanup). */
async function killJobProcesses(pkgs, root) {
  const dir = improvementsPath(root)
  for (const name of await readdir(dir).catch(() => [])) {
    const pid = await pkgs.evolve.readLockPid(join(dir, name, 'job.lock')).catch(() => undefined)
    if (typeof pid === 'number' && pid !== process.pid && pkgs.evolve.processAlive(pid)) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch { /* already gone */ }
    }
  }
}

/** The meta job's three files, its job file's improver facts and the revision naming it, as files say. */
async function metaFilesOf(pkgs, root, jobId) {
  const dir = improvementsPath(root)
  const paths = pkgs.evolve.jobPaths(dir, jobId)
  const diagnosis = await readJson(paths.metaDiagnosis)
  const change = await readJson(paths.change)
  const comparison = await readJson(paths.comparison)
  const job = (await readImprovements(pkgs, root)).jobs.find(item => item.id === jobId)
  const arm = a => a === undefined ? undefined : {
    arm: a.arm,
    improverVersion: a.improverVersion,
    candidateId: a.candidateId,
    status: a.status,
    verdictOutcome: a.verdict?.outcome,
    verdictReason: a.verdict?.reason,
    quality: a.verdict?.passRate?.candidate,
    usd: a.cost?.estimatedUsd,
    tokens: a.cost?.usage?.totalTokens,
  }
  const childBundle = change === undefined ? undefined : await readJson(join(root, '.nexgent', 'improvers', 'bundles', `${change.childVersion}.json`))
  const requests = (await ledgerOf(root)).filter(record => record.type === 'llm.request.end' && record.improvementId === jobId)
  return {
    job: job === undefined ? undefined : jobFile(job),
    diagnosis: diagnosis === undefined ? undefined : { hypothesis: diagnosis.hypothesis, proposal: diagnosis.proposal, findings: (diagnosis.findings ?? []).map(f => ({ stage: f.stage, label: f.label, jobs: (f.jobIds ?? []).length })) },
    change: change === undefined ? undefined : {
      op: change.change?.op,
      index: change.change?.index,
      text: change.change?.text,
      rationale: change.rationale,
      parentVersion: change.parentVersion,
      childVersion: change.childVersion,
      childParagraph: change.change?.index === undefined ? undefined : childBundle?.diagnosis?.paragraphs?.[change.change.index],
    },
    comparison: comparison === undefined ? undefined : { parent: arm(comparison.parent), child: arm(comparison.child), outcome: comparison.verdict?.outcome, reason: comparison.verdict?.reason },
    ledger: {
      requests: requests.length,
      phases: [...new Set(requests.map(record => record.improvementPhase))].sort(),
      tokens: requests.every(record => typeof record.usage?.totalTokens === 'number') ? requests.reduce((sum, record) => sum + record.usage.totalTokens, 0) : undefined,
    },
  }
}

// ---- seeding ---------------------------------------------------------------------------

/**
 * One adopted meta job as the flow leaves it: the child improver written and adopted (revision
 * first, then the job's status), the job's three files, and the arms' costs in `comparison.json`.
 */
async function seedAdoptedMetaJob(pkgs, capabilities, root) {
  const kernel = pkgs.kernel
  const evolve = pkgs.evolve
  const dir = improvementsPath(root)
  const store = new capabilities.ImproverStore(capabilities.improversDir({ dataDir: join(root, '.nexgent') }))
  const { version: child } = await store.write(kernel.applyImproverChange(kernel.IMPROVER_V0, SEEDED_CHANGE))
  const basis = [randomUUID(), randomUUID(), randomUUID()]
  const job = await evolve.createJob(dir, { trigger: 'job-count', items: [], kind: 'meta', meta: { parentVersion: 'v0', basis } })
  for (const [from, to] of [['queued', 'meta-diagnosing'], ['meta-diagnosing', 'meta-proposing'], ['meta-proposing', 'comparing']]) await evolve.transitionJob(dir, job.id, to, { expect: [from] })
  const at = new Date().toISOString()
  const commit = await store.adopt(child, { jobId: job.id })
  await evolve.transitionJob(dir, job.id, 'adopted', { expect: ['comparing'], detail: 'The child improver\'s offspring passed its gate; the parent\'s did not.' })
  const big = { inputTokens: 120_000, outputTokens: 6_000, totalTokens: 126_000, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
  await evolve.updateJob(dir, job.id, {
    improverVersion: 'v0',
    meta: { parentVersion: 'v0', basis, childVersion: child, diagnosed: { at, attempts: 1, proposal: 'change' }, compared: { at, outcome: 'adopt', reason: 'gate-passed' }, ...(commit === null ? {} : { revision: commit.revision.revision }) },
    phases: { 'meta-diagnose': { usage: big, requestCount: 3 }, 'meta-propose': { usage: big, requestCount: 2 }, compare: { usage: big, requestCount: 14 } },
  })
  const paths = evolve.jobPaths(dir, job.id)
  const { writeFile } = await import('node:fs/promises')
  const diagnosis = {
    formatVersion: 1, jobId: job.id, createdAt: at, sessionId: randomUUID(), attempts: 1, improverVersion: 'v0', basis, statusCounts: { adopted: 1, rejected: 2 },
    findings: [{ stage: 'diagnose', label: '诊断常漏读失败的检查', jobIds: basis.slice(0, 2) }, { stage: 'trial', label: '后代两次没通过门控', jobIds: basis.slice(1) }],
    hypothesis: '诊断策略没有要求先读失败的检查，所以诊断常把需求变化误判成能力缺口。',
    proposal: 'change',
  }
  const change = { formatVersion: 1, jobId: job.id, createdAt: at, sessionId: randomUUID(), attempts: 1, parentVersion: 'v0', childVersion: child, change: SEEDED_CHANGE, rationale: '让诊断先读失败的检查。' }
  const origin = { kind: 'unresolved', sourceJobId: basis[2], tree: 'a'.repeat(64), feedbackIds: [randomUUID()], capabilityVersion: 'baseline', epoch: 'e'.repeat(64) }
  const arm = side => side === 'parent'
    ? { arm: 'parent', improverVersion: 'v0', origin, jobId: randomUUID(), status: 'rejected', candidateId: randomUUID(), verdict: { outcome: 'reject', reason: 'quality-down', passRate: { candidate: 0.5, baseline: 0.75 }, costRatio: 1.1, costBasis: 'usd', decidedByReview: false }, cost: { usage: big, requestCount: 7, estimatedUsd: 0.52 } }
    : { arm: 'child', improverVersion: child, origin, jobId: randomUUID(), status: 'adopted', candidateId: randomUUID(), verdict: { outcome: 'adopt', reason: 'quality-up', passRate: { candidate: 1, baseline: 0.75 }, costRatio: 1.2, costBasis: 'usd', decidedByReview: false }, cost: { usage: big, requestCount: 7, estimatedUsd: 0.61 } }
  const comparison = { formatVersion: 1, jobId: job.id, createdAt: at, origin, parent: arm('parent'), child: arm('child'), verdict: { outcome: 'adopt', reason: 'gate-passed' } }
  await writeFile(paths.metaDiagnosis, JSON.stringify(diagnosis))
  await writeFile(paths.change, JSON.stringify(change))
  await writeFile(paths.comparison, JSON.stringify(comparison))
  return { jobId: job.id, child, revision: commit?.revision?.revision }
}

// ---- the screen ------------------------------------------------------------------------

/** Every job card of the 改进 tab as shown. */
const cardsOf = page => page.evaluate(() => {
  const text = (el, id) => el.querySelector(`[data-testid="${id}"]`)?.textContent ?? null
  return [...document.querySelectorAll('[data-testid="improvement-job"]')].map(el => ({
    id: el.dataset.job ?? null,
    kind: el.dataset.kind ?? null,
    status: el.dataset.status ?? null,
    badge: el.querySelector('[data-testid="improvement-meta-badge"]') !== null,
    badgeText: text(el, 'improvement-meta-badge'),
    improverVersion: el.querySelector('[data-testid="improvement-improver"]')?.dataset.version ?? null,
    improverText: text(el, 'improvement-improver'),
    cost: text(el, 'improvement-cost'),
    child: text(el, 'improvement-meta-child'),
  }))
})

/** The improver section as shown: the version in force, the revisions, the meta status line. */
const improverOf = page => page.evaluate(() => {
  const current = document.querySelector('[data-testid="improver-current"]')
  const text = id => document.querySelector(`[data-testid="${id}"]`)?.textContent ?? null
  return {
    present: document.querySelector('[data-testid="improver-section"]') !== null,
    version: current?.dataset.version ?? null,
    revision: current?.dataset.revision ?? null,
    versionText: text('improver-version'),
    problem: text('improver-problem'),
    revisions: [...document.querySelectorAll('[data-testid="improver-revision"]')].map(el => ({ type: el.dataset.type ?? null, version: el.dataset.version ?? null, text: el.textContent ?? '' })),
    metaStatus: text('improvement-meta-status'),
    metaBudget: text('improvement-meta-budget'),
    rollbackButton: document.querySelector('[data-testid="improver-rollback"]') !== null,
  }
})

/** A meta job's opened detail, or null when it is not open. */
const metaDetailOf = (page, id) => page.evaluate((jobId) => {
  const card = [...document.querySelectorAll('[data-testid="improvement-job"]')].find(el => el.dataset.job === jobId)
  const el = card?.querySelector('[data-testid="improvement-detail"]')
  if (el === null || el === undefined) return null
  const one = testId => el.querySelector(`[data-testid="${testId}"]`)
  const text = testId => one(testId)?.textContent ?? null
  const armOf = a => ({
    arm: a.dataset.arm ?? null,
    version: a.querySelector('[data-testid="improvement-arm-version"]')?.textContent ?? null,
    offspring: a.querySelector('[data-testid="improvement-arm-offspring"]')?.textContent ?? null,
    gate: a.querySelector('[data-testid="improvement-arm-gate"]')?.textContent ?? null,
    quality: a.querySelector('[data-testid="improvement-arm-quality"]')?.textContent ?? null,
    cost: a.querySelector('[data-testid="improvement-arm-cost"]')?.textContent ?? null,
  })
  const verdict = one('improvement-comparison-verdict')
  return {
    diagnosis: text('improvement-meta-diagnosis'),
    findings: [...el.querySelectorAll('[data-testid="improvement-meta-finding"]')].map(x => ({ stage: x.dataset.stage ?? null, text: x.textContent ?? '' })),
    change: one('improvement-change') === null ? null : {
      op: one('improvement-change').dataset.op ?? null,
      before: text('improvement-change-before'),
      after: text('improvement-change-after'),
      rationale: text('improvement-change-rationale'),
    },
    comparison: one('improvement-comparison') === null ? null : {
      arms: [...el.querySelectorAll('[data-testid="improvement-arm"]')].map(armOf),
      verdict: verdict === null ? null : { outcome: verdict.dataset.outcome ?? null, reason: verdict.dataset.reason ?? null, text: verdict.textContent ?? '' },
    },
    cost: text('improvement-meta-cost'),
    phases: [...el.querySelectorAll('[data-testid="improvement-phases"] li')].map(x => ({ phase: x.dataset.phase ?? null, text: x.textContent ?? '' })),
  }
}, id)

/** Make job `id`'s detail open (the card toggles), and read it once it has loaded. */
async function openMetaDetail(page, id) {
  const card = page.locator(`[data-testid="improvement-job"][data-job="${id}"]`)
  await card.waitFor({ timeout: WAIT })
  if ((await card.getByTestId('improvement-detail').count()) === 0) await card.getByTestId('improvement-trigger').click()
  return poll(() => metaDetailOf(page, id), d => d !== null && d.cost !== null && (d.change === null || !String(d.change.before).includes('未取得')), `the detail of meta job ${id}`, WAIT)
}

/** The settings page's values (opened, left open). */
async function readSettings(page) {
  await page.getByTestId('open-settings').click()
  const settings = page.getByTestId('settings-page')
  await settings.waitFor({ timeout: WAIT })
  await poll(() => settings.getByTestId('settings-meta-budget').inputValue(), v => v !== '', 'the meta budget field', WAIT)
  return {
    enabled: await settings.getByTestId('settings-meta-enabled').isChecked(),
    every: await settings.getByTestId('settings-meta-every').inputValue(),
    budget: await settings.getByTestId('settings-meta-budget').inputValue(),
    window: await settings.getByTestId('settings-meta-window').inputValue(),
  }
}

const closeSettings = async page => {
  await page.keyboard.press('Escape')
  await page.getByTestId('settings-page').waitFor({ state: 'detached', timeout: WAIT }).catch(() => undefined)
}

/** Change the meta settings, save, and return what the page says. */
async function saveSettings(page, { enabled, every, budget, window }) {
  const settings = page.getByTestId('settings-page')
  if (enabled) await settings.getByTestId('settings-meta-enabled').check()
  else await settings.getByTestId('settings-meta-enabled').uncheck()
  await settings.getByTestId('settings-meta-every').fill(String(every))
  await settings.getByTestId('settings-meta-budget').fill(String(budget))
  await settings.getByTestId('settings-meta-window').fill(String(window))
  await settings.getByTestId('settings-save').click()
  await settings.getByTestId('settings-saved').waitFor({ timeout: WAIT })
  return { approvalDialogs: await page.getByTestId('approval-dialog').count() }
}

/**
 * Run the step-6 desktop scenario.
 * @param harness - @nexgent/test-support (scriptedModelServer, listSessionIds, ...).
 * @param work - an empty work directory.
 * @param options - `log(line)`.
 * @returns plain observations: `seeded`, `prepared`, `d24`, `d25`, `d26`, `d27`, `consoleErrors`, `errors`.
 */
export async function runStep6DesktopScenario(harness, work, { log = () => {} } = {}) {
  const { _electron: electron } = await import('playwright-core')
  const loaded = await loadStep5Packages()
  if (!loaded.ok) throw new Error(loaded.reason)
  const pkgs = loaded.pkgs
  const capabilities = await loadCapabilities()
  await mkdir(work, { recursive: true })
  work = await realpath(work)
  const obs = {
    consoleErrors: { first: [], second: [], third: [] },
    prepared: {},
    seeded: undefined,
    d24: {},
    d25: {},
    d26: { typed: META_SETTINGS },
    d27: {},
    errors: {},
  }
  const rendererDir = join(work, 'renderer')
  const root = join(work, 'project')
  const home = join(work, 'home')
  createRequire(join(DESKTOP_DIR, 'package.json'))('electron')

  let server
  let display
  let app
  let model
  /** Run one item's section; a crash is recorded under `errors.<item>`. */
  const item = async (name, body) => {
    try {
      await body()
    } catch (error) {
      obs.errors[name] = errorText(error)
      log(`${name} stopped: ${errorText(error).split('\n')[0]}`)
    }
  }
  /** Run an explicit job through the SDK and wait for its end. */
  const explicitJob = async (sdk, projectId, name) => {
    log(`job ${name}`)
    const started = await sdk.call('improvements.run', { projectId, sessionId: obs.prepared.feedbackSession })
    const job = await waitJob(pkgs, root, started.id)
    obs.prepared[name] = { id: started.id, status: job.status, improverVersion: job.improverVersion }
    return job
  }

  try {
    // ---- setup and prep (a crash here stops everything) -----------------------------------
    log('building the renderer')
    const built = await run(process.execPath, [VITE_BIN, 'build', '--outDir', rendererDir, '--emptyOutDir', '--logLevel', 'error'], { cwd: DESKTOP_DIR })
    if (built.code !== 0) throw new Error(`vite build exited ${built.code}: ${built.stderr.slice(0, 400)}`)
    display = await ensureDisplay()
    model = new MetaStep6Model(harness, { root, playbooks: [], feedbackAnswer: 'by-output' })
    server = await harness.scriptedModelServer({ script: Array.from({ length: 5_000 }, () => model.entry) })
    if (!isLoopbackUrl(server.baseUrl)) throw new Error(`scripted server is not on loopback: ${server.baseUrl}`)
    const env = { NEXGENT_API_BASE_URL: server.baseUrl, NEXGENT_API_KEY: SCRIPTED_API_KEY, NEXGENT_HOME: home }

    const restore = scriptedEnvironment(SCRIPTED_API_KEY)
    try {
      log('preparing the feedback project (headless)')
      const project = await runFeedbackProject(harness, pkgs, work, {
        server,
        log: line => log(`prep: ${line}`),
        config: { autoImprove: false },
        createSdk: (e, h) => createStep5Sdk(pkgs, { env: e, home: h }),
      })
      obs.prepared.feedbackSession = project.tasks.at(-1)?.sessionId
      obs.prepared.deliverableId = project.deliverable?.deliverableId
      if (obs.prepared.feedbackSession === undefined || obs.prepared.deliverableId === undefined) throw new Error('the feedback project produced no deliverable')
      model.phase = 'job'
      const sdk = createStep5Sdk(pkgs, { env, home })
      try {
        const { projectId } = await sdk.call('projects.open', { root, create: true })
        await explicitJob(sdk, projectId, 'j1')
        log('prep: seeding the adopted meta job')
        obs.seeded = {
          ...(await seedAdoptedMetaJob(pkgs, capabilities, root)),
          what: 'meta job record (job.json, meta-diagnosis.json, change.json, comparison.json) and the child improver revision written by this scenario through ImproverStore; the rest (capability jobs, rollback, next jobs, settings) is the product\'s',
        }
        await explicitJob(sdk, projectId, 'j2')
      } finally {
        await sdk.dispose()
      }
    } finally {
      restore()
    }
    model.phase = 'main'
    obs.prepared.files = await snapshot(pkgs, root)

    // ---- launch helper ---------------------------------------------------------------------
    const launch = async (which) => {
      const appEnv = {}
      for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !key.startsWith('NEXGENT_') && key !== 'ANTHROPIC_API_KEY') appEnv[key] = value
      Object.assign(appEnv, display.display === undefined ? {} : { DISPLAY: display.display }, {
        NEXGENT_HOME: home,
        NEXGENT_DESKTOP_RENDERER_DIR: rendererDir,
        NEXGENT_API_KEY: META_DESKTOP_KEY,
        NEXGENT_API_BASE_URL: server.baseUrl,
      })
      app = await electron.launch({ args: ROOT_USER ? [DESKTOP_DIR, '--no-sandbox'] : [DESKTOP_DIR], env: appEnv, timeout: TIMEOUT })
      const page = await app.firstWindow({ timeout: TIMEOUT })
      page.on('console', (message) => {
        if (message.type() === 'error') obs.consoleErrors[which].push(message.text())
      })
      page.on('pageerror', error => obs.consoleErrors[which].push(error.message))
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 900))
      await page.waitForLoadState('load')
      await poll(async () => {
        if ((await page.getByTestId('workspace').count()) > 0) return 'workspace'
        return (await page.getByTestId('start-screen').count()) > 0 ? 'start' : 'loading'
      }, state => state !== 'loading', 'the workspace or the start screen', WAIT)
      await sleep(1_500)
      if ((await page.getByTestId('workspace').count()) === 0) {
        await page.getByTestId('project-path').fill(root, { timeout: 10_000 })
        await page.getByRole('button', { name: '打开', exact: true }).click()
        await page.getByTestId('workspace').waitFor({ timeout: WAIT })
      }
      return page
    }
    const closeApp = async () => {
      await app?.close().catch(() => undefined)
      app = undefined
    }
    /** Wait for the card of a job that is not in `known`, and for it to reach a final status on screen. */
    const newSettledCard = async (page, known, what) => {
      const found = await poll(async () => (await cardsOf(page)).find(c => !known.includes(c.id ?? '')) ?? null, c => c !== null, `the new job card (${what})`, WAIT)
      const final = await poll(async () => (await cardsOf(page)).find(c => c.id === found.id) ?? null, c => c !== null && SETTLED.has(c.status ?? ''), `the ${what} job to end on screen`, JOB_WAIT)
      await waitJob(pkgs, root, found.id)
      return final
    }

    // ---- launch 1 --------------------------------------------------------------------------
    log('launch 1: the 改进 tab')
    let page
    let seededId
    seededId = obs.seeded.jobId
    await item('d24', async () => {
      page = await launch('first')
      await page.getByTestId('tab-improvements').click()
      const ids = [obs.prepared.j1.id, obs.prepared.j2.id, seededId]
      await poll(() => cardsOf(page), cards => ids.every(id => cards.some(c => c.id === id)), 'the three job cards', WAIT)
      await poll(() => improverOf(page), v => v.present && v.version === obs.seeded.child, 'the improver section with the child in force', WAIT)
      obs.d24.initial = { cards: await cardsOf(page), improver: await improverOf(page), files: await snapshot(pkgs, root) }
    })
    if (page === undefined) throw new Error(`launch 1 failed: ${obs.errors.d24 ?? 'no page'}`)

    await item('d25', async () => {
      obs.d25.seeded = { jobId: seededId, child: obs.seeded.child, dom: await openMetaDetail(page, seededId), files: await metaFilesOf(pkgs, root, seededId) }
      obs.d25.seeded.parentParagraph = pkgs.kernel.IMPROVER_V0.diagnosis.paragraphs[SEEDED_CHANGE.index]
    })

    // D27: roll back in the UI, then the next jobs.
    await item('d27', async () => {
      const before = await snapshot(pkgs, root)
      const reason = '子改进器的诊断太慢（accept-step6 D27）'
      await page.getByTestId('improver-rollback').click()
      await page.getByTestId('improver-rollback-reason').fill(reason)
      await page.getByTestId('improver-rollback-confirm').click()
      await poll(() => improverOf(page), v => v.version === 'v0' && v.revision === '2', 'the improver rolled back on screen', WAIT)
      obs.d27 = { reason, before, rolledBackAt: new Date().toISOString(), afterImprover: await improverOf(page), after: await snapshot(pkgs, root), next: [] }
      // The next job: 改进 on the deliverable card (a capability job).
      model.phase = 'job'
      const known = (await cardsOf(page)).map(c => c.id)
      await page.getByTestId('session-item').filter({ hasText: FEEDBACK_TASK.id }).first().click()
      const button = page.getByTestId('deliverable-improve').last()
      await button.waitFor({ timeout: WAIT })
      await button.click()
      await page.getByTestId('tab-improvements').click()
      const card = await newSettledCard(page, known, 'capability')
      obs.d27.next.push({ via: 'deliverable-improve', id: card.id, card })
      // Then 立即元改进: a meta job on the rolled-back improver.
      const known2 = (await cardsOf(page)).map(c => c.id)
      const meta = page.getByTestId('improvement-run-meta')
      await poll(() => meta.isEnabled(), enabled => enabled === true, 'the 立即元改进 button to be enabled', WAIT)
      await meta.click()
      const metaCard = await newSettledCard(page, known2, 'meta')
      obs.d27.next.push({ via: 'improvement-run-meta', id: metaCard.id, card: metaCard })
      model.phase = 'main'
      obs.d27.final = { improver: await improverOf(page), files: await snapshot(pkgs, root), cards: await cardsOf(page) }
      obs.d24.later = { cards: obs.d27.final.cards, improver: obs.d27.final.improver, files: obs.d27.final.files }
    })

    // D25 for the real meta job (no change was proposed: the diagnosis, its cost from the ledger).
    await item('d25', async () => {
      const real = obs.d27.next?.find(n => n.via === 'improvement-run-meta')
      if (real === undefined) throw new Error('no real meta job was started (see d27)')
      obs.d25.real = { jobId: real.id, dom: await openMetaDetail(page, real.id), files: await metaFilesOf(pkgs, root, real.id) }
    })

    // D26: meta improvement on, K = 2, budget and window typed in; no approval asked.
    await item('d26', async () => {
      obs.d26.initial = await readSettings(page)
      obs.d26.configBefore = await metaConfigOf(root)
      obs.d26.saveOn = await saveSettings(page, META_SETTINGS.on)
      obs.d26.configOn = await metaConfigOf(root)
      await closeSettings(page)
      await page.getByTestId('tab-improvements').click()
      obs.d26.screenOn = await poll(() => improverOf(page), v => (v.metaStatus ?? '').includes('开') && (v.metaBudget ?? '').includes(META_SETTINGS.on.budget.toLocaleString('en-US')), 'the meta status line to read 开 with the new budget', WAIT)
      await closeApp()

      log('launch 2: settings after the restart')
      page = await launch('second')
      obs.d26.restartOn = await readSettings(page)
      obs.d26.configAfterRestartOn = await metaConfigOf(root)
      obs.d26.saveOff = await saveSettings(page, META_SETTINGS.off)
      obs.d26.configOff = await metaConfigOf(root)
      await closeSettings(page)
      await closeApp()

      log('launch 3: settings after the second restart')
      page = await launch('third')
      obs.d26.restartOff = await readSettings(page)
      obs.d26.configAfterRestartOff = await metaConfigOf(root)
      await closeSettings(page)
      await page.getByTestId('tab-improvements').click()
      obs.d26.screenOff = await poll(() => improverOf(page), v => v.metaStatus !== null, 'the meta status line', WAIT)
      obs.d26.filesAtRestart = await snapshot(pkgs, root)
      await closeApp()
    })
    await closeApp()

    // ---- after: switch off, K finished jobs; then the control with the switch on --------------
    await item('d26', async () => {
      if (obs.d26.restartOff === undefined) throw new Error('the settings were not saved off and read back (see above)')
      model.phase = 'job'
      const before = await snapshot(pkgs, root)
      const restoreAfter = scriptedEnvironment(SCRIPTED_API_KEY)
      try {
        const sdk = createStep5Sdk(pkgs, { env, home })
        try {
          const { projectId } = await sdk.call('projects.open', { root, create: true })
          const ran = []
          for (const name of ['j4', 'j5']) {
            const job = await explicitJob(sdk, projectId, name)
            await waitCounted(pkgs, root, job.id)
            ran.push({ id: job.id, status: job.status })
          }
          await sleep(3_000)
          obs.d26.autoOff = { ran, before, after: await snapshot(pkgs, root) }

          // Control: the same count with the switch on starts a meta job on the job-count rule.
          await sdk.call('settings.update', { projectId, patch: { improvement: { meta: { enabled: true, everyJobs: META_SETTINGS.off.every, budget: { maxTokens: META_SETTINGS.off.budget, windowDays: META_SETTINGS.off.window } } } } })
          const control = { configEnabled: (await metaConfigOf(root)).enabled, before: await snapshot(pkgs, root) }
          const job = await explicitJob(sdk, projectId, 'j6')
          await waitCounted(pkgs, root, job.id)
          const known = control.before.jobs.map(j => j.id)
          const started = await poll(async () => (await snapshot(pkgs, root)).jobs.find(j => j.kind === 'meta' && j.trigger === 'job-count' && !known.includes(j.id)) ?? null, j => j !== null, 'the automatic meta job', 60_000)
          await waitJob(pkgs, root, started.id)
          control.ran = { id: job.id, status: job.status }
          control.started = started.id
          control.after = await snapshot(pkgs, root)
          obs.d26.control = control
        } finally {
          await sdk.dispose()
        }
      } finally {
        restoreAfter()
        model.phase = 'main'
      }
    })
  } catch (error) {
    obs.error = { step: 'setup', message: errorText(error) }
    log(`step-6 desktop scenario stopped: ${errorText(error).split('\n')[0]}`)
  } finally {
    await app?.close().catch(() => undefined)
    await killJobProcesses(pkgs, root).catch(() => undefined)
    obs.modelRequests = server === undefined ? null : server.requests.length
    await server?.close().catch(() => undefined)
    display?.stop()
  }
  return obs
}
