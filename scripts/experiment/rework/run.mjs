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
 *              when a learning arm can run; half of each family's cases get template
 *              feedback (feedback.mjs), whose counted entries become the notes policy
 *   isolation  no held-out case's fingerprint, message or folder anywhere in the stream's
 *              projects, its home or the notes text (a leak stops before any holdout run)
 *   arms       per arm, a template project (and home) the holdout runs copy: base and
 *              format and notes on the product as it is; learning arms only when their
 *              adapter exists (arms.mjs), else recorded as unavailable and skipped;
 *              `--stand-in` (rehearsal only) gives them a fixed policy instead, marked
 *   holdout    every held-out case × arm × repeat in a fresh copy of the arm's template,
 *              new session, learning off; no deliverable → the user asks once (counted);
 *              the deterministic judge scores; the external reviewer judges repeat 1 of
 *              every case and arm for the report only
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
import { gate, recordSpend } from '../step6/budget.mjs'
import { PRESENT_REQUEST } from '../step6/cases.mjs'
import { keepOutputs, realComplete } from '../step6/pilot/run.mjs'
import { allowAll, copyProject, costOf, ledgerOf, loadPackages, MODEL, realKeyPresent, runIdOf, slug, TASK_CAPS } from '../step6/run.mjs'
import { ARMS, armSupport, FORMAT_POLICY, STAND_IN_POLICY } from './arms.mjs'
import { allCases, caseById, feedbackCases, holdoutIsolation, judgeCase, trainingOrder } from './cases.mjs'
import { listFiles, readText, sha256, writeFiles } from './common.mjs'
import { caseFeedback, counts, NOTES_POLICY, notesInstructions } from './feedback.mjs'
import { checkJudges } from './judges.mjs'
import { ORCHESTRATION_SCRIPTS, PLAN_FILE, PLAN_FILE_REL, planSha256, planText, PROFILES, scriptHashes } from './plan.mjs'
import { buildReport } from './report.mjs'
import { deliveredFiles, reviewRun } from './reviewer.mjs'
import { agreement, comparisons, criteria, literalRate } from './stats.mjs'

/** Estimated USD set aside before each step (frozen in the plan). */
export const RESERVE_USD = Object.freeze({ task: 0.4, feedback: 0.15, holdout: 0.4, review: 0.08 })

const errorText = (/** @type {unknown} */ error) => (error instanceof Error ? error.message : String(error))
const repoUrl = (/** @type {string} */ path) => new URL(`../../../${path}`, import.meta.url).href
const sleep = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms))

class Stop extends Error {}

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

/**
 * Adopt one context policy in a project through the `@nexgent/capabilities` store (the
 * pilot's memory-arm path, generalised): the adopted bundle's components plus this policy.
 * @param {any} pkgs @param {string} root @param {{ name: string, description: string, instructions: string }} policy @param {string} detail
 */
