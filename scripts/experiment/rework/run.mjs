#!/usr/bin/env node
// @ts-check
/**
 * Orchestration of the rework measurement (ADR 0019 §8; docs/plan/rework-partition.md M1
 * skeleton, M2–M4 runs), through the product path (`@nexgent/sdk` as built). Order:
 *
 *   judges     every checker on its good and bad end states, for the profile's cases; a
 *              failure stops before any model call
 *   stream     the training stream: the profile's training cases in round-robin order,
 *              one project per family, one NEXGENT_HOME for the stream; learning on only
 *              when a learning arm can run (the notice acknowledged; after every turn the
 *              stream waits until the learner has worked off the queue, so the next task
 *              sees what was learned); half of each family's cases get template feedback
 *              (feedback.mjs), whose counted entries become the notes text; the product's
 *              self-evaluation of each task is set against the deterministic judge
 *   isolation  no held-out case's fingerprint, message or folder anywhere in the stream's
 *              projects, its home or the notes text (a leak stops before any holdout run)
 *   arms       per arm, a template project and home the holdout runs copy, and the text
 *              put before the task message (arms.mjs): base, format, notes in a fresh
 *              home; L1 under the stream home's user level; arms without an adapter are
 *              recorded as unavailable and skipped, or (`--stand-in`, rehearsal only) get
 *              a fixed text, marked
 *   holdout    case by case, repeat by repeat, every arm in turn (so a stop at the cost
 *              gate leaves paired runs), each in a fresh copy of the arm's template, new
 *              session, learning off (retrieval stays on); no deliverable → the user asks
 *              once (counted); the deterministic judge scores; the external reviewer judges
 *              repeat 1 of every case and arm for the report only
 *   records    raw.json (report.mjs's input), report.md, manifest.json, observations.json
 *
 * Every step passes the profile's cost gate first (spend file `--spend`, real runs only);
 * an unknown cost counts as the step's reserve.
 *
 *   node scripts/experiment/rework/run.mjs --scripted --profile smoke --out <dir> [--stand-in]
 *   node scripts/experiment/rework/run.mjs --real --profile smoke --out <dir> --spend <file>
 *
 * A real run refuses unless the plan file is current (plan.mjs --check), the key is in the
 * environment, and the profile's gate allows it. Exit codes: 0 records written; 1 the run
 * failed; 2 not runnable (no key, packages not built, plan not current, bad arguments).
 * The key is read from NEXGENT_API_KEY (or ANTHROPIC_API_KEY), never printed or written.
 *
 * Linux, macOS and Windows; needs `pnpm build`.
 */
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { dataDirFor, layoutFor } from '../../accept-common/data-dir.mjs'
import { gate, recordSpend } from '../step6/budget.mjs'
import { PRESENT_REQUEST } from '../step6/cases.mjs'
import { keepOutputs, realComplete } from '../step6/pilot/run.mjs'
import { allowAll, copyProject, costOf, ledgerOf, loadPackages, MODEL, realKeyPresent, runIdOf, slug, TASK_CAPS } from '../step6/run.mjs'
import { ARMS, armSupport, firstMessage, FORMAT_TEXT, notesText, standInText } from './arms.mjs'
import { allCases, caseById, feedbackCases, holdoutIsolation, judgeCase, trainingOrder } from './cases.mjs'
import { listFiles, readText, sha256, writeFiles } from './common.mjs'
import { caseFeedback, counts } from './feedback.mjs'
import { checkJudges } from './judges.mjs'
import { ORCHESTRATION_SCRIPTS, PLAN_FILE, PLAN_FILE_REL, planSha256, planText, PROFILES, scriptHashes } from './plan.mjs'
import { buildReport } from './report.mjs'
import { deliveredFiles, reviewRun } from './reviewer.mjs'
import { agreement, comparisons, criteria, literalRate, selfEvalAgreement } from './stats.mjs'

/** Estimated USD set aside before each step (frozen in the plan). */
export const RESERVE_USD = Object.freeze({ task: 0.4, feedback: 0.15, learning: 0.15, holdout: 0.4, review: 0.08 })
/** How long the stream waits for the learner after a turn. */
const LEARNING_WAIT_MS = { scripted: 60_000, real: 15 * 60_000 }

const errorText = (/** @type {unknown} */ error) => (error instanceof Error ? error.message : String(error))
const repoUrl = (/** @type {string} */ path) => new URL(`../../../${path}`, import.meta.url).href
const sleep = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms))

class Stop extends Error {}

/** Set by the first SIGINT / SIGTERM: the run stops at the next gate and still writes its records. */
let stopRequested = false

/** Path relative to the output directory, `/`-separated. @param {string} out @param {string} path */
const rel = (out, path) => relative(out, path).split('\\').join('/')

// ---------------------------------------------------------------------------
// Backends

const SCRIPTED_KEY = 'sk-rework-scripted-key'

