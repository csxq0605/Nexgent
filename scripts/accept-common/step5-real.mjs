/**
 * The real-model layer of accept-step5 (R01–R07, docs/plan/step-5-work-partition.md
 * §真实模型验收): the monthly region-table family (scripts/real-task/step5-orders.mjs)
 * in one project, driven through `@nexgent/sdk` as shipped against the real Claude
 * API (thinking on). The improvement job, its gate and their replays are the SDK's
 * own processes; they inherit this process's environment, so they read the key the
 * same way. Neither the task asks nor the feedback name a capability tool.
 *
 *   R01 history    two monthly summaries and one region table, each with its test command
 *   R02 feedback   a region table (the ask names three columns), then the five feedback
 *                  entries of FEEDBACK on its deliverable: three counted, naming the column
 *                  only the user's convention has
 *   R03 job        the third counted feedback starts the job by itself: diagnosis, proposal
 *   R04 gate       the job's gate, whatever it concludes (adopted, rejected or waiting)
 *   R05 next       a new month in a new OS process, no hint of a component; the hidden judge
 *                  checks the column the feedback named (only when the gate adopted)
 *   R06 costs      requests, tokens, unknown counts and estimated cost per task, per feedback
 *                  turn and per job phase; the improvement apart; the total under the cap
 *   R07 second     (not in the threshold) another table task and SECOND_FEEDBACK (another
 *                  missing column): a second job, its conclusion, jobs / adoptions
 *
 * Before each step the estimated spend so far (from the project's ledger) plus that step's
 * reserve must stay under the cap, or the scenario stops. A task that did not complete stops
 * it too: later steps would prove nothing. The key is never logged or written.
 */
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { judgeSummary } from '../real-task/step4-orders.mjs'
import { countsTowardImprovement, FEEDBACK, judgeRegionTable, MONTHS, ordersCsv, SECOND_FEEDBACK } from '../real-task/step5-orders.mjs'
import { runTurn } from './step2-runtime.mjs'
import { REAL_MODEL } from './step5-checks.mjs'
import { checkSource, familyTask, FEEDBACK_TASK, HISTORY_TASKS, NEXT_TASK, writeFeedbackProject } from './step5-fixtures.mjs'
import { decisionsOf, editConfig, trialsOf } from './step4-gate.mjs'
import { activationOf, candidatesOf, filesUnder, ledgerOf, sessionsOf } from './step4-headless.mjs'
import { usageOf } from './step4-real.mjs'
import { jobView, loadStep5Packages, readImprovements, readJsonFile } from './step5-runtime.mjs'

const DRIVER = fileURLToPath(new URL('./step5-real-driver.mjs', import.meta.url))

/** Per-task caps of the project (permissions.md §费用上限). */
export const TASK_CAPS = { maxRequests: 80, maxTokens: 2_000_000 }
/** The gate's trial budget (`capabilities.trialBudget`), as in step 4. */
export const TRIAL_BUDGET = { maxRequests: 240, maxTokens: 2_000_000 }
/**
 * The improvement budget the script sets (plan §真实模型验收: the script sets it). Two jobs
 * must fit in one window; the 15 USD cap is enforced by the reserves below, not by this.
 */
export const IMPROVEMENT = { feedbackThreshold: 3, budget: { maxTokens: 12_000_000, windowDays: 30 }, model: REAL_MODEL.model, thinking: REAL_MODEL.thinking }
/** Estimated USD set aside before each step; a step starts only when spent + reserve stays under the cap. */
export const RESERVE = { task: 0.6, feedback: 0.3, job: 4 }
/** R07's table task: same kind, another month. */
export const SECOND_TASK = familyTask('regions-2026-11', 'regions', MONTHS.second)
/** Job states that end the wait: final, or parked. */
export const SETTLED = new Set(['adopted', 'rejected', 'no-proposal', 'budget-exhausted', 'failed', 'interrupted', 'cancelled', 'waiting-history', 'awaiting-approval'])

/** A ledger record written during a turn's wall-clock window (llm records carry no turn number). */
const within = (record, window) => window !== undefined && typeof record.ts === 'string' && record.ts >= window.from && record.ts <= window.to
const errorText = error => (error instanceof Error ? error.message : String(error))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

class StopScenario extends Error {}

