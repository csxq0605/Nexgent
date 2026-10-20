#!/usr/bin/env node
/**
 * Step 4 acceptance (docs/plan/step-4-work-partition.md §`accept-step4`
 * 检查项清单): three layers of checks, all judged by this script from files,
 * session records, ledger lines, the activation history and process state.
 *
 *   headless  H01–H19  scripted model server, through @nexgent/sdk: H19 (step 3's H01–H23 over a
 *                      fresh run of step 3's headless scenario); H01–H18 from the step-4 scenario
 *                      (accept-common/step4-headless.mjs, step4-scenario.mjs) and, for the gate items
 *                      (H06, H08, H09, H11, H12, H14–H16), the gate scenario in its own project
 *                      (accept-common/step4-gate.mjs); the midterm checkpoint's four items are
 *                      recorded as named checks
 *   desktop   D01–D18  D01–D14: steps 2 and 3's desktop scenarios and judges, as a regression;
 *                      D15–D18 (capability version, candidates, no approval dialog, rollback) from the
 *                      capabilities scenario (accept-common/step4-desktop.mjs)
 *   real      R01–R07  real Claude model on the order-summary family (scripts/real-task/step4-orders.mjs,
 *                      accept-common/step4-real.mjs): history tasks, task A, the gate, task B in a new
 *                      process, an injected regression; manual: Linux cloud session, thinking on;
 *                      R07 (Windows) optional
 *
 * Usage:
 *   node scripts/accept-step4.mjs [--layer headless,desktop|real|all] [--out <summary.json>]
 *     [--work-dir <empty dir>] [--budget-usd 15] [--spent <earlier-runs.json>]
 *
 * Writes a summary JSON (test-support schema, fields of docs/validation/TEMPLATE.md);
 * every checklist item appears with its id and status passed / failed / not-implemented.
 *
 * Exit codes: 0 every selected item passed; 1 an item failed; 2 not runnable
 * yet (an item not implemented, or a layer's prerequisites missing) — never a
 * fake pass.
 *
 * The real layer reads the key from NEXGENT_API_KEY (fallback ANTHROPIC_API_KEY)
 * into the SDK's env object only; it is never printed or written. With
 * NEXGENT_API_BASE_URL on a loopback address the run is not real-model evidence. Linux, macOS and Windows; no shell, no Python.
 */
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { loadHarness, REPO_ROOT } from './accept-common/harness.mjs'
import { desktopPrerequisites, runDesktopScenario } from './accept-common/step2-desktop.mjs'
import { isLoopbackUrl, loadStep2Packages } from './accept-common/step2-runtime.mjs'
import { runMembersDesktopScenario } from './accept-common/step3-desktop.mjs'
import { runCapabilitiesDesktopScenario } from './accept-common/step4-desktop.mjs'
import { runHeadlessScenario as runStep3Headless } from './accept-common/step3-headless.mjs'
import { judgeCheckpoint } from './accept-common/step4-judges.mjs'
import { realPrerequisites, runRealScenario } from './accept-common/step4-real.mjs'
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
} from './accept-common/step4-checks.mjs'

const STEP = {
  step: 4,
  name: '能力变化进入真实运行',
  exitCriteria: [
    '跨任务、跨进程实际调用：任务 A 开发并使用的组件经门控采用后，新 OS 进程里的任务 B 自动加载并调用它，账本可证',
    '自动回滚：注入一次退化后，宿主自动退回上一版本，之后的任务用回旧版本，账本与采用历史可证',
    '被拒候选留档：门控判定变差的候选保留组件、回放结果、费用与拒绝原因，原版本照常可用',
    '`accept-step4` 无界面层与桌面层在 Linux 本地通过（脚本化 provider）；验收前 Windows 手动运行一次',
    '真实模型一次（Linux，thinking 开）主链跑通；验收记录 docs/validation/step-4-<日期>.md 经用户认可；工作留在 nexgent-app',
  ],
  script: 'scripts/accept-step4.mjs',
  repoRoot: REPO_ROOT,
}

function log(line) {
  process.stderr.write(`accept-step4: ${line}\n`)
}

/** Earlier real-model runs' estimated costs: a JSON array of numbers or of `{ costUsd }`. */
async function readSpent(path) {
  if (path === undefined) return []
  const parsed = JSON.parse(await readFile(path, 'utf8'))
  if (!Array.isArray(parsed)) throw new Error(`${path}: expected a JSON array`)
  return parsed.map(entry => (typeof entry === 'number' ? entry : entry?.costUsd ?? 'unknown'))
}

const errorText = error => (error instanceof Error ? (error.stack ?? error.message) : String(error))

/**
 * Prerequisites per layer. Returns `{ ok: true, ctx }` or `{ ok: false, reason }`.
 * Nothing here calls a model.
 */