/** @param {any} pkgs @param {string} out */
async function scriptedBackend(pkgs, out) {
  const harness = await import(repoUrl('packages/test-support/dist/index.js')).catch(error => { throw new Stop(`the test-support harness is not built (${errorText(error)}); run \`pnpm build\``) })
  const { ReworkModel } = await import('./scripted-model.mjs')
  const model = new ReworkModel(harness, { cases: allCases() })
  const server = await harness.scriptedModelServer({ script: Array.from({ length: 100_000 }, () => model.entry) })
  const saved = { NEXGENT_API_KEY: process.env.NEXGENT_API_KEY, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, NEXGENT_HOME: process.env.NEXGENT_HOME }
  process.env.NEXGENT_API_KEY = SCRIPTED_KEY
  delete process.env.ANTHROPIC_API_KEY
  const env = { NEXGENT_API_BASE_URL: server.baseUrl, NEXGENT_API_KEY: SCRIPTED_KEY }
  return {
    name: 'scripted',
    model: 'scripted (local scripted server, no model call)',
    createSdk: (/** @type {string} */ home) => {
      process.env.NEXGENT_HOME = home
      return pkgs.sdk.createSdk({ appVersion: 'experiment-rework-scripted', env: { ...env, NEXGENT_HOME: home }, home, approvalResponder: allowAll })
    },
    complete: realComplete(pkgs, { env, home: join(out, 'homes', 'reviewer'), ledgersDir: join(out, 'reviewer', 'ledgers') }),
    turnTimeoutMs: 120_000,
    requests: () => model.requests,
    async close() {
      await server.close()
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    },
  }
}

/** @param {any} pkgs @param {string} out */
function realBackend(pkgs, out) {
  const saved = process.env.NEXGENT_HOME
  return {
    name: 'real',
    model: `${MODEL.model}, thinking ${MODEL.thinking}`,
    createSdk: (/** @type {string} */ home) => {
      process.env.NEXGENT_HOME = home
      return pkgs.sdk.createSdk({ appVersion: 'experiment-rework-real', env: { ...process.env, NEXGENT_HOME: home }, home, approvalResponder: allowAll })
    },
    complete: realComplete(pkgs, { env: { ...process.env }, home: join(out, 'homes', 'reviewer'), ledgersDir: join(out, 'reviewer', 'ledgers') }),
    turnTimeoutMs: 30 * 60_000,
    requests: () => [],
    async close() {
      if (saved === undefined) delete process.env.NEXGENT_HOME
      else process.env.NEXGENT_HOME = saved
    },
  }
}

// ---------------------------------------------------------------------------
// Product helpers

/**
 * One turn, waited for; a timeout or failure cancels it.
 * @param {any} client @param {string} projectId @param {string} sessionId @param {string} text @param {number} timeoutMs
 */
async function turn(client, projectId, sessionId, text, timeoutMs) {
  let timer
  try {
    const started = await client.startTurn({ projectId, sessionId, text })
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`turn did not finish within ${timeoutMs} ms`)), timeoutMs) })
    const result = await Promise.race([started.done, timeout])
    return { reason: result?.reason?.kind ?? 'unknown' }
  } catch (error) {
    await client.cancelTurn({ projectId, sessionId }).catch(() => undefined)
    return { reason: 'error', error: errorText(error) }
  } finally {
    clearTimeout(timer)
  }
}

/** Latest deliverable version a session presented. @param {any} client @param {string} projectId @param {string} sessionId */
const deliverableOf = async (client, projectId, sessionId) => (await client.call('deliverables.list', { projectId }))
  .flatMap((/** @type {any} */ d) => d.versions ?? [])
  .filter((/** @type {any} */ v) => v.sessionId === sessionId)
  .sort((/** @type {any} */ a, /** @type {any} */ b) => a.presentedAt.localeCompare(b.presentedAt))
  .at(-1)

/** Records of one session in the project's data directory. @param {string} root @param {string} home @param {string} sessionId */
export async function sessionRecords(root, home, sessionId) {
  const layout = await layoutFor(root, home)
  const text = await readFile(join(layout.sessions, sessionId, 'session.jsonl'), 'utf8').catch(() => '')
  return text.split('\n').filter(line => line.trim() !== '').flatMap(line => {
    try {
      return [JSON.parse(line)]
    } catch {
      return []
    }
  })
}

/** Handbook entry ids a session was given (`turn.start.handbook`). @param {any[]} records */
export const handbookGiven = records => [...new Set(records.flatMap(r => (r.type === 'turn.start' && Array.isArray(r.handbook) ? r.handbook : [])))]

/** The learning queue of a project (`<data dir>/learning/queue.json`). @param {string} root @param {string} home */
async function learningQueue(root, home) {
  const text = await readFile(join(await dataDirFor(root, home), 'learning', 'queue.json'), 'utf8').catch(() => '')
  try {
    const value = JSON.parse(text)
    return { items: /** @type {any[]} */ (value.items ?? []), history: /** @type {any[]} */ (value.history ?? []) }
  } catch {
    return { items: /** @type {any[]} */ ([]), history: /** @type {any[]} */ ([]) }
  }
}

/**
 * Wait until the learner has worked off a project's queue (the turn was queued before its
 * `done` resolved: the kernel awaits `noteTurnEnd`). Items waiting for budget end the wait;
 * so does the timeout (recorded).
 * @param {string} root @param {string} home @param {number} timeoutMs
 */
