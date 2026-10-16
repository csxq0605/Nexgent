/**
 * The step-5 desktop items D19–D23: Playwright drives the built Electron app
 * (real renderer, real `@nexgent/sdk` in the main process) against the scripted
 * Claude Messages API server — no real model. The jobs are real product runs:
 * the project is prepared headlessly first, with the SDK as shipped and the
 * step-5 scripted model, and four explicit improvement jobs run to their ends
 * (no capability problem, failed, rejected, adopted). Follows
 * apps/desktop/tests/improvements-e2e.spec.ts and step4-desktop.mjs.
 *
 *   prep      history tasks + feedback task + five feedback entries (autoImprove off),
 *             then explicit runs: not-capability → no-proposal, two components → failed,
 *             improve with an unknown feedback check → rejected, improve → adopted
 *   launch 1  D19/D20 the 改进 tab: every job card and every job's detail, compared with the
 *             job files; D23 the next task (loads the adopted skill) → 已被后续任务使用;
 *             D21 "改进" on the feedback deliverable's card → a new explicit job, followed
 *             to its end in the tab; D22 automatic improvement turned on, budget and window changed
 *   launch 2  D22 the values survived the restart; turned off with another budget
 *   launch 3  D22 the values survived again
 *   after     D22 with automatic improvement off, three counted feedback entries are submitted
 *             headlessly: the queue counts them, no job starts
 *
 * The scenario only observes; step5-desktop-judges.mjs decides. A step that
 * throws stops the scenario and is recorded in `obs.error`.
 */
