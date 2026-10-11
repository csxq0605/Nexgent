#!/usr/bin/env node
/**
 * Step 2 acceptance (docs/plan/step-2-work-partition.md §`accept-step2`
 * 检查项清单): three layers of checks, all judged by this script from files,
 * session records, ledger lines and process state.
 *
 *   headless  H01–H23  scripted provider, through @nexgent/sdk (accept-common/step2-runtime.mjs),
 *                      the kill checks in a child process (step2-driver.mjs) and `nexgent export`
 *   desktop   D01–D10  scripted provider, Playwright driving the built Electron app with the real
 *                      renderer and SDK (accept-common/step2-desktop.mjs; Linux without DISPLAY starts Xvfb)
 *   real      R01–R07  real Claude model on the step-2 real task (accept-common/step2-real.mjs;
 *                      manual: Linux cloud session, thinking on; Windows optional via
 *                      .github/workflows/nexgent-real-model.yml). Raw records stay in --work-dir.
 *
 * Usage:
 *   node scripts/accept-step2.mjs [--layer headless,desktop|real|all] [--out <summary.json>]
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
 * and only ever records which variable was set, never the value.
 * Linux, macOS and Windows; no shell, no Python.
 */
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { loadHarness, REPO_ROOT } from './accept-common/harness.mjs'
import { desktopPrerequisites, runDesktopScenario } from './accept-common/step2-desktop.mjs'
import { runHeadlessScenario } from './accept-common/step2-headless.mjs'
import { runRealScenario } from './accept-common/step2-real.mjs'
import { isLoopbackUrl, loadStep2Packages } from './accept-common/step2-runtime.mjs'
import {
  budgetGate,
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
} from './accept-common/step2-checks.mjs'

const STEP = {
  step: 2,
  name: '接通完整的日常任务体验',
  exitCriteria: [
    '`accept-step2` 的无界面层与桌面层在 Linux、Windows CI 上都通过（脚本化 provider）',
    '真实 Claude 模型完成一个真实任务的全链，脚本独立判定，Linux 云端开 thinking 跑一次',
    '验收记录 docs/validation/step-2-<日期>.md 经用户认可',
  ],
  script: 'scripts/accept-step2.mjs',
  repoRoot: REPO_ROOT,
}

function log(line) {
  process.stderr.write(`accept-step2: ${line}\n`)
}

/** Earlier real-model runs' estimated costs: a JSON array of numbers or of `{ costUsd }`. */
async function readSpent(path) {
  if (path === undefined) return []
  const parsed = JSON.parse(await readFile(path, 'utf8'))
  if (!Array.isArray(parsed)) throw new Error(`${path}: expected a JSON array`)
  return parsed.map(entry => (typeof entry === 'number' ? entry : entry?.costUsd ?? 'unknown'))
}

/**
 * Prerequisites per layer. Returns `{ ok: true, ctx }` or `{ ok: false, reason }`.
 * Nothing here calls a model.
 */
