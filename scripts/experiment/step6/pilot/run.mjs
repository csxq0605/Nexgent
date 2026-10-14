#!/usr/bin/env node
// @ts-check
/**
 * The pilot's orchestration (ADR 0011; docs/plan/step-6-rework-partition.md R6 part 2),
 * through the product path: `@nexgent/sdk` as built (it installs `@nexgent/evolve`, which
 * starts every improvement job and its gate in their own processes). Order:
 *
 *   judges     reliability criterion 1 (every checker on its good and bad end states); a
 *              failure stops the pilot before any model call
 *   pairs      the six reference pairs, each judged by the external reviewer in both orders
 *              (criterion 2)
 *   per family, in its own project and its own NEXGENT_HOME:
 *   history    the selection and guard cases, one session each
 *   dev        the dev cases, one session each; then the `base` arm is copied
 *   feedback   template feedback from the deterministic points only (feedback.mjs
 *              `pilotFeedback`); three counted entries start an improvement job by itself
 *              (improver v0, epoch adr-0014); the orchestration waits for it, and answers an
 *              approval request in the user's place, recorded; then the `parent` arm is copied
 *   memory     a copy of `base` in which the orchestration writes and adopts one context
 *              policy `project-notes` through the `@nexgent/capabilities` store: the counted
 *              feedback text of the family, oldest first (memory.mjs); no diagnosis, no gate
 *   checks     holdout isolation over every arm (a leak stops the family), the epoch, each
 *              arm's capability and improver version, adopted components by class and their
 *              instance-literal rate (ADR 0013 `findInstanceLiterals`)
 *   holdout    every holdout case × base / memory / parent × 3 repeats, each in a fresh copy
 *              of the arm with the arm's own NEXGENT_HOME, a new session, auto-improvement
 *              off; no deliverable → the user asks once (counted per arm); the deterministic
 *              judge; for documents, the external reviewer judges the review points and the
 *              in-loop reviewer judges the same points (agreement only)
 *   arm pairs  per document holdout case, repeat 1: parent vs memory, both orders
 *   records    raw.json (report.mjs's input), report.md, manifest.json, observations.json
 *
 * Every step passes two cost gates first (budget.mjs): the step-6 cap (35 USD, the spend
 * file given by --spend) and the pilot's own gate (12 USD, `pilot-spend.json` in --out);
 * each step's measured cost is added to both after it. An unknown cost is counted as the
 * step's reserve.
 *
 *   node scripts/experiment/step6/pilot/run.mjs --scripted --out <dir>   rehearsal, scripted model
 *   node scripts/experiment/step6/pilot/run.mjs --real --out <dir> --spend <file>   the pilot
 *   options: --families docs,files  --keep-runs
 *
 * The real pilot refuses to start when pilot-plan.json is not current (plan.mjs --check).
 * Exit codes: 0 records written; 1 the run failed; 2 not runnable here (no key for --real,
 * packages not built, plan not current, bad arguments). The key is read from
 * NEXGENT_API_KEY (or ANTHROPIC_API_KEY) and never printed or written.
 *
 * Linux, macOS and Windows; needs `pnpm build`.
 */
import { createHash, randomUUID } from 'node:crypto'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gate, readSpend, recordSpend, spentUsd, STEP6_CAP_USD } from '../budget.mjs'
import { checkIsolation, PRESENT_REQUEST } from '../cases.mjs'
import { counts } from '../feedback.mjs'
import { allowAll, copyProject, costOf, IMPROVEMENT, ledgerOf, loadPackages, MODEL, realKeyPresent, runIdOf, SETTLED, slug, TASK_CAPS } from '../run.mjs'
import { judgePilotCase, PILOT_FAMILIES, pilotCases, pilotReferencePairs, tasteMet } from './cases.mjs'
import { withReview, writeFiles } from './common.mjs'
import { pilotFeedback } from './feedback.mjs'
import { MEMORY_POLICY, memoryInstructions } from './memory.mjs'
import { PILOT_ID, PLAN_FILE, PLAN_FILE_REL, planSha256, planText } from './plan.mjs'
import { checkJudges } from './reliability.mjs'
import { buildPilotReport } from './report.mjs'
import { comparePair, EXTERNAL_REVIEWER, IN_LOOP_REVIEWER, reviewPoints } from './reviewer.mjs'
import { componentClass, literalRate, PILOT_ARMS } from './stats.mjs'

/** The pilot's own cost gate (ADR 0011), inside the step-6 cap. */
export const PILOT_GATE_USD = 12
/** Estimated USD set aside before each step. */
export const PILOT_RESERVE_USD = { task: 0.4, feedback: 0.2, job: 2.5, holdout: 0.4, pointReview: 0.08, pairReview: 0.16 }
/** Repeats per holdout case and arm (frozen in the plan). */
export const PILOT_REPEATS = 3

const sleep = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms))
const errorText = (/** @type {unknown} */ error) => (error instanceof Error ? error.message : String(error))
const repoUrl = (/** @type {string} */ path) => new URL(`../../../../${path}`, import.meta.url).href
const sha256 = (/** @type {string} */ text) => createHash('sha256').update(text).digest('hex')

class Stop extends Error {}

// ---------------------------------------------------------------------------
// Backends

/** The packages `../run.mjs` loads, plus kernel and session. */
async function loadPilotPackages() {
  const loaded = await loadPackages()
  if (!loaded.ok) return loaded
  try {
    const [kernel, session] = await Promise.all(['packages/kernel/dist/index.js', 'packages/session/dist/index.js'].map(path => import(repoUrl(path))))
    return { ok: /** @type {const} */ (true), pkgs: { ...loaded.pkgs, kernel, session } }
  } catch (error) {
    return { ok: /** @type {const} */ (false), reason: `packages are not built (${errorText(error)}); run \`pnpm build\`` }
  }
}