async function awaitLearning(root, home, timeoutMs) {
  const start = Date.now()
  await sleep(200)
  let queue = await learningQueue(root, home)
  while (Date.now() - start < timeoutMs && queue.items.some(item => item.status !== 'waiting-budget')) {
    await sleep(250)
    queue = await learningQueue(root, home)
  }
  return {
    ms: Date.now() - start,
    open: queue.items.filter(item => item.status !== 'waiting-budget').length,
    waitingBudget: queue.items.filter(item => item.status === 'waiting-budget').length,
    learned: queue.history.length,
  }
}

/** What the learner's requests (ledger records with `learningPhase`) cost. @param {any[]} ledger @param {any} estimate */
function learningCost(ledger, estimate) {
  const ids = new Set(ledger.filter(r => r.type === 'llm.request.start' && typeof r.learningPhase === 'string').map(r => r.requestId))
  return costOf(ledger.filter(r => ids.has(r.requestId)), estimate)
}

/**
 * The product's self-evaluation of a stream task, before the user's feedback: its checks
 * and rubric scores through C1 `selfEvalOutcome` without the rating.
 * @param {any} pkgs @param {string} root @param {string} home @param {string} sessionId
 */
async function selfEvaluationOf(pkgs, root, home, sessionId) {
  const layout = await layoutFor(root, home)
  const all = await pkgs.capabilities.listEvaluations(pkgs.capabilities.evaluationsDirectory(layout)).catch(() => [])
  const evaluation = all.find((/** @type {any} */ e) => e.sessionId === sessionId)
  if (evaluation === undefined) return null
  const scored = pkgs.capabilities.scoredBy(evaluation.rubric, evaluation.scores, evaluation.score)
  return {
    sample: evaluation.sample,
    outcome: pkgs.kernel.selfEvalOutcome({ checks: evaluation.checks, ...scored }),
    outcomeWithFeedback: evaluation.outcome,
    score: evaluation.score ?? null,
    rubricScore: scored.rubricScore ?? null,
    rubricItems: evaluation.rubric?.items.length ?? 0,
    failedChecks: evaluation.checks.filter((/** @type {any} */ c) => !c.passed).map((/** @type {any} */ c) => c.name ?? c.kind ?? 'check'),
    calibration: evaluation.calibration === undefined ? null : { score: evaluation.calibration.score, agree: evaluation.calibration.agree },
  }
}

/** The project settings of every experiment project. @param {boolean} learning */
const settingsPatch = learning => ({ ...MODEL, autoImprove: false, learning: { enabled: learning }, costCaps: { perTask: TASK_CAPS } })

// ---------------------------------------------------------------------------
// Steps

/**
 * The training stream.
 * @param {any} ctx
 * @param {{ families: string[] }} profile
 * @param {boolean} learning
 */
