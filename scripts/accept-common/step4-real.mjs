/**
 * The real-model layer of accept-step4 (R01–R06, docs/plan/step-4-work-partition.md
 * §真实模型验收): the monthly order-summary family (scripts/real-task/step4-orders.mjs)
 * in one project, driven through `@nexgent/sdk` against the real Claude API
 * (thinking on), with the real gate (its processes inherit this process's
 * environment, so they read the key the same way):
 *
 *   R01 history   two past tasks (a monthly summary, a region table), each with its test
 *                 command: snapshots and checks for the replay set
 *   R02 task A    a summary that also asks for a reusable function or skill (user decision 8):
 *                 the model drafts, tries, uses and proposes it
 *   R03 gate      the automatic gate after task A: both arms on the replay set, r runs each,
 *                 the reviewer only on a tie; its verdict is recorded whatever it is
 *   R04 task B    a new month in a new OS process, no mention of a component: it must load
 *                 the adopted version and call it (only when the gate adopted)
 *   R05 injected  the adopted function module is broken on purpose (an adoption of a copy
 *                 whose functions throw, written through the store as the gate would);
 *                 the next tasks must trigger the usage rollback within the rule's window, and
 *                 the task after it must run on the version before the injection
 *   R06 costs     requests, tokens, unknown counts and estimated cost per task; the trial's
 *                 cost apart; the total under the cap
 *
 * Before each step the estimated spend so far (from the project's ledger) plus that
 * step's reserve must stay under the cap, or the scenario stops. A step whose task
 * did not complete stops the scenario too: later steps would prove nothing.
 * The key is never logged or written: it lives in the environment and the SDK's env
 * object only; the task-B child reads it from its inherited environment.
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expectedRegionsCsv, judgeSummary, ordersCsv } from '../real-task/step4-orders.mjs'
import { budgetGate } from './step2-checks.mjs'
import { ledgerUsage } from './step2-real.mjs'
import { runTurn } from './step2-runtime.mjs'
import { createStep3Sdk, loadStep3Packages } from './step3-runtime.mjs'
import { REAL_MODEL, realModelKeySource } from './step4-checks.mjs'
import { checkSource, familyTask, REPLAY_TASKS, TASK_A, TASK_B, writeReplayProject } from './step4-fixtures.mjs'
import { decisionsOf, editConfig, gateLines, trialsOf } from './step4-gate.mjs'
import { activationOf, candidatesOf, filesUnder, ledgerOf, sessionsOf } from './step4-headless.mjs'

const DRIVER = fileURLToPath(new URL('./step4-real-driver.mjs', import.meta.url))

/** Per-task caps of the project (permissions.md §费用上限). */
export const TASK_CAPS = { maxRequests: 80, maxTokens: 2_000_000 }
/** The gate's trial budget (`capabilities.trialBudget`), sized to the 15 USD cap. */
export const TRIAL_BUDGET = { maxRequests: 240, maxTokens: 2_000_000 }
/** Estimated USD set aside before each step; a step starts only when spent + reserve stays under the cap. */
export const RESERVE = { task: 0.8, gate: 7 }

/** R01: a monthly summary (the selection side) and a region table (the guard side). */
export const HISTORY = [REPLAY_TASKS[0], REPLAY_TASKS[2]]
/** R05: tasks on the injected version (at most the rule's window), then one after the rollback. */
export const REGRESSION_TASKS = ['2026-11', '2026-12', '2027-01'].map(month => familyTask(`summary-${month}`, 'summary', month))
export const AFTER_ROLLBACK = familyTask('summary-2027-02', 'summary', '2027-02')

const errorText = error => (error instanceof Error ? error.message : String(error))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

class StopScenario extends Error {}

function slim(event) {
  switch (event.type) {
    case 'tool.start': return { type: event.type, turn: event.turn, name: event.call.name, arguments: String(JSON.stringify(event.call.arguments)).slice(0, 600) }
    case 'tool.result': return { type: event.type, turn: event.turn, name: event.name, isError: event.isError, content: String(event.content).slice(0, 300) }
    case 'turn.end': return { type: event.type, turn: event.turn, reason: event.reason }
    case 'error': return { type: event.type, error: event.error }
    default: return undefined
  }
}