async function prepareLayer(layer, harness, options) {
  if (layer === 'headless') {
    const packages = await loadStep2Packages()
    if (!packages.ok) return { ok: false, reason: packages.reason }
    const { validateSessionRecord, validateLedgerRecord } = packages.pkgs.session
    const ctx = { work: options.work, tools: { validateSessionRecord, validateLedgerRecord } }
    await mkdir(join(options.work, 'step3'), { recursive: true })
    // H19: one run of step 3's headless scenario; its crash fails H19 only.
    try {
      ctx.step3 = await runStep3Headless(harness, join(options.work, 'step3'), { log: line => log(`headless step3: ${line}`) })
    } catch (error) {
      ctx.step3Error = errorText(error)
    }
    // The step-4 scenario (loaded here: it needs the built kernel); its crash fails its items only.
    try {
      await mkdir(join(options.work, 'step4'), { recursive: true })
      const { runStep4Headless } = await import('./accept-common/step4-headless.mjs')
      ctx.step4 = await runStep4Headless(harness, join(options.work, 'step4'), { log: line => log(`headless step4: ${line}`) })
    } catch (error) {
      ctx.step4Error = errorText(error)
    }
    // The gate scenario (its own project), once the gate is there; its crash fails the gate items only.
    if (ctx.step4?.features?.gate === true) {
      try {
        await mkdir(join(options.work, 'gate'), { recursive: true })
        const { runStep4Gate } = await import('./accept-common/step4-gate.mjs')
        ctx.step4.gate = await runStep4Gate(harness, join(options.work, 'gate'), { log: line => log(`headless gate: ${line}`) })
      } catch (error) {
        ctx.step4.gate = { error: { step: 'setup', message: errorText(error) } }
      }
    }
    return { ok: true, ctx }
  }
  if (layer === 'desktop') {
    const ready = await desktopPrerequisites()
    if (!ready.ok) return { ok: false, reason: ready.reason }
    await mkdir(options.work, { recursive: true })
    // D01–D14 regression (step 2's scenario, step 3's members scenario), then D15–D18; each failure fails only its own items.
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
    // D15–D18: the capability-version views.
    try {
      ctx.capabilities = await runCapabilitiesDesktopScenario(harness, join(options.work, 'capabilities'), { log: line => log(`desktop capabilities: ${line}`) })
    } catch (error) {
      ctx.capabilitiesError = errorText(error)
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
    // The summary builder itself lives in test-support; without a build there is nothing to write with.
    log(`not runnable yet: ${loaded.reason}`)
    return EXIT_NOT_READY
  }
  const h = loaded.harness

  const work = values['work-dir'] === undefined
    ? await mkdtemp(join(tmpdir(), 'nexgent-accept-step4-'))
    : resolve(values['work-dir'])
  await mkdir(work, { recursive: true })
  const out = values.out === undefined ? join(work, 'summary.json') : resolve(values.out)
  log(`layers ${layers.join(', ')}; work dir ${work}`)

  const realOnly = !layers.includes('headless') && !layers.includes('desktop')
  const s = h.acceptanceSummary({
    ...STEP,
    provider: realOnly ? 'real' : 'scripted',
    command: `node scripts/accept-step4.mjs --layer ${layers.join(',')}`,
    simulated: 'scripted Claude Messages API model server with per-session routing; checklist H01–H19 / D01–D18',
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
      // The midterm checkpoint (partition §中期检查点): recorded, not part of the exit code.
      const points = ready.ctx.step4 === undefined
        ? [{ title: '中期检查点', status: 'failed', evidence: `step 4 headless scenario failed: ${ready.ctx.step4Error}` }]
        : judgeCheckpoint(ready.ctx.step4)
      for (const point of points) {
        s.check(point.title, point.status === 'passed', `${point.status}: ${point.evidence}`)
        log(`${point.id ?? 'checkpoint'} ${point.status}`)
      }
    }
  }

  if (layers.includes('real')) {
    const obs = realCtx?.obs
    const usage = obs?.usage?.total
    const realStatuses = CHECKS.filter(check => check.layer === 'real' && !OPTIONAL_CHECKS.has(check.id)).map(check => statusOf.get(check.id))
    let runNote = 'real layer not runnable; no model call made'
    if (realCtx !== undefined) {
      runNote = `key from ${realCtx.keySource}; budget left before this run ${realCtx.remainingUsd.toFixed(2)} USD; tasks ${Object.keys(obs?.tasks ?? {}).join(', ') || 'none'}; trial ~${obs?.usage?.trial?.costUsd ?? '?'} USD of the total${obs?.stopped ? `; stopped at ${obs.stopped.step}: ${obs.stopped.reason}` : ''}; raw records in ${realCtx.work}`
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
  if (!layers.includes('real')) s.untested('real-model layer (R01–R07): run with --layer real')
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
    process.stderr.write(`accept-step4: internal error: ${errorText(error)}\n`)
    process.exitCode = EXIT_FAIL
  },
)
