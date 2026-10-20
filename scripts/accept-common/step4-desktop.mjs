/**
 * The step-4 desktop items D15–D18: Playwright drives the built Electron app
 * (real renderer, real `@nexgent/sdk` in the main process) against the
 * scripted Claude Messages API server — no real model. Follows
 * apps/desktop/tests/capabilities-e2e.spec.ts.
 *
 * Updated 2026-10-19: the 能力 page no longer shows the version panel, the
 * candidate list, the revision list or the rollback button. The version and
 * candidate data still live in the project, so the scenario reads them the way
 * the renderer can (`capabilities.list` over the app's IPC), checks the 能力
 * page shows none of the old entries, and rolls back through
 * `capabilities.rollback` instead of the removed button.
 *
 *   1. A new project on the baseline; one turn.
 *   2. While the app is open, the capability files are written as the gate and
 *      the store write them (the gate itself has not landed): candidate A adopted,
 *      R rejected with a reason, T in a trial, B adopted and then rolled back by a
 *      usage regression, P a plugin that waited for approval (old data).
 *   3. A new conversation: no approval dialog appears (the flow was removed on
 *      2026-10-20) and P stays as it was; the data shows A, the candidates'
 *      statuses and R's reason; one turn on A.
 *   4. Manual rollback with a reason (IPC); then a restart.
 *
 * The scenario only observes; step4-desktop-judges.mjs decides. A step that
 * throws stops the scenario and is recorded in `obs.error`.
 */
