/**
 * The step-5 headless scenario (docs/plan/step-5-work-partition.md §`accept-step5`),
 * scripted model server only, through `@nexgent/sdk` as shipped: the SDK installs
 * `@nexgent/evolve` and starts every improvement job through its own improve entry
 * (a detached process that runs the diagnose and propose sessions and the gate, whose
 * replays are processes of their own). One `Step5Model` (step5-model.mjs) answers all
 * of a project's requests, whichever process sends them. Each phase has its own project.
 *
 *   main          the feedback project: after each of the five feedbacks, the queue and the
 *                 jobs (H01); per-turn records (H16). The third counted feedback starts a job
 *                 that runs the 该改进 playbook end to end: diagnosis (H05, H06), proposal in the
 *                 snapshot copy (H07, H08), the gate with the feedback task first and feedback
 *                 checks (H09, H10), adoption; the next task in a new OS process loads the
 *                 adopted skill and the job records its first use (H11); costs by phase (H14);
 *                 config.json untouched (H17); schemas, the test key, the export (H18)
 *   checkFailure  one project, four root tasks (H03; user decision B, PR #111): a table that
 *                 passed its test and was broken before present; a failing test run presented
 *                 anyway; exploratory commands that fail beside a passing test; a test that
 *                 fails, is fixed and passes. The first two count once each, the others not
 *   disabled      the feedback project with autoImprove off: feedback recorded, no job (H04);
 *                 then explicit runs: a diagnosis refused three times (H05), not a capability
 *                 problem (H07), two components (H07); the budget lowered through settings,
 *                 a job that stops on it, a run refused (H14); config.json changes only on
 *                 the settings call (H17)
 *   explicit      autoImprove off, empty queue: `improvements.run` on a deliverable; the
 *                 提案跑不起来 playbook ends without a candidate (H02, H07)
 *   waiting       only the feedback task as history: the job parks waiting-history; two more
 *                 tasks, a restart, the gate runs at the configured size; the reviewer cannot
 *                 tell (null): rejected; the next task runs on the old version (H10, H12, H13)
 *   concurrency   one counted feedback, then two OS processes submit one counted feedback each
 *                 at the same instant: both counted once, one job, held in diagnosis (H15)
 *   recovery      that job's process killed; the next SDK start marks it interrupted, no rerun (H15)
 *
 * The real key may be in this process's environment and the SDK's processes inherit it,
 * so the scenario runs with the scripted key in `process.env` (restored afterwards).
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { countsTowardImprovement, FEEDBACK, judgeRegionTable, MONTHS, ordersCsv, THRESHOLD } from '../real-task/step5-orders.mjs'
import { shellCall } from './scenario-step2.mjs'
import { dataDirSync, registerHome, scanSecrets, strayDataIn } from './data-dir.mjs'
import { filesContaining } from './step2-headless.mjs'
import { CLI_BIN, runTurn } from './step2-runtime.mjs'
import { decisionsOf, trialsOf } from './step4-gate.mjs'
import { activationOf, candidatesOf, ledgerOf, sessionsOf } from './step4-headless.mjs'
import { checkSource, familyTask, FEEDBACK_TASK, HISTORY_TASKS, NEXT_TASK, outputFor, PARKED_STATES, runFeedbackProject, SCRIPTED_API_KEY, TERMINAL_STATES, writeFeedbackProject } from './step5-fixtures.mjs'
import { Step5Model } from './step5-model.mjs'
import { createStep5Sdk, improvementsPath, jobView, loadStep5Packages, pendingFeedback, readImprovements, readJsonFile, scriptedEnvironment } from './step5-runtime.mjs'

const DRIVER = fileURLToPath(new URL('./step5-driver.mjs', import.meta.url))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const errorText = error => (error instanceof Error ? error.message : String(error))
/** How long one job may take to settle (diagnosis, proposal, a gate of 12 replay processes). */
const JOB_WAIT = 240_000
const SETTLED = new Set([...TERMINAL_STATES, ...PARKED_STATES])
const usage = { inputTokens: 40, outputTokens: 12, cacheReadTokens: 0, cacheWriteTokens: 0 }

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

/** Hashes of every file under `dir` (relative paths), skipping top-level names. */
async function treeHashes(dir, skip = []) {
  const out = {}
  const walk = async (current, rel) => {
    for (const entry of await readdir(current, { withFileTypes: true }).catch(() => [])) {
      const path = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (rel === '' && skip.includes(entry.name)) continue
      if (entry.isDirectory()) await walk(join(current, entry.name), path)
      else out[path] = sha(await readFile(join(current, entry.name)))
    }
  }
  await walk(dir, '')
  return out
}

const configHash = async root => sha(await readText(join(root, '.nexgent', 'config.json')))
const deliverablesOf = async (sdk, projectId) => (await sdk.call('deliverables.list', { projectId })).map(d => ({ id: d.deliverableId, versions: (d.versions ?? []).map(v => v.version) }))