/** Hidden check of a task's output, from the orders it was made from. */
export function hiddenCheck(task, text) {
  if (text === null || text === undefined) return { pass: false, problems: [`${task.output} was not written`] }
  if (task.kind === 'regions') {
    const want = expectedRegionsCsv(ordersCsv(task.month))
    const got = String(text).replace(/\r\n/g, '\n').replace(/\n*$/, '\n')
    return got === want ? { pass: true, problems: [] } : { pass: false, problems: ['the region table does not match the orders'] }
  }
  return judgeSummary(ordersCsv(task.month), text)
}

/** Usage of a set of ledger records (any sessions). */
export function usageOf(records) {
  return ledgerUsage(records.map(({ sessionId: _s, ...rest }) => rest), undefined)
}

/** The broken copy of a function module's entry: every function it declares throws. */
export function brokenModuleSource(spec) {
  const names = (spec.functions ?? []).map(fn => fn.name).filter(name => typeof name === 'string')
  return `${names.map(name => `export function ${name}() {\n  throw new Error('injected regression (accept-step4 R05): ${name} is broken on purpose')\n}\n`).join('\n')}`
}

/**
 * R05's injection: a copy of the adopted version whose function module's functions all throw,
 * written as a candidate and adopted through the store with `trigger: gate` (so the usage watch
 * applies), its decision saying plainly that it is an injection and not a gate result.
 * @param cap - `@nexgent/capabilities`.
 * @returns `{ candidateId, version, from, module, functions }`, or `{ skipped }` when there is no function module.
 */
export async function injectRegression(cap, dir, adoptedVersion, gateVerdict) {
  const store = new cap.CapabilityStore(dir)
  const base = await store.load(adoptedVersion)
  const module = base.manifest.components.find(c => c.kind === 'function-module')
  if (module === undefined) return { skipped: 'the adopted version has no function module to break' }
  const files = new Map((await cap.readComponentFiles(base, module)).map(file => [file.path, Buffer.from(file.content)]))
  const spec = JSON.parse(Buffer.from(files.get('functions.json') ?? '{}').toString('utf8'))
  files.set(spec.entry ?? 'index.mjs', Buffer.from(brokenModuleSource(spec)))
  const { record } = await cap.writeCandidate(dir, {
    sessionId: randomUUID(),
    taskId: randomUUID(),
    turn: 1,
    base,
    components: [{ kind: 'function-module', name: module.name, files }],
    proofs: [{ kind: 'function-module', name: module.name, turn: 1, toolCallId: 'injected' }],
    summary: 'accept-step4 R05: the adopted module with every function broken on purpose',
  })
  const injected = await store.adopt(record.version, {
    trigger: 'gate',
    reason: 'quality-up',
    candidateId: record.id,
    ...(gateVerdict === undefined ? {} : { verdict: gateVerdict }),
    detail: 'Injected by accept-step4 R05 to test the usage rollback: a copy of the adopted function module whose functions throw. Not a gate result.',
  })
  if (injected === null) throw new Error('the injected adoption raced another writer')
  return { candidateId: record.id, version: record.version, from: adoptedVersion, module: module.name, functions: (spec.functions ?? []).map(fn => fn.name) }
}

/** One task-B turn in a child OS process; the child reads the key from its inherited environment. */
function turnInChild(spec) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [DRIVER, JSON.stringify(spec)], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000) })
    child.on('close', (code) => {
      const lines = stdout.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line) } catch { return { raw: line } } })
      resolve({ pid: child.pid, exitCode: code, done: lines.find(line => line.type === 'driver.done'), events: lines.filter(line => line.type === 'tool.start' || line.type === 'tool.result' || line.type === 'driver.timeout'), stderr: stderr.slice(-1500) })
    })
  })
}