import { mkdir, readFile, readdir, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { countsTowardImprovement, SECOND_FEEDBACK } from '../real-task/step5-orders.mjs'
import { isLoopbackUrl } from './step2-runtime.mjs'
import { dataDirSync, homeOf, registerHome } from './data-dir.mjs'
import { DESKTOP_DIR, VITE_BIN, ensureDisplay, poll, run } from './step2-desktop.mjs'
import { decisionsOf } from './step4-gate.mjs'
import { FEEDBACK_TASK, NEXT_TASK, runFeedbackProject, SCRIPTED_API_KEY, TERMINAL_STATES, PARKED_STATES } from './step5-fixtures.mjs'
import { Step5Model } from './step5-model.mjs'
import { createStep5Sdk, improvementsPath, loadStep5Packages, readImprovements, scriptedEnvironment } from './step5-runtime.mjs'
import { showTab, fillProjectPath } from './desktop-ui.mjs'

const TIMEOUT = 60_000
const WAIT = 45_000
const JOB_WAIT = 240_000
const ROOT_USER = typeof process.getuid === 'function' && process.getuid() === 0
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const SETTLED = new Set([...TERMINAL_STATES, ...PARKED_STATES])

/** Fake key the desktop app runs with. */
export const IMPROVEMENTS_DESKTOP_KEY = 'sk-accept-step5-desktop'
/** What the scenario types into the settings page. */
export const SETTINGS_VALUES = {
  on: { budget: 2_500_000, window: 7 },
  off: { budget: 3_000_000, window: 10 },
}
/** The desktop labels the scenario compares with (apps/desktop strings.ts). */
export const LABELS = { firstUse: '已被后续任务使用', feedbackRate: '反馈检查（单独记）', passRate: '检查通过率', review: '审核模型的意见决定了结果' }

const errorText = error => (error instanceof Error ? (error.stack ?? error.message) : String(error))
const readJson = path => readFile(path, 'utf8').then(text => JSON.parse(text), () => undefined)

/** A job file as the judges compare it with the screen. */
function jobFile(job) {
  return {
    id: job.id,
    trigger: job.trigger,
    status: job.status,
    items: (job.items ?? []).length,
    request: job.request,
    history: (job.history ?? []).map(change => ({ status: change.status, detail: change.detail })),
    detail: job.history?.at(-1)?.detail,
    candidateId: job.candidateId,
    decisionId: job.decisionId,
    phases: Object.keys(job.phases ?? {}),
    firstUse: job.firstUse,
    rolledBack: job.rolledBack,
  }
}

/** The state of the job files and decisions of a project. */
async function filesOf(pkgs, root) {
  const cap = await import(new URL('../../packages/capabilities/dist/index.js', import.meta.url).href)
  const { queue, jobs } = await readImprovements(pkgs, root)
  const decisions = await decisionsOf(root)
  const out = { queue: { counted: (queue?.counted ?? []).length, pending: (queue?.pending ?? []).length }, jobs: {} }
  for (const job of jobs) {
    const file = jobFile(job)
    const decision = decisions.find(d => d.id === job.decisionId)
    if (decision !== undefined) file.decision = { outcome: decision.outcome, reason: decision.reason, decidedByReview: decision.verdict?.decidedByReview === true, feedbackPassRate: decision.verdict?.feedbackPassRate, passRate: decision.verdict?.passRate }
    if (job.candidateId !== undefined) {
      const candidate = await cap.readCandidate(join(dataDirSync(root), 'capabilities'), job.candidateId).catch(() => undefined)
      file.candidate = candidate === undefined ? null : { components: candidate.components.map(c => ({ kind: c.kind, name: c.name })), summary: candidate.summary }
    }
    file.diagnosis = await readJson(join(improvementsPath(root), job.id, 'diagnosis.json'))
    out.jobs[job.id] = file
  }
  return out
}

/** Submit counted feedback entries on the deliverable and wait for each feedback turn. @returns the keys submitted. */
async function submitFeedback(harness, sdk, { projectId, sessionId, deliverableId, entries }) {
  const deliverable = (await sdk.call('deliverables.list', { projectId })).find(d => d.deliverableId === deliverableId)
  const version = deliverable?.versions?.at(-1)?.version
  const submitted = []
  for (const entry of entries) {
    const events = []
    const unsubscribe = sdk.onAgentEvent((event) => { if (event.projectId === projectId && event.sessionId === sessionId) events.push(event) })
    try {
      await sdk.call('feedback.submit', {
        projectId, sessionId, deliverableId, version,
        ...(entry.rating === undefined ? {} : { rating: entry.rating }), comment: entry.comment,
      })
      await harness.waitFor(() => events.some(e => e.type === 'turn.end') && !sdk.isRunning(projectId, sessionId), { timeoutMs: 60_000, intervalMs: 20, label: `feedback ${entry.key}` })
      submitted.push(entry.key)
    } finally {
      unsubscribe()
    }
  }
  return submitted
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

/** Wait until job `jobId` has a final or parked status. */
async function waitJob(pkgs, root, jobId, timeoutMs = JOB_WAIT) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const job = (await readImprovements(pkgs, root)).jobs.find(item => item.id === jobId)
    if (job !== undefined && SETTLED.has(job.status)) return job
    if (Date.now() > deadline) throw new Error(`job ${jobId} did not settle within ${timeoutMs / 1000}s (status ${job?.status ?? 'none'})`)
    await sleep(200)
  }
}

/** Every job card of the 改进 tab as shown. */
const cardsOf = page => page.evaluate(() => {
  const text = (el, id) => el.querySelector(`[data-testid="${id}"]`)?.textContent ?? null
  return [...document.querySelectorAll('[data-testid="improvement-job"]')].map(el => ({
    id: el.dataset.job ?? null,
    status: el.dataset.status ?? null,
    trigger: text(el, 'improvement-trigger'),
    statusText: text(el, 'improvement-status'),
    cost: text(el, 'improvement-cost'),
    detailText: text(el, 'improvement-detail-text'),
    cancel: el.querySelector('[data-testid="improvement-cancel"]') !== null,
    expanded: el.querySelector('[data-testid="improvement-detail"]') !== null,
  }))
})