function slim(event) {
  switch (event.type) {
    case 'tool.start': return { type: event.type, turn: event.turn, name: event.call.name, arguments: String(JSON.stringify(event.call.arguments)).slice(0, 600) }
    case 'tool.result': return { type: event.type, turn: event.turn, name: event.result.name, isError: event.result.isError, content: String(event.result.content).slice(0, 300) }
    case 'turn.end': return { type: event.type, turn: event.turn, reason: event.reason }
    case 'error': return { type: event.type, error: event.error }
    default: return undefined
  }
}

/**
 * Hidden check of a task's output from the orders it was made from. A region table must
 * have the three asked columns right; `convention` says whether the column only the
 * feedback names is there and right (judgeRegionTable).
 */
export function hiddenCheck(task, text) {
  if (text === null || text === undefined) return { pass: false, base: false, problems: [`${task.output} was not written`] }
  if (task.kind === 'regions') {
    const judged = judgeRegionTable(ordersCsv(task.month), text)
    return { pass: judged.pass, base: judged.pass || judged.missingConvention, missingConvention: judged.missingConvention, problems: judged.problems }
  }
  const judged = judgeSummary(ordersCsv(task.month), text)
  return { ...judged, base: judged.pass }
}

/** One turn in a child OS process; the child reads the key from its inherited environment. */
function turnInChild(spec) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [DRIVER, JSON.stringify(spec)], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000) })
    child.on('close', (code) => {
      const lines = stdout.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line) } catch { return { raw: line } } })
      resolve({ pid: child.pid, exitCode: code, done: lines.find(line => line.type === 'driver.done'), error: lines.find(line => line.type === 'driver.error')?.message, events: lines.filter(line => line.type === 'tool.start' || line.type === 'tool.result' || line.type === 'driver.timeout'), stderr: stderr.slice(-1500) })
    })
  })
}

/** The usage of the ledger records an improvement job wrote, per phase and in all. */
export function jobUsage(ledger, jobId) {
  const mine = ledger.filter(r => r.improvementId === jobId)
  const phases = [...new Set(mine.map(r => r.improvementPhase).filter(Boolean))]
  return { phases: Object.fromEntries(phases.map(phase => [phase, usageOf(mine.filter(r => r.improvementPhase === phase))])), total: usageOf(mine) }
}

/**
 * Run R01–R05 and R07 once (R06 is read from what they spent).
 * @param options - `env` (NEXGENT_API_KEY, optional NEXGENT_API_BASE_URL), `realModel`, `budgetUsd`,
 *   `spent`, `turnTimeoutMs`, `jobTimeoutMs`, `log`, `second` (run R07; default true).
 */