async function prepareLayer(layer, options) {
  if (layer === 'headless') {
    const loaded = await loadHarness()
    if (!loaded.ok) return { ok: false, reason: loaded.reason }
    const packages = await loadStep2Packages()
    if (!packages.ok) return { ok: false, reason: packages.reason }
    const h = loaded.harness
    const tools = { ...packages.pkgs.session, requestText: h.requestText, isAuxiliaryRequest: h.isAuxiliaryRequest }
    await mkdir(options.work, { recursive: true })
    // One scenario run; every H judge reads its observations. A crash fails every H item.
    try {
      const obs = await runHeadlessScenario(h, options.work, { log: line => log(`headless: ${line}`) })
      return { ok: true, ctx: { harness: h, work: options.work, obs, tools } }
    } catch (error) {
      return { ok: true, ctx: { harness: h, work: options.work, tools, scenarioError: error instanceof Error ? (error.stack ?? error.message) : String(error) } }
    }
  }
  if (layer === 'desktop') {
    const loaded = await loadHarness()
    if (!loaded.ok) return { ok: false, reason: loaded.reason }
    const ready = await desktopPrerequisites()
    if (!ready.ok) return { ok: false, reason: ready.reason }
    await mkdir(options.work, { recursive: true })
    // One scenario run (real Electron, real renderer and SDK, scripted model); every D judge reads it.
    try {
      const obs = await runDesktopScenario(loaded.harness, options.work, { log: line => log(`desktop: ${line}`) })
      return { ok: true, ctx: { work: options.work, obs } }
    } catch (error) {
      return { ok: true, ctx: { work: options.work, scenarioError: error instanceof Error ? (error.stack ?? error.message) : String(error) } }
    }
  }
  // real
  const keySource = realModelKeySource(process.env)
  if (keySource === undefined) return { ok: false, reason: `no API key (${REAL_MODEL.keyEnv.join(' or ')} is not set)` }
  const gate = budgetGate(options.budgetUsd, options.spent)
  if (!gate.ok) return { ok: false, reason: gate.reason }
  const loaded = await loadHarness()
  if (!loaded.ok) return { ok: false, reason: loaded.reason }
  // NEXGENT_API_BASE_URL may point the layer at a loopback stand-in (tests); then nothing here is real-model evidence.
  const baseUrl = process.env['NEXGENT_API_BASE_URL']
  const realModel = baseUrl === undefined || baseUrl === '' || !isLoopbackUrl(baseUrl)
  const runCapUsd = Math.min(REAL_MODEL.runCapUsd, gate.remainingUsd)
  const env = {
    NEXGENT_API_KEY: process.env[keySource],
    NEXGENT_COMPACTION_THRESHOLD: String(REAL_MODEL.compactionThreshold),
    ...(baseUrl === undefined || baseUrl === '' ? {} : { NEXGENT_API_BASE_URL: baseUrl }),
  }
  await mkdir(options.work, { recursive: true })
  const ctx = { work: options.work, keySource, remainingUsd: gate.remainingUsd, runCapUsd, realModel, thinking: REAL_MODEL.thinking }
  try {
    ctx.obs = await runRealScenario(loaded.harness, options.work, { env, keyFromEnv: keySource, realModel, runCapUsd, log: line => log(`real: ${line}`) })
  } catch (error) {
    ctx.scenarioError = error instanceof Error ? (error.stack ?? error.message) : String(error)
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
    ? await mkdtemp(join(tmpdir(), 'nexgent-accept-step2-'))
    : resolve(values['work-dir'])
  await mkdir(work, { recursive: true })
  const out = values.out === undefined ? join(work, 'summary.json') : resolve(values.out)
  log(`layers ${layers.join(', ')}; work dir ${work}`)

  const realOnly = !layers.includes('headless') && !layers.includes('desktop')
  const s = h.acceptanceSummary({
    ...STEP,
    provider: realOnly && !isLoopbackUrl(process.env['NEXGENT_API_BASE_URL'] ?? 'https://api.anthropic.com') ? 'real' : 'scripted',
    command: `node scripts/accept-step2.mjs --layer ${layers.join(',')}`,
    simulated: 'scripted Claude Messages API model server; per-layer checklist H01–H23 / D01–D10',
  })

  const spent = await readSpent(values.spent)
  const statuses = []
  const itemStatus = new Map()
  let notReady = 0
  let realCtx
  for (const layer of layers) {
    const ready = await prepareLayer(layer, { work: join(work, layer), budgetUsd, spent })
    if (!ready.ok) {
      notReady += 1
      s.knownIssue(`${LAYERS[layer].title} not runnable yet: ${ready.reason}`)
      log(`${layer}: not runnable yet: ${ready.reason}`)
    } else {
      await mkdir(ready.ctx.work, { recursive: true })
      if (layer === 'real') realCtx = ready.ctx
    }
    for (const entry of CHECKS.filter(check => check.layer === layer)) {
      const { status, evidence } = ready.ok
        ? await evaluateItem(entry, ready.ctx)
        : { status: 'not-implemented', evidence: `layer not runnable yet: ${ready.reason}` }
      const name = OPTIONAL_CHECKS.has(entry.id) ? `${entry.title}（可选）` : entry.title
      s.item(entry.id, name, status, evidence)
      itemStatus.set(entry.id, status)
      // Optional items are reported but do not decide the exit code.
      if (!OPTIONAL_CHECKS.has(entry.id)) statuses.push(status)
    }
  }

  if (layers.includes('real')) {
    const usage = realCtx?.obs?.usage
    const realStatuses = CHECKS.filter(check => check.layer === 'real' && !OPTIONAL_CHECKS.has(check.id)).map(check => itemStatus.get(check.id))
    let runNote = 'real layer not runnable; no model call made'
    if (realCtx !== undefined) {
      runNote = `key from ${realCtx.keySource}; budget left before this run ${realCtx.remainingUsd.toFixed(2)} USD; run cap ${realCtx.runCapUsd.toFixed(2)} USD; raw records in ${realCtx.work}`
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
        knownTokens: { input: usage?.known.input ?? 0, output: usage?.known.output ?? 0 },
        unknownCount: usage?.unknownCount ?? 0,
        cost: usage?.costUsd ?? 0,
        result: realCtx?.realModel === true && realStatuses.every(status => status === 'passed') ? 'pass' : 'fail',
        summaryFile: null,
        runNote,
        unknownSources: (usage?.unknownRequestIds ?? []).map(id => `llm request ${id}: process killed mid-stream (R04)`),
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
    process.stderr.write(`accept-step2: internal error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
    process.exitCode = EXIT_FAIL
  },
)