/** The opened detail of job `id`, or null when it is not open. */
const detailOf = (page, id) => page.evaluate((jobId) => {
  const card = [...document.querySelectorAll('[data-testid="improvement-job"]')].find(el => el.dataset.job === jobId)
  const el = card?.querySelector('[data-testid="improvement-detail"]')
  if (el === null || el === undefined) return null
  const text = testId => el.querySelector(`[data-testid="${testId}"]`)?.textContent ?? null
  const all = testId => [...el.querySelectorAll(`[data-testid="${testId}"]`)].map(x => x.textContent ?? '')
  return {
    diagnosis: text('improvement-diagnosis'),
    failures: all('improvement-failure'),
    candidate: text('improvement-candidate'),
    gate: text('improvement-gate'),
    gateVerdict: text('improvement-gate-verdict'),
    gateRate: text('improvement-gate-rate'),
    gateFeedback: text('improvement-gate-feedback'),
    gateReview: text('improvement-gate-review'),
    phases: [...el.querySelectorAll('[data-testid="improvement-phases"] li')].map(x => ({ phase: x.dataset.phase ?? null, text: x.textContent ?? '' })),
    firstUse: text('improvement-first-use'),
    rolledBack: text('improvement-rolled-back'),
  }
}, id)

/** Make job `id`'s detail open (the card toggles), and read it. */
async function openDetail(page, id) {
  const card = page.locator(`[data-testid="improvement-job"][data-job="${id}"]`)
  await card.waitFor({ timeout: WAIT })
  if ((await card.getByTestId('improvement-detail').count()) === 0) await card.getByTestId('improvement-trigger').click()
  return poll(() => detailOf(page, id), d => d !== null && d.candidate !== null, `the detail of job ${id}`, WAIT)
}

/** The settings page's values (opened and closed again). */
async function readSettings(page) {
  await page.getByTestId('open-settings').click()
  const settings = page.getByTestId('settings-page')
  await settings.waitFor({ timeout: WAIT })
  await poll(() => settings.getByTestId('settings-improvement-budget').inputValue(), v => v !== '', 'the improvement budget field', WAIT)
  const values = {
    autoImprove: await settings.getByTestId('settings-auto-improve').isChecked(),
    budget: await settings.getByTestId('settings-improvement-budget').inputValue(),
    window: await settings.getByTestId('settings-improvement-window').inputValue(),
  }
  return values
}

const closeSettings = async page => {
  await page.keyboard.press('Escape')
  await page.getByTestId('settings-page').waitFor({ state: 'detached', timeout: WAIT }).catch(() => undefined)
}

/** Change the settings, save, and return what the page says. */
async function saveSettings(page, { autoImprove, budget, window }) {
  const settings = page.getByTestId('settings-page')
  if (autoImprove) await settings.getByTestId('settings-auto-improve').check()
  else await settings.getByTestId('settings-auto-improve').uncheck()
  await settings.getByTestId('settings-improvement-budget').fill(String(budget))
  await settings.getByTestId('settings-improvement-window').fill(String(window))
  await settings.getByTestId('settings-save').click()
  await settings.getByTestId('settings-saved').waitFor({ timeout: WAIT })
  return { approvalDialogs: await page.getByTestId('approval-dialog').count() }
}

const configOf = async root => {
  const config = await readJson(join(root, '.nexgent', 'config.json'))
  return {
    autoImprove: config?.autoImprove,
    budget: config?.improvement?.budget?.maxTokens,
    window: config?.improvement?.budget?.windowDays,
  }
}

/**
 * Run the improvements desktop scenario.
 * @param harness - @nexgent/test-support (scriptedModelServer, listSessionIds, ...).
 * @param work - an empty work directory.
 * @param options - `log(line)`.
 * @returns plain observations; see the top-level keys set below.
 */
