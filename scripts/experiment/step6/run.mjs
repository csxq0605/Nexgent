#!/usr/bin/env node
// @ts-check
/**
 * The step-6 experiment runner (docs/plan/step-6-work-partition.md §测量, W6 part 2),
 * through the product path: `@nexgent/sdk` as built (it installs `@nexgent/evolve`, which
 * starts every improvement job, its gate and the meta job's comparison arms in their own
 * processes). Per task family, in its own project:
 *
 *   history    the selection and guard cases, one session each
 *   dev        the dev cases, one session each; then the base arm is copied (the project as
 *              it was before any feedback)
 *   feedback   template feedback (feedback.mjs) on each dev case's deliverable; the third
 *              counted entry starts an improvement job by itself; the runner waits for it
 *              (and answers an approval request in the user's place, recorded)
 *   meta       one explicit meta job with `keepCopies`; its comparison copies are the parent
 *              and child arms
 *   holdout    every holdout case × base / parent / child × repeats, each in a fresh copy of
 *              the arm, a new session, the hidden judge, the run's estimated cost
 *   records    raw.json (report.mjs's input), report.md, manifest.json, observations.json
 *
 * Every step passes the cost gate first (budget.mjs, cap 35 USD): spent + the step's reserve
 * must stay within the cap; each step's measured cost is added after it.
 *
 *   node scripts/experiment/step6/run.mjs --scripted --out <dir>        rehearsal, scripted model
 *   node scripts/experiment/step6/run.mjs --real --out <dir>            real model (key from env)
 *   node scripts/experiment/step6/run.mjs --dev-trial --real --out <dir> [--case <id>] [--repeats N]
 *       one dev case on improver v0 in fresh projects, before the experiment (plan: calibrate)
 *   options: --families tables,code  --repeats N  --iterations N  --spend <file>  --cap <usd>
 *            --keep-runs  --id <experiment id>
 *
 * Exit codes: 0 records written; 1 the run failed; 2 not runnable here (no key for --real,
 * packages not built, the test-support harness missing for --scripted, bad arguments).
 * The key is read from NEXGENT_API_KEY (or ANTHROPIC_API_KEY) and never printed or written.
 *
 * Linux, macOS and Windows; needs `pnpm build`.
 */
import { createHash } from 'node:crypto'
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gate, readSpend, recordSpend, spentUsd, STEP6_CAP_USD } from './budget.mjs'
import { allCases, checkGatePicks, checkIsolation, familyCases, FAMILIES, judgeCase, PLAN, PRESENT_REQUEST, writeCaseFiles } from './cases.mjs'
import { counts, feedbackFor } from './feedback.mjs'
import { buildReport } from './report.mjs'

/** Model settings of every session (user decision 8). */
export const MODEL = { model: 'claude-sonnet-5-5', thinking: 'on' }
/** Per-task caps of the experiment projects (permissions.md §费用上限). */
export const TASK_CAPS = { maxRequests: 80, maxTokens: 2_000_000 }
/** Improvement settings the runner sets (meta jobs only on request: they run explicitly). */
export const IMPROVEMENT = {
  feedbackThreshold: 3,
  budget: { maxTokens: 12_000_000, windowDays: 30 },
  ...MODEL,
  meta: { enabled: false, budget: { maxTokens: 12_000_000, windowDays: 30 }, model: MODEL.model },
}
/** Estimated USD set aside before each step (plan §真实模型实验's per-step estimates, rounded up). */
export const RESERVE_USD = { task: 0.4, feedback: 0.2, job: 2.5, meta: 6, holdout: 0.4 }
/** Job states that end a wait. */
export const SETTLED = new Set(['adopted', 'rejected', 'no-proposal', 'budget-exhausted', 'failed', 'interrupted', 'cancelled', 'waiting-history', 'awaiting-approval'])
export const ARMS = /** @type {const} */ (['base', 'parent', 'child'])

const sleep = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms))
const errorText = (/** @type {unknown} */ error) => (error instanceof Error ? error.message : String(error))
const repoUrl = (/** @type {string} */ path) => new URL(`../../../${path}`, import.meta.url).href

class Stop extends Error {}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)

/** A run's id: stable across reruns, so the same records give the same report. */
export const runIdOf = (/** @type {string} */ arm, /** @type {string} */ caseId, /** @type {number} */ repeat) => `${arm}#${caseId}#${repeat}`

/** Directory name for a case id. */
export const slug = (/** @type {string} */ text) => text.replace(/[^0-9A-Za-z-]+/g, '-')

/**
 * Estimated USD of ledger records: every `llm.request.end` priced by `estimate(model, usage)`.
 * `null` (unknown) when a request has no end or an end has no known price.
 * @param {readonly any[]} records
 * @param {(model: string, usage: any) => number | 'unknown'} estimate
 * @returns {number | null}
 */
export function costOf(records, estimate) {
  const ends = new Map(records.filter(r => r.type === 'llm.request.end').map(r => [r.requestId, r]))
  let total = 0
  for (const start of records.filter(r => r.type === 'llm.request.start')) {
    const end = ends.get(start.requestId)
    if (end === undefined || end.usage === undefined) return null
    const usd = estimate(end.model ?? start.model, end.usage)
    if (typeof usd !== 'number' || !Number.isFinite(usd)) return null
    total += usd
  }
  return Math.round(total * 1e6) / 1e6
}