/**
 * The reviewers' model call through the product's Claude Platform client
 * (`@nexgent/llm` `AnthropicProvider`), outside every project: its records go to a ledger
 * of their own, so no verdict is written into a project.
 * @param {any} pkgs
 * @param {{ env: Record<string, string | undefined>, home: string, ledgersDir: string }} options
 * @returns {import('./reviewer.mjs').Complete}
 */
export function realComplete(pkgs, { env, home, ledgersDir }) {
  const ledger = new pkgs.session.JsonlLedger({ ledgersDir })
  return async request => {
    const provider = new pkgs.llm.AnthropicProvider({
      credentials: new pkgs.kernel.LocalCredentials({ env, home }),
      ledger,
      env,
      defaultModel: request.model,
      maxTokens: request.maxTokens,
    })
    let text = ''
    let usage
    let failure
    for await (const event of provider.complete({
      requestId: randomUUID(),
      model: request.model,
      thinking: request.thinking,
      maxTokens: request.maxTokens,
      messages: [{ role: 'system', content: request.system }, { role: 'user', content: request.user }],
    }, { purpose: 'auxiliary' })) {
      if (event.type === 'text.delta') text += event.text
      else if (event.type === 'usage') usage = event.usage
      else if (event.type === 'error') failure = `${event.error.code}: ${event.error.message}`
    }
    if (failure !== undefined) throw new Error(failure)
    const usd = usage === undefined ? 'unknown' : pkgs.llm.estimateUsd(request.model, usage)
    return { text, usd: typeof usd === 'number' && Number.isFinite(usd) ? usd : null }
  }
}

const SCRIPTED_KEY = 'sk-step6-pilot-scripted-key'

/**
 * The scripted backend: a local scripted server answered by `PilotModel` (tasks, jobs,
 * gate and both reviewers, the reviewers through {@link realComplete}). Child processes
 * inherit `process.env`, so the real key (if any) is swapped for the scripted one until
 * `close()`.
 * @param {any} pkgs
 * @param {string} out
 */
