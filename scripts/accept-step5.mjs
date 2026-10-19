#!/usr/bin/env node
/**
 * Step 5 acceptance (docs/plan/step-5-work-partition.md §`accept-step5`
 * 检查项清单): three layers of checks, all judged by this script from files,
 * session records, ledger lines, job records and process state.
 *
 *   headless  H01–H19  scripted model server, through @nexgent/sdk as shipped: H19 (step 4's H01–H19,
 *                      with step 3's H01–H23 inside, over fresh runs of step 4's headless and gate
 *                      scenarios); H01–H18 from the step-5 scenario (accept-common/step5-headless.mjs):
 *                      the feedback project and its improvement job end to end (the SDK's own job
 *                      entry, the gate, the next task in a new process), the triggers, the switch,
 *                      explicit runs, the budget, waiting for history, concurrency and recovery;
 *                      the fixture itself is recorded as a named check
 *   desktop   D01–D23  D01–D18: steps 2–4's desktop scenarios and judges, as a regression;
 *                      D19–D23: the 改进 page, the deliverable's 改进 button and the settings
 *   real      R01–R08  real Claude model, thinking on (scripts/real-task/step5-orders.mjs,
 *                      accept-common/step5-real.mjs): history tasks, the feedback task and its
 *                      feedback, the job it starts, the gate, the next task in a new process, the
 *                      costs; R07 a second job; R07 and R08 (Windows, a manual run) never decide the exit
 *
 * Usage:
 *   node scripts/accept-step5.mjs [--layer headless,desktop|real|all] [--out <summary.json>]
 *     [--work-dir <empty dir>] [--budget-usd 15] [--spent <earlier-runs.json>]
 *
 * Writes a summary JSON (test-support schema, fields of docs/validation/TEMPLATE.md);
 * every checklist item appears with its id and status passed / failed / not-implemented.
 *
 * Exit codes: 0 every selected item passed; 1 an item failed; 2 not runnable
 * yet (an item not implemented, or a layer's prerequisites missing) — never a
 * fake pass.
 *
 * The real layer reads the key from NEXGENT_API_KEY (fallback ANTHROPIC_API_KEY) into
 * the SDK's in-process env only; the job, gate and next-task processes inherit it from
 * the environment. It is never printed or written. With NEXGENT_API_BASE_URL on a
 * loopback address the run is not real-model evidence. Linux, macOS and
 * Windows; no shell, no Python.
 */
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { judgeRegionTable } from './real-task/step5-orders.mjs'
import { loadHarness, REPO_ROOT } from './accept-common/harness.mjs'
import { desktopPrerequisites, runDesktopScenario } from './accept-common/step2-desktop.mjs'
import { isLoopbackUrl, loadStep2Packages } from './accept-common/step2-runtime.mjs'
import { runMembersDesktopScenario } from './accept-common/step3-desktop.mjs'
import { runHeadlessScenario as runStep3Headless } from './accept-common/step3-headless.mjs'
import { runCapabilitiesDesktopScenario } from './accept-common/step4-desktop.mjs'
import { realPrerequisites } from './accept-common/step4-real.mjs'
import { runRealScenario } from './accept-common/step5-real.mjs'
import { runImprovementsDesktopScenario } from './accept-common/step5-desktop.mjs'
import { judgeFeedbackProject } from './accept-common/step5-judges.mjs'
import {
  CHECKS,
  decideExit,
  evaluateItem,
  EXIT_FAIL,
  EXIT_NOT_READY,
  LAYERS,
  OPTIONAL_CHECKS,
  parseLayers,
  REAL_MODEL,
} from './accept-common/step5-checks.mjs'

// ADR 0018 (rework E1) retired the counting path these checks exercise; keep it on for them until
// the rework's T1 list retires or rewrites them (inherited by in-process SDKs and child processes).
process.env.NEXGENT_LEGACY_COUNTING ??= '1'