/**
 * Whether a path inside a project is copied into an arm or run copy: never lock files; for a
 * run copy, never the improvement jobs (the copy runs no jobs).
 * @param {string} relPath relative to the project root, any separator
 * @param {{ jobs: boolean }} options
 */
export function copied(relPath, { jobs }) {
  const parts = relPath.split(/[\\/]/)
  if (parts.at(-1)?.endsWith('.lock')) return false
  if (!jobs && parts[0] === '.nexgent' && parts[1] === 'improvements') return false
  return true
}

/**
 * Case ids whose sessions a gate's trial records name (session ids found in the text).
 * @param {string} trialsText every trial file of a project, concatenated
 * @param {Record<string, string>} sessionToCase
 */
export function pickedCases(trialsText, sessionToCase) {
  return Object.entries(sessionToCase).filter(([sessionId]) => trialsText.includes(sessionId)).map(([, caseId]) => caseId).sort()
}

/** The plan's version: a digest of the case plan. */
export const planVersion = () => createHash('sha256').update(JSON.stringify(PLAN)).digest('hex').slice(0, 16)

// ---------------------------------------------------------------------------
// Files

/** Every file under a directory as one text (for the gate-pick search). @param {string} dir */
async function textUnder(dir) {
  let out = ''
  const walk = async (/** @type {string} */ d) => {
    for (const entry of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const path = join(d, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) out += await readFile(path, 'utf8').catch(() => '')
    }
  }
  await walk(dir)
  return out
}

/** Ledger records of a project. @param {string} root */
async function ledgerOf(root) {
  const dir = join(root, '.nexgent', 'ledgers')
  const out = []
  for (const month of (await readdir(dir).catch(() => [])).sort()) {
    const text = await readFile(join(dir, month, 'requests.jsonl'), 'utf8').catch(() => '')
    for (const line of text.split('\n')) if (line.trim() !== '') out.push(JSON.parse(line))
  }
  return out
}

/** Copy a project. @param {string} from @param {string} to @param {{ jobs: boolean }} options */
async function copyProject(from, to, options) {
  await rm(to, { recursive: true, force: true })
  await cp(from, to, { recursive: true, filter: source => copied(relative(from, source), options) })
}

const readJson = async (/** @type {string} */ path) => JSON.parse(await readFile(path, 'utf8'))

// ---------------------------------------------------------------------------
// Backends

/**
 * Packages as built.
 * @returns {Promise<{ ok: true, pkgs: any } | { ok: false, reason: string }>}
 */
export async function loadPackages() {
  try {
    const [sdk, evolve, llm, capabilities] = await Promise.all(['packages/sdk/dist/index.js', 'packages/evolve/dist/index.js', 'packages/llm/dist/index.js', 'packages/capabilities/dist/index.js'].map(path => import(repoUrl(path))))
    return { ok: true, pkgs: { sdk, evolve, llm, capabilities } }
  } catch (error) {
    return { ok: false, reason: `packages are not built (${errorText(error)}); run \`pnpm build\`` }
  }
}

/** The key the real backend uses, from the environment (never printed). */
export const realKeyPresent = (/** @type {NodeJS.ProcessEnv} */ env = process.env) => [env.NEXGENT_API_KEY, env.ANTHROPIC_API_KEY].some(value => typeof value === 'string' && value.trim() !== '')

const SCRIPTED_KEY = 'sk-step6-experiment-scripted-key'

/**
 * The scripted backend: a local scripted server answered by {@link ExperimentModel}.
 * Child processes inherit `process.env`, so the real key (if any) is swapped for the
 * scripted one until `close()`.
 * @param {any} pkgs
 * @param {string} home
 */