/** Per-turn snapshot and check files of the task a session ran (`snapshots/tasks|checks/<taskId>.t<n>.json`). */
async function turnFiles(root, sessionId) {
  const dir = join(dataDirSync(root), 'snapshots')
  const out = { taskId: undefined, tasks: {}, checks: {}, legacy: {} }
  for (const name of await readdir(join(dir, 'tasks')).catch(() => [])) {
    let record
    try {
      record = JSON.parse(await readText(join(dir, 'tasks', name)))
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

/** Whether the SDK as shipped runs the improvement flow: `improvements.list` answers. */
async function shippedProbe(sdk, projectId) {
  try {
    await sdk.call('improvements.list', { projectId })
    return { shipped: true }
  } catch (error) {
    return { shipped: false, reason: errorText(error) }
  }
}

/** Wait until job `jobId` (or the newest job) has a status `done` accepts (default: final or parked). */
async function waitJob(pkgs, root, { jobId, done = status => SETTLED.has(status), timeoutMs = JOB_WAIT } = {}) {
  const pick = jobs => (jobId === undefined ? jobs.at(-1) : jobs.find(job => job.id === jobId))
  const state = await settle(() => readImprovements(pkgs, root), ({ jobs }) => pick(jobs) !== undefined && done(pick(jobs).status), { timeoutMs, intervalMs: 200 })
  const job = pick(state.jobs)
  if (job === undefined || !done(job.status)) throw new Error(`job ${jobId ?? '(newest)'} did not settle within ${timeoutMs / 1000}s (status ${job?.status ?? 'none'})`)
  return job
}

/** The scripted server one model answers (every request of the phase's processes). */
const modelServer = (h, model) => h.scriptedModelServer({ script: Array.from({ length: 5_000 }, () => model.entry) })
const envOf = (server, home) => ({ NEXGENT_API_BASE_URL: server.baseUrl, NEXGENT_API_KEY: SCRIPTED_API_KEY, NEXGENT_HOME: home })

/** Open the project with the SDK as shipped, run `fn(sdk, projectId)`, close. */
async function withSdk(pkgs, root, env, fn) {
  registerHome(root, env.NEXGENT_HOME)
  const sdk = createStep5Sdk(pkgs, { env, home: env.NEXGENT_HOME })
  try {
    const { projectId } = await sdk.call('projects.open', { root, create: true })
    return await fn(sdk, projectId)
  } finally {
    await sdk.dispose()
  }
}

/** One task in a new session of an open SDK. */
async function task(sdk, projectId, entry) {
  const { sessionId } = await sdk.call('sessions.create', { projectId, title: entry.id })
  const { result, error } = await runTurn(sdk, { projectId, sessionId, text: entry.ask })
  return { id: entry.id, sessionId, reason: result?.reason, error: error === undefined ? undefined : String(error) }
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

/**
 * A session's records, checkpoints left out: closing the user's SDK writes a checkpoint (derived
 * state) into every session it had open, so a checkpoint alone is no change by the job.
 */
const recordsHash = records => sha(JSON.stringify(records.filter(record => record.type !== 'checkpoint')))

/** Records of a session whose `turn` is beyond `turns` (a job writing into the user's conversation). */
const recordsAfterTurn = (records, turns) => records.filter(record => typeof record.turn === 'number' && record.turn > turns).length

/**
 * H18 data: schema issues of every record and file the flow wrote; files holding the test key.
 * Since ADR 0012 the user's queue under `home` (`<NEXGENT_HOME>/improvements/queue.json`) is
 * checked too, and every job that pinned an improver is listed with its improverScope.
 */
async function integrity(pkgs, root, home) {
  const { validateSessionRecord, validateLedgerRecord, validateImprovementFile, validateCapabilityFile } = pkgs.session
  const issuesOf = (records, validate, where) => records.flatMap((record, index) => validate(record).map(issue => `${where}#${index + 1} ${record.type ?? ''}: ${issue.path ?? ''} ${issue.message ?? JSON.stringify(issue)}`))
  const sessions = await sessionsOf(root)
  const ledger = await ledgerOf(root)
  const issues = [
    ...Object.entries(sessions).flatMap(([id, records]) => issuesOf(records, validateSessionRecord, `session ${id.slice(0, 8)}`)),
    ...issuesOf(ledger, validateLedgerRecord, 'ledger'),
  ]
  const dir = improvementsPath(root)
  const files = { queue: 0, job: 0, diagnosis: 0, candidate: 0, trialReceipt: 0, decision: 0, userQueue: 0 }
  const scopes = []
  const check = (kind, value, where, validate) => {
    files[kind] += 1
    issues.push(...validate(kind, value).map(issue => `${where}: ${issue.path ?? ''} ${issue.message ?? JSON.stringify(issue)}`))
  }
  const queue = await readJsonFile(join(dir, 'queue.json'))
  if (queue !== undefined) check('queue', queue, 'improvements/queue.json', validateImprovementFile)
  for (const name of await readdir(dir).catch(() => [])) {
    const job = await readJsonFile(join(dir, name, 'job.json'))
    if (job !== undefined) check('job', job, `improvements/${name.slice(0, 8)}/job.json`, validateImprovementFile)
    if (job?.improverVersion !== undefined) scopes.push({ id: job.id, improverScope: job.improverScope })
    const diagnosis = await readJsonFile(join(dir, name, 'diagnosis.json'))
    if (diagnosis !== undefined) check('diagnosis', diagnosis, `improvements/${name.slice(0, 8)}/diagnosis.json`, validateImprovementFile)
  }
  for (const candidate of await candidatesOf(root)) if (candidate.record !== undefined) check('candidate', candidate.record, `candidate ${candidate.id.slice(0, 8)}`, validateCapabilityFile)
  for (const [trialId, receipts] of Object.entries(await trialsOf(root))) for (const receipt of receipts) check('trialReceipt', receipt, `trial ${trialId.slice(0, 8)} ${receipt.type}`, validateCapabilityFile)
  for (const decision of await decisionsOf(root)) check('decision', decision, `decision ${String(decision.id).slice(0, 8)}`, validateCapabilityFile)
  const userQueue = home === undefined ? undefined : await readJsonFile(join(home, 'improvements', 'queue.json'))
  if (userQueue !== undefined) check('userQueue', userQueue, '<home>/improvements/queue.json', validateImprovementFile)
  return { issues, files, scopes, sessions: Object.keys(sessions).length, ledger: ledger.length, secretHits: await scanSecrets(filesContaining, root, home, SCRIPTED_API_KEY), strayInProject: await strayDataIn(root) }
}

// ---- main --------------------------------------------------------------------------------

/**
 * H01, H05–H11, H14, H16–H18: the feedback project; the third counted feedback starts a job
 * that runs the 该改进 playbook through diagnosis, proposal, the gate and adoption; then the
 * next task in a new process.
 */
async function mainPhase(h, pkgs, work, log) {
  const root = join(work, 'project')
  const model = new Step5Model(h, { root, playbooks: ['improve'] })
  const server = await modelServer(h, model)
  const out = {}
  try {
    const project = await runFeedbackProject(h, pkgs, work, {
      server,
      log: line => log(`main: ${line}`),
      createSdk: (env, home) => createStep5Sdk(pkgs, { env, home }),
      async beforeFeedback({ sdk, projectId, root: at, feedbackSession }) {
        out.shipped = await shippedProbe(sdk, projectId)
        return {
          files: await turnFiles(at, feedbackSession),
          tree: await treeHashes(at, ['.nexgent']),
          sessions: Object.fromEntries(Object.entries(await sessionsOf(at)).map(([id, records]) => [id, recordsHash(records)])),
          deliverables: await deliverablesOf(sdk, projectId),
          config: await configHash(at),
        }
      },
      async afterFeedback(entry, { root: at, id }) {
        // Wait for evolve's background count (and, at the threshold, the job); an uncounted
        // feedback leaves nothing to wait for, so it gets a short look only.
        const counts = countsTowardImprovement(entry)
        const state = await settle(() => readImprovements(pkgs, at), ({ queue, jobs }) => {
          if (!counts) return false
          const keys = (queue?.counted ?? []).filter(key => key.startsWith('feedback:'))
          return keys.includes(`feedback:${id}`) && (keys.length < THRESHOLD || jobs.length > 0)
        }, { timeoutMs: counts ? 10_000 : 600 })
        if (state.jobs.length > 0) model.phase = 'job'
        return { queue: pendingFeedback(state.queue), counted: state.queue?.counted ?? [], jobs: state.jobs.map(jobView) }
      },
    })
    out.project = project
    const feedbackSession = project.tasks.at(-1)?.sessionId
    out.steps = project.feedback.map(f => ({ key: f.key, rating: f.rating, comment: f.comment, feedbackId: f.id, queue: f.observed?.queue ?? [], counted: f.observed?.counted ?? [], jobs: f.observed?.jobs ?? [] }))
    out.turns = { taskId: undefined, before: project.before?.files, feedbackTurns: project.feedback.length }

    log('main: waiting for the job (diagnose, propose, gate)')
    const job = await waitJob(pkgs, root)
    model.phase = 'after'
    const after = await turnFiles(root, feedbackSession)
    out.turns.taskId = after.taskId
    out.turns.after = after
    out.feedbackTaskId = after.taskId
    out.job = jobView(job)
    out.jobs = (await readImprovements(pkgs, root)).jobs.map(jobView)
    const sessions = await sessionsOf(root)
    const before = project.before ?? {}
    out.isolation = {
      treeBefore: before.tree,
      treeAfter: await treeHashes(root, ['.nexgent']),
      // Sessions that existed before the feedback, the feedback session aside (its feedback turns are the user's).
      sessionsChanged: Object.entries(before.sessions ?? {}).filter(([id, hash]) => id !== feedbackSession && recordsHash(sessions[id] ?? []) !== hash).map(([id]) => id),
      sessionsBefore: Object.keys(before.sessions ?? {}).length,
      feedbackSessionExtra: recordsAfterTurn(sessions[feedbackSession] ?? [], 1 + project.feedback.length),
      deliverablesBefore: before.deliverables,
      newSessions: Object.keys(sessions).filter(id => !(id in (before.sessions ?? {}))),
      configBefore: before.config,
    }
    out.requests = model.requests
    out.diagnoseSessions = model.diagnoseSessions
    out.feedbackChecks = model.feedbackChecks
    out.feedbackSession = feedbackSession
    out.taskSessions = project.tasks.map(t => ({ id: t.id, sessionId: t.sessionId }))

    await withSdk(pkgs, root, envOf(server, project.home), async (sdk, projectId) => {
      out.isolation.deliverablesAfter = await deliverablesOf(sdk, projectId)
      out.listedSessions = (await sdk.call('sessions.list', { projectId })).map(s => s.sessionId)
      out.resume = {}
      for (const [phase, sessionId] of Object.entries(job.sessions ?? {})) {
        out.resume[phase] = await sdk.openSession({ projectId, sessionId }).then(() => ({ opened: true }), error => ({ code: error?.code, message: errorText(error) }))
      }
      out.detail = await sdk.call('improvements.show', { projectId, jobId: job.id }).catch(error => ({ error: errorText(error) }))
      out.listing = await sdk.call('improvements.list', { projectId }).catch(error => ({ error: errorText(error) }))
      out.current = await sdk.call('capabilities.current', { projectId }).catch(() => undefined)
    })
    out.diagnosis = await readJsonFile(join(improvementsPath(root), job.id, 'diagnosis.json'))
    // Every record the diagnosis cites, looked up in the project's sessions.
    out.evidence = (out.diagnosis?.failureTypes ?? []).flatMap(failure => failure.evidence ?? []).map((ref) => {
      const record = (sessions[ref.sessionId] ?? []).find(item => item.seq === ref.seq)
      return { ...ref, found: record !== undefined, type: record?.type, turnMatches: ref.turn === undefined || record?.turn === ref.turn }
    })
    out.decisions = await decisionsOf(root)
    out.trials = await trialsOf(root)
    out.activation = await activationOf(root)

    // H11: the next task, in a process that never saw the trial.
    log('main: the next task in a new process')
    model.phase = 'next'
    const child = await runDriver({ mode: 'task', root, home: project.home, baseUrl: server.baseUrl, key: SCRIPTED_API_KEY, title: NEXT_TASK.id, text: NEXT_TASK.ask })
    const done = child.lines.find(line => line.type === 'driver.done')
    out.next = {
      pid: child.pid,
      parentPid: process.pid,
      code: child.code,
      sessionId: done?.sessionId,
      version: done?.version,
      reason: done?.reason,
      error: done?.error ?? child.lines.find(line => line.type === 'driver.error')?.message ?? (child.code === 0 ? undefined : child.stderr),
      output: await readText(join(root, NEXT_TASK.output)) ?? null,
      requests: model.requests.filter(r => r.phase === 'next' && r.task === NEXT_TASK.id),
    }
    out.next.judged = out.next.output === null ? undefined : judgeRegionTable(ordersCsv(NEXT_TASK.month), out.next.output)
    // evolve records the first use when a host starts (or a turn starts) after the task.
    await withSdk(pkgs, root, envOf(server, project.home), async () => {
      await settle(async () => (await readImprovements(pkgs, root)).jobs.find(j => j.id === job.id)?.firstUse, Boolean, { timeoutMs: 10_000, intervalMs: 100 })
    })
    out.firstUse = (await readImprovements(pkgs, root)).jobs.find(j => j.id === job.id)?.firstUse
    out.ledger = await ledgerOf(root)
    out.configAfter = await configHash(root)
    out.integrity = await integrity(pkgs, root, project.home)

    // H18: the export of the feedback task carries no key.
    const exportDir = join(work, 'export')
    const cli = h.spawnNode([CLI_BIN, 'export', feedbackSession, '--project', root, '--out', exportDir, '--json'], { cwd: work, env: { NEXGENT_HOME: project.home, NEXGENT_API_KEY: SCRIPTED_API_KEY } })
    const cliExit = await cli.exit
    out.export = { code: cliExit.code, stderr: cliExit.stderr.slice(0, 2000), files: (await readdir(exportDir).catch(() => [])).sort(), secretHits: await filesContaining(exportDir, SCRIPTED_API_KEY, work) }
  } finally {
    await server.close()
  }
  return out
}

// ---- check failures -----------------------------------------------------------------------

const breakLine = (entry) => {
  const line = outputFor(entry).split('\n')[1]
  return { from: line, to: line.replace(/,[\d.]+$/, ',0.01') }
}
const wrongTable = entry => outputFor(entry).replace(breakLine(entry).from, breakLine(entry).to)
/** Exploratory commands that fail: a missing file, a checker run without its arguments (exit 2). Neither is a test command. */
export const EXPLORE = { bash: 'cat data/missing-export.csv', pwsh: 'Get-Content data/missing-export.csv' }
export const USAGE_LINE = 'node checks/regions-verify.mjs'

/**
 * The four root tasks of the check-failure phase, as script entries (one queue, in order):
 *   corrupt   test passes, then a str_replace breaks a value, present: the re-run fails
 *   failing   a wrong table, an exploratory command that fails, the test fails, present anyway
 *             (the two automatic check retries get a reply each; the test still fails)
 *   explore   the right table, two failing commands that are not tests, the test passes
 *   fixed     a wrong table, the test fails, str_replace fixes it, the test passes
 */
function checkFailureScript(h, tasks) {
  const entries = []
  const call = (key, entry, label, toolCalls) => entries.push(h.expectRequest(`${key}: ${label}`, body => h.requestText(body).includes(entry.ask), { toolCalls, usage }))
  const say = (key, entry, content) => entries.push(h.expectRequest(`${key}: done`, body => h.requestText(body).includes(entry.ask), { content, usage }))
  const test = entry => [shellCall({ bash: entry.checkCommand, pwsh: entry.checkCommand })]
  const present = entry => [{ name: 'present', arguments: { paths: [entry.output], summary: `regions for ${entry.month}` } }]
  const write = (entry, content) => [{ name: 'write_file', arguments: { path: entry.output, content } }]
  const replace = (entry, from, to) => [{ name: 'str_replace', arguments: { path: entry.output, old_str: from, new_str: to } }]
  const { corrupt, failing, explore, fixed } = tasks
  call('corrupt', corrupt, 'write', write(corrupt, outputFor(corrupt)))
  call('corrupt', corrupt, 'test', test(corrupt))
  call('corrupt', corrupt, 'break', replace(corrupt, breakLine(corrupt).from, breakLine(corrupt).to))
  call('corrupt', corrupt, 'present', present(corrupt))
  say('corrupt', corrupt, 'Presented.')
  call('failing', failing, 'write', write(failing, wrongTable(failing)))
  call('failing', failing, 'explore', [shellCall(EXPLORE)])
  call('failing', failing, 'test', test(failing))
  call('failing', failing, 'present', present(failing))
  say('failing', failing, 'Presented; the test still fails.')
  // Redesign 3.2: the failing test of this turn sends the model back twice; it cannot fix it.
  say('failing', failing, 'The test still fails; the table cannot be fixed from this data.')
  say('failing', failing, 'Still failing; stopping here.')
  call('explore', explore, 'write', write(explore, outputFor(explore)))
  call('explore', explore, 'explore', [shellCall(EXPLORE)])
  call('explore', explore, 'usage', [shellCall({ bash: USAGE_LINE, pwsh: USAGE_LINE })])
  call('explore', explore, 'test', test(explore))
  call('explore', explore, 'present', present(explore))
  say('explore', explore, 'Presented.')
  call('fixed', fixed, 'write', write(fixed, wrongTable(fixed)))
  call('fixed', fixed, 'test', test(fixed))
  call('fixed', fixed, 'fix', replace(fixed, breakLine(fixed).to, breakLine(fixed).from))
  call('fixed', fixed, 'retest', test(fixed))
  call('fixed', fixed, 'present', present(fixed))
  say('fixed', fixed, 'Presented.')
  return entries
}

/** H03: which root tasks count as a check failure (one count each; exploratory failures never). */
async function checkFailurePhase(h, pkgs, work, log) {
  const root = join(work, 'project')
  const home = join(work, 'home')
  await mkdir(root, { recursive: true })
  await writeFeedbackProject(root)
  const extra = familyTask('regions-2026-11', 'regions', MONTHS.second)
  await writeFile(join(root, extra.input), ordersCsv(extra.month))
  await writeFile(join(root, `checks/${extra.id}.test.mjs`), checkSource(extra))
  const tasks = { corrupt: FEEDBACK_TASK, failing: NEXT_TASK, explore: HISTORY_TASKS[2], fixed: extra }
  const server = await h.scriptedModelServer({ script: checkFailureScript(h, tasks) })
  const out = { runs: {} }
  try {
    await withSdk(pkgs, root, envOf(server, home), async (sdk, projectId) => {
      out.queueBefore = ((await settle(() => readImprovements(pkgs, root), ({ queue }) => queue !== undefined)).queue?.pending ?? []).map(pkgs.kernel.signalKey)
      for (const [key, entry] of Object.entries(tasks)) {
        log(`check-failure: ${key}`)
        const before = ((await readImprovements(pkgs, root)).queue?.pending ?? []).map(pkgs.kernel.signalKey)
        const run = await task(sdk, projectId, entry)
        const files = await turnFiles(root, run.sessionId)
        const expectSignal = key === 'corrupt' || key === 'failing'
        const state = await settle(() => readImprovements(pkgs, root), ({ queue }) => {
          const keys = (queue?.pending ?? []).map(pkgs.kernel.signalKey)
          return expectSignal && keys.length > before.length
        }, { timeoutMs: expectSignal ? 10_000 : 1_000 })
        const after = (state.queue?.pending ?? []).map(pkgs.kernel.signalKey)
        const checks = files.checks['1']?.record
        out.runs[key] = {
          reason: run.reason?.kind ?? run.error,
          taskId: files.taskId,
          specs: (checks?.specs ?? []).map(spec => ({ name: spec.name, kind: spec.kind, command: spec.command ?? spec.target })),
          results: (checks?.results ?? []).map(result => ({ name: result.name, passed: result.passed, exitCode: result.exitCode })),
          added: after.filter(k => !before.includes(k)),
          output: await readText(join(root, entry.output)) ?? null,
        }
      }
      const end = await readImprovements(pkgs, root)
      out.queueAfter = (end.queue?.pending ?? []).map(pkgs.kernel.signalKey)
      out.jobs = end.jobs.map(jobView)
    })
  } finally {
    await server.close()
  }
  out.failedChecks = out.runs.corrupt?.results?.filter(r => r.passed === false).length ?? 0
  return out
}

// ---- disabled, then explicit runs ---------------------------------------------------------

/** Start an explicit job and wait for it; a refusal is recorded as `{ code, error }`. */
async function explicitRun(pkgs, sdk, root, projectId, input) {
  let started
  try {
    started = await sdk.call('improvements.run', { projectId, ...input })
  } catch (error) {
    return { code: error?.code, error: errorText(error) }
  }
  const job = await waitJob(pkgs, root, { jobId: started.id })
  return { started: { trigger: started.trigger, status: started.status }, job: jobView(job), diagnosis: await readJsonFile(join(improvementsPath(root), job.id, 'diagnosis.json')) }
}

/** H04, then H05 (refused three times), H07 (none, two components), H14 (budget), H17 (settings only). */
async function disabledPhase(h, pkgs, work, log) {
  const root = join(work, 'project')
  const model = new Step5Model(h, { root, playbooks: ['invalid', 'not-capability', 'two', 'improve'] })
  const server = await modelServer(h, model)
  const out = { autoImprove: false }
  try {
    const project = await runFeedbackProject(h, pkgs, work, {
      server,
      log: line => log(`disabled: ${line}`),
      // K1: task snapshots are taken only while the project learns; automatic jobs stay off through autoImprove.
      config: { autoImprove: false, learning: { enabled: true } },
      createSdk: (env, home) => createStep5Sdk(pkgs, { env, home }),
    })
    // Give the background count time to finish, then look.
    await sleep(500)
    const { queue, jobs } = await readImprovements(pkgs, root)
    out.submitted = project.feedback.length
    out.recorded = project.feedback.filter(f => (project.listing ?? []).some(l => l.id === f.id)).length
    out.counted = queue?.counted ?? []
    out.jobs = jobs.map(jobView)
    const feedbackSession = project.tasks.at(-1)?.sessionId
    const candidatesBefore = (await candidatesOf(root)).length
    out.config = { start: await configHash(root) }
    model.phase = 'job'
    await withSdk(pkgs, root, envOf(server, project.home), async (sdk, projectId) => {
      log('disabled: explicit runs (refused diagnosis, not a capability, two components)')
      out.invalid = await explicitRun(pkgs, sdk, root, projectId, { sessionId: feedbackSession })
      out.none = await explicitRun(pkgs, sdk, root, projectId, { sessionId: feedbackSession })
      out.two = await explicitRun(pkgs, sdk, root, projectId, { sessionId: feedbackSession })
      out.config.afterJobs = await configHash(root)
      out.candidatesAdded = (await candidatesOf(root)).length - candidatesBefore
      // Lower the budget through settings to just above what the window has spent.
      const used = (await sdk.call('improvements.list', { projectId })).budget.usedTokens
      const settings = await sdk.call('settings.get', { projectId })
      out.budget = { used, limit: used + 50 }
      log(`disabled: budget lowered to ${out.budget.limit} tokens`)
      const updated = await sdk.call('settings.update', { projectId, patch: { improvement: { ...settings.improvement, budget: { ...settings.improvement.budget, maxTokens: out.budget.limit } } } })
      out.budget.settingsLimit = updated.improvement?.budget?.maxTokens
      out.config.afterSettings = await configHash(root)
      out.configFile = await readJsonFile(join(root, '.nexgent', 'config.json'))
      out.stopped = await explicitRun(pkgs, sdk, root, projectId, { sessionId: feedbackSession })
      out.refused = await explicitRun(pkgs, sdk, root, projectId, { sessionId: feedbackSession })
      out.config.end = await configHash(root)
      out.listing = await sdk.call('improvements.list', { projectId }).catch(error => ({ error: errorText(error) }))
    })
    out.diagnoseSessions = model.diagnoseSessions.map(s => s.playbook)
    out.ledger = (await ledgerOf(root)).filter(r => r.type === 'llm.request.end' && r.improvementId !== undefined).map(r => ({ improvementId: r.improvementId, improvementPhase: r.improvementPhase }))
  } finally {
    await server.close()
  }
  return out
}

// ---- explicit -----------------------------------------------------------------------------

/** H02 (and H07's 提案跑不起来): autoImprove off, empty queue, `improvements.run` on a deliverable. */
async function explicitPhase(h, pkgs, work, log) {
  const root = join(work, 'project')
  const home = join(work, 'home')
  await mkdir(join(root, '.nexgent'), { recursive: true })
  await writeFeedbackProject(root)
  await writeFile(join(root, '.nexgent', 'config.json'), `${JSON.stringify({ autoImprove: false })}\n`)
  const model = new Step5Model(h, { root, playbooks: ['broken'] })
  const server = await modelServer(h, model)
  const out = { autoImprove: false }
  try {
    await withSdk(pkgs, root, envOf(server, home), async (sdk, projectId) => {
      const run = await task(sdk, projectId, FEEDBACK_TASK)
      const deliverable = (await sdk.call('deliverables.list', { projectId })).find(d => d.versions?.at(-1)?.sessionId === run.sessionId)
      const before = await settle(() => readImprovements(pkgs, root), ({ queue }) => queue !== undefined)
      out.queueBefore = (before.queue?.pending ?? []).map(pkgs.kernel.signalKey)
      out.jobsBefore = before.jobs.length
      log('explicit: improvements.run on the deliverable')
      model.phase = 'job'
      const result = await explicitRun(pkgs, sdk, root, projectId, { sessionId: run.sessionId, deliverableId: deliverable?.deliverableId })
      out.via = result.error === undefined ? 'sdk' : undefined
      out.error = result.error
      out.job = result.job === undefined ? undefined : { ...result.job, startedAs: result.started }
      out.diagnosis = result.diagnosis
      out.candidates = (await candidatesOf(root)).filter(c => c.record?.error === undefined).length
      out.proposeRequests = model.requests.filter(r => r.kind === 'propose').length
    })
  } finally {
    await server.close()
  }
  return out
}

// ---- waiting history ----------------------------------------------------------------------

/** H13, H12, H10 (unknown): too little history, then enough; the reviewer cannot tell; rejected. */
async function waitingPhase(h, pkgs, work, log) {
  const root = join(work, 'project')
  const model = new Step5Model(h, { root, playbooks: ['improve'], feedbackAnswer: 'null' })
  const server = await modelServer(h, model)
  const out = {}
  try {
    const project = await runFeedbackProject(h, pkgs, work, {
      server,
      tasks: [FEEDBACK_TASK],
      log: line => log(`waiting: ${line}`),
      createSdk: (env, home) => createStep5Sdk(pkgs, { env, home }),
    })
    model.phase = 'job'
    const parked = await waitJob(pkgs, root)
    out.parked = { ...jobView(parked), trials: Object.keys(await trialsOf(root)).length, candidate: parked.candidateId !== undefined && (await candidatesOf(root)).some(c => c.id === parked.candidateId) }
    log(`waiting: job ${parked.status}; two more history tasks`)
    model.phase = 'main'
    const env = envOf(server, project.home)
    out.history = await withSdk(pkgs, root, env, async (sdk, projectId) => [await task(sdk, projectId, HISTORY_TASKS[2]), await task(sdk, projectId, HISTORY_TASKS[0])])
    out.statusAfterHistory = (await readImprovements(pkgs, root)).jobs.find(j => j.id === parked.id)?.status
    // A restart (the host's start) resumes the parked job once the history is there.
    model.phase = 'job'
    log('waiting: restart; the gate runs')
    await withSdk(pkgs, root, env, async () => {
      await settle(async () => (await readImprovements(pkgs, root)).jobs.find(j => j.id === parked.id)?.status, status => status !== 'waiting-history', { timeoutMs: 15_000, intervalMs: 100 })
    })
    const job = await waitJob(pkgs, root, { jobId: parked.id, done: status => TERMINAL_STATES.includes(status) })
    out.job = jobView(job)
    out.trials = await trialsOf(root)
    out.decisions = await decisionsOf(root)
    out.feedbackChecks = model.feedbackChecks
    out.diagnoseSessions = model.diagnoseSessions.length
    model.phase = 'after'
    out.after = await withSdk(pkgs, root, env, async (sdk, projectId) => {
      const current = await sdk.call('capabilities.current', { projectId }).catch(() => undefined)
      const run = await task(sdk, projectId, NEXT_TASK)
      const show = job.candidateId === undefined ? undefined : await sdk.call('capabilities.show', { projectId, candidateId: job.candidateId }).catch(error => ({ error: errorText(error) }))
      return { version: current?.version, reason: run.reason?.kind ?? run.error, output: await readText(join(root, NEXT_TASK.output)) ?? null, candidate: show?.view, receipts: (show?.receipts ?? []).map(r => r.type) }
    })
    out.after.judged = out.after.output === null ? undefined : judgeRegionTable(ordersCsv(NEXT_TASK.month), out.after.output)
    out.activation = await activationOf(root)
  } finally {
    await server.close()
  }
  return out
}

// ---- concurrency and recovery -------------------------------------------------------------

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

/** H15: concurrent submissions from two processes, one job at a time, kill and recovery. */
async function concurrencyPhase(h, pkgs, work, log) {
  const root = join(work, 'project')
  // The job's diagnosis request never returns: it stays diagnosing until its process is killed.
  const model = new Step5Model(h, { root, playbooks: ['stall'] })
  const server = await modelServer(h, model)
  const phase = { submitted: [], drivers: [] }
  const recovery = {}
  try {
    const first = FEEDBACK.find(f => f.key === 'first')
    const project = await runFeedbackProject(h, pkgs, work, {
      server,
      feedback: [first],
      log: line => log(`concurrency: ${line}`),
      createSdk: (env, home) => createStep5Sdk(pkgs, { env, home }),
      afterFeedback: async (_entry, { root: at, id }) => settle(() => readImprovements(pkgs, at), ({ queue }) => (queue?.counted ?? []).includes(`feedback:${id}`)),
    })
    const regions = project.deliverables.find(d => d.sessionId === project.tasks.find(t => t.id === 'regions-2026-08')?.sessionId)
    const target = project.deliverable
    const comments = { a: '八月的地区表也少了平均客单价那一列。', b: '九月这张还是缺平均客单价。' }
    const startAt = Date.now() + 4_000
    const base = { mode: 'feedback', root, home: project.home, baseUrl: server.baseUrl, key: SCRIPTED_API_KEY, startAt }
    log('concurrency: two processes submit at once')
    const results = await Promise.all([
      runDriver({ ...base, sessionId: regions?.sessionId, deliverableId: regions?.deliverableId, version: regions?.version, rating: 2, comment: comments.a }),
      runDriver({ ...base, sessionId: target?.sessionId, deliverableId: target?.deliverableId, version: target?.version, comment: comments.b }),
    ])
    phase.drivers = results.map(r => ({ code: r.code, done: r.lines.find(l => l.type === 'driver.done'), error: r.lines.find(l => l.type === 'driver.error')?.message ?? (r.code === 0 ? undefined : r.stderr) }))
    phase.submitted = phase.drivers.map(d => d.done?.feedbackId).filter(Boolean)
    // Sample the running jobs for a while: never more than one at once.
    let maxRunning = 0
    let state = await readImprovements(pkgs, root)
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

    // Recovery: kill the held job's process (the server keeps its request hanging), then start the SDK again.
    const job = phase.jobs[0]
    if (job !== undefined) {
      const dir = join(improvementsPath(root), job.jobId)
      await settle(async () => (await readImprovements(pkgs, root)).jobs.find(j => j.id === job.jobId)?.status, status => status === 'diagnosing', { timeoutMs: 15_000, intervalMs: 50 })
      const pid = await settle(() => pkgs.evolve.readLockPid(join(dir, 'job.lock')).catch(() => undefined), value => typeof value === 'number')
      recovery.jobId = job.jobId
      recovery.statusBeforeKill = (await readImprovements(pkgs, root)).jobs.find(j => j.id === job.jobId)?.status
      recovery.adoptedBefore = (await activationOf(root)).at(-1)?.version ?? 'baseline'
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
      await withSdk(pkgs, root, envOf(server, project.home), async () => {
        await settle(async () => (await readImprovements(pkgs, root)).jobs.find(j => j.id === job.jobId)?.status, status => status === 'interrupted', { timeoutMs: 10_000, intervalMs: 50 })
        await sleep(1_000)
      })
      recovery.adoptedAfter = (await activationOf(root)).at(-1)?.version ?? 'baseline'
      const after = await readImprovements(pkgs, root)
      recovery.statusAfterRestart = after.jobs.find(j => j.id === job.jobId)?.status
      recovery.jobsAfterRestart = after.jobs.length
      const text = await readText(join(dir, 'job.log')) ?? ''
      recovery.starts = (text.match(new RegExp(`improve-entry start ${job.jobId}`, 'g')) ?? []).length
      recovery.reruns = Math.max(0, recovery.starts - 1)
      recovery.diagnoseRequests = model.requests.filter(r => r.kind === 'diagnose').length
    }
  } finally {
    await killJobProcesses(pkgs, root)
    await server.close()
  }
  return { phase, recovery }
}

/**
 * @param h - the loaded test-support harness.
 * @returns `{ features, project, trigger, turns, main, disabled, waiting, concurrency, recovery, errors }`;
 *   a phase that crashes is recorded under `errors.<phase>` and leaves its observations out.
 */
export async function runStep5Headless(h, work, { log = () => undefined } = {}) {
  const loaded = await loadStep5Packages()
  if (!loaded.ok) throw new Error(loaded.reason)
  const pkgs = loaded.pkgs
  const obs = { features: { evolvePackage: evolvePackageBuilt() }, trigger: {}, errors: {} }
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
  const restore = scriptedEnvironment(SCRIPTED_API_KEY)
  try {
    const main = await phase('main', dir => mainPhase(h, pkgs, dir, log))
    if (main !== undefined) {
      const { project, steps, turns, shipped, ...rest } = main
      obs.project = project
      obs.trigger.counting = steps
      obs.turns = turns
      obs.features.shipped = shipped?.shipped === true
      obs.features.shippedNote = shipped?.reason
      obs.main = rest
    }
    log(`SDK improvements.* ${obs.features.shipped ? 'answers' : `refuses (${obs.features.shippedNote ?? 'not probed'})`}`)
    obs.trigger.checkFailure = await phase('check-failure', dir => checkFailurePhase(h, pkgs, dir, log))
    obs.disabled = await phase('disabled', dir => disabledPhase(h, pkgs, dir, log))
    if (obs.disabled !== undefined) obs.trigger.disabled = { autoImprove: false, submitted: obs.disabled.submitted, recorded: obs.disabled.recorded, counted: obs.disabled.counted, jobs: obs.disabled.jobs }
    obs.trigger.explicit = await phase('explicit', dir => explicitPhase(h, pkgs, dir, log))
    obs.waiting = await phase('waiting', dir => waitingPhase(h, pkgs, dir, log))
    const concurrency = await phase('concurrency', dir => concurrencyPhase(h, pkgs, dir, log))
    if (concurrency !== undefined) {
      obs.concurrency = concurrency.phase
      obs.recovery = concurrency.recovery
    }
  } finally {
    restore()
  }
  return obs
}