const STEP = {
  step: 5,
  name: '默认反馈改进流程',
  exitCriteria: [
    '反馈触发的改进作业自动开始：3 条计入的反馈后作业开始，诊断合 schema，提案产出一个候选，全程不点名能力工具',
    '门控接反馈：回放集含反馈任务，反馈检查与确定性检查分开记录，结论如实写进作业记录',
    '采用后被使用：新 OS 进程里的下一次同类任务自动加载并调用组件，账本可证，反馈指出的问题不再出现',
    '`accept-step5` 无界面层与桌面层在 Linux 本地通过（脚本化 provider）；验收前 Windows 手动运行一次',
    '真实模型一次（Linux，thinking 开）主链跑通；验收记录 docs/validation/step-5-<日期>.md 经用户认可；工作留在 nexgent-app',
  ],
  script: 'scripts/accept-step5.mjs',
  repoRoot: REPO_ROOT,
}

function log(line) {
  process.stderr.write(`accept-step5: ${line}\n`)
}

/** Earlier real-model runs' estimated costs: a JSON array of numbers or of `{ costUsd }`. */
async function readSpent(path) {
  if (path === undefined) return []
  const parsed = JSON.parse(await readFile(path, 'utf8'))
  if (!Array.isArray(parsed)) throw new Error(`${path}: expected a JSON array`)
  return parsed.map(entry => (typeof entry === 'number' ? entry : entry?.costUsd ?? 'unknown'))
}

const errorText = error => (error instanceof Error ? (error.stack ?? error.message) : String(error))

/** The step-4 headless ctx (what accept-step4's headless layer builds): step 3's scenario, step 4's, the gate's. */
async function step4HeadlessCtx(harness, work, tools) {
  const ctx = { work, tools }
  await mkdir(join(work, 'step3'), { recursive: true })
  try {
    ctx.step3 = await runStep3Headless(harness, join(work, 'step3'), { log: line => log(`regression step3: ${line}`) })
  } catch (error) {
    ctx.step3Error = errorText(error)
  }
  try {
    await mkdir(join(work, 'step4'), { recursive: true })
    const { runStep4Headless } = await import('./accept-common/step4-headless.mjs')
    ctx.step4 = await runStep4Headless(harness, join(work, 'step4'), { log: line => log(`regression step4: ${line}`) })
  } catch (error) {
    ctx.step4Error = errorText(error)
  }
  if (ctx.step4?.features?.gate === true) {
    try {
      await mkdir(join(work, 'gate'), { recursive: true })
      const { runStep4Gate } = await import('./accept-common/step4-gate.mjs')
      ctx.step4.gate = await runStep4Gate(harness, join(work, 'gate'), { log: line => log(`regression gate: ${line}`) })
    } catch (error) {
      ctx.step4.gate = { error: { step: 'setup', message: errorText(error) } }
    }
  }
  return ctx
}

/**
 * Prerequisites per layer. Returns `{ ok: true, ctx }` or `{ ok: false, reason }`.
 * Nothing here calls a model.
 */