async function scriptedBackend(pkgs, home) {
  const harness = await import(repoUrl('packages/test-support/dist/index.js')).catch(error => { throw new Stop(`the test-support harness is not built (${errorText(error)}); run \`pnpm build\``) })
  const { ExperimentModel } = await import('./scripted-model.mjs')
  const { evidenceFor } = await import(repoUrl('scripts/accept-common/step5-model.mjs'))
  let root = ''
  const model = new ExperimentModel(harness, { cases: allCases(), evidence: text => evidenceFor(root, text) })
  const server = await harness.scriptedModelServer({ script: Array.from({ length: 50_000 }, () => model.entry) })
  const saved = { NEXGENT_API_KEY: process.env.NEXGENT_API_KEY, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY }
  process.env.NEXGENT_API_KEY = SCRIPTED_KEY
  delete process.env.ANTHROPIC_API_KEY
  const env = { NEXGENT_API_BASE_URL: server.baseUrl, NEXGENT_API_KEY: SCRIPTED_KEY, NEXGENT_HOME: home }
  return {
    name: 'scripted',
    model: 'scripted (local scripted server, no model call)',
    createSdk: () => pkgs.sdk.createSdk({ appVersion: 'experiment-step6-scripted', env, home, approvalResponder: allowAll }),
    setRoot: (/** @type {string} */ r) => { root = r },
    turnTimeoutMs: 120_000,
    jobTimeoutMs: 600_000,
    pollMs: 300,
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

/** The real backend: the real API, the key from the environment. @param {any} pkgs @param {string} home */
function realBackend(pkgs, home) {
  const env = { ...process.env, NEXGENT_HOME: home }
  return {
    name: 'real',
    model: `${MODEL.model}, thinking ${MODEL.thinking}`,
    createSdk: () => pkgs.sdk.createSdk({ appVersion: 'experiment-step6-real', env, home, approvalResponder: allowAll }),
    setRoot: () => undefined,
    turnTimeoutMs: 30 * 60_000,
    jobTimeoutMs: 150 * 60_000,
    pollMs: 10_000,
    requests: () => [],
    async close() {},
  }
}

/** Every approval prompt is allowed in the user's place (the experiment has no user at the screen). @param {any} request */
async function allowAll(request) {
  return { id: request.id, decision: 'allow', scope: 'once', decidedBy: 'user' }
}

// ---------------------------------------------------------------------------
// Steps

/**
 * One family's experiment.
 * @param {any} ctx `{ pkgs, backend, out, spend, cap, repeats, keepRuns, log }`
 * @param {'tables' | 'code'} family
 */
async function runFamily(ctx, family) {
  const { pkgs, backend, log } = ctx
  const cases = familyCases(family)
  const dir = join(ctx.out, family)
  const root = join(dir, 'project')
  await rm(dir, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  backend.setRoot(root)
  const estimate = (/** @type {string} */ model, /** @type {any} */ usage) => pkgs.llm.estimateUsd(model, usage)
  /** @type {any} */
  const obs = { family, root, tasks: {}, jobs: [], approvals: [], meta: null, arms: {}, runs: [], costs: [], notes: [], checks: {} }
  const sdk = backend.createSdk()
  let projectId = ''
  let step = 'setup'
  const sessionCost = async (/** @type {string} */ projectRoot, /** @type {string} */ sessionId) => costOf((await ledgerOf(projectRoot)).filter(r => r.sessionId === sessionId && r.improvementId === undefined && r.trialId === undefined), estimate)
  const guard = async (/** @type {number} */ reserve, /** @type {string} */ label) => {
    const verdict = await gate(ctx.spend, reserve, ctx.cap)
    if (!verdict.ok) {
      obs.stoppedForBudget = { before: label, reason: verdict.reason }
      throw new Stop(`not starting ${label}: ${verdict.reason}`)
    }
  }
  const spent = async (/** @type {string} */ label, /** @type {number | null} */ usd) => {
    if (usd === null) {
      obs.notes.push(`${label}: cost unknown; the cost gate counts it as ${RESERVE_USD.job} USD`)
      await recordSpend(ctx.spend, { label: `${family}/${label} (unknown, reserve counted)`, usd: RESERVE_USD.job }, ctx.cap)
      return
    }
    await recordSpend(ctx.spend, { label: `${family}/${label}`, usd }, ctx.cap)
  }
  const turn = async (/** @type {any} */ client, /** @type {string} */ pid, /** @type {string} */ sessionId, /** @type {string} */ text) => {
    const events = []
    const off = client.onAgentEvent((/** @type {any} */ e) => { if (e.projectId === pid && e.sessionId === sessionId) events.push(e) })
    let timer
    try {
      const started = await client.startTurn({ projectId: pid, sessionId, text })
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`turn did not finish within ${backend.turnTimeoutMs} ms`)), backend.turnTimeoutMs) })
      const result = await Promise.race([started.done, timeout])
      return { reason: result?.reason?.kind ?? 'unknown' }
    } catch (error) {
      await client.cancelTurn({ projectId: pid, sessionId }).catch(() => undefined)
      return { reason: 'error', error: errorText(error) }
    } finally {
      clearTimeout(timer)
      off()
    }
  }
  /** The latest deliverable version a session presented. @param {string} sessionId */
  const deliverableOf = async sessionId => (await sdk.call('deliverables.list', { projectId }))
    .flatMap((/** @type {any} */ d) => d.versions ?? [])
    .filter((/** @type {any} */ v) => v.sessionId === sessionId)
    .sort((/** @type {any} */ a, /** @type {any} */ b) => a.presentedAt.localeCompare(b.presentedAt))
    .at(-1)
  const doTask = async (/** @type {import('./cases.mjs').TaskCase} */ task) => {
    step = task.id
    await guard(RESERVE_USD.task, task.id)
    await writeCaseFiles(task, root)
    const { sessionId } = await sdk.call('sessions.create', { projectId, title: task.id })
    const result = await turn(sdk, projectId, sessionId, task.message)
    // Feedback attaches to a deliverable: when the turn presented none, the user asks for one.
    let presentRequest
    if (result.reason !== 'error' && (await deliverableOf(sessionId)) === undefined) {
      const asked = await turn(sdk, projectId, sessionId, PRESENT_REQUEST)
      presentRequest = { turn: asked.reason, presented: (await deliverableOf(sessionId)) !== undefined }
    }
    const judged = await judgeCase(task, root)
    const usd = await sessionCost(root, sessionId)
    obs.tasks[task.id] = { set: task.set, sessionId, ...result, ...(presentRequest === undefined ? {} : { presentRequest }), judge: judged, costUsd: usd }
    await spent(task.id, usd)
    log(`${task.id}: ${result.reason}, hidden ${judged.pass === null ? 'unknown' : judged.pass ? 'pass' : `fail (${[...new Set(judged.issues.map(i => i.kind))].join(', ')})`}`)
  }
  const jobs = async () => (await pkgs.evolve.listJobs(join(root, '.nexgent', 'improvements')).catch(() => []))
  const awaitJob = async (/** @type {string[]} */ known, /** @type {string} */ label, /** @type {string | undefined} */ jobId) => {
    const deadline = Date.now() + backend.jobTimeoutMs
    let job
    while (Date.now() < deadline) {
      job = (await jobs()).find((/** @type {any} */ j) => (jobId === undefined ? !known.includes(j.id) : j.id === jobId))
      if (job !== undefined && SETTLED.has(job.status)) break
      await sleep(job === undefined ? Math.min(backend.pollMs, 2000) : backend.pollMs)
    }
    if (job === undefined) throw new Stop(`${label}: no job started`)
    if (!SETTLED.has(job.status)) throw new Stop(`${label}: job ${job.id} did not settle (status ${job.status})`)
    return job
  }

  try {
    projectId = (await sdk.call('projects.open', { root, create: true })).projectId
    await sdk.call('settings.update', { projectId, patch: { ...MODEL, autoImprove: true, costCaps: { perTask: TASK_CAPS }, improvement: IMPROVEMENT } })

    for (const task of cases.filter(c => c.set === 'selection' || c.set === 'guard')) await doTask(task)
    const dev = cases.filter(c => c.set === 'dev')
    for (const task of dev) await doTask(task)

    step = 'base'
    obs.arms.base = { root: join(dir, 'arms', 'base'), from: 'the project after the history and dev tasks, before any feedback' }
    await copyProject(root, obs.arms.base.root, { jobs: true })

    for (const task of dev) {
      step = `${task.id}: feedback`
      const view = obs.tasks[task.id]
      const { entries } = feedbackFor(view.judge)
      view.feedback = []
      if (entries.filter(counts).length === 0) {
        obs.notes.push(`${task.id}: the hidden judge ${view.judge.pass === null ? 'could not finish' : 'passed'}; no counted feedback, so no job`)
        continue
      }
      await guard(RESERVE_USD.feedback * entries.length + RESERVE_USD.job, step)
      const deliverable = await deliverableOf(view.sessionId)
      if (deliverable === undefined) {
        obs.notes.push(`${task.id}: no deliverable was presented, even when asked; feedback not given, no job`)
        continue
      }
      const known = (await jobs()).map((/** @type {any} */ j) => j.id)
      const before = await sessionCost(root, view.sessionId)
      for (const entry of entries) {
        const events = /** @type {any[]} */ ([])
        const off = sdk.onAgentEvent((/** @type {any} */ e) => { if (e.projectId === projectId && e.sessionId === view.sessionId) events.push(e) })
        try {
          await sdk.call('feedback.submit', { projectId, sessionId: view.sessionId, deliverableId: deliverable.deliverableId, version: deliverable.version, ...(entry.rating === undefined ? {} : { rating: entry.rating }), comment: entry.comment })
          const deadline = Date.now() + backend.turnTimeoutMs
          while (Date.now() < deadline && !(events.some(e => e.type === 'turn.end') && !sdk.isRunning(projectId, view.sessionId))) await sleep(100)
        } finally {
          off()
        }
        view.feedback.push({ ...entry, turn: events.find(e => e.type === 'turn.end')?.reason?.kind ?? 'did not end' })
      }
      await spent(`${task.id}: feedback turns`, (await sessionCost(root, view.sessionId) ?? 0) - (before ?? 0))
      let job = await awaitJob(known, `${task.id}: job`, undefined)
      if (job.status === 'awaiting-approval' && job.candidateId !== undefined) {
        // ADR 0007: a costly quality rise waits for the user; the experiment answers in the user's place, recorded.
        const approved = await sdk.call('capabilities.approve', { projectId, candidateId: job.candidateId, decision: 'allow' }).catch((/** @type {unknown} */ error) => ({ error: errorText(error) }))
        obs.approvals.push({ jobId: job.id, candidateId: job.candidateId, result: approved?.status ?? approved?.error })
        job = (await jobs()).find((/** @type {any} */ j) => j.id === job.id) ?? job
      }
      const usd = costOf((await ledgerOf(root)).filter(r => r.improvementId === job.id), estimate)
      obs.jobs.push({ caseId: task.id, jobId: job.id, status: job.status, candidateId: job.candidateId, improverVersion: job.improverVersion, history: (job.history ?? []).map((/** @type {any} */ h) => h.status), costUsd: usd })
      await spent(`job ${job.id}`, usd)
      log(`${task.id}: job ${job.status}`)
    }

    step = 'meta'
    await guard(RESERVE_USD.meta, 'meta')
    const known = (await jobs()).map((/** @type {any} */ j) => j.id)
    let started
    try {
      started = await sdk.call('improvements.runMeta', { projectId, keepCopies: true })
      obs.metaVia = 'sdk improvements.runMeta'
    } catch (error) {
      if (!/not available yet/.test(errorText(error))) throw error
      // Until the SDK wires improvements.runMeta (W5), start it on the project's improvement host, the method the SDK will call.
      const host = /** @type {any} */ (sdk).projects?.get(projectId)?.app?.ctx?.get('improve')
      if (host === undefined) throw new Stop('improvements.runMeta is not wired and the project has no improvement host')
      started = await host.runMeta({ keepCopies: true })
      obs.metaVia = 'evolve ImprovementHost.runMeta (sdk improvements.runMeta not wired yet)'
    }
    const meta = await awaitJob(known, 'meta', started.id)
    const metaDir = join(root, '.nexgent', 'improvements', meta.id)
    const comparison = await readJson(join(metaDir, 'comparison.json')).catch(() => undefined)
    obs.meta = {
      jobId: meta.id, status: meta.status, history: (meta.history ?? []).map((/** @type {any} */ h) => h.status), detail: meta.history?.at(-1)?.detail,
      diagnosis: await readJson(join(metaDir, 'meta-diagnosis.json')).catch(() => undefined),
      change: await readJson(join(metaDir, 'change.json')).catch(() => undefined),
      comparison,
    }
    const metaUsd = costOf((await ledgerOf(root)).filter(r => r.improvementId === meta.id && r.comparisonArm === undefined), estimate)
    const armUsd = /** @type {Record<string, number | null>} */ ({ parent: comparison?.parent?.cost?.estimatedUsd ?? null, child: comparison?.child?.cost?.estimatedUsd ?? null })
    obs.meta.costUsd = { meta: metaUsd, ...armUsd }
    // Without a comparison file (no proposal, or stopped before it) the gate is charged whatever
    // the ledger holds for the meta job and any arm it started.
    const metaTotal = comparison === undefined
      ? costOf((await ledgerOf(root)).filter(r => r.improvementId === meta.id || r.metaJobId === meta.id), estimate)
      : metaUsd === null || armUsd.parent === null || armUsd.child === null ? null : metaUsd + armUsd.parent + armUsd.child
    await spent(`meta ${meta.id}`, metaTotal)
    log(`meta: ${meta.status}${comparison === undefined ? '' : ` (${comparison.origin.kind} origin; ${comparison.verdict.outcome}, ${comparison.verdict.reason})`}`)
    for (const arm of /** @type {const} */ (['parent', 'child'])) {
      const kept = comparison?.kept?.[arm]
      if (kept?.root !== undefined) obs.arms[arm] = { root: kept.root, from: `the meta job's ${arm} comparison copy`, improverVersion: comparison?.[arm]?.improverVersion }
      else obs.notes.push(`${arm} arm: no kept comparison copy (meta job ${meta.status}); its holdout runs are missing`)
    }

    step = 'checks'
    const holdoutCases = cases.filter(c => c.set === 'holdout')
    const sessionToCase = Object.fromEntries(Object.entries(obs.tasks).map(([caseId, t]) => [/** @type {any} */ (t).sessionId, caseId]))
    obs.checks.gatePicks = pickedCases(await textUnder(join(root, '.nexgent', 'capabilities')), sessionToCase)
    obs.checks.gatePickProblems = checkGatePicks(obs.checks.gatePicks, allCases())
    const roots = [join(root, '.nexgent'), ...Object.values(obs.arms).map((/** @type {any} */ a) => join(a.root, '.nexgent'))]
    const isolation = await checkIsolation(allCases(), roots)
    obs.checks.isolation = { leaks: isolation.leaks, scanned: isolation.scanned, skipped: isolation.skipped.length }
    obs.checks.epoch = await ctx.pkgs.capabilities.projectEpoch?.(projectLayout(root)).catch(() => undefined)

    for (const source of Object.values(obs.arms)) {
      source.capabilityVersion = await ctx.pkgs.capabilities.readActivation(join(source.root, '.nexgent', 'capabilities', 'activation'))
        .then((/** @type {any} */ a) => a.version, () => 'unknown')
    }

    if (ctx.untilMeta) obs.notes.push('stopped after the meta job (--until-meta): no holdout runs')

    for (const arm of ctx.untilMeta ? [] : ARMS) {
      const source = obs.arms[arm]
      if (source === undefined) continue
      for (const task of holdoutCases) {
        for (let repeat = 1; repeat <= ctx.repeats; repeat += 1) {
          const runId = runIdOf(arm, task.id, repeat)
          step = runId
          await guard(RESERVE_USD.holdout, runId)
          const runRoot = join(dir, 'runs', slug(`${arm}-${task.id}-${repeat}`))
          await copyProject(source.root, runRoot, { jobs: false })
          await writeCaseFiles(task, runRoot)
          const client = backend.createSdk()
          let record
          try {
            const { projectId: pid } = await client.call('projects.open', { root: runRoot })
            await client.call('settings.update', { projectId: pid, patch: { autoImprove: false } })
            const { sessionId } = await client.call('sessions.create', { projectId: pid, title: runId })
            const result = await turn(client, pid, sessionId, task.message)
            const judged = result.reason === 'error' ? { pass: null, issues: [], problems: [result.error ?? 'turn failed'] } : await judgeCase(task, runRoot)
            const ledger = await ledgerOf(runRoot)
            const outcome = ledger.filter(r => r.type === 'task.outcome' && r.sessionId === sessionId).at(-1)
            record = {
              runId, family, caseId: task.id, arm, repeat,
              pass: judged.pass,
              costUsd: costOf(ledger.filter(r => r.sessionId === sessionId && r.improvementId === undefined && r.trialId === undefined), estimate),
              componentsUsed: (outcome?.componentsUsed ?? []).map((/** @type {any} */ c) => (typeof c === 'string' ? c : `${c.kind}:${c.name}`)).sort(),
              turn: result.reason,
              problems: judged.problems,
            }
          } finally {
            await client.dispose().catch(() => undefined)
          }
          obs.runs.push(record)
          await spent(runId, record.costUsd)
          if (!ctx.keepRuns) await rm(runRoot, { recursive: true, force: true })
          log(`${runId}: ${record.pass === null ? 'unknown' : record.pass ? 'pass' : 'fail'}`)
        }
      }
    }
  } catch (error) {
    if (error instanceof Stop) obs.stopped = { step, reason: error.message }
    else obs.error = { step, message: error instanceof Error ? (error.stack ?? error.message) : String(error) }
    log(`${family} stopped at ${step}: ${errorText(error)}`)
  } finally {
    await sdk.dispose().catch(() => undefined)
  }

  // Costs of everything but the holdout runs, from the project's ledger.
  const ledger = await ledgerOf(root)
  const add = (/** @type {string} */ kind, /** @type {string} */ ref, /** @type {number | null} */ usd) => {
    if (usd === null) obs.notes.push(`${kind} ${ref}: cost unknown, left out of the cost table`)
    else obs.costs.push({ kind, family, usd, ref })
  }
  for (const [caseId, t] of Object.entries(obs.tasks)) add(/** @type {any} */ (t).set === 'dev' ? 'dev' : 'history', caseId, /** @type {any} */ (t).costUsd === undefined ? null : await sessionCostAll(ledger, /** @type {any} */ (t).sessionId, estimate))
  for (const job of obs.jobs) add('improvement', job.jobId, job.costUsd)
  const trialsOutside = ledger.filter(r => r.trialId !== undefined && r.improvementId === undefined)
  if (trialsOutside.length > 0) add('other', 'trials outside jobs', costOf(trialsOutside, estimate))
  if (obs.meta !== null) {
    add('meta', obs.meta.jobId, obs.meta.costUsd?.meta ?? null)
    for (const arm of ['parent', 'child']) if (obs.meta.comparison !== undefined) add('comparison', `${obs.meta.jobId}/${arm}`, obs.meta.costUsd?.[arm] ?? null)
  }
  return obs
}

