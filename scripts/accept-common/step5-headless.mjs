/**
 * The step-5 headless scenario (docs/plan/step-5-work-partition.md §`accept-step5`),
 * scripted model server only, through `@nexgent/sdk`. Each phase has its own project.
 *
 *   counting      the feedback project (step5-fixtures.mjs) with the evolve row: after each of
 *                 the five feedbacks, the queue and the jobs (H01); per-turn snapshots and checks
 *                 of the feedback task before and after the feedback turns (H16, kernel only)
 *   checkFailure  one region-table task whose output is wrong: the host's check fails, the
 *                 kernel signals it, the queue grows by one (H03)
 *   disabled      the feedback project with autoImprove off in config.json: feedback recorded,
 *                 no job (H04)
 *   explicit      autoImprove off, empty queue: `improvements.run` through the SDK; while the SDK
 *                 does not implement it, the plugin host's `run` on the same project (H02)
 *   concurrency   one counted feedback, then two OS processes submit one counted feedback each at
 *                 the same instant (two sessions): both counted once, one job, held running (H15)
 *   recovery      that job's process killed; the next SDK start marks it interrupted, no rerun (H15)
 *
 * `features.shipped` says whether the SDK as shipped runs the flow (`improvements.list`
 * answers). Until it does (W4) the phases insert the `@nexgent/evolve` row themselves
 * (step5-runtime.mjs) and the judges report what they checked as not-implemented,
 * never as a pass. H16 needs no evolve and is judged as is.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { countsTowardImprovement, FEEDBACK, ordersCsv, THRESHOLD } from '../real-task/step5-orders.mjs'
import { runTurn } from './step2-runtime.mjs'
import { FEEDBACK_TASK, outputFor, runFeedbackProject, SCRIPTED_API_KEY, taskScript, writeFeedbackProject } from './step5-fixtures.mjs'
import { createStep5Sdk, improvementsPath, jobView, loadStep5Packages, pendingFeedback, readImprovements } from './step5-runtime.mjs'

const DRIVER = fileURLToPath(new URL('./step5-driver.mjs', import.meta.url))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Whether the built `@nexgent/evolve` package is in the workspace (evidence only). */
export function evolvePackageBuilt() {
  return existsSync(new URL('../../packages/evolve/dist/index.js', import.meta.url))
}

/** The CSV a fixture task read (for the fixture check). */
export const csvOf = task => ordersCsv(task.id.slice(-7))