export async function runRealScenario(h, work, { env, realModel, budgetUsd = REAL_MODEL.budgetUsd, spent = [], turnTimeoutMs = 30 * 60_000, jobTimeoutMs = 150 * 60_000, log = () => {}, second = true }) {
  const loaded = await loadStep5Packages()
  if (!loaded.ok) throw new Error(loaded.reason)
  const pkgs = loaded.pkgs
  const root = join(work, 'project')
  const home = join(work, 'home')
  await mkdir(root, { recursive: true })
  await mkdir(home, { recursive: true })
  await writeFeedbackProject(root)
  await writeFile(join(root, SECOND_TASK.input), ordersCsv(SECOND_TASK.month))
  await writeFile(join(root, 'checks', `${SECOND_TASK.id}.test.mjs`), checkSource(SECOND_TASK))
  const earlier = spent.reduce((sum, cost) => sum + (typeof cost === 'number' ? cost : 0), 0)
  const obs = {
    platform: process.platform, realModel, budgetUsd, spentBeforeUsd: earlier, config: {}, tasks: {}, feedback: { main: [], second: [] }, jobs: {}, approvals: [],
    prompts: { asks: [...HISTORY_TASKS, FEEDBACK_TASK, NEXT_TASK, SECOND_TASK].map(t => t.ask), comments: [...FEEDBACK, ...SECOND_FEEDBACK].map(f => f.comment) },
  }
  const approvals = async (request) => {
    obs.approvals.push({ tool: request.tool, summary: String(request.summary).slice(0, 200) })
    return { id: request.id, decision: 'allow', scope: 'once', decidedBy: 'user' }
  }
  // In-process only: the SDK's env object holds the key; the job, gate and driver processes inherit process.env.
  const sdk = pkgs.sdk.createSdk({ appVersion: 'accept-step5-real', env: { ...env, NEXGENT_HOME: home }, home, approvalResponder: approvals })
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
  const outcomeOf = async (sessionId, turn) => (await ledgerOf(root)).filter(r => r.type === 'task.outcome' && r.sessionId === sessionId && r.trialId === undefined && r.improvementId === undefined && (r.memberId ?? 'main') === 'main' && (turn === undefined || r.turn === undefined || r.turn === turn)).at(-1)
  const finishTask = async (key, task, sessionId, extra) => {
    const output = await readFile(join(root, task.output), 'utf8').catch(() => null)
    const outcome = await outcomeOf(sessionId, 1)
    obs.tasks[key] = {
      id: task.id, ask: task.ask, sessionId, ...extra,
      version: await versionOf(sessionId),
      taskId: outcome?.taskId,
      componentsUsed: outcome?.componentsUsed ?? null,
      checks: outcome?.checks ?? null,
      hidden: hiddenCheck(task, output),
    }
    const hidden = obs.tasks[key].hidden
    log(`${key}: ${extra.reason?.kind ?? extra.error ?? 'no result'}, hidden ${hidden.pass ? 'pass' : `${hidden.base ? 'base right, ' : ''}fail (${hidden.problems.slice(0, 2).join('; ')})`}`)
    if (extra.reason?.kind !== 'completed') throw new StopScenario(`${key} did not complete`)
  }
  const task = async (key, entry) => {
    step = key
    await guard(RESERVE.task, key)
    const sessionId = (await sdk.call('sessions.create', { projectId, title: `step-5 real ${key}` })).sessionId
    const from = new Date().toISOString()
    const run = await withTimeout(runTurn(sdk, { projectId, sessionId, text: entry.ask }), key, sessionId)
    await finishTask(key, entry, sessionId, { reason: run.result?.reason, ...(run.error === undefined ? {} : { error: errorText(run.error) }), window: { from, to: new Date().toISOString() }, events: run.events.map(slim).filter(Boolean) })
    return sessionId
  }
  /** Submit feedback entries on the first version of a task's deliverable, each followed by its feedback turn. */
  const feedback = async (list, key, entries) => {
    const sessionId = obs.tasks[key].sessionId
    const deliverable = (await sdk.call('deliverables.list', { projectId })).map(d => d.versions?.[0]).find(v => v?.sessionId === sessionId)
    obs.tasks[key].deliverable = deliverable === undefined ? null : { deliverableId: deliverable.deliverableId, version: deliverable.version }
    if (deliverable === undefined) throw new StopScenario(`${key} presented no deliverable`)
    for (const entry of entries) {
      step = `${list}-feedback-${entry.key}`
      await guard(RESERVE.feedback, step)
      const events = []
      const from = new Date().toISOString()
      const off = sdk.onAgentEvent(event => { if (event.projectId === projectId && event.sessionId === sessionId) events.push(event) })
      try {
        await sdk.call('feedback.submit', { projectId, sessionId, deliverableId: deliverable.deliverableId, version: deliverable.version, ...(entry.rating === undefined ? {} : { rating: entry.rating }), comment: entry.comment })
        const deadline = Date.now() + turnTimeoutMs
        while (Date.now() < deadline && !(events.some(e => e.type === 'turn.end') && !sdk.isRunning(projectId, sessionId))) await sleep(200)
      } finally {
        off()
      }
      const id = (await sdk.call('feedback.list', { projectId, sessionId })).find(l => l.comment === entry.comment)?.id
      const end = events.find(e => e.type === 'turn.end')
      obs.feedback[list].push({ key: entry.key, rating: entry.rating, comment: entry.comment, counted: countsTowardImprovement(entry), id, turn: end?.turn, reason: end?.reason, window: { from, to: new Date().toISOString() }, events: events.map(slim).filter(Boolean) })
      log(`${list} feedback ${entry.key}: turn ${end?.reason?.kind ?? 'did not end'}`)
      if (end?.reason?.kind !== 'completed') throw new StopScenario(`the feedback turn for ${entry.key} did not complete`)
    }
  }
  /** Wait for the job the feedback started (the first job not in `known`) to settle. */
  const awaitJob = async (label, known) => {
    step = label
    const deadline = Date.now() + jobTimeoutMs
    let job
    let last
    while (Date.now() < deadline) {
      job = (await readImprovements(pkgs, root)).jobs.find(j => !known.includes(j.id))
      if (job !== undefined && job.status !== last) {
        last = job.status
        log(`${label}: ${job.status}${job.history?.at(-1)?.detail ? ` (${String(job.history.at(-1).detail).slice(0, 160)})` : ''}`)
      }
      if (job !== undefined && SETTLED.has(job.status)) break
      // Never wait on a job that is spending past the cap: stop it.
      if (job !== undefined && (await spentNow()) > budgetUsd) {
        await sdk.call('improvements.cancel', { projectId, jobId: job.id }).catch(() => undefined)
        obs.stoppedForBudget = { during: label, spentUsd: Math.round((await spentNow()) * 10000) / 10000 }
        throw new StopScenario(`${label} passed the ${budgetUsd} USD cap; cancelled`)
      }
      await sleep(job === undefined ? 2_000 : 10_000)
    }
    if (job === undefined) throw new StopScenario(`${label}: no job started`)
    if (!SETTLED.has(job.status)) throw new StopScenario(`${label}: job ${job.id} did not settle within ${jobTimeoutMs / 60_000} min (status ${job.status})`)
    const view = jobView(job)
    const dir = join(root, '.nexgent', 'improvements', job.id)
    obs.jobs[label] = {
      ...view,
      request: job.request,
      diagnosis: await readJsonFile(join(dir, 'diagnosis.json')),
      show: await sdk.call('improvements.show', { projectId, jobId: job.id }).catch(error => ({ error: errorText(error) })),
    }
    return job
  }

  try {
    projectId = (await sdk.call('projects.open', { root, create: true })).projectId
    await sdk.call('settings.update', { projectId, patch: { model: REAL_MODEL.model, thinking: REAL_MODEL.thinking, costCaps: { perTask: TASK_CAPS }, improvement: IMPROVEMENT } })
    await editConfig(root, config => ({ ...config, capabilities: { ...config.capabilities, trialBudget: TRIAL_BUDGET } }))
    const config = JSON.parse(await readFile(join(root, '.nexgent', 'config.json'), 'utf8'))
    obs.config = { model: config.model, thinking: config.thinking, autoImprove: config.autoImprove ?? true, costCaps: config.costCaps, improvement: config.improvement, trialBudget: config.capabilities?.trialBudget }

    // R01
    for (const [index, entry] of HISTORY_TASKS.entries()) await task(`history${index + 1}`, entry)

    // R02, then R03 and R04: the third counted feedback starts the job by itself.
    await task('feedback', FEEDBACK_TASK)
    await guard(RESERVE.feedback * FEEDBACK.length + RESERVE.job, 'feedback')
    await feedback('main', 'feedback', FEEDBACK)
    const main = await awaitJob('main', [])
    obs.candidates = (await candidatesOf(root)).map(c => ({ id: c.id, version: c.record?.version, origin: c.record?.origin, jobId: c.record?.jobId, status: c.status, components: (c.record?.components ?? []).map(x => ({ kind: x.kind, name: x.name, files: (x.files ?? []).map(f => f.path) })), summary: c.record?.summary }))
    // ADR 0007: a quality rise above the cost-approval ratio waits for the user. The script answers
    // "allow" in the user's place (the coordinator's instruction, 2026-10-13) and records it.
    if (main.status === 'awaiting-approval' && main.candidateId !== undefined) {
      step = 'approve'
      const approved = await sdk.call('capabilities.approve', { projectId, candidateId: main.candidateId, decision: 'allow' }).catch(error => ({ error: errorText(error) }))
      const after = (await readImprovements(pkgs, root)).jobs.find(j => j.id === main.id)
      obs.approvedByScript = { candidateId: main.candidateId, candidateStatus: approved?.status, error: approved?.error, jobStatusAfter: after?.status }
      log(`approve: the script allowed ${main.candidateId.slice(0, 8)} in the user's place (candidate ${approved?.status ?? approved?.error}; job ${after?.status})`)
    }
    const current = (await sdk.call('capabilities.current', { projectId })).version
    const candidateVersion = obs.candidates.find(c => c.id === main.candidateId)?.version
    obs.adopted = main.candidateId !== undefined && current === candidateVersion && (main.status === 'adopted' || obs.approvedByScript?.candidateStatus === 'adopted') ? { candidateId: main.candidateId, version: current } : null

    // R05: a new month in a new OS process (only when the gate adopted).
    if (obs.adopted !== null) {
      step = 'next'
      await guard(RESERVE.task, 'next')
      const sessionId = (await sdk.call('sessions.create', { projectId, title: 'step-5 real next' })).sessionId
      await sdk.call('sessions.close', { projectId, sessionId })
      const from = new Date().toISOString()
      const child = await turnInChild({ root, home, sessionId, text: NEXT_TASK.ask, timeoutMs: turnTimeoutMs })
      await finishTask('next', NEXT_TASK, sessionId, { reason: child.done?.reason, ...((child.done?.error ?? child.error) === undefined ? {} : { error: child.done?.error ?? child.error }), window: { from, to: new Date().toISOString() }, events: child.events, child: { pid: child.pid, parentPid: process.pid, exitCode: child.exitCode, stderr: child.stderr } })
      obs.jobs.main.firstUse = (await sdk.call('improvements.show', { projectId, jobId: main.id }).catch(() => undefined))?.job?.firstUse
        ?? (await readImprovements(pkgs, root)).jobs.find(j => j.id === main.id)?.firstUse
    }

    // R07 (not in the threshold): another table, another missing column, a second job.
    if (second) {
      await task('second', SECOND_TASK)
      await guard(RESERVE.feedback * SECOND_FEEDBACK.length + RESERVE.job, 'second-feedback')
      await feedback('second', 'second', SECOND_FEEDBACK)
      await awaitJob('second', [main.id])
    }
  } catch (error) {
    if (error instanceof StopScenario) obs.stopped = { step, reason: error.message }
    else obs.error = { step, message: error instanceof Error ? (error.stack ?? error.message) : String(error) }
    log(`stopped at ${step}: ${errorText(error)}`)
  } finally {
    await sdk.dispose().catch(() => undefined)
  }
  // Late reads: everything the judges need, from disk.
  const ledger = await ledgerOf(root)
  const { queue, jobs } = await readImprovements(pkgs, root)
  obs.queue = queue
  obs.jobList = jobs.map(jobView)
  obs.activation = await activationOf(root)
  obs.decisions = await decisionsOf(root)
  obs.trials = await trialsOf(root)
  obs.snapshots = await filesUnder(join(root, '.nexgent', 'snapshots'))
  obs.diagnosisValid = Object.fromEntries(Object.entries(obs.jobs).map(([label, job]) => [label, job.diagnosis === undefined ? null : (issues => ({ valid: issues.length === 0, errors: issues.map(i => `${i.path}: ${i.message}`) }))(pkgs.session.validateImprovementFile('diagnosis', job.diagnosis))]))
  obs.ledgerVersions = Object.fromEntries(Object.values(obs.tasks).map(t => [t.sessionId, [...new Set(ledger.filter(r => r.sessionId === t.sessionId && r.trialId === undefined && r.improvementId === undefined).map(r => r.capabilityVersion))]]))
  const userRecords = ledger.filter(r => r.trialId === undefined && r.improvementId === undefined)
  obs.usage = {
    tasks: Object.fromEntries(Object.entries(obs.tasks).map(([key, t]) => [key, usageOf(userRecords.filter(r => r.sessionId === t.sessionId && within(r, t.window)))])),
    feedbackTurns: Object.fromEntries(Object.entries(obs.feedback).flatMap(([list, entries]) => entries.map(entry => [`${list}:${entry.key}`, usageOf(userRecords.filter(r => r.sessionId === obs.tasks[list === 'main' ? 'feedback' : 'second']?.sessionId && within(r, entry.window)))]))),
    jobs: Object.fromEntries(Object.entries(obs.jobs).map(([label, job]) => [label, jobUsage(ledger, job.jobId)])),
    improvement: usageOf(ledger.filter(r => r.improvementId !== undefined)),
    trialOutsideJobs: usageOf(ledger.filter(r => r.trialId !== undefined && r.improvementId === undefined)),
    user: usageOf(userRecords),
    total: usageOf(ledger),
  }
  obs.totalCostUsd = obs.usage.total.costUsd
  obs.root = root
  await writeFile(join(work, 'observations.json'), `${JSON.stringify(obs, null, 1)}\n`).catch(() => undefined)
  return obs
}