/** A user session's cost including its feedback turns. @param {any[]} ledger @param {string} sessionId @param {any} estimate */
async function sessionCostAll(ledger, sessionId, estimate) {
  return costOf(ledger.filter(r => r.sessionId === sessionId && r.improvementId === undefined && r.trialId === undefined), estimate)
}

/** The layout `projectEpoch` reads. @param {string} root */
function projectLayout(root) {
  const dataDir = join(root, '.nexgent')
  return { root, dataDir, configFile: join(dataDir, 'config.json') }
}

/**
 * The raw records (report.mjs's input) from the families' observations.
 * @param {any[]} families
 * @param {{ experimentId: string, backend: string, model: string, iterations: number }} meta
 */
export function rawRecords(families, meta) {
  const decisions = /** @type {Record<string, string>} */ ({})
  const origins = /** @type {Record<string, string>} */ ({})
  const parents = new Set()
  const children = new Set()
  const epochs = new Set()
  const capabilities = /** @type {Record<string, string[]>} */ ({ base: [], parent: [], child: [] })
  const notes = []
  for (const f of families) {
    for (const arm of ARMS) if (f.arms?.[arm]?.capabilityVersion !== undefined) capabilities[arm].push(`${f.family}: ${f.arms[arm].capabilityVersion}`)
    const c = f.meta?.comparison
    decisions[f.family] = c === undefined ? `no comparison (meta job ${f.meta?.status ?? 'not run'})` : `${c.verdict.outcome} (${c.verdict.reason})`
    if (c !== undefined) {
      origins[f.family] = `${c.origin.kind ?? 'unknown'} (job ${c.origin.sourceJobId}, capability version ${c.origin.capabilityVersion})`
      parents.add(`${f.family}: ${c.parent.improverVersion}`)
      children.add(`${f.family}: ${c.child.improverVersion}`)
      epochs.add(c.origin.epoch)
    } else if (typeof f.checks?.epoch === 'string') epochs.add(f.checks.epoch)
    for (const note of f.notes) notes.push(`${f.family}: ${note}`)
    if (f.stopped !== undefined) notes.push(`${f.family}: stopped at ${f.stopped.step}: ${f.stopped.reason}`)
    if (f.error !== undefined) notes.push(`${f.family}: error at ${f.error.step}: ${String(f.error.message).split('\n')[0]}`)
    if (f.metaVia !== undefined) notes.push(`${f.family}: meta job started through ${f.metaVia}`)
    if (f.checks?.gatePicks !== undefined) notes.push(`${f.family}: gate picked ${f.checks.gatePicks.length} history cases; holdout picked: ${f.checks.gatePickProblems.length === 0 ? 'none' : f.checks.gatePickProblems.join('; ')}`)
    if (f.checks?.isolation !== undefined) notes.push(`${f.family}: holdout isolation: ${f.checks.isolation.leaks.length} leaks in ${f.checks.isolation.scanned} files (${f.checks.isolation.skipped} skipped)`)
    for (const a of f.approvals) notes.push(`${f.family}: job ${a.jobId} awaited approval; the runner allowed it in the user's place (${a.result})`)
  }
  notes.push('feedback check vs hidden judge: not compared in this runner yet (missing data, not zero)')
  return {
    manifest: {
      experimentId: meta.experimentId,
      epochId: [...epochs].sort().join(', ') || undefined,
      model: meta.model,
      thinking: meta.backend === 'real' ? MODEL.thinking : 'scripted',
      planVersion: planVersion(),
      improvers: { parent: [...parents].sort().join('; ') || undefined, child: [...children].sort().join('; ') || undefined },
      capabilities: Object.fromEntries(ARMS.map(arm => [arm, capabilities[arm].sort().join('; ') || undefined])),
      origins,
      decisions,
    },
    runs: families.flatMap(f => f.runs.map((/** @type {any} */ r) => ({ runId: r.runId, family: r.family, caseId: r.caseId, arm: r.arm, repeat: r.repeat, pass: r.pass, costUsd: r.costUsd, componentsUsed: r.componentsUsed }))),
    costs: families.flatMap(f => f.costs),
    disagreements: [],
    notes,
  }
}