export async function adoptPolicy(pkgs, root, policy, detail) {
  const cap = pkgs.capabilities
  const store = new cap.CapabilityStore(join(root, '.nexgent', 'capabilities'))
  const { bundle } = await store.resolveAdopted()
  const existing = bundle.manifest.components
  if (existing.some((/** @type {any} */ c) => c.kind === 'context-policy')) throw new Stop('the project already has a context policy; a bundle holds at most one')
  const inputs = []
  for (const component of existing) inputs.push({ kind: component.kind, name: component.name, files: await cap.readComponentFiles(bundle, component) })
  const text = `${JSON.stringify({ formatVersion: 1, name: policy.name, description: policy.description, instructions: policy.instructions }, null, 2)}\n`
  const ref = { kind: 'context-policy', name: policy.name }
  await cap.validateComponent(ref, new Map([['policy.json', new Uint8Array(Buffer.from(text, 'utf8'))]]), join(root, '.nexgent', 'capabilities'))
  const stored = await store.write([...inputs, { ...ref, files: [{ path: 'policy.json', content: text }] }])
  const adopted = await store.adopt(stored.version, { trigger: 'manual', detail })
  if (adopted === null) throw new Stop('a policy adoption lost a race on the activation chain')
  return { version: stored.version, sha256: sha256(policy.instructions), bytes: Buffer.byteLength(policy.instructions) }
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
  const obs = { home, learning, projects: /** @type {Record<string, string>} */ ({}), tasks: /** @type {any[]} */ ([]), notesEntries: /** @type {Array<{ at: string, comment: string, caseId: string }>} */ ([]) }
  const withFeedback = new Set(feedbackCases())
  try {
    for (const id of trainingOrder(profile.families)) {
      const task = caseById(id)
      const root = join(ctx.out, 'stream', 'projects', task.family)
      if (projects[task.family] === undefined) {
        await mkdir(root, { recursive: true })
        projects[task.family] = (await sdk.call('projects.open', { root, create: true })).projectId
        await sdk.call('settings.update', { projectId: projects[task.family], patch: settingsPatch(learning) })
        obs.projects[task.family] = root
      }
      const projectId = projects[task.family]
      await ctx.guard(RESERVE_USD.task, id)
      await writeFiles(root, task.files)
      const { sessionId } = await sdk.call('sessions.create', { projectId, title: `task ${obs.tasks.length + 1}` })
      const result = await turn(sdk, projectId, sessionId, task.message, backend.turnTimeoutMs)
      let followUp = false
      if (result.reason !== 'error' && (await deliverableOf(sdk, projectId, sessionId)) === undefined) {
        followUp = true
        await turn(sdk, projectId, sessionId, PRESENT_REQUEST, backend.turnTimeoutMs)
      }
      const judged = await judgeCase(task, root)
      /** @type {any} */
      const record = { caseId: id, family: task.family, turn: result.reason, followUp, score: judged.score, pass: judged.pass, points: judged.points.map(p => ({ id: p.id, type: p.type, pass: p.pass })), feedback: [] }
      if (withFeedback.has(id)) {
        const { entries } = caseFeedback(task, judged)
        const deliverable = await deliverableOf(sdk, projectId, sessionId)
        if (deliverable === undefined) record.feedbackSkipped = 'no deliverable, even when asked'
        for (const entry of deliverable === undefined ? [] : entries) {
          await ctx.guard(RESERVE_USD.feedback, `${id}: feedback`)
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
          record.feedback.push({ rating: entry.rating ?? null, comment: entry.comment, counted: counts(entry) })
        }
      }
      record.costUsd = costOf((await ledgerOf(root)).filter(r => r.sessionId === sessionId), ctx.estimate)
      await ctx.spent(`stream ${id}`, record.costUsd, RESERVE_USD.task + RESERVE_USD.feedback * record.feedback.length)
      obs.tasks.push(record)
      log(`stream ${id}: score ${judged.score ?? 'unknown'}${record.feedback.length > 0 ? `, ${record.feedback.length} feedback entries` : ''}`)
    }
  } finally {
    await sdk.dispose().catch(() => undefined)
  }
  return obs
}

/**
 * The template project (and home) of an arm, which every holdout run of the arm copies.
 * @param {any} ctx @param {string} arm @param {{ notes: string, standIn: boolean, streamHome: string }} inputs
 */