/** Poll `probe` until `done(value)` or the deadline; returns the last value either way. */
async function settle(probe, done, { timeoutMs = 10_000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs
  let value = await probe()
  while (!done(value) && Date.now() < deadline) {
    await sleep(intervalMs)
    value = await probe()
  }
  return value
}

const sha = text => (text === undefined ? undefined : createHash('sha256').update(text).digest('hex'))
const readText = path => readFile(path, 'utf8').catch(() => undefined)

/** Per-turn snapshot and check files of the task a session ran (`snapshots/tasks|checks/<taskId>.t<n>.json`). */
async function turnFiles(root, sessionId) {
  const dir = join(root, '.nexgent', 'snapshots')
  const out = { taskId: undefined, tasks: {}, checks: {}, legacy: {} }
  const names = await readdir(join(dir, 'tasks')).catch(() => [])
  for (const name of names) {
    const text = await readText(join(dir, 'tasks', name))
    let record
    try {
      record = JSON.parse(text)
    } catch {
      continue
    }
    if (record?.sessionId !== sessionId) continue
    out.taskId = record.taskId ?? name.replace(/(\.t\d+)?\.json$/, '')
  }
  if (out.taskId === undefined) return out
  for (const kind of ['tasks', 'checks']) {
    for (const name of await readdir(join(dir, kind)).catch(() => [])) {
      if (!name.startsWith(`${out.taskId}.`)) continue
      const turn = /\.t(\d+)\.json$/.exec(name)?.[1]
      const text = await readText(join(dir, kind, name))
      if (turn === undefined) out.legacy[kind] = sha(text)
      else out[kind][turn] = { sha: sha(text), record: kind === 'checks' ? JSON.parse(text) : undefined }
    }
  }
  return out
}

/** Whether the SDK as shipped runs the improvement flow: `improvements.list` answers instead of refusing. */
async function shippedProbe(sdk, projectId) {
  try {
    await sdk.call('improvements.list', { projectId })
    return { shipped: true }
  } catch (error) {
    return { shipped: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/** H01 + H16: the feedback project with the evolve row; queue and jobs after each feedback; per-turn records. */
async function countingPhase(h, pkgs, work, log) {
  const stages = 'pending'
  let shipped
  const project = await runFeedbackProject(h, pkgs, work, {
    log: line => log(`counting: ${line}`),
    createSdk: (env, home) => createStep5Sdk(pkgs, { env, home, evolve: { stages } }),
    async beforeFeedback({ sdk, projectId, root, feedbackSession }) {
      shipped = await shippedProbe(sdk, projectId)
      return { files: await turnFiles(root, feedbackSession) }
    },
    async afterFeedback(entry, { root, id }) {
      // Wait for the plugin's background count (and, at the threshold, the job); an uncounted
      // feedback leaves nothing to wait for, so it gets a short look only.
      const counts = countsTowardImprovement(entry)
      const state = await settle(() => readImprovements(pkgs, root), ({ queue, jobs }) => {
        if (!counts) return false
        const keys = (queue?.counted ?? []).filter(key => key.startsWith('feedback:'))
        return keys.includes(`feedback:${id}`) && (keys.length < THRESHOLD || jobs.length > 0)
      }, { timeoutMs: counts ? 10_000 : 600 })
      return { queue: pendingFeedback(state.queue), counted: state.queue?.counted ?? [], jobs: state.jobs.map(jobView) }
    },
  })
  const feedbackSession = project.tasks.at(-1)?.sessionId
  const after = await turnFiles(project.root, feedbackSession)
  return {
    shipped,
    project,
    steps: project.feedback.map(f => ({ key: f.key, rating: f.rating, comment: f.comment, feedbackId: f.id, queue: f.observed?.queue ?? [], counted: f.observed?.counted ?? [], jobs: f.observed?.jobs ?? [] })),
    turns: { taskId: after.taskId, before: project.before?.files, after, feedbackTurns: project.feedback.length },
  }
}

/**
 * A fresh project and an SDK with the evolve row. With `corrupt`, one run of the feedback
 * task: write the right table, run its test (passes, so the host keeps it as a check),
 * then str_replace one value (`corrupt.from` → `corrupt.to`) and present, so the host's
 * re-run at turn end fails.
 */
async function singleTaskProject(h, pkgs, work, { corrupt, config, evolve }) {
  const root = join(work, 'project')
  const home = join(work, 'home')
  await mkdir(root, { recursive: true })
  await writeFeedbackProject(root)
  if (config !== undefined) {
    await mkdir(join(root, '.nexgent'), { recursive: true })
    await writeFile(join(root, '.nexgent', 'config.json'), `${JSON.stringify(config)}\n`)
  }
  const usage = { inputTokens: 40, outputTokens: 12 }
  const mine = body => h.requestText(body).includes(FEEDBACK_TASK.ask)
  const script = corrupt === undefined ? [] : [
    ...taskScript(h, [FEEDBACK_TASK]).slice(0, 2),
    h.expectRequest(`${FEEDBACK_TASK.id}: corrupt`, mine, { toolCalls: [{ name: 'str_replace', arguments: { path: FEEDBACK_TASK.output, old_str: corrupt.from, new_str: corrupt.to } }], usage }),
    ...taskScript(h, [FEEDBACK_TASK]).slice(2),
  ]
  const server = await h.scriptedModelServer({ script })
  const env = { NEXGENT_API_BASE_URL: server.baseUrl, NEXGENT_API_KEY: SCRIPTED_API_KEY, NEXGENT_HOME: home }
  const sdk = createStep5Sdk(pkgs, { env, home, evolve })
  return { root, home, server, sdk, env }
}

/** H03: a task whose check fails counts once. */
async function checkFailurePhase(h, pkgs, work, log) {
  const line = outputFor(FEEDBACK_TASK).split('\n')[1]
  const corrupt = { from: line, to: line.replace(/,[\d.]+$/, ',0.01') }
  const { root, server, sdk } = await singleTaskProject(h, pkgs, work, { corrupt, evolve: { stages: 'pending' } })
  try {
    const { projectId } = await sdk.call('projects.open', { root, create: true })
    const before = await settle(() => readImprovements(pkgs, root), ({ queue }) => queue !== undefined)
    log('checkFailure: a table that passes its test, then is broken before present')
    const { sessionId } = await sdk.call('sessions.create', { projectId, title: 'wrong table' })
    const { result } = await runTurn(sdk, { projectId, sessionId, text: FEEDBACK_TASK.ask })
    const after = await settle(() => readImprovements(pkgs, root), ({ queue }) => (queue?.pending ?? []).some(item => item.kind === 'check-failure'))
    const files = await turnFiles(root, sessionId)
    const checks = files.checks['1']?.record
    const failed = (checks?.results ?? []).filter(result => result.passed === false)
    return {
      reason: result?.reason,
      failedChecks: failed.length,
      queueBefore: (before.queue?.pending ?? []).map(pkgs.kernel.signalKey),
      queueAfter: (after.queue?.pending ?? []).map(pkgs.kernel.signalKey),
      jobs: after.jobs.map(jobView),
    }
  } finally {
    await sdk.dispose()
    await server.close()
  }
}

/** H04: autoImprove off in config.json; feedback recorded, no job. */
async function disabledPhase(h, pkgs, work, log) {
  const project = await runFeedbackProject(h, pkgs, work, {
    log: line => log(`disabled: ${line}`),
    config: { autoImprove: false },
    createSdk: (env, home) => createStep5Sdk(pkgs, { env, home, evolve: { stages: 'pending' } }),
  })
  // Give the background count time to finish, then look.
  await sleep(500)
  const { queue, jobs } = await readImprovements(pkgs, project.root)
  return {
    autoImprove: false,
    submitted: project.feedback.length,
    recorded: project.feedback.filter(f => (project.listing ?? []).some(l => l.id === f.id)).length,
    counted: queue?.counted ?? [],
    jobs: jobs.map(jobView),
  }
}

/** H02: autoImprove off, nothing counted: the explicit start. */
async function explicitPhase(h, pkgs, work, log) {
  const { root, home, server, sdk } = await singleTaskProject(h, pkgs, work, { config: { autoImprove: false }, evolve: { stages: 'pending' } })
  const phase = { autoImprove: false }
  try {
    const { projectId } = await sdk.call('projects.open', { root, create: true })
    const before = await settle(() => readImprovements(pkgs, root), ({ queue }) => queue !== undefined)
    phase.queueBefore = (before.queue?.pending ?? []).map(pkgs.kernel.signalKey)
    log('explicit: improvements.run')
    try {
      const job = await sdk.call('improvements.run', { projectId })
      phase.via = 'sdk'
      phase.job = { trigger: job.trigger, status: job.status, jobId: job.id }
    } catch (error) {
      phase.sdkError = error instanceof Error ? error.message : String(error)
    }
  } finally {
    await sdk.dispose()
    await server.close()
  }
  if (phase.job === undefined) {
    // The SDK refuses: run the plugin host on the same project (what improvements.run will call).
    const host = new pkgs.evolve.ImprovementHost(pkgs.kernel.resolveWorkspaceLayout(root), { entry: (await import('./step5-runtime.mjs')).JOB_ENTRY, env: { STEP5_JOB_STAGES: 'pending', NEXGENT_HOME: home } })
    try {
      const job = await host.run({})
      phase.via = 'host'
      phase.job = { trigger: job.trigger, status: job.status, jobId: job.id }
      await host.settled().catch(() => undefined)
    } catch (error) {
      phase.error = error instanceof Error ? error.message : String(error)
    }
  }
  return phase
}

function runDriver(spec) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [DRIVER, JSON.stringify(spec)], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } })
    let out = ''
    let err = ''
    child.stdout.on('data', chunk => { out += chunk })
    child.stderr.on('data', chunk => { err += chunk })
    child.on('exit', code => {
      const lines = out.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line) } catch { return { type: 'raw', line } } })
      resolve({ pid: child.pid, code, lines, stderr: err.slice(-2000) })
    })
  })
}

