#!/usr/bin/env node
/**
 * Step 3 acceptance (docs/plan/step-3-work-partition.md §`accept-step3`
 * 检查项清单): three layers of checks, all judged by this script from files,
 * session records, ledger lines and process state.
 *
 *   headless  H01–H23  scripted provider with per-session routing, through @nexgent/sdk
 *                      (accept-common/step3-headless.mjs)
 *   desktop   D01–D14  D01–D10: step 2's desktop scenario and judges, as a regression;
 *                      D11–D14: member blocks, sub-session view, member approval, restart
 *   real      R01–R08  real Claude model on the restock task, five runs (accept-common/step3-real.mjs;
 *                      manual: Linux cloud session, thinking on; R08 Windows optional)
 *
 * Usage:
 *   node scripts/accept-step3.mjs [--layer headless,desktop|real|all] [--out <summary.json>]
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
import { runHeadlessScenario } from './accept-common/step3-headless.mjs'
import { realPrerequisites } from './accept-common/step3-real.mjs'
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
} from './accept-common/step3-checks.mjs'

const STEP = {
  step: 3,
  name: '迁移已有能力，补齐灵活协作',
  exitCriteria: [
    '`accept-step3` 的无界面层与桌面层（含 D01–D10 回归）在 Linux 本地通过（脚本化 provider）；合入 main 前 Windows 手动运行一次',
    '真实 Claude 模型完成补货任务 5 次（直接、委派、团队、工作流、不指定形态），脚本独立判定，Linux 开 thinking，累计不超过 15 美元',
    '仓库里没有 Python 文件；验收记录 docs/validation/step-3-<日期>.md 经用户认可',
  ],
  script: 'scripts/accept-step3.mjs',
  repoRoot: REPO_ROOT,
}

function log(line) {
  process.stderr.write(`accept-step3: ${line}\n`)
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
    await mkdir(options.work, { recursive: true })
    try {
      const obs = await runHeadlessScenario(harness, options.work, { log: line => log(`headless: ${line}`) })
      return { ok: true, ctx: { work: options.work, obs } }
    } catch (error) {
      return { ok: true, ctx: { work: options.work, scenarioError: errorText(error) } }
    }
  }
  if (layer === 'desktop') {
    const ready = await desktopPrerequisites()
    if (!ready.ok) return { ok: false, reason: ready.reason }
    await mkdir(options.work, { recursive: true })
    // D01–D10 regression: step 2's scenario (real Electron, real renderer and SDK, scripted model).
    try {
      const obs = await runDesktopScenario(harness, options.work, { log: line => log(`desktop: ${line}`) })
      return { ok: true, ctx: { work: options.work, obs } }
    } catch (error) {
      return { ok: true, ctx: { work: options.work, scenarioError: errorText(error) } }
    }
  }
  // real
  return realPrerequisites(process.env, options.budgetUsd, options.spent)
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
    ? await mkdtemp(join(tmpdir(), 'nexgent-accept-step3-'))
    : resolve(values['work-dir'])
  await mkdir(work, { recursive: true })
  const out = values.out === undefined ? join(work, 'summary.json') : resolve(values.out)
  log(`layers ${layers.join(', ')}; work dir ${work}`)

  const realOnly = !layers.includes('headless') && !layers.includes('desktop')
  const s = h.acceptanceSummary({
    ...STEP,
    provider: realOnly ? 'real' : 'scripted',
    command: `node scripts/accept-step3.mjs --layer ${layers.join(',')}`,
    simulated: 'scripted Claude Messages API model server with per-session routing; checklist H01–H23 / D01–D14',
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
    // Not wired yet (round 5): no model call is ever made, so nothing here is real-model evidence.
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
        runNote: 'real layer not runnable; no model call made',
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
    process.stderr.write(`accept-step3: internal error: ${errorText(error)}\n`)
    process.exitCode = EXIT_FAIL
  },
)