async function armTemplate(ctx, arm, inputs) {
  const root = join(ctx.out, 'arms', slug(arm), 'project')
  const home = join(ctx.out, 'homes', `arm-${slug(arm)}`)
  await rm(join(ctx.out, 'arms', slug(arm)), { recursive: true, force: true })
  await rm(home, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await mkdir(home, { recursive: true })
  const sdk = ctx.backend.createSdk(home)
  try {
    const { projectId } = await sdk.call('projects.open', { root, create: true })
    await sdk.call('settings.update', { projectId, patch: settingsPatch(false) })
  } finally {
    await sdk.dispose().catch(() => undefined)
  }
  /** @type {any} */
  const info = { arm, root, home, standIn: false, policy: null }
  if (arm === 'format') info.policy = { name: FORMAT_POLICY.name, ...await adoptPolicy(ctx.pkgs, root, FORMAT_POLICY, 'rework format arm: empty handbook frame') }
  else if (arm === 'notes') info.policy = { name: NOTES_POLICY.name, ...await adoptPolicy(ctx.pkgs, root, { name: NOTES_POLICY.name, description: NOTES_POLICY.description, instructions: inputs.notes }, 'rework notes arm: counted feedback of the training stream, verbatim') }
  else if (arm !== 'base') {
    if (!inputs.standIn) throw new Error(`no adapter for ${arm}`)
    info.standIn = true
    const instructions = `${STAND_IN_POLICY.title}：${arm}\n\n这是演练用的固定文字，不是学到的内容。\n`
    info.policy = { name: STAND_IN_POLICY.name, ...await adoptPolicy(ctx.pkgs, root, { name: STAND_IN_POLICY.name, description: STAND_IN_POLICY.description, instructions }, `rework rehearsal stand-in for ${arm}`) }
  }
  info.capabilityVersion = await ctx.pkgs.capabilities.readActivation(join(root, '.nexgent', 'capabilities', 'activation')).then((/** @type {any} */ a) => a.version, () => 'none')
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
  await copyProject(template.root, runRoot, { jobs: false })
  await rm(runHome, { recursive: true, force: true })
  await cp(template.home, runHome, { recursive: true, filter: source => !source.endsWith('.lock') })
  await writeFiles(runRoot, task.files)
  const client = ctx.backend.createSdk(runHome)
  /** @type {any} */
  let run
  try {
    const { projectId } = await client.call('projects.open', { root: runRoot })
    const { sessionId } = await client.call('sessions.create', { projectId, title: 'task' })
    const result = await turn(client, projectId, sessionId, task.message, ctx.backend.turnTimeoutMs)
    let followUp = false
    if (result.reason !== 'error' && (await deliverableOf(client, projectId, sessionId)) === undefined) {
      followUp = true
      await turn(client, projectId, sessionId, PRESENT_REQUEST, ctx.backend.turnTimeoutMs)
    }
    const judged = result.reason === 'error' ? null : await judgeCase(task, runRoot)
    const ledger = await ledgerOf(runRoot)
    run = {
      runId, family: task.family, caseId: task.id, arm: template.arm, repeat, standIn: template.standIn,
      score: judged?.score ?? null, pass: judged?.pass ?? null,
      points: judged?.points.map(p => ({ id: p.id, type: p.type, weight: p.weight, pass: p.pass, detail: p.detail })) ?? [],
      costUsd: costOf(ledger.filter(r => r.sessionId === sessionId), ctx.estimate),
      capabilityVersions: [...new Set(ledger.filter(r => r.sessionId === sessionId && r.type === 'llm.request.start' && typeof r.capabilityVersion === 'string').map(r => r.capabilityVersion))].sort(),
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
    const notesText = notesInstructions(obs.stream.notesEntries)
    await writeFile(join(out, 'stream', 'notes-policy.txt'), notesText.instructions)
    obs.notes = { entries: obs.stream.notesEntries.length, kept: notesText.kept, dropped: notesText.dropped, sha256: sha256(notesText.instructions) }

    step = 'isolation'
    const roots = [join(out, 'stream'), obs.stream.home]
    obs.isolation = await holdoutIsolation(roots, cases)
    log(`isolation: ${obs.isolation.leaks.length} leaks over ${obs.isolation.scanned} files`)
    if (obs.isolation.leaks.length > 0) throw new Stop(`holdout isolation: ${obs.isolation.leaks.length} leaks; no holdout runs`)

    for (const arm of profile.arms) {
      step = `arm ${arm}`
      const available = support[/** @type {import('./arms.mjs').Arm} */ (arm)]
      if (!available.available && !options.standIn) {
        obs.arms[arm] = { arm, status: 'unavailable', reason: available.reason }
        log(`arm ${arm}: unavailable`)
        continue
      }
      const template = await armTemplate(ctx, arm, { notes: notesText.instructions, standIn: !available.available, streamHome: obs.stream.home })
      obs.arms[arm] = { ...template, status: template.standIn ? 'stand-in' : 'ran' }
      for (const task of holdout) {
        for (let repeat = 1; repeat <= profile.repeats; repeat += 1) {
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
          log(`${run.runId}: score ${run.score ?? 'unknown'}${run.followUp ? ' (follow-up)' : ''}`)
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
    arms: Object.fromEntries(Object.entries(obs.arms).map(([arm, a]) => [arm, { status: a.status, reason: a.reason ?? null, home: a.home === undefined ? null : rel(out, a.home), capabilityVersion: a.capabilityVersion ?? null, policy: a.policy ?? null }])),
    stream: obs.stream === undefined ? null : { home: rel(out, obs.stream.home), learning: obs.stream.learning, projects: Object.fromEntries(Object.entries(obs.stream.projects).map(([f, p]) => [f, rel(out, String(p))])) },
    spend: { file: options.spend === undefined ? 'spend.json' : 'external', gateUsd: PROFILES[/** @type {keyof typeof PROFILES} */ (options.profile)].gateUsd, usd: Math.round((spend.entries ?? []).reduce((/** @type {number} */ s, /** @type {any} */ e) => s + e.usd, 0) * 1e6) / 1e6 },
    scriptedRequests: backend.name === 'scripted' ? countKinds(backend.requests()) : undefined,
  }, null, 2)}\n`)
  await writeFile(join(out, 'observations.json'), `${JSON.stringify({ stopped: obs.stopped, error: obs.error, notes }, null, 2)}\n`)
  return { code: obs.error === null ? 0 : 1, report }
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
  const runs = obs.runs.map((/** @type {any} */ r) => ({ ...r }))
  const compared = comparisons(runs)
  const trainCases = (obs.stream?.tasks ?? []).map((/** @type {any} */ t) => caseById(t.caseId))
  const sources = []
  for (const task of trainCases) for (const [path, content] of Object.entries(task.files)) if (typeof content === 'string') sources.push({ kind: /** @type {const} */ ('deliverable'), ref: `input:${task.id}/${path}`, text: content })
  for (const task of obs.stream?.tasks ?? []) for (const entry of task.feedback) sources.push({ kind: /** @type {const} */ ('feedback'), ref: `feedback:${task.caseId}`, text: entry.comment })
  const messages = trainCases.map((/** @type {any} */ task) => ({ taskId: task.id, text: task.message }))
  const notesLiteral = literalRate((obs.stream?.notesEntries ?? []).map((/** @type {any} */ e, /** @type {number} */ i) => ({ name: `notes#${i + 1}`, texts: [{ path: 'policy.json', text: e.comment }] })), sources, messages, meta.pkgs.kernel.findInstanceLiterals)
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
    stream: obs.stream === undefined ? null : { learning: obs.stream.learning, tasks: obs.stream.tasks.map((/** @type {any} */ t) => ({ ...t })) },
    notes: obs.notes ?? null,
    isolation: obs.isolation === undefined ? null : { leaks: obs.isolation.leaks, scanned: obs.isolation.scanned, skipped: obs.isolation.skipped.length },
    arms: Object.fromEntries(Object.entries(obs.arms).map(([arm, a]) => [arm, { status: /** @type {any} */ (a).status, reason: /** @type {any} */ (a).reason ?? null, standIn: /** @type {any} */ (a).standIn ?? false }])),
    runs,
    reviews: obs.reviews,
    agreement: agreement(obs.reviews),
    learned: {
      notes: notesLiteral,
      // Learning arms' texts come from their adapters (V1/V2 stores) once they exist.
      learningArms: null,
      costOptimized: null,
    },
    comparisons: compared,
    criteria: criteria(compared, { literalRate: null, costOptimized: null }),
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
    runRework(options).then(result => {
      if (result.reason !== undefined) process.stderr.write(`${result.reason}\n`)
      process.exit(result.code)
    }, error => {
      process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
      process.exit(1)
    })
  }
}