// ---------------------------------------------------------------------------
// Entry points

/**
 * Run the experiment (or the dev trial).
 * @param {{ backend: 'scripted' | 'real', out: string, families?: string[], repeats?: number, iterations?: number,
 *   spend?: string, cap?: number, keepRuns?: boolean, untilMeta?: boolean, id?: string, devTrial?: { caseId: string, repeats: number }, log?: (line: string) => void }} options
 * @returns {Promise<{ code: number, reason?: string, report?: string }>}
 */
export async function runExperiment(options) {
  const log = options.log ?? (line => process.stderr.write(`${line}\n`))
  if (options.backend === 'real' && !realKeyPresent()) return { code: 2, reason: 'no model key in the environment (NEXGENT_API_KEY or ANTHROPIC_API_KEY); nothing was run' }
  const loaded = await loadPackages()
  if (!loaded.ok) return { code: 2, reason: loaded.reason }
  const out = resolve(options.out)
  await mkdir(out, { recursive: true })
  const home = join(out, 'home')
  const spend = options.spend === undefined ? join(out, 'spend.json') : resolve(options.spend)
  const cap = options.cap ?? STEP6_CAP_USD
  let backend
  try {
    backend = options.backend === 'scripted' ? await scriptedBackend(loaded.pkgs, home) : realBackend(loaded.pkgs, home)
  } catch (error) {
    return { code: 2, reason: errorText(error) }
  }
  const ctx = { pkgs: loaded.pkgs, backend, out, spend, cap, repeats: options.repeats ?? 3, keepRuns: options.keepRuns === true, untilMeta: options.untilMeta === true, log }
  const startedAt = new Date().toISOString()
  try {
    if (options.devTrial !== undefined) {
      const result = await devTrial(ctx, options.devTrial)
      await writeFile(join(out, 'dev-trial.json'), `${JSON.stringify({ backend: backend.name, model: backend.model, startedAt, ...result, spentUsd: spentUsd(await readSpend(spend, cap)) }, null, 2)}\n`)
      return { code: 0 }
    }
    const families = []
    for (const family of options.families ?? [...FAMILIES]) families.push(await runFamily(ctx, /** @type {any} */ (family)))
    const experimentId = options.id ?? `step6-${backend.name}`
    const iterations = options.iterations ?? 10_000
    const raw = rawRecords(families, { experimentId, backend: backend.name, model: backend.model, iterations })
    const report = buildReport(raw, { iterations })
    await writeFile(join(out, 'raw.json'), `${JSON.stringify(raw, null, 2)}\n`)
    await writeFile(join(out, 'report.md'), report)
    await writeFile(join(out, 'observations.json'), `${JSON.stringify(families, null, 1)}\n`)
    await writeFile(join(out, 'manifest.json'), `${JSON.stringify({
      experimentId, backend: backend.name, model: backend.model, startedAt, finishedAt: new Date().toISOString(), platform: process.platform, node: process.version,
      planVersion: planVersion(), plan: PLAN, repeats: ctx.repeats, iterations, capUsd: cap, spendFile: spend, spentUsd: spentUsd(await readSpend(spend, cap)),
      families: families.map(f => ({ family: f.family, stopped: f.stopped, error: f.error?.message?.split('\n')[0], arms: f.arms, meta: f.meta === null ? null : {
        jobId: f.meta.jobId, status: f.meta.status, origin: f.meta.comparison?.origin, verdict: f.meta.comparison?.verdict,
        arms: Object.fromEntries(['parent', 'child'].map(arm => [arm, f.meta.comparison?.[arm] === undefined ? undefined : { status: f.meta.comparison[arm].status, verdict: f.meta.comparison[arm].verdict }])),
      }, checks: f.checks })),
      scriptedRequests: backend.name === 'scripted' ? summarize(backend.requests()) : undefined,
    }, null, 2)}\n`)
    const failed = families.some(f => f.error !== undefined)
    return { code: failed ? 1 : 0, report }
  } finally {
    await backend.close()
  }
}