async function prepareLayer(layer, harness, options) {
  if (layer === 'headless') {
    const packages = await loadStep2Packages()
    if (!packages.ok) return { ok: false, reason: packages.reason }
    const { validateSessionRecord, validateLedgerRecord } = packages.pkgs.session
    const tools = { validateSessionRecord, validateLedgerRecord }
    const ctx = { work: options.work, tools }
    // H19: step 4's headless scenarios; a crash fails H19 only.
    try {
      ctx.regression = await step4HeadlessCtx(harness, join(options.work, 'regression'), tools)
    } catch (error) {
      ctx.regressionError = errorText(error)
    }
    // The step-5 scenario (loaded here: it needs the built packages); its crash fails its items only.
    try {
      await mkdir(join(options.work, 'step5'), { recursive: true })
      const { runStep5Headless } = await import('./accept-common/step5-headless.mjs')
      ctx.step5 = await runStep5Headless(harness, join(options.work, 'step5'), { log: line => log(`headless step5: ${line}`) })
    } catch (error) {
      ctx.step5Error = errorText(error)
    }
    return { ok: true, ctx }
  }
  if (layer === 'desktop') {
    const ready = await desktopPrerequisites()
    if (!ready.ok) return { ok: false, reason: ready.reason }
    await mkdir(options.work, { recursive: true })
    // D01–D18 regression (step 2's scenario, step 3's members scenario, step 4's capabilities scenario).
    const ctx = { work: options.work }
    try {
      await mkdir(join(options.work, 'step2'), { recursive: true })
      ctx.obs = await runDesktopScenario(harness, join(options.work, 'step2'), { log: line => log(`desktop: ${line}`) })
    } catch (error) {
      ctx.scenarioError = errorText(error)
    }
    try {
      ctx.members = await runMembersDesktopScenario(harness, join(options.work, 'members'), { log: line => log(`desktop members: ${line}`) })
    } catch (error) {
      ctx.membersError = errorText(error)
    }
    try {
      ctx.capabilities = await runCapabilitiesDesktopScenario(harness, join(options.work, 'capabilities'), { log: line => log(`desktop capabilities: ${line}`) })
    } catch (error) {
      ctx.capabilitiesError = errorText(error)
    }
    // D19–D23: the improvements page over real explicit jobs.
    try {
      ctx.improvements = await runImprovementsDesktopScenario(harness, join(options.work, 'improvements'), { log: line => log(`desktop improvements: ${line}`) })
    } catch (error) {
      ctx.improvementsError = errorText(error)
    }
    return { ok: true, ctx }
  }
  // real
  const ready = realPrerequisites(process.env, options.budgetUsd, options.spent)
  if (!ready.ok) return ready
  // NEXGENT_API_BASE_URL may point the layer at a loopback stand-in (tests); then nothing here is real-model evidence.
  const baseUrl = process.env['NEXGENT_API_BASE_URL']
  const realModel = baseUrl === undefined || baseUrl === '' || !isLoopbackUrl(baseUrl)
  const env = {
    NEXGENT_API_KEY: process.env[ready.keySource],
    ...(baseUrl === undefined || baseUrl === '' ? {} : { NEXGENT_API_BASE_URL: baseUrl }),
  }
  await mkdir(options.work, { recursive: true })
  const ctx = { work: options.work, keySource: ready.keySource, remainingUsd: ready.remainingUsd, realModel }
  try {
    ctx.obs = await runRealScenario(harness, options.work, {
      env, realModel, budgetUsd: options.budgetUsd, spent: options.spent, log: line => log(`real: ${line}`),
    })
  } catch (error) {
    ctx.scenarioError = errorText(error)
  }
  return { ok: true, ctx }
}

