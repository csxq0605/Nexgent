#!/usr/bin/env node
/**
 * Step 2 acceptance (docs/plan/step-2-work-partition.md §`accept-step2`
 * 检查项清单): three layers of checks, all judged by this script from files,
 * session records, ledger lines and process state.
 *
 *   headless  H01–H22  scripted provider; until @nexgent/sdk exists (round 3) the
 *                      runtime is composed in-process (accept-common/step2-runtime.mjs)
 *                      and the kill checks run it in a child (step2-driver.mjs)
 *   desktop   D01–D10  scripted provider, Playwright driving Electron (CI, both platforms)
 *   real      R01–R07  real Claude model (manual: Linux cloud session, thinking on;
 *                      Windows optional via .github/workflows/nexgent-real-model.yml)
 *
 * Usage:
 *   node scripts/accept-step2.mjs [--layer headless,desktop|real|all] [--out <summary.json>]
 *     [--work-dir <empty dir>] [--budget-usd 15] [--spent <earlier-runs.json>] [--allow-not-ready]
 *
 * Writes a summary JSON (test-support schema, fields of docs/validation/TEMPLATE.md);
 * every checklist item appears with its id and status passed / failed / not-implemented.
 *
 * Exit codes: 0 every selected item passed; 1 an item failed; 2 not runnable
 * yet (an item not implemented, or a layer's prerequisites missing) — never a
 * fake pass. `--allow-not-ready` turns 2 into 0 for CI while the checks are
 * being built (the summary still says `fail`); it never hides a 1.
 *
 * The real layer reads the key from NEXGENT_API_KEY (fallback ANTHROPIC_API_KEY)
 * and only ever records which variable was set, never the value.
 * Linux, macOS and Windows; no shell, no Python.
 */
import { access, mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { loadHarness, REPO_ROOT } from './accept-common/harness.mjs'
import { runHeadlessScenario } from './accept-common/step2-headless.mjs'
import { loadStep2Packages } from './accept-common/step2-runtime.mjs'
import {
  budgetGate,
  CHECKS,
  decideExit,
  evaluateItem,
  EXIT_FAIL,
  EXIT_NOT_READY,
  EXIT_PASS,
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

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
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
    const desktop = join(REPO_ROOT, 'apps', 'desktop', 'package.json')
    if (!(await exists(desktop))) return { ok: false, reason: 'apps/desktop does not exist yet' }
    return { ok: true, ctx: { work: options.work } }
  }
  // real
  const keySource = realModelKeySource(process.env)
  if (keySource === undefined) return { ok: false, reason: `no API key (${REAL_MODEL.keyEnv.join(' or ')} is not set)` }
  const gate = budgetGate(options.budgetUsd, options.spent)
  if (!gate.ok) return { ok: false, reason: gate.reason }
  return { ok: true, ctx: { work: options.work, keySource, remainingUsd: gate.remainingUsd, thinking: REAL_MODEL.thinking } }
}

async function main() {
  const { values } = parseArgs({
    options: {
      layer: { type: 'string' },
      out: { type: 'string' },
      'work-dir': { type: 'string' },
      'budget-usd': { type: 'string' },
      spent: { type: 'string' },
      'allow-not-ready': { type: 'boolean', default: false },
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
    provider: realOnly ? 'real' : 'scripted',
    command: `node scripts/accept-step2.mjs --layer ${layers.join(',')}`,
    simulated: 'scripted Claude Messages API model server; per-layer checklist H01–H22 / D01–D10',
  })

  const spent = await readSpent(values.spent)
  const statuses = []
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
      // Optional items are reported but do not decide the exit code.
      if (!OPTIONAL_CHECKS.has(entry.id)) statuses.push(status)
    }
  }

  if (layers.includes('real')) {
    s.set({
      realModel: {
        model: REAL_MODEL.model,
        thinking: REAL_MODEL.thinking,
        task: REAL_MODEL.task,
        // Counted from the run's ledger once the R checks drive a run; nothing has called the model yet.
        callCount: 0,
        knownTokens: { input: 0, output: 0 },
        unknownCount: 0,
        cost: 0,
        result: 'fail',
        summaryFile: null,
        runNote: realCtx === undefined
          ? 'real layer not runnable; no model call made'
          : `key from ${realCtx.keySource}; budget left ${realCtx.remainingUsd.toFixed(2)} USD; R checks not implemented, no model call made`,
        unknownSources: [],
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
  if (code === EXIT_NOT_READY && values['allow-not-ready']) {
    const note = `accept-step2 is not fully wired: ${count('not-implemented')} item(s) not implemented, ${notReady} layer(s) not runnable; summary result is fail`
    if (process.env['GITHUB_ACTIONS'] === 'true') process.stdout.write(`::warning title=accept-step2 not ready::${note}\n`)
    log(`${note} (--allow-not-ready: exit 0)`)
    return EXIT_PASS
  }
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