import { appendFile, mkdir, readdir, readFile, realpath, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { dataDirSync, homeOf, registerHome } from './data-dir.mjs'
import { DESKTOP_DIR, VITE_BIN, ensureDisplay, poll, run } from './step2-desktop.mjs'
import { isLoopbackUrl } from './step2-runtime.mjs'
import { COMPONENTS, UNUSED_SKILL } from './step4-fixtures.mjs'
import { backToConversation, fillProjectPath } from './desktop-ui.mjs'

const TIMEOUT = 60_000
// Generous: the full test run starts several Electron apps at once.
const WAIT = 45_000
const ROOT_USER = typeof process.getuid === 'function' && process.getuid() === 0

/** Fake key the app runs with. */
export const CAPABILITY_DESKTOP_KEY = 'sk-accept-step4-desktop-capabilities'
/** Texts the scenario types and the scripted model answers. */
export const CAPABILITY_TEXTS = {
  firstTurn: '汇总六月订单',
  firstDone: '六月汇总好了。',
  secondTurn: '汇总七月订单',
  secondDone: '七月汇总好了。',
  rejectDetail: 'The candidate passed fewer checks than the baseline on the replay set.',
  rollbackReason: '口径要改',
}
/** The plugin candidate (D17: old data that waited for approval). */
export const PLUGIN_NAME = 'greeter'

const usage = { inputTokens: 40, outputTokens: 8, totalTokens: 48, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
const ZERO = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
const COST = { usage: ZERO, requestCount: 0, estimatedUsd: 0 }

/** The scripted model: one answer per turn. */
export function capabilityScript() {
  return { script: [{ content: CAPABILITY_TEXTS.firstDone, usage }, { content: CAPABILITY_TEXTS.secondDone, usage }] }
}

/** The plugin's plugin.json. */
export const PLUGIN_SPEC = { formatVersion: 1, name: PLUGIN_NAME, description: 'Greets.', permissions: 'Runs inside the app with its full rights.', tools: ['greet'] }

/** The plugin's files; importing or applying it writes `marker`. */
function pluginComponent(marker) {
  const spec = PLUGIN_SPEC
  const source = `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(marker)}, 'imported\\n')\nexport function apply() {}\n`
  return { kind: 'plugin', name: PLUGIN_NAME, files: [{ path: 'plugin.json', content: JSON.stringify(spec) }, { path: 'index.mjs', content: source }] }
}

/**
 * Write the capability files of step 2 the way the store and the gate write them.
 * @returns `{ A, R, T, B, P }`, each `{ id, version }`.
 */
async function seedCapabilities(cap, root, marker) {
  const dir = join(dataDirSync(root), 'capabilities')
  const store = new cap.CapabilityStore(dir)
  const verdict = (outcome, reason, candidate) => ({ outcome, reason, passRate: { candidate, baseline: 0.5 }, costRatio: 1, decidedByReview: false })
  const propose = async (base, component, summary) => {
    const { record } = await cap.writeCandidate(dir, {
      sessionId: randomUUID(),
      taskId: randomUUID(),
      turn: 1,
      base: await store.load(base),
      components: [{ kind: component.kind, name: component.name, files: new Map(component.files.map(f => [f.path, Buffer.from(f.content)])) }],
      proofs: [{ kind: component.kind, name: component.name, turn: 1, toolCallId: 'call-1' }],
      summary,
    })
    return record
  }
  /** Trial receipts: always the start, the end only when `verdictValue` is given. */
  const trial = async (candidate, verdictValue) => {
    const trialId = randomUUID()
    const ts = new Date().toISOString()
    const ref = caseId => ({ caseId, sessionId: randomUUID(), tree: 'a'.repeat(64), checks: [] })
    const lines = [{ type: 'trial.start', format: 1, trialId, ts, candidateId: candidate.id, candidateVersion: candidate.version, baselineVersion: candidate.base, plan: { selection: [ref('s1'), ref('s2')], guard: [ref('g1')], repeats: 2, costRatioCap: 1.2, reviewer: { model: 'claude-sonnet-5-5', thinking: 'on' }, budget: { maxTokens: 100000 } } }]
    if (verdictValue !== undefined) lines.push({ type: 'trial.end', format: 1, trialId, ts, status: verdictValue.outcome === 'reject' ? 'fail' : 'pass', verdict: verdictValue, cost: { candidate: COST, baseline: COST, review: COST } })
    await mkdir(join(dir, 'trials'), { recursive: true })
    await appendFile(join(dir, 'trials', `${trialId}.jsonl`), lines.map(line => `${JSON.stringify(line)}\n`).join(''))
    return trialId
  }
  const adopt = async (candidate) => {
    const v = verdict('adopt', 'quality-up', 1)
    const trialId = await trial(candidate, v)
    const done = await store.adopt(candidate.version, { trigger: 'gate', reason: 'quality-up', candidateId: candidate.id, trialId, verdict: v, detail: 'Passed its gate.' })
    if (done === null) throw new Error('adopt raced')
  }
  const decide = async (candidate, outcome, v, detail) => {
    const trialId = await trial(candidate, v)
    const current = (await store.activation()).version
    await store.recordDecision({ outcome, reason: v.reason, trigger: 'gate', candidateId: candidate.id, trialId, fromVersion: current, toVersion: current, verdict: v, cost: { candidate: COST, baseline: COST, review: COST }, detail })
  }

  const A = await propose('baseline', COMPONENTS.good.functionModule, '月度汇总函数')
  await adopt(A)
  const R = await propose(A.version, COMPONENTS.bad.skill, '不计折扣的汇总技能')
  await decide(R, 'rejected', verdict('reject', 'quality-down', 0.25), CAPABILITY_TEXTS.rejectDetail)
  const T = await propose(A.version, UNUSED_SKILL, '备注技能')
  await trial(T)
  const B = await propose(A.version, COMPONENTS.good.skill, '月度汇总技能')
  await adopt(B)
  if ((await store.rollback({ trigger: 'usage-regression', reason: 'usage-regression', detail: 'Checks failed more often after adoption.' })) === null) throw new Error('rollback raced')
  const P = await propose(A.version, pluginComponent(marker), '问候插件')
  await decide(P, 'awaiting-approval', verdict('await-approval', 'quality-up', 1), 'Passed its gate; a plugin needs the user.')
  const pick = record => ({ id: record.id, version: record.version })
  return { A: pick(A), R: pick(R), T: pick(T), B: pick(B), P: pick(P) }
}

/** Test ids of the 能力-page parts removed on 2026-10-19 (version panel, candidates, revisions, rollback, offline jobs). */
export const OLD_CAPABILITY_ENTRIES = ['tab-capabilities', 'tab-improvements', 'tab-offline', 'capability-current', 'capability-version', 'capability-candidate', 'candidate-status', 'capability-revision', 'capability-rollback']

/** Open the 能力 page, count the removed entries on it, go back. */
async function oldEntriesOf(page) {
  await page.getByTestId('nav-capabilities').click()
  await page.getByTestId('capabilities-page').waitFor({ timeout: WAIT })
  const out = {}
  for (const id of OLD_CAPABILITY_ENTRIES) out[id] = await page.getByTestId(id).count()
  await page.getByTestId('page-back').click()
  return out
}

/** The project's capability state as the renderer can read it: `capabilities.list` over the app's IPC. */
const panelOf = (page, root) => page.evaluate(async (path) => {
  const { projectId } = await window.nexgent.invoke('projects.open', { root: path })
  const listing = await window.nexgent.invoke('capabilities.list', { projectId })
  return {
    version: listing.current.version,
    revision: listing.current.revision,
    trigger: listing.current.trigger ?? null,
    components: listing.current.components.map(c => c.name),
    problem: listing.current.problem ?? null,
    candidates: listing.candidates.map(c => ({ id: c.id, status: c.status, detail: c.decision?.detail ?? null })),
    revisions: listing.history.map(r => r.type),
  }
}, root)

/** Manual rollback through the IPC call the app exposes (the button is gone). */
const rollbackOf = (page, root, reason) => page.evaluate(async ({ path, why }) => {
  const { projectId } = await window.nexgent.invoke('projects.open', { root: path })
  const view = await window.nexgent.invoke('capabilities.rollback', { projectId, reason: why })
  return { version: view.version, revision: view.revision }
}, { path: root, why: reason })

/** Every session's id and first record's capabilityVersion. */
async function sessionVersions(harness, root) {
  const out = {}
  for (const id of await harness.listSessionIds(root, { home: homeOf(root) })) out[id] = (await harness.readSessionRecords(root, id, { home: homeOf(root) })).records.find(r => r.type === 'session.start')?.capabilityVersion ?? null
  return out
}

/** Decisions in `decisions/`, as written. */
async function decisionsOf(root) {
  const dir = join(dataDirSync(root), 'capabilities', 'decisions')
  const out = []
  for (const name of await readdir(dir).catch(() => [])) out.push(JSON.parse(await readFile(join(dir, name), 'utf8')))
  return out
}

/**
 * Run the capabilities desktop scenario.
 * @param harness - @nexgent/test-support (scriptedModelServer, listSessionIds, readSessionRecords).
 * @param work - an empty work directory.
 * @param options - `log(line)`.
 */
export async function runCapabilitiesDesktopScenario(harness, work, { log = () => {} } = {}) {
  const { _electron: electron } = await import('playwright-core')
  const cap = await import(new URL('../../packages/capabilities/dist/index.js', import.meta.url).href)
  await mkdir(work, { recursive: true })
  work = await realpath(work)
  const obs = { consoleErrors: { first: [], second: [] } }
  const rendererDir = join(work, 'renderer')
  const home = join(work, 'home')
  const root = registerHome(join(work, 'orders'), home)
  const marker = join(work, 'plugin-ran.txt')
  const history = async () => (await new cap.CapabilityStore(join(dataDirSync(root), 'capabilities')).history()).map(r => ({ type: r.type, trigger: r.trigger, version: r.version, revision: r.revision }))
  await mkdir(home, { recursive: true })
  createRequire(join(DESKTOP_DIR, 'package.json'))('electron')

  let server
  let display
  let app
  let step = 'setup'
  const launch = async (which) => {
    const env = {}
    for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !key.startsWith('NEXGENT_') && key !== 'ANTHROPIC_API_KEY') env[key] = value
    Object.assign(env, display.display === undefined ? {} : { DISPLAY: display.display }, {
      NEXGENT_HOME: home,
      NEXGENT_DESKTOP_RENDERER_DIR: rendererDir,
      NEXGENT_API_KEY: CAPABILITY_DESKTOP_KEY,
      NEXGENT_API_BASE_URL: server.baseUrl,
    })
    app = await electron.launch({ args: ROOT_USER ? [DESKTOP_DIR, '--no-sandbox'] : [DESKTOP_DIR], env, timeout: TIMEOUT })
    const page = await app.firstWindow({ timeout: TIMEOUT })
    page.on('console', (message) => {
      if (message.type() === 'error') obs.consoleErrors[which].push(message.text())
    })
    page.on('pageerror', error => obs.consoleErrors[which].push(error.message))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 820))
    await page.waitForLoadState('load')
    return page
  }
  const turn = async (page, text, done) => {
    await backToConversation(page)
    const input = page.getByTestId('composer-input')
    await input.click()
    await page.keyboard.type(text)
    await page.keyboard.press('Enter')
    await poll(() => page.getByTestId('assistant-message').last().textContent(), t => (t ?? '').includes(done), `the answer ${done}`, WAIT)
    await page.getByTestId('send').waitFor({ timeout: WAIT })
  }

  try {
    step = 'build renderer'
    log('building the renderer')
    const built = await run(process.execPath, [VITE_BIN, 'build', '--outDir', rendererDir, '--emptyOutDir', '--logLevel', 'error'], { cwd: DESKTOP_DIR })
    if (built.code !== 0) throw new Error(`vite build exited ${built.code}: ${built.stderr.slice(0, 400)}`)

    step = 'start display and scripted server'
    display = await ensureDisplay()
    server = await harness.scriptedModelServer(capabilityScript())
    if (!isLoopbackUrl(server.baseUrl)) throw new Error(`scripted server is not on loopback: ${server.baseUrl}`)

    step = 'D15 baseline'
    log('baseline project')
    let page = await launch('first')
    await page.getByTestId('start-screen').waitFor({ timeout: WAIT })
    await fillProjectPath(page, root)
    await page.getByTestId('create-project').click()
    await page.getByTestId('workspace').waitFor({ timeout: WAIT })
    await page.getByTestId('new-session').click()
    obs.before = await panelOf(page, root)
    await turn(page, CAPABILITY_TEXTS.firstTurn, CAPABILITY_TEXTS.firstDone)
    obs.firstSessions = await sessionVersions(harness, root)

    step = 'seed capability files'
    log('writing candidates, adoption and rollback')
    obs.seed = await seedCapabilities(cap, root, marker)
    obs.seededHistory = await history()

    step = 'D17 no approval dialog'
    log('new conversation: no approval dialog')
    await page.getByTestId('new-session').click()

    step = 'D15 D16 capability data after adoption'
    obs.after = await poll(() => panelOf(page, root), p => p.version === obs.seed.A.version && p.candidates.find(c => c.id === obs.seed.P.id)?.status === 'awaiting-approval', 'version A and the unchanged plugin candidate in the capability data', WAIT)
    obs.after.oldEntries = await oldEntriesOf(page)
    obs.dialogs = { afterNewSession: await page.getByTestId('plugin-approval-dialog').count() }
    obs.afterOpen = { history: await history(), decisions: (await decisionsOf(root)).filter(d => d.candidateId === obs.seed.P.id).map(d => ({ outcome: d.outcome, reason: d.reason })) }
    await turn(page, CAPABILITY_TEXTS.secondTurn, CAPABILITY_TEXTS.secondDone)
    obs.secondSessions = await sessionVersions(harness, root)

    step = 'D18 manual rollback'
    log('manual rollback')
    obs.rollbackResult = await rollbackOf(page, root, CAPABILITY_TEXTS.rollbackReason)
    const settled = async () => ({ ...(await panelOf(page, root)), history: await history() })
    obs.rolledBack = await settled()

    step = 'close'
    await app.close()
    app = undefined

    step = 'D18 restart'
    log('restart')
    page = await launch('second')
    await page.getByTestId('workspace').waitFor({ timeout: WAIT })
    obs.restart = await settled()
    obs.restart.oldEntries = await oldEntriesOf(page)
    obs.restart.dialogs = await page.getByTestId('plugin-approval-dialog').count()

    step = 'close'
    await app.close()
    app = undefined
  } catch (error) {
    obs.error = { step, message: error instanceof Error ? (error.stack ?? error.message) : String(error) }
    log(`capabilities scenario stopped at ${step}: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    await app?.close().catch(() => undefined)
    obs.pluginRan = await stat(marker).then(() => true, () => false)
    obs.modelRequests = server === undefined ? null : server.requests.length
    await server?.close().catch(() => undefined)
    display?.stop()
  }
  return obs
}