async function main() {
  const { values } = parseArgs({
    options: {
      layer: { type: 'string' },
      out: { type: 'string' },
      'work-dir': { type: 'string' },
      'budget-usd': { type: 'string' },
      spent: { type: 'string' },
    },
    strict: true,
  })
  const parsed = parseLayers(values.layer)
  if (!parsed.ok) {
    log(parsed.reason)
    return EXIT_FAIL
  }
  const layers = parsed.layers
  const budgetUsd = values['budget-usd'] === undefined ? REAL_MODEL.budgetUsd : Number(values['budget-usd'])

  const loaded = await loadHarness()
  if (!loaded.ok) {
    log(`not runnable yet: ${loaded.reason}`)
    return EXIT_NOT_READY
  }
  const h = loaded.harness

  const work = values['work-dir'] === undefined
    ? await mkdtemp(join(tmpdir(), 'nexgent-accept-step5-'))
    : resolve(values['work-dir'])
  await mkdir(work, { recursive: true })
  const out = values.out === undefined ? join(work, 'summary.json') : resolve(values.out)
  log(`layers ${layers.join(', ')}; work dir ${work}`)

  const realOnly = !layers.includes('headless') && !layers.includes('desktop')
  const s = h.acceptanceSummary({
    ...STEP,
    provider: realOnly ? 'real' : 'scripted',
    command: `node scripts/accept-step5.mjs --layer ${layers.join(',')}`,
    simulated: 'scripted Claude Messages API model server with per-session routing; checklist H01–H19 / D01–D23',
  })

  const spent = await readSpent(values.spent)
  const statuses = []
  const statusOf = new Map()
  let realCtx
  let notReady = 0
  for (const layer of layers) {
    const ready = await prepareLayer(layer, h, { work: join(work, layer), budgetUsd, spent })
    if (!ready.ok) {
      notReady += 1
      s.knownIssue(`${LAYERS[layer].title} not runnable yet: ${ready.reason}`)
      log(`${layer}: not runnable yet: ${ready.reason}`)
    }
    if (layer === 'real' && ready.ok) realCtx = ready.ctx
    for (const entry of CHECKS.filter(check => check.layer === layer)) {
      const { status, evidence } = ready.ok
        ? await evaluateItem(entry, ready.ctx)
        : { status: 'not-implemented', evidence: `layer not runnable yet: ${ready.reason}` }
      if (OPTIONAL_CHECKS.has(entry.id)) {
        // Optional items never decide the exit code; one that did not run is untested, not a failed check.
        if (status === 'not-implemented') s.untested(`${entry.id} ${entry.title}: ${evidence}`)
        else s.item(entry.id, entry.title, status, evidence)
        continue
      }
      s.item(entry.id, entry.title, status, evidence)
      statusOf.set(entry.id, status)
      statuses.push(status)
    }
    if (layer === 'headless' && ready.ok) {
      // The feedback project every job starts from: recorded, not part of the exit code.
      const fixture = ready.ctx.step5 === undefined
        ? { status: 'failed', evidence: `step 5 headless scenario failed: ${ready.ctx.step5Error}` }
        : judgeFeedbackProject(ready.ctx.step5.project, { judgeTable: judgeRegionTable, csvOf: (await import('./accept-common/step5-headless.mjs')).csvOf })
      s.check('反馈夹具：历史任务、反馈任务与 5 条反馈（3 条计入）经 SDK 写成', fixture.status === 'passed', `${fixture.status}: ${fixture.evidence}`)
      for (const [name, error] of Object.entries(ready.ctx.step5?.errors ?? {})) s.knownIssue(`step 5 headless phase ${name} failed: ${String(error).split('\n')[0]}`)
      if (ready.ctx.step5 !== undefined && ready.ctx.step5.features?.shipped !== true) s.knownIssue(`the SDK as shipped does not answer improvements.list (${ready.ctx.step5.features?.shippedNote ?? 'not probed'}); H01–H18 fail`)
      log(`feedback fixture ${fixture.status}`)
    }
  }

  if (layers.includes('real')) {
    const obs = realCtx?.obs
    const usage = obs?.usage?.total
    const realStatuses = CHECKS.filter(check => check.layer === 'real' && !OPTIONAL_CHECKS.has(check.id)).map(check => statusOf.get(check.id))
    let runNote = 'real layer not runnable; no model call made'
    if (realCtx !== undefined) {
      const jobs = obs?.jobList ?? []
      runNote = `key from ${realCtx.keySource}; budget left before this run ${realCtx.remainingUsd.toFixed(2)} USD; tasks ${Object.keys(obs?.tasks ?? {}).join(', ') || 'none'}; jobs ${jobs.length} / adopted ${jobs.filter(j => j.status === 'adopted').length} (${jobs.map(j => j.status).join(', ') || 'none'}); improvement ~${obs?.usage?.improvement?.costUsd ?? '?'} USD of the total${obs?.stopped ? `; stopped at ${obs.stopped.step}: ${obs.stopped.reason}` : ''}; raw records in ${realCtx.work}`
      if (!realCtx.realModel) {
        runNote += '; NEXGENT_API_BASE_URL is a loopback server: NOT a real-model run'
        s.knownIssue('real layer ran against a loopback stand-in (NEXGENT_API_BASE_URL); its results are not real-model evidence')
      }
    }
    s.set({
      realModel: {
        model: REAL_MODEL.model,
        thinking: REAL_MODEL.thinking,
        task: REAL_MODEL.task,
        callCount: usage?.callCount ?? 0,
        knownTokens: { input: usage?.known?.input ?? 0, output: usage?.known?.output ?? 0 },
        unknownCount: usage?.unknownCount ?? 0,
        cost: usage?.costUsd ?? 0,
        result: realCtx?.realModel === true && realStatuses.every(status => status === 'passed') ? 'pass' : 'fail',
        summaryFile: null,
        runNote,
        unknownSources: (usage?.unknownRequestIds ?? []).map(id => `llm request ${id}: no usage recorded`),
      },
    })
  }
  s.doesNotProve('anything for an item whose status is not-implemented')
  if (!layers.includes('real')) s.untested('real-model layer (R01–R08): run with --layer real')
  s.set({ raw: { location: work, sha256: null, summaryDir: null, manifest: [] } })

  const code = decideExit(statuses, notReady)
  const summary = await s.write(out)
  const count = status => statuses.filter(value => value === status).length
  log(`summary ${out} (result ${summary.result}; passed ${count('passed')}, failed ${count('failed')}, not implemented ${count('not-implemented')})`)
  return code
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (error) => {
    process.stderr.write(`accept-step5: internal error: ${errorText(error)}\n`)
    process.exitCode = EXIT_FAIL
  },
)