/** Kill every job process still named in a job lock under `root` (cleanup; held jobs never end on their own). */
async function killJobProcesses(pkgs, root) {
  const dir = improvementsPath(root)
  for (const name of await readdir(dir).catch(() => [])) {
    const pid = await pkgs.evolve.readLockPid(join(dir, name, 'job.lock')).catch(() => undefined)
    if (typeof pid === 'number' && pkgs.evolve.processAlive(pid)) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch { /* already gone */ }
    }
  }
}

/** H15: concurrent submissions from two processes, one job at a time, kill and recovery. */
async function concurrencyPhase(h, pkgs, work, log) {
  const first = FEEDBACK.find(f => f.key === 'first')
  const project = await runFeedbackProject(h, pkgs, work, {
    feedback: [first],
    log: line => log(`concurrency: ${line}`),
    createSdk: (env, home) => createStep5Sdk(pkgs, { env, home, evolve: { stages: 'hold' } }),
    afterFeedback: async (_entry, { root, id }) => settle(() => readImprovements(pkgs, root), ({ queue }) => (queue?.counted ?? []).includes(`feedback:${id}`)),
  })
  const root = project.root
  const regions = project.deliverables.find(d => d.sessionId === project.tasks.find(t => t.id === 'regions-2026-08')?.sessionId)
  const target = project.deliverable
  const comments = { a: '八月的地区表也少了平均客单价那一列。', b: '九月这张还是缺平均客单价。' }
  const server = await h.scriptedModelServer({
    routes: {
      a: [h.expectRequest('driver a', () => true, { content: 'Noted.', usage: { inputTokens: 40, outputTokens: 4 } })],
      b: [h.expectRequest('driver b', () => true, { content: 'Noted.', usage: { inputTokens: 40, outputTokens: 4 } })],
    },
    routeKey: body => (h.requestText(body).includes(comments.a) ? 'a' : h.requestText(body).includes(comments.b) ? 'b' : undefined),
  })
  const phase = { submitted: [], drivers: [] }
  try {
    const startAt = Date.now() + 4_000
    const base = { root, home: project.home, baseUrl: server.baseUrl, key: SCRIPTED_API_KEY, stages: 'hold', startAt }
    log('concurrency: two processes submit at once')
    const results = await Promise.all([
      runDriver({ ...base, sessionId: regions?.sessionId, deliverableId: regions?.deliverableId, version: regions?.version, rating: 2, comment: comments.a }),
      runDriver({ ...base, sessionId: target?.sessionId, deliverableId: target?.deliverableId, version: target?.version, comment: comments.b }),
    ])
    phase.drivers = results.map(r => ({ code: r.code, done: r.lines.find(l => l.type === 'driver.done'), error: r.lines.find(l => l.type === 'driver.error')?.message ?? (r.code === 0 ? undefined : r.stderr) }))
    phase.submitted = phase.drivers.map(d => d.done?.feedbackId).filter(Boolean)
    // Sample the running jobs for a while: never more than one at once.
    let maxRunning = 0
    let state
    for (let i = 0; i < 40; i += 1) {
      state = await readImprovements(pkgs, root)
      maxRunning = Math.max(maxRunning, state.jobs.filter(job => ['queued', 'diagnosing', 'proposing', 'trialing'].includes(job.status)).length)
      await sleep(50)
    }
    const allIds = [project.feedback[0]?.id, ...phase.submitted]
    phase.queue = (state.queue?.counted ?? []).filter(key => key.startsWith('feedback:')).map(key => key.slice('feedback:'.length))
    phase.jobStarted = state.jobs.length > 0
    phase.jobs = state.jobs.map(jobView)
    phase.maxRunning = maxRunning
    phase.allCounted = allIds.every(id => phase.queue.includes(id))
  } finally {
    await server.close()
  }

  // Recovery: kill the held job's process, then start the SDK again on the project.
  const recovery = {}
  const job = phase.jobs?.[0]
  if (job !== undefined) {
    const dir = join(improvementsPath(root), job.jobId)
    const pid = await settle(() => pkgs.evolve.readLockPid(join(dir, 'job.lock')).catch(() => undefined), value => typeof value === 'number')
    recovery.jobId = job.jobId
    recovery.statusBeforeKill = (await readImprovements(pkgs, root)).jobs.find(j => j.id === job.jobId)?.status
    const versionSdk = await openPlain(h, pkgs, project)
    recovery.adoptedBefore = versionSdk.version
    if (typeof pid === 'number') {
      log(`recovery: kill job process ${pid}`)
      try {
        process.kill(pid, 'SIGKILL')
      } catch (error) {
        recovery.killError = String(error)
      }
      await settle(() => pkgs.evolve.processAlive(pid), alive => !alive, { timeoutMs: 5_000 })
    } else {
      recovery.killError = 'no job process id in job.lock'
    }
    const reopened = await openPlain(h, pkgs, project, { evolve: { stages: 'hold' }, waitFor: async () => (await readImprovements(pkgs, root)).jobs.find(j => j.id === job.jobId)?.status === 'interrupted' })
    recovery.adoptedAfter = reopened.version
    await sleep(1_000)
    const after = (await readImprovements(pkgs, root)).jobs.find(j => j.id === job.jobId)
    recovery.statusAfterRestart = after?.status
    const log1 = await readText(join(dir, 'job.log')) ?? ''
    recovery.starts = (log1.match(new RegExp(`job-entry start ${job.jobId}`, 'g')) ?? []).length
    recovery.reruns = Math.max(0, recovery.starts - 1)
  }
  await killJobProcesses(pkgs, root)
  return { phase, recovery }
}