async function trainingStream(ctx, profile, learning) {
  const { backend, log } = ctx
  const home = join(ctx.out, 'homes', 'stream')
  await mkdir(home, { recursive: true })
  const sdk = backend.createSdk(home)
  /** @type {Record<string, string>} */
  const projects = {}
  const obs = { home, learning, projects: /** @type {Record<string, string>} */ ({}), tasks: /** @type {any[]} */ ([]), notesEntries: /** @type {Array<{ at: string, comment: string, caseId: string }>} */ ([]), learningWaits: /** @type {any[]} */ ([]) }
  const withFeedback = new Set(feedbackCases())
  /** @type {Record<string, number>} */
  const spentSoFar = {}
  const waitMs = LEARNING_WAIT_MS[/** @type {'scripted' | 'real'} */ (backend.name)]
  try {
    // Background learning spends only after the user was told once (ADR 0017); the stream's user does that first.
    if (learning) await sdk.call('learning.acknowledge', {})
    for (const id of trainingOrder(profile.families)) {
      const task = caseById(id)
      const root = join(ctx.out, 'stream', 'projects', task.family)
      if (projects[task.family] === undefined) {
        await mkdir(root, { recursive: true })
        projects[task.family] = (await sdk.call('projects.open', { root, create: true })).projectId
        await sdk.call('settings.update', { projectId: projects[task.family], patch: settingsPatch(learning) })
        obs.projects[task.family] = root
        spentSoFar[task.family] = 0
      }
      const projectId = projects[task.family]
      const learned = async (/** @type {string} */ label) => {
        if (!learning) return
        const wait = await awaitLearning(root, home, waitMs)
        obs.learningWaits.push({ label, ...wait })
        if (wait.open > 0) log(`${label}: the learner did not finish within ${waitMs} ms (${wait.open} open); going on`)
      }
      await ctx.guard(RESERVE_USD.task + (learning ? RESERVE_USD.learning : 0), id)
      await writeFiles(root, task.files)
      const { sessionId } = await sdk.call('sessions.create', { projectId, title: `task ${obs.tasks.length + 1}` })
      const result = await turn(sdk, projectId, sessionId, task.message, backend.turnTimeoutMs)
      let followUp = false
      if (result.reason !== 'error' && (await deliverableOf(sdk, projectId, sessionId)) === undefined) {
        followUp = true
        await turn(sdk, projectId, sessionId, PRESENT_REQUEST, backend.turnTimeoutMs)
      }
      const judged = await judgeCase(task, root)
      await learned(`${id}: task`)
      /** @type {any} */
      const record = { caseId: id, family: task.family, turn: result.reason, followUp, score: judged.score, pass: judged.pass, points: judged.points.map(p => ({ id: p.id, type: p.type, pass: p.pass })), feedback: [] }
      // Self-evaluation is written once, on the first turn the learner works on: before any feedback.
      record.selfEval = learning ? await selfEvaluationOf(ctx.pkgs, root, home, sessionId) : null
      // A seeded half of each family gets feedback; so does every task that missed a scored point (a user speaks up when something is wrong).
      if (withFeedback.has(id) || judged.points.some(p => !p.pass)) {
        const { entries } = caseFeedback(task, judged)
        const deliverable = await deliverableOf(sdk, projectId, sessionId)
        if (deliverable === undefined) record.feedbackSkipped = 'no deliverable, even when asked'
        for (const entry of deliverable === undefined ? [] : entries) {
          await ctx.guard(RESERVE_USD.feedback + (learning ? RESERVE_USD.learning : 0), `${id}: feedback`)
          const events = /** @type {any[]} */ ([])
          const off = sdk.onAgentEvent((/** @type {any} */ e) => { if (e.projectId === projectId && e.sessionId === sessionId) events.push(e) })
          try {
            const latest = (await deliverableOf(sdk, projectId, sessionId)) ?? deliverable
            await sdk.call('feedback.submit', { projectId, sessionId, deliverableId: latest.deliverableId, version: latest.version, ...(entry.rating === undefined ? {} : { rating: entry.rating }), comment: entry.comment })
            if (counts(entry)) obs.notesEntries.push({ at: String(obs.notesEntries.length).padStart(4, '0'), comment: entry.comment, caseId: id })
            const deadline = Date.now() + backend.turnTimeoutMs
            while (Date.now() < deadline && !(events.some(e => e.type === 'turn.end') && !sdk.isRunning(projectId, sessionId))) await sleep(100)
          } finally {
            off()
          }
          await learned(`${id}: feedback ${record.feedback.length + 1}`)
          record.feedback.push({ rating: entry.rating ?? null, comment: entry.comment, counted: counts(entry) })
        }
      }
      record.handbook = handbookGiven(await sessionRecords(root, home, sessionId))
      // Everything the project spent since the last task: the task, its feedback turns and the learner's requests.
      const total = costOf(await ledgerOf(root, home), ctx.estimate)
      record.costUsd = total === null ? null : Math.round((total - spentSoFar[task.family]) * 1e6) / 1e6
      if (total !== null) spentSoFar[task.family] = total
      record.learningUsdSoFar = learning ? learningCost(await ledgerOf(root, home), ctx.estimate) : 0
      await ctx.spent(`stream ${id}`, record.costUsd, RESERVE_USD.task + RESERVE_USD.feedback * record.feedback.length + (learning ? RESERVE_USD.learning * (1 + record.feedback.length) : 0))
      obs.tasks.push(record)
      log(`stream ${id}: score ${judged.score ?? 'unknown'}${record.selfEval === null || record.selfEval === undefined ? '' : `, self ${record.selfEval.outcome}`}${record.feedback.length > 0 ? `, ${record.feedback.length} feedback entries` : ''}${record.handbook.length > 0 ? `, given ${record.handbook.length} entries` : ''}`)
    }
  } finally {
    await sdk.dispose().catch(() => undefined)
  }
  return obs
}

/**
 * Copy a NEXGENT_HOME's user level (handbook, settings, improvers, practice cases...)
 * without its projects' data; `skills` is left out too when asked (L1 without layer 2).
 * @param {string} from @param {string} to @param {{ skills: boolean }} options
 */
async function copyUserLevel(from, to, options) {
  await rm(to, { recursive: true, force: true })
  await mkdir(to, { recursive: true })
  await cp(from, to, {
    recursive: true,
    filter: source => {
      const top = relative(from, source).split(/[\\/]/)[0]
      return !source.endsWith('.lock') && top !== 'projects' && (options.skills || top !== 'skills')
    },
  })
}

/**
 * The template project (and home) of an arm, which every holdout run of the arm copies,
 * and the text the arm puts before the task message.
 * @param {any} ctx @param {string} arm @param {{ notes: string, standIn: boolean, streamHome: string }} inputs
 */
async function armTemplate(ctx, arm, inputs) {
  const root = join(ctx.out, 'arms', slug(arm), 'project')
  const home = join(ctx.out, 'homes', `arm-${slug(arm)}`)
  await rm(join(ctx.out, 'arms', slug(arm)), { recursive: true, force: true })
  if (arm === 'L1') await copyUserLevel(inputs.streamHome, home, { skills: false })
  else {
    await rm(home, { recursive: true, force: true })
    await mkdir(home, { recursive: true })
  }
  await mkdir(root, { recursive: true })
  /** @type {any} */
  const info = { arm, root, home, standIn: false, prefix: '', entries: [] }
  const sdk = ctx.backend.createSdk(home)
  try {
    const { projectId } = await sdk.call('projects.open', { root, create: true })
    await sdk.call('settings.update', { projectId, patch: settingsPatch(false) })
    // What a holdout run of this arm can be given: the user level's entries (its own project has none).
    info.entries = (await sdk.call('handbook.list', { projectId })).entries.map((/** @type {any} */ e) => ({ id: e.id, text: e.text, keywords: e.keywords, status: e.status, scope: e.scope, helpful: e.helpful, harmful: e.harmful }))
  } finally {
    await sdk.dispose().catch(() => undefined)
  }
  if (arm === 'format') info.prefix = FORMAT_TEXT
  else if (arm === 'notes') info.prefix = inputs.notes
  else if (arm !== 'base' && arm !== 'L1') {
    if (!inputs.standIn) throw new Error(`no adapter for ${arm}`)
    info.standIn = true
    info.prefix = standInText(arm)
  }
  info.prefixSha256 = info.prefix === '' ? null : sha256(info.prefix)
  info.capabilityVersion = await ctx.pkgs.capabilities.readActivation(join(await dataDirFor(root, home), 'capabilities', 'activation')).then((/** @type {any} */ a) => a.version, () => 'none')
  return info
}