export async function runImprovementsDesktopScenario(harness, work, { log = () => {} } = {}) {
  const { _electron: electron } = await import('playwright-core')
  const loaded = await loadStep5Packages()
  if (!loaded.ok) throw new Error(loaded.reason)
  const pkgs = loaded.pkgs
  await mkdir(work, { recursive: true })
  work = await realpath(work)
  const obs = { consoleErrors: { first: [], second: [], third: [] }, prepared: {} }
  const rendererDir = join(work, 'renderer')
  const root = join(work, 'project')
  const home = join(work, 'home')
  registerHome(root, home)
  createRequire(join(DESKTOP_DIR, 'package.json'))('electron')

  let server
  let display
  let app
  let step = 'setup'
  let model
  try {
    step = 'build renderer'
    log('building the renderer')
    const built = await run(process.execPath, [VITE_BIN, 'build', '--outDir', rendererDir, '--emptyOutDir', '--logLevel', 'error'], { cwd: DESKTOP_DIR })
    if (built.code !== 0) throw new Error(`vite build exited ${built.code}: ${built.stderr.slice(0, 400)}`)

    step = 'start display and scripted server'
    display = await ensureDisplay()
    model = new Step5Model(harness, { root, playbooks: [], feedbackAnswer: 'by-output' })
    server = await harness.scriptedModelServer({ script: Array.from({ length: 5_000 }, () => model.entry) })
    if (!isLoopbackUrl(server.baseUrl)) throw new Error(`scripted server is not on loopback: ${server.baseUrl}`)
    const env = { NEXGENT_API_BASE_URL: server.baseUrl, NEXGENT_API_KEY: SCRIPTED_API_KEY, NEXGENT_HOME: home }

    // ---- prep: the project and four real jobs, headless -------------------------------
    step = 'prepare the project'
    log('preparing the feedback project (headless)')
    const restore = scriptedEnvironment(SCRIPTED_API_KEY)
    try {
      const project = await runFeedbackProject(harness, pkgs, work, {
        server,
        log: line => log(`prep: ${line}`),
        config: { autoImprove: false, learning: { enabled: true } },
        createSdk: (e, h) => createStep5Sdk(pkgs, { env: e, home: h }),
      })
      obs.prepared.feedbackSession = project.tasks.at(-1)?.sessionId
      obs.prepared.deliverableId = project.deliverable?.deliverableId
      obs.prepared.feedbackCounted = project.feedback.filter(f => f.counted).length
      if (obs.prepared.feedbackSession === undefined || obs.prepared.deliverableId === undefined) throw new Error('the feedback project produced no deliverable')

      step = 'prepare the jobs'
      model.phase = 'job'
      const sdk = createStep5Sdk(pkgs, { env, home })
      try {
        const { projectId } = await sdk.call('projects.open', { root, create: true })
        const counted = SECOND_FEEDBACK.filter(entry => countsTowardImprovement(entry))
        const explicit = async (name, playbook, feedbackAnswer, { withFeedback = false } = {}) => {
          log(`prep: job ${name}`)
          // A job carries the counted feedback that waits in the queue (the feedback checks of its gate): give it its own.
          if (withFeedback) await submitFeedback(harness, sdk, { projectId, sessionId: obs.prepared.feedbackSession, deliverableId: obs.prepared.deliverableId, entries: counted })
          model.feedbackAnswer = feedbackAnswer
          model.playbooks.push(playbook)
          const started = await sdk.call('improvements.run', { projectId, sessionId: obs.prepared.feedbackSession })
          const job = await waitJob(pkgs, root, started.id)
          obs.prepared[name] = { id: started.id, status: job.status }
          return job
        }
        await explicit('noProposal', 'not-capability', 'by-output')
        await explicit('failed', 'two', 'by-output')
        await explicit('rejected', 'improve', 'null', { withFeedback: true })
        await explicit('adopted', 'improve', 'by-output', { withFeedback: true })
      } finally {
        await sdk.dispose()
      }
      obs.prepared.files = await filesOf(pkgs, root)
    } finally {
      restore()
    }
    model.feedbackAnswer = 'by-output'
    model.phase = 'main'

    // ---- launch helper ----------------------------------------------------------------
    const launch = async (which) => {
      const appEnv = {}
      for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !key.startsWith('NEXGENT_') && key !== 'ANTHROPIC_API_KEY') appEnv[key] = value
      Object.assign(appEnv, display.display === undefined ? {} : { DISPLAY: display.display }, {
        NEXGENT_HOME: home,
        NEXGENT_DESKTOP_RENDERER_DIR: rendererDir,
        NEXGENT_API_KEY: IMPROVEMENTS_DESKTOP_KEY,
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
      // The app reopens the last project; otherwise open the root from the start screen.
      await poll(async () => {
        if ((await page.getByTestId('workspace').count()) > 0) return 'workspace'
        return (await page.getByTestId('start-screen').count()) > 0 ? 'start' : 'loading'
      }, state => state !== 'loading', 'the workspace or the start screen', WAIT)
      await sleep(1_500)
      if ((await page.getByTestId('workspace').count()) === 0) {
        await fillProjectPath(page, root, { timeout: 10_000 })
        await page.getByRole('button', { name: '打开', exact: true }).click()
        await page.getByTestId('workspace').waitFor({ timeout: WAIT })
      }
      return page
    }
    const closeApp = async () => {
      await app?.close().catch(() => undefined)
      app = undefined
    }

    // ---- launch 1 ---------------------------------------------------------------------
    step = 'launch 1'
    log('launch 1: the 改进 tab')
    let page = await launch('first')
    await showTab(page, 'improvements')

    step = 'D19 D20 job cards and details'
    const ids = [obs.prepared.noProposal.id, obs.prepared.failed.id, obs.prepared.rejected.id, obs.prepared.adopted.id]
    await poll(() => cardsOf(page), cards => ids.every(id => cards.some(c => c.id === id)), 'the four job cards', WAIT)
    obs.list = {
      pending: await page.getByTestId('improvement-pending').textContent(),
      budget: await page.getByTestId('improvement-budget').textContent(),
      cards: await cardsOf(page),
    }
    obs.details = {}
    for (const id of ids) obs.details[id] = await openDetail(page, id).catch(error => ({ error: errorText(error).split('\n')[0] }))
    // A job without a candidate / a diagnosis: the detail may be sparse; keep what is shown even when nothing matched.
    obs.files = await filesOf(pkgs, root)

    step = 'D23 next task and first use'
    log('D23: the next task')
    const sessionsBefore = await harness.listSessionIds(root, { home: homeOf(root) })
    await page.getByTestId('new-session').click()
    const typeTurn = async (text, done) => {
      await page.getByTestId('composer-input').click()
      await page.keyboard.type(text)
      await page.keyboard.press('Enter')
      await poll(() => page.getByTestId('assistant-message').last().textContent(), t => (t ?? '').includes(done), `the answer ${done}`, WAIT)
      await page.getByTestId('send').waitFor({ timeout: WAIT })
    }
    await typeTurn(NEXT_TASK.ask, NEXT_TASK.output)
    const nextSession = (await harness.listSessionIds(root, { home: homeOf(root) })).find(id => !sessionsBefore.includes(id))
    obs.firstUse = { nextSession, uiBefore: null }
    // evolve records the first use when a turn starts after the task (or a host starts): look, nudge with a second turn, look again.
    const adoptedId = obs.prepared.adopted.id
    const firstUseText = async () => {
      await showTab(page, 'improvements')
      const detail = await openDetail(page, adoptedId)
      return detail.firstUse
    }
    const found = async (ms) => {
      const deadline = Date.now() + ms
      for (;;) {
        const text = await firstUseText().catch(() => null)
        if (text !== null && text !== undefined) return text
        if (Date.now() > deadline) return null
        await sleep(500)
      }
    }
    obs.firstUse.ui = await found(8_000)
    if (obs.firstUse.ui === null) {
      obs.firstUse.nudged = true
      await showTab(page, 'improvements')
      // Back to the next task's conversation: it is still the open one (the sidebar shortens titles, so not by text).
      await page.locator('[data-testid="session-item"][aria-current="true"]').first().click().catch(() => undefined)
      await typeTurn('谢谢', 'Noted.').catch(() => undefined)
      obs.firstUse.ui = await found(30_000)
    }
    obs.firstUse.file = (await filesOf(pkgs, root)).jobs[adoptedId]?.firstUse ?? null
    obs.firstUse.adoptedDecidedAt = (await decisionsOf(root)).find(d => d.id === obs.files.jobs[adoptedId]?.decisionId)?.decidedAt ?? null
    obs.firstUse.sessionIds = await harness.listSessionIds(root, { home: homeOf(root) })

    step = 'D21 improve from a deliverable card'
    log('D21: 改进 on the deliverable card')
    const jobsBefore = Object.keys((await filesOf(pkgs, root)).jobs)
    model.phase = 'job'
    model.playbooks.push('not-capability')
    await page.getByTestId('session-item').filter({ hasText: FEEDBACK_TASK.id }).first().click()
    const button = page.getByTestId('deliverable-improve').last()
    await button.waitFor({ timeout: WAIT })
    obs.deliverable = { cardCount: await page.getByTestId('deliverable-card').count() }
    await button.click()
    await showTab(page, 'improvements')
    const started = await poll(async () => {
      const cards = await cardsOf(page)
      return cards.find(c => !ids.includes(c.id ?? '') && !jobsBefore.includes(c.id ?? '')) ?? null
    }, c => c !== null, 'the new job in the 改进 tab', WAIT)
    const seen = [started.status]
    let latest = started
    const settleDeadline = Date.now() + JOB_WAIT
    while (!SETTLED.has(latest.status) && Date.now() < settleDeadline) {
      await sleep(150)
      latest = (await cardsOf(page)).find(c => c.id === started.id) ?? latest
      if (seen.at(-1) !== latest.status) seen.push(latest.status)
    }
    if (seen.at(-1) !== latest.status) seen.push(latest.status)
    model.phase = 'main'
    const afterFiles = await filesOf(pkgs, root)
    obs.deliverableJob = {
      id: started.id,
      firstSeen: started.status,
      seen,
      final: latest,
      file: afterFiles.jobs[started.id] ?? null,
      deliverableId: obs.prepared.deliverableId,
      feedbackSession: obs.prepared.feedbackSession,
      newJobs: Object.keys(afterFiles.jobs).filter(id => !jobsBefore.includes(id)),
    }

    step = 'D22 settings (launch 1)'
    log('D22: settings')
    obs.settings = { initial: await readSettings(page) }
    obs.settings.configBefore = await configOf(root)
    obs.settings.saveOn = await saveSettings(page, { autoImprove: true, ...SETTINGS_VALUES.on })
    obs.settings.configOn = await configOf(root)
    await closeSettings(page)
    await closeApp()

    // ---- launch 2 ---------------------------------------------------------------------
    step = 'D22 restart 1'
    log('launch 2: settings after the restart')
    page = await launch('second')
    obs.settings.restartOn = await readSettings(page)
    obs.settings.saveOff = await saveSettings(page, { autoImprove: false, ...SETTINGS_VALUES.off })
    obs.settings.configOff = await configOf(root)
    await closeSettings(page)
    await closeApp()

    // ---- launch 3 ---------------------------------------------------------------------
    step = 'D22 restart 2'
    log('launch 3: settings after the second restart')
    page = await launch('third')
    obs.settings.restartOff = await readSettings(page)
    await closeSettings(page)
    await closeApp()

    // ---- after: automatic improvement off, three counted feedback entries ------------------
    step = 'D22 feedback with automatic improvement off'
    log('D22: three counted feedback entries with automatic improvement off')
    const before = await filesOf(pkgs, root)
    const counted = SECOND_FEEDBACK.filter(entry => countsTowardImprovement(entry))
    const submitted = []
    const restoreAfter = scriptedEnvironment(SCRIPTED_API_KEY)
    try {
      const sdk = createStep5Sdk(pkgs, { env, home })
      try {
        const { projectId } = await sdk.call('projects.open', { root, create: true })
        submitted.push(...await submitFeedback(harness, sdk, { projectId, sessionId: obs.prepared.feedbackSession, deliverableId: obs.prepared.deliverableId, entries: counted }))
      } finally {
        await sdk.dispose()
      }
      await sleep(3_000)
    } finally {
      restoreAfter()
    }
    const after = await filesOf(pkgs, root)
    obs.autoOff = {
      submitted,
      jobsBefore: Object.keys(before.jobs).length,
      jobsAfter: Object.keys(after.jobs).length,
      queueBefore: before.queue,
      queueAfter: after.queue,
      config: await configOf(root),
    }
  } catch (error) {
    obs.error = { step, message: errorText(error) }
    log(`improvements desktop scenario stopped at ${step}: ${errorText(error).split('\n')[0]}`)
  } finally {
    await app?.close().catch(() => undefined)
    await killJobProcesses(pkgs, root).catch(() => undefined)
    obs.modelRequests = server === undefined ? null : server.requests.length
    await server?.close().catch(() => undefined)
    display?.stop()
  }
  return obs
}