async function scriptedBackend(pkgs, out) {
  const harness = await import(repoUrl('packages/test-support/dist/index.js')).catch(error => { throw new Stop(`the test-support harness is not built (${errorText(error)}); run \`pnpm build\``) })
  const { PilotModel } = await import('./scripted-model.mjs')
  const { evidenceFor } = await import(repoUrl('scripts/accept-common/step5-model.mjs'))
  let root = ''
  const model = new PilotModel(harness, { cases: pilotCases(), evidence: text => evidenceFor(root, text) })
  const server = await harness.scriptedModelServer({ script: Array.from({ length: 50_000 }, () => model.entry) })
  const saved = { NEXGENT_API_KEY: process.env.NEXGENT_API_KEY, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, NEXGENT_HOME: process.env.NEXGENT_HOME }
  process.env.NEXGENT_API_KEY = SCRIPTED_KEY
  delete process.env.ANTHROPIC_API_KEY
  const env = { NEXGENT_API_BASE_URL: server.baseUrl, NEXGENT_API_KEY: SCRIPTED_KEY }
  return {
    name: 'scripted',
    model: 'scripted (local scripted server, no model call)',
    createSdk: (/** @type {string} */ home) => {
      process.env.NEXGENT_HOME = home
      return pkgs.sdk.createSdk({ appVersion: 'experiment-step6-pilot-scripted', env: { ...env, NEXGENT_HOME: home }, home, approvalResponder: allowAll })
    },
    complete: realComplete(pkgs, { env, home: join(out, 'homes', 'reviewer'), ledgersDir: join(out, 'reviewer', 'ledgers') }),
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

/** The real backend: the real API, the key from the environment. @param {any} pkgs @param {string} out */
function realBackend(pkgs, out) {
  const saved = process.env.NEXGENT_HOME
  return {
    name: 'real',
    model: `${MODEL.model}, thinking ${MODEL.thinking}`,
    createSdk: (/** @type {string} */ home) => {
      process.env.NEXGENT_HOME = home
      return pkgs.sdk.createSdk({ appVersion: 'experiment-step6-pilot-real', env: { ...process.env, NEXGENT_HOME: home }, home, approvalResponder: allowAll })
    },
    complete: realComplete(pkgs, { env: { ...process.env }, home: join(out, 'homes', 'reviewer'), ledgersDir: join(out, 'reviewer', 'ledgers') }),
    setRoot: () => undefined,
    turnTimeoutMs: 30 * 60_000,
    jobTimeoutMs: 150 * 60_000,
    pollMs: 10_000,
    requests: () => [],
    async close() {
      if (saved === undefined) delete process.env.NEXGENT_HOME
      else process.env.NEXGENT_HOME = saved
    },
  }
}

// ---------------------------------------------------------------------------
// Cost gates

/**
 * Both gates: the step-6 cap and the pilot's own.
 * @param {{ spend: string, cap: number, pilotSpend: string }} ctx
 */
function costGates(ctx) {
  const guard = async (/** @type {number} */ reserve, /** @type {string} */ label) => {
    for (const [file, cap] of /** @type {Array<[string, number]>} */ ([[ctx.spend, ctx.cap], [ctx.pilotSpend, PILOT_GATE_USD]])) {
      const verdict = await gate(file, reserve, cap)
      if (!verdict.ok) throw new Stop(`not starting ${label}: ${verdict.reason}`)
    }
  }
  /** @returns {Promise<string | null>} a note when the cost was unknown */
  const spent = async (/** @type {string} */ label, /** @type {number | null} */ usd, /** @type {number} */ reserve) => {
    const entry = usd === null ? { label: `${label} (unknown, reserve counted)`, usd: reserve } : { label, usd }
    await recordSpend(ctx.spend, entry, ctx.cap)
    await recordSpend(ctx.pilotSpend, entry, PILOT_GATE_USD)
    return usd === null ? `${label}: cost unknown; the cost gates count it as ${reserve} USD` : null
  }
  return { guard, spent }
}

// ---------------------------------------------------------------------------
// The memory arm

/**
 * Write and adopt the `memory` arm's context policy in a project copy, through the
 * `@nexgent/capabilities` store: the adopted bundle's components plus `project-notes`.
 * @param {any} pkgs
 * @param {string} armRoot
 * @param {ReadonlyArray<{ at: string, comment: string }>} entries counted feedback of the family
 */
export async function adoptMemoryPolicy(pkgs, armRoot, entries) {
  const cap = pkgs.capabilities
  const store = new cap.CapabilityStore(join(armRoot, '.nexgent', 'capabilities'))
  const { bundle } = await store.resolveAdopted()
  const existing = bundle.manifest.components
  if (existing.some((/** @type {any} */ c) => c.kind === 'context-policy')) throw new Stop('the base arm already has a context policy; a bundle holds at most one, so the memory arm cannot add its own')
  const inputs = []
  for (const component of existing) inputs.push({ kind: component.kind, name: component.name, files: await cap.readComponentFiles(bundle, component) })
  const { instructions, kept, dropped } = memoryInstructions(entries)
  const policy = `${JSON.stringify({ formatVersion: 1, name: MEMORY_POLICY.name, description: MEMORY_POLICY.description, instructions }, null, 2)}\n`
  const ref = { kind: 'context-policy', name: MEMORY_POLICY.name }
  await cap.validateComponent(ref, new Map([['policy.json', new Uint8Array(Buffer.from(policy, 'utf8'))]]), join(armRoot, '.nexgent', 'capabilities'))
  const stored = await store.write([...inputs, { ...ref, files: [{ path: 'policy.json', content: policy }] }])
  const adopted = await store.adopt(stored.version, { trigger: 'manual', detail: `pilot memory arm: ${kept} counted feedback entries of the family as one context policy (no diagnosis, no gate)` })
  if (adopted === null) throw new Stop('the memory arm\'s adoption lost a race on the activation chain')
  return { version: stored.version, digest: sha256(instructions), kept, dropped, bytes: Buffer.byteLength(instructions) }
}

// ---------------------------------------------------------------------------
// Steps

/**
 * One family of the pilot.
 * @param {any} ctx `{ pkgs, backend, out, spend, cap, pilotSpend, keepRuns, log }`
 * @param {'docs' | 'files'} family
 */
async function runPilotFamily(ctx, family) {
  const { pkgs, backend, log } = ctx
  const cases = pilotCases().filter(c => c.family === family)
  const dir = join(ctx.out, family)
  const root = join(dir, 'project')
  const homeOf = (/** @type {string} */ name) => join(ctx.out, 'homes', name)
  const home = homeOf(family)
  await rm(dir, { recursive: true, force: true })
  await rm(home, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await mkdir(home, { recursive: true })
  backend.setRoot(root)
  const estimate = (/** @type {string} */ model, /** @type {any} */ usage) => pkgs.llm.estimateUsd(model, usage)
  const { guard, spent: record } = costGates(ctx)
  /** @type {any} */
  const obs = { family, root, home, tasks: {}, jobs: [], approvals: [], arms: {}, memory: null, runs: [], agreement: [], pairs: [], components: {}, costs: [], notes: [], checks: {} }
  const spent = async (/** @type {string} */ kind, /** @type {string} */ ref, /** @type {number | null} */ usd, /** @type {number} */ reserve) => {
    const note = await record(`${family}/${ref}`, usd, reserve)
    if (note !== null) obs.notes.push(note)
    obs.costs.push({ kind, family, ref, usd })
  }
  const sdk = backend.createSdk(home)
  let projectId = ''
  let step = 'setup'
  const sessionCost = async (/** @type {string} */ projectRoot, /** @type {string} */ sessionId) => costOf((await ledgerOf(projectRoot)).filter(r => r.sessionId === sessionId && r.improvementId === undefined && r.trialId === undefined), estimate)
  const turn = async (/** @type {any} */ client, /** @type {string} */ pid, /** @type {string} */ sessionId, /** @type {string} */ text) => {
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
    }
  }
  const deliverableOf = async (/** @type {any} */ client, /** @type {string} */ pid, /** @type {string} */ sessionId) => (await client.call('deliverables.list', { projectId: pid }))
    .flatMap((/** @type {any} */ d) => d.versions ?? [])
    .filter((/** @type {any} */ v) => v.sessionId === sessionId)
    .sort((/** @type {any} */ a, /** @type {any} */ b) => a.presentedAt.localeCompare(b.presentedAt))
    .at(-1)
  const doTask = async (/** @type {import('./common.mjs').PilotCase} */ task) => {
    step = task.id
    await guard(PILOT_RESERVE_USD.task, task.id)
    await writeFiles(root, task.files)
    const { sessionId } = await sdk.call('sessions.create', { projectId, title: task.id })
    const result = await turn(sdk, projectId, sessionId, task.message)
    // Feedback attaches to a deliverable: when the turn presented none, the user asks for one.
    let presentRequest
    if (result.reason !== 'error' && (await deliverableOf(sdk, projectId, sessionId)) === undefined) {
      const asked = await turn(sdk, projectId, sessionId, PRESENT_REQUEST)
      presentRequest = { turn: asked.reason, presented: (await deliverableOf(sdk, projectId, sessionId)) !== undefined }
    }
    const judged = await judgePilotCase(task, root)
    const taste = await tasteMet(task, root)
    const usd = await sessionCost(root, sessionId)
    obs.tasks[task.id] = { set: task.set, sessionId, ...result, ...(presentRequest === undefined ? {} : { presentRequest }), judge: judged, tasteMet: taste, costUsd: usd }
    await spent(task.set === 'dev' ? 'dev' : 'history', task.id, usd, PILOT_RESERVE_USD.task)
    log(`${task.id}: ${result.reason}, checks ${judged.points.filter(p => p.by === 'check').map(p => `${p.id}=${p.pass === null ? '?' : p.pass ? 'ok' : 'no'}`).join(' ')}`)
  }
  const jobs = async () => (await pkgs.evolve.listJobs(join(root, '.nexgent', 'improvements')).catch(() => []))
  const awaitJob = async (/** @type {string[]} */ known, /** @type {string} */ label) => {
    const deadline = Date.now() + backend.jobTimeoutMs
    let job
    while (Date.now() < deadline) {
      job = (await jobs()).find((/** @type {any} */ j) => !known.includes(j.id))
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
    obs.arms.base = { root: join(dir, 'arms', 'base'), home: homeOf(`${family}-base`), from: 'the project after the history and dev tasks, before any feedback' }
    await copyProject(root, obs.arms.base.root, { jobs: true })

    /** @type {Array<{ at: string, comment: string }>} */
    const memoryEntries = []
    for (const task of dev) {
      step = `${task.id}: feedback`
      const view = obs.tasks[task.id]
      const { primary, entries } = pilotFeedback(task, view.judge, view.tasteMet)
      view.feedback = []
      view.primary = primary
      if (entries.filter(counts).length === 0) {
        obs.notes.push(`${task.id}: ${entries.length === 0 ? 'a checked point is unknown' : 'every checked point passed'}; no counted feedback, so no job`)
        continue
      }
      await guard(PILOT_RESERVE_USD.feedback * entries.length + PILOT_RESERVE_USD.job, step)
      const deliverable = await deliverableOf(sdk, projectId, view.sessionId)
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
          // A user comments on the latest version: a feedback turn may have presented a new one.
          const latest = (await deliverableOf(sdk, projectId, view.sessionId)) ?? deliverable
          await sdk.call('feedback.submit', { projectId, sessionId: view.sessionId, deliverableId: latest.deliverableId, version: latest.version, ...(entry.rating === undefined ? {} : { rating: entry.rating }), comment: entry.comment })
          if (counts(entry)) memoryEntries.push({ at: new Date().toISOString(), comment: entry.comment })
          const deadline = Date.now() + backend.turnTimeoutMs
          while (Date.now() < deadline && !(events.some(e => e.type === 'turn.end') && !sdk.isRunning(projectId, view.sessionId))) await sleep(100)
        } finally {
          off()
        }
        view.feedback.push({ ...entry, turn: events.find(e => e.type === 'turn.end')?.reason?.kind ?? 'did not end' })
      }
      const after = await sessionCost(root, view.sessionId)
      await spent('feedback', `${task.id}: feedback turns`, after === null || before === null ? null : Math.round((after - before) * 1e6) / 1e6, PILOT_RESERVE_USD.feedback * entries.length)
      let job = await awaitJob(known, `${task.id}: job`)
      if (job.status === 'awaiting-approval' && job.candidateId !== undefined) {
        // ADR 0007 / 0013: a job that waits for the user; the orchestration answers in the user's place, recorded.
        const approved = await sdk.call('capabilities.approve', { projectId, candidateId: job.candidateId, decision: 'allow' }).catch((/** @type {unknown} */ error) => ({ error: errorText(error) }))
        obs.approvals.push({ caseId: task.id, jobId: job.id, candidateId: job.candidateId, result: approved?.status ?? approved?.error })
        job = (await jobs()).find((/** @type {any} */ j) => j.id === job.id) ?? job
      }
      const usd = costOf((await ledgerOf(root)).filter(r => r.improvementId === job.id), estimate)
      obs.jobs.push({ caseId: task.id, jobId: job.id, status: job.status, candidateId: job.candidateId, improverVersion: job.improverVersion, history: (job.history ?? []).map((/** @type {any} */ h) => h.status), detail: job.history?.at(-1)?.detail, costUsd: usd })
      await spent('improvement', `job for ${task.id}`, usd, PILOT_RESERVE_USD.job)
      log(`${task.id}: job ${job.status}`)
    }

    step = 'parent'
    obs.arms.parent = { root: join(dir, 'arms', 'parent'), home: homeOf(`${family}-parent`), from: 'the project after the dev feedback and its improvement jobs (improver v0, epoch adr-0014)' }
    await copyProject(root, obs.arms.parent.root, { jobs: true })
    await rm(obs.arms.parent.home, { recursive: true, force: true })
    await cp(home, obs.arms.parent.home, { recursive: true, filter: source => !source.endsWith('.lock') })

    step = 'memory'
    obs.arms.memory = { root: join(dir, 'arms', 'memory'), home: homeOf(`${family}-memory`), from: 'a copy of base with the counted feedback of the family adopted as one context policy' }
    await copyProject(obs.arms.base.root, obs.arms.memory.root, { jobs: true })
    obs.memory = { entries: memoryEntries.length, ...await adoptMemoryPolicy(pkgs, obs.arms.memory.root, memoryEntries) }
    log(`memory: ${obs.memory.kept} entries kept, ${obs.memory.dropped} dropped, version ${obs.memory.version}`)
    for (const arm of ['base', 'memory']) {
      await rm(obs.arms[arm].home, { recursive: true, force: true })
      await mkdir(obs.arms[arm].home, { recursive: true })
    }

    step = 'checks'
    const roots = [join(root, '.nexgent'), ...PILOT_ARMS.map(arm => join(obs.arms[arm].root, '.nexgent'))]
    const isolation = await checkIsolation(/** @type {any} */ (cases), roots)
    obs.checks.isolation = { leaks: isolation.leaks, scanned: isolation.scanned, skipped: isolation.skipped.length }
    obs.checks.epoch = await pkgs.capabilities.projectEpoch(pkgs.kernel.resolveWorkspaceLayout(root)).catch(() => undefined)
    for (const arm of PILOT_ARMS) {
      const source = obs.arms[arm]
      source.capabilityVersion = await pkgs.capabilities.readActivation(join(source.root, '.nexgent', 'capabilities', 'activation')).then((/** @type {any} */ a) => a.version, () => 'unknown')
      source.improverVersion = await new pkgs.capabilities.ImproverStore(pkgs.capabilities.userImproversDir(arm === 'parent' ? source.home : home)).activation().then((/** @type {any} */ a) => a.version, () => 'unknown')
    }
    obs.components = await adoptedComponents(pkgs, root, obs)
    if (isolation.leaks.length > 0) throw new Stop(`holdout isolation: ${isolation.leaks.length} leaks; no holdout runs`)

    const holdout = cases.filter(c => c.set === 'holdout')
    /** @type {Record<string, string | null>} */
    const docs = {}
    for (const arm of PILOT_ARMS) {
      const source = obs.arms[arm]
      for (const task of holdout) {
        for (let repeat = 1; repeat <= PILOT_REPEATS; repeat += 1) {
          const runId = runIdOf(arm, task.id, repeat)
          step = runId
          await guard(PILOT_RESERVE_USD.holdout, runId)
          const runRoot = join(dir, 'runs', slug(`${arm}-${task.id}-${repeat}`))
          await copyProject(source.root, runRoot, { jobs: false })
          await writeFiles(runRoot, task.files)
          const client = backend.createSdk(source.home)
          /** @type {any} */
          let run
          try {
            const { projectId: pid } = await client.call('projects.open', { root: runRoot })
            await client.call('settings.update', { projectId: pid, patch: { autoImprove: false } })
            const { sessionId } = await client.call('sessions.create', { projectId: pid, title: runId })
            const result = await turn(client, pid, sessionId, task.message)
            // No deliverable: the user asks once (counted per arm, ADR 0011 decision 7).
            let followUp = false
            if (result.reason !== 'error' && (await deliverableOf(client, pid, sessionId)) === undefined) {
              followUp = true
              await turn(client, pid, sessionId, PRESENT_REQUEST)
            }
            const judged = result.reason === 'error' ? null : await judgePilotCase(task, runRoot)
            const ledger = await ledgerOf(runRoot)
            const outcome = ledger.filter(r => r.type === 'task.outcome' && r.sessionId === sessionId).at(-1)
            if (task.family === 'docs') docs[runId] = await readFile(join(runRoot, task.outputs[0]), 'utf8').catch(() => null)
            run = {
              runId, family, caseId: task.id, arm, repeat, judged,
              costUsd: costOf(ledger.filter(r => r.sessionId === sessionId && r.improvementId === undefined && r.trialId === undefined), estimate),
              componentsUsed: (outcome?.componentsUsed ?? []).map((/** @type {any} */ c) => (typeof c === 'string' ? c : `${c.kind}:${c.name}`)).sort(),
              // The capability versions the session's requests ran on (a context policy is in force without being "used").
              capabilityVersions: [...new Set(ledger.filter(r => r.sessionId === sessionId && r.type === 'llm.request.start' && typeof r.capabilityVersion === 'string').map(r => r.capabilityVersion))].sort(),
              turn: result.reason,
              followUp,
              problems: result.reason === 'error' ? [result.error ?? 'turn failed'] : judged?.problems ?? [],
            }
          } finally {
            await client.dispose().catch(() => undefined)
          }
          await spent('holdout', runId, run.costUsd, PILOT_RESERVE_USD.holdout)
          run.outputsKept = await keepOutputs(task, runRoot, join(ctx.out, 'outputs', slug(runId)))
          if (!ctx.keepRuns) await rm(runRoot, { recursive: true, force: true })
          // Review points of documents: the external reviewer scores them; the in-loop reviewer judges the same points, for agreement only.
          if (run.judged !== null && task.rubric.some(p => p.by === 'review')) {
            const doc = docs[runId]
            if (doc === null || doc === undefined) {
              const missing = Object.fromEntries(task.rubric.filter(p => p.by === 'review').map(p => [p.id, { verdict: /** @type {const} */ ('no'), reason: `没有 ${task.outputs[0]}` }]))
              run.judged = withReview(run.judged, missing)
            } else {
              step = `${runId}: review`
              await guard(PILOT_RESERVE_USD.pointReview * 2, step)
              const external = await reviewPoints(ctx.complete, task, doc, EXTERNAL_REVIEWER)
              await spent('review', `${runId}: external review`, external.usd, PILOT_RESERVE_USD.pointReview)
              const inLoop = await reviewPoints(ctx.complete, task, doc, IN_LOOP_REVIEWER)
              await spent('review', `${runId}: in-loop review`, inLoop.usd, PILOT_RESERVE_USD.pointReview)
              run.judged = withReview(run.judged, external.verdicts)
              for (const point of task.rubric.filter(p => p.by === 'review')) {
                const verdictOf = (/** @type {any} */ v) => (v === null || v[point.id] === undefined ? null : v[point.id].verdict === 'yes')
                obs.agreement.push({ runId, pointId: point.id, external: verdictOf(external.verdicts), inLoop: verdictOf(inLoop.verdicts) })
              }
            }
          }
          obs.runs.push(run)
          log(`${runId}: rate ${run.judged?.rate ?? 'unknown'}${run.followUp ? ' (follow-up)' : ''}`)
        }
      }
    }

    for (const task of holdout.filter(t => t.family === 'docs')) {
      step = `${task.id}: parent vs memory`
      const first = docs[runIdOf('parent', task.id, 1)]
      const second = docs[runIdOf('memory', task.id, 1)]
      if (typeof first !== 'string' || typeof second !== 'string') {
        obs.pairs.push({ caseId: task.id, first: 'parent', second: 'memory', ab: null, ba: null, missing: true })
        continue
      }
      await guard(PILOT_RESERVE_USD.pairReview, step)
      const judged = await comparePair(ctx.complete, task, first, second)
      await spent('review', `${task.id}: parent vs memory`, judged.usd, PILOT_RESERVE_USD.pairReview)
      obs.pairs.push({ caseId: task.id, first: 'parent', second: 'memory', ab: judged.ab, ba: judged.ba, replies: judged.replies })
    }
  } catch (error) {
    if (error instanceof Stop) obs.stopped = { step, reason: error.message }
    else obs.error = { step, message: error instanceof Error ? (error.stack ?? error.message) : String(error) }
    log(`${family} stopped at ${step}: ${errorText(error)}`)
  } finally {
    await sdk.dispose().catch(() => undefined)
  }
  return obs
}

/**
 * Adopted components of the memory and parent arms (base runs on what the history left),
 * by class, and their instance-literal rate against the dev jobs' sources (ADR 0013).
 * @param {any} pkgs
 * @param {string} root
 * @param {any} obs
 */
async function adoptedComponents(pkgs, root, obs) {
  const layout = pkgs.kernel.resolveWorkspaceLayout(root)
  /** @type {any[]} */
  const sources = []
  for (const job of obs.jobs) sources.push(...(await pkgs.capabilities.jobLiteralSources(layout, job.jobId).catch(() => undefined) ?? []))
  const messages = await pkgs.capabilities.projectTaskMessages(layout).catch(() => [])
  /** @type {Record<string, any>} */
  const out = {}
  for (const arm of PILOT_ARMS) {
    const store = new pkgs.capabilities.CapabilityStore(join(obs.arms[arm].root, '.nexgent', 'capabilities'))
    const { bundle } = await store.resolveAdopted()
    const components = []
    for (const component of bundle.manifest.components) {
      const files = new Map((await pkgs.capabilities.readComponentFiles(bundle, component)).map((/** @type {any} */ f) => [f.path, f.content]))
      const texts = pkgs.capabilities.componentLiteralTexts(files)
      const policy = component.kind === 'context-policy' ? JSON.parse(String(texts.find((/** @type {any} */ t) => t.path === 'policy.json')?.text ?? '{}')) : undefined
      components.push({ kind: component.kind, name: component.name, class: componentClass({ kind: component.kind, text: policy?.instructions }), texts: texts.map((/** @type {any} */ t) => ({ path: `${component.kind}/${component.name}/${t.path}`, text: t.text })) })
    }
    const literal = literalRate(components.map(c => ({ name: `${c.kind}:${c.name}`, texts: c.texts, sources, projectMessages: messages })), pkgs.kernel.findInstanceLiterals)
    out[arm] = { components: components.map(c => ({ kind: c.kind, name: c.name, class: c.class })), literal }
  }
  return out
}

// ---------------------------------------------------------------------------
// Records

/** Path relative to the output directory, `/`-separated. @param {string} out @param {string} path */
const rel = (out, path) => relative(out, path).split('\\').join('/')

/**
 * Copy a holdout run's deliverables (the case's output paths, files or folders) to `dest`
 * before the run's copy is removed, so the documents the reviewers judged can be read later.
 * Returns the kept paths (absolute; the raw records make them relative to the output folder).
 * @param {{ outputs: string[] }} task
 * @param {string} runRoot
 * @param {string} dest
 */
export async function keepOutputs(task, runRoot, dest) {
  const kept = []
  for (const path of task.outputs) {
    const target = join(dest, path)
    await mkdir(dirname(target), { recursive: true })
    try {
      await cp(join(runRoot, path), target, { recursive: true })
      kept.push(target)
    } catch (error) {
      if (/** @type {any} */ (error)?.code !== 'ENOENT') throw error
    }
  }
  return kept
}

/**
 * The raw records (report.mjs's input). Everything here is the same on a rerun with the same
 * answers: no time, no session or job id, paths relative to the output directory.
 * @param {any[]} families
 * @param {{ out: string, backend: string, model: string, planSha256: string, judges: any, referencePairs: any[], notes: string[] }} meta
 */
export function pilotRawRecords(families, meta) {
  const notes = [...meta.notes]
  for (const f of families) {
    for (const note of f.notes) notes.push(`${f.family}: ${note}`)
    if (f.stopped !== undefined) notes.push(`${f.family}: stopped at ${f.stopped.step}: ${f.stopped.reason}`)
    if (f.error !== undefined) notes.push(`${f.family}: error at ${f.error.step}: ${String(f.error.message).split('\n')[0]}`)
    for (const a of f.approvals) notes.push(`${f.family}: the job for ${a.caseId} awaited approval; the orchestration allowed it in the user's place (${a.result})`)
  }
  return {
    pilotId: PILOT_ID,
    planSha256: meta.planSha256,
    backend: meta.backend,
    model: meta.model,
    reviewers: { external: EXTERNAL_REVIEWER, inLoop: IN_LOOP_REVIEWER },
    epochs: Object.fromEntries(families.map(f => [f.family, f.checks?.epoch ?? null])),
    arms: Object.fromEntries(families.map(f => [f.family, Object.fromEntries(PILOT_ARMS.filter(arm => f.arms[arm] !== undefined).map(arm => [arm, {
      home: rel(meta.out, f.arms[arm].home), capabilityVersion: f.arms[arm].capabilityVersion ?? null, improverVersion: f.arms[arm].improverVersion ?? null,
    }]))])),
    memory: Object.fromEntries(families.map(f => [f.family, f.memory === null ? null : { version: f.memory.version, digest: f.memory.digest, entries: f.memory.entries, kept: f.memory.kept, dropped: f.memory.dropped, bytes: f.memory.bytes }])),
    jobs: Object.fromEntries(families.map(f => [f.family, f.jobs.map((/** @type {any} */ j) => ({ caseId: j.caseId, status: j.status, improverVersion: j.improverVersion ?? null, history: j.history }))])),
    dev: Object.fromEntries(families.map(f => [f.family, Object.entries(f.tasks).filter(([, t]) => /** @type {any} */ (t).set === 'dev').map(([caseId, t]) => ({
      caseId, primary: /** @type {any} */ (t).primary ?? null, feedback: (/** @type {any} */ (t).feedback ?? []).map((/** @type {any} */ e) => ({ rating: e.rating ?? null, comment: e.comment })),
    }))])),
    isolation: Object.fromEntries(families.map(f => [f.family, f.checks?.isolation === undefined ? null : { leaks: f.checks.isolation.leaks.length, scanned: f.checks.isolation.scanned, skipped: f.checks.isolation.skipped }])),
    judges: meta.judges,
    referencePairs: meta.referencePairs,
    armPairs: families.flatMap(f => f.pairs.map((/** @type {any} */ p) => ({ family: f.family, ...p }))),
    agreement: families.flatMap(f => f.agreement),
    components: Object.fromEntries(families.map(f => [f.family, f.components])),
    runs: families.flatMap(f => f.runs.map((/** @type {any} */ r) => ({
      runId: r.runId, family: r.family, caseId: r.caseId, arm: r.arm, repeat: r.repeat,
      rate: r.judged?.rate ?? null, pass: r.judged?.pass ?? null,
      unclear: (r.judged?.points ?? []).filter((/** @type {any} */ p) => p.unclear === true).length,
      points: (r.judged?.points ?? []).map((/** @type {any} */ p) => ({ id: p.id, type: p.type, by: p.by, pass: p.pass, ...(p.unclear === true ? { unclear: true } : {}), ...(typeof p.detail === 'string' ? { detail: p.detail } : {}) })),
      outputs: r.outputsKept === undefined ? [] : r.outputsKept.map((/** @type {string} */ path) => rel(meta.out, path)),
      costUsd: r.costUsd, componentsUsed: r.componentsUsed, capabilityVersions: r.capabilityVersions ?? [], followUp: r.followUp === true, turn: r.turn,
    }))),
    costs: families.flatMap(f => f.costs),
    notes,
  }
}

// ---------------------------------------------------------------------------
// Entry point

/**
 * Run the pilot.
 * @param {{ backend: 'scripted' | 'real', out: string, families?: string[], spend?: string, cap?: number, keepRuns?: boolean, log?: (line: string) => void }} options
 * @returns {Promise<{ code: number, reason?: string, report?: string }>}
 */
export async function runPilot(options) {
  const log = options.log ?? (line => process.stderr.write(`${line}\n`))
  if (options.backend === 'real' && !realKeyPresent()) return { code: 2, reason: 'no model key in the environment (NEXGENT_API_KEY or ANTHROPIC_API_KEY); nothing was run' }
  const fresh = await planText()
  const current = (await readFile(PLAN_FILE, 'utf8').catch(() => '')).replace(/\r\n/g, '\n')
  const planCurrent = fresh === current
  if (options.backend === 'real' && !planCurrent) return { code: 2, reason: `${basename(PLAN_FILE)} is missing or not current (plan.mjs --check); the pilot runs only on the frozen plan` }
  const loaded = await loadPilotPackages()
  if (!loaded.ok) return { code: 2, reason: loaded.reason }
  const out = resolve(options.out)
  await mkdir(out, { recursive: true })
  const spend = options.spend === undefined ? join(out, 'spend.json') : resolve(options.spend)
  const pilotSpend = join(out, 'pilot-spend.json')
  const cap = options.cap ?? STEP6_CAP_USD
  let backend
  try {
    backend = options.backend === 'scripted' ? await scriptedBackend(loaded.pkgs, out) : realBackend(loaded.pkgs, out)
  } catch (error) {
    return { code: 2, reason: errorText(error) }
  }
  const ctx = { pkgs: loaded.pkgs, backend, complete: backend.complete, out, spend, cap, pilotSpend, keepRuns: options.keepRuns === true, log }
  const startedAt = new Date().toISOString()
  // Not frozen yet (a rehearsal): the hash of a fresh build, so the records still say which plan they ran on.
  const planHash = planCurrent ? await planSha256() : createHash('sha256').update(fresh).digest('hex')
  const notes = planCurrent ? [] : [`${basename(PLAN_FILE)} was missing or not current when this run started (rehearsal only; the real pilot refuses to start)`]
  try {
    const cases = pilotCases()
    const judges = await checkJudges(cases)
    const judgeSummary = { pass: judges.pass, samples: judges.results.length, failed: judges.results.filter(r => !r.ok).map(r => `${r.caseId} ${r.sample}: ${r.detail}`), uncovered: judges.uncovered }
    log(`criterion 1: ${judges.pass ? 'all correct' : 'failed'} (${judges.results.length} samples)`)
    /** @type {any[]} */
    const families = []
    /** @type {any[]} */
    const refs = []
    if (!judges.pass) {
      notes.push('reliability criterion 1 failed: the pilot stopped before any model call')
    } else {
      const { guard, spent } = costGates(ctx)
      try {
        for (const pair of pilotReferencePairs()) {
          await guard(PILOT_RESERVE_USD.pairReview, `reference pair ${pair.id}`)
          const task = /** @type {any} */ (cases.find(c => c.id === pair.caseId))
          const judged = await comparePair(ctx.complete, task, pair.good, pair.bad)
          const note = await spent(`reference pair ${pair.id}`, judged.usd, PILOT_RESERVE_USD.pairReview)
          if (note !== null) notes.push(note)
          refs.push({ id: pair.id, caseId: pair.caseId, flaw: pair.flaw, ab: judged.ab, ba: judged.ba, replies: judged.replies, usd: judged.usd })
          log(`reference pair ${pair.id}: ${judged.ab} / ${judged.ba}`)
        }
      } catch (error) {
        if (!(error instanceof Stop)) throw error
        notes.push(`reference pairs stopped: ${error.message}`)
      }
      for (const family of options.families ?? [...PILOT_FAMILIES]) families.push(await runPilotFamily(ctx, /** @type {any} */ (family)))
    }
    const raw = pilotRawRecords(families, {
      out, backend: backend.name, model: backend.model, planSha256: planHash, judges: judgeSummary,
      referencePairs: refs.map(r => ({ id: r.id, caseId: r.caseId, flaw: r.flaw, ab: r.ab, ba: r.ba, replies: r.replies })), notes,
    })
    raw.costs.push(...refs.map(r => ({ kind: 'review', family: 'docs', ref: `reference pair ${r.id}`, usd: r.usd })))
    const report = buildPilotReport(raw)
    await writeFile(join(out, 'raw.json'), `${JSON.stringify(raw, null, 2)}\n`)
    await writeFile(join(out, 'report.md'), report)
    await writeFile(join(out, 'observations.json'), `${JSON.stringify(families, null, 1)}\n`)
    await writeFile(join(out, 'manifest.json'), `${JSON.stringify({
      pilotId: PILOT_ID, planFile: PLAN_FILE_REL, planSha256: planHash, planCurrent,
      backend: backend.name, model: backend.model, reviewers: { external: EXTERNAL_REVIEWER, inLoop: IN_LOOP_REVIEWER },
      startedAt, finishedAt: new Date().toISOString(), platform: process.platform, node: process.version,
      repeats: PILOT_REPEATS, capUsd: cap, pilotGateUsd: PILOT_GATE_USD, spendFile: spend, spentUsd: spentUsd(await readSpend(spend, cap)), pilotSpentUsd: spentUsd(await readSpend(pilotSpend, PILOT_GATE_USD)),
      families: families.map(f => ({
        family: f.family, stopped: f.stopped, error: f.error?.message?.split('\n')[0], epoch: f.checks?.epoch,
        arms: Object.fromEntries(Object.entries(f.arms).map(([arm, a]) => [arm, { NEXGENT_HOME: /** @type {any} */ (a).home, root: /** @type {any} */ (a).root, from: /** @type {any} */ (a).from, capabilityVersion: /** @type {any} */ (a).capabilityVersion, improverVersion: /** @type {any} */ (a).improverVersion }])),
        memory: f.memory === null ? null : { policy: MEMORY_POLICY.name, capabilityVersion: f.memory.version, instructionsSha256: f.memory.digest, entries: f.memory.entries, kept: f.memory.kept, dropped: f.memory.dropped },
        jobs: f.jobs.map((/** @type {any} */ j) => ({ caseId: j.caseId, jobId: j.jobId, status: j.status, improverVersion: j.improverVersion, detail: j.detail })),
        isolation: f.checks?.isolation,
      })),
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

/** @param {string[]} argv */
export function parsePilotArgs(argv) {
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
  for (const f of families ?? []) if (!PILOT_FAMILIES.includes(/** @type {any} */ (f))) problems.push(`unknown family ${f}`)
  const capText = value('--cap')
  const cap = capText === undefined ? undefined : Number(capText)
  if (cap !== undefined && (!Number.isFinite(cap) || cap <= 0)) problems.push('--cap must be a positive number')
  return {
    options: { backend: /** @type {'scripted' | 'real'} */ (backend), out: /** @type {string} */ (out), families, cap, spend: value('--spend'), keepRuns: flag('--keep-runs') },
    problems,
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { options, problems } = parsePilotArgs(process.argv.slice(2))
  if (problems.length > 0) {
    process.stderr.write(`${problems.join('\n')}\nusage: pilot/run.mjs (--scripted | --real) --out <dir> [--spend <file>] [--cap <usd>] [--families docs,files] [--keep-runs]\n`)
    process.exitCode = 2
  } else {
    runPilot(options).then(result => {
      if (result.reason !== undefined) process.stderr.write(`${result.reason}\n`)
      process.exitCode = result.code
    }, error => {
      process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
      process.exitCode = 1
    })
  }
}