/**
 * One holdout run.
 * @param {any} ctx @param {any} template @param {import('./common.mjs').ReworkCase} task @param {number} repeat
 */
async function holdoutRun(ctx, template, task, repeat) {
  const runId = runIdOf(template.arm, task.id, repeat)
  await ctx.guard(RESERVE_USD.holdout, runId)
  const runRoot = join(ctx.out, 'runs', slug(`${template.arm}-${task.id}-${repeat}`))
  const runHome = join(ctx.out, 'homes', 'runs', slug(`${template.arm}-${task.id}-${repeat}`))
  // A run has its own home: the arm's user level, and the template's project data under the copy's own id.
  await copyUserLevel(template.home, runHome, { skills: true })
  await copyProject(template.root, runRoot, { jobs: false }, { from: template.home, to: runHome })
  await writeFiles(runRoot, task.files)
  const client = ctx.backend.createSdk(runHome)
  /** @type {any} */
  let run
  try {
    const { projectId } = await client.call('projects.open', { root: runRoot })
    const { sessionId } = await client.call('sessions.create', { projectId, title: 'task' })
    const result = await turn(client, projectId, sessionId, firstMessage(template.prefix, task.message), ctx.backend.turnTimeoutMs)
    let followUp = false
    if (result.reason !== 'error' && (await deliverableOf(client, projectId, sessionId)) === undefined) {
      followUp = true
      await turn(client, projectId, sessionId, PRESENT_REQUEST, ctx.backend.turnTimeoutMs)
    }
    const judged = result.reason === 'error' ? null : await judgeCase(task, runRoot)
    const ledger = await ledgerOf(runRoot, runHome)
    run = {
      runId, family: task.family, caseId: task.id, arm: template.arm, repeat, standIn: template.standIn,
      score: judged?.score ?? null, pass: judged?.pass ?? null,
      points: judged?.points.map(p => ({ id: p.id, type: p.type, weight: p.weight, pass: p.pass, detail: p.detail })) ?? [],
      costUsd: costOf(ledger.filter(r => r.sessionId === sessionId), ctx.estimate),
      capabilityVersions: [...new Set(ledger.filter(r => r.sessionId === sessionId && r.type === 'llm.request.start' && typeof r.capabilityVersion === 'string').map(r => r.capabilityVersion))].sort(),
      handbook: handbookGiven(await sessionRecords(runRoot, runHome, sessionId)),
      turn: result.reason,
      followUp,
      problems: result.reason === 'error' ? [result.error ?? 'turn failed'] : judged?.problems ?? [],
    }
    if (repeat === 1 && judged !== null) run.delivered = await deliveredFiles(task, runRoot)
  } finally {
    await client.dispose().catch(() => undefined)
  }
  await ctx.spent(runId, run.costUsd, RESERVE_USD.holdout)
  run.outputsKept = (await keepOutputs(task, runRoot, join(ctx.out, 'outputs', slug(runId)))).map(path => rel(ctx.out, path))
  if (!ctx.keepRuns) {
    await rm(runRoot, { recursive: true, force: true })
    await rm(runHome, { recursive: true, force: true })
  }
  return run
}

// ---------------------------------------------------------------------------
// The run

/**
 * @param {{ backend: 'scripted' | 'real', profile: string, out: string, spend?: string, standIn: boolean, keepRuns: boolean, log?: (line: string) => void }} options
 * @returns {Promise<{ code: number, reason?: string, report?: string }>}
 */