/** Request counts by kind (scripted backend). @param {Array<{ kind: string }>} requests */
function summarize(requests) {
  /** @type {Record<string, number>} */
  const out = {}
  for (const r of requests) out[r.kind] = (out[r.kind] ?? 0) + 1
  return out
}

/**
 * The plan's calibration run: one dev case on improver v0 (no feedback, no job), each repeat
 * in a fresh project. Reports the hidden judge per repeat and whether the task itself was right
 * with only the user's convention missing.
 * @param {any} ctx
 * @param {{ caseId: string, repeats: number }} spec
 */
async function devTrial(ctx, { caseId, repeats }) {
  const task = allCases().find(c => c.id === caseId)
  if (task === undefined || task.set !== 'dev') throw new Error(`${caseId} is not a dev case`)
  const estimate = (/** @type {string} */ model, /** @type {any} */ usage) => ctx.pkgs.llm.estimateUsd(model, usage)
  const runs = []
  for (let repeat = 1; repeat <= repeats; repeat += 1) {
    const verdict = await gate(ctx.spend, RESERVE_USD.task, ctx.cap)
    if (!verdict.ok) return { caseId, runs, stopped: verdict.reason }
    const root = join(ctx.out, 'dev-trial', `${slug(caseId)}-${repeat}`)
    await rm(root, { recursive: true, force: true })
    await mkdir(root, { recursive: true })
    ctx.backend.setRoot(root)
    await writeCaseFiles(task, root)
    const sdk = ctx.backend.createSdk()
    try {
      const { projectId } = await sdk.call('projects.open', { root, create: true })
      await sdk.call('settings.update', { projectId, patch: { ...MODEL, autoImprove: false, costCaps: { perTask: TASK_CAPS } } })
      const { sessionId } = await sdk.call('sessions.create', { projectId, title: caseId })
      const started = await sdk.startTurn({ projectId, sessionId, text: task.message })
      const result = await started.done.catch((/** @type {unknown} */ error) => ({ reason: { kind: 'error', message: errorText(error) } }))
      const judged = await judgeCase(task, root)
      const usd = costOf((await ledgerOf(root)).filter(r => r.sessionId === sessionId), estimate)
      await recordSpend(ctx.spend, { label: `dev-trial ${caseId} #${repeat}`, usd: usd ?? RESERVE_USD.task }, ctx.cap)
      const kinds = [...new Set(judged.issues.map(i => i.kind))].sort()
      runs.push({ repeat, turn: result?.reason?.kind, pass: judged.pass, taskRight: judged.pass === true || (judged.pass === false && kinds.every(k => k.startsWith('convention-'))), issues: kinds, problems: judged.problems, costUsd: usd })
      ctx.log(`dev-trial ${caseId} #${repeat}: ${judged.pass === null ? 'unknown' : judged.pass ? 'pass' : `fail (${kinds.join(', ')})`}`)
    } finally {
      await sdk.dispose().catch(() => undefined)
    }
  }
  const known = runs.filter(r => r.pass !== null)
  return { caseId, improver: 'v0', runs, passRate: known.length === 0 ? null : known.filter(r => r.pass).length / known.length, taskRightRate: known.length === 0 ? null : known.filter(r => r.taskRight).length / known.length }
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
  const families = value('--families')?.split(',').map(s => s.trim()).filter(Boolean)
  for (const f of families ?? []) if (!FAMILIES.includes(/** @type {any} */ (f))) problems.push(`unknown family ${f}`)
  const number = (/** @type {string} */ name) => {
    const v = value(name)
    if (v === undefined) return undefined
    const n = Number(v)
    if (!Number.isFinite(n) || n <= 0) problems.push(`${name} must be a positive number`)
    return n
  }
  const repeats = number('--repeats')
  const options = {
    backend: /** @type {'scripted' | 'real'} */ (backend),
    out: /** @type {string} */ (out),
    families, repeats, iterations: number('--iterations'), cap: number('--cap'),
    spend: value('--spend'), keepRuns: flag('--keep-runs'), untilMeta: flag('--until-meta'), id: value('--id'),
    devTrial: flag('--dev-trial') ? { caseId: value('--case') ?? 'code/dev/bugfix-101', repeats: repeats ?? 3 } : undefined,
  }
  return { options, problems }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { options, problems } = parseArgs(process.argv.slice(2))
  if (problems.length > 0) {
    process.stderr.write(`${problems.join('\n')}\nusage: run.mjs (--scripted | --real) --out <dir> [--dev-trial [--case <id>]] [--families tables,code] [--repeats N] [--iterations N] [--spend <file>] [--cap <usd>] [--keep-runs] [--until-meta] [--id <id>]\n`)
    process.exitCode = 2
  } else {
    runExperiment(options).then(result => {
      if (result.reason !== undefined) process.stderr.write(`${result.reason}\n`)
      process.exitCode = result.code
    }, error => {
      process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
      process.exitCode = 1
    })
  }
}

