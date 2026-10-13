#!/usr/bin/env node
/**
 * Step-6 acceptance runner (docs/plan/step-6-work-partition.md §`accept-step6`
 * 检查项清单): recursive improvement and a reproducible benefit report.
 *
 * Layers:
 *   headless    H01–H18  scripted provider through `@nexgent/sdk`: improver versions,
 *                        meta-improvement jobs, the parent / child comparison, epochs;
 *                        H18 re-runs accept-step5's H01–H19 over fresh scenario runs
 *   desktop     D01–D27  D01–D23 are steps 2–5's desktop items (regression); D24–D27
 *                        the improver on the 改进 page and in settings
 *   experiment  E01–E04  scripts/experiment/step6 (「收益测量」): task families, set
 *                        isolation, holdout arms, report reproducibility; no model call
 *   real        R01–R08  real Claude model, thinking on, cap 35 USD (user decision 8);
 *                        R07 and R08 (Windows) never decide the exit
 *
 * Wired: the regressions (H18, D01–D23), the improver-version items H01–H03
 * (step6-headless.mjs), the meta-improvement items H04–H17 (step6-meta.mjs),
 * D24–D27 (step6-desktop.mjs), E01 / E04 (step6-experiment.mjs) and E02 / E03
 * (a scripted rehearsal of the experiment runner, step6-rehearsal.mjs). The real
 * layer R01–R08 reports not-implemented and the script exits 2 for it — never a
 * fake pass; it checks its prerequisites (key, budget) and calls no model.
 *
 * Usage:
 *   node scripts/accept-step6.mjs [--layer headless,desktop,experiment|real|all] [--out <summary.json>]
 *     [--work-dir <empty dir>] [--budget-usd 35] [--spent <earlier-runs.json>]
 *
 * Writes a summary JSON (test-support schema, fields of docs/validation/TEMPLATE.md);
 * every checklist item appears with its id and status passed / failed / not-implemented.
 *
 * Exit codes: 0 every selected item passed; 1 an item failed; 2 not runnable
 * yet (an item not implemented, or a layer's prerequisites missing).
 *
 * The real layer reads the key from NEXGENT_API_KEY (fallback ANTHROPIC_API_KEY) only to
 * see that one is set; it is never printed or written. Linux, macOS and Windows; no shell,
 * no Python.
 */
import { access, mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { loadHarness, REPO_ROOT } from './accept-common/harness.mjs'
import { desktopPrerequisites } from './accept-common/step2-desktop.mjs'
import { loadStep2Packages } from './accept-common/step2-runtime.mjs'
import { budgetGate } from './accept-common/step2-checks.mjs'
import { step5DesktopCtx, step5HeadlessCtx } from './accept-common/step6-regression.mjs'
import { loadCapabilities, runStep6Headless } from './accept-common/step6-headless.mjs'
import { loadExperiment, reportObservation, setsObservation } from './accept-common/step6-experiment.mjs'
import { runStep6Meta } from './accept-common/step6-meta.mjs'
import { runStep6DesktopScenario } from './accept-common/step6-desktop.mjs'
import { runRehearsal } from './accept-common/step6-rehearsal.mjs'
import { loadStep5Packages, scriptedEnvironment } from './accept-common/step5-runtime.mjs'
import { SCRIPTED_API_KEY } from './accept-common/step5-fixtures.mjs'
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
  realModelKeySource,
} from './accept-common/step6-checks.mjs'

const STEP = {
  step: 6,
  name: '递归改进并检验收益',
  exitCriteria: [
    '改进器有版本：步骤 5 的改进流程整理成默认改进器版本 v0，行为不变（accept-step5 在 v0 下照常通过）；改进器版本按内容寻址，有采用历史，可回滚',
    '元改进闭环：对改进器自身提出一个类型化改动，得到子改进器；子改进器在项目副本里实际承担一次改进作业、产生后代候选；父、子从同一起点各自产生后代，按固定规则比较，更好才采用；采用后下一次真实改进作业由新改进器执行，作业记录与账本可证',
    '评价器冻结：门控的采用规则、反馈检查的评审设置、隐藏判定与 holdout 集合在一个纪元内不变，父子比较和报告不跨纪元；改进器改不到它们',
    '可复现报告：两个任务族，dev / selection / guard / holdout 不重叠，holdout 只用于报告，每个 holdout 用例每臂至少 3 次重复；费用包含改进与元改进；写出摊薄；结果按正、零或负如实写；报告由脚本从原始记录重新生成，内容一致',
    '“CI 绿”：本地跑改动包及依赖方的测试与类型检查；accept-step6 无界面层与桌面层在 Linux 本地通过；验收前手动触发一次 Windows 工作流；真实模型实验在 Linux、thinking 开；验收记录 docs/validation/step-6-<日期>.md 经用户认可；工作留在 nexgent-app',
  ],
  script: 'scripts/accept-step6.mjs',
  repoRoot: REPO_ROOT,
}

function log(line) {
  process.stderr.write(`accept-step6: ${line}\n`)
}

/** Earlier real-model runs' estimated costs: a JSON array of numbers or of `{ costUsd }`. */
async function readSpent(path) {
  if (path === undefined) return []
  const parsed = JSON.parse(await readFile(path, 'utf8'))
  if (!Array.isArray(parsed)) throw new Error(`${path}: expected a JSON array`)
  return parsed.map(entry => (typeof entry === 'number' ? entry : entry?.costUsd ?? 'unknown'))
}

const errorText = error => (error instanceof Error ? (error.stack ?? error.message) : String(error))