export async function runRework(options) {
  const log = options.log ?? (line => process.stdout.write(`${line}\n`))
  const profile = PROFILES[/** @type {keyof typeof PROFILES} */ (options.profile)]
  if (profile === undefined) return { code: 2, reason: `unknown profile ${options.profile}` }
  const out = resolve(options.out)
  const planCurrent = (await readFile(PLAN_FILE, 'utf8').catch(() => '')).replace(/\r\n/g, '\n') === await planText()
  if (options.backend === 'real') {
    if (options.standIn) return { code: 2, reason: '--stand-in is for rehearsals only' }
    if (!planCurrent) return { code: 2, reason: `${PLAN_FILE_REL} is missing or not current; a real run measures only against the frozen plan` }
    if (options.spend === undefined) return { code: 2, reason: '--spend <file> is required for a real run' }
    if (!realKeyPresent()) return { code: 2, reason: 'no API key in NEXGENT_API_KEY or ANTHROPIC_API_KEY' }
  }
  const loaded = await loadPackages()
  if (!loaded.ok) return { code: 2, reason: loaded.reason }
  let kernel
  let session
  try {
    [kernel, session] = await Promise.all(['packages/kernel/dist/index.js', 'packages/session/dist/index.js'].map(path => import(repoUrl(path))))
  } catch (error) {
    return { code: 2, reason: `packages are not built (${errorText(error)}); run \`pnpm build\`` }
  }
  const pkgs = { ...loaded.pkgs, kernel, session }
  await rm(out, { recursive: true, force: true })
  await mkdir(out, { recursive: true })
  const spendFile = options.spend === undefined ? join(out, 'spend.json') : resolve(options.spend)
  const notes = /** @type {string[]} */ ([])
  const guard = async (/** @type {number} */ reserve, /** @type {string} */ label) => {
    if (stopRequested) throw new Stop(`not starting ${label}: stopped by a signal`)
    const verdict = await gate(spendFile, reserve, profile.gateUsd)
    if (!verdict.ok) throw new Stop(`not starting ${label}: ${verdict.reason}`)
  }
  const spent = async (/** @type {string} */ label, /** @type {number | null} */ usd, /** @type {number} */ reserve) => {
    await recordSpend(spendFile, usd === null ? { label: `${label} (unknown, reserve counted)`, usd: reserve } : { label, usd }, profile.gateUsd)
    if (usd === null) notes.push(`${label}: cost unknown; the gate counts it as ${reserve} USD`)
  }
  const backend = options.backend === 'real' ? realBackend(pkgs, out) : await scriptedBackend(pkgs, out).catch(error => error)
  if (backend instanceof Error) return { code: 2, reason: errorText(backend) }
  const ctx = { pkgs, backend, out, guard, spent, keepRuns: options.keepRuns, log, estimate: (/** @type {string} */ model, /** @type {any} */ usage) => pkgs.llm.estimateUsd(model, usage) }
  /** @type {any} */
  const obs = { profile: options.profile, stopped: null, error: null, arms: {}, runs: [], reviews: [] }
  let step = 'judges'
  try {
    const cases = allCases()
    const holdout = profile.holdout.map(caseById)
    const used = [...trainingOrder(profile.families).map(caseById), ...holdout]
    obs.judges = await checkJudges(used)
    log(`judges: ${obs.judges.pass ? 'all correct' : 'FAILED'} (${obs.judges.results.length} samples)`)
    if (!obs.judges.pass) throw new Stop('a checker failed on its good or bad sample; no model call')

    const support = armSupport(pkgs)
    const learningAvailable = profile.arms.some(arm => arm.startsWith('L') && support[/** @type {import('./arms.mjs').Arm} */ (arm)].available)
    step = 'stream'
    obs.stream = await trainingStream(ctx, profile, learningAvailable)
    const notesArm = notesText(obs.stream.notesEntries)
    await writeFile(join(out, 'stream', 'notes.txt'), notesArm.text)
    obs.notes = { entries: obs.stream.notesEntries.length, kept: notesArm.kept, dropped: notesArm.dropped, sha256: sha256(notesArm.text) }

    step = 'isolation'
    const roots = [join(out, 'stream'), obs.stream.home, join(out, 'stream', 'notes.txt')]
    obs.isolation = await holdoutIsolation(roots, cases)
    log(`isolation: ${obs.isolation.leaks.length} leaks over ${obs.isolation.scanned} files`)
    if (obs.isolation.leaks.length > 0) throw new Stop(`holdout isolation: ${obs.isolation.leaks.length} leaks; no holdout runs`)

    /** @type {any[]} */
    const templates = []
    for (const arm of profile.arms) {
      step = `arm ${arm}`
      const available = support[/** @type {import('./arms.mjs').Arm} */ (arm)]
      if (!available.available && !options.standIn) {
        obs.arms[arm] = { arm, status: 'unavailable', reason: available.reason }
        log(`arm ${arm}: unavailable`)
        continue
      }
      const template = await armTemplate(ctx, arm, { notes: notesArm.text, standIn: !available.available, streamHome: obs.stream.home })
      obs.arms[arm] = { ...template, status: template.standIn ? 'stand-in' : 'ran' }
      templates.push(template)
      log(`arm ${arm}: ${template.entries.length} handbook entries visible${template.prefix === '' ? '' : `, ${Buffer.byteLength(template.prefix)} bytes before the task message`}`)
    }
    // Case by case, repeat by repeat, every arm in turn: a stop at the gate leaves paired runs.
    for (const task of holdout) {
      for (let repeat = 1; repeat <= profile.repeats; repeat += 1) {
        for (const template of templates) {
          const arm = template.arm
          step = runIdOf(arm, task.id, repeat)
          const run = await holdoutRun(ctx, template, task, repeat)
          if (run.delivered !== undefined) {
            step = `${run.runId}: review`
            await guard(RESERVE_USD.review, step)
            const reviewed = await reviewRun(backend.complete, task, run.delivered)
            await spent(`${run.runId}: review`, reviewed.usd, RESERVE_USD.review)
            for (const point of run.points) {
              const v = reviewed.verdicts?.[point.id]
              obs.reviews.push({ runId: run.runId, arm, family: task.family, pointId: point.id, judge: point.pass, reviewer: v === undefined ? null : v.verdict === 'yes', unclear: v?.verdict === 'unclear', reason: v?.reason ?? (reviewed.verdicts === null ? 'review failed' : 'no verdict') })
            }
            delete run.delivered
          }
          obs.runs.push(run)
          log(`${run.runId}: score ${run.score ?? 'unknown'}${run.followUp ? ' (follow-up)' : ''}${run.handbook.length > 0 ? `, given ${run.handbook.length} entries` : ''}`)
        }
      }
    }
  } catch (error) {
    if (error instanceof Stop) obs.stopped = { step, reason: error.message }
    else obs.error = { step, message: error instanceof Error ? (error.stack ?? error.message) : String(error) }
    log(`stopped at ${step}: ${errorText(error)}`)
  } finally {
    await backend.close()
  }

  const records = await rawRecords(obs, { out, profile: options.profile, backend: backend.name, model: backend.model, planSha256: planCurrent ? await planSha256() : null, planCurrent, notes, pkgs })
  await writeFile(join(out, 'raw.json'), `${JSON.stringify(records, null, 2)}\n`)
  const report = buildReport(records)
  await writeFile(join(out, 'report.md'), report)
  const spend = JSON.parse(await readFile(spendFile, 'utf8').catch(() => '{"entries":[]}'))
  await writeFile(join(out, 'manifest.json'), `${JSON.stringify({
    experiment: 'rework', profile: options.profile, backend: backend.name, model: backend.model,
    plan: { file: PLAN_FILE_REL, sha256: records.planSha256, current: planCurrent },
    orchestration: await scriptHashes(ORCHESTRATION_SCRIPTS),
    product: productCommit(),
    arms: Object.fromEntries(Object.entries(obs.arms).map(([arm, a]) => [arm, { status: a.status, reason: a.reason ?? null, home: a.home === undefined ? null : rel(out, a.home), capabilityVersion: a.capabilityVersion ?? null, prefixSha256: a.prefixSha256 ?? null, prefixBytes: a.prefix === undefined || a.prefix === '' ? 0 : Buffer.byteLength(a.prefix), entries: a.entries?.length ?? 0 }])),
    stream: obs.stream === undefined ? null : { home: rel(out, obs.stream.home), learning: obs.stream.learning, projects: Object.fromEntries(Object.entries(obs.stream.projects).map(([f, p]) => [f, rel(out, String(p))])) },
    spend: { file: options.spend === undefined ? 'spend.json' : 'external', gateUsd: PROFILES[/** @type {keyof typeof PROFILES} */ (options.profile)].gateUsd, usd: Math.round((spend.entries ?? []).reduce((/** @type {number} */ s, /** @type {any} */ e) => s + e.usd, 0) * 1e6) / 1e6 },
    scriptedRequests: backend.name === 'scripted' ? countKinds(backend.requests()) : undefined,
  }, null, 2)}\n`)
  await writeFile(join(out, 'observations.json'), `${JSON.stringify({ stopped: obs.stopped, error: obs.error, notes, learningWaits: obs.stream?.learningWaits ?? [] }, null, 2)}\n`)
  return { code: obs.error === null ? 0 : 1, report }
}