/**
 * Run R01–R05 once (R06 is read from what they spent).
 * @param h - @nexgent/test-support.
 * @param options - `env` (NEXGENT_API_KEY, optional NEXGENT_API_BASE_URL), `realModel`, `budgetUsd`, `spent`, `turnTimeoutMs`, `gateTimeoutMs`, `log`.
 */
export async function runRealScenario(h, work, { env, realModel, budgetUsd = REAL_MODEL.budgetUsd, spent = [], turnTimeoutMs = 30 * 60_000, gateTimeoutMs = 120 * 60_000, log = () => {} }) {
  const loaded = await loadStep3Packages()
  if (!loaded.ok) throw new Error(loaded.reason)
  const pkgs = loaded.pkgs
  const root = join(work, 'project')
  const home = join(work, 'home')
  await mkdir(root, { recursive: true })
  await mkdir(home, { recursive: true })
  await writeReplayProject(root)
  for (const task of [...REGRESSION_TASKS, AFTER_ROLLBACK]) {
    await writeFile(join(root, task.input), ordersCsv(task.month))
    await writeFile(join(root, 'checks', `${task.id}.test.mjs`), checkSource(task))
  }
  const earlier = spent.reduce((sum, cost) => sum + (typeof cost === 'number' ? cost : 0), 0)
  const obs = { platform: process.platform, realModel, budgetUsd, spentBeforeUsd: earlier, config: {}, tasks: {}, approvals: [] }
  const approvals = async (request) => {
    obs.approvals.push({ tool: request.tool, summary: String(request.summary).slice(0, 200) })
    return { id: request.id, decision: 'allow', scope: 'once', decidedBy: 'user' }
  }
  const sdkEnv = { ...env, NEXGENT_HOME: home }
  const sdk = createStep3Sdk(pkgs, { env: sdkEnv, home, approvals, realModel })
  let projectId
  let step = 'setup'
  const spentNow = async () => earlier + usageOf(await ledgerOf(root)).costUsd
  const guard = async (reserve, before) => {
    const now = await spentNow()
    if (now + reserve > budgetUsd) {
      obs.stoppedForBudget = { before, spentUsd: Math.round(now * 10000) / 10000, reserveUsd: reserve }
      throw new StopScenario(`not starting ${before}: ${now.toFixed(2)} USD spent, reserve ${reserve} USD, cap ${budgetUsd} USD`)
    }
  }
  const withTimeout = async (promise, label, sessionId) => {
    let timer
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} did not finish within ${turnTimeoutMs} ms`)), turnTimeoutMs) })
    try {
      return await Promise.race([promise, timeout])
    } catch (error) {
      await sdk.cancelTurn({ projectId, sessionId }).catch(() => undefined)
      throw error
    } finally {
      clearTimeout(timer)
    }
  }
  const versionOf = async sessionId => (await sessionsOf(root))[sessionId]?.find(r => r.type === 'session.start')?.capabilityVersion
  const outcomeOf = async sessionId => (await ledgerOf(root)).filter(r => r.type === 'task.outcome' && r.sessionId === sessionId && r.trialId === undefined && r.memberId === 'main').at(-1)
  const finishTask = async (key, task, sessionId, extra) => {
    const output = await readFile(join(root, task.output), 'utf8').catch(() => null)
    const outcome = await outcomeOf(sessionId)
    obs.tasks[key] = {
      id: task.id, sessionId, ...extra,
      version: await versionOf(sessionId),
      taskId: outcome?.taskId,
      componentsUsed: outcome?.componentsUsed ?? null,
      checks: outcome?.checks ?? null,
      hidden: hiddenCheck(task, output),
    }
    log(`${key}: ${extra.reason?.kind ?? extra.error ?? 'no result'}, hidden ${obs.tasks[key].hidden.pass ? 'pass' : `fail (${obs.tasks[key].hidden.problems.slice(0, 2).join('; ')})`}`)
    if (extra.reason?.kind !== 'completed') throw new StopScenario(`${key} did not complete`)
  }
  const task = async (key, entry, reserve = RESERVE.task) => {
    step = key
    await guard(reserve, key)
    const sessionId = (await sdk.call('sessions.create', { projectId, title: `step-4 real ${key}` })).sessionId
    const run = await withTimeout(runTurn(sdk, { projectId, sessionId, text: entry.ask }), key, sessionId)
    await finishTask(key, entry, sessionId, { reason: run.result?.reason, ...(run.error === undefined ? {} : { error: errorText(run.error) }), events: run.events.map(slim).filter(Boolean) })
    return sessionId
  }
  const tail = async () => (await activationOf(root)).at(-1)

  try {
    projectId = (await sdk.call('projects.open', { root, create: true })).projectId
    await sdk.call('settings.update', { projectId, patch: { model: REAL_MODEL.model, thinking: REAL_MODEL.thinking, costCaps: { perTask: TASK_CAPS } } })
    await editConfig(root, config => ({ ...config, capabilities: { ...config.capabilities, trialBudget: TRIAL_BUDGET } }))
    const config = JSON.parse(await readFile(join(root, '.nexgent', 'config.json'), 'utf8'))
    obs.rule = config.capabilities?.rollback ?? { windowTasks: 3, consecutiveErrors: 3 }
    obs.config = { model: REAL_MODEL.model, thinking: REAL_MODEL.thinking, costCaps: { perTask: TASK_CAPS }, trialBudget: TRIAL_BUDGET }

    // R01
    for (const [index, entry] of HISTORY.entries()) await task(`history${index + 1}`, entry)

    // R02, and the gate it starts (R03): the task's reserve includes the gate's.
    const sessionA = await task('A', TASK_A, RESERVE.task + RESERVE.gate)
    const proposed = (await candidatesOf(root)).filter(c => c.record?.sessionId === sessionA)
    obs.candidates = proposed.map(c => ({ id: c.id, version: c.record.version, base: c.record.base, taskId: c.record.taskId, components: (c.record.components ?? []).map(x => ({ kind: x.kind, name: x.name })), summary: c.record.summary }))
    obs.proposals = ((await sessionsOf(root))[sessionA] ?? []).filter(r => r.type === 'capability.propose').map(r => ({ candidateId: r.candidateId, proofs: r.proofs }))
    if (obs.candidates.length === 0) throw new StopScenario('task A proposed no candidate')

    // R03: wait for every candidate's gate to print its result.
    step = 'gate'
    log(`gate: waiting for ${obs.candidates.length} candidate(s)`)
    const deadline = Date.now() + gateTimeoutMs
    obs.gate = {}
    for (const candidate of obs.candidates) {
      let line
      while (Date.now() < deadline) {
        line = (await gateLines(root, candidate.id)).at(-1)
        if (line !== undefined) break
        await sleep(5_000)
      }
      obs.gate[candidate.id] = { line: line ?? null }
      log(`gate ${candidate.id.slice(0, 8)}: ${line === undefined ? 'no result before the deadline' : `${line.status} ${line.verdict?.outcome ?? line.detail ?? ''} ${line.verdict?.reason ?? ''}`}`)
    }
    const decisions = await decisionsOf(root)
    const adoptedDecision = decisions.find(d => d.outcome === 'adopted' && d.trigger === 'gate' && obs.candidates.some(c => c.id === d.candidateId))
    obs.adopted = adoptedDecision === undefined ? null : { candidateId: adoptedDecision.candidateId, version: adoptedDecision.toVersion }
    if (obs.adopted === null) throw new StopScenario('the gate did not adopt a candidate; R04 and R05 cannot run')

    // R04: a new month in a new OS process.
    step = 'B'
    await guard(RESERVE.task, 'B')
    const sessionB = (await sdk.call('sessions.create', { projectId, title: 'step-4 real B' })).sessionId
    const child = await turnInChild({ root, home, sessionId: sessionB, text: TASK_B.ask, keySource: realModelKeySource(process.env) ?? 'NEXGENT_API_KEY', baseUrl: env.NEXGENT_API_BASE_URL, realModel, timeoutMs: turnTimeoutMs })
    await finishTask('B', TASK_B, sessionB, { reason: child.done?.reason, ...(child.done?.error === undefined ? {} : { error: child.done.error }), events: child.events, child: { pid: child.pid, parentPid: process.pid, exitCode: child.exitCode, stderr: child.stderr } })

    // R05: inject a broken copy of the adopted function module.
    step = 'inject'
    const cap = await import(new URL('../../packages/capabilities/dist/index.js', import.meta.url).href)
    obs.injection = await injectRegression(cap, join(root, '.nexgent', 'capabilities'), obs.adopted.version, adoptedDecision.verdict)
    if (obs.injection.skipped !== undefined) throw new StopScenario(obs.injection.skipped)
    log(`R05: injected ${obs.injection.version.slice(0, 12)} over ${obs.adopted.version.slice(0, 12)}`)

    obs.regression = { tasks: [] }
    for (const [index, entry] of REGRESSION_TASKS.entries()) {
      const key = `regress${index + 1}`
      await task(key, entry)
      obs.regression.tasks.push(key)
      const last = await tail()
      if (last?.type === 'rollback' && last.trigger === 'usage-regression') break
    }
    // The watch also runs before the next root session resolves its version.
    await task('afterRollback', AFTER_ROLLBACK)
  } catch (error) {
    if (error instanceof StopScenario) obs.stopped = { step, reason: error.message }
    else obs.error = { step, message: error instanceof Error ? (error.stack ?? error.message) : String(error) }
    log(`stopped at ${step}: ${errorText(error)}`)
  } finally {
    await sdk.dispose().catch(() => undefined)
  }
  // Late reads: everything the judges need, from disk.
  const ledger = await ledgerOf(root)
  obs.sessionsStart = Object.fromEntries(Object.entries(await sessionsOf(root)).map(([id, records]) => [id, records.find(r => r.type === 'session.start')?.capabilityVersion]))
  obs.activation = await activationOf(root)
  obs.decisions = await decisionsOf(root)
  obs.trials = await trialsOf(root)
  obs.snapshots = await filesUnder(join(root, '.nexgent', 'snapshots'))
  obs.ledgerVersions = Object.fromEntries(Object.values(obs.tasks).map(t => [t.sessionId, [...new Set(ledger.filter(r => r.sessionId === t.sessionId && r.trialId === undefined).map(r => r.capabilityVersion))]]))
  obs.usage = {
    tasks: Object.fromEntries(Object.entries(obs.tasks).map(([key, t]) => [key, usageOf(ledger.filter(r => r.sessionId === t.sessionId && r.trialId === undefined))])),
    trials: Object.fromEntries(Object.keys(obs.trials).map(trialId => [trialId, usageOf(ledger.filter(r => r.trialId === trialId))])),
    trial: usageOf(ledger.filter(r => r.trialId !== undefined)),
    main: usageOf(ledger.filter(r => r.trialId === undefined)),
    total: usageOf(ledger),
  }
  obs.totalCostUsd = obs.usage.total.costUsd
  obs.root = root
  await writeFile(join(work, 'observations.json'), `${JSON.stringify(obs, null, 1)}\n`).catch(() => undefined)
  return obs
}

/**
 * Whether the real layer may start: a key variable is set and the earlier
 * runs' estimated spend leaves room under the cap. Reads which variable is
 * set, never its value.
 * @returns `{ ok: true, keySource, remainingUsd }` or `{ ok: false, reason }`.
 */
export function realPrerequisites(env, budgetUsd, spent) {
  const keySource = realModelKeySource(env)
  if (keySource === undefined) return { ok: false, reason: `no API key (${REAL_MODEL.keyEnv.join(' or ')} is not set)` }
  const gate = budgetGate(budgetUsd, spent)
  if (!gate.ok) return { ok: false, reason: gate.reason }
  return { ok: true, keySource, remainingUsd: gate.remainingUsd }
}