/** The experiment scripts belong to 「收益测量」 (W6); this layer only reads them. */
const EXPERIMENT_DIR = join(REPO_ROOT, 'scripts', 'experiment', 'step6')

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
    // H18: step 5's headless scenarios; a crash fails H18 only.
    try {
      ctx.regression = await step5HeadlessCtx(harness, join(options.work, 'regression'), tools, line => log(`regression ${line}`))
    } catch (error) {
      ctx.regressionError = errorText(error)
    }
    // H01–H03: step 6's own scenario; H01 reads the step-5 projects the regression just ran.
    try {
      ctx.step6 = await runStep6Headless(harness, join(options.work, 'step6'), { step5Work: join(options.work, 'regression', 'step5'), log: line => log(`step6 ${line}`) })
    } catch (error) {
      ctx.step6Error = errorText(error)
    }
    // H04–H17: meta-improvement jobs in three scripted projects.
    try {
      const step5 = await loadStep5Packages()
      if (!step5.ok) throw new Error(step5.reason)
      const restore = scriptedEnvironment(SCRIPTED_API_KEY)
      try {
        ctx.step6Meta = await runStep6Meta(harness, step5.pkgs, await loadCapabilities(), join(options.work, 'meta'), { log: line => log(`meta ${line}`) })
      } finally {
        restore()
      }
    } catch (error) {
      ctx.step6MetaError = errorText(error)
    }
    return { ok: true, ctx }
  }
  if (layer === 'desktop') {
    const ready = await desktopPrerequisites()
    if (!ready.ok) return { ok: false, reason: ready.reason }
    // D01–D23: step 5's desktop ctx; D24–D27: the improver scenario.
    const ctx = await step5DesktopCtx(harness, options.work, log)
    try {
      ctx.step6Desktop = await runStep6DesktopScenario(harness, join(options.work, 'step6'), { log: line => log(`desktop step6 ${line}`) })
    } catch (error) {
      ctx.step6DesktopError = errorText(error)
    }
    return { ok: true, ctx }
  }
  if (layer === 'experiment') {
    const present = await access(EXPERIMENT_DIR).then(() => true, () => false)
    if (!present) return { ok: false, reason: 'scripts/experiment/step6 is not there yet (「收益测量」, W6)' }
    const ctx = { work: options.work, experimentDir: EXPERIMENT_DIR, experimentErrors: {} }
    let experiment
    try {
      experiment = await loadExperiment(EXPERIMENT_DIR)
    } catch (error) {
      return { ok: false, reason: `scripts/experiment/step6 does not load: ${errorText(error)}` }
    }
    try {
      ctx.sets = setsObservation(experiment)
    } catch (error) {
      ctx.experimentErrors.sets = errorText(error)
    }
    try {
      ctx.report = await reportObservation(experiment, join(options.work, 'report'))
    } catch (error) {
      ctx.experimentErrors.report = errorText(error)
    }
    // E02 / E03: the runner end to end on the scripted backend (no model call), its runs kept.
    try {
      const rehearsal = await runRehearsal(join(options.work, 'rehearsal'), { log: line => log(`rehearsal ${line}`) })
      if (rehearsal.error !== undefined) ctx.experimentErrors.rehearsal = rehearsal.error
      else ctx.rehearsal = rehearsal
    } catch (error) {
      ctx.experimentErrors.rehearsal = errorText(error)
    }
    return { ok: true, ctx }
  }
  // real: prerequisites only; no item is wired, so no model is called.
  const keySource = realModelKeySource(process.env)
  if (keySource === undefined) return { ok: false, reason: `no API key (${REAL_MODEL.keyEnv.join(' or ')} is not set)` }
  const gate = budgetGate(options.budgetUsd, options.spent)
  if (!gate.ok) return { ok: false, reason: gate.reason }
  return { ok: true, ctx: { work: options.work, keySource, remainingUsd: gate.remainingUsd } }
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
    ? await mkdtemp(join(tmpdir(), 'nexgent-accept-step6-'))
    : resolve(values['work-dir'])
  await mkdir(work, { recursive: true })
  const out = values.out === undefined ? join(work, 'summary.json') : resolve(values.out)
  log(`layers ${layers.join(', ')}; work dir ${work}`)

  const realOnly = layers.length === 1 && layers[0] === 'real'
  const s = h.acceptanceSummary({
    ...STEP,
    provider: realOnly ? 'real' : 'scripted',
    command: `node scripts/accept-step6.mjs --layer ${layers.join(',')}`,
    simulated: 'scripted Claude Messages API model server (step 2–5 scenarios for the regressions, the step-6 improver-version, meta-improvement and desktop improver scenarios); scripted raw experiment record for E04; scripted rehearsal of scripts/experiment/step6 for E02 / E03; checklist H01–H18 / D01–D27 / E01–E04',
  })

  const spent = await readSpent(values.spent)
  const statuses = []
  let notReady = 0
  for (const layer of layers) {
    const ready = await prepareLayer(layer, h, { work: join(work, layer), budgetUsd, spent })
    if (!ready.ok) {
      notReady += 1
      s.knownIssue(`${LAYERS[layer].title} not runnable yet: ${ready.reason}`)
      log(`${layer}: not runnable yet: ${ready.reason}`)
    }
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
      statuses.push(status)
    }
  }

  if (layers.includes('real')) {
    s.set({
      realModel: {
        model: REAL_MODEL.model,
        thinking: REAL_MODEL.thinking,
        task: REAL_MODEL.task,
        callCount: 0,
        knownTokens: { input: 0, output: 0 },
        unknownCount: 0,
        cost: 0,
        result: 'fail',
        summaryFile: null,
        runNote: 'real layer not wired yet (round 1 skeleton); no model call made',
        unknownSources: [],
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
    process.stderr.write(`accept-step6: internal error: ${errorText(error)}\n`)
    process.exitCode = EXIT_FAIL
  },
)