/** The product commit the run measured (`git rev-parse HEAD`; null outside a checkout). */
function productCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: new URL('.', import.meta.url), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

/** @param {Array<{ kind: string }>} requests */
function countKinds(requests) {
  /** @type {Record<string, number>} */
  const out = {}
  for (const r of requests) out[r.kind] = (out[r.kind] ?? 0) + 1
  return Object.fromEntries(Object.entries(out).sort())
}

/**
 * The raw records (report.mjs's input): no time, no session id, no absolute path, so the
 * same answers give the same bytes.
 * @param {any} obs
 * @param {{ out: string, profile: string, backend: string, model: string, planSha256: string | null, planCurrent: boolean, notes: string[], pkgs: any }} meta
 */
export async function rawRecords(obs, meta) {
  // Handbook entry ids are random: the records name them e1, e2… by first use in the stream, then by text.
  /** @type {Map<string, string>} */
  const labels = new Map()
  const label = (/** @type {string} */ id) => {
    if (!labels.has(id)) labels.set(id, `e${labels.size + 1}`)
    return /** @type {string} */ (labels.get(id))
  }
  for (const task of obs.stream?.tasks ?? []) for (const id of task.handbook ?? []) label(id)
  for (const entry of [...(obs.arms.L1?.entries ?? [])].sort((/** @type {any} */ a, /** @type {any} */ b) => (a.text < b.text ? -1 : a.text > b.text ? 1 : 0))) label(entry.id)
  const named = (/** @type {string[] | undefined} */ ids) => (ids ?? []).map(label)
  const runs = obs.runs.map((/** @type {any} */ r) => ({ ...r, handbook: named(r.handbook) }))
  const compared = comparisons(runs)
  const trainCases = (obs.stream?.tasks ?? []).map((/** @type {any} */ t) => caseById(t.caseId))
  const sources = []
  for (const task of trainCases) for (const [path, content] of Object.entries(task.files)) if (typeof content === 'string') sources.push({ kind: /** @type {const} */ ('deliverable'), ref: `input:${task.id}/${path}`, text: content })
  for (const task of obs.stream?.tasks ?? []) for (const entry of task.feedback) sources.push({ kind: /** @type {const} */ ('feedback'), ref: `feedback:${task.caseId}`, text: entry.comment })
  const messages = trainCases.map((/** @type {any} */ task) => ({ taskId: task.id, text: task.message }))
  const notesLiteral = literalRate((obs.stream?.notesEntries ?? []).map((/** @type {any} */ e, /** @type {number} */ i) => ({ name: `notes#${i + 1}`, texts: [{ path: 'notes.txt', text: e.comment }] })), sources, messages, meta.pkgs.kernel.findInstanceLiterals)
  // What L1 can give a holdout run: the user level's entries (a fresh project has none of its own).
  const l1 = obs.arms.L1?.status === 'ran' ? obs.arms.L1 : undefined
  const entries = /** @type {any[]} */ (l1?.entries ?? [])
  const l1Literal = l1 === undefined ? null : literalRate(entries.map(e => ({ name: `L1#${label(e.id)}`, texts: [{ path: 'handbook', text: e.text }] })), sources, messages, meta.pkgs.kernel.findInstanceLiterals)
  const learningArms = l1 === undefined ? null : {
    arm: 'L1',
    ...l1Literal,
    entries: [...entries].sort((a, b) => label(a.id).localeCompare(label(b.id), 'en', { numeric: true })).map(e => ({ id: label(e.id), text: e.text, keywords: e.keywords, status: e.status, helpful: e.helpful, harmful: e.harmful, given: runs.filter((/** @type {any} */ r) => r.arm === 'L1' && r.handbook.includes(label(e.id))).length })),
  }
  const selfEval = selfEvalAgreement((obs.stream?.tasks ?? []).filter((/** @type {any} */ t) => t.selfEval !== undefined).map((/** @type {any} */ t) => ({ caseId: t.caseId, judgeScore: t.score, selfOutcome: t.selfEval?.outcome ?? null })))
  return {
    formatVersion: 1,
    experiment: 'rework',
    profile: meta.profile,
    backend: meta.backend,
    model: meta.model,
    planSha256: meta.planSha256,
    planCurrent: meta.planCurrent,
    stopped: obs.stopped,
    error: obs.error === null ? null : { step: obs.error.step },
    judges: obs.judges === undefined ? null : { pass: obs.judges.pass, samples: obs.judges.results.length, failed: obs.judges.results.filter((/** @type {any} */ r) => !r.ok) },
    stream: obs.stream === undefined ? null : { learning: obs.stream.learning, tasks: obs.stream.tasks.map((/** @type {any} */ t) => ({ ...t, handbook: named(t.handbook) })) },
    notes: obs.notes ?? null,
    isolation: obs.isolation === undefined ? null : { leaks: obs.isolation.leaks, scanned: obs.isolation.scanned, skipped: obs.isolation.skipped.length },
    arms: Object.fromEntries(Object.entries(obs.arms).map(([arm, a]) => [arm, { status: /** @type {any} */ (a).status, reason: /** @type {any} */ (a).reason ?? null, standIn: /** @type {any} */ (a).standIn ?? false }])),
    runs,
    reviews: obs.reviews,
    agreement: agreement(obs.reviews),
    selfEval,
    learned: {
      notes: notesLiteral,
      learningArms,
      // No gate in layer 1: nothing is adopted as cost-optimized.
      costOptimized: null,
    },
    comparisons: compared,
    criteria: criteria(compared, { literalRate: l1Literal?.rate ?? null, costOptimized: null }),
    runNotes: meta.notes,
  }
}