/** Open the project once (optionally with the evolve row), read the adopted version, optionally wait, close. */
async function openPlain(h, pkgs, project, { evolve = false, waitFor } = {}) {
  const server = await h.scriptedModelServer({ script: [] })
  const sdk = createStep5Sdk(pkgs, { env: { NEXGENT_API_BASE_URL: server.baseUrl, NEXGENT_API_KEY: SCRIPTED_API_KEY, NEXGENT_HOME: project.home }, home: project.home, evolve })
  try {
    const { projectId } = await sdk.call('projects.open', { root: project.root })
    if (waitFor !== undefined) await settle(waitFor, Boolean)
    const current = await sdk.call('capabilities.current', { projectId }).catch(() => undefined)
    return { version: current?.version }
  } finally {
    await sdk.dispose()
    await server.close()
  }
}

/**
 * @param h - the loaded test-support harness.
 * @returns `{ features, project, trigger, turns, concurrency, recovery, errors }`; a phase that
 *   crashes is recorded under `errors.<phase>` and leaves its observations out.
 */
export async function runStep5Headless(h, work, { log = () => undefined } = {}) {
  const loaded = await loadStep5Packages()
  if (!loaded.ok) throw new Error(loaded.reason)
  const pkgs = loaded.pkgs
  const obs = { features: { evolvePackage: evolvePackageBuilt(), evolve: true }, trigger: {}, errors: {} }
  const phase = async (name, run) => {
    try {
      await mkdir(join(work, name), { recursive: true })
      return await run(join(work, name))
    } catch (error) {
      obs.errors[name] = error instanceof Error ? (error.stack ?? error.message) : String(error)
      log(`${name} failed: ${obs.errors[name].split('\n')[0]}`)
      return undefined
    }
  }
  const counting = await phase('counting', dir => countingPhase(h, pkgs, dir, log))
  if (counting !== undefined) {
    obs.project = counting.project
    obs.trigger.counting = counting.steps
    obs.turns = counting.turns
    obs.features.shipped = counting.shipped?.shipped === true
    obs.features.shippedNote = counting.shipped?.reason
  }
  log(`SDK improvements.* ${obs.features.shipped ? 'answers' : `refuses (${obs.features.shippedNote ?? 'not probed'})`}; evolve row inserted by the scenario`)
  obs.trigger.checkFailure = await phase('check-failure', dir => checkFailurePhase(h, pkgs, dir, log))
  obs.trigger.disabled = await phase('disabled', dir => disabledPhase(h, pkgs, dir, log))
  obs.trigger.explicit = await phase('explicit', dir => explicitPhase(h, pkgs, dir, log))
  const concurrency = await phase('concurrency', dir => concurrencyPhase(h, pkgs, dir, log))
  if (concurrency !== undefined) {
    obs.concurrency = concurrency.phase
    obs.recovery = concurrency.recovery
  }
  return obs
}