/** @param {string[]} argv */
export function parseArgs(argv) {
  const flag = (/** @type {string} */ name) => argv.includes(name)
  const value = (/** @type {string} */ name) => {
    const i = argv.indexOf(name)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const problems = []
  const backend = flag('--real') ? 'real' : flag('--scripted') ? 'scripted' : undefined
  if (backend === undefined) problems.push('choose --scripted or --real')
  if (flag('--real') && flag('--scripted')) problems.push('--scripted and --real exclude each other')
  const out = value('--out')
  if (out === undefined) problems.push('--out <dir> is required')
  const profile = value('--profile') ?? 'smoke'
  if (!(profile in PROFILES)) problems.push(`unknown profile ${profile} (${Object.keys(PROFILES).join(', ')})`)
  return {
    options: { backend: /** @type {'scripted' | 'real'} */ (backend), profile, out: /** @type {string} */ (out), spend: value('--spend'), standIn: flag('--stand-in'), keepRuns: flag('--keep-runs') },
    problems,
  }
}

export { ARMS, listFiles, readText }

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { options, problems } = parseArgs(process.argv.slice(2))
  if (problems.length > 0) {
    process.stderr.write(`${problems.join('\n')}\nusage: rework/run.mjs (--scripted | --real) --profile smoke|m3|m4 --out <dir> [--spend <file>] [--stand-in] [--keep-runs]\n`)
    process.exitCode = 2
  } else {
    // The first signal stops at the next gate and writes the records; a second one exits at once.
    for (const signal of /** @type {const} */ (['SIGINT', 'SIGTERM'])) {
      process.on(signal, () => {
        if (stopRequested) process.exit(130)
        stopRequested = true
        process.stderr.write(`${signal}: stopping at the next gate; records will be written\n`)
      })
    }
    runRework(options).then(result => {
      if (result.reason !== undefined) process.stderr.write(`${result.reason}\n`)
      process.exit(result.code)
    }, error => {
      process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
      process.exit(1)
    })
  }
}
